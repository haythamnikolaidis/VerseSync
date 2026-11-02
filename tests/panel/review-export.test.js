'use strict';

// The review list for a job made from a scripture file (docs/09 §5, docs/14 §7, T-51.6 step 2),
// driven through the real panel against the mock sidecar's `export` scenario (Cue Document 1.1,
// tests/fixtures/cue-documents/export.json): its badges, the entry the audio never reached, and
// the Other mentions group. The last tests show a document with no scripture file gets none of it.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var JSDOM = require('jsdom').JSDOM;
var FakeCepFs = require(path.join(__dirname, 'helpers', 'fake-cep-fs.js'));

var root = path.join(__dirname, '..', '..');
var panel = path.join(root, 'panel');
var Main = require(path.join(panel, 'js', 'main.js'));
var Bridge = require(path.join(panel, 'js', 'bridge.js'));
var Cues = require(path.join(panel, 'js', 'cues.js'));
var Insert = require(path.join(panel, 'js', 'insert.js'));
var Review = require(path.join(panel, 'js', 'review.js'));
var Timemap = require(path.join(panel, 'js', 'timemap.js'));
var hostStub = require(path.join(panel, 'js', 'lib', 'host-stub.js'));
var validate = require(path.join(root, 'tests', 'lib', 'validate-cue-document.js')).validate;
var html = fs.readFileSync(path.join(panel, 'index.html'), 'utf8');

