'use strict';

// Exercises panel/js/sidecar.js against the real tools/mock_sidecar.py over real HTTP/SSE.
// The panel's launch/lock-file/pid plumbing is replaced by a node platform that starts the
// mock as a child process with APPDATA pointed at a temp dir (the mock then writes its lock
// file exactly where the panel looks). The CEP-native platform is covered with a fake `cep`.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var os = require('node:os');
var path = require('node:path');
var childProcess = require('node:child_process');

var VSSidecar = require('../panel/js/sidecar');

var MOCK = path.join(__dirname, '..', 'tools', 'mock_sidecar.py');
var PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
var HAVE_PYTHON = childProcess.spawnSync(PYTHON, ['--version']).status === 0;
var NO_PY = HAVE_PYTHON ? false : 'python interpreter not available';

var children = [];
var tmpDirs = [];

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function until(fn, ms) {
  var deadline = Date.now() + (ms || 15000);
  function step() {
    var v = fn();
    if (v) { return Promise.resolve(v); }
    if (Date.now() > deadline) { return Promise.reject(new Error('timed out waiting for condition')); }
    return sleep(25).then(step);
  }
  return step();
}

function makeStorage() {
  var m = {};
  return {
    get: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    set: function (k, v) { m[k] = v; },
    remove: function (k) { delete m[k]; }
  };
}

// flags: mutable array of mock flags used on each launch. launches: count of processes started.
function makePlatform(opts) {
  opts = opts || {};
  var appData = opts.appData || fs.mkdtempSync(path.join(os.tmpdir(), 'vs-sidecar-'));
  if (!opts.appData) { tmpDirs.push(appData); }
  var lockPath = path.join(appData, 'VerseSync', 'sidecar.json');
  var p = {
    appData: appData,
    lockPath: lockPath,
    flags: opts.flags || [],
    launches: 0,
    logPath: path.join(appData, 'VerseSync', 'logs', 'sidecar.log'),
    storage: opts.storage || makeStorage(),
    launchDelayMs: opts.launchDelayMs || 0,
    neverServe: !!opts.neverServe,
    launchError: opts.launchError || null,
    fetch: function (url, init) {
      var headers = Object.assign({ Origin: 'file://' }, init && init.headers);
      return fetch(url, Object.assign({}, init, { headers: headers }));
    },
    sleep: sleep,
    readLock: function () {
      try { return Promise.resolve(JSON.parse(fs.readFileSync(lockPath, 'utf8'))); } catch (e) { return Promise.resolve(null); }
    },
    deleteLock: function () {
      try { fs.unlinkSync(lockPath); } catch (e) { /* already gone */ }
      return Promise.resolve();
    },
    isPidAlive: function (pid) {
      try { process.kill(pid, 0); return Promise.resolve(true); } catch (e) { return Promise.resolve(false); }
    },
    launch: function () {
      p.launches++;
      if (p.launchError) { return Promise.resolve({ ok: false, error: p.launchError }); }
      return sleep(p.launchDelayMs).then(function () {
        var cmd = PYTHON;
        var args = p.neverServe ? ['-c', 'import time; time.sleep(60)'] : [MOCK, '--port', '0'].concat(p.flags);
        var child = childProcess.spawn(cmd, args, {
          env: Object.assign({}, process.env, { APPDATA: appData }),
          stdio: 'ignore'
        });
        children.push(child);
        p.lastChild = child;
        return { ok: true, pid: child.pid };
      });
    }
  };
  return p;
}

function stopAll() {
  children.forEach(function (c) { try { c.kill('SIGKILL'); } catch (e) { /* gone */ } });
  children = [];
  tmpDirs.forEach(function (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* best effort */ } });
  tmpDirs = [];
}

test.after(stopAll);

function readLockSync(p) { return JSON.parse(fs.readFileSync(p.lockPath, 'utf8')); }

var JOB_BODY = { media_path: 'D:/x.mxf', translation_id: 'de4e12af7f28f599-02' };

