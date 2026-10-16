(function (root) {
  'use strict';

  // Node-http transport and API client for the sidecar (docs/07 §1.2, §1.3, §2, §3).
  // Nothing here ever throws or rejects: every failure is returned as {ok:false, error}.

  var HOST = '127.0.0.1';
  // The panel's CEP origin (D21). Node lets us set Origin explicitly; browser pages cannot.
  var PANEL_ORIGIN = 'cep://com.versesync.panel';
  var API_HEADER = 'x-versesync-api';
  var SUPPORTED_API_MAJOR = 1;

  // ---- transport ------------------------------------------------------------------------

  function parseJson(text) {
    if (typeof text !== 'string' || text === '') { return null; }
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  function createNodeTransport(http) {
    // request() resolves {status, headers, json}; a network error resolves status 0.
    function request(opts) {
      return new Promise(function (resolve) {
        var settled = false;
        function finish(result) {
          if (!settled) {
            settled = true;
            resolve(result);
          }
        }
        var payload = null;
        var headers = {};
        var k;
        for (k in (opts.headers || {})) {
          if (Object.prototype.hasOwnProperty.call(opts.headers, k)) { headers[k] = opts.headers[k]; }
        }
        if (opts.body !== undefined && opts.body !== null) {
          payload = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
          headers['Content-Type'] = 'application/json';
          headers['Content-Length'] = Buffer.byteLength(payload);
        }
        try {
          var req = http.request({
            host: HOST,
            port: opts.port,
            path: opts.path,
            method: opts.method || 'GET',
            headers: headers
          }, function (res) {
            var chunks = [];
            res.setEncoding('utf8');
            res.on('data', function (c) { chunks.push(c); });
            res.on('end', function () {
              finish({ status: res.statusCode, headers: res.headers || {}, json: parseJson(chunks.join('')) });
            });
            res.on('error', function () { finish({ status: 0, headers: {}, json: null }); });
          });
          req.on('error', function () { finish({ status: 0, headers: {}, json: null }); });
          if (payload !== null) { req.write(payload); }
          req.end();
        } catch (e) {
          finish({ status: 0, headers: {}, json: null });
        }
      });
    }

    // Incremental SSE parser: feed() takes arbitrary chunks, emits whole events.
    function createSseParser(onEvent) {
      var buffer = '';
      var eventName = 'message';
      var dataLines = [];

      function dispatch() {
        if (dataLines.length > 0) {
          var data = parseJson(dataLines.join('\n'));
          if (data !== null) { onEvent(eventName, data); }
        }
        eventName = 'message';
        dataLines = [];
      }

      function line(text) {
        if (text === '') { dispatch(); return; }
        if (text.charAt(0) === ':') { return; }
        var idx = text.indexOf(':');
        var field = idx === -1 ? text : text.slice(0, idx);
        var value = idx === -1 ? '' : text.slice(idx + 1);
        if (value.charAt(0) === ' ') { value = value.slice(1); }
        if (field === 'event') { eventName = value; }
        else if (field === 'data') { dataLines.push(value); }
      }

      return {
        feed: function (chunk) {
          buffer += chunk;
          var parts = buffer.split(/\r\n|\n|\r/);
          buffer = parts.pop();
          for (var i = 0; i < parts.length; i++) { line(parts[i]); }
        }
      };
    }

    // stream() calls onEnd(reason) exactly once: 'end', 'error', 'http_<status>' or 'closed'.
    function stream(opts, onEvent, onEnd) {
      var ended = false;
      var closed = false;
      var req = null;
      function end(reason) {
        if (ended) { return; }
        ended = true;
        try { onEnd(closed ? 'closed' : reason); } catch (e) { /* caller's handler failed */ }
      }
      try {
        var headers = {};
        var k;
        for (k in (opts.headers || {})) {
          if (Object.prototype.hasOwnProperty.call(opts.headers, k)) { headers[k] = opts.headers[k]; }
        }
        headers.Accept = 'text/event-stream';
        req = http.request({
          host: HOST,
          port: opts.port,
          path: opts.path,
          method: 'GET',
          headers: headers
        }, function (res) {
          if (res.statusCode < 200 || res.statusCode > 299) {
            res.resume();
            end('http_' + res.statusCode);
            return;
          }
          var parser = createSseParser(function (name, data) {
            if (closed) { return; }
            try { onEvent(name, data); } catch (e) { /* caller's handler failed */ }
          });
          res.setEncoding('utf8');
          res.on('data', function (c) { parser.feed(c); });
          res.on('end', function () { end('end'); });
          res.on('error', function () { end('error'); });
          res.on('aborted', function () { end('error'); });
        });
        req.on('error', function () { end('error'); });
        req.end();
      } catch (e) {
        end('error');
      }
      return {
        close: function () {
          closed = true;
          if (req) { try { req.destroy(); } catch (e) { /* already gone */ } }
          end('closed');
        }
      };
    }

    return { request: request, stream: stream };
  }

  // ---- client ---------------------------------------------------------------------------

  function failure(code, message, hint, status) {
    return { ok: false, error: { code: code, message: message, hint: hint || '', status: status } };
  }

  function headerValue(headers, name) {
    if (!headers) { return undefined; }
    if (headers[name] !== undefined) { return headers[name]; }
    for (var k in headers) {
      if (Object.prototype.hasOwnProperty.call(headers, k) && k.toLowerCase() === name) { return headers[k]; }
    }
    return undefined;
  }

  function apiMajor(value) {
    var major = parseInt(String(value).split('.')[0], 10);
    return isNaN(major) ? null : major;
  }

  function create(opts) {
    var transport = opts.transport;
    var port = opts.port;
    var token = opts.token;

    function call(method, path, body, authenticated) {
      var headers = {};
      if (authenticated) {
        headers.Authorization = 'Bearer ' + token;
        headers.Origin = PANEL_ORIGIN;
      }
      var pending;
      try {
        pending = Promise.resolve(transport.request({
          method: method, port: port, path: path, headers: headers, body: body
        }));
      } catch (e) {
        pending = Promise.resolve({ status: 0 });
      }
      return pending.then(function (res) {
        if (!res || !res.status) {
          return failure('unreachable', 'The VerseSync sidecar is not responding.',
            'Check that the sidecar is running, then try again.', 0);
        }
        var version = headerValue(res.headers, API_HEADER);
        if (version !== undefined && apiMajor(version) !== SUPPORTED_API_MAJOR) {
          return failure('api_version_mismatch',
            'The sidecar speaks API version ' + version + ', but this panel needs version ' +
            SUPPORTED_API_MAJOR + '.x.',
            'Update VerseSync so the panel and the sidecar match.', res.status);
        }
        if (res.status < 200 || res.status > 299) {
          var env = res.json && res.json.error;
          if (env && typeof env === 'object') {
            return failure(env.code || 'internal', env.message || 'The sidecar reported an error.',
              env.hint, res.status);
          }
          if (res.status === 401) {
            return failure('unauthorized', 'The sidecar rejected the panel\'s credentials.',
              'Restart the sidecar so the panel can pick up a fresh token.', 401);
          }
          return failure('http_' + res.status, 'The sidecar returned HTTP ' + res.status + '.', '', res.status);
        }
        return { ok: true, data: res.json };
      }, function () {
        return failure('unreachable', 'The VerseSync sidecar is not responding.',
          'Check that the sidecar is running, then try again.', 0);
      }).then(null, function (e) {
        return failure('internal', 'Unexpected error talking to the sidecar: ' + (e && e.message), '', 0);
      });
    }

    function jobPath(id, suffix) {
      return '/jobs/' + encodeURIComponent(id) + (suffix || '');
    }

    return {
      // Where an SSE subscription to a job must connect, with the same credentials as call().
      eventsRequest: function (id) {
        return {
          port: port,
          path: jobPath(id, '/events'),
          headers: { Authorization: 'Bearer ' + token, Origin: PANEL_ORIGIN }
        };
      },
      health: function () { return call('GET', '/health', null, false); },
      models: function () { return call('GET', '/models', null, true); },
      translations: function () { return call('GET', '/translations', null, true); },
      startJob: function (req) { return call('POST', '/jobs', req, true); },
      job: function (id) { return call('GET', jobPath(id), null, true); },
      result: function (id) { return call('GET', jobPath(id, '/result'), null, true); },
      transcript: function (id) { return call('GET', jobPath(id, '/transcript'), null, true); },
      cancel: function (id) { return call('DELETE', jobPath(id), null, true); },
      resolve: function (refOrObj, translationId) {
        return call('POST', '/resolve', { reference: refOrObj, translation_id: translationId }, true);
      },
      shutdown: function () { return call('POST', '/shutdown', null, true); }
    };
  }

  // ---- lifecycle ------------------------------------------------------------------------
  // Discovery, launch and health polling (docs/03 §3, docs/07 §1.1). The sidecar outlives
  // the panel, so nothing here ever stops it except an explicit restart().

  var POLL_MS = 500;
  // restart() waits this long for the old sidecar to go away; a chosen bound, the spec gives none.
  var SHUTDOWN_WAIT_MS = 10000;

  function joinPath(platform, parts) {
    return parts.join(platform === 'win32' ? '\\' : '/');
  }

  function createLifecycle(opts) {
    var fs = opts.fs;
    var childProcess = opts.childProcess;
    var env = opts.env || {};
    var platform = opts.platform;
    var clientFactory = opts.clientFactory;
    var now = opts.now;
    var sleep = opts.sleep;
    var healthTimeoutMs = opts.healthTimeoutMs === undefined ? 30000 : opts.healthTimeoutMs;
    var isAlive = opts.isProcessAlive || function (pid) {
      try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
    };
    var listeners = [];
    var current = null;

    var home = env.VERSESYNC_HOME ||
      (env.APPDATA ? env.APPDATA + (platform === 'win32' ? '\\' : '/') + 'VerseSync' : '');
    var lockPath = joinPath(platform, [home, 'sidecar.json']);
    var logPath = joinPath(platform, [home, 'logs', 'sidecar.log']);
    // Assumption: the panel's venv lives under the app home. Callers with a configured venv
    // pass launchCommand explicitly.
    var launchCommand = opts.launchCommand ||
      [joinPath(platform, [home, 'venv', 'Scripts', 'pythonw.exe']), '-m', 'versesync.sidecar', '--port', '0'];

    function emit(state, detail) {
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](state, detail); } catch (e) { /* listener failed; keep going */ }
      }
    }

    function readLock() {
      try {
        var lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (lock && typeof lock.port === 'number' && typeof lock.pid === 'number' &&
            typeof lock.token === 'string') {
          return lock;
        }
      } catch (e) { /* missing or unreadable lock */ }
      return null;
    }

    function deleteLock() {
      try { fs.unlinkSync(lockPath); } catch (e) { /* already gone */ }
    }

    // Maps one /health reply to a lifecycle result, or null when the sidecar is still starting.
    function judge(client, res) {
      if (!res.ok) {
        if (res.error && res.error.code === 'api_version_mismatch') {
          return { state: 'version_mismatch', client: client, detail: res.error.message };
        }
        return null;
      }
      var status = res.data && res.data.status;
      if (status === 'starting') { return null; }
      if (status === 'degraded') { return { state: 'degraded', client: client, detail: res.data }; }
      return { state: 'ready', client: client, detail: res.data };
    }

    function probe(lock) {
      var client = clientFactory({ port: lock.port, token: lock.token });
      return client.health().then(function (res) { return judge(client, res); });
    }

    function finish(result) {
      current = result.client && result.state !== 'unreachable' ? result : null;
      emit(result.state, result.detail);
      return result;
    }

    function unreachable() {
      return finish({ state: 'unreachable', detail: logPath });
    }

    function launch() {
      var failed = false;
      try {
        var child = childProcess.spawn(launchCommand[0], launchCommand.slice(1),
          { detached: true, stdio: 'ignore' });
        if (child && child.on) { child.on('error', function () { failed = true; }); }
        if (child && child.unref) { child.unref(); }
      } catch (e) {
        return unreachable();
      }
      var started = now();
      function poll() {
        if (failed) { return unreachable(); }
        var lock = readLock();
        var attempt = lock && isAlive(lock.pid) ? probe(lock) : Promise.resolve(null);
        return attempt.then(function (result) {
          if (result) { return finish(result); }
          if (now() - started >= healthTimeoutMs) { return unreachable(); }
          return Promise.resolve(sleep(POLL_MS)).then(poll);
        });
      }
      return poll();
    }

    function connect() {
      emit('starting');
      var lock = readLock();
      if (lock && isAlive(lock.pid)) {
        return probe(lock).then(function (result) {
          if (result) { return finish(result); }
          // Alive process that is not answering: treat the lock as stale.
          deleteLock();
          return launch();
        });
      }
      if (lock) { deleteLock(); }
      return launch();
    }

    function restart() {
      emit('starting');
      var lock = readLock();
      if (!lock) { return launch(); }
      var client = clientFactory({ port: lock.port, token: lock.token });
      return client.shutdown().then(function () {
        var started = now();
        function waitGone() {
          if (!isAlive(lock.pid) || now() - started >= SHUTDOWN_WAIT_MS) { return null; }
          return Promise.resolve(sleep(POLL_MS)).then(waitGone);
        }
        return waitGone();
      }).then(function () {
        deleteLock();
        return launch();
      });
    }

    return {
      connect: connect,
      restart: restart,
      onState: function (cb) { listeners.push(cb); },
      current: function () { return current; },
      // The sidecar outlives the panel: unloading only drops listeners, never shuts it down.
      dispose: function () { listeners = []; }
    };
  }

  // ---- job watcher ----------------------------------------------------------------------
  // SSE first, polling GET /jobs/{id} when the stream ends without a terminal event
  // (docs/07 §2, NFR-3). The mock sends no terminal SSE event for failed or cancelled jobs,
  // so polling is also how those are detected.

  var ACTIVE_JOB_KEY = 'activeJobId';
  var DEFAULT_POLL_MS = 1000;

  function isTerminal(status) {
    return status === 'done' || status === 'failed' || status === 'cancelled';
  }

  function storageWrite(storage, fn) {
    if (!storage) { return; }
    try { fn(storage); } catch (e) { /* storage unavailable; rejoin just won't find the job */ }
  }

  function defaultSleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function watchJob(opts) {
    var client = opts.client;
    var transport = opts.transport;
    var storage = opts.storage;
    var jobId = opts.jobId;
    var pollMs = opts.pollMs === undefined ? DEFAULT_POLL_MS : opts.pollMs;
    var sleep = opts.sleep || defaultSleep;
    var stopped = false;
    var finished = false;
    var polling = false;
    var stream = null;
    var highest = 0;

    storageWrite(storage, function (st) { st.setItem(ACTIVE_JOB_KEY, jobId); });

    function call(cb, arg) {
      if (typeof cb !== 'function') { return; }
      try { cb(arg); } catch (e) { /* caller's handler failed */ }
    }

    function closeStream() {
      if (stream) {
        var s = stream;
        stream = null;
        try { s.close(); } catch (e) { /* already closed */ }
      }
    }

    function finish(cb, arg) {
      if (finished || stopped) { return; }
      finished = true;
      storageWrite(storage, function (st) { st.removeItem(ACTIVE_JOB_KEY); });
      closeStream();
      call(cb, arg);
    }

    // Progress only ever moves forward on the panel side, whatever order updates arrive in.
    function progress(data) {
      if (finished || stopped || !data) { return; }
      var p = typeof data.progress === 'number' ? data.progress : highest;
      p = Math.min(1, Math.max(0, p));
      if (p < highest) { p = highest; }
      highest = p;
      var out = {};
      for (var k in data) {
        if (Object.prototype.hasOwnProperty.call(data, k)) { out[k] = data[k]; }
      }
      out.progress = p;
      call(opts.onProgress, out);
    }

    function pollOnce() {
      return client.job(jobId).then(function (res) {
        if (finished || stopped) { return true; }
        if (!res.ok) {
          // Includes 'unreachable' (sidecar died mid-job) and job_not_found (stale saved id).
          finish(opts.onFailed, res.error);
          return true;
        }
        var job = res.data || {};
        if (job.status === 'done') { finish(opts.onDone, job); return true; }
        if (job.status === 'cancelled') { finish(opts.onCancelled, job); return true; }
        if (job.status === 'failed') {
          finish(opts.onFailed, job.error || {
            code: 'internal', message: job.message || 'The job failed.', hint: '', status: 200
          });
          return true;
        }
        progress(job);
        return false;
      });
    }

    function pollLoop() {
      if (polling || finished || stopped) { return; }
      polling = true;
      function step() {
        return pollOnce().then(function (terminal) {
          if (terminal || finished || stopped) { return null; }
          return Promise.resolve(sleep(pollMs)).then(function () {
            return finished || stopped ? null : step();
          });
        });
      }
      step().then(function () { polling = false; }, function () { polling = false; });
    }

    function onStreamEvent(name, data) {
      if (finished || stopped) { return; }
      if (name === 'progress') { progress(data); }
      // A done event is confirmed against the job record, so every terminal state takes one path.
      else if (name === 'done') { pollLoop(); }
    }

    function onStreamEnd() {
      stream = null;
      pollLoop();
    }

    if (transport && typeof transport.stream === 'function' && typeof client.eventsRequest === 'function') {
      try {
        stream = transport.stream(client.eventsRequest(jobId), onStreamEvent, onStreamEnd);
      } catch (e) {
        stream = null;
        pollLoop();
      }
    } else {
      pollLoop();
    }

    return {
      // Stops watching without touching the saved job id: the job keeps running and a reload rejoins it.
      stop: function () {
        stopped = true;
        closeStream();
      }
    };
  }

  // Resumes the job saved by a previous panel session, or returns null when there is none.
  function rejoin(opts) {
    var jobId = null;
    try { jobId = opts.storage && opts.storage.getItem(ACTIVE_JOB_KEY); } catch (e) { jobId = null; }
    if (!jobId) { return null; }
    var args = {};
    for (var k in opts) {
      if (Object.prototype.hasOwnProperty.call(opts, k)) { args[k] = opts[k]; }
    }
    args.jobId = jobId;
    return watchJob(args);
  }

  var VSSidecarClient = { create: create };
  var VSSidecar = {
    PANEL_ORIGIN: PANEL_ORIGIN,
    createNodeTransport: createNodeTransport,
    createLifecycle: createLifecycle,
    watchJob: watchJob,
    rejoin: rejoin,
    VSSidecarClient: VSSidecarClient
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = VSSidecar;
  } else {
    root.VSSidecar = VSSidecar;
    root.VSSidecarClient = VSSidecarClient;
  }
})(this);
