'use strict';

// T-32.2: every row of docs/03 §8 (the panel and host rows) and docs/09 §7, reproduced against
// the real panel (createApp on jsdom), and the never-settling audit. Sidecar rows run against
// the real mock process (tools/mock_sidecar.py and its --fail flags) through the real client and
// transport; host rows run against the stub host or against VerseSync.jsx on the fake Premiere.
//
// Every bridge, client and lifecycle call goes through a watchdog (createGuard). A test ends
// with settled(), which fails it if any call is still pending or overran the watchdog, or if a
// spinner is still showing. Nothing here may wait on a timer longer than the watchdog.

var test = require('node:test');
var assert = require('node:assert');
var events = require('node:events');
var fs = require('node:fs');
var http = require('node:http');
var path = require('node:path');
var JSDOM = require('jsdom').JSDOM;

var root = path.join(__dirname, '..', '..');
var panel = path.join(root, 'panel');
var Main = require(path.join(panel, 'js', 'main.js'));
var Bridge = require(path.join(panel, 'js', 'bridge.js'));
var Sidecar = require(path.join(panel, 'js', 'sidecar.js'));
var hostStub = require(path.join(panel, 'js', 'lib', 'host-stub.js'));
var loadJsx = require(path.join(root, 'tests', 'lib', 'load-jsx.js')).loadJsx;
var fakePremiere = require(path.join(root, 'tests', 'lib', 'fake-premiere.js'));
var spawnMock = require(path.join(__dirname, 'helpers', 'spawn-mock.js'));
var html = fs.readFileSync(path.join(panel, 'index.html'), 'utf8');

var JSX = path.join(panel, 'jsx', 'VerseSync.jsx');
var MEDIA = 'C:\\media\\SERMON_A014.MXF';
var TEMPLATE = 'C:\\t\\AV_Quote_04.mogrt';
var SAVED = 'C:\\out\\cues.json';
var SEQUENCE_ID = '7f3c2a10-5b8e-4d21-9c47-1e6a0b93d5f2';
var WATCHDOG_MS = 5000;
var TRANSLATIONS = [
  { id: 'kjv-id', abbreviation: 'KJV', name: 'King James Version',
    attribution: 'Public domain.', cache_allowed: true }
];

var skipMock = spawnMock.pythonAvailable() ? false : 'python3 is not on PATH; skipping mock tests';

// ---- helpers --------------------------------------------------------------------------------

