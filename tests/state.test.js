'use strict';

// panel/js/state.js: persistence, smart defaults, mapping validation, the Analyse gate and
// the progress maths. DOM-free, so it runs here directly. The host stub supplies the field
// list for AV_Quote_04.mogrt so the defaults are checked against the real fixture shape.

var test = require('node:test');
var assert = require('node:assert');

var VSState = require('../panel/js/state');
var VSSidecar = require('../panel/js/sidecar');
var fixture = require('./fixtures/host/mogrt-fields.json');

function memoryStorage() {
  var m = {};
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    setItem: function (k, v) { m[k] = String(v); },
    dump: m
  };
}

var FIELDS = (fixture.data || fixture).fields;

function readyStrip() {
  return VSSidecar.computeStrip({ state: 'ready', health: { device: 'cuda' } }, true);
}

// A state that satisfies every Analyse condition; tests knock one condition out at a time.
function validState() {
  var s = VSState.create(memoryStorage());
  s.set({
    mediaPath: 'D:/Sermons/SERMON_A001.MXF',
    mogrtPath: 'D:/T/AV_Quote_04.mogrt',
    mogrtFields: FIELDS,
    translations: [{ id: 'kjv', abbreviation: 'KJV', name: 'King James Version' }],
    translationId: 'kjv',
    hasSequence: true,
    videoTrackCount: 3,
    trackIndex: 2
  });
  s.setMapping(11, 3);
  return s;
}

test('smart defaults pick Description for the reference and Title Main for the body', function () {
  var d = VSState.smartDefaults(FIELDS);
  assert.strictEqual(d.referenceIndex, 11);
  assert.strictEqual(d.bodyIndex, 3);
});

test('smart defaults never return the same field twice', function () {
  var both = [{ index: 1, name: 'Text', group: 'Main Description' },
              { index: 2, name: 'Text', group: 'Other' }];
  var d = VSState.smartDefaults(both);
  assert.notStrictEqual(d.referenceIndex, d.bodyIndex);
  var one = VSState.smartDefaults([{ index: 5, name: 'Text', group: 'Title' }]);
  assert.strictEqual(one.bodyIndex, 5);
  assert.strictEqual(one.referenceIndex, null);
  assert.deepStrictEqual(VSState.smartDefaults([]), { referenceIndex: null, bodyIndex: null });
});

test('mapping the same field to both slots is rejected and not remembered', function () {
  var storage = memoryStorage();
  var s = VSState.create(storage);
  s.set({ mogrtPath: 'a.mogrt' });
  s.setMapping(11, 3);
  s.setMapping(3, 3);
  assert.match(VSState.validateMapping(s.get().mapping), /different fields/);
  assert.deepStrictEqual(s.loadMapping('a.mogrt'), { referenceIndex: 11, bodyIndex: 3 });
});

test('mappings are remembered per MOGRT path by index and survive a new store', function () {
  var storage = memoryStorage();
  var s = VSState.create(storage);
  s.set({ mogrtPath: 'a.mogrt' });
  s.setMapping(11, 3);
  s.set({ mogrtPath: 'b.mogrt' });
  s.setMapping(2, 7);
  var again = VSState.create(storage);
  assert.deepStrictEqual(again.loadMapping('a.mogrt'), { referenceIndex: 11, bodyIndex: 3 });
  assert.deepStrictEqual(again.loadMapping('b.mogrt'), { referenceIndex: 2, bodyIndex: 7 });
  assert.strictEqual(again.loadMapping('c.mogrt'), null);
});

test('every persisted setting survives a restart, the media file does not', function () {
  var storage = memoryStorage();
  var s = VSState.create(storage);
  s.set({ mediaPath: 'D:/x.mp4', mogrtPath: 'a.mogrt', translationId: 'kjv', trackIndex: 1,
          durationMode: 'fixed' });
  s.setLeadInText('1.25');
  s.setFixedText('9');
  var r = VSState.create(storage).get();
  assert.strictEqual(r.mediaPath, null);
  assert.strictEqual(r.mogrtPath, 'a.mogrt');
  assert.strictEqual(r.translationId, 'kjv');
  assert.strictEqual(r.trackIndex, 1);
  assert.strictEqual(r.durationMode, 'fixed');
  assert.strictEqual(r.leadInS, 1.25);
  assert.strictEqual(r.leadInText, '1.25');
  assert.strictEqual(r.fixedDurationS, 9);
});

test('defaults apply with nothing stored; Auto duration and 0.5 s lead-in', function () {
  var r = VSState.create(memoryStorage()).get();
  assert.strictEqual(r.durationMode, 'auto');
  assert.strictEqual(r.leadInS, 0.5);
  assert.strictEqual(r.trackIndex, null);
});

test('corrupt or unavailable storage degrades to defaults without throwing', function () {
  var bad = { getItem: function () { return '{not json'; }, setItem: function () { throw new Error('quota'); } };
  var s = VSState.create(bad);
  assert.strictEqual(s.get().leadInS, 0.5);
  s.set({ mogrtPath: 'a.mogrt' });
  s.setMapping(1, 2);
  assert.strictEqual(VSState.create(null).get().mogrtPath, null);
});

test('lead-in accepts 0 to 3 inclusive and rejects the rest; invalid input is not remembered', function () {
  ['0', '0.5', '3', '2.75', '.5'].forEach(function (t) { assert.ok(VSState.parseLeadIn(t).ok, t); });
  ['', ' ', '-0.1', '3.01', 'abc', '1,5', '1e1', '0.5s'].forEach(function (t) {
    assert.ok(!VSState.parseLeadIn(t).ok, t);
  });
  var storage = memoryStorage();
  var s = VSState.create(storage);
  s.setLeadInText('2');
  s.setLeadInText('7');
  assert.strictEqual(s.get().leadInS, 2);
  assert.strictEqual(VSState.create(storage).get().leadInS, 2);
});

