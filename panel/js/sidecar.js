/**
 * sidecar.js — discover, launch, authenticate and talk to the VerseSync sidecar.
 *
 * Contract: docs/07-sidecar-api.md. Lifecycle: docs/03-architecture.md §3. Status strip:
 * docs/09-ui-spec.md §2.
 *
 * The panel owns the sidecar's lifetime but not its lifespan: nothing here ever stops the
 * sidecar when the panel closes (only relaunch() does, on an explicit version-mismatch
 * request). Reopening reattaches through the lock file, and a job started before a panel
 * reload is rejoined with resumeJob().
 *
 * Like bridge.js nothing here throws and no promise rejects: every call resolves to
 *   { ok: true, data } or { ok: false, error: { code, message, hint, retryable, status } }.
 *
 * Everything that touches the machine (lock file, process launch, pid liveness, fetch,
 * storage, timers) comes from a "platform" object, so the same code runs inside CEP
 * (cepPlatform) and under node:test against tools/mock_sidecar.py. A platform provides:
 *   logPath                string
 *   fetch(url, init)       fetch-compatible (init.signal supported)
 *   readLock()             Promise<object|null>   parsed sidecar.json, null if absent/corrupt
 *   deleteLock()           Promise<void>
 *   isPidAlive(pid)        Promise<boolean>
 *   launch()               Promise<{ok:true,pid}|{ok:false,error:string}>
 *   storage                { get(key), set(key, value), remove(key) }  (best effort)
 *   sleep(ms)              Promise<void>
 *
 * The insert path never calls into this module: computeStrip() keeps Insert enabled whenever
 * a sequence is open, whatever state the sidecar is in (docs/03 §8, FR-6.8).
 */
