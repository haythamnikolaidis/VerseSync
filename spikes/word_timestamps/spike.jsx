/**
 * spike.jsx — T-02 support tool: extract scripture-graphic start times from
 * an already-edited real sermon sequence, to seed the hand-labelled ground
 * truth T-02 needs ("Hand-label the start time of 30 scripture mentions...
 * to the frame"). This does NOT replace hand-labelling — it produces
 * candidate timestamps (and, where the text can be read, the reference
 * itself) straight from clips the editor already placed, so confirming
 * against the raw sermon audio is a quick nudge-to-frame pass per cue
 * instead of scrubbing 45 minutes of audio from scratch.
 *
 * Standalone and self-contained, loaded with $.evalFile() from VerseFlow's
 * already-running debug panel — same approach as spikes/absolute_insert and
 * spikes/media_segments, see console-driver.md. Prefixed `wt` (word
 * timestamps) so it can coexist with those spikes' functions in the same
 * ExtendScript engine without colliding.
 *
 * Read-only — no timeline mutation (wtSetPlayhead moves the playhead only),
 * so none of absolute_insert's undo-group hazards apply here.
 *
 * CAVEAT (read before trusting the output as ground truth): a graphic's
 * clip.start reflects wherever the editor placed it, which may include a
 * deliberate lead-in before the spoken mention (VerseSync's own spec uses a
 * 0.5s lead-in by default, see docs/05-timing-and-placement.md §2) or simply
 * the editor's eyeballed judgement. It is a strong candidate, not a
 * substitute for confirming the actual word onset against the audio -
 * which is exactly what the raw-audio confirmation pass is for.
 *
 * MGT text-field reading was first modelled on VerseFlow's verified
 * implementation (D:/Development/Personal/VerseFlow/jsx/modules/mogrt.jsx,
 * `_iterateProperties` / `_setTextField`): propertyType === 6 for editable
 * source text, === 10 for a group/folder node. CONFIRMED BROKEN on this
 * project's real template ("Quotes | Imocean") — `prop.propertyType` comes
 * back `undefined` for every property on this clip (Premiere/template
 * version difference from whatever VerseFlow was built against). Because
 * JSON.stringify silently drops `undefined` values, this didn't show up as
 * an error — the dumped properties just quietly had no `propertyType` key at
 * all, which is why every one of them read `looksLikeText: false`.
 *
 * Detection therefore runs primarily on VALUE SHAPE, verified against a real
 * dump from this project's sermon (see git history / conversation for the
 * raw dump that drove this):
 *   - A text leaf's getValue() is a JSON string whose parsed object has a
 *     `.textEditValue` string field (confirmed: body-quote and reference
 *     fields both matched this exactly; nothing else in a ~45-property
 *     template did).
 *   - A group-header entry's getValue() is a `;`-joined list of GUIDs
 *     (confirmed: every non-leaf structural property matched this; no leaf
 *     property did).
 * propertyType === 6 / === 10 are kept as an additional OR-condition in case
 * a different template, or a future Premiere version, makes them work again.
 *
 * SEQUENCE TIME VS SOURCE TIME (docs/05-timing-and-placement.md §1): every
 * timestamp from wtWalkScriptureGraphics/wtWalkSequenceClips is SEQUENCE
 * time — seconds from the start of the Premiere SEQUENCE. The raw sermon
 * audio file (what you actually import into Audacity) is in SOURCE time —
 * seconds from the start of that FILE. These are not the same the moment
 * anything was trimmed off the front, or cut out of the middle, during
 * editing — confirmed on this project: the raw file has a long lead-in of
 * silence that was trimmed off before the sequence's tick 0. wtWalkAudioClips
 * / wtWalkScriptureGraphics' optional audioTrackIndex resolve sequence time
 * to source time per clip, via clip.inPoint and clip.getSpeed() (the same
 * source-sequence mapping T-04 proved out in spikes/media_segments) — do not
 * assume a single constant offset across the whole sermon; if the edit has
 * any internal cuts the offset can vary cue to cue, and this resolves each
 * one against whichever clip actually contains it rather than guessing.
 *
 * `var fn = function () {}` throughout, never `function fn() {}` — Premiere
 * 2026's $.evalFile() does not reliably hoist plain function declarations
 * into persistent global scope (see ../../docs/08-premiere-host-api.md §1.4).
 */

