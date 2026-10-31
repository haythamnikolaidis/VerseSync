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

function memoryStorage() {
  var m = {};
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
    storage: memoryStorage(),
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
