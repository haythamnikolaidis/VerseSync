'use strict';

// NFR-2 panel budgets, measured under jsdom in the container (not the reference workstation).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const VSCues = require('../../panel/js/cues.js');
const VSReview = require('../../panel/js/review.js');
const VSTimemap = require('../../panel/js/timemap.js');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'cue-documents', 'happy-18-cues.json');
const SEQ_INFO = { timebase: '10160640000', zeroPointTicks: '0', sequenceId: 'seq-1' };
const CUE_COUNT = 40;
const EXPANDED = 5;
const RENDER_BUDGET_MS = 300;
const TOGGLE_BUDGET_MS = 16; // one 60 Hz frame

const SOURCE_TIME_KEYS = ['source_anchor_s', 'mention_start_s', 'mention_end_s', 'read_start_s', 'read_end_s'];

// The fixture has 18 cues; repeat them with fresh ids and later source times to reach 40.
function bigDocument() {
  const doc = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const base = doc.cues.slice();
  const cues = [];
  for (let i = 0; i < CUE_COUNT; i++) {
    const src = JSON.parse(JSON.stringify(base[i % base.length]));
    const round = Math.floor(i / base.length);
    src.id = 'perf_' + i;
    SOURCE_TIME_KEYS.forEach((key) => {
      if (typeof src[key] === 'number') { src[key] += round * 4000; }
    });
    cues.push(src);
  }
  doc.cues = cues;
  return doc;
}

function mount() {
  const loaded = VSCues.load(JSON.stringify(bigDocument()));
  assert.equal(loaded.ok, true);
  const model = loaded.model;
  assert.equal(model.cues().length, CUE_COUNT);
  const win = new JSDOM('<section id="review"></section>').window;
  const mapped = VSTimemap.mapCueDocument(model.toJSON(), {
    seqInfo: SEQ_INFO,
    manualOffsetTicks: '0'
  });
  model.applyPanelFlags(mapped.placements);
  const rootEl = win.document.getElementById('review');
  VSReview.create({ root: rootEl, model, getPlacements: () => mapped.placements, bridge: null });
  return { win, rootEl };
}

function elapsedMs(fn) {
  const started = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

test('rendering 40 cues with 5 expanded stays under 300 ms', () => {
  mount(); // warm the JIT so the measurement is of steady state, as in a long-lived panel
  let rootEl;
  let win;
  const ms = elapsedMs(() => {
    ({ win, rootEl } = mount());
    const rows = rootEl.querySelectorAll('.row');
    for (let i = 0; i < EXPANDED; i++) {
      rows[i].dispatchEvent(new win.Event('click', { bubbles: true }));
    }
  });
  assert.equal(rootEl.querySelectorAll('.row').length, CUE_COUNT);
  assert.equal(rootEl.querySelectorAll('.vf-row-detail').length, EXPANDED);
  console.log('render 40 cues, 5 expanded: ' + ms.toFixed(1) + ' ms');
  assert.ok(ms < RENDER_BUDGET_MS, 'render took ' + ms.toFixed(1) + ' ms');
});

test('a checkbox toggle takes under 16 ms', () => {
  const { win, rootEl } = mount();
  const rows = rootEl.querySelectorAll('.row');
  for (let i = 0; i < EXPANDED; i++) {
    rows[i].dispatchEvent(new win.Event('click', { bubbles: true }));
  }
  const box = rows[CUE_COUNT - 1].querySelector('.vf-row-check');
  let worst = 0;
  [false, true, false].forEach((checked) => {
    const ms = elapsedMs(() => {
      box.checked = checked;
      box.dispatchEvent(new win.Event('change', { bubbles: true }));
    });
    worst = Math.max(worst, ms);
  });
  console.log('checkbox toggle (worst of 3): ' + worst.toFixed(2) + ' ms');
  assert.ok(worst < TOGGLE_BUDGET_MS, 'toggle took ' + worst.toFixed(2) + ' ms');
});
