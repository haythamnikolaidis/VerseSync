'use strict';

// Pure-JS tests for panel/js/timemap.js (T-28). No Premiere, no CEP.
// Expected values are computed independently with BigInt (the module under test uses plain
// numbers), from exact decimal seconds, so a shared rounding slip cannot hide.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var T = require('../panel/js/timemap');

var FIXTURES = path.join(__dirname, 'fixtures');
function hostFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, 'host', name + '.json'), 'utf8'));
}
function cueDocument(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, 'cue-documents', name + '.json'), 'utf8'));
}

// ---- oracle ------------------------------------------------------------------------------

var TPS = 254016000000n;

// Seconds with at most 3 decimals -> exact ticks (TPS / 1000 is an integer).
function ticksOf(seconds) {
  return BigInt(Math.round(seconds * 1000)) * (TPS / 1000n);
}
// Nearest frame boundary, exact halves up.
function snapBig(ticks, tpf) {
  return ((2n * ticks + tpf) / (2n * tpf)) * tpf;
}
function frames(n, tpf) {
  return BigInt(n) * tpf;
}

var TIMEBASES = {
  '23.976': 10594584000n,
  '24': 10584000000n,
  '25': 10160640000n,
  '29.97': 8475667200n,
  '30': 8467200000n,
  '50': 5080320000n,
  '59.94': 4237833600n
};

// ---- builders ----------------------------------------------------------------------------

function seqInfo(timebase, extra) {
  var s = {
    hasActiveSequence: true,
    name: 'Test',
    timebase: String(timebase),
    frameRate: 29.97,
    zeroPointTicks: '914457600000000',
    endTicks: '723945600000000'
  };
  Object.keys(extra || {}).forEach(function (k) { s[k] = extra[k]; });
  return s;
}

function cue(id, anchorS, durS, extra) {
  var c = {
    id: id,
    enabled: true,
    origin: 'detected',
    source_anchor_s: anchorS,
    source_duration_s: durS,
    flags: []
  };
  Object.keys(extra || {}).forEach(function (k) { c[k] = extra[k]; });
  return c;
}

// A segment covering `lengthS` seconds of sequence from `seqS`, starting at source `inS`.
function seg(seqS, lengthS, inS, extra) {
  var s = {
    trackType: 'video',
    trackIndex: 0,
    seqStartTicks: String(ticksOf(seqS)),
    seqEndTicks: String(ticksOf(seqS) + ticksOf(lengthS)),
    inPointTicks: String(ticksOf(inS)),
    durationTicks: String(ticksOf(lengthS)),
    speed: 1.0,
    name: 'MEDIA.MXF'
  };
  Object.keys(extra || {}).forEach(function (k) { s[k] = extra[k]; });
  return s;
}

function segData(segments, unsupported) {
  return { matched: segments.length > 0 || !!(unsupported && unsupported.length), segments: segments, unsupported: unsupported || [] };
}

function map(cues, segments, sequence, options) {
  var res = T.mapCues({ cues: cues, sequence: sequence, segments: segments, options: options });
  assert.strictEqual(res.ok, true, res.error);
  return res.data;
}

function byId(data) {
  var out = {};
  data.cues.forEach(function (c) { out[c.id] = c; });
  return out;
}

var SEQ_2997 = hostFixture('sequence-2997');
var TPF_2997 = 8475667200n;

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.keys(o).forEach(function (k) { deepFreeze(o[k]); });
  }
  return o;
}

// ==========================================================================================
// Frame snapping (docs/05 §7)
// ==========================================================================================

test('snapToFrame rounds to the nearest frame at every supported timebase', function () {
  Object.keys(TIMEBASES).forEach(function (rate) {
    var tpf = TIMEBASES[rate];
    [0n, 1n, tpf / 2n - 1n, tpf / 2n, tpf / 2n + 1n, tpf - 1n, tpf, 12345n * tpf + 7n,
      10000n * tpf + tpf / 3n, 3600n * TPS + 12345678n].forEach(function (ticks) {
      var got = BigInt(T.snapToFrame(String(ticks), String(tpf)));
      assert.strictEqual(got, snapBig(ticks, tpf), rate + ' fps, ticks ' + ticks);
      assert.strictEqual(got % tpf, 0n);
      assert.ok(got - ticks <= tpf / 2n && ticks - got <= tpf / 2n + 1n);
    });
  });
});

test('snapToFrame returns a string, rounds an exact half up, and is idempotent', function () {
  var tpf = '8475667200';
  assert.strictEqual(typeof T.snapToFrame('4237833600', tpf), 'string');
  assert.strictEqual(T.snapToFrame('4237833600', tpf), '8475667200');
  assert.strictEqual(T.snapToFrame('4237833599', tpf), '0');
  assert.strictEqual(T.snapToFrame('0', tpf), '0');
  var once = T.snapToFrame('359005893120000', tpf);
  assert.strictEqual(T.snapToFrame(once, tpf), once);
});

test('snapToFrame uses the supplied timebase, not a rate derived from it', function () {
  // 29.97 fps: a "30 fps" tick length (8467200000) would give a different answer.
  var ticks = '1000000000000';
  assert.notStrictEqual(T.snapToFrame(ticks, '8475667200'), T.snapToFrame(ticks, '8467200000'));
  assert.strictEqual(BigInt(T.snapToFrame(ticks, '8475667200')) % TPF_2997, 0n);
});

test('snapToFrame rejects malformed input', function () {
  assert.throws(function () { T.snapToFrame('abc', '8475667200'); }, /whole ticks/);
  assert.throws(function () { T.snapToFrame('100', '0'); }, /positive/);
  assert.throws(function () { T.snapToFrame('100', 'x'); }, /whole ticks/);
});

// ==========================================================================================
// Source -> sequence mapping (docs/05 §5.1, §5.2)
// ==========================================================================================

