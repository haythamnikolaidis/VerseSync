'use strict';

// Journey A's last step (docs/09 §6): the real panel (createApp on jsdom) drives the real
// VerseSync.jsx loaded on the T-45 fake Premiere, so the Insert click flow is proved against the
// host contract rather than against a stub.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var JSDOM = require('jsdom').JSDOM;

var root = path.join(__dirname, '..', '..');
var panel = path.join(root, 'panel');
var Main = require(path.join(panel, 'js', 'main.js'));
var Bridge = require(path.join(panel, 'js', 'bridge.js'));
var Insert = require(path.join(panel, 'js', 'insert.js'));
var loadJsx = require(path.join(root, 'tests', 'lib', 'load-jsx.js')).loadJsx;
var fakePremiere = require(path.join(root, 'tests', 'lib', 'fake-premiere.js'));
var html = fs.readFileSync(path.join(panel, 'index.html'), 'utf8');

var JSX = path.join(panel, 'jsx', 'VerseSync.jsx');
var MEDIA = 'C:\\media\\SERMON_A014.MXF';
var TEMPLATE = 'C:\\t\\AV_Quote_04.mogrt';
var SEQUENCE_ID = '7f3c2a10-5b8e-4d21-9c47-1e6a0b93d5f2';
var TARGET_TRACK = 3;
var TPS = 254016000000;
var TRANSLATIONS = [
  { id: 'kjv-id', abbreviation: 'KJV', name: 'King James Version', attribution: 'Public domain.', cache_allowed: true }
];

function cueDocument() {
  var doc = JSON.parse(fs.readFileSync(
    path.join(root, 'tests', 'fixtures', 'cue-documents', 'happy-18-cues.json'), 'utf8'));
  // 16 enabled cues, so the batch is the 16 of the card.
  doc.cues[16].enabled = false;
  doc.cues[17].enabled = false;
  return doc;
}

// settings seeds the panel's stored Setup values, as an earlier session would have left them.
function memoryStorage(settings) {
  var m = {};
  if (settings) {
    m['versesync.state'] = JSON.stringify({ version: 1, settings: settings, mappings: {} });
  }
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    setItem: function (k, v) { m[k] = String(v); },
    removeItem: function (k) { delete m[k]; }
  };
}