function watch(client, id) {
  var rec = { progress: [], done: null, failed: null, polling: false };
  var h = client.watchJob(id, {
    onProgress: function (p) { rec.progress.push(p); },
    onDone: function (d) { rec.done = d; },
    onFailed: function (e) { rec.failed = e; },
    onViaPolling: function () { rec.polling = true; }
  });
  rec.watcher = h;
  return rec;
}

// ---------------------------------------------------------------- pure pieces

test('SSE parser handles events split across arbitrary chunk boundaries', function () {
  var events = [];
  var parser = VSSidecar.createSSEParser(function (n, d) { events.push([n, d]); });
  var text = 'event: progress\ndata: {"a":1}\n\n: keepalive\nevent: done\r\ndata: {"b":2}\r\n\r\n';
  for (var i = 0; i < text.length; i += 3) { parser.push(text.slice(i, i + 3)); }
  assert.deepStrictEqual(events, [['progress', '{"a":1}'], ['done', '{"b":2}']]);
});

test('status strip: every state in docs/09 section 2', function () {
  var strip = VSSidecar.computeStrip;
  var ready = { state: 'ready', health: { device: 'cuda', model_loaded: 'distil-large-v3' } };

  var s = strip({ state: 'starting' }, true);
  assert.strictEqual(s.text, '\u25CC starting transcription service\u2026');
  assert.strictEqual(s.analyseEnabled, false);

  s = strip(ready, true);
  assert.strictEqual(s.text, '\u25CF ready \u00B7 cuda \u00B7 distil-large-v3');
  assert.ok(s.analyseEnabled && s.insertEnabled);

  s = strip(ready, false);
  assert.strictEqual(s.text, '\u25B2 no sequence open');
  assert.ok(!s.analyseEnabled && !s.insertEnabled);

  s = strip({ state: 'unreachable', message: 'm', logPath: 'C:\\log' }, true);
  assert.strictEqual(s.text, '\u2715 transcription service unavailable');
  assert.strictEqual(s.action, 'details');
  assert.strictEqual(s.detail.logPath, 'C:\\log');
  assert.ok(!s.analyseEnabled);
  assert.ok(s.insertEnabled, 'insert must survive a dead sidecar');

  s = strip({ state: 'degraded', health: { device: 'cpu', provider: { reachable: true } } }, true);
  assert.strictEqual(s.text, '\u25B2 ready (CPU only)');
  assert.ok(s.analyseEnabled, 'degraded is usable');

  s = strip({ state: 'degraded', health: { device: 'cuda', provider: { reachable: false } } }, true);
  assert.strictEqual(s.text, '\u25B2 ready (Bible API unreachable)');
});

test('with the sidecar down, a saved Cue Document can still be inserted (host path is independent)', function () {
  var VS = require('../panel/js/lib/host-stub');
  VS.__setScenario({ sequence: 'sequence-2997' });
  var strip = VSSidecar.computeStrip({ state: 'unreachable', message: 'down' }, true);
  assert.strictEqual(strip.insertEnabled, true);
  // No sidecar client exists in this test at all; the host call must not need one.
  var res = JSON.parse(VS.insertCues(JSON.stringify({
    mogrtPath: 'D:/Templates/AV_Quote_04.mogrt',
    trackIndex: 2,
    mapping: { referenceIndex: 11, bodyIndex: 3 },
    cues: [{ id: 'cue_001', atTicks: '100000000000', durationTicks: '6000000000', reference: 'John 3:16 (KJV)', body: 'x' }]
  })));
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.data.insertedCount, 1);
});

// ---------------------------------------------------------------- lifecycle

test('cold start launches the sidecar and reaches ready', { skip: NO_PY }, async function () {
  var p = makePlatform({ launchDelayMs: 300 });
  var client = VSSidecar.create(p);
  var seen = [];
  client.onStatus(function (s) { seen.push(s.state); });
  var r = await client.connect();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(p.launches, 1);
  assert.strictEqual(client.getStatus().state, 'ready');
  assert.strictEqual(seen[0], 'starting', 'starting is shown before ready');
  assert.strictEqual(seen[seen.length - 1], 'ready');
  assert.strictEqual(client.getStatus().health.api_version, '1.1');
});