test('one candidate: t_seq = seqStart + (t_src - inPoint), snapped', function () {
  // seq 100 s .. 400 s shows source 12 s .. 312 s.
  var data = map([cue('a', 62.5, 8)], segData([seg(100, 300, 12)]), SEQ_2997);
  var r = data.cues[0];
  assert.strictEqual(r.placed, true);
  assert.deepStrictEqual(r.flags, []);
  var raw = ticksOf(100) + (ticksOf(62.5) - ticksOf(12));
  assert.strictEqual(r.anchorTicks, String(snapBig(raw, TPF_2997)));
  assert.strictEqual(r.endTicks, String(snapBig(raw + ticksOf(8), TPF_2997)));
  assert.strictEqual(BigInt(r.durationTicks), BigInt(r.endTicks) - BigInt(r.anchorTicks));
  assert.strictEqual(r.trackType, 'video');
  assert.strictEqual(r.trackIndex, 0);
  assert.deepStrictEqual(r.placementAlternatives, []);
});

test('window is half-open: first source frame maps, the end of the window does not', function () {
  var segments = segData([seg(100, 300, 12)]);
  var atStart = map([cue('s', 12, 5)], segments, SEQ_2997).cues[0];
  assert.strictEqual(atStart.placed, true);
  assert.strictEqual(atStart.anchorTicks, String(snapBig(ticksOf(100), TPF_2997)));

  var justBefore = map([cue('b', 11.999, 5)], segments, SEQ_2997).cues[0];
  assert.deepStrictEqual(justBefore.flags, ['cut_from_edit']);

  var lastValid = map([cue('l', 311.999, 5)], segments, SEQ_2997).cues[0];
  assert.strictEqual(lastValid.placed, true);

  var atEnd = map([cue('e', 312, 5)], segments, SEQ_2997).cues[0];
  assert.deepStrictEqual(atEnd.flags, ['cut_from_edit']);
  assert.strictEqual(atEnd.placed, false);
});

test('a trimmed head and tail leave the trimmed source time unmapped', function () {
  // Head trimmed 12 s, tail ends at source 1212 s.
  var segments = segData([seg(0, 1200, 12)]);
  var out = byId(map([cue('head', 5, 3), cue('in', 600, 3), cue('tail', 1300, 3)], segments, SEQ_2997));
  assert.deepStrictEqual(out.head.flags, ['cut_from_edit']);
  assert.strictEqual(out.in.anchorTicks, String(snapBig(ticksOf(588), TPF_2997)));
  assert.deepStrictEqual(out.tail.flags, ['cut_from_edit']);
});

test('zero candidates: cut_from_edit, disabled, no position', function () {
  var r = map([cue('x', 5000, 5)], segData([seg(0, 100, 0)]), SEQ_2997).cues[0];
  assert.deepStrictEqual(r.flags, ['cut_from_edit']);
  assert.strictEqual(r.enabled, false);
  assert.strictEqual(r.placed, false);
  assert.strictEqual(r.anchorTicks, null);
  assert.strictEqual(r.endTicks, null);
  assert.strictEqual(r.durationTicks, null);
  assert.deepStrictEqual(r.placementAlternatives, []);
});

test('many candidates: earliest seqStart wins, multiple_placements, others offered', function () {
  // The same source minute used at 0 s, 2000 s and (listed first, out of order) 900 s.
  var segments = segData([seg(2000, 60, 400), seg(900, 60, 400), seg(0, 60, 400)]);
  var r = map([cue('m', 410, 5)], segments, SEQ_2997).cues[0];
  assert.strictEqual(r.anchorTicks, String(snapBig(ticksOf(10), TPF_2997)));
  assert.deepStrictEqual(r.flags, ['multiple_placements']);
  assert.strictEqual(r.enabled, true);
  assert.strictEqual(r.placementAlternatives.length, 2);
  assert.strictEqual(r.placementAlternatives[0].anchorTicks, String(snapBig(ticksOf(910), TPF_2997)));
  assert.strictEqual(r.placementAlternatives[1].anchorTicks, String(snapBig(ticksOf(2010), TPF_2997)));
  r.placementAlternatives.forEach(function (alt, i) {
    var seqS = i === 0 ? 900 : 2000;
    var raw = ticksOf(seqS) + ticksOf(410) - ticksOf(400);
    assert.strictEqual(BigInt(alt.endTicks), snapBig(raw + ticksOf(5), TPF_2997));
    assert.strictEqual(BigInt(alt.durationTicks), BigInt(alt.endTicks) - BigInt(alt.anchorTicks));
    assert.strictEqual(BigInt(alt.anchorTicks) % TPF_2997, 0n);
    assert.strictEqual(alt.trackType, 'video');
  });
});

test('only some candidates contain the time: only those count', function () {
  var segments = segData([seg(0, 60, 400), seg(2000, 30, 400)]);
  // 430 s is inside the first window (400..460) but past the second (400..430, half-open).
  var r = map([cue('p', 430, 5)], segments, SEQ_2997).cues[0];
  assert.deepStrictEqual(r.flags, []);
  assert.deepStrictEqual(r.placementAlternatives, []);
});

test('video and audio halves of one linked clip are one placement, not two', function () {
  var segments = segData([
    seg(100, 300, 12, { trackType: 'audio', trackIndex: 1, name: 'MEDIA.MXF' }),
    seg(100, 300, 12, { trackType: 'video', trackIndex: 2 })
  ]);
  var r = map([cue('l', 62.5, 8)], segments, SEQ_2997).cues[0];
  assert.deepStrictEqual(r.flags, []);
  assert.strictEqual(r.trackType, 'video');
  assert.strictEqual(r.trackIndex, 2);
  assert.deepStrictEqual(r.placementAlternatives, []);
});

test('a detached audio clip with a different trim but the same offset is the same placement', function () {
  var segments = segData([
    seg(100, 300, 12),
    seg(150, 250, 62, { trackType: 'audio', trackIndex: 0 })
  ]);
  var r = map([cue('d', 100, 8)], segments, SEQ_2997).cues[0];
  assert.deepStrictEqual(r.flags, []);
  assert.strictEqual(r.trackType, 'video');
});

