'use strict';

var test = require('node:test');
var assert = require('node:assert');
var path = require('node:path');

var root = path.join(__dirname, '..', '..');
var VSTimemap = require(path.join(root, 'panel', 'js', 'timemap.js'));

function fixture(name) {
  return require(path.join(root, 'tests', 'fixtures', 'host', name));
}

function mapOf(name) {
  return VSTimemap.buildMap(fixture(name));
}

function sec(s) {
  return VSTimemap.secondsToTicks(s);
}

// Fixture geometry, in seconds (ticks / 254016000000):
//   single:    source [0, 2850)      -> sequence 0
//   split:     source [0, 900)       -> sequence 0
//              source [1200, 2100)   -> sequence 900   (300 s cut from the middle)
//              source [2100, 2850)   -> sequence 1800
//              (the third segment starts at source 2100, where the second ends)
//   duplicate: source [400, 460)     -> sequence 0 and sequence 2000
//   speed:     one 2x segment, in `unsupported`, nothing mapped
//   none:      matched false, no segments

test('single segment maps one-to-one from source zero', function () {
  var map = mapOf('segments-single.json');
  var r = VSTimemap.toSequence(map, 1425.32);
  assert.strictEqual(r.ticks, sec(1425.32));
  assert.deepStrictEqual(r.placements, [sec(1425.32)]);
});

test('a source time before inPoint is cut', function () {
  var map = mapOf('segments-duplicate.json');
  assert.strictEqual(VSTimemap.toSequence(map, 399.99), null);
  assert.strictEqual(VSTimemap.toSequence(map, 0), null);
});

test('a source time past the segment end is cut, and the end itself is exclusive', function () {
  var map = mapOf('segments-duplicate.json');
  assert.strictEqual(VSTimemap.toSequence(map, 460), null);
  assert.strictEqual(VSTimemap.toSequence(map, 9000), null);
  assert.notStrictEqual(VSTimemap.toSequence(map, 459.99), null);
});

test('inPoint itself is inside the segment (trimmed head)', function () {
  var map = mapOf('segments-duplicate.json');
  var r = VSTimemap.toSequence(map, 400);
  assert.strictEqual(r.ticks, 0);
});

test('trimmed head and tail: split segments leave gaps that are cut', function () {
  var map = mapOf('segments-split.json');
  // Between the first segment's tail (900) and the second's head (1200).
  assert.strictEqual(VSTimemap.toSequence(map, 900), null);
  assert.strictEqual(VSTimemap.toSequence(map, 1050), null);
  assert.strictEqual(VSTimemap.toSequence(map, 1199.99), null);
  // Past the final tail.
  assert.strictEqual(VSTimemap.toSequence(map, 2850), null);
});

test('split segments map with t_seq = seqStart + (t_src - inPoint)', function () {
  var map = mapOf('segments-split.json');
  assert.strictEqual(VSTimemap.toSequence(map, 100).ticks, sec(100));
  assert.strictEqual(VSTimemap.toSequence(map, 1200).ticks, sec(900));
  assert.strictEqual(VSTimemap.toSequence(map, 1500).ticks, sec(1200));
  assert.strictEqual(VSTimemap.toSequence(map, 2100).ticks, sec(1800));
  assert.strictEqual(VSTimemap.toSequence(map, 2500).ticks, sec(2200));
  assert.deepStrictEqual(VSTimemap.toSequence(map, 1500).placements, [sec(1200)]);
});

test('duplicates map to the earliest seqStart and list every placement', function () {
  var map = mapOf('segments-duplicate.json');
  var r = VSTimemap.toSequence(map, 410);
  assert.strictEqual(r.ticks, sec(10));
  assert.deepStrictEqual(r.placements, [sec(10), sec(2010)]);
});