test('fixed duration must be greater than zero', function () {
  assert.ok(VSState.parseFixedDuration('8').ok);
  assert.ok(!VSState.parseFixedDuration('0').ok);
  assert.ok(!VSState.parseFixedDuration('').ok);
});

test('tracks are listed V-high to V-low with the topmost as the default', function () {
  assert.deepStrictEqual(VSState.trackOptions(3).map(function (o) { return o.label; }), ['V3', 'V2', 'V1']);
  assert.strictEqual(VSState.resolveTrack(null, 4), 3);
  assert.strictEqual(VSState.resolveTrack(1, 4), 1);
  assert.strictEqual(VSState.resolveTrack(5, 4), 3, 'a track that no longer exists falls back to the top');
  assert.strictEqual(VSState.resolveTrack(0, 0), null);
});

test('Analyse is enabled when every condition holds, with no reason', function () {
  var g = VSState.analyseGate(validState().get(), readyStrip());
  assert.deepStrictEqual(g, { enabled: true, reason: '' });
});

// Each row removes exactly one condition from a fully valid state. Every one must disable
// Analyse and say why (docs/09 §3).
var BREAKERS = [
  ['no media', function (s) { s.set({ mediaPath: null }); }, /media file/i],
  ['no template', function (s) { s.set({ mogrtPath: null }); }, /template/i],
  ['template busy', function (s) { s.set({ mogrtBusy: true }); }, /reading template/i],
  ['template unreadable', function (s) { s.set({ mogrtError: 'x' }); }, /could not be read/i],
  ['zero fields', function (s) { s.set({ mogrtFields: [] }); }, /no editable text fields/i],
  ['reference unmapped', function (s) { s.setMapping(null, 3); }, /reference field/i],
  ['body unmapped', function (s) { s.setMapping(11, null); }, /scripture text field/i],
  ['same field twice', function (s) { s.setMapping(3, 3); }, /different fields/i],
  ['translations loading', function (s) { s.set({ translations: null }); }, /loading translations/i],
  ['no translation', function (s) { s.set({ translationId: null }); }, /translation/i],
  ['no track', function (s) { s.set({ trackIndex: null }); }, /track/i],
  ['bad lead-in', function (s) { s.setLeadInText('9'); }, /lead-in/i],
  ['bad fixed duration', function (s) { s.set({ durationMode: 'fixed' }); s.setFixedText('0'); }, /fixed duration/i],
  ['job running', function (s) { s.set({ jobActive: true }); }, /already running/i]
];

BREAKERS.forEach(function (row) {
  test('Analyse is disabled with a reason: ' + row[0], function () {
    var s = validState();
    row[1](s);
    var g = VSState.analyseGate(s.get(), readyStrip());
    assert.strictEqual(g.enabled, false);
    assert.match(g.reason, row[2]);
  });
});

test('Analyse follows the sidecar and the sequence, always with a reason', function () {
  var s = validState().get();
  var cases = [
    [{ state: 'starting' }, true, /start/i],
    [{ state: 'unreachable', message: 'm' }, true, /unavailable/i],
    [{ state: 'version_mismatch' }, true, /restart/i],
    [{ state: 'ready', health: {} }, false, /sequence/i]
  ];
  cases.forEach(function (c) {
    var g = VSState.analyseGate(s, VSSidecar.computeStrip(c[0], c[1]));
    assert.strictEqual(g.enabled, false);
    assert.match(g.reason, c[2]);
  });
  var degraded = VSSidecar.computeStrip({ state: 'degraded', reasons: ['CPU only'] }, true);
  assert.strictEqual(VSState.analyseGate(s, degraded).enabled, true);
});

test('job request carries media, translation, lead-in and the duration mode', function () {
  var s = validState();
  s.setLeadInText('1');
  var auto = VSState.jobRequest(s.get());
  assert.strictEqual(auto.media_path, 'D:/Sermons/SERMON_A001.MXF');
  assert.strictEqual(auto.translation_id, 'kjv');
  assert.deepStrictEqual(auto.options.timing, { lead_in_s: 1, duration_mode: 'auto' });
  s.set({ durationMode: 'fixed' });
  s.setFixedText('6');
  assert.deepStrictEqual(VSState.jobRequest(s.get()).options.timing,
    { lead_in_s: 1, duration_mode: 'fixed', fixed_duration_s: 6 });
});

test('progress readout waits for 10% and prefers the sidecar ETA', function () {
  var early = VSState.progressView({ phase: 'hashing', progress: 0.05 }, 3, false);
  assert.strictEqual(early.time, '');
  assert.strictEqual(early.percent, 5);
  var mid = VSState.progressView({ phase: 'transcribing', progress: 0.62, eta_s: 64 }, 100, false);
  assert.strictEqual(mid.percent, 62);
  assert.strictEqual(mid.label, 'Transcribing\u2026');
  assert.match(mid.time, /elapsed 1:40/);
  assert.match(mid.time, /~1m04s left/);
  var guessed = VSState.progressView({ phase: 'transcribing', progress: 0.5 }, 30, false);
  assert.match(guessed.time, /~30s left/);
  assert.strictEqual(VSState.progressView({ phase: 'timing', progress: 1 }, 5, false).time, '');
});

test('a cache hit is announced in the phase label', function () {
  var v = VSState.progressView({ phase: 'detecting', progress: 0.4 }, 2, true);
  assert.match(v.label, /^Using cached transcript/);
});
