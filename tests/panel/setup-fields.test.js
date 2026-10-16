'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var JSDOM = require('jsdom').JSDOM;

var panel = path.join(__dirname, '..', '..', 'panel');
var Setup = require(path.join(panel, 'js', 'setup.js'));
var State = require(path.join(panel, 'js', 'state.js'));
var html = fs.readFileSync(path.join(panel, 'index.html'), 'utf8');
var AV_QUOTE = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'host', 'mogrt-fields.json'), 'utf8'));

function memoryStorage() {
  var m = {};
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    setItem: function (k, v) { m[k] = String(v); }
  };
}

// A fake cep.fs whose next dialog result is set per test; records the calls it receives.
function fakeFs() {
  var f = { calls: [], next: null };
  f.showOpenDialog = function () {
    f.calls.push(Array.prototype.slice.call(arguments));
    return { err: 0, data: f.next ? [f.next] : [] };
  };
  return f;
}

// A bridge that answers getMogrtFields from a path -> response table.
function fakeBridge(table) {
  var b = { calls: [] };
  b.call = function (name, args) {
    b.calls.push({ name: name, args: args });
    var res = table[args.path];
    return Promise.resolve(res);
  };
  return b;
}

function setup(table, storage) {
  var dom = new JSDOM(html);
  var doc = dom.window.document;
  var state = State.create({ storage: storage || memoryStorage() });
  var f = fakeFs();
  var bridge = fakeBridge(table || {});
  var view = Setup.create({ root: doc.getElementById('setup'), state: state, bridge: bridge, fs: f });
  function $(id) { return doc.getElementById(id); }
  function click(id) { $(id).dispatchEvent(new dom.window.Event('click')); }
  function choose(id, value) {
    $(id).value = value;
    $(id).dispatchEvent(new dom.window.Event('change'));
  }
  return { doc: doc, state: state, fs: f, bridge: bridge, view: view, $: $, click: click, choose: choose };
}

var A = 'C:\\templates\\AV_Quote_04.mogrt';
var B = 'C:\\templates\\Other.mogrt';
var OTHER_FIELDS = {
  fields: [
    { index: 0, name: 'Text', group: 'Caption', label: 'Caption > Text' },
    { index: 1, name: 'Text', group: 'Body', label: 'Body > Text' },
    { index: 2, name: 'Text', group: 'Extra', label: 'Extra > Text' }
  ]
};

test('picking AV_Quote_04 fills both dropdowns with the smart defaults', function () {
  var t = setup();
  t.bridge.call = function () { return Promise.resolve({ ok: true, data: AV_QUOTE }); };
  t.fs.next = A;
  return t.view.pickTemplate().then(function () {
    assert.strictEqual(t.$('setup-reference').value, '11');
    assert.strictEqual(t.$('setup-body').value, '3');
    var labels = Array.from(t.$('setup-reference').options).map(function (o) { return o.textContent; });
    assert.ok(labels.indexOf('Description > Text') !== -1);
    assert.ok(labels.indexOf('Title Main > Text') !== -1);
    assert.strictEqual(t.$('setup-template-name').textContent, 'AV_Quote_04.mogrt');
    assert.strictEqual(t.$('setup-template-name').title, A);
    assert.deepStrictEqual(t.state.fieldMappingFor(A), { referenceIndex: 11, bodyIndex: 3 });
  });
});

test('media dialog is filtered to audio and video and shows basename with path title', function () {
  var t = setup();
  t.fs.next = 'D:\\audio\\sermon.mp3';
  t.click('setup-media-btn');
  assert.strictEqual(t.fs.calls.length, 1);
  var extensions = t.fs.calls[0][4];
  assert.ok(extensions.indexOf('mp3') !== -1 && extensions.indexOf('mp4') !== -1);
  assert.strictEqual(extensions.indexOf('mogrt'), -1);
  assert.strictEqual(t.$('setup-media-name').textContent, 'sermon.mp3');
  assert.strictEqual(t.$('setup-media-name').title, 'D:\\audio\\sermon.mp3');
  assert.strictEqual(t.state.get().mediaPath, 'D:\\audio\\sermon.mp3');
});

test('a cancelled dialog changes nothing', function () {
  var t = setup();
  t.fs.next = null;
  t.click('setup-media-btn');
  assert.strictEqual(t.state.get().mediaPath, null);
  assert.strictEqual(t.$('setup-media-name').textContent, 'No file selected');
});

