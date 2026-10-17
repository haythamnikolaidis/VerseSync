'use strict';

// Journey B, the re-run (docs/00 §6, docs/05 §5.2, docs/11 §6 step 31): the editor recuts the
// sequence and clicks Analyse again. The real panel (createApp on jsdom) runs twice against a
// stub host and a fake sidecar client; between the runs the host's media segments switch to a
// recut fixture. The Cue Document holds source seconds only, so every anchor must be re-derived
// from the new segments and nothing from the first run may survive.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var JSDOM = require('jsdom').JSDOM;

var root = path.join(__dirname, '..', '..');
var panel = path.join(root, 'panel');
var Main = require(path.join(panel, 'js', 'main.js'));
var Bridge = require(path.join(panel, 'js', 'bridge.js'));
var Timemap = require(path.join(panel, 'js', 'timemap.js'));
var hostStub = require(path.join(panel, 'js', 'lib', 'host-stub.js'));
var html = fs.readFileSync(path.join(panel, 'index.html'), 'utf8');
var validate = require(path.join(root, 'tests', 'lib', 'validate-cue-document.js')).validate;

var MEDIA = 'C:\\media\\SERMON_A014.MXF';
var OUT = 'C:\\out\\sermon.json';
var TIMEBASE = '8475667200'; // sequence-2997

function fixtureAt(parts) {
  return JSON.parse(fs.readFileSync(path.join.apply(path, [root, 'tests', 'fixtures'].concat(parts)), 'utf8'));
}

var TRANSLATIONS = [
  { id: 'kjv-id', abbreviation: 'KJV', name: 'King James Version',
    attribution: 'Public domain.', cache_allowed: true }
];

function memoryStorage() {
  var m = {};
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    setItem: function (k, v) { m[k] = String(v); },
    removeItem: function (k) { delete m[k]; }
  };
}

// The first job transcribes; the second finds the transcript in the cache. Each reports its
// progress out of order on purpose, since the panel must only ever move the bar forward, and ends
// with a poll at 1.0 before it reports done.
var FRESH_POLLS = [0.2, 0.9, 0.7, 1];
var CACHED_POLLS = [0.85, 0.8, 1];

function fakeClient(doc) {
  var c = { started: [], polls: {} };
  c.translations = function () {
    return Promise.resolve({ ok: true, data: { provider: 'fake', translations: TRANSLATIONS } });
  };
  c.startJob = function (req) {
    c.started.push(req);
    var id = 'job_' + c.started.length;
    c.polls[id] = (c.started.length > 1 ? CACHED_POLLS : FRESH_POLLS).slice();
    return Promise.resolve({ ok: true, data: { job_id: id, cache_hit: c.started.length > 1 } });
  };
  c.job = function (id) {
    var next = c.polls[id].shift();
    if (next === undefined) {
      return Promise.resolve({ ok: true, data: { job_id: id, status: 'done', progress: 1 } });
    }
    return Promise.resolve({ ok: true, data: {
      job_id: id, status: 'running', phase: 'resolving', progress: next } });
  };
  c.result = function (id) {
    var copy = JSON.parse(JSON.stringify(doc));
    copy.job.id = id;
    return Promise.resolve({ ok: true, data: copy });
  };
  c.transcript = function () {
    return Promise.resolve({ ok: true, data: [{ text: 'hello', start: 0, end: 1, probability: 0.9 }] });
  };
  c.cancel = function () { return Promise.resolve({ ok: true, data: {} }); };
  return c;
}

