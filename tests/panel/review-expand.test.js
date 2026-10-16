'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var JSDOM = require('jsdom').JSDOM;

var root = path.join(__dirname, '..', '..');
var panel = path.join(root, 'panel');
var Main = require(path.join(panel, 'js', 'main.js'));
var Cues = require(path.join(panel, 'js', 'cues.js'));
var Bridge = require(path.join(panel, 'js', 'bridge.js'));
var hostStub = require(path.join(panel, 'js', 'lib', 'host-stub.js'));
var html = fs.readFileSync(path.join(panel, 'index.html'), 'utf8');
var validate = require(path.join(root, 'tests', 'lib', 'validate-cue-document.js')).validate;

// 0.4 s per word, like the mock sidecar's synthetic transcript.
var WORDS = [];
for (var w = 0; w < 3000; w++) {
  WORDS.push({ text: 'word' + w, start: w * 0.4, end: w * 0.4 + 0.4, probability: 0.95 });
}

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'cue-documents', name), 'utf8'));
}

var MEDIA = 'C:\\media\\SERMON_A014.MXF';

function memoryStorage() {
  var m = {};
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    setItem: function (k, v) { m[k] = String(v); },
    removeItem: function (k) { delete m[k]; }
  };
}

function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

function waitFor(predicate) {
  return new Promise(function (resolve, reject) {
    var tries = 0;
    (function poll() {
      if (predicate()) { resolve(); return; }
      tries += 1;
      if (tries > 500) { reject(new Error('timed out waiting for the panel')); return; }
      setTimeout(poll, 2);
    })();
  });
}

function fakeClient(doc) {
  var c = { started: [], transcripts: [] };
  c.translations = function () {
    return Promise.resolve({ ok: true, data: { provider: 'fake', translations: [
      { id: 'kjv-id', abbreviation: 'KJV', name: 'King James Version',
        attribution: 'Public domain.', cache_allowed: true }] } });
  };
  c.startJob = function (req) {
    c.started.push(req);
    return Promise.resolve({ ok: true, data: { job_id: 'job_1', cache_hit: false } });
  };
  c.job = function (id) {
    return Promise.resolve({ ok: true, data: { job_id: id, status: 'done', progress: 1 } });
  };
  c.result = function (id) {
    var copy = JSON.parse(JSON.stringify(doc));
    copy.job.id = id;
    return Promise.resolve({ ok: true, data: copy });
  };
  c.transcript = function (id) {
    c.transcripts.push(id);
    return Promise.resolve({ ok: true, data: WORDS });
  };
  c.cancel = function () { return Promise.resolve({ ok: true, data: {} }); };
  return c;
}

// An in-memory cep.fs. Dialogs answer from the queues the test fills.
function fakeFs() {
  var f = { files: {}, saveAnswers: [], openAnswers: [], saveTitles: [] };
  f.showOpenDialog = function (multiple, directory, title, initial, extensions) {
    if (extensions.indexOf('mogrt') !== -1) { return { err: 0, data: ['C:\\t\\AV_Quote_04.mogrt'] }; }
    if (extensions.indexOf('json') !== -1) { return { err: 0, data: [f.openAnswers.shift()] }; }
    return { err: 0, data: [MEDIA] };
  };
  f.showSaveDialog = function (title) {
    f.saveTitles.push(title);
    return { err: 0, data: f.saveAnswers.shift() };
  };
  f.writeFile = function (p, data) { f.files[p] = data; return { err: 0 }; };
  f.readFile = function (p) {
    return Object.prototype.hasOwnProperty.call(f.files, p) ?
      { err: 0, data: f.files[p] } : { err: 3, data: '' };
  };
  return f;
}

async function build(o) {
  o = o || {};
  hostStub.__setScenario({ sequence: 'sequence-2997', segments: 'segments-single' });
  var dom = new JSDOM(html);
  var doc = dom.window.document;
  var source = fixture('happy-18-cues.json');
  if (o.mutate) { o.mutate(source); }
  var client = fakeClient(source);
  var cepFs = fakeFs();
  var inner = Bridge.create({ csInterface: null, hostStub: hostStub, jsxPath: null });
  var calls = [];
  var bridge = Object.create(inner);
  bridge.call = function (fn, args) {
    calls.push({ fn: fn, args: args });
    return inner.call(fn, args);
  };
  var app = Main.createApp({
    document: doc, bridge: bridge, client: client, transport: null, storage: memoryStorage(),
    fs: cepFs, sleep: function () { return tick(); }
  });
  var t = {
    doc: doc, app: app, client: client, calls: calls,
    $: function (id) { return doc.getElementById(id); },
    rows: function () { return doc.querySelectorAll('#review .row'); },
    row: function (id) { return doc.querySelector('#review .row[data-cue-id="' + id + '"]'); }
  };
  await app.ready;
  t.$('setup-media-btn').click();
  await app.setup.pickTemplate();
  t.$('setup-translation').value = 'kjv-id';
  t.$('setup-translation').dispatchEvent(new dom.window.Event('change'));
  t.$('setup-analyse').click();
  await waitFor(function () { return t.rows().length > 0; });
  return t;
}