var MEDIA = 'C:\\media\\SERMON_A014.MXF';
var NOT_FOUND = 'Not found in audio \u2014 set the time';

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'cue-documents', name), 'utf8'));
}

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
  var c = {};
  c.translations = function () {
    return Promise.resolve({ ok: true, data: { provider: 'fake', translations: [
      { id: 'kjv-id', abbreviation: 'KJV', name: 'King James Version',
        attribution: 'Public domain.', cache_allowed: true }] } });
  };
  c.startJob = function () { return Promise.resolve({ ok: true, data: { job_id: 'job_1', cache_hit: false } }); };
  c.job = function (id) {
    return Promise.resolve({ ok: true, data: { job_id: id, status: 'done', progress: 1 } });
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

// The real panel on the stub host, the shared cep.fs fake and a fake client that answers with the
// given fixture. The bridge is wrapped so a test can read what Insert sent to the host.
async function build(o) {
  o = o || {};
  hostStub.__setScenario({ sequence: 'sequence-2997', segments: 'segments-single' });
  var dom = new JSDOM(html);
  var doc = dom.window.document;
  var source = fixture(o.fixture || 'export.json');
  if (o.mutate) { o.mutate(source); }
  var inner = Bridge.create({ csInterface: null, hostStub: hostStub, jsxPath: null });
  var calls = [];
  var bridge = {
    init: inner.init,
    call: function (name, args) {
      calls.push({ name: name, args: JSON.parse(JSON.stringify(args)) });
      return inner.call(name, args);
    }
  };
  var cepFs = FakeCepFs.create(MEDIA);
  var app = Main.createApp({
    document: doc,
    bridge: bridge,
    client: fakeClient(source),
    transport: null,
    storage: memoryStorage(),
    fs: cepFs,
    sleep: function () { return tick(); }
  });
  var t = {
    doc: doc, app: app, fs: cepFs, source: source, window: dom.window,
    $: function (id) { return doc.getElementById(id); },
    q: function (sel) { return doc.querySelector('#review ' + sel); },
    all: function (sel) { return doc.querySelectorAll('#review ' + sel); },
    rows: function () { return doc.querySelectorAll('#review .row'); },
    row: function (id) { return doc.querySelector('#review .row[data-cue-id="' + id + '"]'); },
    box: function (id) { return t.row(id).querySelector('.vf-row-check'); },
    cue: function (id) { return app.session.model.get(id); },
    placement: function (id) { return app.session.mapping.placements[id]; },
    title: function () { return doc.querySelector('#review .vf-review-title').textContent; },
    // Opens a row the way an editor does, by clicking its text.
    open: function (id) { t.row(id).querySelector('.vf-row-meta').click(); return t.row(id); },
    inserts: function () { return calls.filter(function (c) { return c.name === 'insertCues'; }); },
    insert: async function () {
      var before = t.inserts().length;
      t.q('.vf-review-insert').click();
      await waitFor(function () { return t.inserts().length === before + 1; });
      return t.inserts()[before].args.cues.map(function (c) { return c.id; });
    },
    menu: function (cls) {
      t.q('.vf-review-save').click();
      t.q('.' + cls).click();
    }
  };
  await app.ready;
  t.$('setup-media-btn').click();
  await app.setup.pickTemplate();
  t.$('setup-translation').value = 'kjv-id';
  t.$('setup-translation').dispatchEvent(new dom.window.Event('change'));
  t.$('setup-analyse').click();
  await waitFor(function () { return t.rows().length === source.cues.length; });
  return t;
}

function sourceSeconds(timecode, seqInfo) {
  // The same chain the panel uses for a typed time, written out independently.
  var parts = timecode.split(':').map(Number);
  var fps = Math.round(seqInfo.frameRate);
  var frames = ((parts[0] * 60 + parts[1]) * 60 + parts[2]) * fps + parts[3];
  return (frames * Number(seqInfo.timebase) - Number(seqInfo.zeroPointTicks)) / Timemap.TICKS_PER_SECOND;
}

// ---- badges --------------------------------------------------------------------------------

test('an export cue shows an EW badge with its translation; the provider cue does not', async function () {
  var t = await build();
  t.source.cues.forEach(function (cue) {
    var badge = t.row(cue.id).querySelector('.vf-badge--ew');
    if (cue.text_source.kind === 'export') {
      assert.ok(badge, cue.id);
      assert.strictEqual(badge.textContent, 'EW ' + cue.text_source.translation, cue.id);
    } else {
      assert.strictEqual(badge, null, cue.id);
    }
  });
  assert.strictEqual(t.all('.vf-badge--ew').length, 10);
  assert.strictEqual(t.row('cue_001').querySelector('.vf-badge--ew').textContent, 'EW KJV');
  assert.strictEqual(t.row('cue_003').querySelector('.vf-badge--ew').textContent, 'EW WEB');
});

test('Repeat marks repeat_read and repeat_mention, Out of order marks out_of_order', async function () {
  var t = await build();
  var ids = function (sel) {
    return Array.prototype.map.call(t.all(sel), function (b) { return b.closest('.row').getAttribute('data-cue-id'); });
  };
  assert.deepStrictEqual(ids('.vf-badge--repeat'), ['cue_008', 'cue_011']);
  assert.deepStrictEqual(ids('.vf-badge--out-of-order'), ['cue_006']);
  t.all('.vf-badge--repeat').forEach(function (b) { assert.strictEqual(b.textContent, 'Repeat'); });
  assert.strictEqual(t.row('cue_006').querySelector('.vf-badge--out-of-order').textContent, 'Out of order');
  assert.strictEqual(t.row('cue_011').querySelector('.vf-badge--repeat').title, 'Read again with no new slide');
  assert.strictEqual(t.row('cue_008').querySelector('.vf-badge--repeat').title, 'Named again with no new slide');
  // They are flags too, so they count in the flagged total and survive "Flagged only".
  assert.ok(t.row('cue_011').querySelector('.vf-flag-repeat_read'));
  assert.ok(t.row('cue_006').querySelector('.vf-flag-out_of_order'));
});

test('a repeat_read cue and an out_of_order cue stay enabled; a repeat_mention starts off', async function () {
  var t = await build();
  assert.strictEqual(t.cue('cue_011').enabled, true);
  assert.strictEqual(t.cue('cue_006').enabled, true);
  assert.strictEqual(t.cue('cue_008').enabled, false);
});

test('rowViewModel carries the badges, the unset flag and the group flag', function () {
  var cues = fixture('export.json').cues;
  var byId = {};
  cues.forEach(function (c) { byId[c.id] = Review.rowViewModel(c, undefined, 0.55); });
  assert.deepStrictEqual(byId.cue_001.badges.map(function (b) { return b.text; }), ['EW KJV']);
  assert.deepStrictEqual(byId.cue_011.badges.map(function (b) { return b.key; }), ['ew', 'repeat']);
  assert.deepStrictEqual(byId.cue_006.badges.map(function (b) { return b.key; }), ['ew', 'out-of-order']);
  assert.strictEqual(byId.cue_002.needsTime, true);
  assert.strictEqual(byId.cue_001.needsTime, false);
  assert.strictEqual(byId.cue_005.other, true);
  assert.strictEqual(byId.cue_001.other, false);
  assert.deepStrictEqual(byId.cue_005.badges, []);
});

// ---- the entry the audio never reached ------------------------------------------------------

test('an unplaced row reads Not found in audio, set the time, and its checkbox is off with that reason', async function () {
  var t = await build();
  var row = t.row('cue_002');
  assert.strictEqual(row.querySelector('.vf-row-prompt').textContent, NOT_FOUND);
  assert.strictEqual(t.box('cue_002').disabled, true);
  assert.strictEqual(t.box('cue_002').title, NOT_FOUND);
  assert.strictEqual(t.box('cue_002').checked, false);
  assert.ok(row.querySelector('.vf-flag-not_found_in_audio'));
  // No other row carries the prompt, and no other checkbox is off.
  assert.strictEqual(t.all('.vf-row-prompt').length, 1);
  assert.strictEqual(t.all('.vf-row-check:disabled').length, 1);
});

test('opening an unplaced row focuses its time field', async function () {
  var t = await build();
  var row = t.open('cue_002');
  var field = row.querySelector('.vf-detail-time-input');
  assert.ok(field);
  assert.strictEqual(t.doc.activeElement, field);
  assert.strictEqual(field.getAttribute('placeholder'), 'HH:MM:SS:FF');
  // A placed row opens without one.
  assert.strictEqual(t.open('cue_001').querySelector('.vf-detail-time-input'), null);
  // The guess is labelled, and nudging a guess is off until a time is set.
  assert.ok(row.querySelector('.vf-detail-anchor-value').textContent.indexOf('(a guess)') !== -1);
  assert.strictEqual(row.querySelector('.vf-detail-nudge-forward').disabled, true);
  assert.strictEqual(row.querySelector('.vf-detail-playhead').disabled, false);
});

test('an unplaced cue cannot be ticked', async function () {
  var t = await build();
  t.box('cue_002').click();
  assert.strictEqual(t.cue('cue_002').enabled, false);
  // Not even a change event that gets past a disabled box.
  t.box('cue_002').checked = true;
  t.box('cue_002').dispatchEvent(new t.window.Event('change', { bubbles: true }));
  assert.strictEqual(t.cue('cue_002').enabled, false);
  assert.strictEqual(t.box('cue_002').checked, false);
  assert.strictEqual(t.app.session.model.enabledCount(), 8);
});

test('select all skips an unplaced cue, and it is not in the insert payload', async function () {
  var t = await build();
  t.q('.vf-review-all').click();
  assert.strictEqual(t.cue('cue_002').enabled, false);
  assert.strictEqual(t.app.session.model.enabledCount(), 10);
  assert.ok(t.title().indexOf('10 enabled') !== -1);
  var sent = await t.insert();
  assert.strictEqual(sent.length, 10);
  assert.strictEqual(sent.indexOf('cue_002'), -1);
});

test('typing a time sets it: the flag goes, the cue is enabled and it is inserted', async function () {
  var t = await build();
  var row = t.open('cue_002');
  var field = row.querySelector('.vf-detail-time-input');
  field.value = '01:20:00:00';
  row.querySelector('.vf-detail-time-set').click();

  var cue = t.cue('cue_002');
  assert.deepStrictEqual(cue.flags, []);
  assert.strictEqual(cue.enabled, true);
  assert.strictEqual(cue.origin, 'edited');
  assert.ok(Math.abs(cue.source_anchor_s - sourceSeconds('01:20:00:00', t.app.session.seqInfo)) < 1e-6);
  assert.strictEqual(t.placement('cue_002').timecode, '01:20:00:00');
  assert.deepStrictEqual(validate(t.app.session.model.toJSON()), []);

  // The row is redrawn as an ordinary one, still open.
  var fresh = t.row('cue_002');
  assert.strictEqual(fresh.querySelector('.vf-row-prompt'), null);
  assert.strictEqual(fresh.querySelector('.vf-flag-not_found_in_audio'), null);
  assert.strictEqual(t.box('cue_002').disabled, false);
  assert.strictEqual(t.box('cue_002').checked, true);
  assert.strictEqual(t.box('cue_002').hasAttribute('title'), false);
  assert.ok(fresh.querySelector('.vf-row-detail'));
  assert.ok(t.title().indexOf('9 enabled') !== -1);

  var sent = await t.insert();
  assert.strictEqual(sent.length, 9);
  var payload = t.inserts()[0].args.cues.filter(function (c) { return c.id === 'cue_002'; })[0];
  assert.strictEqual(payload.atTicks, t.placement('cue_002').atTicks);
});

test('Enter in the time field sets the time too', async function () {
  var t = await build();
  var field = t.open('cue_002').querySelector('.vf-detail-time-input');
  field.value = '01:20:00:00';
  field.dispatchEvent(new t.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.strictEqual(t.cue('cue_002').enabled, true);
});

test('taking the playhead sets the time as well', async function () {
  var t = await build();
  t.open('cue_002').querySelector('.vf-detail-playhead').click();
  await waitFor(function () { return t.cue('cue_002').flags.length === 0; });
  var cue = t.cue('cue_002');
  assert.strictEqual(cue.enabled, true);
  // The stub sequence parks its playhead 1800 s in, over the start of the media.
  assert.ok(Math.abs(cue.source_anchor_s - 1800) < 1e-6);
  assert.strictEqual(t.box('cue_002').disabled, false);
  var sent = await t.insert();
  assert.ok(sent.indexOf('cue_002') !== -1);
});

test('a time that is not a timecode, or is off the media, changes nothing', async function () {
  var t = await build();
  var before = JSON.stringify(t.cue('cue_002'));
  var row = t.open('cue_002');
  var error = row.querySelector('.vf-detail-timing-error');
  [['soon', 'Enter a timecode as HH:MM:SS:FF.'], ['03:00:00:00', 'That timecode is outside the media.']]
    .forEach(function (pair) {
      row.querySelector('.vf-detail-time-input').value = pair[0];
      row.querySelector('.vf-detail-time-set').click();
    });
  await waitFor(function () { return !error.hidden && error.textContent === 'That timecode is outside the media.'; });
  assert.strictEqual(JSON.stringify(t.cue('cue_002')), before);
  assert.ok(t.row('cue_002').querySelector('.vf-row-prompt'));
  assert.strictEqual(t.box('cue_002').disabled, true);
});

test('a saved document keeps the flag and enabled state, before and after the time is set', async function () {
  var t = await build();
  t.fs.saveAnswers.push('C:\\out\\before.json');
  t.menu('vf-review-save-doc');
  await waitFor(function () { return t.fs.files['C:\\out\\before.json']; });
  var before = JSON.parse(t.fs.files['C:\\out\\before.json']).cues.filter(function (c) { return c.id === 'cue_002'; })[0];
  assert.deepStrictEqual(before.flags, ['not_found_in_audio']);
  assert.strictEqual(before.enabled, false);

  var row = t.open('cue_002');
  row.querySelector('.vf-detail-time-input').value = '01:20:00:00';
  row.querySelector('.vf-detail-time-set').click();
  t.fs.saveAnswers.push('C:\\out\\after.json');
  t.menu('vf-review-save-doc');
  await waitFor(function () { return t.fs.files['C:\\out\\after.json']; });
  var saved = JSON.parse(t.fs.files['C:\\out\\after.json']);
  var after = saved.cues.filter(function (c) { return c.id === 'cue_002'; })[0];
  assert.deepStrictEqual(after.flags, []);
  assert.strictEqual(after.enabled, true);
  assert.strictEqual(after.origin, 'edited');
  assert.deepStrictEqual(validate(saved), []);

  // Loading it back shows an ordinary, enabled row.
  t.fs.openAnswers.push('C:\\out\\after.json');
  t.menu('vf-review-load-doc');
  await waitFor(function () { return t.app.session.loadedFrom === 'C:\\out\\after.json' && t.rows().length === 11; });
  assert.strictEqual(t.row('cue_002').querySelector('.vf-row-prompt'), null);
  assert.strictEqual(t.box('cue_002').checked, true);
  assert.strictEqual(t.box('cue_002').disabled, false);
});

test('the insert check refuses a not_found_in_audio cue that was enabled some other way', function () {
  var model = Cues.load(JSON.stringify(fixture('export.json'))).model;
  model.setEnabled('cue_002', true);
  var seqInfo = JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'host', 'sequence-2997.json'), 'utf8'));
  var segments = JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'host', 'segments-single.json'), 'utf8'));
  var mapped = Timemap.mapCueDocument(model.toJSON(), { seqInfo: seqInfo, segments: segments });
  var stop = Insert.blockers({
    settings: {
      sidecarReady: true, sequenceOpen: true, mediaPath: MEDIA, mogrtPath: 'D:/Templates/AV_Quote_04.mogrt',
      mogrtFields: [{ index: 3, name: 'Text', group: 'Caption' }, { index: 11, name: 'Text', group: 'Title' }],
      translation: 'KJV', targetTrack: 2, referenceIndex: 3, bodyIndex: 11
    },
    sequenceId: seqInfo.sequenceId,
    model: model,
    placements: mapped.placements
  });
  assert.deepStrictEqual(stop, ['Resolve the flagged cues before inserting: cue_002']);
});

