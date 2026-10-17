'use strict';

// The real lifecycle, client, transport and job watcher against the real mock process.

var test = require('node:test');
var assert = require('node:assert');
var http = require('node:http');
var path = require('node:path');

var Sidecar = require(path.join(__dirname, '..', '..', 'panel', 'js', 'sidecar.js'));
var spawnMock = require(path.join(__dirname, 'helpers', 'spawn-mock.js'));

var TRANSLATION_ID = 'de4e12af7f28f599-02';
var JOB_SECONDS = '2';

var skip = spawnMock.pythonAvailable() ? false : 'python3 is not on PATH; skipping mock integration tests';

function setup(t, flags) {
  var world = spawnMock.createMockEnv();
  t.after(function () { world.cleanup(); });
  var transport = Sidecar.createNodeTransport(http);
  var lifecycle = Sidecar.createLifecycle({
    fs: require('node:fs'),
    childProcess: world.childProcess,
    env: world.env,
    platform: process.platform,
    clientFactory: function (conn) {
      return Sidecar.VSSidecarClient.create({ transport: transport, port: conn.port, token: conn.token });
    },
    now: Date.now,
    sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
    launchCommand: world.launchCommand(flags)
  });
  return { world: world, transport: transport, lifecycle: lifecycle };
}

function storageStub() {
  var data = {};
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem: function (k, v) { data[k] = String(v); },
    removeItem: function (k) { delete data[k]; }
  };
}

// Starts a job and resolves with the first terminal callback the watcher fires.
function runJob(env, client) {
  return client.startJob({ media_path: 'D:/x.mxf', translation_id: TRANSLATION_ID }).then(function (res) {
    assert.strictEqual(res.ok, true, 'startJob should succeed');
    return new Promise(function (resolve) {
      Sidecar.watchJob({
        client: client,
        transport: env.transport,
        storage: storageStub(),
        jobId: res.data.id || res.data.job_id,
        pollMs: 100,
        onProgress: function () {},
        onDone: function (job) { resolve({ kind: 'done', value: job }); },
        onFailed: function (err) { resolve({ kind: 'failed', value: err }); },
        onCancelled: function (job) { resolve({ kind: 'cancelled', value: job }); }
      });
    });
  });
}

test('cold start reaches ready', { skip: skip }, function (t) {
  var env = setup(t, ['--duration', JOB_SECONDS]);
  var states = [];
  env.lifecycle.onState(function (s) { states.push(s); });
  return env.lifecycle.connect().then(function (result) {
    assert.strictEqual(result.state, 'ready');
    assert.strictEqual(env.world.childProcess.spawnCount, 1);
    assert.strictEqual(states[0], 'starting');
    assert.strictEqual(states[states.length - 1], 'ready');
    return result.client.models();
  }).then(function (res) {
    assert.strictEqual(res.ok, true, 'authenticated call works with the lock-file token');
  });
});

test('a second connect attaches to the running process', { skip: skip }, function (t) {
  var env = setup(t, ['--duration', JOB_SECONDS]);
  var firstPid;
  return env.lifecycle.connect().then(function (first) {
    assert.strictEqual(first.state, 'ready');
    firstPid = env.world.readLock().pid;
    return env.lifecycle.connect();
  }).then(function (second) {
    assert.strictEqual(second.state, 'ready');
    assert.strictEqual(env.world.childProcess.spawnCount, 1, 'only one process was launched');
    assert.strictEqual(env.world.readLock().pid, firstPid);
  });
});

test('--drop-sse completes through polling', { skip: skip }, function (t) {
  var env = setup(t, ['--duration', JOB_SECONDS, '--drop-sse']);
  return env.lifecycle.connect().then(function (result) {
    assert.strictEqual(result.state, 'ready');
    return runJob(env, result.client);
  }).then(function (outcome) {
    assert.strictEqual(outcome.kind, 'done');
  });
});

test('--fail model_load_failed surfaces the exact OOM message', { skip: skip }, function (t) {
  var env = setup(t, ['--fail', 'model_load_failed']);
  return env.lifecycle.connect().then(function (result) {
    return runJob(env, result.client);
  }).then(function (outcome) {
    assert.strictEqual(outcome.kind, 'failed');
    assert.strictEqual(outcome.value.code, 'model_load_failed');
    assert.strictEqual(outcome.value.message,
      'Could not load large-v3-turbo on cuda: out of memory (9.1 GB free, ~10.4 GB required).');
  });
});

test('--api-version 2.0 gives version_mismatch', { skip: skip }, function (t) {
  var env = setup(t, ['--api-version', '2.0']);
  return env.lifecycle.connect().then(function (result) {
    assert.strictEqual(result.state, 'version_mismatch');
  });
});

test('--die-mid-job leads to unreachable on the next poll', { skip: skip }, function (t) {
  var env = setup(t, ['--duration', JOB_SECONDS, '--die-mid-job']);
  return env.lifecycle.connect().then(function (result) {
    assert.strictEqual(result.state, 'ready');
    return runJob(env, result.client);
  }).then(function (outcome) {
    assert.strictEqual(outcome.kind, 'failed');
    assert.strictEqual(outcome.value.code, 'unreachable');
  });
});

test('--degraded gives the degraded state', { skip: skip }, function (t) {
  var env = setup(t, ['--degraded']);
  return env.lifecycle.connect().then(function (result) {
    assert.strictEqual(result.state, 'degraded');
    assert.ok(result.client, 'a degraded sidecar is still usable');
  });
});
