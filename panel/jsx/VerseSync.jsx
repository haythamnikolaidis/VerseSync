/**
 * VerseSync.jsx -- ExtendScript host, single consolidated file.
 * All code is inlined here to avoid #include path-resolution issues in Premiere 2026.
 *
 * NOTE: All helpers use `var fn = function(){}` rather than `function fn(){}`.
 * In Premiere 2026's ExtendScript engine, $.evalFile() does not hoist function
 * declarations into the persistent global scope. Using var expressions ensures
 * _ok, _err, and all private helpers are accessible when VS.* methods are
 * called from a later evalScript() call.
 *
 * ES3 and ASCII only. Every VS.* function takes one JSON string and returns
 * one JSON string; it never throws across the bridge (docs/08 section 1).
 */

// ---- JSON polyfill ----------------------------------------------------------
// Premiere 2026's ExtendScript engine (ES3) has no native JSON object.
// This minimal implementation uses only ASCII source characters to avoid
// encoding problems when the file is loaded via $.evalFile().

var JSON = JSON || {};

(function () {
    // Characters that must be escaped in JSON strings
    var MUST_ESCAPE = /[\x00-\x1f\\"]/g;

    var ESCAPES = {};
    ESCAPES['"']  = '\\"';
    ESCAPES['\\'] = '\\\\';
    ESCAPES['\b'] = '\\b';
    ESCAPES['\f'] = '\\f';
    ESCAPES['\n'] = '\\n';
    ESCAPES['\r'] = '\\r';
    ESCAPES['\t'] = '\\t';

    var escChar = function (c) {
        var e = ESCAPES[c];
        if (e) return e;
        return '\\u00' + ('0' + c.charCodeAt(0).toString(16)).slice(-2);
    };

    var escStr = function (s) {
        return '"' + s.replace(MUST_ESCAPE, escChar) + '"';
    };

    var str = function (val) {
        if (val === null)                          return 'null';
        var t = typeof val;
        if (t === 'boolean')                       return val ? 'true' : 'false';
        if (t === 'number')                        return isFinite(val) ? String(val) : 'null';
        if (t === 'string')                        return escStr(val);
        if (t === 'undefined' || t === 'function') return undefined;

        var i, out, k, v;

        if (val instanceof Array) {
            out = [];
            for (i = 0; i < val.length; i++) {
                v = str(val[i]);
                out.push(v === undefined ? 'null' : v);
            }
            return '[' + out.join(',') + ']';
        }

        out = [];
        for (k in val) {
            if (Object.prototype.hasOwnProperty.call(val, k)) {
                v = str(val[k]);
                if (v !== undefined) {
                    out.push(escStr(k) + ':' + v);
                }
            }
        }
        return '{' + out.join(',') + '}';
    };

    if (typeof JSON.stringify !== 'function') {
        JSON.stringify = function (value) { return str(value); };
    }

    if (typeof JSON.parse !== 'function') {
        // eval() is safe here -- we only parse strings we generated internally
        // through the bridge, never untrusted user input.
        JSON.parse = function (text) {
            return eval('(' + String(text) + ')');
        };
    }
}());

// ---- VS namespace -----------------------------------------------------------
var VS = {};

// ---- Constants --------------------------------------------------------------
var VS_VERSION = '1.0.0';
var VS_HOST_API = '1.1';
var VS_TICKS_PER_SECOND = 254016000000;

// docs/08 section 9
var VS_MSG_NO_SEQUENCE = 'Open a sequence in Premiere first.';

// ---- Response helpers -------------------------------------------------------

var _ok = function (data) {
    return JSON.stringify({ ok: true, data: data });
};

var _err = function (msg) {
    return JSON.stringify({ ok: false, error: String(msg) });
};

// Every VS.* function is built with _wrap, which parses the single JSON
// argument and turns any thrown error into an _err response.
var _wrap = function (name, fn) {
    return function (argsJson) {
        try {
            var args = {};
            if (argsJson !== undefined && argsJson !== null && argsJson !== '') {
                args = JSON.parse(argsJson);
            }
            return fn(args || {});
        } catch (e) {
            return _err(name + ': ' + e);
        }
    };
};

// ---- VS.ping ----------------------------------------------------------------

VS.ping = _wrap('ping', function (args) {
    return _ok({ pong: true, version: VS_VERSION, hostApi: VS_HOST_API });
});

// ---- VS.getSequenceInfo -----------------------------------------------------

// Frame rate is display only. Frame snapping uses timebase, which is passed
// through exactly as Premiere reports it and never derived from this value.
var _displayFrameRate = function (timebase) {
    var tb = Number(timebase);
    if (!(tb > 0)) return 0;
    return Math.round(VS_TICKS_PER_SECOND / tb * 1000) / 1000;
};

VS.getSequenceInfo = _wrap('getSequenceInfo', function (args) {
    var seq = app.project.activeSequence;
    if (!seq) return _ok({ hasActiveSequence: false });
    var timebase = String(seq.timebase);
    return _ok({
        hasActiveSequence: true,
        sequenceId:        String(seq.sequenceID),
        name:              seq.name,
        videoTrackCount:   seq.videoTracks.numTracks,
        audioTrackCount:   seq.audioTracks.numTracks,
        playheadTicks:     String(seq.getPlayerPosition().ticks),
        timebase:          timebase,
        frameRate:         _displayFrameRate(timebase),
        zeroPointTicks:    String(seq.zeroPoint),
        endTicks:          String(seq.end)
    });
});

// ---- VS.setPlayhead ---------------------------------------------------------

VS.setPlayhead = _wrap('setPlayhead', function (args) {
    var seq = app.project.activeSequence;
    if (!seq) return _err(VS_MSG_NO_SEQUENCE);
    if (typeof args.ticks !== 'string' || args.ticks === '') {
        return _err('setPlayhead: ticks must be a string');
    }
    seq.setPlayerPosition(args.ticks);
    return _ok({ ticks: args.ticks });
});

// ---- VS.getMogrtFields ------------------------------------------------------

// docs/08 section 9, with the em dash written as -- to keep this file ASCII.
var VS_MSG_FIELDS_NO_SEQUENCE =
    'Open a sequence in Premiere first -- reading a template\'s fields requires an active sequence.';
var VS_MSG_IMPORT_NULL =
    'Premiere could not insert the template. Check the .mogrt path is still valid.';
var VS_MSG_NO_MGT_COMPONENT =
    'This template has no Motion Graphics component -- it may not be an After Effects template.';

// Seconds the scratch clip is placed beyond the end of the sequence, so that it
// cannot overwrite anything. Copied from the VerseFlow reference.
var VS_SCRATCH_OFFSET_SECONDS = 60;

// Iterate mgt.properties, return editable text fields with index + group label.
//
// Detection strategy (in order):
//   1. propertyType === 6  -- source text per MOGRT definition.json spec
//   2. propertyType === 5  -- some Premiere versions use 5 for source text
//   3. getValue() contains "textEditValue" -- reliable cross-version probe;
//      Premiere stores text properties as a JSON blob with this key
//
// Group detection: type 10 (spec) or type 4 (seen in some Premiere builds).
var _iterateProperties = function (mgt) {
    var props = mgt.properties;
    var count = 0;
    try { count = props.numItems; } catch (e) { return []; }

    var results = [];
    var currentGroup = '';

    for (var i = 0; i < count; i++) {
        var p;
        try { p = props[i]; } catch (e) { continue; }
        if (!p) continue;

        var pType = -1;
        var pName = '';
        try { pType = Number(p.propertyType); } catch (e) {}
        try { pName = p.displayName; } catch (e) {}

        // Group / folder nodes: track the current group, do not add to results
        if (pType === 10 || pType === 4) {
            currentGroup = pName;
            continue;
        }

        // Strategy 1 and 2: known source-text type numbers
        var isText = (pType === 6 || pType === 5);

        // Strategy 3: probe the raw value blob for the textEditValue key
        if (!isText) {
            try {
                var raw = p.getValue();
                if (typeof raw === 'string' && raw.indexOf('textEditValue') >= 0) {
                    isText = true;
                }
            } catch (e) {}
        }

        if (isText) {
            var lbl = currentGroup ? (currentGroup + ' > ' + pName) : pName;
            results.push({ index: i, name: pName, group: currentGroup, label: lbl });
        }
    }

    if (results.length > 0) {
        var allNoGroup = true;
        for (var k = 0; k < results.length; k++) {
            if (results[k].group !== '') { allNoGroup = false; break; }
        }
        if (allNoGroup) {
            for (var j = 0; j < results.length; j++) {
                results[j].label = results[j].name + ' #' + (j + 1);
            }
        }
    }

    return results;
};

// Inserts one scratch instance past the end of the sequence inside an undo
// group, enumerates its properties, and removes it again.
VS.getMogrtFields = function (argsJson) {
    try {
        var args = JSON.parse(argsJson);
        var path = args.path;
        if (!path) return _err('No path provided');

        var seq = app.project.activeSequence;
        if (!seq) return _err(VS_MSG_FIELDS_NO_SEQUENCE);

        // seq.end is a ticks string (getSequenceInfo reads it the same way); a
        // Time object is accepted too.
        var seqEndTicks = VS_TICKS_PER_SECOND * 3600;
        if (seq.end) {
            seqEndTicks = Number(seq.end.ticks !== undefined ? seq.end.ticks : seq.end);
        }
        var scratchTicks = String(seqEndTicks + VS_TICKS_PER_SECOND * VS_SCRATCH_OFFSET_SECONDS);
        var scratchTrack = seq.videoTracks.numTracks - 1;

        var clip = null;
        var fields = [];

        try { app.beginUndoGroup('VS_scratch'); } catch (e) {}

        try {
            clip = seq.importMGT(path, scratchTicks, scratchTrack, 0);
        } catch (e) {
            try { app.endUndoGroup(); } catch (e2) {}
            return _err('importMGT failed: ' + e);
        }

        if (!clip) {
            try { app.endUndoGroup(); } catch (e) {}
            return _err(VS_MSG_IMPORT_NULL);
        }

        var mgtErr = '';
        try {
            var mgt = clip.getMGTComponent();
            if (mgt) {
                fields = _iterateProperties(mgt);
            } else {
                mgtErr = VS_MSG_NO_MGT_COMPONENT;
            }
        } catch (e) {
            mgtErr = 'getMGTComponent() threw: ' + e;
        }

        try { clip.remove(false, true); } catch (e) {}
        try { app.endUndoGroup(); } catch (e) {}

        // Surface getMGTComponent failures so the panel can show a real error
        if (mgtErr && fields.length === 0) {
            return _err(mgtErr);
        }

        return _ok({ fields: fields });
    } catch (e) {
        try { app.endUndoGroup(); } catch (e2) {}
        return _err('getMogrtFields: ' + e);
    }
};

// ---- VS.getMediaSegments ----------------------------------------------------

// docs/08 section 9
var VS_MSG_SEQUENCE_CHANGED_PREFIX = 'The active sequence changed since this analysis. Switch back to "';
var VS_MSG_SEQUENCE_CHANGED_SUFFIX = '" or click Analyse again.';

// Name of the project sequence whose ID is sequenceId, or null if none.
var _sequenceNameById = function (sequenceId) {
    var seqs = app.project.sequences;
    if (!seqs) return null;
    var n = seqs.numSequences !== undefined ? seqs.numSequences : seqs.length;
    for (var i = 0; i < n; i++) {
        if (seqs[i] && String(seqs[i].sequenceID) === sequenceId) {
            return String(seqs[i].name);
        }
    }
    return null;
};

// D20: compares the caller's sequenceId to the active sequence. Returns
// { seq: <active sequence> } on a match, otherwise { err: <_err response> }.
var _checkSequenceId = function (sequenceId) {
    var seq = app.project.activeSequence;
    if (!seq) return { err: _err(VS_MSG_NO_SEQUENCE) };
    if (typeof sequenceId !== 'string' || sequenceId === '') {
        return { err: _err(VS_MSG_NO_SEQUENCE) };
    }
    if (String(seq.sequenceID) === sequenceId) return { seq: seq };
    var name = _sequenceNameById(sequenceId);
    if (name === null) return { err: _err(VS_MSG_NO_SEQUENCE) };
    return { err: _err(VS_MSG_SEQUENCE_CHANGED_PREFIX + name + VS_MSG_SEQUENCE_CHANGED_SUFFIX) };
};

// Backslashes to slashes, repeated slashes collapsed (a leading // is kept so
// UNC paths stay distinct), lowercased for Windows case-insensitivity.
var _normalisePath = function (p) {
    var s = String(p).replace(/\\/g, '/');
    var unc = s.indexOf('//') === 0;
    s = s.replace(/\/{2,}/g, '/');
    if (unc) s = '/' + s;
    return s.toLowerCase();
};

// Ticks are at most ~1e15, well inside the 2^53 range of a Number, so plain
// subtraction is exact; results go back out as strings.
var _ticksBetween = function (startTicks, endTicks) {
    return String(Number(endTicks) - Number(startTicks));
};

var _segmentFor = function (trackType, trackIndex, clip, speed) {
    var startTicks = String(clip.start.ticks);
    var endTicks = String(clip.end.ticks);
    return {
        trackType:     trackType,
        trackIndex:    trackIndex,
        seqStartTicks: startTicks,
        seqEndTicks:   endTicks,
        inPointTicks:  String(clip.inPoint.ticks),
        durationTicks: _ticksBetween(startTicks, endTicks),
        speed:         speed,
        name:          String(clip.name)
    };
};

var _walkTracksForMedia = function (tracks, trackType, target, segments, unsupported) {
    for (var t = 0; t < tracks.numTracks; t++) {
        var clips = tracks[t].clips;
        // Premiere's TrackItemCollection exposes numItems; a plain array has length.
        var count = clips.numItems !== undefined ? clips.numItems : clips.length;
        for (var c = 0; c < count; c++) {
            var clip = clips[c];
            // projectItem can be null (T-04); check it before chaining.
            if (!clip || !clip.projectItem) continue;

            var path = '';
            try { path = clip.projectItem.getMediaPath(); } catch (e) { path = ''; }

            if (!path) {
                // Nested sequence, multicam or offline media (T-04): not told apart.
                unsupported.push({
                    trackType:  trackType,
                    trackIndex: t,
                    name:       String(clip.name),
                    reason:     'unresolvable_media'
                });
                continue;
            }
            if (_normalisePath(path) !== target) continue;

            var speed = clip.getSpeed();
            if (speed !== 1) {
                // In and out points are garbage once the speed changes (T-04).
                var u = _segmentFor(trackType, t, clip, speed);
                u.reason = 'speed_change';
                unsupported.push(u);
                continue;
            }
            segments.push(_segmentFor(trackType, t, clip, speed));
        }
    }
};

VS.getMediaSegments = _wrap('getMediaSegments', function (args) {
    var checked = _checkSequenceId(args.sequenceId);
    if (checked.err) return checked.err;
    if (typeof args.mediaPath !== 'string' || args.mediaPath === '') {
        return _err('getMediaSegments: mediaPath must be a non-empty string');
    }
    var seq = checked.seq;
    var target = _normalisePath(args.mediaPath);
    var segments = [];
    var unsupported = [];
    _walkTracksForMedia(seq.videoTracks, 'video', target, segments, unsupported);
    _walkTracksForMedia(seq.audioTracks, 'audio', target, segments, unsupported);
    return _ok({
        matched:     segments.length > 0,
        segments:    segments,
        unsupported: unsupported
    });
});
