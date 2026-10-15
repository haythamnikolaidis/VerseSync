'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadJsx } = require('../lib/load-jsx');

function writeTemp(name, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-jsx-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
}

test('loadJsx evaluates a script that sees app and $ but no native JSON', () => {
  const fake = { app: { project: { name: 'p' } }, $: { tag: 'dollar' } };
  const file = writeTemp('trivial.jsx', [
    'var VS = {};',
    'VS.projectName = app.project.name;',
    'VS.dollar = $.tag;',
    'VS.jsonType = typeof JSON;',
    'VS.hasEvent = typeof CSXSEvent;',
    'VS.hasFile = typeof File;'
  ].join('\n'));
  const loaded = loadJsx(file, fake);
  assert.strictEqual(loaded.VS.projectName, 'p');
  assert.strictEqual(loaded.VS.dollar, 'dollar');
  assert.strictEqual(loaded.VS.jsonType, 'undefined');
  assert.strictEqual(loaded.VS.hasEvent, 'function');
  assert.strictEqual(loaded.VS.hasFile, 'function');
  assert.ok(loaded.context);
});

test('loadJsx rejects non-ASCII source with a clear error', () => {
  const file = writeTemp('bad.jsx', 'var a = 1;\nvar b = "café";\n');
  assert.throws(() => loadJsx(file, { app: {}, $: {} }), /ASCII only.*U\+00E9.*line 2/);
});
