/**
 * timemap.js — source time -> frame-snapped sequence time (docs/05 §5, §7, §8; T-28).
 *
 * Pure functions over plain data: no DOM, no CSInterface, no Premiere. It consumes
 *   - Cue Document cues (docs/07 §5): times in SOURCE SECONDS (source_anchor_s, source_duration_s)
 *   - VS.getSequenceInfo data (docs/08 §3): only `timebase` (and `zeroPointTicks`/`endTicks`
 *     where noted) is read
 *   - VS.getMediaSegments data (docs/08 §4): { matched, segments, unsupported }
 * and produces SEQUENCE TIME as tick strings. Fields it does not know (a newer host adds
 * `sequenceID`, for instance) are ignored.
 *
 * Time domains (docs/05 §1):
 *   source time   seconds, origin = start of the media file
 *   sequence time ticks (string), origin = start of the sequence
 *   display TC    sequence time PLUS zeroPoint — formatting only.
 * zeroPoint is never added into placement math: a sequence that starts at 01:00:00:00 still
 * has its first frame at tick 0 for importMGT, so adding it would shift every graphic by an
 * hour. It is subtracted only where a typed *display* timecode is converted (parseTimecode).
 *
 * Ticks-per-frame always comes from `timebase`. It is never derived from a float frame rate,
 * which is wrong for 23.976 and 29.97 and is exactly what produces cumulative drift.
 *
 * All tick arithmetic lives in the "Tick arithmetic" section below (risk R-11): values are
 * JS numbers, which are exact up to Number.MAX_SAFE_INTEGER (about 9.8 hours of sequence at
 * 254,016,000,000 ticks/s). Every operation goes through the checked helpers there, so a
 * value outside the safe range fails loudly instead of silently losing precision, and the
 * representation can be swapped for string/BigInt math in one place.
 *
 * buildMap, mapCues and offsetFromTimecode never throw: they return { ok: true, data } or
 * { ok: false, error }, like the bridge. snapToFrame is a plain helper and throws a TimemapError
 * on malformed input.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------------------

  var TICKS_PER_SECOND = 254016000000;
  var MAX_SAFE = 9007199254740991;

  // docs/05 §2 defaults for the two config keys this module consumes.
  var DEFAULT_OPTIONS = { overlap_gap_s: 0.25, min_visible_s: 2.0 };

  // Flags this module owns. They are recomputed on every call (Journey B recomputes from an
  // unchanged Cue Document), so any of them already present on an input cue is discarded.
  // `overlap` and `truncated` come from the §8 sweep; the other three from the §5 mapping.
  var OWNED_FLAGS = [
    'cut_from_edit', 'speed_change_unsupported', 'multiple_placements', 'overlap', 'truncated'
  ];

  // ---------------------------------------------------------------------------------------
  // Tick arithmetic (centralised — R-11). Nothing outside this section does math on ticks.
  // ---------------------------------------------------------------------------------------

  function TimemapError(message) {
    this.name = 'TimemapError';
    this.message = message;
    this.isTimemapError = true;
  }
  TimemapError.prototype = new Error();

  function fail(message) {
    throw new TimemapError(message);
  }

  function isIntegerNumber(n) {
    return typeof n === 'number' && isFinite(n) && Math.floor(n) === n;
  }

  // A tick value must stay inside the exactly-representable range.
  function checked(n, what) {
    if (!isIntegerNumber(n) || Math.abs(n) > MAX_SAFE) {
      fail('Tick value out of range (' + what + '). The sequence is too long for exact tick math.');
    }
    return n;
  }

  // Host tick strings -> number. Strictly an optionally-signed run of digits.
  function parseTicks(value, what) {
    if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
      fail('Expected whole ticks as a string for ' + what + '.');
    }
    return checked(Number(value), what);
  }

  function formatTicks(n) {
    checked(n, 'result');
    return String(n === 0 ? 0 : n);
  }

  // Seconds (float) -> whole ticks.
  function secondsToTicks(seconds, what) {
    if (typeof seconds !== 'number' || !isFinite(seconds)) {
      fail('Expected a number of seconds for ' + what + '.');
    }
    return checked(Math.round(seconds * TICKS_PER_SECOND), what);
  }

  function parseTimebase(value) {
    var n = parseTicks(value, 'timebase');
    if (n <= 0) {
      fail('The sequence timebase must be a positive number of ticks per frame.');
    }
    return n;
  }

  // docs/05 §7. Nearest frame boundary; exact halves round up.
  function snapNumber(ticks, ticksPerFrame) {
    return checked(Math.round(ticks / ticksPerFrame) * ticksPerFrame, 'snapped time');
  }

  // Smallest whole number of frames covering `ticks` (used for the overlap gap).
  function ceilToFrames(ticks, ticksPerFrame) {
    return checked(Math.ceil(ticks / ticksPerFrame) * ticksPerFrame, 'frame-aligned length');
  }

  // ---------------------------------------------------------------------------------------
  // Public tick helpers
  // ---------------------------------------------------------------------------------------

  /**
   * docs/05 §7: snap tick string `ticks` to the nearest frame boundary of `ticksPerFrame`
   * (the sequence `timebase`, as a string or number). Returns a tick string.
   */
  function snapToFrame(ticks, ticksPerFrame) {
    var tpf = parseTimebase(String(ticksPerFrame));
    return formatTicks(snapNumber(parseTicks(String(ticks), 'ticks'), tpf));
  }

  // ---------------------------------------------------------------------------------------
  // Building the map (docs/05 §5.1)
  // ---------------------------------------------------------------------------------------

  function trackRank(segment) {
    // A video placement is preferred over an audio one when both sit at the same time.
    return segment.trackType === 'audio' ? 1 : 0;
  }

  function compareSegments(a, b) {
    return (a.seqStart - b.seqStart) ||
      (trackRank(a) - trackRank(b)) ||
      (a.trackIndex - b.trackIndex) ||
      (a.order - b.order);
  }

  function isSpeedChanged(entry) {
    return entry.reason === 'speed_change' ||
      (typeof entry.speed === 'number' && entry.speed !== 1);
  }

  /**
   * Normalise the `data` of VS.getMediaSegments into a map the resolver can search.
   *
   * Returns { ok: true, data: map } where map =
   *   { matched, segments: [ { trackType, trackIndex, name, seqStart, length, inPoint, order } ],
   *     speedChanged: <count of unsupported speed-changed placements>,
   *     unsupported: [ { trackType, trackIndex, name, reason } ],
   *     warnings: [ string ] }
   *
   * A segment that cannot be used reliably is excluded rather than guessed at: reporting
   * nothing is better than reporting something wrong (T-24). Excluded segments are listed in
   * `warnings`.
   */
  function buildMap(hostData) {
    try {
      if (!hostData || typeof hostData !== 'object') {
        fail('No media segment data was supplied.');
      }
      var map = {
        matched: hostData.matched === true,
        segments: [],
        speedChanged: 0,
        unsupported: [],
        warnings: []
      };

      var supported = hostData.segments instanceof Array ? hostData.segments : [];
      var unsupported = hostData.unsupported instanceof Array ? hostData.unsupported : [];

      supported.forEach(function (raw, i) {
        var label = 'segments[' + i + ']';
        if (!raw || typeof raw !== 'object') {
          map.warnings.push(label + ' is not an object; ignored.');
          return;
        }
        if (isSpeedChanged(raw)) {
          // The host should have put this in `unsupported`; its in-point is not source time.
          map.speedChanged += 1;
          map.unsupported.push(describeUnsupported(raw, 'speed_change'));
          return;
        }
        var seqStart;
        var seqEnd;
        var inPoint;
        try {
          seqStart = parseTicks(raw.seqStartTicks, label + '.seqStartTicks');
          seqEnd = parseTicks(raw.seqEndTicks, label + '.seqEndTicks');
          inPoint = parseTicks(raw.inPointTicks, label + '.inPointTicks');
        } catch (e) {
          if (!e.isTimemapError) { throw e; }
          map.warnings.push(label + ' ignored: ' + e.message);
          return;
        }
        var length = checked(seqEnd - seqStart, label + ' length');
        if (length <= 0 || inPoint < 0) {
          map.warnings.push(label + ' ignored: it has no usable length or in-point.');
          return;
        }
        map.segments.push({
          trackType: raw.trackType === 'audio' ? 'audio' : 'video',
          trackIndex: isIntegerNumber(raw.trackIndex) ? raw.trackIndex : 0,
          name: typeof raw.name === 'string' ? raw.name : '',
          seqStart: seqStart,
          length: length,
          inPoint: inPoint,
          order: i
        });
      });

      unsupported.forEach(function (raw) {
        if (!raw || typeof raw !== 'object') { return; }
        if (isSpeedChanged(raw)) {
          map.speedChanged += 1;
          map.unsupported.push(describeUnsupported(raw, 'speed_change'));
        } else {
          map.unsupported.push(describeUnsupported(raw, raw.reason));
        }
      });

      map.segments.sort(compareSegments);
      return { ok: true, data: map };
    } catch (e) {
      if (e && e.isTimemapError) { return { ok: false, error: e.message }; }
      throw e;
    }
  }

  function describeUnsupported(raw, reason) {
    return {
      trackType: raw.trackType === 'audio' ? 'audio' : 'video',
      trackIndex: isIntegerNumber(raw.trackIndex) ? raw.trackIndex : 0,
      name: typeof raw.name === 'string' ? raw.name : '',
      reason: typeof reason === 'string' ? reason : 'unresolved'
    };
  }

  // ---------------------------------------------------------------------------------------
  // Resolving one source time (docs/05 §5.2)
  // ---------------------------------------------------------------------------------------

  /**
   * Every segment whose window [inPoint, inPoint + length) contains `srcTicks`, mapped:
   *   t_seq = seqStart + (t_src - inPoint)
   * Half-open: a time exactly at the end of a window belongs to the next one, not this one.
   * Returns [ { trackType, trackIndex, rawTicks, segment } ] ordered earliest seqStart first.
   */
  function candidatesFor(map, srcTicks) {
    var found = [];
    map.segments.forEach(function (seg) {
      if (seg.inPoint <= srcTicks && srcTicks < checked(seg.inPoint + seg.length, 'window end')) {
        found.push({
          trackType: seg.trackType,
          trackIndex: seg.trackIndex,
          rawTicks: checked(seg.seqStart + (srcTicks - seg.inPoint), 'sequence time'),
          segment: seg
        });
      }
    });
    return found;
  }

  // ---------------------------------------------------------------------------------------
  // Placing cues
  // ---------------------------------------------------------------------------------------

  function placementFrom(rawAnchor, durationTicks, ticksPerFrame, source) {
    var anchor = snapNumber(rawAnchor, ticksPerFrame);
    var end = snapNumber(checked(rawAnchor + durationTicks, 'cue end'), ticksPerFrame);
    if (end <= anchor) {
      // A cue is always at least one whole frame long.
      end = checked(anchor + ticksPerFrame, 'cue end');
    }
    return {
      anchor: anchor,
      end: end,
      trackType: source.trackType,
      trackIndex: source.trackIndex
    };
  }

  function placementView(p) {
    return {
      anchorTicks: formatTicks(p.anchor),
      endTicks: formatTicks(p.end),
      durationTicks: formatTicks(p.end - p.anchor),
      trackType: p.trackType,
      trackIndex: p.trackIndex
    };
  }

  function withoutOwnedFlags(flags) {
    var out = [];
    (flags instanceof Array ? flags : []).forEach(function (f) {
      if (OWNED_FLAGS.indexOf(f) === -1 && out.indexOf(f) === -1) { out.push(f); }
    });
    return out;
  }

  function newResult(cue, index) {
    return {
      id: cue.id,
      index: index,
      enabled: cue.enabled !== false,
      flags: withoutOwnedFlags(cue.flags),
      placed: false,
      approximate: false,
      anchorTicks: null,
      endTicks: null,
      naturalEndTicks: null,
      durationTicks: null,
      trackType: null,
      trackIndex: null,
      placementAlternatives: [],
      // Working copies as numbers for the overlap sweep; stripped before returning.
      _anchor: null,
      _end: null,
      _naturalEnd: null
    };
  }

  function addFlag(result, flag) {
    if (result.flags.indexOf(flag) === -1) { result.flags.push(flag); }
  }

  function setPlacement(result, p) {
    var view = placementView(p);
    result.placed = true;
    result.anchorTicks = view.anchorTicks;
    result.endTicks = view.endTicks;
    result.naturalEndTicks = view.endTicks;
    result.durationTicks = view.durationTicks;
    result.trackType = p.trackType;
    result.trackIndex = p.trackIndex;
    result._anchor = p.anchor;
    result._end = p.end;
    result._naturalEnd = p.end;
  }

  // Segment mode: resolve a cue against the map.
  function placeFromSegments(result, srcTicks, durationTicks, map, tpf) {
    var candidates = candidatesFor(map, srcTicks);
    // Distinct placements only: the video and audio halves of one linked clip map to the same
    // sequence moment and are one placement, not two (docs/05 §5.2 counts occurrences in the
    // edit, not tracks).
    var placements = [];
    var seen = {};
    candidates.forEach(function (c) {
      var p = placementFrom(c.rawTicks, durationTicks, tpf, c);
      if (!seen.hasOwnProperty(p.anchor)) {
        seen[p.anchor] = true;
        placements.push(p);
      }
    });

    if (placements.length === 0) {
      // Not covered by any usable window. An unusable speed-changed use of the media may
      // contain it (its in-point is not source time, so that cannot be ruled in or out).
      if (map.speedChanged > 0) {
        addFlag(result, 'speed_change_unsupported');
      } else {
        addFlag(result, 'cut_from_edit');
      }
      result.enabled = false;
      return;
    }

    setPlacement(result, placements[0]);
    if (placements.length > 1) {
      addFlag(result, 'multiple_placements');
      result.placementAlternatives = placements.slice(1).map(placementView);
    }
  }

  // Manual-offset mode (docs/05 §5.4): t_seq = offset + t_src, for everything.
  function placeFromOffset(result, srcTicks, durationTicks, offset, tpf, endTicks) {
    var raw = checked(offset + srcTicks, 'sequence time');
    var p = placementFrom(raw, durationTicks, tpf, { trackType: null, trackIndex: null });
    result.approximate = true;
    if (p.anchor < 0 || (endTicks !== null && p.anchor >= endTicks)) {
      addFlag(result, 'cut_from_edit');
      result.enabled = false;
      return;
    }
    setPlacement(result, p);
  }

  // ---------------------------------------------------------------------------------------
  // Overlap resolution (docs/05 §8)
  // ---------------------------------------------------------------------------------------

  /**
   * Sort the cues that will actually be inserted (placed and enabled) by anchor and sweep
   * once over consecutive pairs. Mutates the result objects produced by mapCues. Starting
   * every sweep from each cue's natural end makes it safe to repeat after the editor nudges
   * an anchor or toggles a cue.
   *
   * Disabled cues are skipped: they will not be inserted, so they must neither shorten nor
   * flag a cue that will.
   *
   * a.end > b.anchor  ->  truncate a to (b.anchor - gap) if that leaves >= min_visible,
   *                        else flag BOTH `overlap` (the editor decides — do not be clever).
   * Cues that exactly abut (a.end == b.anchor) do not overlap.
   */
  function sweepOverlaps(results, tpf, options) {
    var gapTicks = ceilToFrames(secondsToTicks(options.overlap_gap_s, 'overlap_gap_s'), tpf);
    var minVisible = secondsToTicks(options.min_visible_s, 'min_visible_s');

    var live = results.filter(function (r) { return r.placed && r.enabled; });
    live.forEach(function (r) {
      r._end = r._naturalEnd;
      r.flags = r.flags.filter(function (f) { return f !== 'overlap' && f !== 'truncated'; });
    });
    live.sort(function (a, b) { return (a._anchor - b._anchor) || (a.index - b.index); });

    for (var i = 0; i + 1 < live.length; i++) {
      var a = live[i];
      var b = live[i + 1];
      if (a._end > b._anchor) {
        var proposedEnd = checked(b._anchor - gapTicks, 'truncated end');
        if (proposedEnd - a._anchor >= minVisible) {
          a._end = proposedEnd;
          addFlag(a, 'truncated');
        } else {
          addFlag(a, 'overlap');
          addFlag(b, 'overlap');
        }
      }
    }

    results.forEach(function (r) {
      if (r.placed) {
        r.endTicks = formatTicks(r._end);
        r.durationTicks = formatTicks(r._end - r._anchor);
      }
    });
  }

  // Panel-owned flags in a fixed order after the sidecar's own, so output is deterministic.
  function orderFlags(result) {
    var own = OWNED_FLAGS.filter(function (f) { return result.flags.indexOf(f) !== -1; });
    result.flags = result.flags.filter(function (f) {
      return OWNED_FLAGS.indexOf(f) === -1;
    }).concat(own);
  }

  // ---------------------------------------------------------------------------------------
  // mapCues
  // ---------------------------------------------------------------------------------------

  function optionValue(options, key) {
    var v = options && options[key];
    return typeof v === 'number' && isFinite(v) && v >= 0 ? v : DEFAULT_OPTIONS[key];
  }

  /**
   * Convert Cue Document cues from source time to frame-snapped sequence time.
   *
   * args:
   *   cues             Cue Document cues (docs/07 §5). Not modified.
   *   sequence         `data` of VS.getSequenceInfo; `timebase` is required.
   *   segments         `data` of VS.getMediaSegments (segment mode).
   *   manualOffsetTicks  string; when present, manual-offset mode is used instead: the
   *                    sequence tick at which the media's frame 0 sits (may be negative).
   *                    `segments` is then ignored. See offsetFromTimecode.
   *   options          { overlap_gap_s: 0.25, min_visible_s: 2.0 }
   *
   * On success `data` is { cues: [ result ], summary }, `cues` in input order. Each result:
   *   id, index, enabled   enabled is false for cut_from_edit and speed_change_unsupported
   *   flags                sidecar flags kept; cut_from_edit, speed_change_unsupported,
   *                        multiple_placements, overlap, truncated recomputed
   *   placed               false when the cue has no sequence position (then the ticks and
   *                        track fields below are null)
   *   anchorTicks, endTicks, durationTicks   frame-snapped tick strings (end after truncation)
   *   naturalEndTicks      end before overlap truncation
   *   trackType, trackIndex  where the chosen placement sits (null in manual-offset mode)
   *   placementAlternatives  other placements of the same moment, same shape as the chosen
   *                        one (anchorTicks, endTicks, durationTicks, trackType, trackIndex);
   *                        only present for multiple_placements
   *   approximate          true for every cue produced by manual-offset mode
   */
  function mapCues(args) {
    try {
      args = args || {};
      var sequence = args.sequence;
      if (!sequence || typeof sequence !== 'object' || sequence.hasActiveSequence === false) {
        fail('Open a sequence in Premiere first.');
      }
      var tpf = parseTimebase(sequence.timebase);
      var cues = args.cues instanceof Array ? args.cues : [];
      var options = {
        overlap_gap_s: optionValue(args.options, 'overlap_gap_s'),
        min_visible_s: optionValue(args.options, 'min_visible_s')
      };

      var manual = args.manualOffsetTicks !== undefined && args.manualOffsetTicks !== null;
      var offset = 0;
      var seqEnd = null;
      var map = null;
      if (manual) {
        offset = parseTicks(args.manualOffsetTicks, 'manualOffsetTicks');
        if (typeof sequence.endTicks === 'string') {
          seqEnd = parseTicks(sequence.endTicks, 'endTicks');
        }
      } else {
        var built = buildMap(args.segments);
        if (!built.ok) { return built; }
        map = built.data;
      }

      var results = cues.map(function (cue, i) {
        var label = 'cue ' + (cue && cue.id !== undefined ? cue.id : i);
        if (!cue || typeof cue !== 'object') { fail('Cue ' + i + ' is not an object.'); }
        var result = newResult(cue, i);
        var src = secondsToTicks(cue.source_anchor_s, label + ' source_anchor_s');
        var dur = secondsToTicks(cue.source_duration_s, label + ' source_duration_s');
        if (src < 0 || dur < 0) { fail(label + ' has a negative time.'); }
        if (manual) {
          placeFromOffset(result, src, dur, offset, tpf, seqEnd);
        } else {
          placeFromSegments(result, src, dur, map, tpf);
        }
        return result;
      });

      sweepOverlaps(results, tpf, options);

      var summary = {
        mode: manual ? 'manual_offset' : 'segments',
        mediaMatched: manual ? null : map.matched,
        segmentCount: manual ? null : map.segments.length,
        total: results.length,
        placed: 0,
        cutFromEdit: 0,
        speedChangeUnsupported: 0,
        multiplePlacements: 0,
        truncated: 0,
        overlap: 0,
        approximate: manual,
        unsupported: manual ? [] : map.unsupported,
        warnings: manual ? [] : map.warnings
      };
      results.forEach(function (r) {
        orderFlags(r);
        if (r.placed) { summary.placed += 1; }
        if (r.flags.indexOf('cut_from_edit') !== -1) { summary.cutFromEdit += 1; }
        if (r.flags.indexOf('speed_change_unsupported') !== -1) { summary.speedChangeUnsupported += 1; }
        if (r.flags.indexOf('multiple_placements') !== -1) { summary.multiplePlacements += 1; }
        if (r.flags.indexOf('truncated') !== -1) { summary.truncated += 1; }
        if (r.flags.indexOf('overlap') !== -1) { summary.overlap += 1; }
        delete r._anchor;
        delete r._end;
        delete r._naturalEnd;
      });

      return { ok: true, data: { cues: results, summary: summary } };
    } catch (e) {
      if (e && e.isTimemapError) { return { ok: false, error: e.message }; }
      throw e;
    }
  }

  // ---------------------------------------------------------------------------------------
  // Manual offset: typed timecode -> sequence ticks (docs/05 §5.4)
  // ---------------------------------------------------------------------------------------

  /**
   * Convert the display timecode an editor reads off Premiere (HH:MM:SS:FF, or HH:MM:SS;FF
   * for drop-frame) into SEQUENCE ticks for mapCues' `manualOffsetTicks`.
   *
   * The timecode on screen includes the sequence's start offset (zeroPoint), so that offset is
   * subtracted here: 01:00:00:00 on a sequence that starts at 01:00:00:00 is tick 0. A timecode
   * before the sequence start gives a negative result, which is valid (the media's frame 0 can
   * sit before the first frame of the sequence when its head is trimmed).
   *
   * The frame count per timecode second is taken from the timebase (never from frameRate):
   * round(254016000000 / timebase) is 24, 25, 30, ... Drop-frame is accepted only for the
   * fractional 30/60 rates it exists for.
   */
  function offsetFromTimecode(text, sequence) {
    try {
      if (!sequence || typeof sequence !== 'object' || sequence.hasActiveSequence === false) {
        fail('Open a sequence in Premiere first.');
      }
      var tpf = parseTimebase(sequence.timebase);
      var m = /^\s*(\d{1,2}):(\d{2}):(\d{2})([:;])(\d{2})\s*$/.exec(String(text));
      if (!m) { fail('Enter a timecode like 01:00:00:00.'); }
      var h = Number(m[1]);
      var min = Number(m[2]);
      var s = Number(m[3]);
      var drop = m[4] === ';';
      var f = Number(m[5]);

      var nominal = Math.round(TICKS_PER_SECOND / tpf);
      if (min > 59 || s > 59 || f >= nominal) {
        fail('That timecode is not valid for a ' + nominal + ' frames-per-second timeline.');
      }

      var frames = ((h * 60 + min) * 60 + s) * nominal + f;
      if (drop) {
        var dropFrames = nominal === 30 ? 2 : nominal === 60 ? 4 : 0;
        var isFractional = nominal * tpf !== TICKS_PER_SECOND;
        if (dropFrames === 0 || !isFractional) {
          fail('Drop-frame timecode only applies to 29.97 and 59.94 timelines.');
        }
        if (s === 0 && f < dropFrames && min % 10 !== 0) {
          fail('That drop-frame timecode does not exist (frames are skipped at the start of the minute).');
        }
        var totalMinutes = h * 60 + min;
        frames -= dropFrames * (totalMinutes - Math.floor(totalMinutes / 10));
      }

      var zero = typeof sequence.zeroPointTicks === 'string' ?
        parseTicks(sequence.zeroPointTicks, 'zeroPointTicks') : 0;
      var ticks = checked(frames * tpf, 'timecode') - zero;
      return { ok: true, data: { ticks: formatTicks(ticks) } };
    } catch (e) {
      if (e && e.isTimemapError) { return { ok: false, error: e.message }; }
      throw e;
    }
  }

  // ---------------------------------------------------------------------------------------

  var VSTimemap = {
    TICKS_PER_SECOND: TICKS_PER_SECOND,
    DEFAULT_OPTIONS: DEFAULT_OPTIONS,
    snapToFrame: snapToFrame,
    buildMap: buildMap,
    mapCues: mapCues,
    offsetFromTimecode: offsetFromTimecode
  };

  if (typeof window !== 'undefined') {
    window.VSTimemap = VSTimemap;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = VSTimemap;
  }
})();
