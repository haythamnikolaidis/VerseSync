'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var FakeCepFs = require(path.join(__dirname, 'helpers', 'fake-cep-fs.js'));
var JSDOM = require('jsdom').JSDOM;

var root = path.join(__dirname, '..', '..');
var panel = path.join(root, 'panel');
var Main = require(path.join(panel, 'js', 'main.js'));
var Cues = require(path.join(panel, 'js', 'cues.js'));
var Review = require(path.join(panel, 'js', 'review.js'));
var Insert = require(path.join(panel, 'js', 'insert.js'));
var Timemap = require(path.join(panel, 'js', 'timemap.js'));
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
  return FakeCepFs.create(MEDIA);
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
  assert.strictEqual(detail.querySelector('.vf-detail-verse textarea, .vf-detail-verse input'), null);
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

// ---- the text layout in the review rows (docs/09 §5, docs/15 §5) -------------------------------

var TIMEBASE = '8475667200'; // 29.97 fps, as the host reports it
var SEQ_INFO = { timebase: TIMEBASE, frameRate: 29.97, zeroPointTicks: '0' };
// The sequence shows source 0..2000 s at its start, so source seconds equal sequence seconds.
var SEGMENTS = {
  matched: true,
  segments: [{ seqStartTicks: '0', seqEndTicks: String(Timemap.secondsToTicks(2000)), inPointTicks: '0' }],
  unsupported: []
};

// The review list over the happy fixture with the layout settings in state.settings, changeable
// by a test as Setup changes them. cue_003 (Psalm 23:1-4, 356 characters) needs two graphics at
// 80 x 4, the others one.
function layoutReview(settings) {
  var dom = new JSDOM('<div id="host"></div>');
  var doc = dom.window.document;
  var model = Cues.load(JSON.stringify(fixture('happy-18-cues.json'))).model;
  var state = { settings: Object.assign({ autoWrap: true, maxCharsPerLine: 80, maxLinesPerGraphic: 4 }, settings),
    mapping: null };
  function remap() {
    state.mapping = Timemap.mapCueDocument(model.toJSON(), { seqInfo: SEQ_INFO, segments: SEGMENTS });
  }
  remap();
  var review = Review.create({
    root: doc.getElementById('host'),
    model: model,
    getPlacements: function () { return state.mapping.placements; },
    timecodeOf: function (ticks) { return Timemap.timecode(ticks, SEQ_INFO); },
    getGraphics: function (cue) {
      var placement = state.mapping.placements[cue.id];
      return Insert.graphicsFor(cue, placement && placement.timecode ? placement : null,
        state.settings, TIMEBASE);
    },
    timing: {
      nudgedSource: function (atTicks, frames) {
        return Timemap.toSource(Timemap.buildMap(SEGMENTS), Timemap.shiftFrames(atTicks, frames, TIMEBASE));
      },
      playheadSource: function () { return Promise.resolve(null); }
    },
    onChange: function () { remap(); }
  });
  var t = {
    doc: doc, model: model, state: state, review: review,
    row: function (id) { return doc.querySelector('.row[data-cue-id="' + id + '"]'); },
    open: function (id) { t.row(id).querySelector('.vf-row-snippet').click(); return t.row(id); },
    graphics: function (id) {
      return Insert.graphicsFor(model.get(id), state.mapping.placements[id], state.settings, TIMEBASE);
    },
    partTimes: function (id) {
      return Array.prototype.map.call(t.row(id).querySelectorAll('.vf-detail-part-time'), function (n) {
        return n.textContent;
      });
    }
  };
  return t;
}

function textOf(node) { return node ? node.textContent : null; }