var wtOk = function (data) {
    return JSON.stringify({ ok: true, data: data });
};

var wtErr = function (msg) {
    return JSON.stringify({ ok: false, error: String(msg) });
};

/**
 * wtSafeGet(fn) -> { ok: true, value } or { ok: false, error }
 * Every property/method read in this file goes through this so one clip's
 * exotic component (or one unexpected property shape) can't lose the rest
 * of the walk or abort it outright.
 */
var wtSafeGet = function (fn) {
    try {
        return { ok: true, value: fn() };
    } catch (e) {
        return { ok: false, error: e.toString() };
    }
};

/**
 * wtFieldOrError(fn) -> value, 'ERROR: ...', or null
 * `undefined` is coerced to `null` — not left as-is — because
 * JSON.stringify silently drops object keys whose value is `undefined`.
 * Without this, a property that exists but reads as undefined (as
 * prop.propertyType did on this project's real MOGRT — see file header)
 * looks identical to a key that was never set, hiding the actual finding.
 */
var wtFieldOrError = function (fn) {
    var r = wtSafeGet(fn);
    if (!r.ok) return 'ERROR: ' + r.error;
    return (typeof r.value === 'undefined') ? null : r.value;
};

// Premiere's internal tick rate is a fixed 254,016,000,000 ticks per second,
// independent of sequence frame rate — same constant used in
// spikes/absolute_insert/spike.jsx. Do not derive this from fps.
var WT_TICKS_PER_SECOND = 254016000000;

/**
 * wtPing() — confirms this file (not VerseFlow.jsx or another spike's
 * spike.jsx) answered the call.
 */
var wtPing = function () {
    return wtOk({ pong: true, file: 'word_timestamps/spike.jsx' });
};

/**
 * wtListSequences() -> every open sequence, by index. Same rationale and
 * caveat as media_segments' msListSequences: app.project.activeSequence does
 * not reliably track UI tab focus across separate evalScript round-trips, so
 * resolve an explicit sequenceIndex once here and pass it to every other
 * call below rather than relying on activeSequence sticking.
 */
var wtListSequences = function () {
    var seqs = [];
    var current = app.project.activeSequence;
    for (var i = 0; i < app.project.sequences.numSequences; i++) {
        var s = app.project.sequences[i];
        seqs.push({ index: i, name: s.name, isCurrentActiveSequence: s === current });
    }
    return wtOk({ sequences: seqs });
};

/**
 * wtResolveSequence(args) -> Sequence for args.sequenceIndex if given, else
 * app.project.activeSequence. Internal helper.
 */
var wtResolveSequence = function (args) {
    if (args && typeof args.sequenceIndex === 'number') {
        if (args.sequenceIndex < 0 || args.sequenceIndex >= app.project.sequences.numSequences) {
            return null;
        }
        return app.project.sequences[args.sequenceIndex];
    }
    return app.project.activeSequence;
};

/**
 * wtGetSequenceInfo(argsJson) — args: { sequenceIndex? }
 * timebase (ticks per frame, string-safe number) and frameRate (derived,
 * display only — never use it for tick math, per
 * docs/05-timing-and-placement.md §1). zeroPointTicks is display-only too;
 * everything this file reports in "seconds"/"ticks" is sequence time from
 * tick 0, matching clip.start/.end directly.
 */
var wtGetSequenceInfo = function (argsJson) {
    var args = argsJson ? JSON.parse(argsJson) : {};
    var seq = wtResolveSequence(args);
    if (!seq) return wtErr('Open a sequence first, or sequenceIndex is out of range.');

    var timebase = wtFieldOrError(function () { return Number(seq.timebase); });
    var zeroPointTicks = wtFieldOrError(function () { return String(seq.zeroPoint); });
    var frameRate = (typeof timebase === 'number' && !isNaN(timebase))
        ? WT_TICKS_PER_SECOND / timebase
        : null;

    return wtOk({
        name: wtFieldOrError(function () { return seq.name; }),
        timebase: timebase,
        frameRate: frameRate,
        zeroPointTicks: zeroPointTicks
    });
};

