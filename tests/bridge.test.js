'use strict';

var test = require('node:test');
var assert = require('node:assert');

var BRIDGE_PATH = require.resolve('../panel/js/bridge');
var STUB_PATH = require.resolve('../panel/js/lib/host-stub');

var EVAL_ERROR = 'EvalScript error.';

// A fake ExtendScript engine behind CSInterface.evalScript. `engine.vs` is the persistent
// global VS; evalFile replaces it with `engine.diskVs`, like $.evalFile reading the file fresh.
function makeEngine(options) {
  var engine = {
    scripts: [],
    vs: options.staleVs || null,
    diskVs: options.diskVs,
    evalFileResult: options.evalFileResult
  };
  engine.run = function (script) {
    engine.scripts.push(script);
    if (script.indexOf('$.evalFile(') === 0) {
      if (engine.evalFileResult === EVAL_ERROR) { return EVAL_ERROR; }
      engine.vs = engine.diskVs;
      return 'undefined';
    }
    if (script.indexOf('typeof VS') === 0) {
      return engine.vs && typeof engine.vs.ping === 'function' ? 'function' : 'undefined';
    }
    var m = /^VS\.(\w+)\((".*")\)$/.exec(script);
    if (m) {
      if (!engine.vs || typeof engine.vs[m[1]] !== 'function') { return EVAL_ERROR; }
      return engine.vs[m[1]](JSON.parse(m[2]));
    }
    return EVAL_ERROR;
  };
  return engine;
}

function loadBridge(engine, winExtras) {
  delete require.cache[BRIDGE_PATH];
  function FakeCSInterface() {}
  FakeCSInterface.prototype.evalScript = function (script, cb) {
    var result = engine.run(script);
    setTimeout(function () { cb(result); }, 0);
  };
  FakeCSInterface.prototype.getSystemPath = function () { return 'Invalid Input Params'; };
  global.CSInterface = FakeCSInterface;
  global.SystemPath = { EXTENSION: 'extension' };
  global.window = Object.assign({
    __adobe_cep__: {},
    location: { href: 'file:///C:/Users/me/AppData/Roaming/Adobe/CEP/extensions/VerseSync/index.html', search: '' }
  }, winExtras || {});
  return require(BRIDGE_PATH);
}

function cleanup() {
  delete global.CSInterface;
  delete global.SystemPath;
  delete global.window;
  delete require.cache[BRIDGE_PATH];
}

function okVs() {
  return {
    ping: function () { return JSON.stringify({ ok: true, data: { pong: true, version: '1.0.0', hostApi: '1.1' } }); },
    fail: function () { return JSON.stringify({ ok: false, error: 'No active sequence' }); },
    echo: function (arg) { return JSON.stringify({ ok: true, data: JSON.parse(arg) }); },
    garbage: function () { return 'not json'; },
    nothing: function () { return 'undefined'; }
  };
}

test('loadJSX evaluates the host from the URL-derived extension root, then VS.ping resolves', async function () {
  var engine = makeEngine({ diskVs: okVs() });
  var bridge = loadBridge(engine);
  try {
    var loaded = await bridge.loadJSX();
    assert.strictEqual(loaded.ok, true);
    assert.strictEqual(
      engine.scripts[0],
      '$.evalFile("C:/Users/me/AppData/Roaming/Adobe/CEP/extensions/VerseSync/jsx/VerseSync.jsx")'
    );
    var res = await bridge.api.ping();
    assert.deepStrictEqual(res, { ok: true, data: { pong: true, version: '1.0.0', hostApi: '1.1' } });
    assert.strictEqual(bridge.mode(), 'host');
  } finally { cleanup(); }
});

test('stale script: loadJSX replaces whatever an earlier session left in the engine', async function () {
  var stale = { ping: function () { return JSON.stringify({ ok: true, data: { pong: true, version: 'stale' } }); } };
  var engine = makeEngine({ staleVs: stale, diskVs: okVs() });
  var bridge = loadBridge(engine);
  try {
    var res = await bridge.api.ping();
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.version, '1.0.0');
    assert.strictEqual(engine.scripts[0].indexOf('$.evalFile('), 0, 'evalFile runs before the first call');
  } finally { cleanup(); }
});

test('loadJSX is called once and shared by concurrent calls', async function () {
  var engine = makeEngine({ diskVs: okVs() });
  var bridge = loadBridge(engine);
  try {
    await Promise.all([bridge.api.ping(), bridge.api.ping()]);
    var loads = engine.scripts.filter(function (s) { return s.indexOf('$.evalFile(') === 0; });
    assert.strictEqual(loads.length, 1);
  } finally { cleanup(); }
});