test('reopening the panel reattaches instead of launching a second sidecar', { skip: NO_PY }, async function () {
  var p = makePlatform();
  var first = VSSidecar.create(p);
  assert.strictEqual((await first.connect()).ok, true);
  var lock = readLockSync(p);

  var second = VSSidecar.create(p);   // a reloaded panel: fresh client, same machine
  assert.strictEqual((await second.connect()).ok, true);
  assert.strictEqual(p.launches, 1, 'no second launch');
  assert.strictEqual(readLockSync(p).pid, lock.pid);
  assert.strictEqual(second.getStatus().state, 'ready');
  // Authenticated calls work with the token recovered from the lock file.
  var models = await second.models();
  assert.strictEqual(models.ok, true);
});

test('a stale lock file (dead pid) is cleared and recovered from', { skip: NO_PY }, async function () {
  var p = makePlatform();
  fs.mkdirSync(path.dirname(p.lockPath), { recursive: true });
  fs.writeFileSync(p.lockPath, JSON.stringify({
    pid: 2147483000, port: 1, token: 'stale', api_version: '1.0', sidecar_version: '1', started_at: 'x'
  }));
  var client = VSSidecar.create(p);
  var r = await client.connect();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(p.launches, 1);
  assert.notStrictEqual(readLockSync(p).token, 'stale');
});

test('a lock whose pid is alive but whose port is dead is also treated as stale', { skip: NO_PY }, async function () {
  var p = makePlatform();
  fs.mkdirSync(path.dirname(p.lockPath), { recursive: true });
  fs.writeFileSync(p.lockPath, JSON.stringify({
    pid: process.pid, port: 1, token: 'stale', api_version: '1.0', sidecar_version: '1', started_at: 'x'
  }));
  var client = VSSidecar.create(p);
  assert.strictEqual((await client.connect()).ok, true);
  assert.strictEqual(p.launches, 1);
});

test('the sidecar survives the panel: nothing is stopped when a client is abandoned', { skip: NO_PY }, async function () {
  var p = makePlatform();
  var client = VSSidecar.create(p);
  await client.connect();
  var child = p.lastChild;
  client = null;
  await sleep(200);
  assert.strictEqual(child.exitCode, null);
  assert.strictEqual((await VSSidecar.create(p).connect()).ok, true);
});

// ---------------------------------------------------------------- jobs

test('a panel reload mid-job rejoins the running job', { skip: NO_PY }, async function () {
  var p = makePlatform({ flags: ['--duration', '3'] });
  var a = VSSidecar.create(p);
  await a.connect();
  var started = await a.startJob(JOB_BODY);
  assert.strictEqual(started.ok, true);
  var recA = watch(a, started.data.job_id);
  await until(function () { return recA.progress.length > 0; });
  recA.watcher.stop();                          // panel closes mid-job

  var b = VSSidecar.create(p);                  // panel reopens: new client, same storage
  await b.connect();
  var recB = { progress: [], done: null, failed: null };
  var resumed = await b.resumeJob({
    onProgress: function (x) { recB.progress.push(x); },
    onDone: function (d) { recB.done = d; },
    onFailed: function (e) { recB.failed = e; }
  });
  assert.strictEqual(resumed.ok, true);
  assert.strictEqual(resumed.data.job_id, started.data.job_id);
  await until(function () { return recB.done || recB.failed; });
  assert.strictEqual(recB.failed, null);
  assert.strictEqual(recB.done.job_id, started.data.job_id);
  var result = await b.getResult(started.data.job_id);
  assert.strictEqual(result.ok, true);
  assert.ok(Array.isArray(result.data.cues));
  assert.strictEqual((await b.resumeJob({})).data, null, 'finished job is no longer remembered');
});

test('streaming SSE delivers progress and done without polling', { skip: NO_PY }, async function () {
  var p = makePlatform({ flags: ['--duration', '2'] });
  var c = VSSidecar.create(p);
  await c.connect();
  var job = (await c.startJob(JOB_BODY)).data;
  var rec = watch(c, job.job_id);
  await until(function () { return rec.done || rec.failed; });
  assert.ok(rec.progress.length > 0);
  assert.strictEqual(rec.polling, false);
});

