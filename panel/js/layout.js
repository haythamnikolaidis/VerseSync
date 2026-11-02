(function (root) {
  'use strict';

  // layout.js - wraps scripture text and splits a long passage across graphics (docs/15). Pure
  // functions; no DOM or Premiere dependencies. The Cue Document's body is never changed: layout
  // happens at insert time, so the settings can change after analysis (docs/15 §2).

  var Timemap = root.VSTimemap || (typeof require !== 'undefined' ? require('./timemap.js') : undefined);

  function wordsOf(text) {
    return String(text === null || text === undefined ? '' : text).split(/\s+/).filter(function (w) {
      return w !== '';
    });
  }

  // docs/15 §3, a port of VerseFlow's _wrapText: split on whitespace, add words to the line while
  // it stays within maxChars, join the lines with "\n". A word longer than maxChars gets its own
  // line. maxChars <= 0 (or not a number) returns the text unchanged.
  function wrapText(text, maxChars) {
    var source = text === null || text === undefined ? '' : String(text);
    if (!(maxChars > 0)) { return source; }
    var lines = [];
    var line = '';
    wordsOf(source).forEach(function (word) {
      if (line === '') {
        line = word;
      } else if (line.length + 1 + word.length <= maxChars) {
        line += ' ' + word;
      } else {
        lines.push(line);
        line = word;
      }
    });
    if (line !== '') { lines.push(line); }
    return lines.join('\n');
  }

  function isVerseNumber(n) {
    return typeof n === 'number' && isFinite(n) && n >= 1 && Math.floor(n) === n;
  }

  // docs/15 §3. Splits a multi-verse body at its verse numbers. Looks only for the next expected
  // number, `verse`, `verse + 1`, ... `verse_end`, as a whole word, so "seven 7" starts a chunk only
  // when 7 really is next. Text before the first number joins the first chunk, and a body that
  // leaves the first number off still splits at the second. A chapter-less, single-verse or
  // out-of-range reference gives one chunk. Chunk k always begins on verse `verse + k`.
  function verseChunks(body, reference) {
    var text = body === null || body === undefined ? '' : String(body);
    var ref = reference || {};
    var first = ref.verse;
    var last = ref.verse_end;
    if (!isVerseNumber(first) || !isVerseNumber(last) || last <= first) { return [text]; }

    var chunks = [[]];
    var expected = first;
    var started = false;
    wordsOf(text).forEach(function (word) {
      if (expected <= last && word === String(expected)) {
        if (expected !== first) { chunks.push([]); }
        expected++;
        started = true;
      } else if (!started && expected === first && chunks[0].length > 0 && word === String(first + 1)) {
        chunks.push([]);
        expected = first + 2;
        started = true;
      }
      chunks[chunks.length - 1].push(word);
    });
    return chunks.map(function (words) { return words.join(' '); });
  }

  // docs/15 §3. Returns [{ body, firstVerse }]: the graphics a cue becomes, each body already
  // wrapped with "\n". firstVerse is the verse a graphic begins on, or null when it begins part way
  // through a verse or the reference gives no verse range. Wrap off, or no usable maxChars, returns
  // the body unchanged as one graphic.
  function layoutCue(cue, settings) {
    var opts = settings || {};
    var body = cue.body === null || cue.body === undefined ? '' : String(cue.body);
    var maxChars = opts.wrapChars;
    if (!opts.wrapEnabled || !(maxChars > 0)) { return [{ body: body, firstVerse: null }]; }
    var limit = opts.maxLines > 0 ? Math.max(1, Math.floor(opts.maxLines)) : Infinity;

    var ref = cue.reference || {};
    var byVerse = isVerseNumber(ref.verse) && isVerseNumber(ref.verse_end) && ref.verse_end > ref.verse;
    var parts = [];
    var current = null;

    function lineCount(text) { return wrapText(text, maxChars).split('\n').length; }
    function flush() {
      if (current) {
        parts.push({ body: wrapText(current.text, maxChars), firstVerse: current.firstVerse });
        current = null;
      }
    }

    verseChunks(body, ref).forEach(function (chunk, k) {
      if (current) {
        var joined = current.text + ' ' + chunk;
        if (lineCount(joined) <= limit) {
          current.text = joined;
          return;
        }
        flush();
      }
      current = { text: chunk, firstVerse: byVerse ? ref.verse + k : null };
      // A chunk that alone exceeds the limit is cut at the last line that fits and carries on in
      // the next graphic, which starts part way through the verse.
      var lines = wrapText(chunk, maxChars).split('\n');
      while (lines.length > limit) {
        parts.push({ body: lines.slice(0, limit).join('\n'), firstVerse: current.firstVerse });
        lines = lines.slice(limit);
        current = { text: lines.join(' '), firstVerse: null };
      }
    });
    flush();
    return parts.length > 0 ? parts : [{ body: body, firstVerse: null }];
  }

  // Whole frames in a number of seconds. Ticks come from VSTimemap.secondsToTicks (R-11).
  function secondsToFrames(seconds, frame) {
    return Math.round(Timemap.secondsToTicks(seconds) / frame);
  }

  // The difference of two tick strings. Both are exact integers well inside 2^53 (docs/05 §1), as
  // timemap.js itself relies on.
  function diffTicks(later, earlier) {
    return String(Number(later) - Number(earlier));
  }

  // The recorded start of each part 1..n-1 in frames from the cue's start, null where the part has
  // no recorded time. Returns null altogether when a recorded time is unusable: not increasing or
  // not inside the cue (docs/15 §4).
  function recordedFrames(parts, offsets, frame, totalFrames) {
    var out = [0];
    var previous = 0;
    var any = false;
    for (var i = 1; i < parts.length; i++) {
      var verse = parts[i].firstVerse;
      var seconds = verse === null || verse === undefined || !offsets ? undefined : offsets[String(verse)];
      if (typeof seconds !== 'number' || !isFinite(seconds)) {
        out.push(null);
      } else {
        var f = secondsToFrames(seconds, frame);
        if (f <= previous || f >= totalFrames) { return null; }
        out.push(f);
        previous = f;
        any = true;
      }
    }
    return any ? out : [0];
  }

  // Frame offsets of parts 1..n-1. A part without a recorded time takes its share of the words
  // between the recorded starts on either side (or the cue's start and end), so with no recorded
  // times at all this is plain word share. Kept strictly increasing and inside the cue wherever the
  // cue is long enough to allow it.
  function partFrames(parts, offsets, frame, totalFrames) {
    var counts = parts.map(function (p) { return Math.max(wordsOf(p.body).length, 1); });
    var known = recordedFrames(parts, offsets, frame, totalFrames) || [0];
    var frames = [0];
    var a = 0;
    for (var i = 1; i <= parts.length; i++) {
      if (i < parts.length && typeof known[i] !== 'number') { continue; }
      var fb = i === parts.length ? totalFrames : known[i];
      var span = 0;
      var k;
      for (k = a; k < i; k++) { span += counts[k]; }
      var before = 0;
      for (k = a + 1; k < i; k++) {
        before += counts[k - 1];
        frames[k] = frames[a] + Math.round((fb - frames[a]) * before / span);
      }
      frames[i] = fb;
      a = i;
    }
    var out = [];
    for (var j = 1; j < parts.length; j++) {
      var previous = j === 1 ? 0 : out[j - 2];
      var upper = totalFrames - (parts.length - j);
      out.push(Math.max(Math.min(Math.max(frames[j], previous + 1), upper), previous));
    }
    return out;
  }

  // docs/15 §4. [{ atTicks, durationTicks }] (strings) for the parts layoutCue returned, laid
  // back to back across the cue's placed time. Part 1 starts at atTicks, each part ends where the
  // next begins, the last ends at the cue's end, and the durations add up to durationTicks exactly.
  // Later starts are frame-snapped, and come from cue.verse_offsets_s (relative to the anchor, so a
  // nudged cue moves its parts) when those are valid, otherwise from word share.
  function timeParts(parts, cue, atTicks, durationTicks, frameTicks) {
    if (parts.length <= 1) { return [{ atTicks: atTicks, durationTicks: durationTicks }]; }
    var frame = Number(frameTicks);
    var totalFrames = Math.floor(Number(durationTicks) / frame);
    var frames = partFrames(parts, cue && cue.verse_offsets_s, frame, totalFrames);

    var starts = [atTicks];
    frames.forEach(function (f) {
      starts.push(Timemap.snapToFrame(Timemap.shiftFrames(atTicks, f, frameTicks), frameTicks));
    });
    var end = String(Number(atTicks) + Number(durationTicks));
    return starts.map(function (start, i) {
      return { atTicks: start, durationTicks: diffTicks(i + 1 < starts.length ? starts[i + 1] : end, start) };
    });
  }

  var Layout = {
    wrapText: wrapText,
    verseChunks: verseChunks,
    layoutCue: layoutCue,
    timeParts: timeParts
  };

  if (typeof module !== 'undefined' && module.exports) { module.exports = Layout; }
  // Always set the global too (see bridge.js): CEP's mixed-context leaks `module` into the
  // browser window, so this can't be an else-branch without breaking Premiere.
  root.VSLayout = Layout;
})(this);
