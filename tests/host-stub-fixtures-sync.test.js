'use strict';

// host-stub.js inlines its fixture data (see the comment at the top of that file for why —
// fetch() of a local JSON file from a file:// page is unreliable in Chrome). This test is
// what keeps that inline copy honest against the committed tests/fixtures/host/*.json, which
// remain the documented source of truth.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var VS = require('../panel/js/lib/host-stub');

var FIXTURES_DIR = path.join(__dirname, 'fixtures', 'host');

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name + '.json'), 'utf8'));
}

var SEQUENCE_NAMES = ['sequence-2997', 'sequence-23976', 'sequence-25', 'sequence-none'];
var SEGMENTS_NAMES = [
  'segments-single', 'segments-split', 'segments-duplicate', 'segments-speed', 'segments-none'
];

SEQUENCE_NAMES.forEach(function (name) {
  test('getSequenceInfo scenario "' + name + '" matches tests/fixtures/host/' + name + '.json', function () {
    VS.__setScenario({ sequence: name });
    var response = JSON.parse(VS.getSequenceInfo('{}'));
    assert.deepStrictEqual(response, { ok: true, data: readFixture(name) });
  });
});

SEGMENTS_NAMES.forEach(function (name) {
  test('getMediaSegments scenario "' + name + '" matches tests/fixtures/host/' + name + '.json', function () {
    VS.__setScenario({ sequence: 'sequence-2997', segments: name });
    var response = JSON.parse(VS.getMediaSegments('{}'));
    assert.deepStrictEqual(response, { ok: true, data: readFixture(name) });
  });
});

test('getMogrtFields success matches tests/fixtures/host/mogrt-fields.json', function () {
  VS.__setScenario({ sequence: 'sequence-2997' });
  var response = JSON.parse(VS.getMogrtFields('{"path":"D:/Templates/AV_Quote_04.mogrt"}'));
  assert.deepStrictEqual(response, { ok: true, data: readFixture('mogrt-fields') });
});