(function () {
  'use strict';

  // The major version of docs/07 this panel speaks. A different major is refused.
  var PANEL_API_MAJOR = 1;

  // docs/03 §3 step 3: a cold CUDA model load genuinely takes this long.
  var STARTUP_TIMEOUT_MS = 30000;
  var HEALTH_POLL_MS = 500;
  var HEALTH_REQUEST_TIMEOUT_MS = 3000;
  var JOB_POLL_MS = 1000;
  // Consecutive failed polls before a watched job is reported as lost. Three polls at
  // JOB_POLL_MS tolerates a brief hiccup without leaving the editor staring at a dead bar.
  var JOB_POLL_FAILURE_LIMIT = 3;
  var SHUTDOWN_WAIT_MS = 10000;
  var ACTIVE_JOB_KEY = 'versesync.activeJob';

  // Location of the sidecar's log, shown under "Details" when it is unreachable.
  var LOG_RELATIVE = 'VerseSync/logs/sidecar.log';
  var LOCK_RELATIVE = 'VerseSync/sidecar.json';
  var PYTHONW_RELATIVE = 'VerseSync/venv/Scripts/pythonw.exe';

  function _err(code, message, extra) {
    var e = { code: code, message: message, hint: null, retryable: false, status: 0 };
    if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) { e[k] = extra[k]; } } }
    return { ok: false, error: e };
  }

  function _errText(e) {
    return e && e.message ? e.message : String(e);
  }

  function _major(version) {
    var n = parseInt(String(version).split('.')[0], 10);
    return isNaN(n) ? -1 : n;
  }

  function _joinPath(base, rel) {
    return String(base).replace(/\\/g, '/').replace(/\/+$/, '') + '/' + rel;
  }

  // ------------------------------------------------------------------ SSE parsing

  /**
   * createSSEParser(onEvent) -> { push(textChunk) }
   * Incremental parser for text/event-stream. Calls onEvent(name, dataString) per event.
   * Chunks may split anywhere, including mid-line.
   */
  function createSSEParser(onEvent) {
    var buffer = '';
    var eventName = 'message';
    var dataLines = [];

    function dispatch() {
      if (dataLines.length) { onEvent(eventName, dataLines.join('\n')); }
      eventName = 'message';
      dataLines = [];
    }

    function line(l) {
      if (l === '') { dispatch(); return; }
      if (l.charAt(0) === ':') { return; }
      var i = l.indexOf(':');
      var field = i === -1 ? l : l.slice(0, i);
      var value = i === -1 ? '' : l.slice(i + 1);
      if (value.charAt(0) === ' ') { value = value.slice(1); }
      if (field === 'event') { eventName = value; }
      else if (field === 'data') { dataLines.push(value); }
    }

    return {
      push: function (chunk) {
        buffer += chunk;
        var parts = buffer.split(/\r\n|\n|\r/);
        buffer = parts.pop();
        for (var i = 0; i < parts.length; i++) { line(parts[i]); }
      }
    };
  }

  // ------------------------------------------------------------------ status strip

  function _degradedReasons(health) {
    var reasons = [];
    if (health && health.device === 'cpu') { reasons.push('CPU only'); }
    if (health && health.provider && health.provider.reachable === false) {
      reasons.push('Bible API unreachable');
    }
    return reasons;
  }

  /**
   * computeStrip(status, hasSequence) -> view model for the status strip (docs/09 §2).
   *   { kind, text, detail, analyseEnabled, insertEnabled, action }
   * status is client.getStatus(); hasSequence is the panel's knowledge of the open sequence.
   * insertEnabled depends only on the sequence: a dead sidecar never blocks inserting from
   * an already-loaded Cue Document.
   */
  function computeStrip(status, hasSequence) {
    var seq = hasSequence !== false;
    var s = status || { state: 'starting' };
    var out = {
      kind: s.state,
      text: '',
      detail: null,
      analyseEnabled: false,
      insertEnabled: seq,
      action: null
    };

    if (s.state === 'starting') {
      out.text = '◌ starting transcription service…';
      return out;
    }
    if (s.state === 'unreachable') {
      out.text = '✕ transcription service unavailable';
      out.detail = { message: s.message || '', logPath: s.logPath || '' };
      out.action = 'details';
      return out;
    }
    if (s.state === 'version_mismatch') {
      out.text = '✕ transcription service needs restarting';
      out.detail = { message: s.message || '', logPath: s.logPath || '' };
      out.action = 'relaunch';
      return out;
    }
    if (!seq) {
      out.kind = 'no_sequence';
      out.text = '▲ no sequence open';
      return out;
    }

    out.analyseEnabled = true;
    if (s.state === 'degraded') {
      var reasons = s.reasons && s.reasons.length ? s.reasons : _degradedReasons(s.health);
      out.text = '▲ ready' + (reasons.length ? ' (' + reasons.join('; ') + ')' : '');
      return out;
    }
    var h = s.health || {};
    out.text = '● ready' + (h.device ? ' · ' + h.device : '') +
      (h.model_loaded ? ' · ' + h.model_loaded : '');
    return out;
  }

  // ------------------------------------------------------------------ client

  /**
   * create(platform, options) -> client
   * options: { startupTimeoutMs, healthPollMs, jobPollMs }  (tests shorten these)
   */
  function create(platform, options) {
    options = options || {};
    var startupTimeoutMs = options.startupTimeoutMs || STARTUP_TIMEOUT_MS;
    var healthPollMs = options.healthPollMs || HEALTH_POLL_MS;
    var jobPollMs = options.jobPollMs || JOB_POLL_MS;

    var conn = null;            // { port, token, base }
    var status = { state: 'starting', message: 'Starting transcription service…' };
    var listeners = [];
    var connecting = null;

    function setStatus(next) {
      next.logPath = platform.logPath;
      status = next;
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](status); } catch (e) { /* a listener must not break the client */ }
      }
    }

    function onStatus(fn) {
      listeners.push(fn);
      return function () {
        var i = listeners.indexOf(fn);
        if (i !== -1) { listeners.splice(i, 1); }
      };
    }

    // ---- raw HTTP

    function timedFetch(url, init, timeoutMs) {
      var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = null;
      var init2 = init || {};
      if (ctl) { init2.signal = ctl.signal; }
      var p = Promise.resolve(platform.fetch(url, init2));
      if (!timeoutMs) { return p; }
      return new Promise(function (resolve, reject) {
        timer = setTimeout(function () {
          if (ctl) { ctl.abort(); }
          reject(new Error('request timed out'));
        }, timeoutMs);
        p.then(function (r) { clearTimeout(timer); resolve(r); },
               function (e) { clearTimeout(timer); reject(e); });
      });
    }

    /** health(port) -> Promise<{ok:true,data,apiHeader}|{ok:false,...}>. /health is unauthenticated. */
    function health(port) {
      return timedFetch('http://127.0.0.1:' + port + '/health', { method: 'GET' },
                        HEALTH_REQUEST_TIMEOUT_MS)
        .then(function (res) {
          if (!res.ok) { return _err('unreachable', 'Health check returned ' + res.status, { status: res.status }); }
          return res.json().then(function (data) {
            return { ok: true, data: data, apiHeader: res.headers.get('X-VerseSync-Api') };
          });
        })
        .then(null, function (e) { return _err('unreachable', _errText(e)); });
    }

    function headers(extra) {
      var h = { Authorization: 'Bearer ' + conn.token };
      if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) { h[k] = extra[k]; } } }
      return h;
    }

    function parseError(res) {
      return res.text().then(function (text) {
        var body = null;
        try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
        if (body && body.error) {
          var b = body.error;
          return _err(b.code || 'internal', b.message || ('HTTP ' + res.status), {
            hint: b.hint || null, retryable: !!b.retryable, status: res.status, detail: b.detail || null
          });
        }
        if (res.status === 401) {
          return _err('unauthorized', 'The transcription service rejected the panel’s credentials.',
                      { status: 401, retryable: true });
        }
        return _err('internal', 'Unexpected response from the transcription service (HTTP ' + res.status + ').',
                    { status: res.status });
      });
    }

    /**
     * request(method, path, body) -> Promise<{ok,data}|{ok:false,error}>
     * Adds the bearer token. A network failure marks the sidecar unreachable; a 401 re-reads
     * the lock file once in case the sidecar was relaunched with a new token.
     */
    function request(method, path, body, retried) {
      if (!conn) {
        return Promise.resolve(_err('unreachable', 'Not connected to the transcription service.'));
      }
      var init = { method: method, headers: headers() };
      if (body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      return timedFetch(conn.base + path, init, 0).then(function (res) {
        if (res.status === 401 && !retried) {
          return reattachFromLock().then(function (ok) {
            return ok ? request(method, path, body, true) : parseError(res);
          });
        }
        if (!res.ok) { return parseError(res); }
        return res.text().then(function (text) {
          var data = null;
          try { data = text ? JSON.parse(text) : null; } catch (e) {
            return _err('internal', 'The transcription service sent a malformed reply.');
          }
          return { ok: true, data: data };
        });
      }, function (e) {
        markUnreachable('Lost contact with the transcription service (' + _errText(e) + ').');
        return _err('unreachable', 'Lost contact with the transcription service.', { retryable: true });
      });
    }

    function markUnreachable(message) {
      if (status.state !== 'unreachable') {
        setStatus({ state: 'unreachable', message: message });
      }
    }

    // ---- discovery and launch

    function reattachFromLock() {
      return platform.readLock().then(function (lock) {
        if (!lock || !lock.port || !lock.token) { return false; }
        conn = { port: lock.port, token: lock.token, base: 'http://127.0.0.1:' + lock.port };
        return true;
      });
    }

    /** Attach to the sidecar the lock file describes. Resolves to a health result or null. */
    function tryAttach() {
      return platform.readLock().then(function (lock) {
        if (!lock || !lock.port || !lock.token) { return null; }
        return platform.isPidAlive(lock.pid).then(function (alive) {
          if (!alive) { return platform.deleteLock().then(function () { return null; }); }
          return health(lock.port).then(function (h) {
            if (!h.ok) { return platform.deleteLock().then(function () { return null; }); }
            conn = { port: lock.port, token: lock.token, base: 'http://127.0.0.1:' + lock.port };
            return h;
          });
        });
      });
    }

    /** Poll the lock file and /health until the new sidecar answers, or time runs out. */
    function waitForHealthy() {
      var waited = 0;
      function step() {
        return platform.readLock().then(function (lock) {
          if (!lock || !lock.port || !lock.token) { return null; }
          return health(lock.port).then(function (h) {
            if (!h.ok) { return null; }
            conn = { port: lock.port, token: lock.token, base: 'http://127.0.0.1:' + lock.port };
            return h;
          });
        }).then(function (h) {
          if (h && h.data.status !== 'starting') { return h; }
          if (waited >= startupTimeoutMs) { return null; }
          waited += healthPollMs;
          return platform.sleep(healthPollMs).then(step);
        });
      }
      return step();
    }

    function versionOk(h) {
      var v = h.data.api_version || h.apiHeader;
      return _major(v) === PANEL_API_MAJOR;
    }

    function applyHealth(h) {
      if (!versionOk(h)) {
        var theirs = h.data.api_version || h.apiHeader || 'unknown';
        setStatus({
          state: 'version_mismatch',
          health: h.data,
          message: 'The transcription service speaks API ' + theirs + ' but this panel needs ' +
            PANEL_API_MAJOR + '.x. Restart the service to continue.'
        });
        return _err('version_mismatch', status.message);
      }
      var reasons = h.data.status === 'degraded' ? _degradedReasons(h.data) : [];
      if (h.data.status === 'degraded') {
        setStatus({ state: 'degraded', health: h.data, reasons: reasons, message: 'ready (' + reasons.join('; ') + ')' });
      } else {
        setStatus({ state: 'ready', health: h.data, reasons: [] });
      }
      return { ok: true, data: h.data };
    }

    function launchAndWait() {
      setStatus({ state: 'starting', message: 'Starting transcription service…' });
      return platform.launch().then(function (launched) {
        if (!launched.ok) {
          setStatus({ state: 'unreachable', message: launched.error });
          return _err('launch_failed', launched.error);
        }
        return waitForHealthy().then(function (h) {
          if (!h) {
            var msg = 'The transcription service did not start within ' +
              Math.round(startupTimeoutMs / 1000) + ' seconds.';
            setStatus({ state: 'unreachable', message: msg });
            return _err('startup_timeout', msg, { retryable: true });
          }
          return applyHealth(h);
        });
      });
    }

    /**
     * connect() -> Promise<{ok,data:health}|{ok:false,error}>
     * Attach to a running sidecar if the lock file describes a live one, else launch.
     * Concurrent calls share one attempt.
     */
    function connect() {
      if (connecting) { return connecting; }
      setStatus({ state: 'starting', message: 'Starting transcription service…' });
      connecting = tryAttach().then(function (h) {
        if (!h) { return launchAndWait(); }
        if (h.data.status !== 'starting') { return applyHealth(h); }
        // Attached to a sidecar that is still loading its model: wait, do not launch a second.
        return waitForHealthy().then(function (ready) {
          if (ready) { return applyHealth(ready); }
          var msg = 'The transcription service did not finish starting within ' +
            Math.round(startupTimeoutMs / 1000) + ' seconds.';
          setStatus({ state: 'unreachable', message: msg });
          return _err('startup_timeout', msg, { retryable: true });
        });
      }).then(function (r) { connecting = null; return r; },
              function (e) {
                connecting = null;
                setStatus({ state: 'unreachable', message: _errText(e) });
                return _err('unreachable', _errText(e));
              });
      return connecting;
    }

    /**
     * relaunch() — the version-mismatch path: POST /shutdown, wait for the old process to go
     * away, then launch a fresh one. Only ever called on an explicit editor request.
     */
    function relaunch() {
      var oldPort = conn ? conn.port : null;
      var stop = conn ? request('POST', '/shutdown') : Promise.resolve({ ok: true });
      setStatus({ state: 'starting', message: 'Restarting transcription service…' });
      return stop.then(function () {
        var waited = 0;
        function gone() {
          if (oldPort === null) { return Promise.resolve(true); }
          return health(oldPort).then(function (h) {
            if (!h.ok) { return true; }
            if (waited >= SHUTDOWN_WAIT_MS) { return false; }
            waited += 250;
            return platform.sleep(250).then(gone);
          });
        }
        return gone();
      }).then(function (stopped) {
        if (!stopped) {
          var msg = 'The old transcription service did not stop.';
          setStatus({ state: 'unreachable', message: msg });
          return _err('shutdown_failed', msg);
        }
        conn = null;
        return platform.deleteLock().then(launchAndWait);
      });
    }

    // ---- jobs

    function rememberJob(id) { try { platform.storage.set(ACTIVE_JOB_KEY, id); } catch (e) { /* best effort */ } }
    function forgetJob() { try { platform.storage.remove(ACTIVE_JOB_KEY); } catch (e) { /* best effort */ } }
    function storedJob() { try { return platform.storage.get(ACTIVE_JOB_KEY) || null; } catch (e) { return null; } }

    function startJob(body) {
      return request('POST', '/jobs', body).then(function (r) {
        if (r.ok) { rememberJob(r.data.job_id); }
        return r;
      });
    }

    function cancelJob(id) {
      return request('DELETE', '/jobs/' + encodeURIComponent(id)).then(function (r) {
        if (r.ok) { forgetJob(); }
        return r;
      });
    }

    function getJob(id) { return request('GET', '/jobs/' + encodeURIComponent(id)); }
    function getResult(id) { return request('GET', '/jobs/' + encodeURIComponent(id) + '/result'); }

    function progressOf(snap) {
      return { phase: snap.phase, progress: snap.progress, eta_s: snap.eta_s, message: snap.message };
    }

    /**
     * watchJob(id, handlers) -> { stop() }
     * handlers: onProgress({phase,progress,eta_s,message}), onDone({job_id,...}),
     *           onFailed(error), onViaPolling() (optional; informational).
     * Streams SSE; when the stream drops before `done` (normal across a panel reload, NFR-3)
     * polls GET /jobs/{id} instead and reports through the same handlers.
     */
    function watchJob(id, handlers) {
      var stopped = false;
      var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var finished = false;

      function finish(fn, arg) {
        if (finished || stopped) { return; }
        finished = true;
        forgetJob();
        if (ctl) { ctl.abort(); }
        if (fn) { fn(arg); }
      }

      function applySnapshot(snap) {
        if (snap.status === 'done') { finish(handlers.onDone, { job_id: id }); return true; }
        if (snap.status === 'failed') {
          finish(handlers.onFailed, snap.error || { code: 'internal', message: snap.message || 'The job failed.', hint: null });
          return true;
        }
        if (snap.status === 'cancelled') {
          finish(handlers.onFailed, { code: 'cancelled', message: 'The job was cancelled.', hint: null, retryable: false });
          return true;
        }
        if (handlers.onProgress) { handlers.onProgress(progressOf(snap)); }
        return false;
      }

      function poll() {
        var failures = 0;
        if (handlers.onViaPolling) { handlers.onViaPolling(); }
        function tick() {
          if (stopped || finished) { return Promise.resolve(); }
          return getJob(id).then(function (r) {
            if (stopped || finished) { return; }
            if (r.ok) {
              failures = 0;
              if (applySnapshot(r.data)) { return; }
            } else if (r.error.code === 'job_not_found') {
              finish(handlers.onFailed, r.error);
              return;
            } else {
              failures++;
              if (failures >= JOB_POLL_FAILURE_LIMIT) {
                markUnreachable('The transcription service stopped responding.');
                finish(handlers.onFailed, {
                  code: 'sidecar_lost',
                  message: 'The transcription service stopped responding while the job was running.',
                  hint: 'Check the log, then click Analyse again.',
                  retryable: true
                });
                return;
              }
            }
            return platform.sleep(jobPollMs).then(tick);
          });
        }
        return tick();
      }

      function stream() {
        if (!conn) { return poll(); }
        var parser;
        var sawDone = false;
        var init = { method: 'GET', headers: headers({ Accept: 'text/event-stream' }) };
        if (ctl) { init.signal = ctl.signal; }
        return Promise.resolve(platform.fetch(conn.base + '/jobs/' + encodeURIComponent(id) + '/events', init))
          .then(function (res) {
            if (!res.ok || !res.body) { return null; }
            parser = createSSEParser(function (name, data) {
              var payload = null;
              try { payload = JSON.parse(data); } catch (e) { return; }
              if (name === 'progress') {
                if (handlers.onProgress && !finished && !stopped) { handlers.onProgress(payload); }
              } else if (name === 'done') {
                sawDone = true;
                finish(handlers.onDone, payload);
              }
            });
            var reader = res.body.getReader();
            var decoder = new TextDecoder('utf-8');
            function pump() {
              return reader.read().then(function (chunk) {
                if (chunk.done) { return; }
                parser.push(decoder.decode(chunk.value, { stream: true }));
                if (sawDone || stopped) { return; }
                return pump();
              });
            }
            return pump();
          })
          .then(null, function () { /* a dropped stream is normal; fall through to polling */ })
          .then(function () {
            if (stopped || finished) { return; }
            return poll();
          });
      }

      stream();
      return {
        stop: function () {
          stopped = true;
          if (ctl) { ctl.abort(); }
        }
      };
    }

    /**
     * resumeJob(handlers) -> Promise<{ok, data:{job_id, status}|null}>
     * After a panel reload: rejoin the job remembered in storage. data is null when there is
     * nothing to rejoin. A job that already finished reports through onDone/onFailed.
     */
    function resumeJob(handlers) {
      var id = storedJob();
      if (!id) { return Promise.resolve({ ok: true, data: null }); }
      return getJob(id).then(function (r) {
        if (!r.ok) {
          if (r.error.code === 'job_not_found') { forgetJob(); return { ok: true, data: null }; }
          return r;
        }
        var watcher = watchJob(id, handlers);
        return { ok: true, data: { job_id: id, status: r.data.status, watcher: watcher } };
      });
    }

    return {
      onStatus: onStatus,
      getStatus: function () { return status; },
      connect: connect,
      relaunch: relaunch,
      request: request,
      startJob: startJob,
      cancelJob: cancelJob,
      getJob: getJob,
      getResult: getResult,
      watchJob: watchJob,
      resumeJob: resumeJob,
      models: function () { return request('GET', '/models'); },
      translations: function () { return request('GET', '/translations'); },
      resolve: function (body) { return request('POST', '/resolve', body); },
      shutdown: function () { return request('POST', '/shutdown'); }
    };
  }

  // ------------------------------------------------------------------ CEP platform

  /**
   * cepPlatform(opts) -> platform
   * Backs the platform interface with CEP's native APIs (window.cep.fs / window.cep.process),
   * so the manifest needs no Node flags. opts: { cep, appData, pythonwPath, fetch, storage }.
   * appData is %APPDATA% (CSInterface SystemPath.USER_DATA).
   */
  function cepPlatform(opts) {
    var cep = opts.cep;
    var appData = opts.appData;
    var lockPath = _joinPath(appData, LOCK_RELATIVE);
    var pythonw = opts.pythonwPath || _joinPath(appData, PYTHONW_RELATIVE);
    var logPath = _joinPath(appData, LOG_RELATIVE).replace(/\//g, '\\');

    return {
      logPath: logPath,
      fetch: opts.fetch || function (url, init) { return window.fetch(url, init); },
      storage: opts.storage || {
        get: function (k) { return window.localStorage.getItem(k); },
        set: function (k, v) { window.localStorage.setItem(k, v); },
        remove: function (k) { window.localStorage.removeItem(k); }
      },
      sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
      readLock: function () {
        return new Promise(function (resolve) {
          try {
            var res = cep.fs.readFile(lockPath);
            if (res.err !== 0) { resolve(null); return; }
            resolve(JSON.parse(res.data));
          } catch (e) { resolve(null); }
        });
      },
      deleteLock: function () {
        return new Promise(function (resolve) {
          try { cep.fs.deleteFile(lockPath); } catch (e) { /* already gone */ }
          resolve();
        });
      },
      isPidAlive: function (pid) {
        return new Promise(function (resolve) {
          try {
            var res = cep.process.isRunning(pid);
            resolve(res.err === 0 && !!res.data);
          } catch (e) { resolve(false); }
        });
      },
      launch: function () {
        return new Promise(function (resolve) {
          try {
            var st = cep.fs.stat(pythonw);
            if (st.err !== 0) {
              resolve({ ok: false, error: 'The transcription service is not installed (missing ' +
                pythonw.replace(/\//g, '\\') + '). Reinstall VerseSync.' });
              return;
            }
            var res = cep.process.createProcess(pythonw, '-m', 'versesync.sidecar', '--port', '0');
            if (res.err !== 0) {
              resolve({ ok: false, error: 'Could not start the transcription service (error ' + res.err + ').' });
              return;
            }
            resolve({ ok: true, pid: res.data });
          } catch (e) {
            resolve({ ok: false, error: 'Could not start the transcription service: ' + _errText(e) });
          }
        });
      }
    };
  }

  var VSSidecar = {
    PANEL_API_MAJOR: PANEL_API_MAJOR,
    STARTUP_TIMEOUT_MS: STARTUP_TIMEOUT_MS,
    create: create,
    cepPlatform: cepPlatform,
    computeStrip: computeStrip,
    createSSEParser: createSSEParser
  };

  if (typeof window !== 'undefined') {
    window.VSSidecar = VSSidecar;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = VSSidecar;
  }
})();
