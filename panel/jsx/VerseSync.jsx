/**
 * VerseSync.jsx -- ExtendScript host, single consolidated file.
 * All code is inlined here to avoid #include path-resolution issues in Premiere 2026.
 *
 * Conventions (docs/08-premiere-host-api.md section 1, all non-negotiable):
 *  - ES3 and ASCII only. Non-ASCII characters in strings are written as \uXXXX escapes.
 *  - Every helper is `var fn = function(){}`, never `function fn(){}`. In Premiere 2026's
 *    engine, $.evalFile() does not hoist function declarations into the persistent global
 *    scope, so a declaration works at load time and fails with "undefined is not a function"
 *    when VS.* is called from a later evalScript().
 *  - Every VS.* function takes one JSON string and returns one JSON string:
 *    {"ok":true,"data":...} or {"ok":false,"error":"message"[,"code":"..."]}.
 *    Nothing here throws across the bridge.
 *  - Ticks are passed as strings.
 *
 * The host does no time arithmetic beyond adding a duration to a start, and knows nothing
 * about scripture (docs/08 section 10).
 */

// ---- JSON polyfill ----------------------------------------------------------
// Premiere 2026's ExtendScript engine (ES3) has no native JSON object.
// This minimal implementation uses only ASCII source characters to avoid
// encoding problems when the file is loaded via $.evalFile(). Output is ASCII too:
// every character outside printable ASCII is written as a \uXXXX escape, so text
// carrying typographic quotes or dashes survives the evalScript string round trip.

var JSON = JSON || {};

(function () {
    // Characters that must be escaped in JSON strings (plus everything non-ASCII)
    var MUST_ESCAPE = /[\x00-\x1f\x7f-\uffff\\"]/g;

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
        return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
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

// Premiere's internal tick rate is fixed, independent of the sequence's frame rate.
var VS_TICKS_PER_SECOND = 254016000000;

// Editor-facing messages (docs/08 section 9). \u2014 is an em dash.
var VS_MSG_NO_SEQUENCE = 'Open a sequence in Premiere first.';
var VS_MSG_NO_SEQUENCE_FIELDS =
    'Open a sequence in Premiere first \u2014 reading a template\'s fields requires an ' +
    'active sequence.';
var VS_MSG_IMPORT_FAILED =
    'Premiere could not insert the template. Check the .mogrt path is still valid.';
var VS_MSG_NO_MGT_COMPONENT =
    'This template has no Motion Graphics component \u2014 it may not be an After Effects ' +
    'template.';

// ---- Response helpers -------------------------------------------------------

var vsOk = function (data) {
    return JSON.stringify({ ok: true, data: data });
};

// `code` is optional; when given it is a lower_snake_case value the panel branches on.
var vsErr = function (msg, code) {
    var envelope = { ok: false, error: String(msg) };
    if (code) envelope.code = String(code);
    return JSON.stringify(envelope);
};

// ---- Argument and tick helpers ----------------------------------------------

var vsParseArgs = function (argsJson) {
    if (argsJson === undefined || argsJson === null || argsJson === '') return {};
    var args = JSON.parse(argsJson);
    return (args && typeof args === 'object') ? args : {};
};

// Tick strings are digits only. A malformed value handed to Time.ticks or importMGT can
// raise a fatal ExtendScript error that try/catch cannot see, so check before using one.
var vsIsTickString = function (value) {
    return typeof value === 'string' && /^[0-9]+$/.test(value);
};

// Read ticks off a Time object, or accept a bare tick value; always returns a string.
var vsTicksOf = function (timeOrTicks) {
    if (timeOrTicks === undefined || timeOrTicks === null) return '0';
    if (typeof timeOrTicks === 'object') return String(timeOrTicks.ticks);
    return String(timeOrTicks);
};

var vsSecondsToTicksStr = function (sec) {
    return String(Math.round(sec * VS_TICKS_PER_SECOND));
};

// ---- Internal MOGRT helpers -------------------------------------------------

// Iterate mgt.properties, return editable text fields with index + group label.
//
// Detection strategy (in order):
//   1. propertyType === 6  -- source text per MOGRT definition.json spec
//   2. propertyType === 5  -- some Premiere versions use 5 for source text
//   3. getValue() contains "textEditValue" -- reliable cross-version probe;
//      Premiere stores text properties as a JSON blob with this key
//
// Group detection: on the real reference template propertyType is undefined for every
// property (spikes/word_timestamps), and a group header's getValue() is a ';'-joined list of
// GUIDs. A GUID-list value is therefore the primary signal; type 10 (spec) or type 4 (seen in
// some Premiere builds) remain as secondary signals for builds that do report propertyType.
//
// Fields are identified by their index in the collection and never by display name: the
// reference template has two fields both called "Text".
var VS_GUID_LIST_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12};?)+$/i;

var vsIterateProperties = function (mgt) {
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

        // Group / folder nodes -- track current group context, don't add to results
        var isGroup = (pType === 10 || pType === 4);
        if (!isGroup) {
            try {
                var gv = p.getValue();
                if (typeof gv === 'string' && VS_GUID_LIST_RE.test(gv)) isGroup = true;
            } catch (e) {}
        }
        if (isGroup) {
            currentGroup = pName;
            continue;
        }

        // Strategy 1 & 2: known source-text type numbers
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

    // A template with no groups at all would show several identical labels; number them.
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

// ---- VS.ping ----------------------------------------------------------------

VS.ping = function (argsJson) {
    return vsOk({ pong: true, version: VS_VERSION, hostApi: VS_HOST_API });
};

// ---- VS.getSequenceInfo -----------------------------------------------------
// timebase is Premiere's own integer ticks-per-frame. frameRate is derived from it for
// display only; snapping must always divide by timebase. zeroPointTicks is for display
// timecode only and must not enter placement math.

VS.getSequenceInfo = function (argsJson) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return vsOk({ hasActiveSequence: false });

        var sequenceID = seq.sequenceID;
        if (sequenceID === undefined || sequenceID === null || String(sequenceID) === '') {
            return vsErr('Premiere did not report an ID for this sequence, so VerseSync cannot ' +
                'tell it apart from the others. Update Premiere and try again.');
        }

        var timebase = vsTicksOf(seq.timebase);
        if (!vsIsTickString(timebase) || Number(timebase) <= 0) {
            return vsErr('Premiere did not report this sequence\'s frame timing. ' +
                'Click Refresh and try again.');
        }

        var pos = seq.getPlayerPosition();
        return vsOk({
            hasActiveSequence: true,
            sequenceID:        String(sequenceID),
            name:              seq.name,
            videoTrackCount:   seq.videoTracks.numTracks,
            audioTrackCount:   seq.audioTracks.numTracks,
            playheadTicks:     vsTicksOf(pos),
            timebase:          timebase,
            frameRate:         Math.round(VS_TICKS_PER_SECOND / Number(timebase) * 1000) / 1000,
            zeroPointTicks:    vsTicksOf(seq.zeroPoint),
            endTicks:          vsTicksOf(seq.end)
        });
    } catch (e) {
        return vsErr('getSequenceInfo: ' + e);
    }
};

