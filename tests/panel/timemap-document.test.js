'use strict';

var test = require('node:test');
var assert = require('node:assert');
var path = require('node:path');

var root = path.join(__dirname, '..', '..');
var VSTimemap = require(path.join(root, 'panel', 'js', 'timemap.js'));

function host(name) {
  return JSON.parse(JSON.stringify(require(path.join(root, 'tests', 'fixtures', 'host', name))));
}

function happyDoc() {
  return JSON.parse(JSON.stringify(
    require(path.join(root, 'tests', 'fixtures', 'cue-documents', 'happy-18-cues.json'))));
}

function sec(s) {
  return VSTimemap.secondsToTicks(s);
}

var SEQ = host('sequence-2997.json');
var TIMEBASE = Number(SEQ.timebase);

function cue(id, anchorS, durationS) {
  return { id: id, enabled: true, source_anchor_s: anchorS, source_duration_s: durationS };
}

function map(doc, segments, extra) {
  var options = { segments: segments, seqInfo: SEQ };
  Object.keys(extra || {}).forEach(function (k) { options[k] = extra[k]; });
  return VSTimemap.mapCueDocument(doc, options);
}

// docs/05 §9: 29.97 fps (timebase 8475667200), 12 s trimmed off the head of the media, a cue
// anchored at 1425.32 s of source time lands at 1413.32 s of sequence time.
test('worked example from docs/05 section 9 reproduces exactly', function () {
  var segments = {
    matched: true,
    segments: [{
      seqStartTicks: '0',
      seqEndTicks: String(sec(2838)),
      inPointTicks: String(sec(12)),
      speed: 1.0
    }],
    unsupported: []
  };
  var result = map({ cues: [cue('cue_w', 1425.32, 27.08)] }, segments);
  var p = result.placements.cue_w;
  // 1413.32 s is 359005893120000 ticks, which is 42357.4 frames; the nearest frame is 42357.
  assert.strictEqual(sec(1413.32), 359005893120000);
  assert.strictEqual(p.atTicks, String(42357 * 8475667200));
  assert.strictEqual(p.atTicks, '359003835590400');
  assert.strictEqual(Number(p.atTicks) % TIMEBASE, 0);
  assert.strictEqual(p.endTicks, VSTimemap.snapToFrame(sec(1413.32) + sec(27.08), SEQ.timebase));
  assert.strictEqual(p.durationTicks, String(Number(p.endTicks) - Number(p.atTicks)));
  assert.deepStrictEqual(p.alternatives, []);
  assert.deepStrictEqual(p.panelFlags, []);
  assert.strictEqual(result.unmatched, false);
  assert.strictEqual(result.approximate, false);
});

test('timecode adds zeroPoint for display and placement maths does not', function () {
  var result = map({ cues: [cue('a', 10, 5)] }, host('segments-single.json'));
  var p = result.placements.a;
  assert.strictEqual(p.atTicks, VSTimemap.snapToFrame(sec(10), SEQ.timebase));
  assert.strictEqual(p.timecode, VSTimemap.timecode(p.atTicks, SEQ));
  // zeroPoint is 01:00:00:00 in this fixture's sequence
  assert.strictEqual(p.timecode.slice(0, 2), '01');
});

test('happy-18-cues against segments-split: cut cues are flagged, the rest are placed', function () {
  var doc = happyDoc();
  var result = map(doc, host('segments-split.json'));
  var cut = ['cue_007', 'cue_008'];
  doc.cues.forEach(function (c) {
    var p = result.placements[c.id];
    assert.ok(p, c.id + ' has a placement');
    if (cut.indexOf(c.id) !== -1) {
      assert.deepStrictEqual(p.panelFlags, ['cut_from_edit'], c.id);
      assert.strictEqual(p.atTicks, '0');
      assert.strictEqual(p.timecode, '');
    } else {
      assert.deepStrictEqual(p.panelFlags, [], c.id);
      assert.strictEqual(Number(p.atTicks) % TIMEBASE, 0, c.id);
    }
  });
  // Source 889.5 s is in the first segment (sequence 0); 1333.5 s is in the second, which
  // starts at sequence 900 s and source 1200 s, so it lands at 900 + 133.5 s.
  assert.strictEqual(result.placements.cue_006.atTicks, VSTimemap.snapToFrame(sec(889.5), SEQ.timebase));
  assert.strictEqual(result.placements.cue_009.atTicks, VSTimemap.snapToFrame(sec(1033.5), SEQ.timebase));
  // Source 2221.5 s is in the third segment: sequence 1800 s + (2221.5 - 2100) s.
  assert.strictEqual(result.placements.cue_015.atTicks, VSTimemap.snapToFrame(sec(1921.5), SEQ.timebase));
  assert.strictEqual(result.unmatched, false);
  assert.strictEqual(result.approximate, false);
});

