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
    return Promise.resolve({ ok: true, data: [{ text: 'hello', start: 0, end: 1, probability: 0.9 }] });
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
  hostStub.__setScenario({ sequence: 'sequence-2997', segments: o.segments || 'segments-single' });
  var dom = new JSDOM(html);
  var doc = dom.window.document;
  var source = fixture(o.fixture || 'happy-18-cues.json');
  if (o.mutate) { o.mutate(source); }
  var client = fakeClient(source);
  var cepFs = fakeFs();
  var app = Main.createApp({
    document: doc,
    bridge: Bridge.create({ csInterface: null, hostStub: hostStub, jsxPath: null }),
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
    visibleRows: function () {
      return Array.prototype.filter.call(doc.querySelectorAll('#review .row'), function (r) { return !r.hidden; });
    },
    title: function () { return doc.querySelector('#review .vf-review-title').textContent; },
    timecodes: function () {
      return Array.prototype.map.call(doc.querySelectorAll('#review .vf-row-timecode'), function (n) {
        return n.textContent;
      });
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
  await waitFor(function () { return t.rows().length > 0; });
  return t;
}

test('the header counts update when cues are toggled', async function () {
  var t = await build();
  assert.ok(/^REVIEW \u2014 18 found \u00B7 \d+ enabled \[\u2691 \d+\]$/.test(t.title()));
  var before = t.app.session.model.enabledCount();
  var box = t.rows()[0].querySelector('.vf-row-check');
  box.click();
  var expected = t.app.session.model.enabledCount();
  assert.notStrictEqual(expected, before);
  assert.ok(t.title().indexOf(expected + ' enabled') >= 0);
  assert.strictEqual(t.q('.vf-review-insert').textContent,
    'Insert ' + expected + (expected === 1 ? ' scripture' : ' scriptures'));
});

test('All and None enable and disable every cue, and Insert follows', async function () {
  var t = await build();
  t.q('.vf-review-none').click();
  assert.strictEqual(t.app.session.model.enabledCount(), 0);
  assert.ok(t.title().indexOf('0 enabled') >= 0);
  assert.strictEqual(t.q('.vf-review-insert').disabled, true);
  assert.strictEqual(t.q('.vf-review-insert-hint').hidden, false);
  assert.strictEqual(t.doc.querySelectorAll('#review .vf-row--disabled').length, 18);

  t.q('.vf-review-all').click();
  assert.strictEqual(t.app.session.model.enabledCount(), 18);
  assert.ok(t.title().indexOf('18 enabled') >= 0);
  assert.strictEqual(t.q('.vf-review-insert').textContent, 'Insert 18 scriptures');
  assert.strictEqual(t.q('.vf-review-insert').disabled, false);
  assert.strictEqual(t.q('.vf-review-insert-hint').hidden, true);
  assert.strictEqual(t.doc.querySelectorAll('#review .vf-row--disabled').length, 0);
});

test('Flagged only hides the rows with no flags, and toggles back', async function () {
  // Four cues lose their stored flags, so the list has both flagged and unflagged rows.
  var t = await build({ fixture: 'flagged.json', mutate: function (d) {
    d.cues.slice(0, 4).forEach(function (c) { c.flags = []; });
  } });
  var all = t.rows().length;
  var flagged = Array.prototype.filter.call(t.rows(), function (r) {
    return r.querySelector('.vf-flag');
  }).length;
  assert.ok(flagged > 0 && flagged < all);
  t.q('.vf-review-flagged').click();
  assert.strictEqual(t.visibleRows().length, flagged);
  assert.ok(t.visibleRows().every(function (r) { return r.querySelector('.vf-flag'); }));
  assert.strictEqual(t.q('.vf-review-flagged').getAttribute('aria-pressed'), 'true');
  t.q('.vf-review-flagged').click();
  assert.strictEqual(t.visibleRows().length, all);
});

test('Save cue document writes valid JSON and the transcript sibling', async function () {
  var t = await build();
  t.fs.saveAnswers.push('C:\\out\\sermon.json');
  t.q('.vf-review-none').click();
  t.menu('vf-review-save-doc');
  var ref = t.app.session.model.toJSON().transcript.words_ref;
  await waitFor(function () { return t.fs.files['C:\\out\\' + ref] !== undefined; });
  var saved = JSON.parse(t.fs.files['C:\\out\\sermon.json']);
  assert.deepStrictEqual(validate(saved), []);
  assert.strictEqual(saved.cues.filter(function (c) { return c.enabled; }).length, 0);
  assert.deepStrictEqual(t.client.transcripts, ['job_1']);
  assert.strictEqual(JSON.parse(t.fs.files['C:\\out\\' + ref])[0].text, 'hello');
  assert.strictEqual(t.fs.saveTitles[0], 'Save cue document');
});

test('Export as VerseFlow .txt writes the enabled cues', async function () {
  var t = await build();
  t.fs.saveAnswers.push('C:\\out\\scriptures.txt');
  t.menu('vf-review-export-txt');
  assert.strictEqual(t.fs.files['C:\\out\\scriptures.txt'], Cues.exportVerseFlowTxt(t.app.session.model));
  assert.ok(t.fs.files['C:\\out\\scriptures.txt'].length > 0);
});

test('Load re-maps against the current sequence instead of trusting stored positions', async function () {
  var t = await build();
  var first = t.timecodes();
  t.fs.saveAnswers.push('C:\\out\\sermon.json');
  t.menu('vf-review-save-doc');
  await waitFor(function () { return t.fs.files['C:\\out\\sermon.json'] !== undefined; });
  assert.ok(first[0].indexOf('--') === -1);

  // The editor recut the sequence: the same media now sits somewhere else.
  hostStub.__setScenario({ sequence: 'sequence-2997', segments: 'segments-split' });
  t.fs.openAnswers.push('C:\\out\\sermon.json');
  t.menu('vf-review-load-doc');
  await waitFor(function () { return t.app.session.loadedFrom === 'C:\\out\\sermon.json'; });
  await waitFor(function () { return t.rows().length === 18; });
  assert.notDeepStrictEqual(t.timecodes(), first);
  assert.strictEqual(t.app.session.jobId, null);
  assert.ok(t.title().indexOf('18 found') >= 0);
});

test('Load of a file from a newer major version is refused inline and keeps the list', async function () {
  var t = await build();
  var bad = fixture('happy-18-cues.json');
  bad.schema_version = '2.0';
  t.fs.files['C:\\out\\bad.json'] = JSON.stringify(bad);
  t.fs.openAnswers.push('C:\\out\\bad.json');
  t.menu('vf-review-load-doc');
  await tick();
  assert.ok(t.q('.vf-review-message').textContent.indexOf("can't be opened") >= 0);
  assert.strictEqual(t.rows().length, 18);
});