// ---- order -----------------------------------------------------------------------------------

test('the rows stay in timecode order, the unplaced and out-of-order ones where their times put them', async function () {
  var t = await build();
  var main = Array.prototype.map.call(t.doc.querySelectorAll('#review .vf-review-list > .row'),
    function (r) { return r.getAttribute('data-cue-id'); });
  assert.deepStrictEqual(main, ['cue_001', 'cue_002', 'cue_003', 'cue_004', 'cue_006', 'cue_007',
    'cue_008', 'cue_009', 'cue_010', 'cue_011']);
  var ticks = main.map(function (id) { return Number(t.placement(id).atTicks); });
  ticks.forEach(function (n, i) { if (i > 0) { assert.ok(n >= ticks[i - 1], main[i]); } });
});

// ---- Other mentions --------------------------------------------------------------------------

test('not_in_export cues are grouped under Other mentions (N), collapsed', async function () {
  var t = await build();
  var group = t.q('.vf-review-group');
  assert.ok(group);
  var toggle = group.querySelector('.vf-review-group-toggle');
  var body = group.querySelector('.vf-review-group-list');
  assert.strictEqual(toggle.textContent, 'Other mentions (1)');
  assert.strictEqual(toggle.getAttribute('aria-expanded'), 'false');
  assert.strictEqual(body.hidden, true);
  assert.deepStrictEqual(Array.prototype.map.call(body.querySelectorAll('.row'),
    function (r) { return r.getAttribute('data-cue-id'); }), ['cue_005']);
  assert.strictEqual(t.q('.vf-review-list > .row[data-cue-id="cue_005"]'), null);
  // The header still counts every cue.
  assert.ok(t.title().indexOf('11 found') !== -1);
  toggle.click();
  assert.strictEqual(body.hidden, false);
  assert.strictEqual(toggle.getAttribute('aria-expanded'), 'true');
  toggle.click();
  assert.strictEqual(body.hidden, true);
});