test('a cue that will split shows Inserts as N graphics; one that fits has nothing extra', function () {
  var t = layoutReview();
  var split = t.row('cue_003');
  assert.strictEqual(textOf(split.querySelector('.vf-row-graphics')), 'Inserts as 2 graphics');
  assert.strictEqual(split.querySelector('.vf-flag-short-part'), null);
  // One cue, one row.
  assert.strictEqual(t.doc.querySelectorAll('.row[data-cue-id="cue_003"]').length, 1);
  assert.strictEqual(t.doc.querySelectorAll('.row').length, 18);
  assert.deepStrictEqual(Array.prototype.map.call(split.children, function (n) { return n.className; })
    .slice(0, 3), ['vf-row-main', 'vf-row-meta', 'vf-row-graphics']);

  var fits = t.row('cue_001');
  assert.strictEqual(fits.querySelector('.vf-row-graphics'), null);
  assert.deepStrictEqual(Array.prototype.map.call(fits.children, function (n) { return n.className; }),
    ['vf-row-main', 'vf-row-meta', 'vf-row-snippet']);
  t.open('cue_001');
  assert.strictEqual(fits.querySelector('.vf-detail-graphics'), null);
});

test('the expanded row shows the parts with their line breaks and start times', function () {
  var t = layoutReview();
  var row = t.open('cue_003');
  var graphics = t.graphics('cue_003');
  var parts = row.querySelectorAll('.vf-detail-part');
  assert.strictEqual(textOf(row.querySelector('.vf-detail-graphics .vf-detail-label')), 'Inserts as 2 graphics');
  assert.strictEqual(parts.length, 2);
  graphics.forEach(function (g, i) {
    var lines = Array.prototype.map.call(parts[i].querySelectorAll('.vf-detail-part-line'), textOf);
    assert.strictEqual(lines.join('\n'), g.body);
    assert.ok(lines.length >= 1 && lines.length <= 4);
    assert.strictEqual(textOf(parts[i].querySelector('.vf-detail-part-title')), 'Part ' + (i + 1));
    assert.strictEqual(textOf(parts[i].querySelector('.vf-detail-part-time')),
      ' · ' + Timemap.timecode(g.atTicks, SEQ_INFO));
  });
  // The first part starts where the row says the cue does, and the full text is still shown once.
  assert.strictEqual(textOf(parts[0].querySelector('.vf-detail-part-time')),
    ' · ' + t.state.mapping.placements.cue_003.timecode);
  assert.strictEqual(textOf(row.querySelector('.vf-detail-body')), t.model.get('cue_003').body);
  // The parts sit after the verse text and before the transcript context.
  var order = Array.prototype.map.call(row.querySelector('.vf-row-detail').children, function (n) {
    return n.className;
  });
  assert.ok(order.indexOf('vf-detail-graphics') === order.indexOf('vf-detail-verse') + 1);
});

test('a part under 2 s gets an amber warning on the row and on the part', function () {
  var t = layoutReview();
  // 3 s shared between the two parts leaves at least one of them under 2 s.
  t.model.edit('cue_003', { source_duration_s: 3 });
  t.state.mapping = Timemap.mapCueDocument(t.model.toJSON(), { seqInfo: SEQ_INFO, segments: SEGMENTS });
  t.review.render();
  var row = t.row('cue_003');
  var flag = row.querySelector('.vf-row-graphics .vf-flag-short-part');
  assert.ok(flag);
  assert.strictEqual(flag.textContent, '⚑ Part under 2 s');
  assert.ok(flag.classList.contains('vf-flag--amber'));
  t.open('cue_003');
  // Word share gives the long part about 2.4 s and the one-line part about 0.6 s: only that one warns.
  var short = t.graphics('cue_003').filter(function (g) {
    return BigInt(g.durationTicks) < BigInt(Timemap.secondsToTicks(2));
  }).length;
  assert.strictEqual(short, 1);
  assert.strictEqual(row.querySelectorAll('.vf-detail-part .vf-flag-short-part').length, short);
  // It still inserts: the graphics are all there, and nothing else is flagged.
  assert.strictEqual(t.graphics('cue_003').length, 2);
  assert.strictEqual(row.querySelector('.vf-row-flags').children.length, 0);

  var calm = layoutReview();
  assert.strictEqual(calm.row('cue_003').querySelector('.vf-flag-short-part'), null);
  calm.open('cue_003');
  assert.strictEqual(calm.row('cue_003').querySelector('.vf-flag-short-part'), null);
});