test('--drop-sse switches to the polling fallback transparently', { skip: NO_PY }, async function () {
  var p = makePlatform({ flags: ['--duration', '3', '--drop-sse'] });
  var c = VSSidecar.create(p);
  await c.connect();
  var job = (await c.startJob(JOB_BODY)).data;
  var rec = watch(c, job.job_id);
  await until(function () { return rec.done || rec.failed; });
  assert.strictEqual(rec.failed, null);
  assert.strictEqual(rec.polling, true, 'polling took over');
  assert.strictEqual(rec.done.job_id, job.job_id);
  assert.ok(rec.progress.length > 2, 'progress kept flowing after the stream dropped');
  assert.strictEqual((await c.getResult(job.job_id)).ok, true);
});

test('POST /jobs accepts the fixed-duration override and the result echoes the resolved timing', { skip: NO_PY }, async function () {
  var p = makePlatform({ flags: ['--duration', '1'] });
  var c = VSSidecar.create(p);
  await c.connect();
  var body = Object.assign({}, JOB_BODY, {
    options: { timing: { lead_in_s: 1, duration_mode: 'fixed', fixed_duration_s: 6 } }
  });
  var job = (await c.startJob(body)).data;
  var rec = watch(c, job.job_id);
  await until(function () { return rec.done || rec.failed; });
  var doc = (await c.getResult(job.job_id)).data;
  assert.deepStrictEqual(doc.job.options.timing, {
    read_coverage_threshold: 0.55, lead_in_s: 1, tail_pad_s: 1.0, duration_mode: 'fixed', fixed_duration_s: 6
  });
});

test('POST /jobs without timing options resolves the documented defaults', { skip: NO_PY }, async function () {
  var p = makePlatform({ flags: ['--duration', '1'] });
  var c = VSSidecar.create(p);
  await c.connect();
  var job = (await c.startJob(JOB_BODY)).data;
  var rec = watch(c, job.job_id);
  await until(function () { return rec.done || rec.failed; });
  var doc = (await c.getResult(job.job_id)).data;
  assert.deepStrictEqual(doc.job.options.timing, {
    read_coverage_threshold: 0.55, lead_in_s: 0.5, tail_pad_s: 1.0, duration_mode: 'auto'
  });
});

test('POST /jobs rejects an unknown duration_mode and a fixed mode without a positive duration', { skip: NO_PY }, async function () {
  var p = makePlatform();
  var c = VSSidecar.create(p);
  await c.connect();
  var bad = [
    { duration_mode: 'sometimes' },
    { duration_mode: 'fixed' },
    { duration_mode: 'fixed', fixed_duration_s: 0 },
    { duration_mode: 'fixed', fixed_duration_s: '6' }
  ];
  for (var i = 0; i < bad.length; i++) {
    var r = await c.startJob(Object.assign({}, JOB_BODY, { options: { timing: bad[i] } }));
    assert.strictEqual(r.ok, false, JSON.stringify(bad[i]));
    assert.strictEqual(r.error.code, 'bad_request');
  }
});

test('--fail model_load_failed: the sidecar message and hint come through verbatim', { skip: NO_PY }, async function () {
  var p = makePlatform({ flags: ['--fail', 'model_load_failed'] });
  var c = VSSidecar.create(p);
  await c.connect();
  var job = (await c.startJob(JOB_BODY)).data;
  var rec = watch(c, job.job_id);
  await until(function () { return rec.done || rec.failed; });
  assert.strictEqual(rec.failed.code, 'model_load_failed');
  assert.match(rec.failed.message, /out of memory/);
  assert.ok(rec.failed.hint, 'hint is passed along');
});

test('--fail provider_unavailable is a successful job carrying a provider_partial warning', { skip: NO_PY }, async function () {
  var p = makePlatform({ flags: ['--duration', '1', '--fail', 'provider_unavailable'] });
  var c = VSSidecar.create(p);
  await c.connect();
  var job = (await c.startJob(JOB_BODY)).data;
  var rec = watch(c, job.job_id);
  await until(function () { return rec.done || rec.failed; });
  assert.strictEqual(rec.failed, null);
  var result = (await c.getResult(job.job_id)).data;
  assert.ok(result.warnings.some(function (w) { return w.code === 'provider_partial'; }));
});