// ---- VS.getMogrtFields ------------------------------------------------------
// Insert one instance of the template past the end of the sequence inside an undo group,
// enumerate its properties, remove it again.

VS.getMogrtFields = function (argsJson) {
    var undoOpen = false;
    var clip = null;
    try {
        var args = vsParseArgs(argsJson);
        var path = args.path;
        if (!path) return vsErr('No path provided');

        var seq = app.project.activeSequence;
        if (!seq) return vsErr(VS_MSG_NO_SEQUENCE_FIELDS);

        // An out-of-range track index is a fatal ExtendScript error try/catch cannot see,
        // and it would strand the undo group below, so refuse before opening one.
        var trackCount = seq.videoTracks.numTracks;
        if (!trackCount || trackCount < 1) {
            return vsErr('This sequence has no video tracks to read the template from.');
        }
        var scratchTrack = trackCount - 1;

        var seqEndTicks  = seq.end ? Number(vsTicksOf(seq.end)) : Number(vsSecondsToTicksStr(3600));
        var scratchTicks = String(seqEndTicks + Number(vsSecondsToTicksStr(60)));

        try { app.beginUndoGroup('VS_scratch'); undoOpen = true; } catch (e) {}

        try {
            clip = seq.importMGT(path, scratchTicks, scratchTrack, 0);
        } catch (e) {
            return vsErr(VS_MSG_IMPORT_FAILED);
        }

        if (!clip) return vsErr(VS_MSG_IMPORT_FAILED);

        var fields = [];
        var mgtMissing = false;
        try {
            var mgt = clip.getMGTComponent();
            if (mgt) {
                fields = vsIterateProperties(mgt);
            } else {
                mgtMissing = true;
            }
        } catch (e) {
            mgtMissing = true;
        }

        // Surface a missing component so the panel can show a real error
        if (mgtMissing && fields.length === 0) return vsErr(VS_MSG_NO_MGT_COMPONENT);

        return vsOk({ fields: fields });
    } catch (e) {
        return vsErr('getMogrtFields: ' + e);
    } finally {
        // Runs on every exit above: the scratch clip never stays on the timeline and the
        // undo group is always closed, since a stranded group breaks undo for the session.
        if (clip) {
            try { clip.remove(false, true); } catch (e) {}
        }
        if (undoOpen) {
            try { app.endUndoGroup(); } catch (e) {}
        }
    }
};

// ---- VS.setPlayhead ---------------------------------------------------------
// Backs FR-6.6: a click on a review row's timecode moves Premiere to that moment.

VS.setPlayhead = function (argsJson) {
    try {
        var args = vsParseArgs(argsJson);

        var seq = app.project.activeSequence;
        if (!seq) return vsErr(VS_MSG_NO_SEQUENCE);

        if (!vsIsTickString(args.ticks)) {
            return vsErr('Internal error: invalid playhead position. Please report this.');
        }

        seq.setPlayerPosition(args.ticks);
        return vsOk({ ticks: args.ticks });
    } catch (e) {
        return vsErr('setPlayhead: ' + e);
    }
};
