'use strict';

// The optional Scripture file (EasyWorship export) picker in Setup (docs/14 §7, T-51.6 step 1):
// what it sends, where its dialog opens, and that it never gates Analyse or outlives the session.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var JSDOM = require('jsdom').JSDOM;
var FakeCepFs = require(path.join(__dirname, 'helpers', 'fake-cep-fs.js'));

var root = path.join(__dirname, '..', '..');
var panel = path.join(root, 'panel');
var Main = require(path.join(panel, 'js', 'main.js'));
var State = require(path.join(panel, 'js', 'state.js'));
var Bridge = require(path.join(panel, 'js', 'bridge.js'));
var hostStub = require(path.join(panel, 'js', 'lib', 'host-stub.js'));
var html = fs.readFileSync(path.join(panel, 'index.html'), 'utf8');

var MEDIA = 'C:\\media\\SERMON_A014.MXF';
var EXPORT = 'C:\\media\\2026-10-25 - Scriptures.txt';

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'cue-documents', name), 'utf8'));
}

function memoryStorage() {
  var m = {};
  return {
    data: m,
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

// A fake sidecar. startError makes POST /jobs itself fail; failures hands out job errors, as the
// sidecar does for a file it can only judge after transcribing (14 §6). result() answers with the
// mock sidecar's `export` scenario.
function fakeClient(o) {
  o = o || {};
  var c = { started: [] };
  c.translations = function () {
    return Promise.resolve({ ok: true, data: { provider: 'fake', translations: [
      { id: 'kjv-id', abbreviation: 'KJV', name: 'King James Version',
        attribution: 'Public domain.', cache_allowed: true }] } });
  };
  c.startJob = function (req) {
    c.started.push(req);
    if (o.startError) { return Promise.resolve({ ok: false, error: o.startError }); }
    return Promise.resolve({ ok: true, data: { job_id: 'job_1', cache_hit: false } });
  };
  c.job = function (id) {
    if (o.jobError) {
      return Promise.resolve({ ok: true, data: { job_id: id, status: 'failed', error: o.jobError } });
    }
    return Promise.resolve({ ok: true, data: { job_id: id, status: 'done', progress: 1 } });
  };
  c.result = function (id) {
    var copy = fixture('export.json');
    copy.job.id = id;
    return Promise.resolve({ ok: true, data: copy });
  };
  c.cancel = function () { return Promise.resolve({ ok: true, data: {} }); };
  return c;
}

// The real panel wiring around the shared cep.fs fake. The media and template are picked as an
// editor would, so Analyse is ready; pickMedia: false leaves them for the test to do.
async function build(o) {
  o = o || {};
  hostStub.__setScenario({ sequence: 'sequence-2997', segments: 'segments-single' });
  var dom = new JSDOM(html);
  var doc = dom.window.document;
  var storage = o.storage || memoryStorage();
  var cepFs = FakeCepFs.create(o.media || MEDIA);
  var client = fakeClient(o);
  var app = Main.createApp({
    document: doc,
    bridge: Bridge.create({ csInterface: null, hostStub: hostStub, jsxPath: null }),
    client: client,
    transport: null,
    storage: storage,
    fs: cepFs,
    sleep: function () { return tick(); }
  });
  var t = {
    doc: doc, app: app, client: client, fs: cepFs, storage: storage, dom: dom,
    $: function (id) { return doc.getElementById(id); },
    rows: function () { return doc.querySelectorAll('#review .row'); },
    lastOpen: function () { return cepFs.openCalls[cepFs.openCalls.length - 1]; },
    pickScripture: function (answer) {
      cepFs.textAnswers.push(answer);
      t.$('setup-scripture-btn').click();
    }
  };
  await app.ready;
  if (o.pickMedia !== false) { t.$('setup-media-btn').click(); }
  await app.setup.pickTemplate();
  t.$('setup-translation').value = 'kjv-id';
  t.$('setup-translation').dispatchEvent(new dom.window.Event('change'));
  return t;
}

test('the picker sits under the media picker, optional, with Clear hidden until a file is chosen', async function () {
  var t = await build({ pickMedia: false });
  var labels = Array.prototype.map.call(t.$('setup').querySelectorAll('.vf-label'),
    function (n) { return n.textContent; });
  assert.strictEqual(labels[0], 'Media');
  assert.strictEqual(labels[1], 'Scripture file (EasyWorship export)');
  assert.strictEqual(t.$('setup-scripture-name').textContent, 'None (optional)');
  assert.strictEqual(t.$('setup-scripture-clear').hidden, true);
  assert.strictEqual(t.$('setup-scripture-btn').disabled, false);
});

test('the dialog is the .txt file dialog of cep.fs', async function () {
  var t = await build();
  t.pickScripture(EXPORT);
  var call = t.lastOpen();
  assert.deepStrictEqual(call.extensions, ['txt']);
  assert.strictEqual(call.multiple, false);
  assert.strictEqual(call.directory, false);
  assert.strictEqual(call.title, 'Select EasyWorship scripture export');
});

test('the chosen path goes in options.scripture_file, and the name shows beside the picker', async function () {
  var t = await build();
  t.pickScripture(EXPORT);
  assert.strictEqual(t.$('setup-scripture-name').textContent, '2026-10-25 - Scriptures.txt');
  assert.strictEqual(t.$('setup-scripture-name').title, EXPORT);
  assert.strictEqual(t.$('setup-scripture-clear').hidden, false);
  t.$('setup-analyse').click();
  await waitFor(function () { return t.rows().length === 11; });
  assert.strictEqual(t.client.started.length, 1);
  assert.strictEqual(t.client.started[0].options.scripture_file, EXPORT);
  assert.deepStrictEqual(t.client.started[0].options.timing, { lead_in_s: 0.5, duration_mode: 'auto' });
  assert.strictEqual(t.client.started[0].media_path, MEDIA);
});

test('Clear removes the option, and the picker goes back to none', async function () {
  var t = await build();
  t.pickScripture(EXPORT);
  t.$('setup-scripture-clear').click();
  assert.strictEqual(t.$('setup-scripture-name').textContent, 'None (optional)');
  assert.strictEqual(t.$('setup-scripture-name').title, '');
  assert.strictEqual(t.$('setup-scripture-clear').hidden, true);
  t.$('setup-analyse').click();
  await waitFor(function () { return t.client.started.length === 1; });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(t.client.started[0].options, 'scripture_file'), false);
});

test('without a scripture file the request is exactly the one made before the picker existed', async function () {
  var t = await build();
  t.$('setup-analyse').click();
  await waitFor(function () { return t.client.started.length === 1; });
  assert.deepStrictEqual(t.client.started[0], {
    media_path: MEDIA,
    translation_id: 'kjv-id',
    options: { timing: { lead_in_s: 0.5, duration_mode: 'auto' } }
  });
});

test('a cancelled dialog changes nothing', async function () {
  var t = await build();
  t.pickScripture(EXPORT);
  t.pickScripture(null);
  assert.strictEqual(t.$('setup-scripture-name').title, EXPORT);
  assert.strictEqual(t.$('setup-scripture-clear').hidden, false);
});

test('the dialog opens in the media folder', async function () {
  var t = await build();
  t.pickScripture(EXPORT);
  assert.strictEqual(t.lastOpen().initial, 'C:\\media');
});

test('the media folder is read with whichever separator the path uses', async function () {
  var t = await build({ media: '/Volumes/Media/Sermons/SERMON_A014.MXF' });
  t.pickScripture('/Volumes/Media/Sermons/export.txt');
  assert.strictEqual(t.lastOpen().initial, '/Volumes/Media/Sermons');
});

test('with no media chosen the dialog opens where the host left it, then in the last folder used', async function () {
  var t = await build({ pickMedia: false });
  t.pickScripture('D:\\Exports\\export.txt');
  assert.strictEqual(t.lastOpen().initial, null);
  t.$('setup-scripture-clear').click();
  t.pickScripture('D:\\Exports\\export.txt');
  assert.strictEqual(t.lastOpen().initial, 'D:\\Exports');
});

test('the media folder takes over again once a media file is chosen', async function () {
  var t = await build({ pickMedia: false });
  t.pickScripture('D:\\Exports\\export.txt');
  t.$('setup-media-btn').click();
  t.pickScripture(EXPORT);
  assert.strictEqual(t.lastOpen().initial, 'C:\\media');
});

test('picking and clearing never change whether Analyse is enabled', async function () {
  var t = await build({ pickMedia: false });
  var reason = t.$('setup-analyse-reason').textContent;
  assert.strictEqual(t.$('setup-analyse').disabled, true);
  t.pickScripture(EXPORT);
  assert.strictEqual(t.$('setup-analyse').disabled, true);
  assert.strictEqual(t.$('setup-analyse-reason').textContent, reason);
  t.$('setup-media-btn').click();
  assert.strictEqual(t.$('setup-analyse').disabled, false);
  t.$('setup-scripture-clear').click();
  assert.strictEqual(t.$('setup-analyse').disabled, false);
  assert.strictEqual(t.$('setup-analyse-reason').textContent, '');
});

test('the chosen file is per sermon: it is never written to storage or restored', async function () {
  var storage = memoryStorage();
  var t = await build({ storage: storage });
  t.pickScripture(EXPORT);
  assert.ok(Object.keys(storage.data).length > 0);
  Object.keys(storage.data).forEach(function (k) {
    assert.strictEqual(storage.data[k].indexOf('Scriptures.txt'), -1, k);
    assert.strictEqual(storage.data[k].indexOf('scriptureFile'), -1, k);
  });
  var next = await build({ storage: storage });
  assert.strictEqual(next.$('setup-scripture-name').textContent, 'None (optional)');
  assert.strictEqual(State.create({ storage: storage }).get().scriptureFile, null);
});

test('a missing export file is an input error shown like the other job errors', async function () {
  var t = await build({
    startError: {
      code: 'scripture_file_not_found',
      message: 'The scripture file was not found: ' + EXPORT,
      hint: 'Pick the file again, or clear the scripture file.'
    }
  });
  t.pickScripture(EXPORT);
  t.$('setup-analyse').click();
  await waitFor(function () { return t.$('review').querySelector('.vf-failure-retry'); });
  assert.ok(t.$('review').textContent.indexOf('The scripture file was not found: ' + EXPORT) >= 0);
  assert.ok(t.$('review').textContent.indexOf('Pick the file again') >= 0);
  assert.strictEqual(t.rows().length, 0);
  assert.strictEqual(t.$('progress').hidden, true);
});

test('an empty export file fails the job with its message', async function () {
  var t = await build({
    jobError: {
      code: 'scripture_file_empty',
      message: 'The scripture file has no scripture entries.',
      hint: 'Check that it is the EasyWorship export.',
      status: 200
    }
  });
  t.pickScripture(EXPORT);
  t.$('setup-analyse').click();
  await waitFor(function () { return t.$('review').querySelector('.vf-failure-retry'); });
  assert.ok(t.$('review').textContent.indexOf('The scripture file has no scripture entries.') >= 0);
  assert.ok(t.$('review').textContent.indexOf('Check that it is the EasyWorship export.') >= 0);
  assert.strictEqual(t.rows().length, 0);
});
