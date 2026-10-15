/**
 * VerseFlow.jsx -- ExtendScript host, single consolidated file.
 * All code is inlined here to avoid #include path-resolution issues in Premiere 2026.
 *
 * NOTE: All helpers use `var fn = function(){}` rather than `function fn(){}`.
 * In Premiere 2026's ExtendScript engine, $.evalFile() does not hoist function
 * declarations into the persistent global scope. Using var expressions ensures
 * vfOk, vfErr, and all private helpers are accessible when VF.* methods are
 * called from a later evalScript() call.
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

// ---- VF namespace -----------------------------------------------------------
var VF = {};

// ---- Constants --------------------------------------------------------------
var VF_TICKS_PER_SECOND = 254016000000;

// ---- Response helpers -------------------------------------------------------

var vfOk = function (data) {
    return JSON.stringify({ ok: true, data: data });
};

var vfErr = function (msg) {
    return JSON.stringify({ ok: false, error: String(msg) });
};

// ---- Tick helpers -----------------------------------------------------------

var addTicks = function (aStr, bStr) {
    return String(Number(aStr) + Number(bStr));
};

var secondsToTicksStr = function (sec) {
    return String(Math.round(sec * VF_TICKS_PER_SECOND));
};

var buildTimeFromTicks = function (ticksStr) {
    var t = new Time();
    t.ticks = ticksStr;
    return t;
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

        // Group / folder nodes -- track current group context, don't add to results
        if (pType === 10 || pType === 4) {
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

// Write text to a MOGRT field by index using the JSON textEditValue dance.
var _setTextField = function (mgt, fieldIndex, text) {
    var p = mgt.properties[fieldIndex];
    if (!p) throw new Error('No property at index ' + fieldIndex);

    var raw = '';
    try { raw = p.getValue(); } catch (e) {}

    var data = null;
    try { data = JSON.parse(raw); } catch (e) {}

    if (data && typeof data === 'object') {
        data.textEditValue     = text;
        data.fontTextRunLength = [text.length];
        p.setValue(JSON.stringify(data), true);
    } else {
        p.setValue(text, true);
    }
};

// Set a clip's timeline length by adjusting its end time.
var _setClipDuration = function (clip, durationTicksStr) {
    var startNum = Number(clip.start.ticks);
    var endNum   = startNum + Number(durationTicksStr);
    var endTime  = buildTimeFromTicks(String(endNum));
    try {
        clip.end = endTime;
    } catch (e) {
        try { clip.outPoint = endTime; } catch (e2) {
            throw new Error('setClipDuration failed: ' + e2);
        }
    }
};

// ---- VF.ping ----------------------------------------------------------------

VF.ping = function (argsJson) {
    return vfOk({ pong: true, version: '1.0.0' });
};

// ---- VF.getSequenceInfo -----------------------------------------------------

VF.getSequenceInfo = function (argsJson) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return vfOk({ hasActiveSequence: false });
        var pos = seq.getPlayerPosition();
        return vfOk({
            hasActiveSequence: true,
            name:              seq.name,
            videoTrackCount:   seq.videoTracks.numTracks,
            playheadTicks:     pos.ticks
        });
    } catch (e) {
        return vfErr('getSequenceInfo: ' + e);
    }
};

// ---- VF.getMogrtFields ------------------------------------------------------

VF.getMogrtFields = function (argsJson) {
    try {
        var args = JSON.parse(argsJson);
        var path = args.path;
        if (!path) return vfErr('No path provided');

        var seq = app.project.activeSequence;
        if (!seq) {
            return vfErr(
                'Open a sequence in Premiere first -- field discovery requires an active sequence.'
            );
        }

        var seqEndTicks  = seq.end ? Number(seq.end.ticks) : Number(secondsToTicksStr(3600));
        var scratchTicks = String(seqEndTicks + Number(secondsToTicksStr(60)));
        var scratchTrack = seq.videoTracks.numTracks - 1;

        var clip   = null;
        var fields = [];

        try { app.beginUndoGroup('VF_scratch'); } catch (e) {}

        try {
            clip = seq.importMGT(path, scratchTicks, scratchTrack, 0);
        } catch (e) {
            try { app.endUndoGroup(); } catch (e2) {}
            return vfErr('importMGT failed: ' + e);
        }

        if (!clip) {
            try { app.endUndoGroup(); } catch (e) {}
            return vfErr('importMGT returned null -- verify the template path.');
        }

        var mgtErr = '';
        try {
            var mgt = clip.getMGTComponent();
            if (mgt) {
                fields = _iterateProperties(mgt);
            } else {
                mgtErr = 'getMGTComponent() returned null';
            }
        } catch (e) {
            mgtErr = 'getMGTComponent() threw: ' + e;
        }

        try { clip.remove(false, true); } catch (e) {}
        try { app.endUndoGroup(); } catch (e) {}

        // Surface getMGTComponent failures so the panel can show a real error
        if (mgtErr && fields.length === 0) {
            return vfErr(mgtErr);
        }

        return vfOk({ fields: fields });
    } catch (e) {
        try { app.endUndoGroup(); } catch (e2) {}
        return vfErr('getMogrtFields: ' + e);
    }
};

// ---- VF.insertBatch ---------------------------------------------------------

VF.insertBatch = function (argsJson) {
    try {
        var args      = JSON.parse(argsJson);
        var mogrtPath = args.mogrtPath;
        var trackIdx  = args.trackIndex  || 0;
        var cursor    = args.startTicks  || '0';
        var mapping   = args.mapping;
        var items     = args.items || [];

        var seq = app.project.activeSequence;
        if (!seq) return vfErr('No active sequence.');

        try { app.beginUndoGroup('VerseFlow: Insert scriptures'); } catch (e) {}

        var results       = [];
        var insertedCount = 0;
        var failedCount   = 0;

        for (var i = 0; i < items.length; i++) {
            var item    = items[i];
            var success = false;

            try {
                var clip = seq.importMGT(mogrtPath, cursor, trackIdx, 0);
                if (!clip) throw new Error('importMGT returned null');

                var mgt = clip.getMGTComponent();
                if (!mgt) throw new Error('getMGTComponent returned null');

                _setTextField(mgt, mapping.referenceIndex, item.reference);
                _setTextField(mgt, mapping.bodyIndex,      item.body);
                _setClipDuration(clip, item.durationTicks);

                cursor = addTicks(cursor, item.durationTicks);
                success = true;
                insertedCount++;
            } catch (itemErr) {
                failedCount++;
                results.push({ index: i, ok: false, error: String(itemErr) });
                try { cursor = addTicks(cursor, item.durationTicks); } catch (e) {}
            }

            if (success) results.push({ index: i, ok: true });

            try {
                var evt  = new CSXSEvent();
                evt.type = 'com.verseflow.progress';
                evt.data = JSON.stringify({ done: insertedCount + failedCount, total: items.length });
                evt.dispatch();
            } catch (e) {}
        }

        try { app.endUndoGroup(); } catch (e) {}

        return vfOk({
            results:       results,
            insertedCount: insertedCount,
            failedCount:   failedCount,
            endTicks:      cursor
        });
    } catch (e) {
        try { app.endUndoGroup(); } catch (e2) {}
        return vfErr('insertBatch: ' + e);
    }
};

// ---- VF.insertOne -----------------------------------------------------------

VF.insertOne = function (argsJson) {
    try {
        var args = JSON.parse(argsJson);
        var seq  = app.project.activeSequence;
        if (!seq) return vfErr('No active sequence.');

        var clip = seq.importMGT(args.mogrtPath, args.atTicks, args.trackIndex, 0);
        if (!clip) return vfErr('importMGT returned null.');

        var mgt = clip.getMGTComponent();
        if (!mgt) return vfErr('getMGTComponent returned null.');

        _setTextField(mgt, args.mapping.referenceIndex, args.item.reference);
        _setTextField(mgt, args.mapping.bodyIndex,      args.item.body);
        _setClipDuration(clip, args.item.durationTicks);

        return vfOk({ nextTicks: addTicks(args.atTicks, args.item.durationTicks) });
    } catch (e) {
        return vfErr('insertOne: ' + e);
    }
};