test('cancelJob cancels a running job and forgets it', { skip: NO_PY }, async function () {
  var p = makePlatform({ flags: ['--duration', '20'] });
  var c = VSSidecar.create(p);
  await c.connect();
  var job = (await c.startJob(JOB_BODY)).data;
  assert.strictEqual((await c.cancelJob(job.job_id)).ok, true);
  var status = null;
  for (var i = 0; i < 100 && status !== 'cancelled'; i++) {
    status = (await c.getJob(job.job_id)).data.status;
    if (status !== 'cancelled') { await sleep(50); }
  }
  assert.strictEqual(status, 'cancelled');
  assert.strictEqual((await VSSidecar.create(p).resumeJob({})).data, null);
});

test('--die-mid-job: the loss is reported and the status turns unreachable with a log path', { skip: NO_PY }, async function () {
  var p = makePlatform({ flags: ['--duration', '2', '--die-mid-job'] });
  var c = VSSidecar.create(p, { jobPollMs: 100 });
  await c.connect();
  var job = (await c.startJob(JOB_BODY)).data;
  var rec = watch(c, job.job_id);
  await until(function () { return rec.done || rec.failed; });
  assert.strictEqual(rec.failed.code, 'sidecar_lost');
  assert.strictEqual(c.getStatus().state, 'unreachable');
  var strip = VSSidecar.computeStrip(c.getStatus(), true);
  assert.strictEqual(strip.detail.logPath, p.logPath);
  assert.ok(strip.insertEnabled);
  // Retry: the lock is stale (dead pid), so connect() launches a fresh sidecar.
  p.flags = [];
  assert.strictEqual((await c.connect()).ok, true);
  assert.strictEqual(c.getStatus().state, 'ready');
});

// ---------------------------------------------------------------- failure states

test('--degraded is usable-with-a-caveat, not an error', { skip: NO_PY }, async function () {
  var p = makePlatform({ flags: ['--degraded'] });
  var c = VSSidecar.create(p);
  var r = await c.connect();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(c.getStatus().state, 'degraded');
  var strip = VSSidecar.computeStrip(c.getStatus(), true);
  assert.strictEqual(strip.text, '\u25B2 ready (CPU only; Bible API unreachable)');
  assert.ok(strip.analyseEnabled);
});

test('launch failure is immediate, plain and carries the log path', async function () {
  var p = makePlatform({ launchError: 'The transcription service is not installed.' });
  var c = VSSidecar.create(p);
  var r = await c.connect();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'launch_failed');
  var strip = VSSidecar.computeStrip(c.getStatus(), true);
  assert.strictEqual(strip.text, '\u2715 transcription service unavailable');
  assert.strictEqual(strip.detail.message, 'The transcription service is not installed.');
  assert.strictEqual(strip.detail.logPath, p.logPath);
  assert.strictEqual(strip.analyseEnabled, false);
  assert.strictEqual(strip.insertEnabled, true);
});

test('a sidecar that never becomes healthy ends in unreachable, not an endless spinner', { skip: NO_PY }, async function () {
  var p = makePlatform({ neverServe: true });
  var c = VSSidecar.create(p, { startupTimeoutMs: 700, healthPollMs: 100 });
  var t0 = Date.now();
  var r = await c.connect();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'startup_timeout');
  assert.ok(Date.now() - t0 >= 700);
  assert.strictEqual(c.getStatus().state, 'unreachable');
});

test('the default startup budget is 30 s', function () {
  assert.strictEqual(VSSidecar.STARTUP_TIMEOUT_MS, 30000);
});

test('a major api_version mismatch offers a relaunch, which stops the old sidecar and starts a compatible one', { skip: NO_PY }, async function () {
  var p = makePlatform({ flags: ['--api-version', '2.0'] });
  var c = VSSidecar.create(p);
  var r = await c.connect();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'version_mismatch');
  var strip = VSSidecar.computeStrip(c.getStatus(), true);
  assert.strictEqual(strip.action, 'relaunch');
  assert.ok(!strip.analyseEnabled);
  var oldPid = readLockSync(p).pid;

  p.flags = [];                                  // the relaunched sidecar speaks 1.0
  var again = await c.relaunch();
  assert.strictEqual(again.ok, true);
  assert.strictEqual(c.getStatus().state, 'ready');
  assert.notStrictEqual(readLockSync(p).pid, oldPid);
  assert.strictEqual(p.launches, 2);
});