function fakeFs() {
  var f = { files: {}, saveAnswers: [], openAnswers: [] };
  f.showOpenDialog = function (multiple, directory, title, initial, extensions) {
    if (extensions.indexOf('mogrt') !== -1) { return { err: 0, data: ['C:\\t\\AV_Quote_04.mogrt'] }; }
    if (extensions.indexOf('json') !== -1) { return { err: 0, data: [f.openAnswers.shift()] }; }
    return { err: 0, data: [MEDIA] };
  };
  f.showSaveDialog = function () { return { err: 0, data: f.saveAnswers.shift() }; };
  f.writeFile = function (p, data) { f.files[p] = data; return { err: 0 }; };
  f.readFile = function (p) {
    return Object.prototype.hasOwnProperty.call(f.files, p) ?
      { err: 0, data: f.files[p] } : { err: 3, data: '' };
  };
  return f;
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

// The stub host with one change: while `state.segments` holds a recut fixture, getMediaSegments
// answers with it instead of with the stub's own scenario. The stub's sequence check still runs
// first, so a stale sequenceId is refused as it would be in Premiere.
function recutHost(state) {
  var host = {};
  Object.keys(hostStub).forEach(function (k) {
    if (typeof hostStub[k] === 'function') { host[k] = hostStub[k]; }
  });
  host.getMediaSegments = function (argJson) {
    var raw = hostStub.getMediaSegments(argJson);
    if (!state.segments || !JSON.parse(raw).ok) { return raw; }
    return JSON.stringify({ ok: true, data: JSON.parse(JSON.stringify(state.segments)) });
  };
  return host;
}

// Records what the progress view shows: the bar after every update, and the cache notice as it
// appears. Replacing the methods on the view works because the panel calls them through it.
function watchProgress(t) {
  var bar = t.doc.querySelector('#progress .vf-progress-bar');
  var cache = t.doc.querySelector('#progress .vf-progress-cache');
  var log = { bars: [], events: [], cacheNotice: null };
  var update = t.app.progress.update;
  var cacheHit = t.app.progress.cacheHit;
  t.app.progress.update = function (ev) {
    update(ev);
    log.events.push(ev.progress);
    log.bars.push(Number(bar.getAttribute('aria-valuenow')));
  };
  t.app.progress.cacheHit = function () {
    cacheHit();
    log.cacheNotice = cache.hidden ? null : cache.textContent;
    log.bars.push(Number(bar.getAttribute('aria-valuenow')));
  };
  t.progressLog = function () { return log; };
  t.resetProgressLog = function () {
    log.bars = [];
    log.events = [];
    log.cacheNotice = null;
  };
}

async function build() {
  hostStub.__setScenario({ sequence: 'sequence-2997', segments: 'segments-single' });
  var state = { segments: null };
  var dom = new JSDOM(html);
  var doc = dom.window.document;
  var client = fakeClient(fixtureAt(['cue-documents', 'happy-18-cues.json']));
  var cepFs = fakeFs();
  var app = Main.createApp({
    document: doc,
    bridge: Bridge.create({ csInterface: null, hostStub: recutHost(state), jsxPath: null }),
    client: client,
    transport: null,
    storage: memoryStorage(),
    fs: cepFs,
    sleep: function () { return tick(); }
  });
  var t = {
    doc: doc, app: app, client: client, fs: cepFs,
    $: function (id) { return doc.getElementById(id); },
    q: function (sel) { return doc.querySelector('#review ' + sel); },
    rows: function () { return doc.querySelectorAll('#review .row'); },
    recut: function (name) { state.segments = fixtureAt(['host', name + '.json']); },
    menu: function (cls) {
      t.q('.vf-review-save').click();
      t.q('.' + cls).click();
    },
    placements: function () {
      var out = {};
      var mapping = app.session.mapping.placements;
      Object.keys(mapping).forEach(function (id) { out[id] = mapping[id]; });
      return out;
    },
    cue: function (id) {
      return app.session.model.cues().filter(function (c) { return c.id === id; })[0];
    }
  };
  watchProgress(t);
  await app.ready;
  t.$('setup-media-btn').click();
  await app.setup.pickTemplate();
  t.$('setup-translation').value = 'kjv-id';
  t.$('setup-translation').dispatchEvent(new dom.window.Event('change'));
  return t;
}

async function analyse(t, jobId) {
  t.$('setup-analyse').click();
  await waitFor(function () {
    return t.app.session && t.app.session.jobId === jobId && t.rows().length === 18;
  });
}

function ids(list) { return list.map(function (c) { return c.id; }); }

// The segment of a recut fixture that holds a source time, found with plain tick arithmetic and
// without the panel's own mapping code.
function segmentFor(segments, sourceSeconds) {
  var src = Math.round(sourceSeconds * 254016000000);
  return segments.segments.filter(function (s) {
    return Number(s.inPointTicks) <= src && src < Number(s.inPointTicks) + Number(s.durationTicks);
  })[0] || null;
}

function deltaTicks(segment) { return Number(segment.seqStartTicks) - Number(segment.inPointTicks); }

// 1 frame of sequence-2997, in ticks.
var FRAME = Number(TIMEBASE);

// Runs Analyse on the unedited sequence, saves the document, recuts, and runs Analyse again.
async function rerun(recutName) {
  var t = await build();
  await analyse(t, 'job_1');
  var first = t.placements();
  t.fs.saveAnswers.push(OUT);
  t.menu('vf-review-save-doc');
  await waitFor(function () { return t.fs.files[OUT] !== undefined; });
  t.resetProgressLog();

  t.recut(recutName);
  await analyse(t, 'job_2');
  return { t: t, first: first, second: t.placements() };
}

test('the second Analyse hits the transcript cache and says so, and progress ends at 1.0', async function () {
  var t = await build();
  await analyse(t, 'job_1');
  var fresh = t.progressLog();
  assert.strictEqual(t.client.started.length, 1);
  assert.strictEqual(fresh.cacheNotice, null);
  assert.strictEqual(fresh.events[fresh.events.length - 1], 1);
  assert.strictEqual(fresh.bars[fresh.bars.length - 1], 100);

  t.resetProgressLog();
  t.recut('recut-delete');
  var seenNotice = null;
  var cacheEl = t.doc.querySelector('#progress .vf-progress-cache');
  var cacheHit = t.app.progress.cacheHit;
  t.app.progress.cacheHit = function () {
    cacheHit();
    seenNotice = { text: cacheEl.textContent, hidden: cacheEl.hidden };
  };
  await analyse(t, 'job_2');
  var log = t.progressLog();
  assert.strictEqual(t.client.started.length, 2);
  assert.deepStrictEqual(t.client.started[1], t.client.started[0]);
  assert.deepStrictEqual(seenNotice, { text: 'Using cached transcript', hidden: false });
  assert.strictEqual(log.cacheNotice, 'Using cached transcript');
  // The cached run starts at the resolving phase, never goes backwards, and ends at exactly 1.0.
  assert.strictEqual(log.bars[0], 80);
  for (var i = 1; i < log.bars.length; i++) {
    assert.ok(log.bars[i] >= log.bars[i - 1], 'the bar moved backwards at update ' + i);
  }
  assert.strictEqual(log.events[log.events.length - 1], 1);
  assert.strictEqual(log.bars[log.bars.length - 1], 100);
  assert.strictEqual(t.$('progress').hidden, true);
});

test('recut-delete: cues in the removed section are cut and disabled, the rest shift by the delta', async function () {
  var r = await rerun('recut-delete');
  var t = r.t;
  var recut = fixtureAt(['host', 'recut-delete.json']);
  var cues = t.app.session.model.cues();
  assert.strictEqual(cues.length, 18);

  var cut = cues.filter(function (c) { return !segmentFor(recut, c.source_anchor_s); });
  assert.deepStrictEqual(ids(cut), ['cue_007', 'cue_008', 'cue_009', 'cue_010']);
  cut.forEach(function (c) {
    var p = r.second[c.id];
    assert.ok(p.panelFlags.indexOf('cut_from_edit') !== -1, c.id + ' is flagged cut_from_edit');
    assert.strictEqual(c.enabled, false, c.id + ' is disabled');
    assert.strictEqual(p.atTicks, '0');
    assert.strictEqual(p.timecode, '');
    // It had a position in the first run; none of it may be left over.
    assert.notStrictEqual(r.first[c.id].atTicks, '0');
  });
  // Their rows offer no timecode to jump to.
  var disabledTimecodes = t.doc.querySelectorAll('#review .vf-row-timecode:disabled');
  assert.strictEqual(disabledTimecodes.length, 4);

  var kept = cues.filter(function (c) { return segmentFor(recut, c.source_anchor_s); });
  assert.strictEqual(kept.length, 14);
  var shifted = 0;
  kept.forEach(function (c) {
    var delta = deltaTicks(segmentFor(recut, c.source_anchor_s));
    var p = r.second[c.id];
    assert.strictEqual(p.panelFlags.indexOf('cut_from_edit'), -1);
    assert.strictEqual(c.enabled, true, c.id + ' is still enabled');
    assert.strictEqual(p.atTicks, String(Number(r.first[c.id].atTicks) + delta), c.id + ' moved by the delta');
    if (delta !== 0) {
      shifted += 1;
      assert.notStrictEqual(p.atTicks, r.first[c.id].atTicks);
    }
  });
  // The 8 cues after the cut all move up by the same 18000 frames; the 6 before it stay put.
  assert.strictEqual(shifted, 8);
  assert.strictEqual(deltaTicks(recut.segments[1]), -18000 * FRAME);
});

test('recut-move: cues in swapped sections shift by exactly the move delta', async function () {
  var r = await rerun('recut-move');
  var t = r.t;
  var recut = fixtureAt(['host', 'recut-move.json']);
  var cues = t.app.session.model.cues();

  var byDelta = {};
  cues.forEach(function (c) {
    var seg = segmentFor(recut, c.source_anchor_s);
    assert.ok(seg, c.id + ' is still in the edit');
    var delta = deltaTicks(seg);
    var p = r.second[c.id];
    assert.strictEqual(p.atTicks, String(Number(r.first[c.id].atTicks) + delta), c.id + ' moved by the delta');
    assert.strictEqual(p.panelFlags.indexOf('cut_from_edit'), -1);
    assert.strictEqual(c.enabled, true);
    byDelta[delta / FRAME] = (byDelta[delta / FRAME] || []).concat(c.id);
  });
  // Section one stays, the middle section moves 31000 frames later and the last 27000 earlier.
  assert.deepStrictEqual(Object.keys(byDelta).sort(), ['-27000', '0', '31000']);
  assert.deepStrictEqual(byDelta['0'], ['cue_001', 'cue_002', 'cue_003', 'cue_004', 'cue_005', 'cue_006']);
  assert.deepStrictEqual(byDelta['31000'],
    ['cue_007', 'cue_008', 'cue_009', 'cue_010', 'cue_011', 'cue_012']);
  assert.deepStrictEqual(byDelta['-27000'],
    ['cue_013', 'cue_014', 'cue_015', 'cue_016', 'cue_017', 'cue_018']);
  // Every moved position is still on the frame grid.
  cues.forEach(function (c) {
    var p = r.second[c.id];
    assert.strictEqual(Timemap.snapToFrame(p.atTicks, TIMEBASE), p.atTicks);
  });
  assert.strictEqual(t.$('review').hidden, false);
  assert.strictEqual(t.rows().length, 18);
});

[['recut-delete', 4], ['recut-move', 0]].forEach(function (c) {
  test('a document saved before the ' + c[0] + ' re-maps the same way when loaded after it', async function () {
    var r = await rerun(c[0]);
    var t = r.t;
    var analysed = r.second;

    t.fs.openAnswers.push(OUT);
    t.menu('vf-review-load-doc');
    await waitFor(function () { return t.app.session.loadedFrom === OUT && t.rows().length === 18; });
    assert.strictEqual(t.app.session.jobId, null);
    var loaded = t.placements();
    Object.keys(analysed).forEach(function (id) {
      assert.strictEqual(loaded[id].atTicks, analysed[id].atTicks, id + ' lands where Analyse put it');
      assert.deepStrictEqual(loaded[id].panelFlags, analysed[id].panelFlags);
      assert.strictEqual(loaded[id].timecode, analysed[id].timecode);
    });
    var disabled = t.app.session.model.cues().filter(function (cue) { return !cue.enabled; });
    assert.strictEqual(disabled.length, c[1]);
  });
});

test('the saved Cue Document stores no ticks, so nothing in it can go stale', async function () {
  var r = await rerun('recut-move');
  var text = r.t.fs.files[OUT];
  var saved = JSON.parse(text);
  assert.deepStrictEqual(validate(saved), []);

  function keysOf(value, found) {
    if (Array.isArray(value)) { value.forEach(function (v) { keysOf(v, found); }); }
    else if (value && typeof value === 'object') {
      Object.keys(value).forEach(function (k) { found.push(k); keysOf(value[k], found); });
    }
    return found;
  }
  keysOf(saved, []).forEach(function (k) {
    assert.ok(!/tick/i.test(k), 'the document has a key named ' + k);
  });
  assert.ok(!/ticks/i.test(text));
  // Not a single sequence position from either run appears in the file.
  [r.first, r.second].forEach(function (placements) {
    Object.keys(placements).forEach(function (id) {
      var at = placements[id].atTicks;
      if (at !== '0') { assert.strictEqual(text.indexOf(at), -1, id + ' has a stored position ' + at); }
    });
  });
  saved.cues.forEach(function (cue) {
    assert.strictEqual(typeof cue.source_anchor_s, 'number');
  });
});

test('the panel never writes ticks into the document it holds after a recut', async function () {
  var r = await rerun('recut-delete');
  var json = JSON.stringify(r.t.app.session.model.toJSON());
  assert.ok(!/tick/i.test(json));
  assert.strictEqual(r.t.app.session.model.toJSON().cues.length, 18);
});