function fixture(name) {
  return JSON.parse(fs.readFileSync(
    path.join(root, 'tests', 'fixtures', 'cue-documents', name), 'utf8'));
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

function waitFor(predicate, what) {
  return new Promise(function (resolve, reject) {
    var started = Date.now();
    (function poll() {
      if (predicate()) { resolve(); return; }
      if (Date.now() - started > WATCHDOG_MS) {
        reject(new Error('timed out waiting for ' + (what || 'the panel')));
        return;
      }
      setTimeout(poll, 5);
    })();
  });
}

// The watchdog. wrap(obj, prefix) returns an object that reads through to obj, with every
// function property replaced by one that records the call and, when it returns a promise, starts
// a timer: a promise still unsettled after `ms` is a violation.
function createGuard(ms) {
  var g = { ms: ms || WATCHDOG_MS, log: [], pending: 0, violations: [] };
  g.wrap = function (obj, prefix) {
    var out = Object.create(obj);
    Object.keys(obj).forEach(function (key) {
      if (typeof obj[key] !== 'function') { return; }
      out[key] = function () {
        var args = arguments;
        var label = prefix + '.' + key + (typeof args[0] === 'string' ? ':' + args[0] : '');
        g.log.push(label);
        var result = obj[key].apply(obj, args);
        if (!result || typeof result.then !== 'function') { return result; }
        g.pending += 1;
        var timer = setTimeout(function () {
          g.violations.push(label + ' did not settle within ' + g.ms + ' ms');
        }, g.ms);
        var done = function () { clearTimeout(timer); g.pending -= 1; };
        result.then(done, done);
        return result;
      };
    });
    return out;
  };
  g.count = function (label) {
    return g.log.filter(function (l) { return l === label; }).length;
  };
  return g;
}

// What a user would call a spinner: the progress view, a busy section, the Inserting label, the
// template read, or (when asked for) the starting status.
function spinners(doc, withStatus) {
  var found = [];
  if (!doc.getElementById('progress').hidden) { found.push('the progress view is showing'); }
  if (doc.querySelector('[aria-busy="true"]')) { found.push('a section is aria-busy'); }
  var insert = doc.querySelector('.vf-review-insert');
  if (insert && /Inserting/.test(insert.textContent)) { found.push('the Insert button says Inserting'); }
  var msg = doc.getElementById('setup-template-msg');
  if (!msg.hidden && /Reading template/.test(msg.textContent)) { found.push('the template read is showing'); }
  if (withStatus && /starting/.test(doc.getElementById('status').textContent)) {
    found.push('the status strip says starting');
  }
  return found;
}

function fakeFs() {
  var f = { files: {}, openAnswers: [] };
  f.showOpenDialog = function (multiple, directory, title, initial, extensions) {
    if (extensions.indexOf('mogrt') !== -1) { return { err: 0, data: [TEMPLATE] }; }
    if (extensions.indexOf('json') !== -1) { return { err: 0, data: [f.openAnswers.shift()] }; }
    return { err: 0, data: [MEDIA] };
  };
  f.readFile = function (p) {
    return Object.prototype.hasOwnProperty.call(f.files, p) ?
      { err: 0, data: f.files[p] } : { err: 3, data: '' };
  };
  return f;
}

// A fake sidecar client. A job is `done` on its first poll unless `o.jobError` is set, in which
// case it is `failed` with that error. startError makes POST /jobs itself fail.
function fakeClient(doc, o) {
  o = o || {};
  var c = { started: [], results: 0, resolves: 0 };
  c.translations = function () {
    return Promise.resolve({ ok: true, data: { provider: 'fake', translations: TRANSLATIONS } });
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
    c.results += 1;
    var copy = JSON.parse(JSON.stringify(doc));
    copy.job.id = id;
    return Promise.resolve({ ok: true, data: copy });
  };
  c.transcript = function () { return Promise.resolve({ ok: false, error: { message: 'none' } }); };
  c.resolve = function () {
    c.resolves += 1;
    return o.resolve ? o.resolve() : Promise.resolve({ ok: true, data: {} });
  };
  c.cancel = function () { return Promise.resolve({ ok: true, data: {} }); };
  return c;
}

// The stub host, on the same bridge the panel uses outside Premiere.
function stubBridge(scenario) {
  hostStub.__setScenario(scenario || { sequence: 'sequence-2997', segments: 'segments-single' });
  return Bridge.create({ csInterface: null, hostStub: hostStub, jsxPath: null });
}

// VerseSync.jsx on the fake Premiere, as the Insert tests drive it. `answers` records what the
// host said to every call.
function hostWorld(o) {
  o = o || {};
  var fake = fakePremiere.createFakePremiere();
  var seq = fake.addSequence({
    id: SEQUENCE_ID, name: 'Sermon 2026-09-14', timebase: '8475667200',
    zeroPointTicks: '914457600000000', endTicks: '723945600000000',
    videoTracks: 4, audioTracks: 6
  });
  fake.addClip(seq, 'video', 0, {
    name: 'SERMON_A014.MXF', mediaPath: MEDIA, startTicks: '0', endTicks: '723945600000000',
    inPointTicks: '0'
  });
  fake.registerMogrt(TEMPLATE, o.fields || fakePremiere.AV_QUOTE_04_FIELDS);
  var VS = loadJsx(JSX, fake).VS;
  var answers = [];
  var bridge = {
    mode: 'premiere',
    init: function () { return Promise.resolve({ ok: true, data: {} }); },
    call: function (name, args) {
      var res = Bridge.parseResult(VS[name](JSON.stringify(args)));
      answers.push({ name: name, res: res });
      return Promise.resolve(res);
    }
  };
  return { fake: fake, seq: seq, bridge: bridge, answers: answers };
}

// Builds the real panel around the given pieces. o: bridge, client (null for no sidecar),
// transport, fs, pollMs, doc (the cue document the default fake client serves).
async function build(o) {
  o = o || {};
  var guard = createGuard(o.watchdogMs);
  var dom = new JSDOM(html);
  var doc = dom.window.document;
  var inner = o.client === undefined ? fakeClient(o.doc || fixture('happy-18-cues.json')) : o.client;
  var files = o.fs || fakeFs();
  var app = Main.createApp({
    document: doc,
    bridge: guard.wrap(o.bridge || stubBridge(), 'bridge'),
    client: inner === null ? null : guard.wrap(inner, 'client'),
    transport: o.transport || null,
    storage: memoryStorage(),
    fs: files,
    confirm: function () { return true; },
    sleep: function () { return tick(); },
    pollMs: o.pollMs
  });
  var t = {
    dom: dom, doc: doc, app: app, guard: guard, fs: files, client: inner,
    $: function (id) { return doc.getElementById(id); },
    q: function (sel) { return doc.querySelector(sel); },
    rows: function () { return doc.querySelectorAll('#review .row'); },
    text: function (id) { return doc.getElementById(id).textContent; },
    // The setup the Insert tests use: media, template and translation chosen.
    prepare: async function (translationId) {
      t.$('setup-media-btn').click();
      await app.setup.pickTemplate();
      var select = t.$('setup-translation');
      select.value = translationId || select.options[1].value;
      select.dispatchEvent(new dom.window.Event('change'));
    },
    // The end of every test: nothing pending, nothing overran, no spinner left.
    settled: async function (withStatus) {
      await tick();
      assert.deepStrictEqual(guard.violations, [], 'a call overran the watchdog');
      assert.strictEqual(guard.pending, 0, 'a call is still pending');
      assert.deepStrictEqual(spinners(doc, withStatus), []);
    }
  };
  await app.ready;
  return t;
}

// The real mock, behind the real lifecycle, client and transport.
async function mockWorld(t, flags, transportOptions) {
  var world = spawnMock.createMockEnv();
  t.after(function () { world.cleanup(); });
  var transport = Sidecar.createNodeTransport(http, transportOptions);
  var lifecycle = Sidecar.createLifecycle({
    fs: fs,
    childProcess: world.childProcess,
    env: world.env,
    platform: process.platform,
    clientFactory: function (conn) {
      return Sidecar.VSSidecarClient.create({ transport: transport, port: conn.port, token: conn.token });
    },
    now: Date.now,
    sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
    launchCommand: world.launchCommand(flags)
  });
  var result = await lifecycle.connect();
  assert.ok(result.client, 'the mock sidecar should have started');
  return { world: world, transport: transport, client: result.client };
}

function failure(t) {
  var box = t.q('#review .vf-failure');
  return box && {
    box: box,
    message: box.querySelector('.vf-failure-message').textContent,
    hint: box.querySelector('.vf-failure-hint') && box.querySelector('.vf-failure-hint').textContent,
    retry: box.querySelector('.vf-failure-retry')
  };
}

function savedDocument() {
  var doc = fixture('happy-18-cues.json');
  doc.job.media_path = MEDIA;
  return doc;
}

// ---- docs/03 §8: the sidecar rows -----------------------------------------------------------

var WIN_LOG = 'C:\\Users\\ed\\AppData\\Roaming\\VerseSync\\logs\\sidecar.log';

function launchWorld(spawn) {
  var clock = { now: 0 };
  return Sidecar.createLifecycle({
    fs: {
      readFileSync: function () { throw new Error('ENOENT'); },
      unlinkSync: function () { throw new Error('ENOENT'); }
    },
    childProcess: { spawn: spawn },
    env: { APPDATA: 'C:\\Users\\ed\\AppData\\Roaming' },
    platform: 'win32',
    clientFactory: function () { throw new Error('there is no sidecar to talk to'); },
    now: function () { return clock.now; },
    sleep: function (ms) { clock.now += ms; return tick(); },
    isProcessAlive: function () { return false; }
  });
}

var WONT_LAUNCH = [
  ['the launch command cannot be spawned', function () { throw new Error('spawn pythonw.exe ENOENT'); }],
  ['the child reports a launch error', function () {
    var child = new events.EventEmitter();
    setImmediate(function () { child.emit('error', new Error('ENOENT')); });
    return child;
  }],
  ['the process starts but never writes its lock file', function () { return new events.EventEmitter(); }]
];

WONT_LAUNCH.forEach(function (row) {
  test('sidecar will not launch (' + row[0] + '): message, log path, Analyse disabled', async function () {
    var t = await build({ client: null });
    var lifecycle = t.guard.wrap(launchWorld(row[1]), 'lifecycle');
    lifecycle.onState(function (state, detail) { t.app.setLifecycle(state, detail); });

    var result = await lifecycle.connect();

    assert.strictEqual(result.state, 'unreachable');
    assert.strictEqual(result.detail, WIN_LOG);
    assert.strictEqual(t.q('#status .vf-status-text').textContent, ' transcription service unavailable');
    assert.ok(t.q('#status').classList.contains('vf-status--error'));
    assert.strictEqual(t.q('#status .vf-status-details').textContent, WIN_LOG);
    assert.strictEqual(t.$('setup-analyse').disabled, true);
    assert.strictEqual(t.text('setup-analyse-reason'), "Transcription service isn't ready.");
    await t.settled(true);
  });
});

test('with the sidecar down, a saved cue document still loads and inserts', async function () {
  var host = hostWorld();
  var files = fakeFs();
  files.files[SAVED] = JSON.stringify(savedDocument());
  files.openAnswers.push(SAVED);
  var t = await build({ client: null, bridge: host.bridge, fs: files });
  var lifecycle = t.guard.wrap(launchWorld(WONT_LAUNCH[0][1]), 'lifecycle');
  lifecycle.onState(function (state, detail) { t.app.setLifecycle(state, detail); });
  await lifecycle.connect();
  t.$('setup-media-btn').click();
  await t.app.setup.pickTemplate();
  assert.strictEqual(t.$('setup-analyse').disabled, true);

  t.q('#review .vf-load-doc').click();
  await waitFor(function () { return t.rows().length === 18; }, 'the loaded rows');
  assert.strictEqual(t.q('#review .vf-review-insert').textContent, 'Insert 18 scriptures');

  host.fake.undoLog.length = 0;
  t.q('#review .vf-review-insert').click();
  await waitFor(function () { return t.q('#insert .vf-insert-summary'); }, 'the insert summary');
  assert.strictEqual(t.q('#insert .vf-insert-summary').textContent,
    'Placed 18 of 18. Ctrl+Z removes the graphics one at a time.');
  assert.strictEqual(host.seq.videoTracks[3].clips.length, 18);
  assert.deepStrictEqual(host.fake.undoLog, [
    { type: 'begin', name: 'VerseSync: Insert scriptures' },
    { type: 'end' }
  ]);
  assert.strictEqual(t.$('setup-analyse').disabled, true);
  assert.strictEqual(t.q('#status .vf-status-text').textContent, ' transcription service unavailable');
  await t.settled(true);
});

test('Load cue document says why when the file cannot be read, with no review open', async function () {
  var files = fakeFs();
  files.openAnswers.push(SAVED);
  var t = await build({ client: null, fs: files });

  t.q('#review .vf-load-doc').click();
  await tick();

  assert.strictEqual(t.q('#review .vf-load-note').hidden, false);
  assert.strictEqual(t.q('#review .vf-load-note').textContent, 'That file could not be read.');
  await t.settled();
});

test('the sidecar dies mid-job: the stream closes, the panel polls, and offers the job again',
  { skip: skipMock }, async function (c) {
    var mock = await mockWorld(c, ['--duration', '2', '--die-mid-job']);
    var t = await build({ client: mock.client, transport: mock.transport, pollMs: 50 });
    await t.prepare();
    t.$('setup-analyse').click();

    await waitFor(function () { return failure(t); }, 'the failure');
    var shown = failure(t);
    assert.strictEqual(shown.message, 'The VerseSync sidecar is not responding.');
    assert.strictEqual(shown.hint, 'Check that the sidecar is running, then try again.');
    assert.ok(shown.retry, 'a Retry button restarts the job');
    assert.strictEqual(t.rows().length, 0);

    // The sidecar stays dead, so Retry fails again, the same way, instead of hanging.
    shown.retry.click();
    await waitFor(function () { return failure(t) && failure(t).retry !== shown.retry; }, 'the second failure');
    assert.strictEqual(failure(t).message, 'The VerseSync sidecar is not responding.');
    assert.strictEqual(t.guard.count('client.startJob'), 2);
    await t.settled();
  });

test('the model fails to load: the sidecar message and hint are shown, with Retry',
  { skip: skipMock }, async function (c) {
    var mock = await mockWorld(c, ['--fail', 'model_load_failed']);
    var t = await build({ client: mock.client, transport: mock.transport, pollMs: 50 });
    await t.prepare();
    t.$('setup-analyse').click();

    await waitFor(function () { return failure(t); }, 'the failure');
    var shown = failure(t);
    assert.strictEqual(shown.message,
      'Could not load large-v3-turbo on cuda: out of memory (9.1 GB free, ~10.4 GB required).');
    assert.strictEqual(shown.hint, 'Try large-v3-turbo with float16, or switch to CPU.');
    assert.ok(shown.retry);
    assert.strictEqual(t.rows().length, 0);

    shown.retry.click();
    await waitFor(function () { return failure(t) && failure(t).retry !== shown.retry; }, 'the second failure');
    assert.strictEqual(t.guard.count('client.startJob'), 2);
    await t.settled();
  });

var UNREADABLE = {
  code: 'media_unreadable',
  message: 'The media file could not be read: ' + MEDIA,
  hint: 'Check that the file is not open in another program and that you can read it.',
  status: 400
};

test('the media is unreadable (rejected at POST /jobs): message and hint, nothing cached', async function () {
  var t = await build({ client: fakeClient(fixture('happy-18-cues.json'), { startError: UNREADABLE }) });
  await t.prepare();
  t.$('setup-analyse').click();

  await waitFor(function () { return failure(t); }, 'the failure');
  assert.strictEqual(failure(t).message, UNREADABLE.message);
  assert.strictEqual(failure(t).hint, UNREADABLE.hint);
  assert.ok(failure(t).retry);
  assert.strictEqual(t.client.results, 0, 'no result is fetched for a job that never ran');
  assert.strictEqual(t.app.session, null);
  assert.strictEqual(t.rows().length, 0);
  await t.settled();
});

test('the media has no audio (the job fails before transcription): message and hint', async function () {
  var error = {
    code: 'transcription_failed',
    message: 'The audio could not be transcribed: no audio stream.',
    hint: 'Check that the media file has an audio track, then try again.',
    status: 200
  };
  var t = await build({ client: fakeClient(fixture('happy-18-cues.json'), { jobError: error }) });
  await t.prepare();
  t.$('setup-analyse').click();

  await waitFor(function () { return failure(t); }, 'the failure');
  assert.strictEqual(failure(t).message, error.message);
  assert.strictEqual(failure(t).hint, error.hint);
  assert.strictEqual(t.client.results, 0);
  assert.strictEqual(t.rows().length, 0);
  await t.settled();
});

test('the Bible provider is down: the job succeeds, the cues are flagged, a banner offers a retry',
  { skip: skipMock }, async function (c) {
    var mock = await mockWorld(c, ['--fail', 'provider_unavailable', '--duration', '1']);
    var t = await build({ client: mock.client, transport: mock.transport, pollMs: 50 });
    await t.prepare();
    t.$('setup-analyse').click();

    await waitFor(function () { return t.rows().length === 12; }, 'the flagged rows');
    assert.strictEqual(failure(t), null, 'a provider outage is not a failed job');
    assert.strictEqual(t.q('#review .vf-review-banner').hidden, false);
    assert.strictEqual(t.q('#review .vf-review-banner-text').textContent,
      'The Bible text could not be fetched for some cues. ');
    assert.strictEqual(t.q('#review .vf-review-retry-text').textContent, 'Retry text fetch');
    assert.ok(t.q('#review .vf-flag-text_unavailable'));
    await t.settled();
  });

test('Retry text fetch with the provider still down says so and unlocks the button', async function () {
  var down = { ok: false, error: { code: 'provider_unavailable', message: 'The Bible text service could not be reached.' } };
  var client = fakeClient(fixture('flagged.json'), { resolve: function () { return Promise.resolve(down); } });
  var t = await build({ client: client });
  await t.prepare();
  t.$('setup-analyse').click();
  await waitFor(function () { return t.rows().length === 12; }, 'the flagged rows');

  t.q('#review .vf-review-retry-text').click();
  await waitFor(function () { return client.resolves === 1 && !t.q('#review .vf-review-retry-text').disabled; },
    'the retry to finish');

  assert.strictEqual(t.q('#review .vf-review-message').textContent, down.error.message);
  assert.strictEqual(t.q('#review .vf-review-banner').hidden, false);
  assert.strictEqual(client.resolves, 1, 'a dead provider costs one request, not one per cue');
  await t.settled();
});

// ---- docs/03 §8 and docs/09 §7: the host rows -----------------------------------------------

test('no sequence open: Analyse is disabled with the reason, and the status says so', async function () {
  var t = await build({ bridge: stubBridge({ sequence: 'sequence-none', segments: 'segments-single' }) });
  t.app.setLifecycle('ready', { status: 'ready', device: 'cuda', model_loaded: 'large-v3-turbo' });
  await t.app.start();
  await t.prepare();

  assert.strictEqual(t.$('setup-analyse').disabled, true);
  assert.strictEqual(t.text('setup-analyse-reason'), 'Open a sequence in Premiere first.');
  assert.strictEqual(t.q('#status .vf-status-text').textContent, ' no sequence open');
  await t.settled(true);
});

test('no sequence open: loading a cue document explains it, and Insert says the same', async function () {
  var files = fakeFs();
  files.files[SAVED] = JSON.stringify(savedDocument());
  files.openAnswers.push(SAVED, SAVED);
  var t = await build({ bridge: stubBridge(), fs: files });
  await t.prepare();
  t.$('setup-analyse').click();
  await waitFor(function () { return t.rows().length === 18; }, 'the rows');

  // The editor closes the sequence. Insert goes to the host, which refuses it.
  stubBridge({ sequence: 'sequence-none', segments: 'segments-single' });
  t.q('#review .vf-review-insert').click();
  await waitFor(function () { return t.q('#insert .vf-insert-error'); }, 'the insert error');
  assert.strictEqual(t.q('#insert .vf-insert-error').textContent, 'Open a sequence in Premiere first.');
  assert.strictEqual(t.guard.count('bridge.call:insertCues'), 0);

  // Refresh tells setup, so Analyse and Insert are both blocked without another host call.
  await t.app.setup.refreshTracks();
  assert.strictEqual(t.$('setup-analyse').disabled, true);
  assert.strictEqual(t.text('setup-analyse-reason'), 'Open a sequence in Premiere first.');
  var checks = t.guard.count('bridge.call:validateTrack');
  t.q('#review .vf-review-insert').click();
  await tick();
  var lines = Array.prototype.map.call(t.doc.querySelectorAll('#insert .vf-insert-error-line'),
    function (line) { return line.textContent; });
  assert.strictEqual(lines[0], 'Open a sequence in Premiere first.');
  assert.strictEqual(t.guard.count('bridge.call:validateTrack'), checks);

  // Loading a document with no sequence open explains itself and offers to try again.
  t.q('#review .vf-review-save').click();
  t.q('#review .vf-review-load-doc').click();
  await waitFor(function () { return failure(t); }, 'the load failure');
  assert.strictEqual(failure(t).message, 'Open a sequence in Premiere first.');
  assert.ok(failure(t).retry);
  stubBridge();
  await t.settled();
});

test('the media is not in the sequence: the panel says so and takes a timecode instead', async function () {
  var t = await build({ bridge: stubBridge({ sequence: 'sequence-2997', segments: 'segments-none' }) });
  await t.prepare();
  t.$('setup-analyse').click();

  await waitFor(function () { return t.$('review-manual-offset'); }, 'the manual offset form');
  assert.strictEqual(t.q('#review .vf-review-notice').textContent, "SERMON_A014.MXF isn't in this sequence.");
  assert.strictEqual(t.q('#review .vf-label').textContent, 'Enter a start timecode manually');
  assert.strictEqual(t.rows().length, 0);

  t.$('review-manual-offset').value = '01:00:00:00';
  t.$('review-manual-apply').click();
  assert.strictEqual(t.rows().length, 18);
  assert.strictEqual(t.q('#review .vf-review-notice').textContent,
    'Positions come from the start timecode you entered, so they are approximate if the audio was cut.');
  await t.settled();
});

test('the MOGRT has no editable fields: warning, Analyse and Insert both refuse', async function () {
  var host = hostWorld({ fields: [] });
  var files = fakeFs();
  files.files[SAVED] = JSON.stringify(savedDocument());
  files.openAnswers.push(SAVED);
  var t = await build({ bridge: host.bridge, fs: files });
  await t.prepare();

  assert.strictEqual(t.text('setup-template-msg'),
    'No editable text fields were found in this template. Templates must be authored in After ' +
    'Effects with text layers exposed as Essential Graphics properties.');
  assert.strictEqual(t.$('setup-analyse').disabled, true);
  assert.strictEqual(t.text('setup-analyse-reason'), 'This template has no editable text fields.');

  t.q('#review .vf-load-doc').click();
  await waitFor(function () { return t.rows().length === 18; }, 'the loaded rows');
  t.q('#review .vf-review-insert').click();
  await tick();
  assert.strictEqual(t.q('#insert .vf-insert-error').textContent,
    'This template has no editable text fields.');
  assert.strictEqual(t.guard.count('bridge.call:insertCues'), 0);
  assert.deepStrictEqual(host.fake.undoLog.filter(function (e) {
    return e.name === 'VerseSync: Insert scriptures';
  }), []);
  await t.settled();
});

test('one importMGT fails mid-batch: it is reported, the rest land, and the undo log is one pair',
  async function () {
    var host = hostWorld();
    var files = fakeFs();
    files.files[SAVED] = JSON.stringify(savedDocument());
    files.openAnswers.push(SAVED);
    var t = await build({ bridge: host.bridge, fs: files });
    await t.prepare();
    t.q('#review .vf-load-doc').click();
    await waitFor(function () { return t.rows().length === 18; }, 'the loaded rows');

    var real = host.seq.importMGT;
    var calls = 0;
    host.seq.importMGT = function () {
      calls += 1;
      if (calls === 7) { return null; }
      return real.apply(host.seq, arguments);
    };
    host.fake.undoLog.length = 0;

    t.q('#review .vf-review-insert').click();
    await waitFor(function () { return t.q('#insert .vf-insert-summary'); }, 'the summary');

    assert.strictEqual(calls, 18, 'the batch continued past the failure');
    assert.strictEqual(host.seq.videoTracks[3].clips.length, 17);
    assert.strictEqual(t.q('#insert .vf-insert-summary').textContent,
      'Placed 17 of 18 \u2014 1 failed, see details. Ctrl+Z removes the graphics one at a time.');
    var hostSaid = host.answers.filter(function (a) { return a.name === 'insertCues'; })[0].res.data;
    assert.strictEqual(hostSaid.failedCount, 1);
    var failed = hostSaid.results.filter(function (r) { return !r.ok; })[0];
    var items = t.doc.querySelectorAll('#insert .vf-insert-failure');
    assert.strictEqual(items.length, 1);
    assert.ok(items[0].textContent.indexOf(' \u2014 ' + failed.error) > 0);
    assert.deepStrictEqual(host.fake.undoLog, [
      { type: 'begin', name: 'VerseSync: Insert scriptures' },
      { type: 'end' }
    ]);
    assert.strictEqual(host.fake.openUndoGroups(), 0);
    await t.settled();
  });

// ---- the never-settling audit ---------------------------------------------------------------

test('the watchdog catches a call that never settles, and a spinner left showing', async function () {
  var hung = fakeClient(fixture('happy-18-cues.json'));
  hung.startJob = function () { return new Promise(function () {}); };
  var t = await build({ client: hung, watchdogMs: 60 });
  await t.prepare();
  t.$('setup-analyse').click();
  await new Promise(function (r) { setTimeout(r, 150); });

  assert.deepStrictEqual(t.guard.violations, ['client.startJob did not settle within 60 ms']);
  assert.strictEqual(t.guard.pending, 1);
  assert.deepStrictEqual(spinners(t.doc), ['the progress view is showing']);
});

// A server that takes the connection and then says nothing. `frozen` picks what it ignores.
function silentSidecar(c, frozen) {
  return new Promise(function (resolve) {
    var server = http.createServer(function (req, res) {
      if (req.method === 'GET' && req.url === '/translations') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ provider: 'fake', translations: TRANSLATIONS }));
      } else if (req.method === 'POST' && req.url === '/jobs' && !frozen.start) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ job_id: 'job_1', cache_hit: false }));
      } else if (/\/events$/.test(req.url) && !frozen.start) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(': connected\n\n');
      }
      // everything else is never answered
    });
    server.listen(0, '127.0.0.1', function () {
      c.after(function () { server.closeAllConnections(); server.close(); });
      resolve(server.address().port);
    });
  });
}