/**
 * wtSetPlayhead(argsJson) — args: { ticks, sequenceIndex? }
 * Moves the playhead so you can listen at a candidate start without doing
 * timecode math by hand. Best-effort: Sequence.setPlayerPosition()'s exact
 * accepted argument shape isn't verified in this repo, so two call forms are
 * tried before giving up.
 */
var wtSetPlayhead = function (argsJson) {
    var args = JSON.parse(argsJson);
    var seq = wtResolveSequence(args);
    if (!seq) return wtErr('Open a sequence first, or sequenceIndex is out of range.');

    var attempt1 = wtSafeGet(function () {
        seq.setPlayerPosition(String(args.ticks));
        return true;
    });
    if (attempt1.ok) return wtOk({ ticks: String(args.ticks), method: 'setPlayerPosition(string)' });

    var attempt2 = wtSafeGet(function () {
        var t = new Time();
        t.ticks = String(args.ticks);
        seq.setPlayerPosition(t.ticks);
        return true;
    });
    if (attempt2.ok) return wtOk({ ticks: String(args.ticks), method: 'setPlayerPosition(Time.ticks)' });

    return wtErr('Could not move playhead: ' + attempt1.error + ' / ' + attempt2.error);
};

/**
 * wtDescribeAudioClip(clip, trackIndex, clipIndex) -> everything needed to
 * map a sequence time inside this clip back to source (raw-file) time.
 * Internal helper.
 */
var wtDescribeAudioClip = function (clip, trackIndex, clipIndex) {
    return {
        trackIndex: trackIndex,
        clipIndex: clipIndex,
        name: wtFieldOrError(function () { return clip.name; }),
        startTicks: wtFieldOrError(function () { return clip.start.ticks; }),
        endTicks: wtFieldOrError(function () { return clip.end.ticks; }),
        inPointTicks: wtFieldOrError(function () { return clip.inPoint.ticks; }),
        speed: wtFieldOrError(function () { return clip.getSpeed(); }),
        mediaPath: wtFieldOrError(function () { return clip.projectItem.getMediaPath(); })
    };
};

/**
 * wtWalkAudioClips(argsJson) — args: { sequenceIndex? }
 * Every clip on every audio track, with mediaPath/inPoint/speed — use this
 * to find which trackIndex actually holds the raw sermon audio (by name or
 * mediaPath) before calling wtMapTicksToSource or passing audioTrackIndex to
 * wtWalkScriptureGraphics. Mirrors spikes/media_segments' msWalkSequence,
 * audio tracks only, self-contained here rather than depending on that
 * spike being loaded in the same session.
 */
var wtWalkAudioClips = function (argsJson) {
    var args = argsJson ? JSON.parse(argsJson) : {};
    var seq = wtResolveSequence(args);
    if (!seq) return wtErr('Open a sequence first, or sequenceIndex is out of range.');

    var out = [];
    for (var i = 0; i < seq.audioTracks.numTracks; i++) {
        var track = seq.audioTracks[i];
        for (var j = 0; j < track.clips.numItems; j++) {
            out.push(wtDescribeAudioClip(track.clips[j], i, j));
        }
    }
    return wtOk({ clips: out, clipCount: out.length });
};

/**
 * wtResolveSourceSeconds(seq, audioTrackIndex, atTicksNum) ->
 *   { resolved: true, sourceSeconds, sequenceToSourceOffsetSeconds, speed,
 *     mediaPath, clipName }
 *   or { resolved: false, reason }
 * Finds the audio clip on seq.audioTracks[audioTrackIndex] whose
 * [start, end) contains atTicksNum, then maps via that clip's inPoint and
 * speed — clip.inPoint is where in the SOURCE file this clip's sequence
 * start corresponds to, so:
 *   sourceTicks = inPointTicks + (atTicksNum - clipStartTicks) * speed
 * Internal helper (shared by wtMapTicksToSource and wtWalkScriptureGraphics).
 */
