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
var FIELDS = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'host', 'mogrt-fields.json'), 'utf8'));

var TRANSLATIONS = [
  { id: 'kjv-id', abbreviation: 'KJV', name: 'King James Version',
    attribution: 'Public domain.', cache_allowed: true },
  { id: 'web-id', abbreviation: 'WEB', name: 'World English Bible',
    attribution: 'WEB is public domain.', cache_allowed: true }
];

function memoryStorage() {
  var m = {};
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    setItem: function (k, v) { m[k] = String(v); }
  };
}

// Fake bridge: getMogrtFields answers from FIELDS; getSequenceInfo answers from `seq`,
// which a test can change between calls.
function fakeBridge(seq) {
  var b = { calls: [], seq: seq };
  b.call = function (name) {
    b.calls.push(name);
    if (name === 'getSequenceInfo') { return Promise.resolve({ ok: true, data: b.seq }); }
    return Promise.resolve({ ok: true, data: { fields: FIELDS.fields } });
  };
  return b;
}

function fakeClient(reachable) {
  return {
    translations: function () {
      return Promise.resolve(reachable
        ? { ok: true, data: { provider: 'stub', translations: TRANSLATIONS } }
        : { ok: false, error: { code: 'unreachable' } });
    }
  };
}

function build(o) {
  o = o || {};
  var dom = new JSDOM(html);
  var doc = dom.window.document;
  var storage = memoryStorage();
  var state = State.create({ storage: storage });
  if (o.mogrt !== false) { state.set({ mogrtPath: 'C:\\t\\AV_Quote_04.mogrt' }); }
  var bridge = fakeBridge(o.seq || { hasActiveSequence: true, videoTrackCount: 4 });
  var requests = [];
  var f = {
    next: 'C:\\media\\sermon.mp4',
    showOpenDialog: function () { return { err: 0, data: [f.next] }; }
  };
  var view = Setup.create({
    root: doc.getElementById('setup'), state: state, bridge: bridge, fs: f,
    client: fakeClient(o.reachable !== false),
    onAnalyse: function (r) { requests.push(r); }
  });
  function $(id) { return doc.getElementById(id); }
  function fire(id, type, value) {
    if (value !== undefined) { $(id).value = value; }
    $(id).dispatchEvent(new dom.window.Event(type));
  }
  return { doc: doc, state: state, bridge: bridge, view: view, requests: requests, $: $, fire: fire };
}

function options(select) {
  return Array.prototype.map.call(select.options, function (o) { return o.textContent; });
}

test('the track list is ordered high to low and defaults to the topmost', async function () {
  var t = build();
  await t.view.ready;
  assert.deepStrictEqual(options(t.$('setup-track')), ['V4', 'V3', 'V2', 'V1']);
  assert.strictEqual(t.$('setup-track').value, '3');
  assert.strictEqual(t.state.get().targetTrack, 3);
});

test('Refresh re-reads the tracks', async function () {
  var t = build();
  await t.view.ready;
  t.bridge.seq = { hasActiveSequence: true, videoTrackCount: 2 };
  t.$('setup-track-refresh').dispatchEvent(new t.doc.defaultView.Event('click'));
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.deepStrictEqual(options(t.$('setup-track')), ['V2', 'V1']);
  assert.strictEqual(t.bridge.calls.filter(function (n) { return n === 'getSequenceInfo'; }).length, 2);
});

test('the translation list and its attribution render', async function () {
  var t = build();
  await t.view.ready;
  assert.deepStrictEqual(options(t.$('setup-translation')).slice(1),
    ['KJV \u2014 King James Version', 'WEB \u2014 World English Bible']);
  t.fire('setup-translation', 'change', 'web-id');
  assert.strictEqual(t.$('setup-attribution').textContent, 'WEB is public domain.');
  assert.strictEqual(t.state.get().translation, 'web-id');
});

test('the translation control is disabled while the sidecar is unreachable', async function () {
  var t = build({ reachable: false });
  await t.view.ready;
  assert.strictEqual(t.$('setup-translation').disabled, true);
  assert.strictEqual(t.$('setup-analyse').disabled, true);
  assert.strictEqual(t.$('setup-analyse-reason').textContent, "Transcription service isn't ready.");
});

test('the lead-in clamps to 0-3 and defaults to 0.5', async function () {
  var t = build();
  await t.view.ready;
  assert.strictEqual(t.$('setup-leadin').value, '0.5');
  t.fire('setup-leadin', 'change', '7');
  assert.strictEqual(t.$('setup-leadin').value, '3');
  assert.strictEqual(t.state.get().leadInSec, 3);
  t.fire('setup-leadin', 'change', '-2');
  assert.strictEqual(t.state.get().leadInSec, 0);
});

test('the Analyse reason updates as each blocker is cleared', async function () {
  var t = build({ seq: { hasActiveSequence: false, videoTrackCount: 0 } });
  await t.view.ready;
  var reason = function () { return t.$('setup-analyse-reason').textContent; };
  assert.strictEqual(reason(), 'Open a sequence in Premiere first.');
  assert.strictEqual(t.$('setup-analyse').disabled, true);

  t.bridge.seq = { hasActiveSequence: true, videoTrackCount: 3 };
  t.$('setup-track-refresh').dispatchEvent(new t.doc.defaultView.Event('click'));
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.strictEqual(reason(), 'Select a media file.');

  // Smart defaults map both fields on load, so media is the last blocker before translation.
  t.fire('setup-reference', 'change', '');
  assert.strictEqual(reason(), 'Select a media file.');
  t.view.pickMedia();
  assert.strictEqual(reason(), 'Map both template fields.');

  t.fire('setup-reference', 'change', '11');
  assert.strictEqual(reason(), 'Select a translation.');
  assert.strictEqual(t.$('setup-analyse').disabled, true);

  t.fire('setup-translation', 'change', 'kjv-id');
  assert.strictEqual(reason(), '');
  assert.strictEqual(t.$('setup-analyse').disabled, false);
});

test('the Analyse request matches the 07 POST /jobs shape', async function () {
  var t = build();
  await t.view.ready;
  t.view.pickMedia();
  t.fire('setup-reference', 'change', '11');
  t.fire('setup-body', 'change', '3');
  t.fire('setup-translation', 'change', 'kjv-id');
  t.fire('setup-leadin', 'change', '1.5');
  t.$('setup-analyse').dispatchEvent(new t.doc.defaultView.Event('click'));
  assert.deepStrictEqual(t.requests, [{
    media_path: 'C:\\media\\sermon.mp4',
    translation_id: 'kjv-id',
    options: { timing: { lead_in_s: 1.5, duration_mode: 'auto' } }
  }]);

  t.$('setup-duration-fixed').checked = true;
  t.fire('setup-duration-fixed', 'change');
  t.fire('setup-duration-sec', 'change', '6');
  t.$('setup-analyse').dispatchEvent(new t.doc.defaultView.Event('click'));
  assert.deepStrictEqual(t.requests[1].options.timing,
    { lead_in_s: 1.5, duration_mode: 'fixed', fixed_duration_s: 6 });
});

test('a disabled Analyse does not emit a request', async function () {
  var t = build();
  await t.view.ready;
  t.$('setup-analyse').dispatchEvent(new t.doc.defaultView.Event('click'));
  assert.strictEqual(t.requests.length, 0);
});
