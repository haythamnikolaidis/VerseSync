'use strict';

// Drives panel/index.html in headless Chromium against the host stub and tools/mock_sidecar.py.
// Covers the Setup panel, status strip and progress view (T-27) end to end, including that
// settings survive closing and reopening the browser profile.
//
// This needs Playwright and a Chromium, neither of which is an npm dependency of the repo.
// The test locates them via PLAYWRIGHT_NODE_PATH (a directory holding node_modules/playwright)
// and PLAYWRIGHT_BROWSERS_PATH, and skips with a reason when they are missing, so CI stays
// green without a browser.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var os = require('node:os');
var path = require('node:path');
var childProcess = require('node:child_process');

var MOCK = path.join(__dirname, '..', 'tools', 'mock_sidecar.py');
var PANEL = path.join(__dirname, '..', 'panel', 'index.html');
var PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
var MOGRT = 'D:/Templates/AV_Quote_04.mogrt';
var MEDIA = 'D:/Sermons/SERMON_A001.MXF';

function loadPlaywright() {
  var candidates = ['playwright'];
  if (process.env.PLAYWRIGHT_NODE_PATH) {
    candidates.unshift(path.join(process.env.PLAYWRIGHT_NODE_PATH, 'node_modules', 'playwright'));
  }
  candidates.push('/opt/node-tools/node_modules/playwright');
  for (var i = 0; i < candidates.length; i++) {
    try { return require(candidates[i]); } catch (e) { /* try the next */ }
  }
  return null;
}

var pw = loadPlaywright();
var HAVE_PY = childProcess.spawnSync(PYTHON, ['--version']).status === 0;
var SKIP = !pw ? 'Playwright is not installed' : (!HAVE_PY ? 'python interpreter not available' : false);
var browserOk = null;

var children = [];
var tmpDirs = [];

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function startMock(flags) {
  return new Promise(function (resolve, reject) {
    var child = childProcess.spawn(PYTHON, [MOCK, '--port', '0', '--no-lock-file'].concat(flags || []), {
      stdio: ['ignore', 'pipe', 'ignore']
    });
    children.push(child);
    var out = '';
    child.stdout.on('data', function (d) {
      out += d;
      var port = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      var token = /token: (\S+)/.exec(out);
      if (port && token) { resolve({ port: port[1], token: token[1], child: child }); }
    });
    child.on('error', reject);
    setTimeout(function () { reject(new Error('mock sidecar did not start')); }, 15000);
  });
}

// The panel runs from file://; the browser would block its calls to the mock for lack of CORS
// headers (CEP does not). Relay them through Node and add the headers. SSE is refused so the
// panel exercises its polling fallback, which is also what a reload mid-job uses.
function relay(context) {
  var cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': '*',
    'access-control-expose-headers': '*'
  };
  return context.route(/^http:\/\/127\.0\.0\.1:\d+\//, function (route) {
    var req = route.request();
    if (/\/events$/.test(req.url())) { return route.abort(); }
    if (req.method() === 'OPTIONS') { return route.fulfill({ status: 204, headers: cors }); }
    var headers = { Origin: 'file://' };
    var h = req.headers();
    if (h.authorization) { headers.Authorization = h.authorization; }
    if (h['content-type']) { headers['Content-Type'] = h['content-type']; }
    return fetch(req.url(), { method: req.method(), headers: headers, body: req.postData() || undefined })
      .then(function (res) {
        return res.arrayBuffer().then(function (buf) {
          var out = Object.assign({}, cors);
          out['content-type'] = res.headers.get('content-type') || 'application/json';
          return route.fulfill({ status: res.status, headers: out, body: Buffer.from(buf) });
        });
      });
  });
}

async function openPanel(profileDir, query) {
  var context = await pw.chromium.launchPersistentContext(profileDir, {
    headless: true,
    viewport: { width: 420, height: 900 }
  });
  await relay(context);
  // The panel's file dialog is window.cep.fs.showOpenDialog; hand back whatever the test queues.
  await context.addInitScript(function () {
    window.__picks = [];
    window.cep = { fs: { showOpenDialog: function () {
      var next = window.__picks.shift();
      return next ? { err: 0, data: [next] } : { err: 0, data: [] };
    } } };
  });
  var page = await context.newPage();
  var errors = [];
  page.on('pageerror', function (e) { errors.push(String(e)); });
  await page.goto('file://' + PANEL + '?stub=1' + (query || ''));
  return { context: context, page: page, errors: errors };
}

function profile() {
  var d = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-ui-'));
  tmpDirs.push(d);
  return d;
}

