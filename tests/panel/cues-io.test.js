'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');

var VSCues = require('../../panel/js/cues.js');

var FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'cue-documents');
var FIXTURES = ['alternatives.json', 'empty.json', 'flagged.json', 'happy-18-cues.json'];

// Copied from reference/verseflow/js/scripture-parser.js (REFERENCE_RE).
var REFERENCE_RE = /^((?:\d+\s+)?[A-Za-z][A-Za-z ]*?\s+\d+:\d+(?:-\d+)?)\s*\(([A-Za-z0-9]+)\)\s*$/;

function loadModel(name) {
  var r = VSCues.load(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
  assert.equal(r.ok, true);
  return r.model;
}

function reload(model) {
  var r = VSCues.load(VSCues.serialize(model));
  assert.equal(r.ok, true);
  return r.model;
}

test('save, load, save is byte-identical for every fixture', function () {
  FIXTURES.forEach(function (name) {
    var first = VSCues.serialize(loadModel(name));
    var second = VSCues.serialize(reload(loadModel(name)));
    assert.equal(second, first, name);
  });
});

test('edits, disables and manual additions survive the round trip', function () {
  var model = loadModel('happy-18-cues.json');
  var ids = model.cues().map(function (c) { return c.id; });
  model.setEnabled(ids[0], false);
  model.edit(ids[1], { body: '1 Edited body text' });
  var manualId = model.addManual({
    reference: { book: 'John', osis: 'John', chapter: 3, verse: 16 },
    reference_display: 'John 3:16 (KJV)',
    body: '16 For God so loved the world',
    body_word_count: 7,
    source_anchor_s: 12.5,
    source_duration_s: 8
  });
  var text = VSCues.serialize(model);
  var back = reload(model);
  assert.equal(VSCues.serialize(back), text);
  assert.equal(back.get(ids[0]).enabled, false);
  assert.equal(back.get(ids[1]).body, '1 Edited body text');
  assert.equal(back.get(ids[1]).origin, 'edited');
  assert.equal(back.get(manualId).origin, 'manual');
});

test('every exported block parses with VerseFlow\'s reference regex', function () {
  var model = loadModel('happy-18-cues.json');
  var out = VSCues.exportVerseFlowTxt(model);
  var blocks = out.split('\n\n').filter(function (b) { return b.trim() !== ''; });
  assert.equal(blocks.length, model.enabledCount());
  blocks.forEach(function (block) {
    var lines = block.split('\n').filter(function (l) { return l !== ''; });
    assert.equal(lines.length, 2);
    assert.ok(REFERENCE_RE.test(lines[0]), lines[0]);
    assert.equal(REFERENCE_RE.test(lines[1]), false);
  });
});

test('export skips disabled cues and cues with an empty body, in anchor order', function () {
  var model = loadModel('happy-18-cues.json');
  var cues = model.cues();
  cues[0].body = '';
  model.setEnabled(cues[1].id, false);
  var out = VSCues.exportVerseFlowTxt(model);
  var blocks = out.split('\n\n').filter(function (b) { return b.trim() !== ''; });
  assert.equal(blocks.length, cues.length - 2);
  assert.equal(out.indexOf(cues[1].body.slice(0, 20)), -1);
  var anchors = [];
  cues.forEach(function (c) { if (c.enabled && c.body !== '') { anchors.push(c); } });
  anchors.sort(function (a, b) { return a.source_anchor_s - b.source_anchor_s; });
  assert.equal(blocks[0].split('\n')[0], anchors[0].reference_display);
});

test('an empty document exports an empty string', function () {
  assert.equal(VSCues.exportVerseFlowTxt(loadModel('empty.json')), '');
});