test('a failing $.evalFile resolves {ok:false}, never throws, and is retried on the next call', async function () {
  var engine = makeEngine({ diskVs: okVs(), evalFileResult: EVAL_ERROR });
  var bridge = loadBridge(engine);
  try {
    var first = await bridge.loadJSX();
    assert.strictEqual(first.ok, false);
    assert.match(first.error, /evalFile failed/);

    engine.evalFileResult = undefined;
    var res = await bridge.api.ping();
    assert.strictEqual(res.ok, true);
  } finally { cleanup(); }
});

test('a host script that does not define VS.ping is reported as an error', async function () {
  var engine = makeEngine({ diskVs: {} });
  var bridge = loadBridge(engine);
  try {
    var res = await bridge.api.ping();
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /VS\.ping is not a function/);
  } finally { cleanup(); }
});

test('host {ok:false,error} surfaces as a resolved value, not an exception', async function () {
  var engine = makeEngine({ diskVs: okVs() });
  var bridge = loadBridge(engine);
  try {
    var res = await bridge.call('fail');
    assert.deepStrictEqual(res, { ok: false, error: 'No active sequence' });
  } finally { cleanup(); }
});

test('the EvalScript error. sentinel surfaces as {ok:false}', async function () {
  var engine = makeEngine({ diskVs: okVs() });
  var bridge = loadBridge(engine);
  try {
    var res = await bridge.call('doesNotExist');
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /doesNotExist/);
    assert.match(res.error, /EvalScript error\./);
  } finally { cleanup(); }
});

test('non-JSON and empty host replies surface as {ok:false}', async function () {
  var engine = makeEngine({ diskVs: okVs() });
  var bridge = loadBridge(engine);
  try {
    var garbage = await bridge.call('garbage');
    assert.strictEqual(garbage.ok, false);
    assert.match(garbage.error, /Non-JSON/);
    var nothing = await bridge.call('nothing');
    assert.strictEqual(nothing.ok, false);
    assert.match(nothing.error, /no result/);
  } finally { cleanup(); }
});

test('arguments are passed to the host as a single JSON string', async function () {
  var engine = makeEngine({ diskVs: okVs() });
  var bridge = loadBridge(engine);
  try {
    var res = await bridge.call('echo', { trackIndex: 2, text: 'a "quoted" \\ value' });
    assert.deepStrictEqual(res, { ok: true, data: { trackIndex: 2, text: 'a "quoted" \\ value' } });
    var noArgs = await bridge.call('echo');
    assert.deepStrictEqual(noArgs, { ok: true, data: {} });
  } finally { cleanup(); }
});

test('unserialisable arguments resolve {ok:false}', async function () {
  var engine = makeEngine({ diskVs: okVs() });
  var bridge = loadBridge(engine);
  try {
    var circular = {};
    circular.self = circular;
    var res = await bridge.call('echo', circular);
    assert.strictEqual(res.ok, false);
  } finally { cleanup(); }
});

test('stub: used when not inside Premiere and window.VS is installed', async function () {
  delete require.cache[STUB_PATH];
  var VS = require(STUB_PATH);
  var engine = makeEngine({ diskVs: okVs() });
  var bridge = loadBridge(engine, { __adobe_cep__: undefined, VS: VS });
  try {
    assert.strictEqual(bridge.mode(), 'stub');
    var res = await bridge.api.ping();
    assert.deepStrictEqual(res, { ok: true, data: { pong: true, version: '1.0.0', hostApi: '1.1' } });
    assert.strictEqual(engine.scripts.length, 0, 'the stub path never touches evalScript');
    var unknown = await bridge.call('nope');
    assert.strictEqual(unknown.ok, false);
  } finally { cleanup(); }
});

test('stub: never used inside Premiere, even if window.VS is present', async function () {
  delete require.cache[STUB_PATH];
  var VS = require(STUB_PATH);
  var engine = makeEngine({ diskVs: okVs() });
  var bridge = loadBridge(engine, { __adobe_cep__: {}, VS: VS });
  try {
    assert.strictEqual(bridge.mode(), 'host');
    var res = await bridge.api.ping();
    assert.strictEqual(res.ok, true);
    assert.ok(engine.scripts.length > 0, 'the real host path was used');
  } finally { cleanup(); }
});
