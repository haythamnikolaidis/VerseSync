#!/usr/bin/env node
'use strict';

// Panel smoke harness (T-49): loads the real panel/index.html in headless Chromium in stub
// mode, fails on any console error or page error, and saves a screenshot per scenario.
//
//   npm run smoke
//   npm run smoke -- --scenario flagged --expect '#review .row' --count 18
//
// Options (all optional):
//   --scenario a,b   scenarios to load (default: happy,flagged,alternatives,empty)
//   --expect SEL     after load, require SEL to match at least one element
//   --count N        with the preceding --expect: require exactly N matches
//   --eval JS        run JS in the page after load (e.g. to click through a flow)
//   --timeout MS     per-scenario wait for #status and network idle (default 15000)
//   --out DIR        screenshot directory (default: artifacts/)
// --expect and --count may be repeated; each --count binds to the nearest --expect before it.
// Expectations and --eval apply to every scenario that is run, so narrow with --scenario.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ALL_SCENARIOS = ['happy', 'flagged', 'alternatives', 'empty'];
const BROWSERS_DIR = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.jsx': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

function parseArgs(argv) {
  const opts = { scenarios: ALL_SCENARIOS, expects: [], evals: [], timeout: 15000, out: path.join(ROOT, 'artifacts') };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) { throw new Error(flag + ' needs a value'); }
      i += 1;
      return argv[i];
    };
    if (flag === '--scenario') { opts.scenarios = value().split(',').filter(Boolean); }
    else if (flag === '--expect') { opts.expects.push({ selector: value(), count: null }); }
    else if (flag === '--count') {
      if (opts.expects.length === 0) { throw new Error('--count needs a preceding --expect'); }
      const n = Number(value());
      if (!Number.isInteger(n) || n < 0) { throw new Error('--count must be a non-negative integer'); }
      opts.expects[opts.expects.length - 1].count = n;
    }
    else if (flag === '--eval') { opts.evals.push(value()); }
    else if (flag === '--timeout') { opts.timeout = Number(value()); }
    else if (flag === '--out') { opts.out = path.resolve(value()); }
    else { throw new Error('unknown option ' + flag); }
  }
  opts.scenarios.forEach((s) => {
    if (ALL_SCENARIOS.indexOf(s) < 0) { throw new Error('unknown scenario ' + s); }
  });
  return opts;
}

// Static file server on the repo root, same-origin for the panel and the fixtures.
function startServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    const file = path.resolve(ROOT, '.' + urlPath);
    const inside = path.relative(ROOT, file);
    if (inside.startsWith('..') || path.isAbsolute(inside)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function findInstalledChromium() {
  let dirs = [];
  try { dirs = fs.readdirSync(BROWSERS_DIR).filter((d) => /^chromium-\d+$/.test(d)).sort(); } catch (e) { return null; }
  for (const dir of dirs) {
    const exe = path.join(BROWSERS_DIR, dir, 'chrome-linux', 'chrome');
    if (fs.existsSync(exe)) { return exe; }
  }
  return null;
}

async function launchBrowser() {
  const { chromium } = require('playwright-core');
  try {
    return await chromium.launch({ headless: true });
  } catch (firstError) {
    const exe = findInstalledChromium();
    if (!exe) { throw firstError; }
    return chromium.launch({ headless: true, executablePath: exe });
  }
}

async function runScenario(browser, base, scenario, opts) {
  const problems = [];
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  page.on('console', (msg) => {
    if (msg.type() === 'error') { problems.push('console.error: ' + msg.text()); }
  });
  page.on('pageerror', (err) => { problems.push('page error: ' + err.message); });
  page.on('requestfailed', (req) => {
    problems.push('request failed: ' + req.url() + ' (' + (req.failure() && req.failure().errorText) + ')');
  });
  try {
    await page.goto(base + '/panel/index.html?stub=1&scenario=' + scenario, { timeout: opts.timeout });
    await page.waitForSelector('#status', { state: 'attached', timeout: opts.timeout });
    await page.waitForLoadState('networkidle', { timeout: opts.timeout });
    for (const code of opts.evals) { await page.evaluate(code); }
    for (const exp of opts.expects) {
      const found = await page.locator(exp.selector).count();
      if (exp.count === null ? found < 1 : found !== exp.count) {
        problems.push('expected ' + (exp.count === null ? 'at least 1' : exp.count) + ' of "' +
          exp.selector + '", found ' + found);
      }
    }
    fs.mkdirSync(opts.out, { recursive: true });
    await page.screenshot({ path: path.join(opts.out, 'smoke-' + scenario + '.png'), fullPage: true });
  } catch (e) {
    problems.push('harness: ' + e.message);
  } finally {
    await page.close();
  }
  return problems;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const server = await startServer();
  const base = 'http://127.0.0.1:' + server.address().port;
  let browser = null;
  let failed = false;
  try {
    browser = await launchBrowser();
    for (const scenario of opts.scenarios) {
      const problems = await runScenario(browser, base, scenario, opts);
      if (problems.length === 0) {
        console.log('ok   ' + scenario + '  -> ' + path.join(opts.out, 'smoke-' + scenario + '.png'));
      } else {
        failed = true;
        console.log('FAIL ' + scenario);
        problems.forEach((p) => console.log('       ' + p));
      }
    }
  } finally {
    if (browser) { await browser.close(); }
    server.close();
  }
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error('smoke harness error: ' + e.message);
  process.exitCode = 1;
});