var wtResolveSourceSeconds = function (seq, audioTrackIndex, atTicksNum) {
    if (audioTrackIndex < 0 || audioTrackIndex >= seq.audioTracks.numTracks) {
        return { resolved: false, reason: 'audioTrackIndex ' + audioTrackIndex + ' is out of range — this sequence has ' + seq.audioTracks.numTracks + ' audio track(s).' };
    }
    var track = seq.audioTracks[audioTrackIndex];

    for (var j = 0; j < track.clips.numItems; j++) {
        var clip = track.clips[j];
        var startR = wtSafeGet(function () { return Number(clip.start.ticks); });
        var endR = wtSafeGet(function () { return Number(clip.end.ticks); });
        if (!startR.ok || !endR.ok) continue;

        if (atTicksNum >= startR.value && atTicksNum < endR.value) {
            var inPointR = wtSafeGet(function () { return Number(clip.inPoint.ticks); });
            var speedR = wtSafeGet(function () { return clip.getSpeed(); });
            var mediaPathR = wtSafeGet(function () { return clip.projectItem.getMediaPath(); });
            var nameR = wtSafeGet(function () { return clip.name; });

            if (!inPointR.ok) return { resolved: false, reason: 'Found containing clip but could not read inPoint: ' + inPointR.error };
            var speed = speedR.ok ? speedR.value : 1.0;

            var sourceTicks = inPointR.value + (atTicksNum - startR.value) * speed;
            var sourceSeconds = sourceTicks / WT_TICKS_PER_SECOND;

            return {
                resolved: true,
                sourceSeconds: sourceSeconds,
                sequenceToSourceOffsetSeconds: sourceSeconds - (atTicksNum / WT_TICKS_PER_SECOND),
                speed: speed,
                speedWarning: (speed !== 1.0) ? ('Clip speed is ' + speed + ', not 1.0 — source mapping for speed-changed clips is unverified (R-6).') : null,
                mediaPath: mediaPathR.ok ? mediaPathR.value : ('ERROR: ' + mediaPathR.error),
                clipName: nameR.ok ? nameR.value : ('ERROR: ' + nameR.error)
            };
        }
    }

    return { resolved: false, reason: 'No clip on audio track ' + audioTrackIndex + ' contains this sequence time — possible gap or cut boundary. Check wtWalkAudioClips and the right audioTrackIndex.' };
};

/**
 * wtMapTicksToSource(argsJson) — args: { atTicks, audioTrackIndex, sequenceIndex? }
 * Public wrapper around wtResolveSourceSeconds for checking one timestamp by
 * hand before trusting the bulk mapping in wtWalkScriptureGraphics.
 */
var wtMapTicksToSource = function (argsJson) {
    var args = JSON.parse(argsJson);
    var seq = wtResolveSequence(args);
    if (!seq) return wtErr('Open a sequence first, or sequenceIndex is out of range.');
    if (typeof args.audioTrackIndex !== 'number') return wtErr('audioTrackIndex is required.');

    var result = wtResolveSourceSeconds(seq, args.audioTrackIndex, Number(args.atTicks));
    if (!result.resolved) return wtErr(result.reason);
    return wtOk(result);
};

/**
 * wtWalkSequenceClips(argsJson) — args: { sequenceIndex? }
 * Lightweight full-sequence dump: every clip's name, track position, start/
 * end in ticks and seconds, and whether getMGTComponent() returns truthy.
 * Use this first to sanity-check which track(s) actually hold the scripture
 * graphics on this sermon's timeline before trusting wtWalkScriptureGraphics'
 * filtering.
 */
var wtWalkSequenceClips = function (argsJson) {
    var args = argsJson ? JSON.parse(argsJson) : {};
    var seq = wtResolveSequence(args);
    if (!seq) return wtErr('Open a sequence first, or sequenceIndex is out of range.');

    var out = [];
    var i, j, track;

    var describe = function (clip, trackType, trackIndex, clipIndex) {
        var startTicks = wtFieldOrError(function () { return clip.start.ticks; });
        var endTicks = wtFieldOrError(function () { return clip.end.ticks; });
        var hasMGT = wtSafeGet(function () { return !!clip.getMGTComponent(); });
        return {
            trackType: trackType,
            trackIndex: trackIndex,
            clipIndex: clipIndex,
            name: wtFieldOrError(function () { return clip.name; }),
            startTicks: startTicks,
            endTicks: endTicks,
            startSeconds: (typeof startTicks === 'string') ? Number(startTicks) / WT_TICKS_PER_SECOND : null,
            endSeconds: (typeof endTicks === 'string') ? Number(endTicks) / WT_TICKS_PER_SECOND : null,
            hasMGTComponent: hasMGT.ok ? hasMGT.value : ('ERROR: ' + hasMGT.error)
        };
    };

    for (i = 0; i < seq.videoTracks.numTracks; i++) {
        track = seq.videoTracks[i];
        for (j = 0; j < track.clips.numItems; j++) {
            out.push(describe(track.clips[j], 'video', i, j));
        }
    }
    for (i = 0; i < seq.audioTracks.numTracks; i++) {
        track = seq.audioTracks[i];
        for (j = 0; j < track.clips.numItems; j++) {
            out.push(describe(track.clips[j], 'audio', i, j));
        }
    }

    return wtOk({ clips: out, clipCount: out.length });
};

