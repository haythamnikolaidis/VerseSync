'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');

var VSCues = require('../../panel/js/cues.js');
var validator = require('../lib/validate-cue-document.js');

var FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'cue-documents');
var FIXTURES = ['alternatives.json', 'empty.json', 'flagged.json', 'happy-18-cues.json'];

function text(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

function loadModel(name) {
  var r = VSCues.load(text(name));
  assert.equal(r.ok, true);
  return r.model;
}

function manualFields() {
  return {
    reference: { book: 'John', osis: 'John', chapter: 3, verse: 16 },
    reference_display: 'John 3:16 (KJV)',
    body: '16 For God so loved the world',
    body_word_count: 6,
    source_anchor_s: 120.5,
    source_duration_s: 10
  };
}

FIXTURES.forEach(function (name) {
  test('fixture ' + name + ' round-trips unedited and validates', function () {
    var model = loadModel(name);
    var out = model.toJSON();
    assert.deepEqual(validator.validate(out), []);
    assert.deepEqual(out, JSON.parse(text(name)));
  });
});

test('a 1.1 document loads with a warning', function () {
  var doc = JSON.parse(text('happy-18-cues.json'));
  doc.schema_version = '1.1';
  var r = VSCues.load(JSON.stringify(doc));
  assert.equal(r.ok, true);
  assert.equal(typeof r.warning, 'string');
  assert.ok(r.warning.length > 0);
});

test('a 1.0 document loads without a warning', function () {
  var r = VSCues.load(text('happy-18-cues.json'));
  assert.equal(r.ok, true);
  assert.equal(r.warning, undefined);
});

test('a 2.0 document is refused with the newer-version message', function () {
  var doc = JSON.parse(text('happy-18-cues.json'));
  doc.schema_version = '2.0';
  var r = VSCues.load(JSON.stringify(doc));
  assert.equal(r.ok, false);
  assert.equal(r.error,
    'This cue document was made by a newer VerseSync (version 2.0) and can\'t be opened.');
});

test('malformed JSON is refused, not thrown', function () {
  assert.equal(VSCues.load('{nope').ok, false);
});

test('enabledCount counts enabled cues and follows setEnabled', function () {
  var model = loadModel('happy-18-cues.json');
  var expected = model.cues().filter(function (c) { return c.enabled; }).length;
  assert.equal(model.enabledCount(), expected);
  var first = model.cues()[0];
  model.setEnabled(first.id, !first.enabled);
  assert.equal(model.enabledCount(), expected + (first.enabled ? 1 : -1));
  assert.deepEqual(validator.validate(model.toJSON()), []);
});

test('edit sets origin edited and keeps the document valid', function () {
  var model = loadModel('happy-18-cues.json');
  var id = model.cues()[0].id;
  assert.equal(model.get(id).origin, 'detected');
  model.edit(id, { source_anchor_s: 12.5 });
  assert.equal(model.get(id).origin, 'edited');
  assert.equal(model.get(id).source_anchor_s, 12.5);
  assert.deepEqual(validator.validate(model.toJSON()), []);
});

test('edit rejects an invalid patch and leaves the cue unchanged', function () {
  var model = loadModel('happy-18-cues.json');
  var id = model.cues()[0].id;
  var before = JSON.stringify(model.get(id));
  assert.throws(function () { model.edit(id, { source_duration_s: -1 }); });
  assert.throws(function () { model.edit(id, { confidence: 3 }); });
  assert.equal(JSON.stringify(model.get(id)), before);
});

test('edit keeps origin manual on a manual cue', function () {
  var model = loadModel('happy-18-cues.json');
  var id = model.addManual(manualFields());
  model.edit(id, { source_duration_s: 20 });
  assert.equal(model.get(id).origin, 'manual');
  assert.deepEqual(validator.validate(model.toJSON()), []);
});

test('manual cue has the specified shape and validates', function () {
  var model = loadModel('happy-18-cues.json');
  var before = model.cues().length;
  var id = model.addManual(manualFields());
  assert.match(id, /^cue_m\d{3}$/);
  assert.equal(id, 'cue_m001');
  assert.equal(model.cues().length, before + 1);
  var cue = model.get(id);
  assert.equal(cue.origin, 'manual');
  assert.equal(cue.confidence, 1.0);
  assert.equal(cue.classification, 'paraphrase');
  assert.equal(cue.mention_start_s, 120.5);
  assert.equal(cue.mention_end_s, 120.5);
  assert.equal(cue.snippet, '');
  assert.deepEqual(cue.flags, []);
  assert.deepEqual(cue.alternatives, []);
  assert.equal('detection' in cue, false);
  assert.deepEqual(validator.validate(model.toJSON()), []);
  assert.equal(model.addManual(manualFields()), 'cue_m002');
});

test('remove drops a cue and keeps the document valid', function () {
  var model = loadModel('happy-18-cues.json');
  var id = model.cues()[0].id;
  var before = model.cues().length;
  model.remove(id);
  assert.equal(model.cues().length, before - 1);
  assert.equal(model.get(id), null);
  assert.deepEqual(validator.validate(model.toJSON()), []);
});

test('applyPanelFlags disables a cue once and does not re-disable it', function () {
  var model = loadModel('happy-18-cues.json');
  var id = model.cues()[0].id;
  var other = model.cues()[1].id;
  model.setEnabled(id, true);
  model.applyPanelFlags(placementsWith(id, ['cut_from_edit']));
  assert.equal(model.get(id).enabled, false);
  assert.equal(model.get(other).enabled, true);

  model.setEnabled(id, true);
  model.applyPanelFlags(placementsWith(id, ['cut_from_edit']));
  assert.equal(model.get(id).enabled, true);
  assert.deepEqual(validator.validate(model.toJSON()), []);
});

test('applyPanelFlags ignores flags that do not disable', function () {
  var model = loadModel('happy-18-cues.json');
  var id = model.cues()[0].id;
  model.applyPanelFlags(placementsWith(id, ['multiple_placements']));
  assert.equal(model.get(id).enabled, true);
  model.applyPanelFlags(placementsWith(id, ['speed_change_unsupported']));
  assert.equal(model.get(id).enabled, false);
});

function placementsWith(id, flags) {
  var p = {};
  p[id] = { panelFlags: flags };
  return p;
}
