'use strict';

var test = require('node:test');
var assert = require('node:assert');
var path = require('node:path');

var Sidecar = require(path.join(__dirname, '..', '..', 'panel', 'js', 'sidecar.js'));

var LOCK = '/home/vs/sidecar.json';

// Fake world: virtual clock, in-memory lock file, scripted health replies, recorded spawns.
function makeWorld(opts) {
  opts = opts || {};
  var world = {
    time: 0,
    files: {},
    alive: {},
    spawns: [],
    shutdowns: 0,
    healthCalls: 0,
    states: [],
    health: opts.health || function () { return { ok: true, data: { status: 'ready' } }; },
    // When set, a launch writes this lock after `writeLockAfterMs` of fake time.
    launchLock: opts.launchLock || null,
    writeLockAfterMs: opts.writeLockAfterMs || 0,
    launchedAt: null
  };
  if (opts.lock) { world.files[LOCK] = JSON.stringify(opts.lock); }
  world.sleep = function (ms) { world.time += ms; return Promise.resolve(); };
  world.fs = {
    readFileSync: function (p) {
      if (p === LOCK && world.launchLock && world.launchedAt !== null &&
          world.time - world.launchedAt >= world.writeLockAfterMs && !world.files[LOCK]) {
        world.files[LOCK] = JSON.stringify(world.launchLock);
      }
      if (world.files[p] === undefined) { throw new Error('ENOENT'); }
      return world.files[p];
    },
    unlinkSync: function (p) {
      if (world.files[p] === undefined) { throw new Error('ENOENT'); }
      delete world.files[p];
    }
  };
  world.childProcess = {
    spawn: function (exe, args, options) {
      var child = { unrefCalled: false, on: function () {}, unref: function () { child.unrefCalled = true; } };
      world.spawns.push({ exe: exe, args: args, options: options, child: child });
      world.launchedAt = world.time;
      return child;
    }
  };
  world.clientFactory = function (conn) {
    return {
      conn: conn,
      health: function () {
        world.healthCalls++;
        return Promise.resolve(world.health(conn));
      },
      shutdown: function () {
        world.shutdowns++;
        world.alive[100] = false;
        return Promise.resolve({ ok: true, data: {} });
      }
    };
  };
  world.lifecycle = function (extra) {
    var o = {
      fs: world.fs,
      childProcess: world.childProcess,
      env: { VERSESYNC_HOME: '/home/vs' },
      platform: 'linux',
      clientFactory: world.clientFactory,
      now: function () { return world.time; },
      sleep: world.sleep,
      isProcessAlive: function (pid) { return world.alive[pid] !== false; },
      launchCommand: ['pythonw', '-m', 'versesync.sidecar']
    };
    for (var k in (extra || {})) { o[k] = extra[k]; }
    var lc = Sidecar.createLifecycle(o);
    lc.onState(function (state) { world.states.push(state); });
    return lc;
  };
  return world;
}

var LIVE = { pid: 100, port: 5001, token: 'tok' };

test('attaches to a live lock without launching a second sidecar', async function () {
  var world = makeWorld({ lock: LIVE });
  var res = await world.lifecycle().connect();
  assert.strictEqual(res.state, 'ready');
  assert.strictEqual(res.client.conn.port, 5001);
  assert.strictEqual(res.client.conn.token, 'tok');
  assert.strictEqual(world.spawns.length, 0);
  assert.ok(world.files[LOCK], 'live lock is left in place');
  assert.deepStrictEqual(world.states, ['starting', 'ready']);
});

test('a lock whose PID is dead is deleted and a sidecar is launched', async function () {
  var fresh = { pid: 200, port: 6002, token: 'new' };
  var world = makeWorld({ lock: LIVE, launchLock: fresh });
  world.alive[100] = false;
  var res = await world.lifecycle().connect();
  assert.strictEqual(res.state, 'ready');
  assert.strictEqual(world.spawns.length, 1);
  assert.strictEqual(res.client.conn.port, 6002, 'the new lock is read, not the stale one');
  assert.strictEqual(JSON.parse(world.files[LOCK]).pid, 200);
});

test('a live PID that does not answer /health is treated as a stale lock', async function () {
  var fresh = { pid: 200, port: 6002, token: 'new' };
  var world = makeWorld({
    lock: LIVE,
    launchLock: fresh,
    health: function (conn) {
      return conn.port === 5001 ? { ok: false, error: { code: 'unreachable' } } : { ok: true, data: { status: 'ready' } };
    }
  });
  var res = await world.lifecycle().connect();
  assert.strictEqual(res.state, 'ready');
  assert.strictEqual(world.spawns.length, 1);
  assert.strictEqual(res.client.conn.port, 6002);
});

test('launches detached with stdio ignored and unrefs the child', async function () {
  var world = makeWorld({ launchLock: { pid: 200, port: 6002, token: 'n' } });
  await world.lifecycle().connect();
  var spawn = world.spawns[0];
  assert.strictEqual(spawn.exe, 'pythonw');
  assert.deepStrictEqual(spawn.args, ['-m', 'versesync.sidecar']);
  assert.deepStrictEqual(spawn.options, { detached: true, stdio: 'ignore' });
  assert.strictEqual(spawn.child.unrefCalled, true);
});