[
  ['POST /jobs is never answered', { start: true }],
  ['the event stream and GET /jobs/{id} both go silent', { start: false }]
].forEach(function (row) {
  test('a frozen sidecar ends in an error, not a spinner (' + row[0] + ')', async function (c) {
    var port = await silentSidecar(c, row[1]);
    var transport = Sidecar.createNodeTransport(http, { requestTimeoutMs: 150, streamIdleMs: 150 });
    var client = Sidecar.VSSidecarClient.create({ transport: transport, port: port, token: 'x' });
    var t = await build({ client: client, transport: transport, pollMs: 20 });
    await t.prepare('kjv-id');
    t.$('setup-analyse').click();

    await waitFor(function () { return failure(t); }, 'the failure');
    assert.strictEqual(failure(t).message, 'The VerseSync sidecar is not responding.');
    assert.ok(failure(t).retry);
    await t.settled();
  });
});

test('a client call that rejects ends the analysis with the error, in every phase', async function () {
  var phases = ['startJob', 'job', 'result'];
  for (var i = 0; i < phases.length; i++) {
    var client = fakeClient(fixture('happy-18-cues.json'));
    client[phases[i]] = function () { return Promise.reject(new Error('boom')); };
    var t = await build({ client: client, pollMs: 5 });
    await t.prepare();
    t.$('setup-analyse').click();
    await waitFor(function () { return failure(t); }, 'the failure after ' + phases[i] + ' rejects');
    assert.ok(/boom/.test(failure(t).message), phases[i] + ': ' + failure(t).message);
    assert.ok(failure(t).retry);
    await t.settled();
  }
});