test('a match on an audio track alone is a valid mapping', function () {
  var segments = segData([seg(100, 300, 12, { trackType: 'audio', trackIndex: 3 })]);
  var r = map([cue('a', 62.5, 8)], segments, SEQ_2997).cues[0];
  assert.strictEqual(r.placed, true);
  assert.strictEqual(r.trackType, 'audio');
  assert.strictEqual(r.trackIndex, 3);
});

test('matched:false with no segments cuts every cue and says the media was not found', function () {
  var data = map([cue('a', 5, 3), cue('b', 50, 3)], hostFixture('segments-none'), SEQ_2997);
  data.cues.forEach(function (r) {
    assert.deepStrictEqual(r.flags, ['cut_from_edit']);
    assert.strictEqual(r.enabled, false);
  });
  assert.strictEqual(data.summary.mediaMatched, false);
  assert.strictEqual(data.summary.cutFromEdit, 2);
  assert.strictEqual(data.summary.mode, 'segments');
});

// ==========================================================================================
// Panel-owned flags from the T-39 fixtures
// ==========================================================================================

test('segments-single: every cue of the 18-cue document is placed unflagged', function () {
  var doc = cueDocument('happy-18-cues');
  var data = map(doc.cues, hostFixture('segments-single'), SEQ_2997);
  assert.strictEqual(data.cues.length, 18);
  data.cues.forEach(function (r, i) {
    var c = doc.cues[i];
    assert.strictEqual(r.id, c.id);
    assert.deepStrictEqual(r.flags, c.flags);
    assert.strictEqual(r.enabled, c.enabled);
    var raw = ticksOf(c.source_anchor_s);
    assert.strictEqual(r.anchorTicks, String(snapBig(raw, TPF_2997)), c.id);
    assert.strictEqual(r.endTicks, String(snapBig(raw + ticksOf(c.source_duration_s), TPF_2997)), c.id);
  });
  assert.strictEqual(data.summary.placed, 18);
});

test('segments-split: cues in the cut are cut_from_edit, the rest follow their own segment', function () {
  var doc = cueDocument('happy-18-cues');
  var data = map(doc.cues, hostFixture('segments-split'), SEQ_2997);
  // Source [0,900) -> seq +0 ; [900,1200) cut ; [1200,2100) -> seq -300 s ; [2100,2850) -> seq -300 s
  var cut = 0;
  data.cues.forEach(function (r, i) {
    var c = doc.cues[i];
    var s = c.source_anchor_s;
    var shift;
    if (s < 900) { shift = 0; } else if (s < 1200) { shift = null; } else if (s < 2850) { shift = -300; } else { shift = null; }
    if (shift === null) {
      cut += 1;
      assert.deepStrictEqual(r.flags, ['cut_from_edit'], c.id);
      assert.strictEqual(r.enabled, false);
      assert.strictEqual(r.placed, false);
    } else {
      assert.deepStrictEqual(r.flags, [], c.id);
      assert.strictEqual(r.anchorTicks, String(snapBig(ticksOf(s + shift), TPF_2997)), c.id);
    }
  });
  assert.strictEqual(cut, 2);
  assert.strictEqual(data.summary.cutFromEdit, 2);
  assert.strictEqual(data.summary.placed, 16);
});

test('segments-duplicate: a moment in the repeated section gets multiple_placements', function () {
  var data = map([cue('a', 410, 5), cue('b', 459.9, 0.04), cue('c', 460, 5), cue('d', 399.9, 5)],
    hostFixture('segments-duplicate'), SEQ_2997);
  var out = byId(data);
  assert.deepStrictEqual(out.a.flags, ['multiple_placements']);
  assert.strictEqual(out.a.anchorTicks, String(snapBig(ticksOf(10), TPF_2997)));
  assert.strictEqual(out.a.placementAlternatives.length, 1);
  assert.strictEqual(out.a.placementAlternatives[0].anchorTicks, String(snapBig(ticksOf(2010), TPF_2997)));
  assert.deepStrictEqual(out.b.flags, ['multiple_placements']);
  assert.strictEqual(out.b.anchorTicks, String(snapBig(ticksOf(59.9), TPF_2997)));
  assert.deepStrictEqual(out.c.flags, ['cut_from_edit']);
  assert.deepStrictEqual(out.d.flags, ['cut_from_edit']);
  assert.strictEqual(data.summary.multiplePlacements, 2);
});

test('segments-speed: cues are speed_change_unsupported, disabled, and not positioned', function () {
  var data = map([cue('a', 5, 3), cue('b', 120, 3)], hostFixture('segments-speed'), SEQ_2997);
  data.cues.forEach(function (r) {
    assert.deepStrictEqual(r.flags, ['speed_change_unsupported']);
    assert.strictEqual(r.enabled, false);
    assert.strictEqual(r.placed, false);
  });
  assert.strictEqual(data.summary.speedChangeUnsupported, 2);
  assert.strictEqual(data.summary.cutFromEdit, 0);
  assert.deepStrictEqual(data.summary.unsupported, [
    { trackType: 'video', trackIndex: 1, name: 'SERMON_A014.MXF', reason: 'speed_change' }
  ]);
});

test('a supported placement wins over a speed-changed use of the same media', function () {
  var fixture = hostFixture('segments-speed');
  var data = map([cue('in', 10, 3), cue('out', 5000, 3)],
    { matched: true, segments: [seg(0, 100, 0)], unsupported: fixture.unsupported }, SEQ_2997);
  var out = byId(data);
  assert.deepStrictEqual(out.in.flags, []);
  assert.strictEqual(out.in.placed, true);
  // Not covered by the usable segment: the speed-changed use might contain it.
  assert.deepStrictEqual(out.out.flags, ['speed_change_unsupported']);
});

test('an unsupported entry of another kind (nested, multicam) does not flag cues as speed-changed', function () {
  var data = map([cue('x', 5000, 3)], {
    matched: true,
    segments: [seg(0, 100, 0)],
    unsupported: [{ trackType: 'video', trackIndex: 0, name: 'Nest', reason: 'unresolvable_media', speed: 1.0 }]
  }, SEQ_2997);
  assert.deepStrictEqual(data.cues[0].flags, ['cut_from_edit']);
  assert.strictEqual(data.summary.unsupported[0].reason, 'unresolvable_media');
});

