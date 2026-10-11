'use strict';

// Validates a Cue Document against schemas/cue-document.schema.json (T-37).
// Test tooling only — never loaded by the panel.

var fs = require('node:fs');
var path = require('node:path');
var Ajv2020 = require('ajv/dist/2020');

var SCHEMA_PATH = path.join(__dirname, '..', '..', 'schemas', 'cue-document.schema.json');

var ajv = new Ajv2020({ allErrors: true });
// Annotation-only, like the Python (jsonschema) side: "format" is not enforced here either.
ajv.addFormat('date-time', true);
var schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
var validateFn = ajv.compile(schema);

function validate(document) {
  var valid = validateFn(document);
  if (valid) {
    return [];
  }
  return (validateFn.errors || []).map(function (e) {
    return (e.instancePath || '<root>') + ': ' + e.message;
  });
}

function validateFile(filePath) {
  var document = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return validate(document);
}

module.exports = { validate: validate, validateFile: validateFile };
