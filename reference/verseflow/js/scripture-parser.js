/**
 * scripture-parser.js — parses a scripture .txt file into an array of Scripture objects.
 * Pure function; no DOM or Adobe dependencies.
 */
(function () {
  'use strict';

  // Matches a reference line: optional leading digit, book name, chapter:verse[-end], (TRANS)
  var REFERENCE_RE = /^((?:\d+\s+)?[A-Za-z][A-Za-z ]*?\s+\d+:\d+(?:-\d+)?)\s*\(([A-Za-z0-9]+)\)\s*$/;

  /**
   * parseScriptures(text) -> Scripture[]
   *
   * Scripture = {
   *   reference : string,   // full reference line verbatim
   *   translation: string,  // e.g. "NKJV"
   *   body      : string,   // verse lines joined with single space, verse numbers kept
   *   wordCount : number,
   *   rawIndex  : number    // 0-based position in file
   * }
   */
  function parseScriptures(text) {
    var lines = text.split(/\r?\n/);
    var results = [];
    var current = null;
    var skippedLines = 0;

    for (var i = 0; i < lines.length; i++) {
      var rawLine = lines[i];
      var line = rawLine.trim();

      if (line === '') {
        // blank / whitespace-only → entry boundary
        if (current) {
          results.push(_finalize(current));
          current = null;
        }
        continue;
      }

      var m = REFERENCE_RE.exec(line);
      if (m) {
        // new reference line
        if (current) {
          results.push(_finalize(current));
        }
        current = {
          reference: line,
          translation: m[2],
          bodyLines: [],
          rawIndex: results.length
        };
      } else {
        if (current) {
          current.bodyLines.push(line);
        } else {
          skippedLines++;
          console.warn('[VerseFlow parser] Skipping stray line before first reference:', line);
        }
      }
    }

    // flush last entry
    if (current) {
      results.push(_finalize(current));
    }

    if (skippedLines > 0) {
      console.warn('[VerseFlow parser] Total stray lines skipped: ' + skippedLines);
    }

    return results;
  }

  function _finalize(entry) {
    var body = entry.bodyLines.join(' ').replace(/\s+/g, ' ').trim();
    var wordCount = body === '' ? 0 : body.split(/\s+/).length;
    return {
      reference: entry.reference,
      translation: entry.translation,
      body: body,
      wordCount: wordCount,
      rawIndex: entry.rawIndex
    };
  }

  window.VFParser = { parseScriptures: parseScriptures };
})();
