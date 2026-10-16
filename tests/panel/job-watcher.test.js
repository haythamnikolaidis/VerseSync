'use strict';

var test = require('node:test');
var assert = require('node:assert');
var path = require('node:path');

var Sidecar = require(path.join(__dirname, '..', '..', 'panel', 'js', 'sidecar.js'));

// Fake world: a scripted GET /jobs/{id} and a scripted SSE stream.
function makeWorld(opts) {
  opts = opts || {};
  var world = {
    jobReplies: opts.jobReplies || [],
    jobCalls: 0,
    streams: [],
    streamRequests: [],
    sleeps: [],
    data: {},
    transport: null,
    storage: null
  };
  world.transport = {
    request: function (req) {
      if (/^\/jobs\/[^/]+$/.test(req.path) && req.method === 'GET') {
        var reply = world.jobReplies[Math.min(world.jobCalls, world.jobReplies.length - 1)];
        world.jobCalls++;
        if (typeof reply === 'number') { return Promise.resolve({ status: reply, headers: {}, json: null }); }
        return Promise.resolve({ status: 200, headers: {}, json: reply });
      }
      return Promise.resolve({ status: 404, headers: {}, json: null });
    },
    stream: function (req, onEvent, onEnd) {
      var s = { req: req, onEvent: onEvent, onEnd: onEnd, closed: false };
      s.close = function () { s.closed = true; };
      world.streams.push(s);
      world.streamRequests.push(req);
      if (opts.script) { opts.script(s); }
      return s;
    }
  };
  world.storage = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(world.data, k) ? world.data[k] : null; },
    setItem: function (k, v) { world.data[k] = String(v); },
    removeItem: function (k) { delete world.data[k]; }
  };
  world.sleep = function (ms) { world.sleeps.push(ms); return Promise.resolve(); };
  world.client = Sidecar.VSSidecarClient.create({ transport: world.transport, port: 4242, token: 'tok' });
  return world;
}

function recorder() {
  var rec = { progress: [], done: [], failed: [], cancelled: [] };
  rec.callbacks = {
    onProgress: function (p) { rec.progress.push(p); },
    onDone: function (d) { rec.done.push(d); },
    onFailed: function (e) { rec.failed.push(e); },
    onCancelled: function (c) { rec.cancelled.push(c); }
  };
  return rec;
}

function watchArgs(world, rec, extra) {
  var args = {
    client: world.client, transport: world.transport, storage: world.storage,
    jobId: 'job_1', pollMs: 250, sleep: world.sleep
  };
  var k;
  for (k in rec.callbacks) { args[k] = rec.callbacks[k]; }
  for (k in (extra || {})) { args[k] = extra[k]; }
  return args;
}

function settle() {
  return new Promise(function (resolve) { setImmediate(resolve); });
}

function snap(status, progress, extra) {
  var job = { job_id: 'job_1', status: status, phase: 'detecting', progress: progress, error: null };
  for (var k in (extra || {})) { job[k] = extra[k]; }
  return job;
}

test('happy SSE run: progress events then done, storage cleared', async function () {
  var world = makeWorld({ jobReplies: [snap('done', 1)] });
  var rec = recorder();
  Sidecar.watchJob(watchArgs(world, rec));
  assert.strictEqual(world.data.activeJobId, 'job_1');
  var s = world.streams[0];
  assert.strictEqual(s.req.port, 4242);
  assert.strictEqual(s.req.path, '/jobs/job_1/events');
  assert.strictEqual(s.req.headers.Authorization, 'Bearer tok');
  assert.strictEqual(s.req.headers.Origin, Sidecar.PANEL_ORIGIN);
  s.onEvent('progress', { phase: 'transcribing', progress: 0.3 });
  s.onEvent('progress', { phase: 'detecting', progress: 0.7 });
  s.onEvent('done', { job_id: 'job_1', cue_count: 18 });
  await settle();
  assert.deepStrictEqual(rec.progress.map(function (p) { return p.progress; }), [0.3, 0.7]);
  assert.strictEqual(rec.done.length, 1);
  assert.strictEqual(rec.done[0].status, 'done');
  assert.strictEqual(rec.failed.length + rec.cancelled.length, 0);
  assert.strictEqual(world.data.activeJobId, undefined);
  assert.strictEqual(s.closed, true);
});

test('stream drops after 2 events, polling completes the job transparently', async function () {
  var world = makeWorld({
    jobReplies: [snap('running', 0.6), snap('running', 0.8), snap('done', 1)],
    script: function (s) {
      setImmediate(function () {
        s.onEvent('progress', { phase: 'transcribing', progress: 0.2 });
        s.onEvent('progress', { phase: 'transcribing', progress: 0.4 });
        s.onEnd('end');
      });
    }
  });
  var rec = recorder();
  Sidecar.watchJob(watchArgs(world, rec));
  await settle();
  await settle();
  assert.strictEqual(world.streams.length, 1);
  assert.strictEqual(world.jobCalls, 3);
  assert.deepStrictEqual(world.sleeps, [250, 250]);
  assert.deepStrictEqual(rec.progress.map(function (p) { return p.progress; }), [0.2, 0.4, 0.6, 0.8]);
  assert.strictEqual(rec.done.length, 1);
  assert.strictEqual(rec.failed.length, 0);
  assert.strictEqual(world.data.activeJobId, undefined);
});

test('a failed job is reported through polling with the sidecar error', async function () {
  var error = { code: 'model_load_failed', message: 'CUDA out of memory.', retryable: false, hint: 'Pick a smaller model.' };
  var world = makeWorld({
    jobReplies: [snap('running', 0), snap('failed', 0, { error: error })],
    script: function (s) { setImmediate(function () { s.onEnd('end'); }); }
  });
  var rec = recorder();
  Sidecar.watchJob(watchArgs(world, rec));
  await settle();
  await settle();
  assert.strictEqual(rec.failed.length, 1);
  assert.strictEqual(rec.failed[0].code, 'model_load_failed');
  assert.strictEqual(rec.failed[0].message, 'CUDA out of memory.');
  assert.strictEqual(rec.done.length, 0);
  assert.strictEqual(world.data.activeJobId, undefined);
});