// A group-header entry's getValue() on this project's templates is one or
// more GUIDs joined by ';' (e.g. "31a1fe9e-5ef8-4a8e-80e3-f666166d3536;...").
// Confirmed against a real property dump — every structural/group row
// matched this, no leaf (text or otherwise) did.
var WT_GUID_LIST_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12};?)+$/i;

/**
 * wtIsTextLeaf(prop) -> true if this is an editable source-text property.
 * PRIMARY signal (confirmed working on this project's real template, where
 * propertyType comes back undefined): getValue() is JSON with a string
 * `.textEditValue` field. propertyType === 6 is kept as a secondary OR in
 * case a different template/Premiere version exposes it correctly.
 */
var wtIsTextLeaf = function (prop) {
    var v = wtSafeGet(function () { return prop.getValue(); });
    if (v.ok && typeof v.value === 'string') {
        var parsed = wtSafeGet(function () { return JSON.parse(v.value); });
        if (parsed.ok && parsed.value && typeof parsed.value.textEditValue === 'string') {
            return true;
        }
    }

    var pt = wtSafeGet(function () { return prop.propertyType; });
    return pt.ok && (pt.value === 6 || pt.value === '6');
};

/**
 * wtIsGroupMarker(prop) -> true if this is a group/folder header entry in
 * the flat properties list, not a field itself. PRIMARY signal (confirmed
 * working on this project's real template): getValue() matches
 * WT_GUID_LIST_RE. propertyType === 10 is kept as a secondary OR.
 */
var wtIsGroupMarker = function (prop) {
    var v = wtSafeGet(function () { return prop.getValue(); });
    if (v.ok && typeof v.value === 'string' && WT_GUID_LIST_RE.test(v.value)) {
        return true;
    }

    var pt = wtSafeGet(function () { return prop.propertyType; });
    return pt.ok && (pt.value === 10 || pt.value === '10');
};

/**
 * wtExtractTextValue(prop) -> { raw, guess, guessMethod }
 * raw is always the untouched getValue() result (stringified) so a wrong
 * guess can be fixed by eye. guess follows the exact read path VerseFlow's
 * _setTextField uses to WRITE this same field (mogrt.jsx lines 73-86):
 * JSON.parse(getValue()).textEditValue, a plain string for AE-authored text
 * params. If that shape isn't there, the raw getValue() string itself is
 * tried as the plain text (Premiere-authored "Type tool" MOGRTs, per
 * VerseFlow's docs/planning/02-adobe-research.md §3, are explicitly
 * unsupported/different — surfaced via raw rather than guessed at).
 */
var wtExtractTextValue = function (prop) {
    var v = wtSafeGet(function () { return prop.getValue(); });
    if (!v.ok) return { raw: 'ERROR: ' + v.error, guess: null, guessMethod: 'none' };

    var raw = wtFieldOrError(function () { return String(v.value); });

    if (typeof v.value !== 'string') {
        return { raw: raw, guess: null, guessMethod: 'getValue() did not return a string' };
    }

    var parsed = wtSafeGet(function () { return JSON.parse(v.value); });
    if (!parsed.ok) {
        // Not JSON — possibly a Premiere-authored "Type tool" MOGRT, which
        // VerseFlow's research notes as a different, unsupported shape.
        // The raw string is likely still the plain text; offer it as a weak guess.
        return { raw: raw, guess: v.value, guessMethod: 'getValue() was not JSON — used as plain string (non-AE-authored field?)' };
    }

    var tev = wtSafeGet(function () { return parsed.value.textEditValue; });
    if (tev.ok && typeof tev.value === 'string') {
        return { raw: raw, guess: tev.value, guessMethod: 'JSON.parse(getValue()).textEditValue' };
    }

    return { raw: raw, guess: null, guessMethod: 'JSON parsed but textEditValue was missing or not a string' };
};

