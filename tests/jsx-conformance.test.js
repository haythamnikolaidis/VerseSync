'use strict';

// Conformance of the ExtendScript host to docs/08-premiere-host-api.md section 1: one file,
// ES3, ASCII only, `var fn = function(){}` rather than declarations, no #include. The rules
// live in eslint.config.js (so `npm run lint` enforces them); this test runs that same
// config over the real host file, and over deliberately bad samples to prove each rule bites.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var ESLint = require('eslint').ESLint;

var ROOT = path.join(__dirname, '..');
var JSX_DIR = path.join(ROOT, 'panel', 'jsx');

var eslint = new ESLint({ cwd: ROOT });

function lintSample(code) {
  return eslint.lintText(code, { filePath: path.join(JSX_DIR, 'sample.jsx') }).then(function (results) {
    return results[0].messages;
  });
}

function ruleIds(messages) {
  return messages.map(function (m) { return m.ruleId || 'parse-error'; });
}

test('every host script in panel/jsx passes the ES3 / ASCII lint', async function () {
  var results = await eslint.lintFiles(['panel/jsx']);
  assert.ok(results.length >= 1, 'no host script was linted');
  results.forEach(function (r) {
    assert.deepStrictEqual(r.messages, [], r.filePath);
  });
});

test('the host is a single file: panel/jsx holds VerseSync.jsx only', function () {
  var files = fs.readdirSync(JSX_DIR).filter(function (f) { return /\.jsx$/.test(f); });
  assert.deepStrictEqual(files, ['VerseSync.jsx']);
});

test('the host file is pure ASCII and has no #include', function () {
  var buf = fs.readFileSync(path.join(JSX_DIR, 'VerseSync.jsx'));
  for (var i = 0; i < buf.length; i++) {
    assert.ok(buf[i] <= 0x7f, 'non-ASCII byte at offset ' + i);
  }
  var text = buf.toString('latin1');
  assert.ok(!/^\s*(#include|\/\/@include)/m.test(text), '#include is unreliable in Premiere 2026');
});

test('lint rejects a function declaration', async function () {
  var ids = ruleIds(await lintSample('var VS = {};\nfunction helper() { return 1; }\nVS.a = helper;\n'));
  assert.ok(ids.indexOf('no-restricted-syntax') >= 0, ids.join());
});

test('lint accepts the var-expression form', async function () {
  assert.deepStrictEqual(await lintSample('var helper = function () { return 1; };\nhelper();\n'), []);
});

test('lint rejects non-ASCII in code, strings and comments', async function () {
  var samples = [
    'var s = "café"; s;\n',
    '// em dash — here\nvar a = 1; a;\n',
    'var s = "“quoted”"; s;\n'
  ];
  for (var i = 0; i < samples.length; i++) {
    var ids = ruleIds(await lintSample(samples[i]));
    assert.ok(ids.indexOf('vs-host/ascii-only') >= 0, 'sample ' + i);
  }
});

test('lint accepts a \\u escape for non-ASCII text', async function () {
  assert.deepStrictEqual(await lintSample('var s = "a \\u2014 b"; s;\n'), []);
});

test('lint rejects syntax newer than ES3', async function () {
  var samples = [
    'var o = { a: 1, }; o;\n',                 // trailing comma in an object literal
    'var a = [1, 2,]; a;\n',                   // trailing comma in an array literal (length differs in ES3)
    'let x = 1; x;\n',
    'const y = 1; y;\n',
    'var f = () => 1; f;\n',
    'var t = `x`; t;\n',
    'var o = { get a() { return 1; } }; o;\n',
    'var o = {}; o.class = 1;\n'               // reserved word as a property name
  ];
  for (var i = 0; i < samples.length; i++) {
    var messages = await lintSample(samples[i]);
    assert.ok(messages.length > 0, 'sample ' + i + ' was accepted: ' + samples[i]);
  }
});

test('lint rejects ES5 library calls that parse but do not exist in ExtendScript', async function () {
  var samples = [
    'var a = [1]; a.forEach(function () {});\n',
    'var a = [1]; a.map(function (x) { return x; });\n',
    'var a = [1]; a.filter(function (x) { return x; });\n',
    'var s = " x "; s.trim();\n',
    'Object.keys({});\n',
    'Array.isArray([]);\n',
    'Date.now();\n',
    'var f = function () {}; f.bind(null);\n',
    'JSON.rawJSON("1");\n'
  ];
  for (var i = 0; i < samples.length; i++) {
    var ids = ruleIds(await lintSample(samples[i]));
    assert.ok(ids.indexOf('no-restricted-syntax') >= 0, 'sample ' + i + ' was accepted: ' + samples[i]);
  }
});

test('lint rejects use of an undefined global', async function () {
  var ids = ruleIds(await lintSample('var a = window.location; a;\n'));
  assert.ok(ids.indexOf('no-undef') >= 0, ids.join());
});
