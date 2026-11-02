'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var root = path.join(__dirname, '..', '..');
var VSTimemap = require(path.join(root, 'panel', 'js', 'timemap.js'));

function fixture(name) {
  return require(path.join(root, 'tests', 'fixtures', 'host', name));
}

var TPS = 254016000000;

// Real timebase values come from the T-39 fixtures where one exists. The others are derived the
// way Premiere does: ticks per second over the frame rate, with NTSC rates scaled by 1.001.
var RATES = [
  { rate: 23.976, timebase: fixture('sequence-23976.json').timebase },
  { rate: 24, timebase: String(TPS / 24) },
  { rate: 25, timebase: fixture('sequence-25.json').timebase },
  { rate: 29.97, timebase: fixture('sequence-2997.json').timebase },
  { rate: 30, timebase: String(TPS / 30) },
  { rate: 50, timebase: String(TPS / 50) },
  { rate: 59.94, timebase: String(Math.round(TPS / 60 * 1.001)) }
];

test('TICKS_PER_SECOND', function () {
  assert.strictEqual(VSTimemap.TICKS_PER_SECOND, 254016000000);
});

test('fixture timebase values are the exact NTSC and PAL tick counts', function () {
  assert.strictEqual(fixture('sequence-23976.json').timebase, String(Math.round(TPS / 24 * 1.001)));
  assert.strictEqual(fixture('sequence-25.json').timebase, String(TPS / 25));
  assert.strictEqual(fixture('sequence-2997.json').timebase, String(Math.round(TPS / 30 * 1.001)));
});

test('secondsToTicks and ticksToSeconds', function () {
  assert.strictEqual(VSTimemap.secondsToTicks(1), TPS);
  assert.strictEqual(typeof VSTimemap.secondsToTicks(1.5), 'number');
  assert.strictEqual(VSTimemap.secondsToTicks(0.5), TPS / 2);
  assert.strictEqual(VSTimemap.ticksToSeconds(TPS * 3), 3);
  assert.strictEqual(VSTimemap.ticksToSeconds(String(TPS * 3)), 3);
  assert.strictEqual(VSTimemap.ticksToSeconds(VSTimemap.secondsToTicks(12.345)), 12.345);
});

RATES.forEach(function (r) {
  var tb = Number(r.timebase);

  test('snapToFrame at ' + r.rate + ' fps lands on a whole frame and returns a string', function () {
    [0, 0.01, 1.234, 59.99, 600.5, 3599.97].forEach(function (seconds) {
      var snapped = VSTimemap.snapToFrame(VSTimemap.secondsToTicks(seconds), r.timebase);
      assert.strictEqual(typeof snapped, 'string');
      assert.strictEqual(Number(snapped) % tb, 0, seconds + ' s');
      // Nearest frame: never further than half a frame from the input.
      assert.ok(Math.abs(Number(snapped) - VSTimemap.secondsToTicks(seconds)) <= tb / 2, seconds + ' s');
    });
  });

  test('snapToFrame at ' + r.rate + ' fps is idempotent', function () {
    [0.01, 1.234, 59.99, 600.5].forEach(function (seconds) {
      var once = VSTimemap.snapToFrame(VSTimemap.secondsToTicks(seconds), r.timebase);
      assert.strictEqual(VSTimemap.snapToFrame(once, r.timebase), once);
    });
  });

  test('snapToFrame at ' + r.rate + ' fps rounds half a frame up and accepts string ticks', function () {
    assert.strictEqual(VSTimemap.snapToFrame(String(tb * 4), r.timebase), String(tb * 4));
    assert.strictEqual(VSTimemap.snapToFrame(tb * 4 + tb / 2, r.timebase), String(tb * 5));
    assert.strictEqual(VSTimemap.snapToFrame(tb * 4 + Math.floor(tb / 2) - 1, r.timebase), String(tb * 4));
  });

  test('40 sequential snapped additions show zero drift at ' + r.rate + ' fps', function () {
    var step = Number(VSTimemap.snapToFrame(VSTimemap.secondsToTicks(3.3), r.timebase));
    var sequential = 0;
    for (var i = 0; i < 40; i++) {
      sequential = Number(VSTimemap.snapToFrame(sequential + step, r.timebase));
    }
    var single = Number(VSTimemap.snapToFrame(step * 40, r.timebase));
    assert.strictEqual(sequential, single);
    assert.strictEqual(sequential % tb, 0);
    assert.strictEqual(sequential / tb, (step / tb) * 40);
  });
});

test('timecode is zero-based plus zeroPoint, non-drop-frame', function () {
  var seq25 = fixture('sequence-25.json');
  // The fixture's zeroPoint is exactly one hour at 25 fps.
  assert.strictEqual(VSTimemap.timecode('0', seq25), '01:00:00:00');
  assert.strictEqual(VSTimemap.timecode(String(Number(seq25.timebase) * 10), seq25), '01:00:00:10');
  assert.strictEqual(VSTimemap.timecode(String(Number(seq25.timebase) * 25), seq25), '01:00:01:00');
  assert.strictEqual(VSTimemap.timecode(Number(seq25.timebase) * (25 * 61 + 3), seq25), '01:01:01:03');
  assert.strictEqual(VSTimemap.timecode(seq25.playheadTicks, seq25), '01:15:00:00');
});

test('timecode includes zeroPoint', function () {
  var seq = fixture('sequence-25.json');
  var withoutZero = { timebase: seq.timebase, frameRate: seq.frameRate, zeroPointTicks: '0' };
  assert.strictEqual(VSTimemap.timecode('0', withoutZero), '00:00:00:00');
  assert.notStrictEqual(VSTimemap.timecode('0', seq), VSTimemap.timecode('0', withoutZero));
  var oneHour = TPS * 3600;
  assert.strictEqual(
    VSTimemap.timecode('0', { timebase: seq.timebase, frameRate: 25, zeroPointTicks: String(oneHour) }),
    '01:00:00:00'
  );
});