/**
 * wtDescribeMGTFields(comp) -> array of
 *   { index, name, group, label, propertyType, raw, guess, guessMethod }
 * One flat linear pass over comp.properties, tracking the most recent group
 * marker so later leaves get a qualified label — same shape VS.getMogrtFields
 * documents ("Title Main > Text"). Internal helper.
 */
var wtDescribeMGTFields = function (comp) {
    var fields = [];
    var countResult = wtSafeGet(function () { return comp.properties.numItems; });
    if (!countResult.ok) return { error: countResult.error, fields: fields };

    var currentGroup = null;
    for (var i = 0; i < countResult.value; i++) {
        var propResult = wtSafeGet(function () { return comp.properties[i]; });
        if (!propResult.ok) continue;
        var prop = propResult.value;

        if (wtIsGroupMarker(prop)) {
            currentGroup = wtFieldOrError(function () { return prop.displayName; });
            continue;
        }

        if (!wtIsTextLeaf(prop)) continue;

        var name = wtFieldOrError(function () { return prop.displayName; });
        var extracted = wtExtractTextValue(prop);
        var entry = {
            index: i,
            name: name,
            group: currentGroup,
            label: currentGroup ? (currentGroup + ' > ' + name) : name,
            propertyType: wtFieldOrError(function () { return prop.propertyType; }),
            raw: extracted.raw,
            guess: extracted.guess,
            guessMethod: extracted.guessMethod
        };
        fields.push(entry);
    }

    return { error: null, fields: fields };
};

/**
 * wtDumpClipProperties(argsJson) — args: { trackType, trackIndex, clipIndex, sequenceIndex? }
 * Diagnostic: every property on one clip's MGT component, unfiltered — use
 * this when wtWalkScriptureGraphics' guesses come back null/wrong for a
 * specific clip, to see the raw shape and fix wtExtractTextValue from it.
 */
var wtDumpClipProperties = function (argsJson) {
    var args = JSON.parse(argsJson);
    var seq = wtResolveSequence(args);
    if (!seq) return wtErr('Open a sequence first, or sequenceIndex is out of range.');

    var track = args.trackType === 'audio' ? seq.audioTracks[args.trackIndex] : seq.videoTracks[args.trackIndex];
    if (!track) return wtErr('No such track: ' + args.trackType + ' ' + args.trackIndex);
    var clip = track.clips[args.clipIndex];
    if (!clip) return wtErr('No such clip index: ' + args.clipIndex);

    var mgtResult = wtSafeGet(function () { return clip.getMGTComponent(); });
    if (!mgtResult.ok || !mgtResult.value) {
        return wtErr('This clip has no Motion Graphics component — it may not be an MGT.');
    }
    var comp = mgtResult.value;

    var countResult = wtSafeGet(function () { return comp.properties.numItems; });
    if (!countResult.ok) return wtErr('Could not read comp.properties.numItems: ' + countResult.error);

    var out = [];
    for (var i = 0; i < countResult.value; i++) {
        var propResult = wtSafeGet(function () { return comp.properties[i]; });
        if (!propResult.ok) {
            out.push({ index: i, error: propResult.error });
            continue;
        }
        var prop = propResult.value;
        var vResult = wtSafeGet(function () { return prop.getValue(); });
        out.push({
            index: i,
            displayName: wtFieldOrError(function () { return prop.displayName; }),
            propertyType: wtFieldOrError(function () { return prop.propertyType; }),
            isGroupMarker: wtIsGroupMarker(prop),
            looksLikeText: wtIsTextLeaf(prop),
            value: vResult.ok ? wtFieldOrError(function () { return String(vResult.value); }) : ('ERROR: ' + vResult.error)
        });
    }

    return wtOk({ properties: out });
};