test('cold start polls every 500 ms and succeeds once the lock and health appear', async function () {
  var world = makeWorld({ launchLock: { pid: 200, port: 6002, token: 'n' }, writeLockAfterMs: 3000 });
  var res = await world.lifecycle().connect();
  assert.strictEqual(res.state, 'ready');
  assert.strictEqual(world.time, 3000);
});

test('health polling gives up as unreachable at exactly 30 s, with the log path', async function () {
  var world = makeWorld({ health: function () { return { ok: true, data: { status: 'starting' } }; },
    launchLock: { pid: 200, port: 6002, token: 'n' } });
  var res = await world.lifecycle().connect();
  assert.strictEqual(res.state, 'unreachable');
  assert.strictEqual(res.detail, '/home/vs/logs/sidecar.log');
  assert.strictEqual(res.client, undefined);
  assert.strictEqual(world.time, 30000, 'not 5 s, not 30.5 s');
  assert.deepStrictEqual(world.states.slice(0, 1), ['starting']);
  assert.strictEqual(world.states[world.states.length - 1], 'unreachable');
});

test('a sidecar that is still answering at 29.5 s is accepted', async function () {
  var world = makeWorld({ health: function () {
    return world.time >= 29500 ? { ok: true, data: { status: 'ready' } } : { ok: true, data: { status: 'starting' } };
  }, launchLock: { pid: 200, port: 6002, token: 'n' } });
  var res = await world.lifecycle().connect();
  assert.strictEqual(res.state, 'ready');
  assert.strictEqual(world.time, 29500);
});

test('no lock ever written: unreachable at 30 s', async function () {
  var world = makeWorld();
  var res = await world.lifecycle().connect();
  assert.strictEqual(res.state, 'unreachable');
  assert.strictEqual(world.time, 30000);
});

test('a spawn that throws fails fast as unreachable', async function () {
  var world = makeWorld();
  world.childProcess.spawn = function () { throw new Error('ENOENT'); };
  var res = await world.lifecycle().connect();
  assert.strictEqual(res.state, 'unreachable');
  assert.strictEqual(world.time, 0);
});

test('degraded health maps to the degraded state, with the health body as detail', async function () {
  var body = { status: 'degraded', device: 'cpu' };
  var world = makeWorld({ lock: LIVE, health: function () { return { ok: true, data: body }; } });
  var res = await world.lifecycle().connect();
  assert.strictEqual(res.state, 'degraded');
  assert.ok(res.client);
  assert.strictEqual(res.detail, body);
});

test('busy health is ready', async function () {
  var world = makeWorld({ lock: LIVE, health: function () { return { ok: true, data: { status: 'busy' } }; } });
  assert.strictEqual((await world.lifecycle().connect()).state, 'ready');
});

test('an API version mismatch maps to version_mismatch and keeps the lock', async function () {
  var world = makeWorld({ lock: LIVE, health: function () {
    return { ok: false, error: { code: 'api_version_mismatch', message: 'v2' } };
  } });
  var res = await world.lifecycle().connect();
  assert.strictEqual(res.state, 'version_mismatch');
  assert.ok(res.client, 'the client is returned so the panel can offer restart');
  assert.strictEqual(world.spawns.length, 0);
  assert.ok(world.files[LOCK]);
});

test('lock path falls back to APPDATA\\VerseSync on Windows, and the log path follows', async function () {
  var world = makeWorld();
  var lock = 'C:\\Users\\a\\AppData\\Roaming\\VerseSync\\sidecar.json';
  world.files[lock] = JSON.stringify(LIVE);
  var res = await world.lifecycle({ env: { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, platform: 'win32' }).connect();
  assert.strictEqual(res.state, 'ready');
  var down = makeWorld();
  var lc = down.lifecycle({ env: { APPDATA: 'C:\\A' }, platform: 'win32', healthTimeoutMs: 0 });
  var gone = await lc.connect();
  assert.strictEqual(gone.detail, 'C:\\A\\VerseSync\\logs\\sidecar.log');
});

test('default launch command is the venv pythonw running versesync.sidecar', async function () {
  var world = makeWorld({ healthTimeoutMs: 0 });
  var lc = world.lifecycle({ launchCommand: undefined, env: { VERSESYNC_HOME: 'C:\\V' }, platform: 'win32', healthTimeoutMs: 0 });
  await lc.connect();
  assert.strictEqual(world.spawns[0].exe, 'C:\\V\\venv\\Scripts\\pythonw.exe');
  assert.deepStrictEqual(world.spawns[0].args.slice(0, 2), ['-m', 'versesync.sidecar']);
});

test('dispose never shuts the sidecar down', async function () {
  var world = makeWorld({ lock: LIVE });
  var lc = world.lifecycle();
  await lc.connect();
  lc.dispose();
  assert.strictEqual(world.shutdowns, 0);
  assert.ok(world.files[LOCK]);
});

test('restart shuts the old sidecar down, waits, then launches a new one', async function () {
  var fresh = { pid: 200, port: 6002, token: 'new' };
  var world = makeWorld({ lock: LIVE, launchLock: fresh });
  var res = await world.lifecycle().restart();
  assert.strictEqual(world.shutdowns, 1);
  assert.strictEqual(world.spawns.length, 1);
  assert.strictEqual(res.state, 'ready');
  assert.strictEqual(res.client.conn.port, 6002);
});
