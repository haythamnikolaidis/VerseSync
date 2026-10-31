'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var JSDOM = require('jsdom').JSDOM;

var panel = path.join(__dirname, '..', '..', 'panel');
var Progress = require(path.join(panel, 'js', 'progress.js'));
var html = fs.readFileSync(path.join(panel, 'index.html'), 'utf8');

var LOG = 'C:\\Users\\ed\\AppData\\Roaming\\VerseSync\\logs\\sidecar.log';

test('statusLine: every docs/09 §2 row has its exact text', function () {
  var cases = [
    [['starting', null, true], '\u25CC', 'starting transcription service\u2026'],
    [['ready', { device: 'cuda', model_loaded: 'large-v3-turbo' }, true],
      '\u25CF', 'ready \u00B7 cuda \u00B7 large-v3-turbo'],
    [['ready', { device: 'cuda', model_loaded: 'large-v3-turbo' }, false],
      '\u25B2', 'no sequence open'],
    [['unreachable', LOG, true], '\u2715', 'transcription service unavailable'],
    [['degraded', { device: 'cpu', model_loaded: 'small', provider: { reachable: true } }, true],
      '\u25B2', 'ready (CPU only)'],
    [['degraded', { device: 'cuda', provider: { reachable: false } }, true],
      '\u25B2', 'ready (Bible API unreachable)']
  ];
  cases.forEach(function (c) {
    var line = Progress.statusLine(c[0][0], c[0][1], c[0][2]);
    assert.strictEqual(line.icon, c[1]);
    assert.strictEqual(line.text, c[2]);
  });
});

test('statusLine: only the unreachable row carries Details, with the log path', function () {
  assert.strictEqual(Progress.statusLine('unreachable', LOG, true).details, LOG);
  assert.strictEqual(Progress.statusLine('starting', null, true).details, undefined);
  assert.strictEqual(Progress.statusLine('ready', { device: 'cpu' }, true).details, undefined);
});

test('renderStatus: Details button reveals the log path', function () {
  var doc = new JSDOM(html).window.document;
  var el = doc.getElementById('status');
  Progress.renderStatus(el, Progress.statusLine('unreachable', LOG, false));
  assert.ok(el.textContent.indexOf('transcription service unavailable') >= 0);
  var btn = el.querySelector('button');
  assert.strictEqual(btn.textContent, 'Details');
  var details = el.querySelector('.vf-status-details');
  assert.strictEqual(details.hidden, true);
  btn.click();
  assert.strictEqual(details.hidden, false);
  assert.strictEqual(details.textContent, LOG);
  Progress.renderStatus(el, Progress.statusLine('ready', { device: 'cpu' }, true));
  assert.strictEqual(el.querySelector('button'), null);
});

function build(onCancel) {
  var doc = new JSDOM(html).window.document;
  var v = Progress.view({
    root: doc.getElementById('progress'),
    setupRoot: doc.getElementById('setup'),
    onCancel: onCancel
  });
  return { doc: doc, view: v, progress: doc.getElementById('progress') };
}

test('progress: phase label and bar follow update', function () {
  var t = build(function () {});
  t.view.begin('KJV');
  t.view.update({ phase: 'transcribing', progress: 0.4, elapsed_s: 30, eta_s: 45 });
  assert.strictEqual(t.progress.querySelector('.vf-progress-phase').textContent, 'Transcribing\u2026');
  assert.strictEqual(t.progress.querySelector('.vf-progress-fill').style.width, '40%');
  t.view.update({ phase: 'detecting', progress: 0.9 });
  assert.strictEqual(t.progress.querySelector('.vf-progress-phase').textContent, 'Detecting\u2026');
});

test('progress: ETA is hidden at or below 10% and shown above', function () {
  var t = build(function () {});
  var readout = t.progress.querySelector('.vf-progress-text');
  t.view.begin('KJV');
  t.view.update({ phase: 'transcribing', progress: 0.05, elapsed_s: 5, eta_s: 100 });
  assert.strictEqual(readout.hidden, true);
  t.view.update({ phase: 'transcribing', progress: 0.1, elapsed_s: 10, eta_s: 90 });
  assert.strictEqual(readout.hidden, true);
  t.view.update({ phase: 'transcribing', progress: 0.11, elapsed_s: 84, eta_s: 112 });
  assert.strictEqual(readout.hidden, false);
  assert.ok(readout.textContent.indexOf('1:24') >= 0);
  assert.ok(readout.textContent.indexOf('1:52') >= 0);
});

