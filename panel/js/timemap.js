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

  var Timemap = {
    TICKS_PER_SECOND: TICKS_PER_SECOND,
    secondsToTicks: secondsToTicks,
    ticksToSeconds: ticksToSeconds,
    snapToFrame: snapToFrame,
    timecode: timecode
  };

  if (typeof module !== 'undefined' && module.exports) { module.exports = Timemap; }
  else { root.VSTimemap = Timemap; }
})(this);
