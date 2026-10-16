'use strict';

var test = require('node:test');
var assert = require('node:assert');
var path = require('node:path');

var VSState = require(path.join(__dirname, '..', '..', 'panel', 'js', 'state.js'));
var fixture = require(path.join(__dirname, '..', 'fixtures', 'host', 'mogrt-fields.json'));

function fakeStorage() {
  var data = {};
  return {
    data: data,
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem: function (k, v) { data[k] = String(v); }
  };
}

function ready() {
  return {
    sidecarReady: true,
    sequenceOpen: true,
    mediaPath: 'C:\\media\\sermon.mp4',
    mogrtPath: 'C:\\t\\AV_Quote_04.mogrt',
    mogrtFields: fixture.fields,
    referenceIndex: 11,
    bodyIndex: 3,
    translation: 'kjv',
    targetTrack: 2
  };
}

test('smart defaults for AV_Quote_04 pick Description and Title Main', function () {
  var d = VSState.smartDefaults(fixture.fields);
  assert.deepStrictEqual(d, { referenceIndex: 11, bodyIndex: 3 });
});

test('smart defaults return null when nothing matches', function () {
  var d = VSState.smartDefaults([{ index: 0, name: 'Text', group: 'Layer', label: 'Layer > Text' }]);
  assert.deepStrictEqual(d, { referenceIndex: null, bodyIndex: null });
});

test('a fully configured state has no blockers', function () {
  assert.deepStrictEqual(VSState.analyseBlockers(ready()), []);
});

function only(patch, message) {
  var s = ready();
  Object.keys(patch).forEach(function (k) { s[k] = patch[k]; });
  assert.deepStrictEqual(VSState.analyseBlockers(s), [message]);
}

test('each blocker triggers on its own', function () {
  only({ sidecarReady: false }, "Transcription service isn't ready.");
  only({ sequenceOpen: false }, 'Open a sequence in Premiere first.');
  only({ mediaPath: null }, 'Select a media file.');
  only({ mogrtPath: null, mogrtFields: null, referenceIndex: null, bodyIndex: null }, 'Select a template.');
  only({ mogrtFields: [], referenceIndex: null, bodyIndex: null }, 'This template has no editable text fields.');
  only({ referenceIndex: null }, 'Map both template fields.');
  only({ bodyIndex: null }, 'Map both template fields.');
  only({ bodyIndex: 11 }, 'Reference and scripture must use different fields.');
  only({ translation: null }, 'Select a translation.');
  only({ targetTrack: null }, 'Select a target track.');
});

test('track index 0 is a valid selection', function () {
  only({ targetTrack: 0, translation: null }, 'Select a translation.');
});

test('blockers are ordered', function () {
  var all = VSState.analyseBlockers({});
  assert.deepStrictEqual(all, [
    "Transcription service isn't ready.",
    'Open a sequence in Premiere first.',
    'Select a media file.',
    'Select a template.',
    'Select a translation.',
    'Select a target track.'
  ]);
});

test('settings survive a new create() on the same storage', function () {
  var st = fakeStorage();
  var a = VSState.create({ storage: st });
  a.set({ mogrtPath: 'm.mogrt', translation: 'kjv', targetTrack: 1, leadInSec: 1.5, durationMode: 'fixed' });
  a.setFieldMapping('m.mogrt', { referenceIndex: 11, bodyIndex: 3 });
  var b = VSState.create({ storage: st });
  var s = b.get();
  assert.strictEqual(s.mogrtPath, 'm.mogrt');
  assert.strictEqual(s.translation, 'kjv');
  assert.strictEqual(s.targetTrack, 1);
  assert.strictEqual(s.leadInSec, 1.5);
  assert.strictEqual(s.durationMode, 'fixed');
  assert.deepStrictEqual(b.fieldMappingFor('m.mogrt'), { referenceIndex: 11, bodyIndex: 3 });
  assert.strictEqual(s.referenceIndex, 11);
  assert.strictEqual(s.bodyIndex, 3);
});

test('mediaPath is not persisted', function () {
  var st = fakeStorage();
  var a = VSState.create({ storage: st });
  a.set({ mediaPath: 'C:\\media\\sermon.mp4', translation: 'kjv' });
  assert.strictEqual(a.get().mediaPath, 'C:\\media\\sermon.mp4');
  assert.ok(Object.keys(st.data).length > 0);
  Object.keys(st.data).forEach(function (k) { assert.ok(st.data[k].indexOf('sermon.mp4') === -1); });
  assert.strictEqual(VSState.create({ storage: st }).get().mediaPath, null);
});

test('mappings are stored per MOGRT path as indices', function () {
  var st = fakeStorage();
  var a = VSState.create({ storage: st });
  a.setFieldMapping('one.mogrt', { referenceIndex: 4, bodyIndex: 5 });
  a.setFieldMapping('two.mogrt', { referenceIndex: 0, bodyIndex: 1 });
  var doc = JSON.parse(st.data['versesync.state']);
  assert.strictEqual(doc.version, 1);
  assert.deepStrictEqual(doc.mappings['one.mogrt'], { referenceIndex: 4, bodyIndex: 5 });
  assert.deepStrictEqual(doc.mappings['two.mogrt'], { referenceIndex: 0, bodyIndex: 1 });
  assert.strictEqual(a.fieldMappingFor('three.mogrt'), null);
});

test('set of a mapping index persists against the current template', function () {
  var st = fakeStorage();
  var a = VSState.create({ storage: st });
  a.set({ mogrtPath: 'm.mogrt' });
  a.set({ referenceIndex: 2, bodyIndex: 7 });
  assert.deepStrictEqual(VSState.create({ storage: st }).fieldMappingFor('m.mogrt'), { referenceIndex: 2, bodyIndex: 7 });
});

test('an unknown schema version or corrupt storage falls back to defaults', function () {
  var st = fakeStorage();
  st.setItem('versesync.state', JSON.stringify({ version: 99, settings: { translation: 'x' } }));
  assert.strictEqual(VSState.create({ storage: st }).get().translation, null);
  st.setItem('versesync.state', '{not json');
  assert.strictEqual(VSState.create({ storage: st }).get().translation, null);
});

test('a throwing storage does not break the state', function () {
  var bad = { getItem: function () { throw new Error('x'); }, setItem: function () { throw new Error('y'); } };
  var s = VSState.create({ storage: bad });
  s.set({ translation: 'kjv' });
  assert.strictEqual(s.get().translation, 'kjv');
});