test('a bridge call that rejects ends the analysis, setup and Insert with the error', async function () {
  // Setup: a rejecting host leaves Analyse disabled instead of leaving setup half-built.
  var broken = stubBridge();
  broken.call = function () { return Promise.reject(new Error('host gone')); };
  var t = await build({ bridge: broken });
  assert.strictEqual(t.$('setup-analyse').disabled, true);
  assert.strictEqual(t.text('setup-analyse-reason'), 'Open a sequence in Premiere first.');
  await t.settled();

  // Analyse: the host rejects between the job and the placement.
  var host = stubBridge();
  var real = host.call;
  var mode = { reject: false };
  host.call = function (name, args) {
    return mode.reject && name === 'getMediaSegments' ?
      Promise.reject(new Error('host gone')) : real(name, args);
  };
  t = await build({ bridge: host });
  await t.prepare();
  mode.reject = true;
  t.$('setup-analyse').click();
  await waitFor(function () { return failure(t); }, 'the failure');
  assert.strictEqual(failure(t).message, 'Unexpected error: host gone');
  await t.settled();

  // Insert: the host rejects mid-click; the controls come back.
  mode.reject = false;
  t.app.session = null;
  t.$('setup-analyse').click();
  await waitFor(function () { return t.rows().length === 18; }, 'the rows');
  host.call = function (name, args) {
    return name === 'insertCues' ? Promise.reject(new Error('host gone')) : real(name, args);
  };
  t.q('#review .vf-review-insert').click();
  await waitFor(function () { return t.q('#insert .vf-insert-error'); }, 'the insert error');
  assert.strictEqual(t.q('#insert .vf-insert-error').textContent, 'Unexpected error: host gone');
  assert.strictEqual(t.q('#review .vf-review-insert').disabled, false);
  assert.strictEqual(t.$('setup-analyse').disabled, false);
  await t.settled();
});