test('progress: a cache hit shows Using cached transcript and races to resolving', function () {
  var t = build(function () {});
  t.view.begin('KJV');
  t.view.cacheHit();
  var note = t.progress.querySelector('.vf-progress-cache');
  assert.strictEqual(note.hidden, false);
  assert.strictEqual(note.textContent, 'Using cached transcript');
  assert.strictEqual(t.progress.querySelector('.vf-progress-phase').textContent, 'Resolving\u2026');
  assert.strictEqual(t.progress.querySelector('.vf-progress-fill').style.width, '80%');
});

test('progress: Cancel invokes the client', function () {
  var cancelled = [];
  var client = { cancel: function (id) { cancelled.push(id); return Promise.resolve({ ok: true }); } };
  var t = build(function () { client.cancel('job_1'); });
  t.view.begin('KJV');
  t.progress.querySelector('.vf-progress-cancel').click();
  assert.deepStrictEqual(cancelled, ['job_1']);
});

test('progress: setup collapses to a summary while a job runs and reopens on click', function () {
  var t = build(function () {});
  var setup = t.doc.getElementById('setup');
  var summary = t.doc.querySelector('.vf-setup-summary');
  assert.strictEqual(summary.hidden, true);
  assert.strictEqual(setup.hidden, false);
  assert.strictEqual(t.progress.hidden, true);
  t.view.begin('KJV \u00B7 sermon.mp4');
  assert.strictEqual(setup.hidden, true);
  assert.strictEqual(summary.hidden, false);
  assert.strictEqual(summary.textContent, 'KJV \u00B7 sermon.mp4');
  assert.strictEqual(t.progress.hidden, false);
  summary.click();
  assert.strictEqual(setup.hidden, false);
  summary.click();
  assert.strictEqual(setup.hidden, true);
  t.view.done();
  assert.strictEqual(t.progress.hidden, true);
  assert.strictEqual(setup.hidden, true);
  assert.strictEqual(summary.hidden, false);
});

// T-30.H step 9: SSE events carry no elapsed_s and arrive in bursts, so the readout keeps time.
function buildTicking() {
  var doc = new JSDOM(html).window.document;
  var clock = { t: 0, tick: null, cleared: 0 };
  var v = Progress.view({
    root: doc.getElementById('progress'),
    setupRoot: doc.getElementById('setup'),
    now: function () { return clock.t; },
    setInterval: function (fn) { clock.tick = fn; return 1; },
    clearInterval: function () { clock.tick = null; clock.cleared++; }
  });
  clock.advance = function (ms) { clock.t += ms; if (clock.tick) { clock.tick(); } };
  return { view: v, clock: clock, readout: doc.querySelector('.vf-progress-text') };
}

test('progress: elapsed counts up between events that carry no elapsed_s', function () {
  var t = buildTicking();
  t.view.begin('KJV');
  t.clock.advance(22000);
  t.view.update({ phase: 'transcribing', progress: 0.54, eta_s: 19 });
  assert.ok(t.readout.textContent.indexOf('elapsed 0:22') === 0, t.readout.textContent);
  t.clock.advance(5000);
  assert.ok(t.readout.textContent.indexOf('elapsed 0:27') === 0, t.readout.textContent);
});

test('progress: the ETA counts down from the last event, then says almost done', function () {
  var t = buildTicking();
  t.view.begin('KJV');
  t.view.update({ phase: 'transcribing', progress: 0.54, eta_s: 19 });
  assert.ok(/about 0:19 left/.test(t.readout.textContent), t.readout.textContent);
  t.clock.advance(10000);
  assert.ok(/about 0:09 left/.test(t.readout.textContent), t.readout.textContent);
  t.clock.advance(10000);
  assert.ok(/almost done$/.test(t.readout.textContent), t.readout.textContent);
});

test('progress: done stops the ticker', function () {
  var t = buildTicking();
  t.view.begin('KJV');
  assert.ok(t.clock.tick, 'ticking while a job runs');
  t.view.done();
  assert.strictEqual(t.clock.tick, null);
});
