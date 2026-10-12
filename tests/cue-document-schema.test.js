'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var validateCueDocument = require('./lib/validate-cue-document');

var FIXTURES_DIR = path.join(__dirname, 'fixtures', 'cue-documents');
var FIXTURES = ['happy-18-cues.json', 'flagged.json', 'alternatives.json', 'empty.json'];

FIXTURES.forEach(function (name) {
  test('fixture validates: ' + name, function () {
    var errors = validateCueDocument.validateFile(path.join(FIXTURES_DIR, name));
    assert.deepStrictEqual(errors, []);
  });
});

test('pattern P13 is accepted and an unknown pattern is rejected', function () {
  var document = JSON.parse(
    fs.readFileSync(path.join(FIXTURES_DIR, 'happy-18-cues.json'), 'utf8')
  );
  document.cues[0].detection.pattern = 'P13';
  assert.deepStrictEqual(validateCueDocument.validate(document), []);

  document.cues[0].detection.pattern = 'P14';
  assert.ok(validateCueDocument.validate(document).some(function (e) { return e.indexOf('pattern') !== -1; }));
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