test('timecode counts frames from the timebase and labels them with the rounded rate', function () {
  [
    { file: 'sequence-23976.json', fps: 24 },
    { file: 'sequence-2997.json', fps: 30 }
  ].forEach(function (c) {
    var seq = fixture(c.file);
    var tb = Number(seq.timebase);
    var zeroed = { timebase: seq.timebase, frameRate: seq.frameRate, zeroPointTicks: '0' };
    assert.strictEqual(VSTimemap.timecode(String(tb * (c.fps - 1)), zeroed), '00:00:00:' + (c.fps - 1));
    assert.strictEqual(VSTimemap.timecode(String(tb * c.fps), zeroed), '00:00:01:00');
    assert.strictEqual(VSTimemap.timecode(String(tb * c.fps * 3600), zeroed), '01:00:00:00');
    // A frame that has not finished yet is floored, never rounded up.
    assert.strictEqual(VSTimemap.timecode(String(tb * c.fps - 1), zeroed), '00:00:00:' + (c.fps - 1));
  });
});

test('timecode adds a fixture zeroPoint that is not frame-aligned, flooring the total', function () {
  var seq = fixture('sequence-23976.json');
  var expectedFrames = Math.floor(Number(seq.zeroPointTicks) / Number(seq.timebase));
  assert.strictEqual(expectedFrames, 86313);
  assert.strictEqual(VSTimemap.timecode('0', seq), '00:59:56:09');
});

test('the ticks-per-frame value is never derived from frameRate', function () {
  // A Windows checkout (core.autocrlf) has CRLF line endings; the search below expects LF.
  var source = fs.readFileSync(path.join(root, 'panel', 'js', 'timemap.js'), 'utf8')
    .replace(/\r\n/g, '\n');
  var start = source.indexOf('function timecode(');
  assert.ok(start >= 0, 'timecode function not found');
  var end = source.indexOf('\n  }\n', start);
  assert.ok(end > start, 'end of timecode function not found');
  var outside = source.slice(0, start) + source.slice(end);
  assert.ok(!/frameRate/.test(outside), 'frameRate is used outside timecode');
  // Inside timecode, frameRate may only pick the label rate, never the tick size.
  var inside = source.slice(start, end);
  var uses = inside.split('\n').filter(function (line) { return /frameRate/.test(line); });
  assert.strictEqual(uses.length, 1);
  assert.ok(/Math\.round\(seqInfo\.frameRate\)/.test(uses[0]));
});

// ---------------------------------------------------------------------------------------------
// Exact string ticks above 2^53 (BigInt is only the oracle here; the panel code is ES5)

var BIG = '9007199254740993000';

test('addTicks and subTicks are exact on digit strings above 2^53', function () {
  assert.strictEqual(VSTimemap.addTicks(BIG, '7'), '9007199254740993007');
  assert.strictEqual(VSTimemap.addTicks(BIG, BIG), String(BigInt(BIG) * 2n));
  assert.strictEqual(VSTimemap.addTicks('999', '1'), '1000');
  assert.strictEqual(VSTimemap.addTicks('0', '0'), '0');
  assert.strictEqual(VSTimemap.subTicks(String(BigInt(BIG) + 12345n), BIG), '12345');
  assert.strictEqual(VSTimemap.subTicks('1000', '1'), '999');
  assert.strictEqual(VSTimemap.subTicks('5', '5'), '0');
  assert.strictEqual(VSTimemap.subTicks('5', '9'), '0');
  assert.strictEqual(VSTimemap.addTicks(254016000000, 1), '254016000001');
});

test('compareTicks orders digit strings by value', function () {
  assert.strictEqual(VSTimemap.compareTicks('9', '10'), -1);
  assert.strictEqual(VSTimemap.compareTicks(BIG, BIG), 0);
  assert.strictEqual(VSTimemap.compareTicks(String(BigInt(BIG) + 1n), BIG), 1);
  assert.strictEqual(VSTimemap.compareTicks('007', '7'), 0);
});

RATES.forEach(function (r) {
  var tb = BigInt(r.timebase);
  test('snapToFrameExact at ' + r.rate + ' fps matches snapToFrame below 2^53', function () {
    [0, 1, 1234567, 600.5 * TPS, 3599.97 * TPS].forEach(function (ticks) {
      var t = Math.round(ticks);
      assert.strictEqual(VSTimemap.snapToFrameExact(String(t), r.timebase), VSTimemap.snapToFrame(String(t), r.timebase));
    });
  });

  test('snapToFrameExact at ' + r.rate + ' fps is exact above 2^53 and rounds halves up', function () {
    var base = (BigInt(BIG) / tb) * tb;
    assert.strictEqual(VSTimemap.snapToFrameExact(String(base), r.timebase), String(base));
    assert.strictEqual(VSTimemap.snapToFrameExact(String(base + 1n), r.timebase), String(base));
    assert.strictEqual(VSTimemap.snapToFrameExact(String(base + tb - 1n), r.timebase), String(base + tb));
    var half = tb / 2n;
    var expected = tb % 2n === 0n ? base + tb : base;
    assert.strictEqual(VSTimemap.snapToFrameExact(String(base + half), r.timebase), String(expected));
    assert.strictEqual(VSTimemap.snapToFrameExact(BIG, r.timebase), String(BigInt(BIG) % tb * 2n >= tb ? base + tb : base));
  });
});
