'use strict';

var test = require('node:test');
var assert = require('node:assert');
var path = require('node:path');

var VSTimemap = require(path.join(__dirname, '..', '..', 'panel', 'js', 'timemap.js'));

var TB = 8475667200; // 29.97 fps ticks per frame, as Premiere reports it
var S = VSTimemap.TICKS_PER_SECOND;

function before(anchorSeconds) {
  return Number(VSTimemap.snapToFrame(at(anchorSeconds) - 0.25 * S, TB));
}
function at(seconds) { return Number(VSTimemap.snapToFrame(seconds * S, TB)); }

test('silent truncation leaves a gap before the next anchor', function () {
  var r = VSTimemap.resolveOverlaps([
    { id: 'a', anchor: at(10), end: at(20) },
    { id: 'b', anchor: at(15), end: at(25) }
  ], String(TB));
  assert.deepStrictEqual(r.a.flags, ['truncated']);
  assert.strictEqual(r.a.end, before(15));
  assert.deepStrictEqual(r.b.flags, []);
  assert.strictEqual(r.b.end, at(25));
});

test('truncation is refused below the minimum visible time', function () {
  var r = VSTimemap.resolveOverlaps([
    { id: 'a', anchor: at(10), end: at(20) },
    { id: 'b', anchor: at(11.5), end: at(25) }
  ], TB);
  assert.deepStrictEqual(r.a.flags, ['overlap']);
  assert.deepStrictEqual(r.b.flags, ['overlap']);
  assert.strictEqual(r.a.end, at(20));
});

test('three-way overlap truncates in sequence', function () {
  var r = VSTimemap.resolveOverlaps([
    { id: 'c', anchor: at(20), end: at(40) },
    { id: 'a', anchor: at(0), end: at(30) },
    { id: 'b', anchor: at(10), end: at(35) }
  ], TB);
  assert.strictEqual(r.a.end, before(10));
  assert.strictEqual(r.b.end, before(20));
  assert.strictEqual(r.c.end, at(40));
  assert.deepStrictEqual(r.a.flags, ['truncated']);
  assert.deepStrictEqual(r.b.flags, ['truncated']);
  assert.deepStrictEqual(r.c.flags, []);
});

test('cues that exactly abut do not overlap', function () {
  var r = VSTimemap.resolveOverlaps([
    { id: 'a', anchor: at(10), end: at(15) },
    { id: 'b', anchor: at(15), end: at(20) }
  ], TB);
  assert.deepStrictEqual(r.a.flags, []);
  assert.deepStrictEqual(r.b.flags, []);
  assert.strictEqual(r.a.end, at(15));
});

test('disabled items take no part', function () {
  var r = VSTimemap.resolveOverlaps([
    { id: 'a', anchor: at(10), end: at(20) },
    { id: 'x', anchor: at(12), end: at(14), enabled: false },
    { id: 'b', anchor: at(30), end: at(35) }
  ], TB);
  assert.deepStrictEqual(r.a.flags, []);
  assert.deepStrictEqual(r.x.flags, []);
  assert.strictEqual(r.a.end, at(20));
});

test('every result is frame-aligned and no unflagged enabled pair overlaps', function () {
  var items = [];
  for (var i = 0; i < 30; i++) {
    items.push({ id: 'c' + i, anchor: at(i * 4.3), end: at(i * 4.3 + 9.1) });
  }
  var r = VSTimemap.resolveOverlaps(items, TB);
  var ids = Object.keys(r);
  ids.forEach(function (id) {
    assert.strictEqual(r[id].anchor % TB, 0);
    assert.strictEqual(r[id].end % TB, 0);
  });
  var sorted = ids.map(function (id) { return r[id]; })
    .sort(function (x, y) { return x.anchor - y.anchor; });
  for (var j = 0; j + 1 < sorted.length; j++) {
    if (sorted[j].end > sorted[j + 1].anchor) {
      assert.ok(sorted[j].flags.indexOf('overlap') !== -1);
      assert.ok(sorted[j + 1].flags.indexOf('overlap') !== -1);
    }
  }
});