async function pick(page, selector, file) {
  await page.evaluate(function (f) { window.__picks.push(f); }, file);
  await page.click(selector);
}

function sidecarQuery(m) { return '&sidecarPort=' + m.port + '&sidecarToken=' + encodeURIComponent(m.token); }

async function text(page, sel) { return (await page.textContent(sel)).trim(); }

test.after(function () {
  children.forEach(function (c) { try { c.kill('SIGKILL'); } catch (e) { /* gone */ } });
  tmpDirs.forEach(function (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* best effort */ } });
});

test('chromium is available', { skip: SKIP }, async function (t) {
  try {
    var b = await pw.chromium.launch({ headless: true });
    await b.close();
    browserOk = true;
  } catch (e) {
    browserOk = false;
    t.skip('no usable Chromium: ' + String(e.message).split('\n')[0]);
  }
});

function ui(name, fn) {
  test(name, { skip: SKIP }, async function (t) {
    if (browserOk === false) { t.skip('no usable Chromium'); return; }
    await fn(t);
  });
}

ui('setup flow: reasons, smart defaults, duplicate mapping, enablement, restart persistence', async function () {
  var mock = await startMock(['--duration', '6']);
  var dir = profile();
  var s = await openPanel(dir, sidecarQuery(mock));
  var page = s.page;
  try {
    await page.waitForFunction(function () {
      return /ready/.test(document.getElementById('sidecar-status').textContent);
    });
    await page.waitForFunction(function () {
      return document.getElementById('sel-translation').options.length > 1;
    });

    // Disabled with a visible reason at every step.
    assert.strictEqual(await page.isDisabled('#btn-analyse'), true);
    assert.match(await text(page, '#analyse-reason'), /Select a media file/);

    await pick(page, '#btn-media', MEDIA);
    assert.strictEqual(await text(page, '#media-name'), 'SERMON_A001.MXF');
    assert.match(await text(page, '#analyse-reason'), /Select a template/);

    await pick(page, '#btn-mogrt', MOGRT);
    await page.waitForFunction(function () {
      return document.getElementById('sel-ref').value !== '';
    });
    // Smart defaults for AV_Quote_04: Description -> reference, Title Main -> scripture.
    assert.strictEqual(await page.inputValue('#sel-ref'), '11');
    assert.strictEqual(await page.inputValue('#sel-body'), '3');
    var labels = await page.$$eval('#sel-ref option', function (o) { return o.map(function (x) { return x.textContent; }); });
    assert.ok(labels.indexOf('Description > Text') !== -1 && labels.indexOf('Title Main > Text') !== -1);
    assert.match(await text(page, '#analyse-reason'), /Choose a translation/);

    // Translation attribution appears beneath the selector.
    await page.selectOption('#sel-translation', { label: 'King James Version (KJV)' });
    assert.strictEqual(await text(page, '#translation-attr'), 'Public domain.');
    await page.selectOption('#sel-translation', { label: 'English Standard Version (ESV)' });
    assert.match(await text(page, '#translation-attr'), /Crossway/);
    await page.selectOption('#sel-translation', { label: 'King James Version (KJV)' });

    // Tracks are V-high to V-low, topmost default (sequence-2997 has 4 video tracks).
    var tracks = await page.$$eval('#sel-track option', function (o) { return o.map(function (x) { return x.textContent; }); });
    assert.deepStrictEqual(tracks.slice(1), ['V4', 'V3', 'V2', 'V1']);
    assert.strictEqual(await page.inputValue('#sel-track'), '3');

    // Everything satisfied: enabled, no reason.
    assert.strictEqual(await page.isDisabled('#btn-analyse'), false);
    assert.strictEqual(await page.isHidden('#analyse-reason'), true);

    // The same field for both slots is rejected.
    await page.selectOption('#sel-body', '11');
    assert.strictEqual(await page.isDisabled('#btn-analyse'), true);
    assert.match(await text(page, '#mapping-error'), /different fields/);
    assert.match(await text(page, '#analyse-reason'), /different fields/);

    // Swap to a valid, non-default mapping; it must come back after a restart.
    await page.selectOption('#sel-ref', '3');
    await page.selectOption('#sel-body', '11');
    assert.strictEqual(await page.isDisabled('#btn-analyse'), false);

    await page.selectOption('#sel-track', '1');
    await page.check('#dur-fixed');
    await page.fill('#input-fixed', '7');
    await page.fill('#input-leadin', '1.5');

    // Out-of-range lead-in blocks Analyse with a reason and is not remembered.
    await page.fill('#input-leadin', '9');
    assert.strictEqual(await page.isDisabled('#btn-analyse'), true);
    assert.match(await text(page, '#analyse-reason'), /Lead-in/);
    await page.fill('#input-leadin', '1.5');
    assert.strictEqual(await page.isDisabled('#btn-analyse'), false);
    assert.deepStrictEqual(s.errors, []);
  } finally {
    await s.context.close();
  }

  // Restart: same browser profile, fresh page.
  var again = await openPanel(dir, sidecarQuery(mock));
  var p2 = again.page;
  try {
    await p2.waitForFunction(function () {
      return document.getElementById('sel-ref').value !== '' &&
        document.getElementById('sel-translation').value !== '';
    });
    assert.strictEqual(await text(p2, '#mogrt-name'), 'AV_Quote_04.mogrt');
    assert.strictEqual(await p2.inputValue('#sel-ref'), '3', 'per-template mapping restored');
    assert.strictEqual(await p2.inputValue('#sel-body'), '11');
    assert.strictEqual(await p2.inputValue('#sel-translation'), 'de4e12af7f28f599-02');
    assert.strictEqual(await p2.inputValue('#sel-track'), '1');
    assert.strictEqual(await p2.isChecked('#dur-fixed'), true);
    assert.strictEqual(await p2.inputValue('#input-fixed'), '7');
    assert.strictEqual(await p2.inputValue('#input-leadin'), '1.5');
    // Only the media file is forgotten.
    assert.strictEqual(await text(p2, '#media-name'), 'No media selected');
    assert.match(await text(p2, '#analyse-reason'), /Select a media file/);
    assert.deepStrictEqual(again.errors, []);
  } finally {
    await again.context.close();
  }
});