test('a speed-changed segment wrongly listed under segments is not used for mapping', function () {
  var data = map([cue('a', 10, 3)], { matched: true, segments: [seg(0, 100, 0, { speed: 1.1 })], unsupported: [] }, SEQ_2997);
  assert.deepStrictEqual(data.cues[0].flags, ['speed_change_unsupported']);
  assert.strictEqual(data.cues[0].placed, false);
});

test('all three mapping flags co-exist in one document with the right enable state', function () {
  var segments = segData([seg(0, 100, 0), seg(500, 100, 0)], [{
    trackType: 'video', trackIndex: 1, name: 'x', reason: 'speed_change', speed: 2.0
  }]);
  // 10 s: twice (multiple); 300 s: nowhere but a speed-changed use exists.
  var out = byId(map([cue('multi', 10, 3), cue('lost', 300, 3), cue('plain', 10, 3, { enabled: false })], segments, SEQ_2997));
  assert.deepStrictEqual(out.multi.flags, ['multiple_placements']);
  assert.strictEqual(out.multi.enabled, true);
  assert.deepStrictEqual(out.lost.flags, ['speed_change_unsupported']);
  assert.strictEqual(out.lost.enabled, false);
});

test('flags the sidecar owns are preserved; stale panel-owned flags are recomputed', function () {
  var doc = cueDocument('flagged');
  var data = map(doc.cues, hostFixture('segments-single'), SEQ_2997);
  var out = byId(data);
  doc.cues.forEach(function (c) {
    ['low_confidence', 'long_passage', 'text_unavailable', 'passage_not_found', 'chapter_only', 'suppressed_duplicate']
      .forEach(function (f) {
        if (c.flags.indexOf(f) !== -1) {
          assert.ok(out[c.id].flags.indexOf(f) !== -1, c.id + ' keeps ' + f);
        }
      });
  });
  // f10 carried cut_from_edit, f11 multiple_placements, f12 speed_change_unsupported in the
  // stored document; against a single straight placement none of them applies any more.
  ['cue_f10', 'cue_f11', 'cue_f12'].forEach(function (id) {
    assert.deepStrictEqual(out[id].flags, [], id);
    assert.strictEqual(out[id].placed, true);
  });
  // Cues the sidecar disabled stay disabled.
  assert.strictEqual(out.cue_f08.enabled, false);
  assert.strictEqual(out.cue_f09.enabled, false);
});

// ==========================================================================================
// Worked example (docs/05 §9)
// ==========================================================================================

test('worked example: 1 Corinthians 6:19-20 at 29.97 fps with 12 s trimmed from the head', function () {
  var sequence = seqInfo('8475667200');
  var segments = segData([{
    trackType: 'video', trackIndex: 0,
    seqStartTicks: '0', seqEndTicks: '685843200000000',
    inPointTicks: '3048192000000', durationTicks: '685843200000000',
    speed: 1.0, name: 'SERMON.MXF'
  }]);
  var read = cue('cue_001', 1425.32, 27.08, { classification: 'read' });
  var next = cue('cue_002', 1521.32, 9);
  var data = map([read, next], segments, sequence);
  var r = data.cues[0];

  // t_seq = 0 + (1425.32 - 12.0) = 1413.32 s
  assert.strictEqual(ticksOf(1413.32), 359005893120000n);
  // Nearest frame: 42,357 frames of 8,475,667,200 ticks.
  assert.strictEqual(r.anchorTicks, '359003835590400');
  assert.strictEqual(BigInt(r.anchorTicks), frames(42357, TPF_2997));
  // End = 1413.32 + 27.08 = 1440.40 s -> frame 43,169.
  assert.strictEqual(r.endTicks, '365886077356800');
  assert.strictEqual(BigInt(r.endTicks), frames(43169, TPF_2997));
  assert.strictEqual(r.durationTicks, String(frames(812, TPF_2997)));
  assert.deepStrictEqual(r.flags, []);
  // The next anchor is 96 s later: no conflict.
  assert.deepStrictEqual(data.cues[1].flags, []);
  assert.strictEqual(r.endTicks, r.naturalEndTicks);
  // zeroPoint is display-only: it must not appear in placement.
  var withOtherZero = map([read], segments, seqInfo('8475667200', { zeroPointTicks: '0' })).cues[0];
  assert.strictEqual(withOtherZero.anchorTicks, r.anchorTicks);
});

// ==========================================================================================
// Frame rates and drift
// ==========================================================================================

test('anchors and ends land on whole frames at 23.976, 25 and 29.97 using the fixture timebase', function () {
  ['sequence-23976', 'sequence-25', 'sequence-2997'].forEach(function (name) {
    var sequence = hostFixture(name);
    var tpf = BigInt(sequence.timebase);
    var segments = segData([seg(37.3, 1000, 5.17)]);
    var cues = [cue('a', 100.123, 7.777), cue('b', 250.5005, 3.3333), cue('c', 900.999, 12.0004)];
    map(cues, segments, sequence).cues.forEach(function (r, i) {
      var c = cues[i];
      var raw = ticksOf(37.3) + ticksOf(c.source_anchor_s) - ticksOf(5.17);
      assert.strictEqual(BigInt(r.anchorTicks), snapBig(raw, tpf), name + ' ' + r.id);
      assert.strictEqual(BigInt(r.endTicks), snapBig(raw + ticksOf(c.source_duration_s), tpf), name + ' ' + r.id);
      assert.strictEqual(BigInt(r.anchorTicks) % tpf, 0n);
      assert.strictEqual(BigInt(r.durationTicks) % tpf, 0n);
    });
  });
});

