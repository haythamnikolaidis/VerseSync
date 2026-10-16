'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var JSDOM = require('jsdom').JSDOM;

var root = path.join(__dirname, '..', '..');
var panel = path.join(root, 'panel');
var Main = require(path.join(panel, 'js', 'main.js'));
var Timemap = require(path.join(panel, 'js', 'timemap.js'));
var Bridge = require(path.join(panel, 'js', 'bridge.js'));
var hostStub = require(path.join(panel, 'js', 'lib', 'host-stub.js'));
var html = fs.readFileSync(path.join(panel, 'index.html'), 'utf8');

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'cue-documents', name), 'utf8'));
}

var TRANSLATIONS = [
  { id: 'kjv-id', abbreviation: 'KJV', name: 'King James Version',
    attribution: 'Public domain.', cache_allowed: true }
];

var MEDIA = 'C:\\media\\SERMON_A014.MXF';

function memoryStorage() {
  var m = {};
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    setItem: function (k, v) { m[k] = String(v); },
    removeItem: function (k) { delete m[k]; }
  };
}

// Fake sidecar client. A job reports `done` on its first poll unless `failures` still has an
// error to hand out, in which case it fails with it. result() answers with the scenario's
// golden Cue Document, as the real sidecar does.
function fakeClient(doc, failures) {
  var c = { started: [], results: 0 };
  c.translations = function () {
    return Promise.resolve({ ok: true, data: { provider: 'fake', translations: TRANSLATIONS } });
  };
  c.startJob = function (req) {
    c.started.push(req);
    return Promise.resolve({ ok: true, data: { job_id: 'job_' + c.started.length, cache_hit: false } });
  };
  c.job = function (id) {
    var error = failures && failures.shift();
    if (error) { return Promise.resolve({ ok: true, data: { job_id: id, status: 'failed', error: error } }); }
    return Promise.resolve({ ok: true, data: { job_id: id, status: 'done', progress: 1 } });
  };
  c.result = function (id) {
    c.results += 1;
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

// Builds the real panel markup and wiring around a stub host and a fake client.
async function build(o) {
  o = o || {};
  hostStub.__setScenario({ sequence: 'sequence-2997', segments: o.segments || 'segments-single' });
  var dom = new JSDOM(html);
  var doc = dom.window.document;
  var client = fakeClient(fixture(o.fixture || 'happy-18-cues.json'), o.failures);
  var app = Main.createApp({
    document: doc,
    bridge: Bridge.create({ csInterface: null, hostStub: hostStub, jsxPath: null }),
    client: client,
    transport: null,
    storage: memoryStorage(),
    fs: {
      showOpenDialog: function (multiple, directory, title, initial, extensions) {
        return { err: 0, data: [extensions.indexOf('mogrt') !== -1 ? 'C:\\t\\AV_Quote_04.mogrt' : MEDIA] };
      }
    },
    sleep: function () { return tick(); }
  });
  var t = {
    doc: doc, app: app, client: client,
    $: function (id) { return doc.getElementById(id); },
    rows: function () { return doc.querySelectorAll('#review .row'); }
  };
  await app.ready;
  t.$('setup-media-btn').click();
  await app.setup.pickTemplate();
  t.$('setup-translation').value = 'kjv-id';
  t.$('setup-translation').dispatchEvent(new dom.window.Event('change'));
  return t;
}

test('Analyse renders the 18 rows of the happy scenario and remembers the sequence', async function () {
  var t = await build();
  assert.strictEqual(t.$('setup-analyse').disabled, false);
  t.$('setup-analyse').click();
  await waitFor(function () { return t.rows().length === 18; });
  assert.strictEqual(t.$('review').hidden, false);
  assert.strictEqual(t.$('progress').hidden, true);
  assert.strictEqual(t.client.started.length, 1);
  assert.strictEqual(t.client.started[0].media_path, MEDIA);
  assert.strictEqual(t.client.started[0].translation_id, 'kjv-id');
  assert.ok(/REVIEW \u2014 18 found/.test(t.$('review').textContent));
  assert.strictEqual(t.app.session.sequenceId, '7f3c2a10-5b8e-4d21-9c47-1e6a0b93d5f2');
  assert.strictEqual(t.app.session.jobId, 'job_1');
  assert.strictEqual(t.app.session.model.cues().length, 18);
  assert.notStrictEqual(t.rows()[0].querySelector('.vf-row-timecode').textContent, '--:--:--:--');
});

test('media missing from the sequence asks for a start timecode and renders approximate rows', async function () {
  var t = await build({ segments: 'segments-none' });
  t.$('setup-analyse').click();
  await waitFor(function () { return t.$('review-manual-offset'); });
  assert.strictEqual(t.rows().length, 0);
  assert.ok(t.$('review').textContent.indexOf("SERMON_A014.MXF isn't in this sequence.") >= 0);
  assert.ok(t.$('review').textContent.indexOf('Enter a start timecode manually') >= 0);

  t.$('review-manual-offset').value = 'soon';
  t.$('review-manual-apply').click();
  assert.strictEqual(t.rows().length, 0);
  assert.ok(t.$('review').textContent.indexOf('HH:MM:SS:FF') >= 0);

  t.$('review-manual-offset').value = '01:00:00:00';
  t.$('review-manual-apply').click();
  assert.strictEqual(t.rows().length, 18);
  assert.ok(t.$('review').textContent.indexOf('approximate') >= 0);
  assert.strictEqual(t.app.session.mapping.approximate, true);
  // 01:00:00:00 is 108000 frames of the 29.97 sequence, less its one-hour zero point.
  assert.strictEqual(t.app.session.manualOffsetTicks, String(108000 * 8475667200 - 914457600000000));
  var cue = t.app.session.model.cues()[0];
  var placement = t.app.session.mapping.placements[cue.id];
  var raw = Number(t.app.session.manualOffsetTicks) + Timemap.secondsToTicks(cue.source_anchor_s);
  assert.strictEqual(placement.atTicks, Timemap.snapToFrame(raw, '8475667200'));
});

test('a failed job shows its message and hint, and Retry starts it again', async function () {
  var t = await build({
    failures: [{ code: 'transcription_failed', message: 'The audio could not be decoded.',
      hint: 'Try converting the file to WAV.', status: 200 }]
  });
  t.$('setup-analyse').click();
  await waitFor(function () { return t.$('review').querySelector('.vf-failure-retry'); });
  assert.ok(t.$('review').textContent.indexOf('The audio could not be decoded.') >= 0);
  assert.ok(t.$('review').textContent.indexOf('Try converting the file to WAV.') >= 0);
  assert.strictEqual(t.rows().length, 0);
  assert.strictEqual(t.$('progress').hidden, true);

  t.$('review').querySelector('.vf-failure-retry').click();
  await waitFor(function () { return t.rows().length === 18; });
  assert.strictEqual(t.client.started.length, 2);
});

test('an analysis that found nothing says so instead of rendering a list', async function () {
  var t = await build({ fixture: 'empty.json' });
  t.$('setup-analyse').click();
  await waitFor(function () { return t.$('review').querySelector('.vf-review-empty'); });
  assert.strictEqual(t.rows().length, 0);
});

test('parseTimecode removes the sequence zero point and rejects bad input', function () {
  var seq = { frameRate: 29.97, timebase: '8475667200', zeroPointTicks: '914457600000000' };
  // The zero point is a little over 107892 frames, so the display calls tick 0 00:59:56:12 and
  // the first whole frame at or after it is 00:59:56:13.
  assert.strictEqual(Timemap.timecode('0', seq), '00:59:56:12');
  assert.ok(Main.parseTimecode('00:59:56:12', seq).error);
  assert.strictEqual(Main.parseTimecode('00:59:56:13', seq).ticks,
    String(107893 * 8475667200 - 914457600000000));
  var a = Number(Main.parseTimecode('01:00:00:00', seq).ticks);
  var b = Number(Main.parseTimecode('01:00:01:00', seq).ticks);
  assert.strictEqual(b - a, 30 * 8475667200);
  assert.ok(Main.parseTimecode('00:00:00:00', seq).error);
  assert.ok(Main.parseTimecode('01:00:00:30', seq).error);
  assert.ok(Main.parseTimecode('01:61:00:00', seq).error);
  assert.ok(Main.parseTimecode('one o clock', seq).error);
});
