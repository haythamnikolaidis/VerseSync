'use strict';

var test = require('node:test');
var assert = require('node:assert');
var path = require('node:path');

var Bridge = require(path.join(__dirname, '..', '..', 'panel', 'js', 'bridge.js'));
var hostStub = require(path.join(__dirname, '..', '..', 'panel', 'js', 'lib', 'host-stub.js'));

function fakeCs(replies) {
  var cs = {
    scripts: [],
    listeners: {},
    evalScript: function (script, cb) {
      cs.scripts.push(script);
      var r = replies(script);
      cb(r);
    },
    addEventListener: function (type, fn) { cs.listeners[type] = fn; }
  };
  return cs;
}

function okReply(data) { return JSON.stringify({ ok: true, data: data }); }

test('init loads the jsx before pinging', function () {
  var cs = fakeCs(function (s) { return s.indexOf('VS.ping') === 0 ? okReply({ hostApi: '1.1' }) : 'undefined'; });
  var b = Bridge.create({ csInterface: cs, hostStub: hostStub, jsxPath: 'C:\\ext\\jsx\\VerseSync.jsx' });
  assert.strictEqual(b.mode, 'premiere');
  return b.init().then(function (res) {
    assert.strictEqual(res.ok, true);
    assert.strictEqual(cs.scripts[0], '$.evalFile("C:/ext/jsx/VerseSync.jsx")');
    assert.strictEqual(cs.scripts[1], 'VS.ping("{}")');
  });
});

test('init reports a failed evalFile without ping', function () {
  var cs = fakeCs(function () { return 'EvalScript error.'; });
  var b = Bridge.create({ csInterface: cs, hostStub: hostStub, jsxPath: '/x/VerseSync.jsx' });
  return b.init().then(function (res) {
    assert.strictEqual(res.ok, false);
    assert.strictEqual(cs.scripts.length, 1);
  });
});

test('call double-encodes arguments', function () {
  var cs = fakeCs(function () { return okReply(1); });
  var b = Bridge.create({ csInterface: cs, hostStub: hostStub, jsxPath: '/x' });
  return b.call('getSequenceInfo', { a: 'q"' }).then(function (res) {
    assert.deepStrictEqual(res, { ok: true, data: 1 });
    assert.strictEqual(cs.scripts[0], 'VS.getSequenceInfo(' + JSON.stringify(JSON.stringify({ a: 'q"' })) + ')');
  });
});

test('sentinel, empty and bad JSON become ok:false', function () {
  var replies = ['EvalScript error.', '', 'not json', '[1]', '{"x":1}'];
  var i = 0;
  var cs = fakeCs(function () { return replies[i++]; });
  var b = Bridge.create({ csInterface: cs, hostStub: hostStub, jsxPath: '/x' });
  var chain = Promise.resolve();
  replies.forEach(function () {
    chain = chain.then(function () {
      return b.call('ping', {}).then(function (res) {
        assert.strictEqual(res.ok, false);
        assert.strictEqual(typeof res.error, 'string');
      });
    });
  });
  return chain;
});

test('a throwing evalScript does not reject', function () {
  var cs = { evalScript: function () { throw new Error('boom'); } };
  var b = Bridge.create({ csInterface: cs, hostStub: hostStub, jsxPath: '/x' });
  return b.call('ping', {}).then(function (res) {
    assert.strictEqual(res.ok, false);
  });
});

test('stub mode routes to host-stub and ping returns hostApi 1.1', function () {
  var b = Bridge.create({ csInterface: null, hostStub: hostStub, jsxPath: null });
  assert.strictEqual(b.mode, 'stub');
  return b.init().then(function (res) {
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.data.hostApi, '1.1');
    return b.call('noSuchFunction', {});
  }).then(function (res) {
    assert.strictEqual(res.ok, false);
  });
});

test('stub mode with a throwing stub resolves ok:false', function () {
  var b = Bridge.create({ csInterface: null, hostStub: { boom: function () { throw new Error('x'); } } });
  return b.call('boom', {}).then(function (res) {
    assert.strictEqual(res.ok, false);
  });
});

test('?stub=1 forces stub mode even with csInterface', function () {
  var saved = global.location;
  global.location = { search: '?stub=1', href: 'file:///x/index.html?stub=1' };
  try {
    var b = Bridge.create({ csInterface: fakeCs(function () { return ''; }), hostStub: hostStub });
    assert.strictEqual(b.mode, 'stub');
  } finally {
    if (saved === undefined) { delete global.location; } else { global.location = saved; }
  }
});

test('events are delivered through addEventListener', function () {
  var cs = fakeCs(function () { return ''; });
  var b = Bridge.create({ csInterface: cs, hostStub: hostStub, jsxPath: '/x' });
  var seen = [];
  b.onEvent('com.versesync.progress', function (e) { seen.push(e.data); });
  cs.listeners['com.versesync.progress']({ data: '50' });
  assert.deepStrictEqual(seen, ['50']);
});