test('a row edit and a text retry that reject unlock their controls', async function () {
  var client = fakeClient(fixture('flagged.json'));
  var t = await build({ client: client });
  await t.prepare();
  t.$('setup-analyse').click();
  await waitFor(function () { return t.rows().length === 12; }, 'the rows');
  client.resolve = function () { return Promise.reject(new Error('provider crashed')); };

  t.q('#review .vf-review-retry-text').click();
  await waitFor(function () { return !t.q('#review .vf-review-retry-text').disabled; }, 'the retry to finish');
  assert.strictEqual(t.q('#review .vf-review-message').textContent, 'Unexpected error: provider crashed');

  t.q('#review .vf-review-add').click();
  t.q('#review .vf-review-add-input').value = 'John 3:16';
  t.q('#review .vf-review-add-go').click();
  await waitFor(function () { return !t.q('#review .vf-review-add-go').disabled; }, 'Add to finish');
  assert.strictEqual(t.q('#review .vf-review-add-error').textContent, 'Unexpected error: provider crashed');
  await t.settled();
});

test('every new Promise in panel/js is one of the reviewed three', function () {
  // Each of these settles by construction: bridge.evalRaw when CSInterface calls back (it has
  // no timeout on purpose, see docs/qa/error-reproduction.md), sidecar request() through its
  // single-shot finish() and the transport timeout, and the sleep timer. A new one needs the
  // same review, so add it here only with its terminal path.
  var counts = {};
  fs.readdirSync(path.join(panel, 'js')).forEach(function (name) {
    if (!/\.js$/.test(name)) { return; }
    var source = fs.readFileSync(path.join(panel, 'js', name), 'utf8');
    var n = (source.match(/new Promise\(/g) || []).length;
    if (n > 0) { counts[name] = n; }
  });
  assert.deepStrictEqual(counts, { 'bridge.js': 1, 'sidecar.js': 2 });
});
