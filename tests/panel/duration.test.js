'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var vm = require('node:vm');

var root = path.join(__dirname, '..', '..');
var VSDuration = require(path.join(root, 'panel', 'js', 'duration.js'));

// The VerseFlow original is a browser script that assigns window.VFDuration; run it in a sandbox.
function loadVerseFlow() {
  var sandbox = { window: {} };
  var source = fs.readFileSync(path.join(root, 'reference', 'verseflow', 'js', 'duration.js'), 'utf8');
  vm.runInNewContext(source, sandbox);
  return sandbox.window.VFDuration;
}

var WORD_COUNTS = [0, 5, 10, 25, 40, 200];
var EXPECTED_AUTO_SECONDS = [3, 3.4, 5.3, 10.9, 16.5, 20];

test('constants match VerseFlow', function () {
  var vf = loadVerseFlow();
  ['READING_WPM', 'ANIMATION_PAD_S', 'MIN_DURATION_S', 'MAX_DURATION_S', 'TICKS_PER_SECOND'].forEach(function (k) {
    assert.strictEqual(VSDuration[k], vf[k], k);
  });
});

test('resolveDurationSeconds matches VerseFlow for six word counts', function () {
  var vf = loadVerseFlow();
  WORD_COUNTS.forEach(function (wordCount, i) {
    var scripture = { wordCount: wordCount };
    var got = VSDuration.resolveDurationSeconds(scripture, null);
    assert.strictEqual(got, vf.resolveDurationSeconds(scripture, null), 'wordCount ' + wordCount);
    assert.strictEqual(got, EXPECTED_AUTO_SECONDS[i], 'wordCount ' + wordCount);
  });
});

test('fixed override wins over the reading-speed model, as in VerseFlow', function () {
  var vf = loadVerseFlow();
  [0, 1.5, 7, 45].forEach(function (override) {
    assert.strictEqual(VSDuration.resolveDurationSeconds({ wordCount: 40 }, override), override);
    assert.strictEqual(vf.resolveDurationSeconds({ wordCount: 40 }, override), override);
  });
  assert.strictEqual(VSDuration.resolveDurationSeconds({ wordCount: 40 }, undefined), 16.5);
  assert.strictEqual(VSDuration.resolveDurationSeconds({ wordCount: 40 }, NaN), 16.5);
});

test('secondsToTicks and ticksToSeconds match VerseFlow', function () {
  var vf = loadVerseFlow();
  [0, 0.04, 3, 16.5, 20].forEach(function (s) {
    assert.strictEqual(VSDuration.secondsToTicks(s), vf.secondsToTicks(s));
    assert.strictEqual(typeof VSDuration.secondsToTicks(s), 'string');
    assert.strictEqual(VSDuration.ticksToSeconds(vf.secondsToTicks(s)), vf.ticksToSeconds(vf.secondsToTicks(s)));
  });
  assert.strictEqual(VSDuration.secondsToTicks(1), '254016000000');
});
