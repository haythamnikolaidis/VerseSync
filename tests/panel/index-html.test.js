'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'panel', 'index.html'), 'utf8');
// Scripts are not run: jsdom's default runScripts is off.
const doc = new JSDOM(html).window.document;

test('every section container exists', () => {
  ['status', 'setup', 'progress', 'review', 'insert'].forEach((id) => {
    assert.ok(doc.getElementById(id), '#' + id + ' is missing');
  });
});

test('scripts load in the required order', () => {
  const srcs = Array.from(doc.querySelectorAll('script[src]')).map((s) => s.getAttribute('src'));
  assert.deepStrictEqual(srcs, [
    'js/lib/CSInterface.js',
    'js/lib/host-stub.js',
    'js/lib/sidecar-stub.js',
    'js/sidecar.js',
    'js/bridge.js',
    'js/state.js',
    'js/setup.js',
    'js/main.js'
  ]);
});

test('every referenced local asset except later-task scripts exists', () => {
  const panelDir = path.join(__dirname, '..', '..', 'panel');
  const later = ['js/bridge.js'];
  const refs = Array.from(doc.querySelectorAll('script[src], link[href]')).map((e) =>
    e.getAttribute('src') || e.getAttribute('href'));
  refs.filter((r) => later.indexOf(r) < 0).forEach((r) => {
    assert.ok(fs.existsSync(path.join(panelDir, r)), r + ' is missing');
  });
});