/**
 * wtWalkScriptureGraphics(argsJson) — args: { sequenceIndex?, audioTrackIndex? }
 * THE MAIN DELIVERABLE. Walks every video/audio clip, keeps only ones with a
 * truthy getMGTComponent(), and for each returns timing (ticks + seconds)
 * plus best-effort extracted text field values — sorted ascending by
 * startTicks, ready to feed the raw-audio confirmation pass for T-02.
 *
 * Pass `audioTrackIndex` (find it with wtWalkAudioClips first) to also
 * resolve each graphic's SOURCE time (seconds into the raw sermon audio
 * FILE, not the sequence — see the file-header note on sequence vs source
 * time). Without it, only sequence-relative startSeconds/endSeconds are
 * returned, which will NOT line up with the raw audio file if anything was
 * trimmed off the front or cut out of the middle during editing.
 *
 * Read the file-level CAVEAT comments before treating this as ground truth
 * without listening to each one.
 */
var wtWalkScriptureGraphics = function (argsJson) {
    var args = argsJson ? JSON.parse(argsJson) : {};
    var seq = wtResolveSequence(args);
    if (!seq) return wtErr('Open a sequence first, or sequenceIndex is out of range.');

    var hasAudioTrackIndex = typeof args.audioTrackIndex === 'number';

    var out = [];
    var i, j, track;

    var describe = function (clip, trackType, trackIndex, clipIndex) {
        var mgtResult = wtSafeGet(function () { return clip.getMGTComponent(); });
        if (!mgtResult.ok || !mgtResult.value) return null;

        var startTicks = wtFieldOrError(function () { return clip.start.ticks; });
        var endTicks = wtFieldOrError(function () { return clip.end.ticks; });
        var fieldsResult = wtDescribeMGTFields(mgtResult.value);

        var entry = {
            trackType: trackType,
            trackIndex: trackIndex,
            clipIndex: clipIndex,
            clipName: wtFieldOrError(function () { return clip.name; }),
            startTicks: startTicks,
            endTicks: endTicks,
            startSeconds: (typeof startTicks === 'string') ? Number(startTicks) / WT_TICKS_PER_SECOND : null,
            endSeconds: (typeof endTicks === 'string') ? Number(endTicks) / WT_TICKS_PER_SECOND : null,
            textFieldsError: fieldsResult.error,
            textFields: fieldsResult.fields,
            sourceSeconds: null,
            sourceResolved: false,
            sourceResolutionNote: hasAudioTrackIndex ? null : 'audioTrackIndex not provided — startSeconds is SEQUENCE time, not source/raw-audio time.'
        };

        if (hasAudioTrackIndex && typeof startTicks === 'string') {
            var srcResult = wtResolveSourceSeconds(seq, args.audioTrackIndex, Number(startTicks));
            if (srcResult.resolved) {
                entry.sourceSeconds = srcResult.sourceSeconds;
                entry.sourceResolved = true;
                entry.sequenceToSourceOffsetSeconds = srcResult.sequenceToSourceOffsetSeconds;
                entry.sourceClipName = srcResult.clipName;
                entry.sourceMediaPath = srcResult.mediaPath;
                if (srcResult.speedWarning) entry.sourceResolutionNote = srcResult.speedWarning;
            } else {
                entry.sourceResolutionNote = srcResult.reason;
            }
        }

        return entry;
    };

    for (i = 0; i < seq.videoTracks.numTracks; i++) {
        track = seq.videoTracks[i];
        for (j = 0; j < track.clips.numItems; j++) {
            var d = describe(track.clips[j], 'video', i, j);
            if (d) out.push(d);
        }
    }
    for (i = 0; i < seq.audioTracks.numTracks; i++) {
        track = seq.audioTracks[i];
        for (j = 0; j < track.clips.numItems; j++) {
            var d2 = describe(track.clips[j], 'audio', i, j);
            if (d2) out.push(d2);
        }
    }

    out.sort(function (a, b) {
        var an = Number(a.startTicks), bn = Number(b.startTicks);
        if (isNaN(an) || isNaN(bn)) return 0;
        return an - bn;
    });

    return wtOk({ graphics: out, graphicCount: out.length });
};