test('graphicsViewModel warns below min_visible_s and not at it, and times only placed cues', function () {
  var two = Timemap.secondsToTicks(2);
  function g(id, at, dur) { return { id: id, body: 'a\nb', atTicks: at, durationTicks: dur }; }
  var tc = function (ticks) { return 'tc:' + ticks; };

  assert.strictEqual(Review.graphicsViewModel([g('a', '0', '10')], tc), null);
  assert.strictEqual(Review.graphicsViewModel(null, tc), null);

  var vm = Review.graphicsViewModel([g('a', '100', String(two - 1)), g('b', '200', String(two)),
    g('c', '300', String(two + 1))], tc);
  assert.deepStrictEqual(vm.parts.map(function (p) { return p.short; }), [true, false, false]);
  assert.strictEqual(vm.anyShort, true);
  assert.strictEqual(vm.text, 'Inserts as 3 graphics');
  assert.strictEqual(vm.shortText, 'Part under 2 s');
  assert.deepStrictEqual(vm.parts.map(function (p) { return p.timecode; }), ['tc:100', 'tc:200', 'tc:300']);
  assert.deepStrictEqual(vm.parts[0].lines, ['a', 'b']);

  var unplaced = Review.graphicsViewModel([g('a', null, null), g('b', null, null)], tc);
  assert.deepStrictEqual(unplaced.parts.map(function (p) { return p.timecode; }), ['', '']);
  assert.strictEqual(unplaced.anyShort, false);
});

test('changing a layout setting redraws the rows in place and keeps an open row open', function () {
  var t = layoutReview();
  var row = t.open('cue_003');
  var before = t.model.get('cue_003').body;
  assert.strictEqual(row.querySelectorAll('.vf-detail-part').length, 2);

  // Narrower lines: the same cue needs more graphics, and cue_001 now needs two as well.
  t.state.settings.maxCharsPerLine = 30;
  t.review.refreshLayout();
  var count = t.graphics('cue_003').length;
  assert.ok(count > 2);
  assert.strictEqual(t.row('cue_003'), row, 'the row is not rebuilt');
  assert.ok(row.querySelector('.vf-row-detail'), 'the row stays open');
  assert.strictEqual(textOf(row.querySelector('.vf-row-graphics-count')), 'Inserts as ' + count + ' graphics');
  assert.strictEqual(row.querySelectorAll('.vf-detail-part').length, count);
  assert.strictEqual(row.querySelectorAll('.vf-detail-graphics').length, 1);
  assert.strictEqual(row.querySelectorAll('.vf-row-graphics').length, 1);
  assert.ok(t.row('cue_001').querySelector('.vf-row-graphics'));

  // Wider lines: it fits one graphic and the layout goes.
  t.state.settings.maxCharsPerLine = 120;
  t.review.refreshLayout();
  assert.strictEqual(row.querySelector('.vf-row-graphics'), null);
  assert.strictEqual(row.querySelector('.vf-detail-graphics'), null);
  assert.strictEqual(t.row('cue_001').querySelector('.vf-row-graphics'), null);

  // More lines allowed, or wrapping off: no split either way.
  t.state.settings.maxCharsPerLine = 30;
  t.state.settings.autoWrap = false;
  t.review.refreshLayout();
  assert.strictEqual(t.doc.querySelectorAll('.vf-row-graphics').length, 0);
  assert.strictEqual(t.doc.querySelectorAll('.vf-detail-graphics').length, 0);

  // None of it touched the Cue Document.
  assert.strictEqual(t.model.get('cue_003').body, before);
});