test('frameRate is ignored: only timebase decides the frame grid', function () {
  var segments = segData([seg(0, 3000, 0)]);
  var cues = [cue('a', 123.456, 6.7)];
  var a = map(cues, segments, seqInfo('10594584000', { frameRate: 23.976 })).cues[0];
  var b = map(cues, segments, seqInfo('10594584000', { frameRate: 24 })).cues[0];
  var c = map(cues, segments, seqInfo('10594584000', { frameRate: 99 })).cues[0];
  assert.deepStrictEqual(a, b);
  assert.deepStrictEqual(a, c);
  assert.strictEqual(BigInt(a.anchorTicks) % 10594584000n, 0n);
});

test('40 cues in one batch show no cumulative drift at 29.97, 23.976 and 25', function () {
  ['sequence-2997', 'sequence-23976', 'sequence-25'].forEach(function (name) {
    var sequence = hostFixture(name);
    var tpf = BigInt(sequence.timebase);
    // Media starts 12 s into the file and 3.5 s into the sequence; cues are spaced by an
    // amount that is not a whole number of frames, so any per-cue error would accumulate.
    var segments = segData([seg(3.5, 3600, 12)]);
    var cues = [];
    for (var i = 0; i < 40; i++) {
      cues.push(cue('c' + i, 20 + i * 61.733 + (i % 3) * 0.017, 7.317));
    }
    var data = map(cues, segments, sequence);
    data.cues.forEach(function (r, i) {
      var raw = ticksOf(3.5) + ticksOf(cues[i].source_anchor_s) - ticksOf(12);
      var anchor = BigInt(r.anchorTicks);
      // Each cue is within half a frame of its true time, however far into the batch it is.
      var err = anchor > raw ? anchor - raw : raw - anchor;
      assert.ok(err * 2n <= tpf, name + ' cue ' + i + ' off by ' + err);
      assert.strictEqual(anchor % tpf, 0n);
      var endErr = BigInt(r.endTicks) - (raw + ticksOf(7.317));
      assert.ok((endErr < 0n ? -endErr : endErr) * 2n <= tpf, name + ' end of cue ' + i);
      assert.strictEqual(BigInt(r.durationTicks) % tpf, 0n);
      assert.deepStrictEqual(r.flags, []);
    });
    var last = BigInt(data.cues[39].anchorTicks);
    assert.strictEqual(last, snapBig(ticksOf(3.5) + ticksOf(cues[39].source_anchor_s) - ticksOf(12), tpf));
  });
});

test('every timebase in the test matrix snaps mapped cues correctly', function () {
  Object.keys(TIMEBASES).forEach(function (rate) {
    var tpf = TIMEBASES[rate];
    var data = map([cue('a', 1425.32, 27.08)], segData([seg(0, 2700, 12)]), seqInfo(String(tpf)));
    var raw = ticksOf(1413.32);
    assert.strictEqual(BigInt(data.cues[0].anchorTicks), snapBig(raw, tpf), rate);
    assert.strictEqual(BigInt(data.cues[0].endTicks), snapBig(raw + ticksOf(27.08), tpf), rate);
  });
});

test('a cue shorter than half a frame still lasts one whole frame', function () {
  var r = map([cue('z', 10, 0)], segData([seg(0, 100, 0)]), SEQ_2997).cues[0];
  assert.strictEqual(BigInt(r.durationTicks), TPF_2997);
});

// ==========================================================================================
// Overlap resolution (docs/05 §8)
// ==========================================================================================

var SEQ_25 = hostFixture('sequence-25');
var TPF_25 = 10160640000n;
var IDENTITY = segData([seg(0, 3000, 0)]);

test('overlap: silent truncation to the next anchor minus the gap, recorded as truncated', function () {
  var data = map([cue('a', 100, 10), cue('b', 105, 10)], IDENTITY, SEQ_2997);
  var a = data.cues[0];
  var b = data.cues[1];
  var bAnchor = snapBig(ticksOf(105), TPF_2997);
  // 0.25 s is 7.49 frames; the gap is rounded up to 8 whole frames so it is never shorter.
  assert.strictEqual(a.endTicks, String(bAnchor - frames(8, TPF_2997)));
  assert.strictEqual(a.naturalEndTicks, String(snapBig(ticksOf(110), TPF_2997)));
  assert.strictEqual(a.durationTicks, String(BigInt(a.endTicks) - BigInt(a.anchorTicks)));
  assert.deepStrictEqual(a.flags, ['truncated']);
  assert.deepStrictEqual(b.flags, []);
  assert.strictEqual(b.endTicks, b.naturalEndTicks);
  assert.strictEqual(BigInt(a.endTicks) % TPF_2997, 0n);
  assert.strictEqual(data.summary.truncated, 1);
});

test('overlap: the gap is at least overlap_gap_s at every timebase', function () {
  Object.keys(TIMEBASES).forEach(function (rate) {
    var tpf = TIMEBASES[rate];
    var data = map([cue('a', 100, 10), cue('b', 105, 10)], IDENTITY, seqInfo(String(tpf)));
    var gap = BigInt(data.cues[1].anchorTicks) - BigInt(data.cues[0].endTicks);
    assert.ok(gap >= ticksOf(0.25), rate + ' gap ' + gap);
    assert.ok(gap < ticksOf(0.25) + tpf, rate + ' gap is not more than one frame too long');
    assert.strictEqual(gap % tpf, 0n);
  });
});

test('overlap: truncation is allowed at exactly min_visible_s and refused just below it', function () {
  // 25 fps: 0.25 s gap -> 7 frames (0.28 s).
  // b at 102.28 s -> proposed end 102.00 s -> exactly 2.0 s visible: truncate.
  var ok = map([cue('a', 100, 10), cue('b', 102.28, 10)], IDENTITY, SEQ_25);
  assert.deepStrictEqual(ok.cues[0].flags, ['truncated']);
  assert.strictEqual(BigInt(ok.cues[0].endTicks) - BigInt(ok.cues[0].anchorTicks), ticksOf(2));
  // b one frame earlier -> 1.96 s visible: flag both, end untouched.
  var no = map([cue('a', 100, 10), cue('b', 102.24, 10)], IDENTITY, SEQ_25);
  assert.deepStrictEqual(no.cues[0].flags, ['overlap']);
  assert.deepStrictEqual(no.cues[1].flags, ['overlap']);
  assert.strictEqual(no.cues[0].endTicks, no.cues[0].naturalEndTicks);
  assert.strictEqual(no.summary.overlap, 2);
  assert.strictEqual(no.summary.truncated, 0);
});