function readFixtureWords(cue) {
  cue.detection.word_span = [905, 909];
  cue.read_start_s = 364.4;
  cue.read_end_s = 366.4;
}

test('clicking the timecode moves the playhead to the placement ticks', async function () {
  var t = await build();
  var placement = t.app.session.mapping.placements.cue_001;
  var tc = t.row('cue_001').querySelector('.vf-row-timecode');
  t.calls.length = 0;
  tc.click();
  assert.strictEqual(t.calls.length, 1);
  assert.strictEqual(t.calls[0].fn, 'setPlayhead');
  assert.deepStrictEqual(t.calls[0].args, { ticks: String(placement.atTicks) });
  assert.strictEqual(t.row('cue_001').querySelector('.vf-row-detail'), null, 'the click does not expand');
});

test('clicking the row body expands it, with read-only verse text and the classification line', async function () {
  var t = await build({ mutate: function (d) { readFixtureWords(d.cues[0]); } });
  var row = t.row('cue_001');
  row.querySelector('.vf-row-snippet').click();
  var detail = row.querySelector('.vf-row-detail');
  assert.ok(detail);
  assert.strictEqual(detail.querySelector('.vf-detail-body').textContent, t.app.session.model.get('cue_001').body);
  assert.strictEqual(detail.querySelector('textarea, input'), null);
  assert.strictEqual(detail.querySelector('.vf-detail-classification .vf-detail-value').textContent,
    'READ (coverage 0.91)');
  assert.strictEqual(detail.querySelector('.vf-detail-truncated'), null);
  row.querySelector('.vf-row-snippet').click();
  assert.strictEqual(row.querySelector('.vf-row-detail'), null, 'a second click collapses');
});

test('the truncation point is shown when long_passage is set', async function () {
  var t = await build({ mutate: function (d) { d.cues[1].flags = ['long_passage']; } });
  t.row('cue_002').querySelector('.vf-row-snippet').click();
  assert.ok(t.row('cue_002').querySelector('.vf-detail-truncated'));
});

test('the transcript is fetched once, even with three rows expanded', async function () {
  var t = await build();
  ['cue_001', 'cue_002', 'cue_003'].forEach(function (id) {
    t.row(id).querySelector('.vf-row-snippet').click();
  });
  await waitFor(function () {
    return t.doc.querySelectorAll('#review .vf-ctx-text').length === 3;
  });
  assert.strictEqual(t.client.transcripts.length, 1);
});

test('the read span is underlined and the matched span marked, about 15 words either side', async function () {
  var t = await build({ mutate: function (d) { readFixtureWords(d.cues[0]); } });
  var row = t.row('cue_001');
  row.querySelector('.vf-row-snippet').click();
  await waitFor(function () { return row.querySelector('.vf-ctx-text'); });
  var texts = function (sel) {
    return Array.prototype.map.call(row.querySelectorAll(sel), function (n) { return n.textContent; });
  };
  assert.deepStrictEqual(texts('.vf-ctx-match'),
    ['word905', 'word906', 'word907', 'word908', 'word909']);
  assert.deepStrictEqual(texts('.vf-ctx-read'),
    ['word911', 'word912', 'word913', 'word914', 'word915']);
  var all = texts('.vf-ctx-word');
  assert.strictEqual(all[0], 'word890');
  assert.strictEqual(all[all.length - 1], 'word924');
});

test('a missing transcript shows the not-available message', async function () {
  var t = await build();
  t.client.transcript = function () { return Promise.resolve({ ok: false, error: { message: 'gone' } }); };
  var row = t.row('cue_001');
  row.querySelector('.vf-row-snippet').click();
  await waitFor(function () { return row.querySelector('.vf-ctx-missing'); });
  assert.strictEqual(row.querySelector('.vf-ctx-missing').textContent,
    'Transcript not available for this document.');
});

test('a manual cue (no detection) shows no context and does not crash', async function () {
  var t = await build();
  var id = t.app.session.model.addManual({
    reference: { book: 'John', osis: 'John', chapter: 3, verse: 16 },
    reference_display: 'John 3:16 (KJV)', body: 'For God so loved the world.',
    body_word_count: 6, source_anchor_s: 100, source_duration_s: 5
  });
  t.app.session.review.render();
  var row = t.row(id);
  row.querySelector('.vf-row-snippet').click();
  assert.ok(row.querySelector('.vf-row-detail'));
  assert.strictEqual(row.querySelector('.vf-detail-context'), null);
  assert.strictEqual(t.client.transcripts.length, 0);
});