test('the earliest placement wins regardless of input order', function () {
  var response = JSON.parse(JSON.stringify(fixture('segments-duplicate.json')));
  response.segments.reverse();
  var r = VSTimemap.toSequence(VSTimemap.buildMap(response), 410);
  assert.strictEqual(r.ticks, sec(10));
  assert.deepStrictEqual(r.placements, [sec(10), sec(2010)]);
});

test('a linked video and audio clip are one placement', function () {
  var response = JSON.parse(JSON.stringify(fixture('segments-single.json')));
  var audio = JSON.parse(JSON.stringify(response.segments[0]));
  audio.trackType = 'audio';
  response.segments.push(audio);
  var r = VSTimemap.toSequence(VSTimemap.buildMap(response), 100);
  assert.deepStrictEqual(r.placements, [sec(100)]);
});

test('speed-changed segments are never mapped', function () {
  var map = mapOf('segments-speed.json');
  assert.strictEqual(map.segments.length, 0);
  assert.strictEqual(map.unsupported.length, 1);
  assert.strictEqual(VSTimemap.toSequence(map, 0), null);
  assert.strictEqual(VSTimemap.toSequence(map, 100), null);
  assert.strictEqual(VSTimemap.toSource(map, sec(1800)), null);
});

test('an unmatched response maps nothing', function () {
  var map = mapOf('segments-none.json');
  assert.strictEqual(map.matched, false);
  assert.strictEqual(VSTimemap.toSequence(map, 10), null);
  assert.strictEqual(VSTimemap.toSource(map, 0), null);
});

test('toSource inverts the mapping inside a segment', function () {
  var map = mapOf('segments-split.json');
  assert.strictEqual(VSTimemap.toSource(map, sec(0)), 0);
  assert.strictEqual(VSTimemap.toSource(map, sec(900)), 1200);
  assert.strictEqual(VSTimemap.toSource(map, sec(1200)), 1500);
  assert.strictEqual(VSTimemap.toSource(map, sec(2200)), 2500);
  assert.strictEqual(VSTimemap.toSource(map, String(sec(1200))), 1500);
});

test('toSource is null outside every segment, and a segment end is exclusive', function () {
  var map = mapOf('segments-duplicate.json');
  assert.strictEqual(VSTimemap.toSource(map, sec(60)), null);
  assert.strictEqual(VSTimemap.toSource(map, sec(1000)), null);
  assert.strictEqual(VSTimemap.toSource(map, sec(2060)), null);
  assert.strictEqual(VSTimemap.toSource(map, -1), null);
  assert.strictEqual(VSTimemap.toSource(map, sec(2000)), 400);
});

test('toSequence then toSource round-trips on every mapped fixture', function () {
  var names = ['segments-single.json', 'segments-split.json', 'segments-duplicate.json'];
  var times = [0, 0.5, 100, 400, 410, 459.5, 899.5, 1200, 1500, 2099.5, 2100, 2500, 2849.5];
  names.forEach(function (name) {
    var map = mapOf(name);
    times.forEach(function (t) {
      var r = VSTimemap.toSequence(map, t);
      if (r === null) { return; }
      r.placements.forEach(function (ticks) {
        assert.strictEqual(VSTimemap.toSource(map, ticks), t, name + ' at ' + t);
      });
    });
  });
});

test('toSequence then toSource round-trips for every cut-free source time of the split map', function () {
  var map = mapOf('segments-split.json');
  for (var t = 0; t < 2850; t += 7.5) {
    var r = VSTimemap.toSequence(map, t);
    if (r === null) {
      assert.ok(t >= 900 && t < 1200, 'only the gap is cut, got ' + t);
    } else {
      assert.strictEqual(VSTimemap.toSource(map, r.ticks), t);
    }
  }
});

test('buildMap does not modify its input', function () {
  var response = JSON.parse(JSON.stringify(fixture('segments-split.json')));
  var before = JSON.stringify(response);
  VSTimemap.buildMap(response);
  assert.strictEqual(JSON.stringify(response), before);
});