test('overlap: a pair too close to truncate stays enabled and keeps its times', function () {
  var data = map([cue('a', 100, 10), cue('b', 101.5, 10)], IDENTITY, SEQ_2997);
  data.cues.forEach(function (r) {
    assert.deepStrictEqual(r.flags, ['overlap']);
    assert.strictEqual(r.enabled, true);
    assert.strictEqual(r.endTicks, r.naturalEndTicks);
  });
});

test('overlap: min_visible_s and overlap_gap_s are configurable', function () {
  var cues = [cue('a', 100, 10), cue('b', 101.5, 10)];
  var relaxed = map(cues, IDENTITY, SEQ_25, { min_visible_s: 1, overlap_gap_s: 0.1 });
  assert.deepStrictEqual(relaxed.cues[0].flags, ['truncated']);
  // 0.1 s = 2.5 frames -> 3 frames.
  assert.strictEqual(BigInt(relaxed.cues[1].anchorTicks) - BigInt(relaxed.cues[0].endTicks), frames(3, TPF_25));
  var none = map(cues, IDENTITY, SEQ_25, { overlap_gap_s: 0 });
  assert.deepStrictEqual(none.cues[0].flags, ['overlap']);
  var zeroGap = map([cue('a', 100, 10), cue('b', 105, 10)], IDENTITY, SEQ_25, { overlap_gap_s: 0 });
  assert.strictEqual(zeroGap.cues[0].endTicks, zeroGap.cues[1].anchorTicks);
});

test('overlap: cues that exactly abut do not overlap', function () {
  var data = map([cue('a', 100, 10), cue('b', 110, 10)], IDENTITY, SEQ_25);
  assert.deepStrictEqual(data.cues[0].flags, []);
  assert.deepStrictEqual(data.cues[1].flags, []);
  assert.strictEqual(data.cues[0].endTicks, data.cues[1].anchorTicks);
});

test('overlap: a three-way chain truncates each cue against its successor', function () {
  var data = map([cue('a', 100, 30), cue('b', 110, 30), cue('c', 120, 30)], IDENTITY, SEQ_25);
  assert.deepStrictEqual(data.cues[0].flags, ['truncated']);
  assert.deepStrictEqual(data.cues[1].flags, ['truncated']);
  assert.deepStrictEqual(data.cues[2].flags, []);
  assert.strictEqual(BigInt(data.cues[0].endTicks), BigInt(data.cues[1].anchorTicks) - frames(7, TPF_25));
  assert.strictEqual(BigInt(data.cues[1].endTicks), BigInt(data.cues[2].anchorTicks) - frames(7, TPF_25));
  assert.strictEqual(data.cues[2].endTicks, data.cues[2].naturalEndTicks);
});

test('overlap: a three-way pile-up flags the unresolvable pair and still truncates the rest', function () {
  // a/b are 1 s apart (cannot truncate a); b/c are 19 s apart (can truncate b).
  var data = map([cue('a', 100, 30), cue('b', 101, 30), cue('c', 120, 30)], IDENTITY, SEQ_25);
  assert.deepStrictEqual(data.cues[0].flags, ['overlap']);
  assert.deepStrictEqual(data.cues[1].flags, ['overlap', 'truncated']);
  assert.deepStrictEqual(data.cues[2].flags, []);
  assert.strictEqual(data.cues[0].endTicks, data.cues[0].naturalEndTicks);
  assert.strictEqual(BigInt(data.cues[1].endTicks), BigInt(data.cues[2].anchorTicks) - frames(7, TPF_25));
});

test('overlap: cues are swept in anchor order whatever order they arrive in', function () {
  var data = map([cue('late', 105, 10), cue('early', 100, 10)], IDENTITY, SEQ_25);
  assert.deepStrictEqual(data.cues.map(function (r) { return r.id; }), ['late', 'early']);
  assert.deepStrictEqual(data.cues[1].flags, ['truncated']);
  assert.deepStrictEqual(data.cues[0].flags, []);
});

test('overlap: identical anchors cannot be truncated and flag both', function () {
  var data = map([cue('a', 100, 10), cue('b', 100, 10)], IDENTITY, SEQ_25);
  assert.deepStrictEqual(data.cues[0].flags, ['overlap']);
  assert.deepStrictEqual(data.cues[1].flags, ['overlap']);
});

test('overlap: disabled cues take no part in the sweep', function () {
  var data = map([cue('a', 100, 10), cue('off', 105, 10, { enabled: false }), cue('c', 140, 10)], IDENTITY, SEQ_25);
  assert.deepStrictEqual(data.cues[0].flags, []);
  assert.deepStrictEqual(data.cues[1].flags, []);
  assert.strictEqual(data.cues[0].endTicks, data.cues[0].naturalEndTicks);
});

test('overlap: placements on different segments are compared in sequence time', function () {
  // Source 100 s and 500 s sit 3 s apart in the sequence after a cut.
  var segments = segData([seg(0, 110, 0), seg(110, 100, 500)]);
  var data = map([cue('a', 100, 15), cue('b', 502, 5)], segments, SEQ_25);
  assert.deepStrictEqual(data.cues[0].flags, ['truncated']);
});

test('overlap: re-running on the same input gives identical output, and stale flags are ignored', function () {
  var cues = [cue('a', 100, 10, { flags: ['overlap', 'truncated', 'low_confidence'] }), cue('b', 105, 10)];
  var first = T.mapCues({ cues: cues, sequence: SEQ_25, segments: IDENTITY });
  var second = T.mapCues({ cues: cues, sequence: SEQ_25, segments: IDENTITY });
  assert.deepStrictEqual(first, second);
  assert.deepStrictEqual(first.data.cues[0].flags, ['low_confidence', 'truncated']);
  // Re-enabling after a disable gives the same result as never having disabled.
  var off = map([cue('a', 100, 10), cue('b', 105, 10, { enabled: false })], IDENTITY, SEQ_25);
  assert.deepStrictEqual(off.cues[0].flags, []);
  var on = map([cue('a', 100, 10), cue('b', 105, 10)], IDENTITY, SEQ_25);
  assert.deepStrictEqual(on.cues[0].flags, ['truncated']);
});

