'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const VSCues = require('../../panel/js/cues.js');
const VSReview = require('../../panel/js/review.js');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'cue-documents');

function loadModel(name) {
  const r = VSCues.load(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
  assert.equal(r.ok, true);
  return r.model;
}

function baseCue(over) {
  return Object.assign({
    id: 'c1', enabled: true, reference: { book: '1 Corinthians', chapter: 6, verse: 19 },
    reference_display: '1 Corinthians 6:19-20 (KJV)', classification: 'read', confidence: 1,
    source_duration_s: 27.14,
    snippet: '…turn with me to First Corinthians six, nineteen and twenty. Or do you not know…',
    flags: []
  }, over || {});
}

test('rowViewModel: the docs/09 §5.1 example row', () => {
  const vm = VSReview.rowViewModel(baseCue(), { timecode: '00:23:45:11', panelFlags: [] }, 0.55);
  assert.equal(vm.timecode, '00:23:45:11');
  assert.equal(vm.reference, '1 Corinthians 6:19-20 (KJV)');
  assert.equal(vm.badge, 'READ');
  assert.deepEqual(vm.confidence, { text: '100%', amber: false });
  assert.equal(vm.duration, '27.1s');
  assert.equal(vm.snippet.match, 'First Corinthians six, nineteen and twenty');
  assert.equal(vm.snippet.before, '…turn with me to ');
  assert.equal(vm.snippet.after, '. Or do you not know…');
});

test('rowViewModel: paraphrase badge, amber below the threshold only', () => {
  const low = VSReview.rowViewModel(baseCue({ classification: 'paraphrase', confidence: 0.54 }), undefined, 0.55);
  assert.equal(low.badge, 'PARAPHRASE');
  assert.equal(low.confidence.amber, true);
  assert.equal(low.confidence.text, '54%');
  const edge = VSReview.rowViewModel(baseCue({ confidence: 0.55 }), undefined, 0.55);
  assert.equal(edge.confidence.amber, false);
});

test('rowViewModel: unplaced cue shows a blank timecode and an unmarked snippet when no match', () => {
  const vm = VSReview.rowViewModel(baseCue({ snippet: 'no mention words here' }),
    { timecode: '', panelFlags: ['cut_from_edit'] }, 0.55);
  assert.equal(vm.placed, false);
  assert.equal(vm.timecode, VSReview.NO_TIMECODE);
  assert.equal(vm.snippet.match, '');
  assert.equal(vm.snippet.before, 'no mention words here');
});

test('rowViewModel: document and panel flags merge without duplicates', () => {
  const vm = VSReview.rowViewModel(baseCue({ flags: ['overlap', 'truncated'] }),
    { timecode: '00:00:01:00', panelFlags: ['truncated', 'multiple_placements'] }, 0.55);
  assert.deepEqual(vm.flags.map((f) => f.flag), ['overlap', 'truncated', 'multiple_placements']);
});

test('rowViewModel: all 11 flags have the 09 §5.2 colour and a text label', () => {
  const expected = {
    low_confidence: 'amber', overlap: 'amber', truncated: 'grey', long_passage: 'amber',
    text_unavailable: 'red', passage_not_found: 'red', chapter_only: 'amber',
    suppressed_duplicate: 'grey', cut_from_edit: 'grey', multiple_placements: 'amber',
    speed_change_unsupported: 'red'
  };
  const vm = VSReview.rowViewModel(baseCue({ flags: Object.keys(expected) }), undefined, 0.55);
  assert.equal(vm.flags.length, 11);
  vm.flags.forEach((f) => {
    assert.equal(f.color, expected[f.flag], f.flag);
    assert.ok(f.label.length > 0, f.flag);
  });
});

test('fixtures: every cue yields a view model', () => {
  ['alternatives.json', 'empty.json', 'flagged.json', 'happy-18-cues.json'].forEach((name) => {
    loadModel(name).cues().forEach((cue) => {
      const vm = VSReview.rowViewModel(cue, undefined, 0.55);
      assert.equal(vm.id, cue.id);
    });
  });
});