test('a newer minor version is accepted', { skip: NO_PY }, async function () {
  var p = makePlatform({ flags: ['--api-version', '1.7'] });
  var c = VSSidecar.create(p);
  assert.strictEqual((await c.connect()).ok, true);
});

test('a wrong token is rejected with 401 and no retry loop', { skip: NO_PY }, async function () {
  var p = makePlatform();
  var c = VSSidecar.create(p);
  await c.connect();
  var lock = readLockSync(p);
  fs.writeFileSync(p.lockPath, JSON.stringify(Object.assign({}, lock, { token: 'wrong' })));
  var c2 = VSSidecar.create(p);
  // health is unauthenticated, so attach succeeds; the first authed call exposes the token.
  await c2.connect();
  var r = await c2.models();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.status, 401);
  assert.strictEqual(r.error.code, 'unauthorized');
});

test('a token changed by a relaunch is picked up from the lock file on 401', { skip: NO_PY }, async function () {
  var p = makePlatform();
  var c = VSSidecar.create(p);
  await c.connect();
  var good = readLockSync(p);
  fs.writeFileSync(p.lockPath, JSON.stringify(Object.assign({}, good, { token: 'wrong' })));
  var stale = VSSidecar.create(p);
  await stale.connect();
  fs.writeFileSync(p.lockPath, JSON.stringify(good));   // the lock now holds the real token again
  var r = await stale.models();
  assert.strictEqual(r.ok, true);
});

test('requests before connect() fail cleanly instead of throwing', async function () {
  var c = VSSidecar.create(makePlatform());
  var r = await c.models();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'unreachable');
});

// ---------------------------------------------------------------- CEP platform

test('cepPlatform maps lock file, pid and launch onto window.cep', async function () {
  var calls = [];
  var cep = {
    fs: {
      readFile: function (p) { calls.push(['read', p]); return { err: 0, data: '{"pid":5,"port":9,"token":"t"}' }; },
      deleteFile: function (p) { calls.push(['delete', p]); return { err: 0 }; },
      stat: function (p) { calls.push(['stat', p]); return { err: p.indexOf('missing') === -1 ? 0 : 1 }; }
    },
    process: {
      isRunning: function (pid) { return { err: 0, data: pid === 5 }; },
      createProcess: function () { calls.push(['spawn'].concat([].slice.call(arguments))); return { err: 0, data: 77 }; }
    }
  };
  var plat = VSSidecar.cepPlatform({
    cep: cep, appData: 'C:\\Users\\me\\AppData\\Roaming', fetch: function () {}, storage: makeStorage()
  });
  assert.deepStrictEqual(await plat.readLock(), { pid: 5, port: 9, token: 't' });
  assert.strictEqual(calls[0][1], 'C:/Users/me/AppData/Roaming/VerseSync/sidecar.json');
  assert.strictEqual(await plat.isPidAlive(5), true);
  assert.strictEqual(await plat.isPidAlive(6), false);
  await plat.deleteLock();
  assert.strictEqual(calls[calls.length - 1][0], 'delete');
  assert.strictEqual(plat.logPath, 'C:\\Users\\me\\AppData\\Roaming\\VerseSync\\logs\\sidecar.log');

  var launched = await plat.launch();
  assert.deepStrictEqual(launched, { ok: true, pid: 77 });
  var spawn = calls.filter(function (c) { return c[0] === 'spawn'; })[0];
  assert.deepStrictEqual(spawn.slice(2), ['-m', 'versesync.sidecar', '--port', '0']);
  assert.match(spawn[1], /venv\/Scripts\/pythonw\.exe$/);

  var missing = VSSidecar.cepPlatform({ cep: cep, appData: 'C:/missing', fetch: function () {}, storage: makeStorage() });
  var bad = await missing.launch();
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /not installed/);
});
