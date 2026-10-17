'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var JSDOM = require('jsdom').JSDOM;

var root = path.join(__dirname, '..', '..');
var panel = path.join(root, 'panel');
var Review = require(path.join(panel, 'js', 'review.js'));
var Cues = require(path.join(panel, 'js', 'cues.js'));
var Timemap = require(path.join(panel, 'js', 'timemap.js'));
var validate = require(path.join(root, 'tests', 'lib', 'validate-cue-document.js')).validate;

var TIMEBASE = '8475667200'; // 29.97 fps, as the host reports it
var SEQ_INFO = { timebase: TIMEBASE, frameRate: 29.97, zeroPointTicks: '0' };
// The sequence shows source 0..2000 s at its start, so source seconds equal sequence seconds.
var SEGMENTS = {
  matched: true,
  segments: [{
    seqStartTicks: '0',
    seqEndTicks: String(Timemap.secondsToTicks(2000)),
    inPointTicks: '0'
  }],
  unsupported: []
};

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'cue-documents', name), 'utf8'));
}

function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

function build(name, o) {
  o = o || {};
  var dom = new JSDOM('<div id="host"></div>');
  var doc = dom.window.document;
  var model = Cues.load(JSON.stringify(fixture(name))).model;
  var state = { playhead: o.playhead || '0', mapping: null };
  function remap() {
    state.mapping = Timemap.mapCueDocument(model.toJSON(), { seqInfo: SEQ_INFO, segments: SEGMENTS });
  }
  remap();
  var review = Review.create({
    root: doc.getElementById('host'),
    model: model,
    getPlacements: function () { return state.mapping.placements; },
    timing: o.noTiming ? undefined : {
      nudgedSource: function (atTicks, frames) {
        return Timemap.toSource(Timemap.buildMap(SEGMENTS), Timemap.shiftFrames(atTicks, frames, TIMEBASE));
      },
      playheadSource: function () {
        return Promise.resolve(Timemap.toSource(Timemap.buildMap(SEGMENTS), state.playhead));
      }
    },
    onChange: function () { remap(); }
  });
  var t = {
    doc: doc, model: model, state: state, review: review,
    row: function (id) { return doc.querySelector('.row[data-cue-id="' + id + '"]'); },
    open: function (id) { t.row(id).querySelector('.vf-row-snippet').click(); return t.row(id); },
    at: function (id) { return Number(state.mapping.placements[id].atTicks); }
  };
  return t;
}

test('ten +1f presses move the timecode exactly ten frames and store source seconds', function () {
  var t = build('happy-18-cues.json');
  var id = 'cue_001';
  var start = t.at(id);
  var before = t.state.mapping.placements[id].timecode;
  t.open(id);
  for (var i = 0; i < 10; i++) {
    t.row(id).querySelector('.vf-detail-nudge-forward').click();
  }
  assert.strictEqual(t.at(id) - start, 10 * Number(TIMEBASE));
  assert.notStrictEqual(t.state.mapping.placements[id].timecode, before);
  assert.strictEqual(t.row(id).querySelector('.vf-detail-anchor-value').textContent,
    'anchor ' + t.state.mapping.placements[id].timecode + ' ');
  var cue = t.model.get(id);
  assert.strictEqual(cue.origin, 'edited');
  assert.ok(Math.abs(cue.source_anchor_s - (start + 10 * Number(TIMEBASE)) / Timemap.TICKS_PER_SECOND) < 1e-6);
  assert.deepStrictEqual(validate(t.model.toJSON()), []);
  assert.ok(t.row(id).querySelector('.vf-row-detail'), 'the row stays open');
});

test('-1f moves one frame earlier', function () {
  var t = build('happy-18-cues.json');
  var start = t.at('cue_001');
  t.open('cue_001').querySelector('.vf-detail-nudge-back').click();
  assert.strictEqual(start - t.at('cue_001'), Number(TIMEBASE));
});

