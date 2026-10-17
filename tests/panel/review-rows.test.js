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

// ── Rendering ───────────────────────────────────────────────────────────────

const { JSDOM } = require('jsdom');
const VSTimemap = require('../../panel/js/timemap.js');

const SEQ_INFO = { timebase: '10160640000', zeroPointTicks: '0', sequenceId: 'seq-1' };

function mount(name) {
  const model = loadModel(name);
  const doc = new JSDOM('<section id="review"></section>').window.document;
  const rootEl = doc.getElementById('review');
  const mapped = VSTimemap.mapCueDocument(model.toJSON(), {
    seqInfo: SEQ_INFO,
    manualOffsetTicks: '0'
  });
  model.applyPanelFlags(mapped.placements);
  VSReview.create({
    root: rootEl, model, getPlacements: () => mapped.placements, bridge: null
  });
  return { model, rootEl, placements: mapped.placements, doc };
}

test('all four fixtures render one row per cue', () => {
  const counts = { 'alternatives.json': 2, 'empty.json': 0, 'flagged.json': 12, 'happy-18-cues.json': 18 };
  Object.keys(counts).forEach((name) => {
    const m = mount(name);
    assert.equal(m.rootEl.querySelectorAll('.row').length, counts[name], name);
    assert.ok(m.rootEl.querySelector('.vf-review-header').textContent.indexOf(counts[name] + ' found') >= 0);
  });
});

test('rows are sorted by sequence timecode, cut cues last', () => {
  const m = mount('flagged.json');
  const order = Array.from(m.rootEl.querySelectorAll('.row')).map((r) => r.getAttribute('data-cue-id'));
  let lastTicks = -1;
  order.forEach((id) => {
    const t = Number(m.placements[id].atTicks);
    assert.ok(t >= lastTicks);
    lastTicks = t;
  });
});

test('cut cues sort to the end', () => {
  const model = loadModel('happy-18-cues.json');
  const doc = new JSDOM('<section id="review"></section>').window.document;
  const cues = model.cues();
  const placements = {};
  cues.forEach((c, i) => {
    placements[c.id] = { timecode: '00:00:00:00', atTicks: String(1000 - i), panelFlags: [] };
  });
  placements[cues[17].id] = { timecode: '', atTicks: '0', panelFlags: ['cut_from_edit'] };
  placements[cues[0].id] = { timecode: '', atTicks: '0', panelFlags: ['cut_from_edit'] };
  VSReview.create({ root: doc.getElementById('review'), model, getPlacements: () => placements });
  const ids = Array.from(doc.querySelectorAll('.row')).map((r) => r.getAttribute('data-cue-id'));
  assert.equal(ids[0], cues[16].id);
  assert.deepEqual(ids.slice(-2), [cues[0].id, cues[17].id]);
});

test('each of the 11 flags renders with its colour class and text label', () => {
  const doc = new JSDOM('<section id="review"></section>').window.document;
  const model = loadModel('happy-18-cues.json');
  const flags = Object.keys(VSReview.FLAGS);
  const placements = {};
  placements[model.cues()[0].id] = { timecode: '00:00:00:00', atTicks: '0', panelFlags: flags };
  VSReview.create({ root: doc.getElementById('review'), model, getPlacements: () => placements });
  const row = doc.querySelector('.row');
  flags.forEach((flag) => {
    const badge = row.querySelector('.vf-flag-' + flag);
    assert.ok(badge, flag);
    assert.ok(badge.className.indexOf('vf-flag--' + VSReview.FLAGS[flag].color) >= 0, flag);
    assert.ok(badge.textContent.indexOf(VSReview.FLAGS[flag].label) >= 0, flag);
  });
});

function toggle(m, row, checked) {
  const box = row.querySelector('.vf-row-check');
  box.checked = checked;
  box.dispatchEvent(new m.doc.defaultView.Event('change', { bubbles: true }));
}

test('a disabled row dims and the header counts follow the checkbox', () => {
  const m = mount('happy-18-cues.json');
  const first = m.rootEl.querySelector('.row');
  const id = first.getAttribute('data-cue-id');
  assert.equal(first.classList.contains('vf-row--disabled'), false);
  toggle(m, first, false);
  assert.equal(m.model.get(id).enabled, false);
  assert.equal(first.classList.contains('vf-row--disabled'), true);
  assert.ok(m.rootEl.querySelector('.vf-review-header').textContent.indexOf('17 enabled') >= 0);
});

test('toggling a checkbox does not replace other rows', () => {
  const m = mount('happy-18-cues.json');
  const before = Array.from(m.rootEl.querySelectorAll('.row'));
  toggle(m, before[3], false);
  const after = Array.from(m.rootEl.querySelectorAll('.row'));
  assert.equal(after.length, before.length);
  after.forEach((row, i) => assert.strictEqual(row, before[i]));
});