test('a cancelled job is reported through polling', async function () {
  var world = makeWorld({
    jobReplies: [snap('cancelled', 0.3)],
    script: function (s) { setImmediate(function () { s.onEnd('end'); }); }
  });
  var rec = recorder();
  Sidecar.watchJob(watchArgs(world, rec));
  await settle();
  assert.strictEqual(rec.cancelled.length, 1);
  assert.strictEqual(rec.failed.length + rec.done.length, 0);
  assert.strictEqual(world.data.activeJobId, undefined);
});

test('progress never goes down, even when polling reports a lower value', async function () {
  var world = makeWorld({
    jobReplies: [snap('running', 0.5), snap('running', 0.45), snap('done', 1)],
    script: function (s) {
      setImmediate(function () {
        s.onEvent('progress', { phase: 'detecting', progress: 0.6 });
        s.onEvent('progress', { phase: 'detecting', progress: 0.55 });
        s.onEnd('end');
      });
    }
  });
  var rec = recorder();
  Sidecar.watchJob(watchArgs(world, rec));
  await settle();
  await settle();
  assert.deepStrictEqual(rec.progress.map(function (p) { return p.progress; }), [0.6, 0.6, 0.6, 0.6]);
  assert.strictEqual(rec.done.length, 1);
});

test('an unreachable sidecar during polling fails the job and clears storage', async function () {
  var world = makeWorld({
    jobReplies: [0],
    script: function (s) { setImmediate(function () { s.onEnd('error'); }); }
  });
  var rec = recorder();
  Sidecar.watchJob(watchArgs(world, rec));
  await settle();
  assert.strictEqual(rec.failed.length, 1);
  assert.strictEqual(rec.failed[0].code, 'unreachable');
  assert.strictEqual(world.data.activeJobId, undefined);
});

test('an SSE connection error falls back to polling', async function () {
  var world = makeWorld({
    jobReplies: [snap('done', 1)],
    script: function (s) { setImmediate(function () { s.onEnd('http_500'); }); }
  });
  var rec = recorder();
  Sidecar.watchJob(watchArgs(world, rec));
  await settle();
  assert.strictEqual(rec.done.length, 1);
});

test('stop() closes the stream, goes quiet and keeps the saved job id', async function () {
  var world = makeWorld({ jobReplies: [snap('done', 1)] });
  var rec = recorder();
  var watcher = Sidecar.watchJob(watchArgs(world, rec));
  var s = world.streams[0];
  watcher.stop();
  assert.strictEqual(s.closed, true);
  s.onEvent('progress', { phase: 'detecting', progress: 0.9 });
  s.onEvent('done', { job_id: 'job_1', cue_count: 1 });
  s.onEnd('closed');
  await settle();
  assert.strictEqual(rec.progress.length + rec.done.length, 0);
  assert.strictEqual(world.jobCalls, 0);
  assert.strictEqual(world.data.activeJobId, 'job_1');
});

test('rejoin after a simulated reload resumes the saved job', async function () {
  var world = makeWorld({ jobReplies: [snap('running', 0.5), snap('done', 1)] });
  var first = recorder();
  var watcher = Sidecar.watchJob(watchArgs(world, first));
  world.streams[0].onEvent('progress', { phase: 'detecting', progress: 0.4 });
  watcher.stop(); // the panel reloads; the same storage survives

  var second = recorder();
  var args = watchArgs(world, second);
  delete args.jobId;
  var resumed = Sidecar.rejoin(args);
  assert.ok(resumed);
  assert.strictEqual(world.streams.length, 2);
  assert.strictEqual(world.streams[1].req.path, '/jobs/job_1/events');
  world.streams[1].onEnd('end');
  await settle();
  await settle();
  assert.strictEqual(second.done.length, 1);
  assert.strictEqual(first.done.length, 0);
  assert.strictEqual(world.data.activeJobId, undefined);
});

test('rejoin returns null when no job was saved', function () {
  var world = makeWorld({ jobReplies: [snap('done', 1)] });
  var rec = recorder();
  var args = watchArgs(world, rec);
  delete args.jobId;
  assert.strictEqual(Sidecar.rejoin(args), null);
  assert.strictEqual(world.streams.length, 0);
});

test('rejoin of a job the sidecar no longer knows reports failure and clears storage', async function () {
  var world = makeWorld({ jobReplies: [404] });
  world.data.activeJobId = 'job_gone';
  var rec = recorder();
  var args = watchArgs(world, rec);
  delete args.jobId;
  Sidecar.rejoin(args);
  world.streams[0].onEnd('end');
  await settle();
  assert.strictEqual(rec.failed.length, 1);
  assert.strictEqual(world.data.activeJobId, undefined);
});

test('a throwing storage never breaks watching', async function () {
  var world = makeWorld({ jobReplies: [snap('done', 1)] });
  world.storage = {
    getItem: function () { throw new Error('blocked'); },
    setItem: function () { throw new Error('blocked'); },
    removeItem: function () { throw new Error('blocked'); }
  };
  var rec = recorder();
  Sidecar.watchJob(watchArgs(world, rec));
  world.streams[0].onEvent('done', { job_id: 'job_1', cue_count: 1 });
  await settle();
  assert.strictEqual(rec.done.length, 1);
  var args = watchArgs(world, rec);
  delete args.jobId;
  assert.strictEqual(Sidecar.rejoin(args), null);
});