test('a nudge that creates an overlap re-runs the sweep over the whole list', function () {
  var t = build('happy-18-cues.json');
  // cue_001 runs 149.5 s to about 157.8 s; park cue_002 just after that.
  t.model.edit('cue_002', { source_anchor_s: 157.9 });
  t.state.mapping = Timemap.mapCueDocument(t.model.toJSON(), { seqInfo: SEQ_INFO, segments: SEGMENTS });
  t.review.render();
  assert.strictEqual(t.row('cue_001').querySelector('.vf-flag-truncated'), null);
  var endBefore = Number(t.state.mapping.placements.cue_001.endTicks);
  t.open('cue_002');
  for (var i = 0; i < 5; i++) {
    t.row('cue_002').querySelector('.vf-detail-nudge-back').click();
  }
  assert.ok(t.row('cue_001').querySelector('.vf-flag-truncated'), 'the earlier cue is truncated');
  assert.ok(Number(t.state.mapping.placements.cue_001.endTicks) < endBefore);
});

test('set-to-playhead stores the playhead as the anchor', async function () {
  var t = build('happy-18-cues.json', { playhead: String(Timemap.secondsToTicks(600)) });
  t.open('cue_001').querySelector('.vf-detail-playhead').click();
  await tick();
  assert.ok(Math.abs(t.model.get('cue_001').source_anchor_s - 600) < 1e-6);
  assert.strictEqual(t.model.get('cue_001').origin, 'edited');
  assert.strictEqual(t.at('cue_001'), Number(Timemap.snapToFrame(Timemap.secondsToTicks(600), TIMEBASE)));
});

test('set-to-playhead outside the media gives the message and changes nothing', async function () {
  var t = build('happy-18-cues.json', { playhead: String(Timemap.secondsToTicks(5000)) });
  var before = JSON.stringify(t.model.get('cue_001'));
  var row = t.open('cue_001');
  row.querySelector('.vf-detail-playhead').click();
  await tick();
  var err = t.row('cue_001').querySelector('.vf-detail-timing-error');
  assert.strictEqual(err.hidden, false);
  assert.strictEqual(err.textContent, 'The playhead isn\'t over this media.');
  assert.strictEqual(JSON.stringify(t.model.get('cue_001')), before);
});

test('a duration override persists through save and load', function () {
  var t = build('happy-18-cues.json');
  var row = t.open('cue_001');
  var input = row.querySelector('.vf-detail-duration-input');
  input.value = '12.5';
  input.dispatchEvent(new t.doc.defaultView.Event('change'));
  assert.strictEqual(t.model.get('cue_001').source_duration_s, 12.5);
  assert.strictEqual(t.model.get('cue_001').origin, 'edited');
  var reloaded = Cues.load(JSON.stringify(t.model.toJSON()));
  assert.strictEqual(reloaded.ok, true);
  assert.strictEqual(reloaded.model.get('cue_001').source_duration_s, 12.5);
  assert.strictEqual(t.row('cue_001').querySelector('.vf-row-duration').textContent, '12.5s');
});

test('an invalid duration shows an error and changes nothing', function () {
  var t = build('happy-18-cues.json');
  var before = t.model.get('cue_001').source_duration_s;
  var row = t.open('cue_001');
  var input = row.querySelector('.vf-detail-duration-input');
  input.value = 'abc';
  input.dispatchEvent(new t.doc.defaultView.Event('change'));
  assert.strictEqual(t.model.get('cue_001').source_duration_s, before);
  assert.strictEqual(row.querySelector('.vf-detail-timing-error').hidden, false);
});

test('Delete removes the cue and its row', function () {
  var t = build('happy-18-cues.json');
  var count = t.model.cues().length;
  t.open('cue_001').querySelector('.vf-detail-delete').click();
  assert.strictEqual(t.model.cues().length, count - 1);
  assert.strictEqual(t.model.get('cue_001'), null);
  assert.strictEqual(t.row('cue_001'), null);
  assert.deepStrictEqual(validate(t.model.toJSON()), []);
});

test('without a sequence the anchor controls are disabled but the duration still edits', function () {
  var t = build('happy-18-cues.json', { noTiming: true });
  var row = t.open('cue_001');
  assert.strictEqual(row.querySelector('.vf-detail-nudge-back').disabled, true);
  assert.strictEqual(row.querySelector('.vf-detail-nudge-forward').disabled, true);
  assert.strictEqual(row.querySelector('.vf-detail-playhead').disabled, true);
  assert.strictEqual(row.querySelector('.vf-detail-duration-input').disabled, false);
});