function fakeClient(doc) {
  var c = {};
  c.translations = function () {
    return Promise.resolve({ ok: true, data: { provider: 'fake', translations: TRANSLATIONS } });
  };
  c.startJob = function () { return Promise.resolve({ ok: true, data: { job_id: 'job_1', cache_hit: false } }); };
  c.job = function (id) { return Promise.resolve({ ok: true, data: { job_id: id, status: 'done', progress: 1 } }); };
  c.result = function (id) {
    var copy = JSON.parse(JSON.stringify(doc));
    copy.job.id = id;
    return Promise.resolve({ ok: true, data: copy });
  };
  c.cancel = function () { return Promise.resolve({ ok: true, data: {} }); };
  return c;
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

// A bridge whose backend is the real host script. Progress events reach the handlers the moment
// the host dispatches them, as CSXS does, and every call and its answer is recorded.
function hostBridge(fake) {
  var VS = loadJsx(JSX, fake).VS;
  var handlers = [];
  var original = fake.CSXSEvent.prototype.dispatch;
  fake.CSXSEvent.prototype.dispatch = function () {
    original.call(this);
    var evt = { type: this.type, data: this.data };
    handlers.forEach(function (h) { if (h.type === evt.type) { h.fn(evt); } });
  };
  var log = { calls: [], answers: [] };
  return {
    log: log,
    mode: 'premiere',
    init: function () { return Promise.resolve({ ok: true, data: {} }); },
    call: function (name, args) {
      log.calls.push({ name: name, args: JSON.parse(JSON.stringify(args)) });
      var res = Bridge.parseResult(VS[name](JSON.stringify(args)));
      log.answers.push({ name: name, res: res });
      return Promise.resolve(res);
    },
    onEvent: function (type, fn) { handlers.push({ type: type, fn: fn }); }
  };
}

// Builds the panel, runs Analyse and waits for the review list.
async function build(o) {
  o = o || {};
  var fake = fakePremiere.createFakePremiere();
  var seq = fake.addSequence({
    id: SEQUENCE_ID, name: 'Sermon 2026-09-14', timebase: '8475667200',
    zeroPointTicks: '914457600000000', endTicks: '723945600000000',
    videoTracks: 4, audioTracks: 6
  });
  fake.addClip(seq, 'video', 0, {
    name: 'SERMON_A014.MXF', mediaPath: MEDIA, startTicks: '0', endTicks: '723945600000000', inPointTicks: '0'
  });
  fake.registerMogrt(TEMPLATE, fakePremiere.AV_QUOTE_04_FIELDS);

  var bridge = hostBridge(fake);
  var dom = new JSDOM(html);
  var doc = dom.window.document;
  var confirms = [];
  var answer = { value: true };
  var app = Main.createApp({
    document: doc,
    bridge: bridge,
    client: fakeClient(cueDocument()),
    transport: null,
    // The original tests count one graphic per cue; o.settings turns the text layout on.
    storage: memoryStorage(o.settings || { autoWrap: false }),
    confirm: function (text) { confirms.push(text); return answer.value; },
    fs: {
      showOpenDialog: function (multiple, directory, title, initial, extensions) {
        return { err: 0, data: [extensions.indexOf('mogrt') !== -1 ? TEMPLATE : MEDIA] };
      }
    },
    sleep: function () { return tick(); }
  });
  var t = {
    fake: fake, seq: seq, bridge: bridge, app: app, confirms: confirms, answer: answer, doc: doc,
    $: function (id) { return doc.getElementById(id); },
    insertBtn: function () { return doc.querySelector('#review .vf-review-insert'); },
    summary: function () { return doc.querySelector('#insert .vf-insert-summary'); },
    calls: function (name) {
      return bridge.log.calls.filter(function (c) { return c.name === name; });
    },
    track: function () { return seq.videoTracks[TARGET_TRACK].clips; },
    // Counts importMGT calls from now on and fails the ones listed (1-based, in call order).
    watchImports: function (failing) {
      var real = seq.importMGT;
      var state = { n: 0 };
      seq.importMGT = function () {
        state.n += 1;
        if (failing && failing.indexOf(state.n) !== -1) { return null; }
        return real.apply(seq, arguments);
      };
      return state;
    }
  };
  await app.ready;
  t.$('setup-media-btn').click();
  await app.setup.pickTemplate();
  t.$('setup-translation').value = 'kjv-id';
  t.$('setup-translation').dispatchEvent(new dom.window.Event('change'));
  t.$('setup-analyse').click();
  await waitFor(function () { return doc.querySelectorAll('#review .row').length === 18; });
  return t;
}

// Insert batches in the undo log; the template scan at setup has its own group.
function insertGroups(fake) {
  return fake.undoLog.filter(function (e) {
    return e.type === 'begin' && e.name === 'VerseSync: Insert scriptures';
  }).length;
}

test('16 cues go in with one insertCues call, live progress, and one undo group', async function () {
  var t = await build();
  var imports = t.watchImports();
  var seen = [];
  t.bridge.onEvent('com.versesync.progress', function () {
    seen.push({
      label: t.insertBtn().textContent,
      setupLocked: t.$('setup-analyse').disabled && t.$('setup-media-btn').disabled,
      reviewLocked: t.doc.querySelector('#review .vf-review-all').disabled
    });
  });
  assert.strictEqual(t.insertBtn().textContent, 'Insert 16 scriptures');
  t.fake.undoLog.length = 0;

  t.insertBtn().click();
  await waitFor(function () { return t.summary(); });

  assert.strictEqual(t.calls('insertCues').length, 1);
  assert.strictEqual(t.calls('insertCues')[0].args.cues.length, 16);
  assert.strictEqual(t.calls('validateTrack').length, 1);
  assert.strictEqual(imports.n, 16);
  assert.strictEqual(t.track().length, 16);
  assert.strictEqual(t.summary().textContent, 'Placed 16 of 16. Ctrl+Z removes the graphics one at a time.');
  assert.strictEqual(t.confirms.length, 0);

  assert.strictEqual(seen.length, 16);
  assert.strictEqual(seen[6].label, 'Inserting\u2026 7 / 16');
  assert.strictEqual(seen[15].label, 'Inserting\u2026 16 / 16');
  assert.ok(seen.every(function (s) { return s.setupLocked && s.reviewLocked; }));

  // Everything is live again, the label is back, and the review state is untouched.
  assert.strictEqual(t.insertBtn().textContent, 'Insert 16 scriptures');
  assert.strictEqual(t.insertBtn().disabled, false);
  assert.strictEqual(t.$('setup-analyse').disabled, false);
  assert.strictEqual(t.doc.querySelector('#review .vf-review-all').disabled, false);
  assert.strictEqual(t.doc.querySelectorAll('#review .row').length, 18);
  assert.strictEqual(t.app.session.model.enabledCount(), 16);

  assert.deepStrictEqual(t.fake.undoLog, [
    { type: 'begin', name: 'VerseSync: Insert scriptures' },
    { type: 'end' }
  ]);
});

test('a failing cue gives a partial summary and Retry failed inserts only that cue', async function () {
  var t = await build();
  var imports = t.watchImports([3]);

  t.insertBtn().click();
  await waitFor(function () { return t.summary(); });
  assert.strictEqual(t.summary().textContent,
    'Placed 15 of 16 \u2014 1 failed, see details. Ctrl+Z removes the graphics one at a time.');
  assert.strictEqual(t.calls('insertCues').length, 1);
  assert.strictEqual(t.track().length, 15);

  var failed = t.calls('insertCues')[0].args.cues[2];
  var details = t.doc.querySelector('#insert .vf-insert-details');
  assert.ok(details);
  var items = details.querySelectorAll('.vf-insert-failure');
  assert.strictEqual(items.length, 1);
  assert.ok(items[0].textContent.indexOf(failed.reference) === 0);
  assert.ok(/ \u2014 .+/.test(items[0].textContent));
  // The review list was not touched by the failure.
  assert.strictEqual(t.doc.querySelectorAll('#review .row').length, 18);

  t.doc.querySelector('#insert .vf-insert-retry').click();
  await waitFor(function () {
    return t.summary() && t.summary().textContent.indexOf('Placed 16 of 16.') === 0;
  });
  assert.strictEqual(t.calls('insertCues').length, 2);
  var retry = t.calls('insertCues')[1].args;
  assert.deepStrictEqual(retry.cues.map(function (c) { return c.id; }), [failed.id]);
  assert.strictEqual(imports.n, 17);
  assert.strictEqual(t.track().length, 16);
  // The undo note is only for the first batch of the session; nothing is left to retry.
  assert.strictEqual(t.summary().textContent, 'Placed 16 of 16.');
  assert.strictEqual(t.doc.querySelector('#insert .vf-insert-retry'), null);
  assert.strictEqual(insertGroups(t.fake), 2);
  assert.strictEqual(t.fake.openUndoGroups(), 0);
});

test('conflicts ask first; declining inserts nothing, accepting overwrites', async function () {
  var t = await build();
  var first = t.app.session.mapping.placements[t.app.session.model.cues()[0].id];
  var at = BigInt(first.atTicks);
  t.fake.addClip(t.seq, 'video', TARGET_TRACK, {
    name: 'Lower Third', startTicks: String(at - BigInt(TPS)), endTicks: String(at + BigInt(TPS)),
    projectItem: false
  });
  var imports = t.watchImports();
  t.fake.undoLog.length = 0;
  t.answer.value = false;

  t.insertBtn().click();
  await waitFor(function () { return t.confirms.length === 1; });
  await tick();
  assert.strictEqual(t.confirms[0], '1 of your cues will overwrite an existing clip on V4. Continue?');
  assert.strictEqual(t.calls('insertCues').length, 0);
  assert.strictEqual(imports.n, 0);
  assert.strictEqual(t.track().length, 1);
  assert.deepStrictEqual(t.fake.undoLog, []);
  assert.strictEqual(t.summary(), null);
  assert.strictEqual(t.insertBtn().disabled, false);
  assert.strictEqual(t.$('setup-analyse').disabled, false);

  t.answer.value = true;
  t.insertBtn().click();
  await waitFor(function () { return t.summary(); });
  assert.strictEqual(t.confirms.length, 2);
  assert.strictEqual(t.calls('insertCues').length, 1);
  assert.strictEqual(t.summary().textContent.indexOf('Placed 16 of 16.'), 0);
  assert.strictEqual(t.track().length, 17);
});

test('a different focused sequence gives the D20 message and inserts nothing', async function () {
  var t = await build();
  var imports = t.watchImports();
  var other = t.fake.addSequence({ id: 'other-seq', name: 'Other', videoTracks: 4 });
  // The fake does not list the project's sequences; the host reads the analysed one's name there.
  t.fake.app.project.sequences = { numSequences: 2, 0: t.seq, 1: other };
  t.fake.focusSequence('other-seq');
  t.fake.undoLog.length = 0;

  t.insertBtn().click();
  await waitFor(function () { return t.doc.querySelector('#insert .vf-insert-error'); });

  var hostAnswer = t.bridge.log.answers.filter(function (a) { return a.name === 'validateTrack'; })[0].res;
  assert.strictEqual(hostAnswer.ok, false);
  assert.strictEqual(hostAnswer.error,
    'The active sequence changed since this analysis. Switch back to "Sermon 2026-09-14" or click Analyse again.');
  assert.strictEqual(t.doc.querySelector('#insert .vf-insert-error').textContent, hostAnswer.error);
  assert.strictEqual(t.calls('insertCues').length, 0);
  assert.strictEqual(imports.n, 0);
  assert.deepStrictEqual(t.fake.undoLog, []);
  assert.strictEqual(t.insertBtn().disabled, false);
  assert.strictEqual(t.$('setup-analyse').disabled, false);
});

test('blockers stop the click before the host is called', async function () {
  var t = await build();
  t.app.session.mapping.placements[t.app.session.model.cues()[0].id].panelFlags = ['cut_from_edit'];
  var before = t.bridge.log.calls.length;

  t.insertBtn().click();
  await tick();

  var error = t.doc.querySelector('#insert .vf-insert-error');
  assert.ok(error);
  assert.ok(error.textContent.indexOf('Resolve the flagged cues before inserting: ') === 0);
  assert.strictEqual(t.bridge.log.calls.length, before);
});

test('summary wording, exact tick sums and the retry bookkeeping', function () {
  assert.strictEqual(Insert.summaryText(16, 16), 'Placed 16 of 16.');
  assert.strictEqual(Insert.summaryText(14, 16), 'Placed 14 of 16 \u2014 2 failed, see details.');
  assert.strictEqual(Insert.progressText(7, 16), 'Inserting\u2026 7 / 16');
  assert.strictEqual(Insert.addTicks('9007199254740993', '7'), '9007199254741000');
  assert.strictEqual(Insert.addTicks('999', '1'), '1000');
  assert.strictEqual(Insert.addTicks('0', '0'), '0');

  var payload = { sequenceId: 's', cues: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
  var run = Insert.newRun(payload);
  Insert.recordResults(run, [{ id: 'a', ok: true }, { id: 'b', ok: false, error: 'boom' }]);
  assert.strictEqual(Insert.placedCount(run), 1);
  // c was never reported, so it counts as failed rather than as placed.
  assert.deepStrictEqual(Insert.failedIds(run), ['b', 'c']);
  assert.deepStrictEqual(Insert.onlyCues(payload, ['c', 'a']).cues, [{ id: 'a' }, { id: 'c' }]);
  Insert.recordResults(run, [{ id: 'b', ok: true }, { id: 'c', ok: true }]);
  assert.strictEqual(Insert.placedCount(run), 3);
  assert.deepStrictEqual(Insert.failedIds(run), []);
});

// ---- text layout on: a passage that does not fit goes in as several graphics (docs/15) ---------

var LAYOUT_ON = { autoWrap: true, maxCharsPerLine: 80, maxLinesPerGraphic: 4 };

// The batch the panel would send for the current session and settings.
function previewPayload(t, settings) {
  var s = t.app.session;
  var withValues = Object.assign({}, settings, {
    mogrtPath: TEMPLATE, targetTrack: TARGET_TRACK, referenceIndex: 3, bodyIndex: 11
  });
  return Insert.buildPayload(s.model, s.mapping.placements, {
    settings: withValues, sequenceId: SEQUENCE_ID, model: s.model, frameTicks: s.seqInfo.timebase
  });
}

// What the fake stored in a clip's text field: { textEditValue, fontTextRunLength }.
function clipText(clip, index) {
  return JSON.parse(clip.getMGTComponent().properties[index].getValue());
}

test('with the layout on, a long passage goes in as several graphics, in one call', async function () {
  var t = await build({ settings: LAYOUT_ON });
  var before = JSON.stringify(t.app.session.model.toJSON());
  var seen = [];
  t.bridge.onEvent('com.versesync.progress', function () { seen.push(t.insertBtn().textContent); });
  var expected = previewPayload(t, LAYOUT_ON);
  // 16 enabled cues; Psalm 23:1-4 and 1 Corinthians 13:4-7 do not fit 4 lines of 80 and take two each.
  assert.strictEqual(expected.cues.length, 18);

  t.insertBtn().click();
  await waitFor(function () { return t.summary(); });

  var sent = t.calls('insertCues');
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual(sent[0].args.cues, expected.cues);
  var ids = sent[0].args.cues.map(function (c) { return c.id; });
  assert.ok(ids.indexOf('cue_003') !== -1 && ids.indexOf('cue_003#2') !== -1);
  assert.ok(ids.indexOf('cue_004#2') !== -1 && ids.indexOf('cue_003#3') === -1);
  sent[0].args.cues.forEach(function (c) {
    if (c.id.indexOf('cue_003') === 0) { assert.strictEqual(c.reference, 'Psalm 23:1-4 (KJV)'); }
  });

  assert.strictEqual(t.track().length, 18);
  assert.strictEqual(t.summary().textContent,
    'Placed 18 of 18 graphics. Ctrl+Z removes the graphics one at a time.');
  assert.strictEqual(seen.length, 18);
  assert.strictEqual(seen[17], 'Inserting… 18 / 18');
  assert.strictEqual(t.insertBtn().textContent, 'Insert 16 scriptures');

  // The line breaks reached the template, and the run length counts them (fontTextRunLength is the
  // length of the text the host was given, "\n" included).
  var bodyIndex = sent[0].args.mapping.bodyIndex;
  var texts = t.track().map(function (clip) { return clipText(clip, bodyIndex); });
  assert.strictEqual(texts.length, 18);
  sent[0].args.cues.forEach(function (c) {
    var onClip = texts.filter(function (x) { return x.textEditValue === c.body; });
    assert.ok(onClip.length >= 1, 'no clip holds the text of ' + c.id);
    assert.deepStrictEqual(onClip[0].fontTextRunLength, [c.body.length]);
  });
  assert.ok(texts.some(function (x) { return x.textEditValue.indexOf('\n') !== -1; }));

  // The Cue Document is what it was: wrapped text is never stored.
  assert.strictEqual(JSON.stringify(t.app.session.model.toJSON()), before);
  t.app.session.model.cues().forEach(function (cue, i) {
    assert.strictEqual(cue.body, cueDocument().cues[i].body);
  });
});

test('a failed part is named by its cue, and Retry failed inserts only that part', async function () {
  var t = await build({ settings: LAYOUT_ON });
  var order = previewPayload(t, LAYOUT_ON).cues.map(function (c) { return c.id; });
  var imports = t.watchImports([order.indexOf('cue_003#2') + 1]);

  t.insertBtn().click();
  await waitFor(function () { return t.summary(); });
  assert.strictEqual(t.summary().textContent,
    'Placed 17 of 18 graphics — 1 failed, see details. Ctrl+Z removes the graphics one at a time.');
  var items = t.doc.querySelectorAll('#insert .vf-insert-failure');
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].textContent.indexOf('Psalm 23:1-4 (KJV), part 2 of 2 — '), 0);
  assert.strictEqual(t.track().length, 17);

  t.doc.querySelector('#insert .vf-insert-retry').click();
  await waitFor(function () {
    return t.summary() && t.summary().textContent.indexOf('Placed 18 of 18 graphics.') === 0;
  });
  assert.strictEqual(t.calls('insertCues').length, 2);
  assert.deepStrictEqual(t.calls('insertCues')[1].args.cues.map(function (c) { return c.id; }),
    ['cue_003#2']);
  assert.strictEqual(imports.n, 19);
  assert.strictEqual(t.track().length, 18);
  assert.strictEqual(t.doc.querySelector('#insert .vf-insert-retry'), null);
});

