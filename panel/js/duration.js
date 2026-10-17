(function (root) {
  'use strict';

  // duration.js - reading-speed duration model, ported from VerseFlow
  // (reference/verseflow/js/duration.js) with its constants and function names kept. Pure
  // functions; no DOM or Adobe dependencies. Tick maths for the sequence lives in timemap.js; the
  // string-returning secondsToTicks here is the VerseFlow original, kept for parity.

  var READING_WPM     = 160;
  var ANIMATION_PAD_S = 1.5;
  var MIN_DURATION_S  = 3;
  var MAX_DURATION_S  = 20;
  var TICKS_PER_SECOND = 254016000000;

  /**
   * resolveDurationSeconds(scripture, overrideSec) -> number
   * overrideSec: number (fixed mode) or null/undefined (auto mode).
   */
  function resolveDurationSeconds(scripture, overrideSec) {
    if (overrideSec !== null && overrideSec !== undefined && !isNaN(overrideSec)) {
      return overrideSec;
    }
    var readingSec = (scripture.wordCount / READING_WPM) * 60;
    var raw = readingSec + ANIMATION_PAD_S;
    var rounded = Math.round(raw * 10) / 10;
    return Math.min(MAX_DURATION_S, Math.max(MIN_DURATION_S, rounded));
  }

  /**
   * secondsToTicks(sec) -> string
   * Returns tick count as a string to avoid float representation issues.
   */
  function secondsToTicks(sec) {
    return String(Math.round(sec * TICKS_PER_SECOND));
  }

  /**
   * ticksToSeconds(ticksStr) -> number
   */
  function ticksToSeconds(ticksStr) {
    return Number(ticksStr) / TICKS_PER_SECOND;
  }

  var Duration = {
    READING_WPM: READING_WPM,
    ANIMATION_PAD_S: ANIMATION_PAD_S,
    MIN_DURATION_S: MIN_DURATION_S,
    MAX_DURATION_S: MAX_DURATION_S,
    TICKS_PER_SECOND: TICKS_PER_SECOND,
    resolveDurationSeconds: resolveDurationSeconds,
    secondsToTicks: secondsToTicks,
    ticksToSeconds: ticksToSeconds
  };

  if (typeof module !== 'undefined' && module.exports) { module.exports = Duration; }
  else { root.VSDuration = Duration; }
})(this);