test('a split cue is enabled, edited and nudged as a whole, and its parts move with it', function () {
  var t = layoutReview();
  var row = t.open('cue_003');
  var before = t.graphics('cue_003');
  var timesBefore = t.partTimes('cue_003');
  assert.strictEqual(timesBefore.length, 2);

  row.querySelector('.vf-detail-nudge-forward').click();
  row = t.row('cue_003');
  assert.ok(row.querySelector('.vf-row-detail'), 'the row stays open');
  var after = t.graphics('cue_003');
  var frame = BigInt(TIMEBASE);
  assert.deepStrictEqual(after.map(function (g) { return BigInt(g.atTicks) - frame; }),
    before.map(function (g) { return BigInt(g.atTicks); }));
  assert.deepStrictEqual(after.map(function (g) { return g.durationTicks; }),
    before.map(function (g) { return g.durationTicks; }));
  assert.deepStrictEqual(t.partTimes('cue_003'), after.map(function (g) {
    return ' · ' + Timemap.timecode(g.atTicks, SEQ_INFO);
  }));
  assert.notDeepStrictEqual(t.partTimes('cue_003'), timesBefore);
  assert.strictEqual(t.model.get('cue_003').origin, 'edited');

  // One checkbox for the whole cue; the Insert count is cues, not graphics.
  var box = row.querySelector('.vf-row-check');
  box.checked = false;
  box.dispatchEvent(new t.doc.defaultView.Event('change', { bubbles: true }));
  assert.strictEqual(t.model.get('cue_003').enabled, false);
  assert.strictEqual(t.model.enabledCount(), 17);
  assert.strictEqual(t.doc.querySelectorAll('.row[data-cue-id="cue_003"]').length, 1);
  assert.strictEqual(textOf(t.row('cue_003').querySelector('.vf-row-graphics')), 'Inserts as 2 graphics');
  assert.strictEqual(t.doc.querySelector('.vf-review-insert').textContent, 'Insert 17 scriptures');
});

test('a cue the media does not reach lists its parts without times', function () {
  var t = layoutReview();
  // Cut from the edit: no timecode, so nothing to time the parts against.
  t.state.mapping.placements.cue_003.timecode = '';
  t.review.refreshLayout();
  var row = t.open('cue_003');
  assert.strictEqual(textOf(row.querySelector('.vf-row-graphics')), 'Inserts as 2 graphics');
  assert.strictEqual(row.querySelectorAll('.vf-detail-part').length, 2);
  assert.strictEqual(row.querySelectorAll('.vf-detail-part-time').length, 0);
  assert.strictEqual(row.querySelector('.vf-flag-short-part'), null);
});

test('the panel redraws the rows when a Setup layout control changes, without analysing again', async function () {
  var t = await build();
  var row = t.row('cue_003');
  assert.strictEqual(textOf(row.querySelector('.vf-row-graphics')), 'Inserts as 2 graphics');
  row.querySelector('.vf-row-snippet').click();
  assert.strictEqual(row.querySelectorAll('.vf-detail-part').length, 2);
  var change = function (id, value) {
    var control = t.$(id);
    if (typeof value === 'boolean') { control.checked = value; } else { control.value = value; }
    control.dispatchEvent(new t.doc.defaultView.Event('change', { bubbles: true }));
  };

  change('setup-maxchars', '120');
  assert.strictEqual(row.querySelector('.vf-row-graphics'), null);
  assert.strictEqual(row.querySelector('.vf-detail-graphics'), null);

  change('setup-maxchars', '30');
  var count = Number(/\d+/.exec(textOf(row.querySelector('.vf-row-graphics')))[0]);
  assert.ok(count > 2);
  assert.strictEqual(row.querySelectorAll('.vf-detail-part').length, count);
  assert.ok(row.querySelector('.vf-row-detail'));

  change('setup-maxchars', '60');
  change('setup-maxlines', '12');
  assert.strictEqual(row.querySelector('.vf-row-graphics'), null);

  change('setup-autowrap', false);
  assert.strictEqual(t.doc.querySelectorAll('#review .vf-row-graphics').length, 0);
  change('setup-autowrap', true);
  change('setup-maxlines', '1');
  assert.ok(t.doc.querySelectorAll('#review .vf-row-graphics').length > 2);

  assert.strictEqual(t.client.started.length, 1, 'no new analysis');
  assert.strictEqual(t.rows().length, 18);
});