// ==========================================================================================
// Manual offset (docs/05 §5.4)
// ==========================================================================================

test('manual offset: t_seq = offset + t_src, every cue approximate', function () {
  var offset = String(ticksOf(100));
  var data = T.mapCues({
    cues: [cue('a', 10, 5), cue('b', 600, 5)],
    sequence: SEQ_2997,
    manualOffsetTicks: offset
  });
  assert.strictEqual(data.ok, true);
  data.data.cues.forEach(function (r, i) {
    var src = i === 0 ? 10 : 600;
    assert.strictEqual(r.placed, true);
    assert.strictEqual(r.approximate, true);
    assert.strictEqual(r.anchorTicks, String(snapBig(ticksOf(100 + src), TPF_2997)));
    assert.strictEqual(r.endTicks, String(snapBig(ticksOf(105 + src), TPF_2997)));
    assert.strictEqual(r.trackType, null);
    assert.deepStrictEqual(r.flags, []);
  });
  assert.strictEqual(data.data.summary.mode, 'manual_offset');
  assert.strictEqual(data.data.summary.approximate, true);
});

test('manual offset: works when the media has no segments at all', function () {
  var res = T.mapCues({
    cues: [cue('a', 10, 5)],
    sequence: SEQ_2997,
    segments: hostFixture('segments-none'),
    manualOffsetTicks: '0'
  });
  assert.strictEqual(res.data.cues[0].placed, true);
  assert.strictEqual(res.data.cues[0].anchorTicks, String(snapBig(ticksOf(10), TPF_2997)));
});

test('manual offset: a negative offset (trimmed head) is allowed; times before the sequence are cut', function () {
  var res = T.mapCues({
    cues: [cue('before', 5, 3), cue('ok', 20, 3)],
    sequence: SEQ_2997,
    manualOffsetTicks: String(-ticksOf(12))
  });
  var out = byId(res.data);
  assert.deepStrictEqual(out.before.flags, ['cut_from_edit']);
  assert.strictEqual(out.before.enabled, false);
  assert.strictEqual(out.before.approximate, true);
  assert.strictEqual(out.before.placed, false);
  assert.strictEqual(out.ok.anchorTicks, String(snapBig(ticksOf(8), TPF_2997)));
});

test('manual offset: times at or past the end of the sequence are cut', function () {
  var res = T.mapCues({
    cues: [cue('in', 2000, 3), cue('past', 2900, 3)],
    sequence: SEQ_2997, // 2850 s long
    manualOffsetTicks: '0'
  });
  var out = byId(res.data);
  assert.strictEqual(out.in.placed, true);
  assert.deepStrictEqual(out.past.flags, ['cut_from_edit']);
});

test('manual offset: overlap resolution still applies', function () {
  var res = T.mapCues({
    cues: [cue('a', 100, 10), cue('b', 105, 10)],
    sequence: SEQ_25,
    manualOffsetTicks: '0'
  });
  assert.deepStrictEqual(res.data.cues[0].flags, ['truncated']);
  assert.strictEqual(res.data.cues[0].approximate, true);
});

test('offsetFromTimecode: display timecode includes zeroPoint, which is removed', function () {
  var tpf = 10160640000n;
  var seq25 = hostFixture('sequence-25'); // zeroPoint = 01:00:00:00
  assert.deepStrictEqual(T.offsetFromTimecode('01:00:00:00', seq25), { ok: true, data: { ticks: '0' } });
  assert.deepStrictEqual(T.offsetFromTimecode('01:00:12:05', seq25),
    { ok: true, data: { ticks: String(frames(12 * 25 + 5, tpf)) } });
  // Before the start of the sequence: negative.
  assert.deepStrictEqual(T.offsetFromTimecode('00:59:48:00', seq25),
    { ok: true, data: { ticks: String(-frames(12 * 25, tpf)) } });
  assert.deepStrictEqual(T.offsetFromTimecode(' 01:00:00:00 ', seq25).data, { ticks: '0' });
});

test('offsetFromTimecode: 29.97 counts nominal 30 frames per timecode second (non-drop)', function () {
  var seq = seqInfo('8475667200', { zeroPointTicks: '0' });
  assert.deepStrictEqual(T.offsetFromTimecode('00:00:01:00', seq).data, { ticks: String(frames(30, TPF_2997)) });
  assert.deepStrictEqual(T.offsetFromTimecode('00:01:00:00', seq).data, { ticks: String(frames(1800, TPF_2997)) });
});

test('offsetFromTimecode: drop-frame skips frame numbers at the start of each non-tenth minute', function () {
  // A drop-frame sequence starting at 01:00:00;00 has its zeroPoint at frame 107,892.
  var seq = seqInfo('8475667200', { zeroPointTicks: String(frames(107892, TPF_2997)) });
  assert.deepStrictEqual(T.offsetFromTimecode('01:00:00;00', seq).data, { ticks: '0' });
  var zero = seqInfo('8475667200', { zeroPointTicks: '0' });
  assert.deepStrictEqual(T.offsetFromTimecode('00:01:00;02', zero).data, { ticks: String(frames(1800, TPF_2997)) });
  assert.deepStrictEqual(T.offsetFromTimecode('00:10:00;00', zero).data, { ticks: String(frames(17982, TPF_2997)) });
  assert.strictEqual(T.offsetFromTimecode('00:01:00;00', zero).ok, false);
  assert.strictEqual(T.offsetFromTimecode('00:01:00;01', zero).ok, false);
  assert.strictEqual(T.offsetFromTimecode('00:10:00;00', zero).ok, true);
});