ui('a template with no mapping history gets smart defaults; two templates keep separate mappings', async function () {
  var mock = await startMock([]);
  var s = await openPanel(profile(), sidecarQuery(mock));
  var page = s.page;
  try {
    await page.waitForFunction(function () { return /ready/.test(document.getElementById('sidecar-status').textContent); });
    await pick(page, '#btn-media', MEDIA);
    await pick(page, '#btn-mogrt', MOGRT);
    await page.waitForFunction(function () { return document.getElementById('sel-ref').value === '11'; });
    await page.selectOption('#sel-ref', '3');
    await page.selectOption('#sel-body', '11');
    // A different path (the stub only serves AV_Quote_04, so it reports an unreadable template).
    await pick(page, '#btn-mogrt', 'D:/Other/Other.mogrt');
    await page.waitForFunction(function () { return /could not/i.test(document.getElementById('mogrt-warning').textContent); });
    assert.match(await text(page, '#analyse-reason'), /could not be read/);
    // Back to the first: its own mapping returns, not the defaults.
    await pick(page, '#btn-mogrt', MOGRT);
    await page.waitForFunction(function () { return document.getElementById('sel-ref').value !== ''; });
    assert.strictEqual(await page.inputValue('#sel-ref'), '3');
    assert.strictEqual(await page.inputValue('#sel-body'), '11');
  } finally {
    await s.context.close();
  }
});

ui('status strip and reasons: no sequence, and service unavailable (insert path untouched)', async function () {
  var mock = await startMock([]);
  var s = await openPanel(profile(), '&hostSequence=sequence-none' + sidecarQuery(mock));
  try {
    await s.page.waitForFunction(function () { return /no sequence open/.test(document.getElementById('sidecar-status').textContent); });
    assert.match(await text(s.page, '#analyse-reason'), /Open a sequence/);
    assert.strictEqual(await s.page.isDisabled('#btn-analyse'), true);
  } finally {
    await s.context.close();
  }

  var down = await openPanel(profile(), '');
  try {
    await down.page.waitForFunction(function () { return /unavailable/.test(document.getElementById('sidecar-status').textContent); });
    assert.match(await text(down.page, '#analyse-reason'), /unavailable/);
    assert.strictEqual(await down.page.isDisabled('#sel-translation'), true);
  } finally {
    await down.context.close();
  }
});

async function readyForAnalyse(page) {
  await page.waitForFunction(function () {
    var sel = document.getElementById('sel-translation');
    return /ready/.test(document.getElementById('sidecar-status').textContent) && sel.options.length > 1;
  });
  await pick(page, '#btn-media', MEDIA);
  await pick(page, '#btn-mogrt', MOGRT);
  await page.waitForFunction(function () { return document.getElementById('sel-ref').value !== ''; });
  await page.selectOption('#sel-translation', { label: 'King James Version (KJV)' });
  assert.strictEqual(await page.isDisabled('#btn-analyse'), false);
}

