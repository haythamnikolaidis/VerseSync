'use strict';

// connectedClient: the panel's client in CEP, forwarding to whatever client the lifecycle holds.
// Found missing in T-30.H: boot() never started the lifecycle, so the status stayed "starting".

var test = require('node:test');
var assert = require('node:assert');
var path = require('node:path');

var Sidecar = require(path.join(__dirname, '..', '..', 'panel', 'js', 'sidecar.js'));

function fakeClient(log, responses) {
  var c = {};
  ['health', 'models', 'translations', 'startJob', 'job', 'result', 'transcript', 'cancel',
    'resolve', 'shutdown'].forEach(function (name) {
    c[name] = function () {
      log.push(name);
      var next = responses && responses[name] && responses[name].shift();
      return Promise.resolve(next || { ok: true, data: { from: name } });
    };
  });
  c.eventsRequest = function (id) { return { path: '/jobs/' + id + '/events' }; };
  return c;
}

// A lifecycle whose connect() hands out the next result in `results`, after a tick.
function fakeLifecycle(results) {
  var current = null;
  var lc = {
    connects: 0,
    connect: function () {
      lc.connects++;
      var result = results.shift() || { state: 'unreachable', detail: 'log' };
      return new Promise(function (resolve) {
        setTimeout(function () {
          current = result.client ? result : null;
          resolve(result);
        }, 1);
      });
    },
    current: function () { return current; },
    drop: function () { current = null; }
  };
  return lc;
}

test('the first call connects, then forwards to the connected client', async function () {
  var log = [];
  var lc = fakeLifecycle([{ state: 'ready', client: fakeClient(log) }]);
  var client = Sidecar.connectedClient(lc);
  var res = await client.translations();
  assert.deepStrictEqual(res, { ok: true, data: { from: 'translations' } });
  assert.strictEqual(lc.connects, 1);
  await client.health();
  assert.strictEqual(lc.connects, 1, 'a held connection is reused');
  assert.deepStrictEqual(log, ['translations', 'health']);
});

test('simultaneous first calls share one connect, so only one sidecar is launched', async function () {
  var log = [];
  var lc = fakeLifecycle([{ state: 'ready', client: fakeClient(log) }]);
  var client = Sidecar.connectedClient(lc);
  await Promise.all([client.connect(), client.translations(), client.health()]);
  assert.strictEqual(lc.connects, 1);
});

test('when the sidecar cannot be reached, calls fail as unreachable and the next call retries', async function () {
  var log = [];
  var lc = fakeLifecycle([
    { state: 'unreachable', detail: 'C:\\log' },
    { state: 'ready', client: fakeClient(log) }
  ]);
  var client = Sidecar.connectedClient(lc);
  var first = await client.translations();
  assert.strictEqual(first.ok, false);
  assert.strictEqual(first.error.code, 'unreachable');
  var second = await client.translations();
  assert.strictEqual(second.ok, true);
  assert.strictEqual(lc.connects, 2);
});

test('a call that finds the sidecar gone (idle exit) reconnects and is retried once', async function () {
  var oldLog = [];
  var newLog = [];
  var gone = fakeClient(oldLog, {
    startJob: [{ ok: false, error: { code: 'unreachable', message: 'x', hint: '', status: 0 } }]
  });
  var lc = fakeLifecycle([
    { state: 'ready', client: gone },
    { state: 'ready', client: fakeClient(newLog) }
  ]);
  var client = Sidecar.connectedClient(lc);
  await client.connect();
  var res = await client.startJob({ media_path: 'x' });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(oldLog, ['startJob']);
  assert.deepStrictEqual(newLog, ['startJob']);
  assert.strictEqual(lc.connects, 2);
});

test('other errors are returned as they are, without reconnecting', async function () {
  var log = [];
  var bad = { ok: false, error: { code: 'media_not_found', message: 'm', hint: '', status: 404 } };
  var lc = fakeLifecycle([{ state: 'ready', client: fakeClient(log, { startJob: [bad] }) }]);
  var client = Sidecar.connectedClient(lc);
  var res = await client.startJob({});
  assert.deepStrictEqual(res, bad);
  assert.strictEqual(lc.connects, 1);
});

test('eventsRequest comes from the held client', async function () {
  var lc = fakeLifecycle([{ state: 'ready', client: fakeClient([]) }]);
  var client = Sidecar.connectedClient(lc);
  assert.throws(function () { client.eventsRequest('j1'); }, /No sidecar connection/);
  await client.connect();
  assert.deepStrictEqual(client.eventsRequest('j1'), { path: '/jobs/j1/events' });
});