test('offsetFromTimecode: timecodes the timeline cannot show are rejected', function () {
  var seq25 = hostFixture('sequence-25');
  ['', 'abc', '1:2:3', '01:00:00', '01:60:00:00', '01:00:60:00', '01:00:00:25', '01:00:00;00']
    .forEach(function (text) {
      var res = T.offsetFromTimecode(text, seq25);
      assert.strictEqual(res.ok, false, text);
      assert.strictEqual(typeof res.error, 'string');
    });
  assert.strictEqual(T.offsetFromTimecode('01:00:00:00', { hasActiveSequence: false }).ok, false);
});

test('offsetFromTimecode feeds mapCues', function () {
  var seq = hostFixture('sequence-25');
  var offset = T.offsetFromTimecode('01:02:00:00', seq); // media frame 0 at 120 s into the sequence
  var res = T.mapCues({ cues: [cue('a', 10, 5)], sequence: seq, manualOffsetTicks: offset.data.ticks });
  assert.strictEqual(res.data.cues[0].anchorTicks, String(snapBig(ticksOf(130), TPF_25)));
});

// ==========================================================================================
// Robustness and the host contract
// ==========================================================================================

test('unknown fields on host data and cues are ignored', function () {
  var sequence = seqInfo('8475667200', { sequenceID: 'abc-123', somethingNew: [1, 2] });
  var segments = {
    matched: true,
    sequenceID: 'abc-123',
    extra: { x: 1 },
    segments: [seg(0, 100, 0, { clipID: 'zz', color: 'red' })],
    unsupported: []
  };
  var plain = map([cue('a', 10, 3)], segData([seg(0, 100, 0)]), seqInfo('8475667200'));
  var withExtras = map([cue('a', 10, 3, { future_field: true })], segments, sequence);
  assert.deepStrictEqual(withExtras, plain);
});

test('inputs are not modified', function () {
  var cues = deepFreeze([cue('a', 100, 10, { flags: ['low_confidence'] }), cue('b', 105, 10)]);
  var segments = deepFreeze(segData([seg(0, 3000, 0)]));
  var sequence = deepFreeze(seqInfo('8475667200'));
  var res = T.mapCues({ cues: cues, sequence: sequence, segments: segments });
  assert.strictEqual(res.ok, true);
});

test('an empty cue list maps to an empty result', function () {
  var data = map([], hostFixture('segments-single'), SEQ_2997);
  assert.deepStrictEqual(data.cues, []);
  assert.strictEqual(data.summary.total, 0);
});

test('unusable segments are skipped with a warning rather than guessed at', function () {
  var good = seg(0, 100, 0);
  var badEnd = seg(0, 100, 0);
  badEnd.seqEndTicks = badEnd.seqStartTicks;
  var badType = seg(0, 100, 0);
  badType.inPointTicks = 12345;
  var negIn = seg(0, 100, 0);
  negIn.inPointTicks = '-5';
  var data = map([cue('a', 10, 3)], { matched: true, segments: [badEnd, good, badType, negIn, null], unsupported: [] }, SEQ_2997);
  assert.strictEqual(data.cues[0].placed, true);
  assert.strictEqual(data.summary.warnings.length, 4);
  assert.strictEqual(data.summary.segmentCount, 1);
});

test('errors are returned, not thrown', function () {
  var cues = [cue('a', 10, 3)];
  var segments = segData([seg(0, 100, 0)]);
  var cases = [
    [{ cues: cues, sequence: null, segments: segments }, /Open a sequence/],
    [{ cues: cues, sequence: { hasActiveSequence: false }, segments: segments }, /Open a sequence/],
    [{ cues: cues, sequence: seqInfo('0'), segments: segments }, /positive/],
    [{ cues: cues, sequence: seqInfo('29.97'), segments: segments }, /whole ticks/],
    [{ cues: cues, sequence: { hasActiveSequence: true, frameRate: 29.97 }, segments: segments }, /timebase/],
    [{ cues: cues, sequence: SEQ_2997 }, /segment data/],
    [{ cues: cues, sequence: SEQ_2997, manualOffsetTicks: 'soon' }, /manualOffsetTicks/],
    [{ cues: [cue('bad', NaN, 3)], sequence: SEQ_2997, segments: segments }, /cue bad/],
    [{ cues: [cue('neg', -1, 3)], sequence: SEQ_2997, segments: segments }, /negative/]
  ];
  cases.forEach(function (c) {
    var res = T.mapCues(c[0]);
    assert.strictEqual(res.ok, false);
    assert.match(res.error, c[1]);
  });
  assert.strictEqual(T.mapCues().ok, false);
  assert.strictEqual(T.buildMap(undefined).ok, false);
});

test('ticks beyond exact numeric range fail loudly instead of losing precision', function () {
  var huge = seg(0, 100, 0);
  huge.seqStartTicks = '9007199254740990';
  huge.seqEndTicks = '9007199254741990';
  var res = T.mapCues({ cues: [cue('a', 10, 3)], sequence: SEQ_2997, segments: { matched: true, segments: [huge], unsupported: [] } });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.data.summary.segmentCount, 0);
  var tooLong = seg(0, 100, 0);
  tooLong.seqStartTicks = '9007199254740000';
  tooLong.seqEndTicks = '9007199254740900';
  var res2 = T.mapCues({ cues: [cue('a', 0, 3)], sequence: SEQ_2997, segments: { matched: true, segments: [tooLong], unsupported: [] } });
  assert.strictEqual(res2.ok, false);
  assert.match(res2.error, /out of range/);
});

test('results carry tick strings, never numbers', function () {
  var data = map([cue('a', 100, 10), cue('b', 105, 10)], hostFixture('segments-single'), SEQ_2997);
  data.cues.forEach(function (r) {
    ['anchorTicks', 'endTicks', 'naturalEndTicks', 'durationTicks'].forEach(function (k) {
      assert.strictEqual(typeof r[k], 'string', k);
      assert.match(r[k], /^\d+$/);
    });
  });
});