test('overwriting a clip with two parts of one cue asks about one cue', async function () {
  var t = await build({ settings: LAYOUT_ON });
  var cue = previewPayload(t, LAYOUT_ON).cues.filter(function (c) { return c.id.indexOf('cue_003') === 0; });
  assert.strictEqual(cue.length, 2);
  // One clip spanning the whole of the cue, so both of its parts land on it.
  var start = BigInt(cue[0].atTicks);
  var end = BigInt(cue[1].atTicks) + BigInt(cue[1].durationTicks);
  t.fake.addClip(t.seq, 'video', TARGET_TRACK, {
    name: 'Lower Third', startTicks: String(start), endTicks: String(end), projectItem: false
  });
  t.answer.value = false;

  t.insertBtn().click();
  await waitFor(function () { return t.confirms.length === 1; });
  await tick();

  var ranges = t.calls('validateTrack')[0].args.ranges;
  assert.strictEqual(ranges.length, 18);
  assert.strictEqual(t.confirms[0], '1 of your cues will overwrite an existing clip on V4. Continue?');
  assert.strictEqual(t.calls('insertCues').length, 0);
});

test('a Setup change applies to the next Insert without analysing again', async function () {
  var t = await build({ settings: LAYOUT_ON });
  var started = t.app.session.jobId;

  // Narrower lines: more cues need two graphics.
  t.$('setup-maxchars').value = '40';
  t.$('setup-maxchars').dispatchEvent(new t.doc.defaultView.Event('change'));
  t.insertBtn().click();
  await waitFor(function () { return t.summary(); });
  var narrow = t.calls('insertCues')[0].args.cues;
  assert.ok(narrow.length > 18);
  narrow.forEach(function (c) {
    assert.ok(c.body.split('\n').every(function (line) { return line.length <= 40; }));
    assert.ok(c.body.split('\n').length <= 4);
  });

  // Unticking the box puts the body in unchanged, as one graphic per cue.
  t.$('setup-autowrap').checked = false;
  t.$('setup-autowrap').dispatchEvent(new t.doc.defaultView.Event('change'));
  t.insertBtn().click();
  await waitFor(function () {
    return t.summary() && t.summary().textContent.indexOf('Placed 16 of 16.') === 0;
  });
  var off = t.calls('insertCues')[1].args.cues;
  assert.strictEqual(off.length, 16);
  off.forEach(function (c) {
    assert.strictEqual(c.body, t.app.session.model.get(c.id).body);
  });
  assert.strictEqual(t.app.session.jobId, started);
});

