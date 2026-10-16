(function (root) {
  'use strict';

  // Source-time to sequence-time mapping (docs/05). This file owns all tick maths (risk R-11):
  // ticks are Numbers inside the module, exact up to 2^53 (about 9.9 hours of sequence time), and
  // Strings when they cross a module boundary.

  var TICKS_PER_SECOND = 254016000000;

  function secondsToTicks(s) {
    return Math.round(s * TICKS_PER_SECOND);
  }

  function ticksToSeconds(t) {
    return Number(t) / TICKS_PER_SECOND;
  }

  // docs/05 §7, verbatim. ticksPerFrame is sequence.timebase as Premiere reports it; it is never
  // computed from a float frame rate, which is wrong for 23.976 and 29.97 (docs/05 §1).
  function snapToFrame(ticks, timebase) {
    var ticksPerFrame = Number(timebase);
    return String(Math.round(Number(ticks) / ticksPerFrame) * ticksPerFrame);
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  // Display timecode, HH:MM:SS:FF, non-drop-frame. seqInfo carries timebase and zeroPointTicks
  // as strings (docs/08 §3). zeroPoint is added here and only here: it is display-only, and
  // adding it into placement maths would shift every graphic by the sequence start (docs/05 §1).
  // The label rate is the rounded frame rate (24 for 23.976, 30 for 29.97), while frames are
  // counted from the exact timebase.
  function timecode(ticks, seqInfo) {
    var total = Number(ticks) + Number(seqInfo.zeroPointTicks || 0);
    var frames = Math.floor(total / Number(seqInfo.timebase));
    var fps = Math.round(seqInfo.frameRate);
    var ff = frames % fps;
    var totalSeconds = Math.floor(frames / fps);
    var ss = totalSeconds % 60;
    var mm = Math.floor(totalSeconds / 60) % 60;
    var hh = Math.floor(totalSeconds / 3600);
    return pad2(hh) + ':' + pad2(mm) + ':' + pad2(ss) + ':' + pad2(ff);
  }

  // docs/05 §5.1. Segments arrive from VS.getMediaSegments (docs/08 §4) with tick fields as
  // strings. Each one is a linear window onto the source: it covers source ticks
  // [inPoint, inPoint + length), where length = seqEnd - seqStart. Segments are ordered by
  // seqStart (ties keep their input order) so that "earliest placement" is the first match.
  // Speed-changed segments arrive in `unsupported`, which is kept on the map for callers that need
  // to explain a cut, but they are never part of the linear mapping (docs/05 §5.3).
  function toWindow(seg, index) {
    var seqStart = Number(seg.seqStartTicks);
    return {
      seqStart: seqStart,
      seqEnd: Number(seg.seqEndTicks),
      inPoint: Number(seg.inPointTicks),
      length: Number(seg.seqEndTicks) - seqStart,
      index: index
    };
  }

  function buildMap(segmentsResponse) {
    var response = segmentsResponse || {};
    var windows = (response.segments || []).map(toWindow);
    windows.sort(function (a, b) {
      return a.seqStart - b.seqStart || a.index - b.index;
    });
    return {
      matched: response.matched === true,
      segments: windows,
      unsupported: (response.unsupported || []).map(toWindow)
    };
  }

  // docs/05 §5.2. Returns null when the source time is cut from the edit. Otherwise ticks is the
  // earliest placement and placements lists every distinct sequence position, earliest first. A
  // video clip and its linked audio clip share a seqStart and are one placement, not two: counting
  // them twice would flag every ordinary cue as multiple_placements.
  function toSequence(map, tSrcSeconds) {
    var tSrc = secondsToTicks(tSrcSeconds);
    var placements = [];
    for (var i = 0; i < map.segments.length; i++) {
      var seg = map.segments[i];
      if (seg.inPoint <= tSrc && tSrc < seg.inPoint + seg.length) {
        var tSeq = seg.seqStart + (tSrc - seg.inPoint);
        if (placements.indexOf(tSeq) === -1) { placements.push(tSeq); }
      }
    }
    if (placements.length === 0) { return null; }
    return { ticks: placements[0], placements: placements };
  }

  // Inverse of the mapping, in source seconds, for the first segment containing seqTicks. Null
  // outside every segment.
  function toSource(map, seqTicks) {
    var tSeq = Number(seqTicks);
    for (var i = 0; i < map.segments.length; i++) {
      var seg = map.segments[i];
      if (seg.seqStart <= tSeq && tSeq < seg.seqEnd) {
        return ticksToSeconds(seg.inPoint + (tSeq - seg.seqStart));
      }
    }
    return null;
  }

  // docs/05 §2 defaults. Seconds, converted to ticks per call.
  var MIN_VISIBLE_S = 2.0;
  var OVERLAP_GAP_S = 0.25;

  // docs/05 §8. items are [{id, anchor, end, enabled?}] with Number ticks; an item with
  // enabled === false takes no part and is returned untouched. One sweep in anchor order (ties
  // keep input order): when a runs into b, a is truncated to snap(b.anchor - gap) if that still
  // lasts min_visible, otherwise both are flagged `overlap`. cfg may carry minVisibleS and
  // overlapGapS. Returns { [id]: {anchor, end, flags} }.
  function resolveOverlaps(items, timebase, cfg) {
    var config = cfg || {};
    var minVisible = secondsToTicks(config.minVisibleS === undefined ? MIN_VISIBLE_S : config.minVisibleS);
    var gap = secondsToTicks(config.overlapGapS === undefined ? OVERLAP_GAP_S : config.overlapGapS);
    var result = {};
    var active = [];
    items.forEach(function (item, index) {
      var enabled = item.enabled !== false;
      var entry = {
        anchor: enabled ? Number(snapToFrame(item.anchor, timebase)) : item.anchor,
        end: enabled ? Number(snapToFrame(item.end, timebase)) : item.end,
        flags: []
      };
      result[item.id] = entry;
      if (enabled) { active.push({ entry: entry, index: index }); }
    });
    active.sort(function (x, y) {
      return x.entry.anchor - y.entry.anchor || x.index - y.index;
    });
    function addFlag(entry, flag) {
      if (entry.flags.indexOf(flag) === -1) { entry.flags.push(flag); }
    }
    for (var i = 0; i + 1 < active.length; i++) {
      var a = active[i].entry;
      var b = active[i + 1].entry;
      if (a.end > b.anchor) {
        var proposedEnd = Number(snapToFrame(b.anchor - gap, timebase));
        if (proposedEnd - a.anchor >= minVisible) {
          a.end = proposedEnd;
          addFlag(a, 'truncated');
        } else {
          addFlag(a, 'overlap');
          addFlag(b, 'overlap');
        }
      }
    }
    return result;
  }

  var Timemap = {
    MIN_VISIBLE_S: MIN_VISIBLE_S,
    OVERLAP_GAP_S: OVERLAP_GAP_S,
    resolveOverlaps: resolveOverlaps,
    TICKS_PER_SECOND: TICKS_PER_SECOND,
    secondsToTicks: secondsToTicks,
    ticksToSeconds: ticksToSeconds,
    snapToFrame: snapToFrame,
    timecode: timecode,
    buildMap: buildMap,
    toSequence: toSequence,
    toSource: toSource
  };

  if (typeof module !== 'undefined' && module.exports) { module.exports = Timemap; }
  else { root.VSTimemap = Timemap; }
})(this);