test('multiple_placements: earliest placement wins and the others are alternatives', function () {
  var doc = { cues: [cue('dup', 410, 10)] };
  var p = map(doc, host('segments-duplicate.json')).placements.dup;
  assert.strictEqual(p.atTicks, VSTimemap.snapToFrame(sec(10), SEQ.timebase));
  assert.deepStrictEqual(p.alternatives, [VSTimemap.snapToFrame(sec(2010), SEQ.timebase)]);
  assert.deepStrictEqual(p.panelFlags, ['multiple_placements']);
});

test('speed_change_unsupported: a cue inside a speed-changed clip is flagged and not placed', function () {
  var doc = { cues: [cue('fast', 100, 10), cue('later', 400, 10)] };
  var result = map(doc, host('segments-speed.json'));
  assert.deepStrictEqual(result.placements.fast.panelFlags, ['speed_change_unsupported']);
  assert.strictEqual(result.placements.fast.atTicks, '0');
  // The 2x clip covers source [0, 304 s); 400 s is outside it, and outside the linear map.
  assert.deepStrictEqual(result.placements.later.panelFlags, ['cut_from_edit']);
});

test('truncated and overlap flags come from the sweep, over enabled cues only', function () {
  var segments = host('segments-single.json');
  var doc = { cues: [
    cue('a', 100, 30),
    cue('b', 110, 10),
    cue('c', 200, 5),
    cue('d', 201, 5)
  ] };
  var result = map(doc, segments);
  assert.deepStrictEqual(result.placements.a.panelFlags, ['truncated']);
  assert.strictEqual(
    result.placements.a.endTicks,
    VSTimemap.snapToFrame(
      Number(result.placements.b.atTicks) - sec(VSTimemap.OVERLAP_GAP_S), SEQ.timebase)
  );
  assert.deepStrictEqual(result.placements.b.panelFlags, []);
  assert.deepStrictEqual(result.placements.c.panelFlags, ['overlap']);
  assert.deepStrictEqual(result.placements.d.panelFlags, ['overlap']);

  // Disabling d takes it out of the sweep, so c is no longer flagged.
  var after = map(doc, segments, { enabledById: { d: false } });
  assert.deepStrictEqual(after.placements.c.panelFlags, []);
  assert.deepStrictEqual(after.placements.d.panelFlags, []);
  assert.strictEqual(after.placements.d.atTicks, VSTimemap.snapToFrame(sec(201), SEQ.timebase));
});

test('a 40-cue synthetic batch shows no drift', function () {
  var cues = [];
  for (var i = 0; i < 40; i++) { cues.push(cue('s' + i, 10 + i * 60, 5)); }
  var result = map({ cues: cues }, host('segments-single.json'));
  for (var j = 0; j < 40; j++) {
    var p = result.placements['s' + j];
    var expected = VSTimemap.snapToFrame(sec(10 + j * 60), SEQ.timebase);
    assert.strictEqual(p.atTicks, expected, 's' + j);
    assert.strictEqual(Number(p.atTicks) % TIMEBASE, 0);
    assert.strictEqual(Number(p.durationTicks) % TIMEBASE, 0);
    assert.deepStrictEqual(p.panelFlags, []);
  }
});

test('manual offset maps every cue by t_seq = offset + t_src and is approximate', function () {
  var offset = sec(3600);
  var doc = { cues: [cue('m1', 12.5, 6), cue('m2', 700, 8)] };
  var result = map(doc, host('segments-none.json'), { manualOffsetTicks: String(offset) });
  assert.strictEqual(result.approximate, true);
  assert.strictEqual(result.unmatched, false);
  assert.strictEqual(result.placements.m1.atTicks, VSTimemap.snapToFrame(offset + sec(12.5), SEQ.timebase));
  assert.strictEqual(result.placements.m2.atTicks, VSTimemap.snapToFrame(offset + sec(700), SEQ.timebase));
  assert.deepStrictEqual(result.placements.m1.panelFlags, []);
});

test('the offset is ignored when the media is matched', function () {
  var result = map({ cues: [cue('a', 10, 5)] }, host('segments-single.json'), { manualOffsetTicks: '999' });
  assert.strictEqual(result.approximate, false);
  assert.strictEqual(result.placements.a.atTicks, VSTimemap.snapToFrame(sec(10), SEQ.timebase));
});

test('unmatched media with no offset places nothing', function () {
  var result = map({ cues: [cue('a', 10, 5)] }, host('segments-none.json'));
  assert.strictEqual(result.unmatched, true);
  assert.strictEqual(result.approximate, false);
  assert.deepStrictEqual(result.placements, {});
});

test('the input document is deep-equal before and after', function () {
  var doc = happyDoc();
  var before = JSON.stringify(doc);
  map(doc, host('segments-split.json'), { enabledById: { cue_001: false } });
  map(doc, host('segments-none.json'), { manualOffsetTicks: '0' });
  assert.strictEqual(JSON.stringify(doc), before);
  assert.deepStrictEqual(doc, happyDoc());
});