test('summary wording for graphics, the bookkeeping for part ids, and how a graphic is named', function () {
  assert.strictEqual(Insert.summaryText(18, 18, 16), 'Placed 18 of 18 graphics.');
  assert.strictEqual(Insert.summaryText(17, 18, 16),
    'Placed 17 of 18 graphics — 1 failed, see details.');
  // Unsplit, or with no cue count, the line is the one it always was.
  assert.strictEqual(Insert.summaryText(16, 16, 16), 'Placed 16 of 16.');
  assert.strictEqual(Insert.summaryText(14, 16), 'Placed 14 of 16 — 2 failed, see details.');

  var model = {
    cues: {
      a: { id: 'a', reference_display: 'John 3:16 (KJV)' },
      b: { id: 'b', reference_display: 'Psalm 23:1-4 (KJV)' }
    },
    get: function (id) { return this.cues[id] || null; }
  };
  var payload = { sequenceId: 's', cues: [{ id: 'a' }, { id: 'b' }, { id: 'b#2' }, { id: 'b#3' }] };
  var run = Insert.newRun(payload);
  assert.strictEqual(Insert.cueCount(run, model), 2);
  Insert.recordResults(run, [
    { id: 'a', ok: true }, { id: 'b', ok: true }, { id: 'b#2', ok: false, error: 'boom' }
  ]);
  // b#3 was never reported, so it failed too.
  assert.deepStrictEqual(Insert.failedIds(run), ['b#2', 'b#3']);
  assert.strictEqual(Insert.placedCount(run), 2);
  assert.deepStrictEqual(Insert.onlyCues(payload, Insert.failedIds(run)).cues, [{ id: 'b#2' }, { id: 'b#3' }]);
  assert.strictEqual(Insert.graphicName(run, model, 'a'), 'John 3:16 (KJV)');
  assert.strictEqual(Insert.graphicName(run, model, 'b#2'), 'Psalm 23:1-4 (KJV), part 2 of 3');
  assert.strictEqual(Insert.graphicName(run, model, 'b'), 'Psalm 23:1-4 (KJV), part 1 of 3');
  // A cue deleted since the insert is named by its id.
  assert.strictEqual(Insert.graphicName(run, model, 'gone#2'), 'gone#2');
  Insert.recordResults(run, [{ id: 'b#2', ok: true }, { id: 'b#3', ok: true }]);
  assert.deepStrictEqual(Insert.failedIds(run), []);
  assert.strictEqual(Insert.placedCount(run), 4);
});
