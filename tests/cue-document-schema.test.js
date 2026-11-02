'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var validateCueDocument = require('./lib/validate-cue-document');

var FIXTURES_DIR = path.join(__dirname, 'fixtures', 'cue-documents');
var FIXTURES = ['happy-18-cues.json', 'flagged.json', 'alternatives.json', 'empty.json', 'export.json'];

FIXTURES.forEach(function (name) {
  test('fixture validates: ' + name, function () {
    var errors = validateCueDocument.validateFile(path.join(FIXTURES_DIR, name));
    assert.deepStrictEqual(errors, []);
  });
});

test('a corrupted copy fails with a useful message', function () {
  var document = JSON.parse(
    fs.readFileSync(path.join(FIXTURES_DIR, 'happy-18-cues.json'), 'utf8')
  );
  document.cues[0].classification = 'not_a_real_classification';
  delete document.cues[1].reference.chapter;
  document.schema_version = '2.0';

  var errors = validateCueDocument.validate(document);
  assert.ok(errors.length >= 3);
  assert.ok(errors.some(function (e) { return e.indexOf('classification') !== -1; }));
  assert.ok(errors.some(function (e) { return e.indexOf('chapter') !== -1; }));
  assert.ok(errors.some(function (e) { return e.indexOf('schema_version') !== -1 || e === '<root>: must match "const" schema'; }));
});

// Cue Document 1.1 (docs/14-scripture-file-import.md §6). The same cases as
// SCHEMA_1_1_CASES in tests/test_cue_document_fixtures.py, so that Ajv and jsonschema agree.
var SHA256 = '446e9cba88e70ae980365ca2f69ad8a9bc07a8830bb8899f9e344867e923ebd7';
var PREFIXED = 'sha256:' + SHA256.slice(0, 57); // 64 characters long, but not all hex digits
var DOCUMENT_KEYS = ['schema_version', 'scripture_file', 'warnings'];
var NEW_FLAGS = ['not_in_export', 'not_found_in_audio', 'repeat_mention', 'repeat_read', 'out_of_order'];
var EXPORT_SOURCE = { kind: 'export', translation: 'NKJV', entry_index: 3 };
var PROVIDER_SOURCE = { kind: 'provider', translation: 'KJV' };
var FILE = { path: 'D:/Sermons/Scriptures.txt', sha256: SHA256, entry_count: 12 };
var INVALID = 'export_reference_invalid';
var UNREFERENCED = 'export_block_unreferenced';

function extend(base, extra) {
  var out = {};
  Object.keys(base).forEach(function (k) { out[k] = base[k]; });
  Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
  return out;
}

function warning(code, line) {
  var w = { code: code, message: 'm' };
  if (line !== undefined) { w.line = line; }
  return [w];
}

function document11(changes) {
  var doc = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'happy-18-cues.json'), 'utf8'));
  doc.schema_version = '1.1';
  Object.keys(changes).forEach(function (key) {
    var target = DOCUMENT_KEYS.indexOf(key) !== -1 ? doc : doc.cues[0];
    target[key] = changes[key];
  });
  return doc;
}

var CASES_1_1 = [
  ['version 1.0', { schema_version: '1.0' }, true],
  ['version 1.1', {}, true],
  ['version 1.2', { schema_version: '1.2' }, false],
  ['version 2.0', { schema_version: '2.0' }, false],
  ['export text_source', { text_source: EXPORT_SOURCE }, true],
  ['provider text_source', { text_source: PROVIDER_SOURCE }, true],
  ['export without entry_index', { text_source: { kind: 'export', translation: 'N' } }, false],
  ['provider with entry_index', { text_source: extend(PROVIDER_SOURCE, { entry_index: 0 }) }, false],
  ['text_source of another kind', { text_source: extend(EXPORT_SOURCE, { kind: 'api' }) }, false],
  ['text_source without translation', { text_source: { kind: 'provider' } }, false],
  ['negative entry_index', { text_source: extend(EXPORT_SOURCE, { entry_index: -1 }) }, false],
  ['text_source with an extra key', { text_source: extend(EXPORT_SOURCE, { x: 1 }) }, false],
  ['verse_offsets_s', { verse_offsets_s: { '7': 27.2, '8': 33.6 } }, true],
  ['empty verse_offsets_s', { verse_offsets_s: {} }, true],
  ['verse_offsets_s key 0', { verse_offsets_s: { '0': 1.0 } }, false],
  ['verse_offsets_s key not a number', { verse_offsets_s: { seven: 1.0 } }, false],
  ['verse_offsets_s key with a leading zero', { verse_offsets_s: { '07': 1.0 } }, false],
  ['negative verse offset', { verse_offsets_s: { '7': -0.1 } }, false],
  ['verse offset not a number', { verse_offsets_s: { '7': '27.2' } }, false],
  ['scripture_file', { scripture_file: FILE }, true],
  ['scripture_file without sha256', { scripture_file: { path: 'p', entry_count: 1 } }, false],
  ['scripture_file sha256 prefixed', { scripture_file: extend(FILE, { sha256: PREFIXED }) }, false],
  ['scripture_file sha256 short', { scripture_file: extend(FILE, { sha256: SHA256.slice(0, 40) }) }, false],
  ['scripture_file with no entries', { scripture_file: extend(FILE, { entry_count: 0 }) }, false],
  ['scripture_file with an extra key', { scripture_file: extend(FILE, { x: 1 }) }, false],
  ['invalid-reference warning', { warnings: warning(INVALID, 17) }, true],
  ['unreferenced warning', { warnings: warning(UNREFERENCED, 1) }, true],
  ['invalid-reference warning, no line', { warnings: warning(INVALID) }, false],
  ['unreferenced warning, no line', { warnings: warning(UNREFERENCED) }, false],
  ['warning line 0', { warnings: warning(INVALID, 0) }, false],
  ['other warning without a line', { warnings: warning('provider_partial') }, true],
  ['other warning with a line', { warnings: warning('provider_partial', 4) }, true]
].concat(NEW_FLAGS.map(function (flag) {
  return ['flag ' + flag, { flags: [flag] }, true];
})).concat([
  ['unknown flag', { flags: ['not_a_flag'] }, false]
]);

CASES_1_1.forEach(function (c) {
  test('schema 1.1: ' + c[0], function () {
    var errors = validateCueDocument.validate(document11(c[1]));
    assert.strictEqual(errors.length === 0, c[2], errors.join('; '));
  });
});