test('ticking an other mention enables it as a normal cue and it is inserted', async function () {
  var t = await build();
  t.q('.vf-review-group-toggle').click();
  assert.strictEqual(t.cue('cue_005').enabled, false);
  t.box('cue_005').click();
  assert.strictEqual(t.cue('cue_005').enabled, true);
  assert.ok(t.title().indexOf('9 enabled') !== -1);
  assert.strictEqual(t.q('.vf-review-insert').textContent, 'Insert 9 scriptures');
  // The group stays where it was, open, and the cue keeps its flag.
  assert.strictEqual(t.q('.vf-review-group-list').hidden, false);
  assert.deepStrictEqual(t.cue('cue_005').flags, ['not_in_export']);
  var sent = await t.insert();
  assert.ok(sent.indexOf('cue_005') !== -1);
  assert.strictEqual(sent.length, 9);
});

test('the group count follows the cues: three, and none at all', async function () {
  var three = await build({ mutate: function (doc) {
    ['cue_003', 'cue_004'].forEach(function (id) {
      var cue = doc.cues.filter(function (c) { return c.id === id; })[0];
      cue.flags = ['not_in_export'];
      cue.enabled = false;
      cue.text_source = { kind: 'provider', translation: 'KJV' };
    });
    assert.deepStrictEqual(validate(doc), []);
  } });
  assert.strictEqual(three.q('.vf-review-group-toggle').textContent, 'Other mentions (3)');
  assert.strictEqual(three.all('.vf-review-group-list .row').length, 3);
  assert.strictEqual(three.all('.vf-review-list > .row').length, 8);
  assert.ok(three.title().indexOf('11 found') !== -1);

  var none = await build({ mutate: function (doc) {
    doc.cues = doc.cues.filter(function (c) { return c.id !== 'cue_005'; });
  } });
  assert.strictEqual(none.q('.vf-review-group'), null);
  assert.strictEqual(none.q('.vf-review-group-toggle'), null);
  assert.strictEqual(none.q('.vf-review-list').textContent.indexOf('Other mentions'), -1);
  assert.strictEqual(none.rows().length, 10);
});