ui('cold run: setup collapses, bar and phase advance, ETA after 10%, cancel, then completes', async function () {
  var mock = await startMock(['--duration', '10']);
  var s = await openPanel(profile(), sidecarQuery(mock));
  var page = s.page;
  try {
    await readyForAnalyse(page);
    await page.click('#btn-analyse');

    await page.waitForSelector('#progress-section:not([hidden])');
    assert.strictEqual(await page.isVisible('#setup-summary'), true);
    assert.strictEqual(await page.isVisible('#setup-body'), false);
    assert.match(await text(page, '#setup-summary'), /SERMON_A001\.MXF.*AV_Quote_04.*KJV.*V4.*Auto/);
    assert.ok(!/cached/i.test(await text(page, '#progress-label')));

    // ETA and elapsed appear once past 10%.
    await page.waitForFunction(function () {
      return /elapsed \d+:\d\d/.test(document.getElementById('progress-time').textContent);
    }, null, { timeout: 15000 });
    var pct = parseInt(await text(page, '#progress-pct'), 10);
    assert.ok(pct >= 10 && pct < 100, 'percent ' + pct);
    assert.match(await text(page, '#progress-time'), /left/);
    assert.match(await text(page, '#progress-label'), /Transcribing/);

    // Cancel returns to an editable setup.
    await page.click('#btn-cancel');
    await page.waitForSelector('#progress-section', { state: 'hidden' });
    assert.strictEqual(await page.isVisible('#setup-body'), true);
    assert.strictEqual(await page.isHidden('#job-error'), true);
    assert.strictEqual(await page.isDisabled('#btn-analyse'), false);

    // A second run goes the distance.
    await page.click('#btn-analyse');
    await page.waitForSelector('#progress-section:not([hidden])');
    await page.waitForSelector('#progress-section', { state: 'hidden', timeout: 30000 });
    assert.match(await text(page, '#review-area'), /scriptures? found/);
    assert.strictEqual(await page.isVisible('#setup-summary'), true, 'setup stays collapsed after a job');
    await page.click('#setup-summary');
    assert.strictEqual(await page.isVisible('#setup-body'), true);
    assert.deepStrictEqual(s.errors, []);
  } finally {
    await s.context.close();
  }
});

ui('cache hit: announced, styled differently, and races to the end', async function () {
  var mock = await startMock(['--cache-hit']);
  var s = await openPanel(profile(), sidecarQuery(mock));
  var page = s.page;
  try {
    await readyForAnalyse(page);
    var started = Date.now();
    await page.click('#btn-analyse');
    await page.waitForSelector('#progress-section:not([hidden])');
    assert.match(await text(page, '#progress-label'), /^Using cached transcript/);
    assert.match(await page.getAttribute('#progress-section', 'class'), /vs-progress--cached/);
    await page.waitForSelector('#progress-section', { state: 'hidden', timeout: 15000 });
    assert.ok(Date.now() - started < 12000, 'a cache hit finishes in seconds');
  } finally {
    await s.context.close();
  }
});

ui('a failed job shows the sidecar message and hint with Retry, and reopens setup', async function () {
  var mock = await startMock(['--fail', 'model_load_failed']);
  var s = await openPanel(profile(), sidecarQuery(mock));
  var page = s.page;
  try {
    await readyForAnalyse(page);
    await page.click('#btn-analyse');
    await page.waitForSelector('#job-error:not([hidden])', { timeout: 15000 });
    assert.match(await text(page, '#job-error-message'), /Could not load/);
    assert.strictEqual(await page.isVisible('#btn-retry'), true);
    assert.strictEqual(await page.isVisible('#setup-body'), true);
  } finally {
    await s.context.close();
  }
});

ui('a panel reload rejoins a running job', async function () {
  var mock = await startMock(['--duration', '12']);
  var dir = profile();
  var s = await openPanel(dir, sidecarQuery(mock));
  try {
    await readyForAnalyse(s.page);
    await s.page.click('#btn-analyse');
    await s.page.waitForSelector('#progress-section:not([hidden])');
    await sleep(1500);
  } finally {
    await s.context.close();
  }
  var again = await openPanel(dir, sidecarQuery(mock));
  try {
    await again.page.waitForSelector('#progress-section:not([hidden])', { timeout: 15000 });
    assert.strictEqual(await again.page.isVisible('#setup-summary'), true);
  } finally {
    await again.context.close();
  }
});