test('the template dialog is filtered to .mogrt and shows a busy state while reading', function () {
  var t = setup();
  var release;
  t.bridge.call = function () {
    return new Promise(function (resolve) { release = resolve; });
  };
  t.fs.next = A;
  var p = t.view.pickTemplate();
  assert.deepStrictEqual(t.fs.calls[0][4], ['mogrt']);
  assert.strictEqual(t.$('setup-template-msg').textContent, 'Reading template…');
  assert.strictEqual(t.$('setup-template-msg').hidden, false);
  assert.strictEqual(t.$('setup-template-btn').disabled, true);
  release({ ok: true, data: AV_QUOTE });
  return p.then(function () {
    assert.strictEqual(t.$('setup-template-msg').hidden, true);
    assert.strictEqual(t.$('setup-template-btn').disabled, false);
  });
});

test('an empty fields response shows the After Effects warning', function () {
  var t = setup();
  t.bridge.call = function () { return Promise.resolve({ ok: true, data: { fields: [] } }); };
  t.fs.next = A;
  return t.view.pickTemplate().then(function () {
    var msg = t.$('setup-template-msg');
    assert.strictEqual(msg.hidden, false);
    assert.match(msg.textContent, /After Effects/);
    assert.strictEqual(t.$('setup-reference').disabled, true);
    assert.strictEqual(t.state.get().mogrtFields.length, 0);
  });
});

test('switching templates restores each template\'s saved mapping', function () {
  var t = setup();
  t.bridge.call = function (name, args) {
    return Promise.resolve({ ok: true, data: args.path === A ? AV_QUOTE : OTHER_FIELDS });
  };
  t.fs.next = A;
  return t.view.pickTemplate().then(function () {
    t.choose('setup-reference', '3');
    t.choose('setup-body', '11');
    t.fs.next = B;
    return t.view.pickTemplate();
  }).then(function () {
    assert.strictEqual(t.$('setup-reference').value, '0');
    assert.strictEqual(t.$('setup-body').value, '1');
    t.choose('setup-body', '2');
    t.fs.next = A;
    return t.view.pickTemplate();
  }).then(function () {
    assert.strictEqual(t.$('setup-reference').value, '3');
    assert.strictEqual(t.$('setup-body').value, '11');
    t.fs.next = B;
    return t.view.pickTemplate();
  }).then(function () {
    assert.strictEqual(t.$('setup-reference').value, '0');
    assert.strictEqual(t.$('setup-body').value, '2');
  });
});

test('a changed mapping is stored as indices and survives a restart', function () {
  var storage = memoryStorage();
  var t = setup(null, storage);
  t.bridge.call = function () { return Promise.resolve({ ok: true, data: AV_QUOTE }); };
  t.fs.next = A;
  return t.view.pickTemplate().then(function () {
    t.choose('setup-reference', '3');
    t.choose('setup-body', '11');
    var t2 = setup({ [A]: { ok: true, data: AV_QUOTE } }, storage);
    return t2.view.ready.then(function () {
      assert.strictEqual(t2.$('setup-template-name').textContent, 'AV_Quote_04.mogrt');
      assert.strictEqual(t2.$('setup-reference').value, '3');
      assert.strictEqual(t2.$('setup-body').value, '11');
      assert.strictEqual(t2.$('setup-media-name').textContent, 'No file selected');
    });
  });
});

test('a bridge error shows its message in place and keeps the previous template', function () {
  var t = setup();
  var answers = [
    { ok: true, data: AV_QUOTE },
    { ok: false, error: 'Open a sequence in Premiere first.' }
  ];
  t.bridge.call = function () { return Promise.resolve(answers.shift()); };
  t.fs.next = A;
  return t.view.pickTemplate().then(function () {
    t.fs.next = B;
    return t.view.pickTemplate();
  }).then(function () {
    var msg = t.$('setup-template-msg');
    assert.strictEqual(msg.hidden, false);
    assert.strictEqual(msg.textContent, 'Open a sequence in Premiere first.');
    assert.strictEqual(t.state.get().mogrtPath, A);
    assert.strictEqual(t.$('setup-template-btn').disabled, false);
  });
});

test('it uses cep.fs only, never ExtendScript File.openDialog', function () {
  var src = fs.readFileSync(path.join(panel, 'js', 'setup.js'), 'utf8');
  assert.ok(src.indexOf('File.openDialog') === -1);
  assert.ok(src.indexOf('showOpenDialog') !== -1);
});