test('Flagged only leaves the group, and deleting its last cue removes it', async function () {
  var t = await build();
  t.q('.vf-review-flagged').click();
  assert.strictEqual(t.row('cue_001').hidden, true);
  assert.strictEqual(t.row('cue_005').hidden, false);
  assert.ok(t.q('.vf-review-group'));
  t.q('.vf-review-flagged').click();

  t.q('.vf-review-group-toggle').click();
  t.open('cue_005').querySelector('.vf-detail-delete').click();
  assert.strictEqual(t.q('.vf-review-group'), null);
  assert.ok(t.title().indexOf('10 found') !== -1);
});

test('the group stays open across a redraw', async function () {
  var t = await build();
  t.q('.vf-review-group-toggle').click();
  t.open('cue_005').querySelector('.vf-detail-nudge-forward').click();
  assert.strictEqual(t.q('.vf-review-group-list').hidden, false);
  assert.ok(t.row('cue_005').querySelector('.vf-row-detail'));
});

// ---- nothing changes without a scripture file ------------------------------------------------

test('a document with no scripture file gets no badge, prompt, group, time field or disabled box', async function () {
  ['happy-18-cues.json', 'flagged.json', 'alternatives.json'].forEach(function (name) {
    var model = Cues.load(JSON.stringify(fixture(name))).model;
    var doc = new JSDOM('<section id="review"></section>').window.document;
    var mapped = Timemap.mapCueDocument(model.toJSON(), {
      seqInfo: { timebase: '10160640000', zeroPointTicks: '0', sequenceId: 'seq-1' }, manualOffsetTicks: '0'
    });
    var view = Review.create({
      root: doc.getElementById('review'), model: model, getPlacements: function () { return mapped.placements; },
      bridge: null
    });
    var rows = doc.querySelectorAll('.row');
    assert.ok(rows.length > 0, name);
    assert.strictEqual(doc.querySelectorAll('.vf-badge, .vf-row-prompt, .vf-review-group, .vf-row-badges').length, 0, name);
    assert.strictEqual(doc.querySelectorAll('.vf-row-check:disabled').length, 0, name);
    assert.strictEqual(doc.querySelectorAll('.vf-row-check[title]').length, 0, name);
    assert.strictEqual(doc.querySelectorAll('.vf-row--needs-time').length, 0, name);
    rows[0].querySelector('.vf-row-meta').click();
    assert.strictEqual(doc.querySelectorAll('.vf-detail-time, .vf-detail-time-input').length, 0, name);
    // "All" still ticks every cue.
    doc.querySelector('.vf-review-all').click();
    assert.strictEqual(model.enabledCount(), model.cues().length, name);
    assert.ok(view);
  });
});

test('Analyse on a v1 document shows the same 18 rows with none of the scripture-file elements', async function () {
  var t = await build({ fixture: 'happy-18-cues.json' });
  assert.strictEqual(t.rows().length, 18);
  assert.strictEqual(t.all('.vf-badge, .vf-row-prompt, .vf-review-group').length, 0);
  t.q('.vf-review-none').click();
  t.q('.vf-review-all').click();
  assert.strictEqual(t.app.session.model.enabledCount(), 18);
});
