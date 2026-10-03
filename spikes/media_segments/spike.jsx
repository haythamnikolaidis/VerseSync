/**
 * spike.jsx — T-04: characterise VS.getMediaSegments' hardest input —
 * clip.projectItem.getMediaPath() and related fields across real-world edit
 * constructs (straight cut, trim, duplicate media, detached audio,
 * speed-changed, merged clip, multicam clip, nested sequence).
 *
 * Standalone and self-contained, loaded with $.evalFile() from VerseFlow's
 * debug-mode panel — same approach as spikes/absolute_insert, see
 * console-driver.md. Prefixed `ms` (media segments) to avoid colliding with
 * absolute_insert's `spike*` functions if both are loaded in the same
 * session's ExtendScript engine.
 *
 * Read-only — no timeline mutation, so none of absolute_insert's
 * undo-group hazards apply here.
 *
 * `var fn = function () {}` throughout, never `function fn() {}` — Premiere
 * 2026's $.evalFile() does not reliably hoist plain function declarations
 * into persistent global scope (see ../../docs/08-premiere-host-api.md §1.4).
 */

var msOk = function (data) {
    return JSON.stringify({ ok: true, data: data });
};

var msErr = function (msg) {
    return JSON.stringify({ ok: false, error: String(msg) });
};

/**
 * msSafeGet(fn) -> { ok, value } or { ok: false, error }
 * Every property read below is wrapped individually so one clip's exotic
 * construct (e.g. a nested sequence throwing on getMediaPath()) doesn't lose
 * the rest of that clip's data, or abort the whole walk. Whether a given
 * call throws at all is itself part of what this spike is measuring.
 */
var msSafeGet = function (fn) {
    try {
        return { ok: true, value: fn() };
    } catch (e) {
        return { ok: false, error: e.toString() };
    }
};

var msFieldOrError = function (fn) {
    var r = msSafeGet(fn);
    return r.ok ? r.value : ('ERROR: ' + r.error);
};

/**
 * msPing() — confirms this file (not VerseFlow.jsx or absolute_insert's
 * spike.jsx) answered the call.
 */
var msPing = function () {
    return msOk({ pong: true, file: 'media_segments/spike.jsx' });
};

/**
 * msListSequences() -> every open sequence, by index, with which one
 * app.project.activeSequence currently thinks is active.
 *
 * app.project.activeSequence does not reliably track which sequence tab has
 * UI focus — with multiple sequences open it can stay "stuck" on whichever
 * one was last activated some other way. Use this to see what Premiere
 * actually thinks is active, then msSetActiveSequence to force it, rather
 * than relying on clicking a tab.
 */
var msListSequences = function () {
    var seqs = [];
    var current = app.project.activeSequence;
    for (var i = 0; i < app.project.sequences.numSequences; i++) {
        var s = app.project.sequences[i];
        seqs.push({ index: i, name: s.name, isCurrentActiveSequence: s === current });
    }
    return msOk({ sequences: seqs });
};

/**
 * msSetActiveSequence(argsJson) — args: { index }
 * DOES NOT WORK RELIABLY — kept only as a documented negative result.
 * Assigning app.project.activeSequence from script takes effect for the
 * remainder of THAT evalScript call (confirmed: reading it back immediately
 * after shows the new sequence), but does NOT persist to the next, separate
 * evalScript round-trip — Premiere's UI tab focus reasserts itself in
 * between. Use msResolveSequence(index) and pass that index to
 * msWalkSequence/msClipsOnTrack/msTimeWalk instead of relying on this.
 */
var msSetActiveSequence = function (argsJson) {
    var args = JSON.parse(argsJson);
    if (args.index < 0 || args.index >= app.project.sequences.numSequences) {
        return msErr('index ' + args.index + ' is out of range — ' +
            app.project.sequences.numSequences + ' sequence(s) open.');
    }
    app.project.activeSequence = app.project.sequences[args.index];
    return msOk({ name: app.project.activeSequence.name });
};

/**
 * msResolveSequence(args) -> the Sequence object for args.sequenceIndex if
 * given, else app.project.activeSequence. Internal helper — the reliable
 * alternative to trusting activeSequence to have stuck from a prior call.
 */
var msResolveSequence = function (args) {
    if (args && typeof args.sequenceIndex === 'number') {
        if (args.sequenceIndex < 0 || args.sequenceIndex >= app.project.sequences.numSequences) {
            return null;
        }
        return app.project.sequences[args.sequenceIndex];
    }
    return app.project.activeSequence;
};

/**
 * msDescribeClip(clip) -> every field VS.getMediaSegments / T-04 cares about,
 * for one TrackItem. Internal helper, not exposed directly.
 */
var msDescribeClip = function (clip, trackType, trackIndex, clipIndex) {
    var hasProjectItem = msFieldOrError(function () { return !!clip.projectItem; });

    return {
        trackType: trackType,
        trackIndex: trackIndex,
        clipIndex: clipIndex,
        name: msFieldOrError(function () { return clip.name; }),
        startTicks: msFieldOrError(function () { return clip.start.ticks; }),
        endTicks: msFieldOrError(function () { return clip.end.ticks; }),
        inPointTicks: msFieldOrError(function () { return clip.inPoint.ticks; }),
        outPointTicks: msFieldOrError(function () { return clip.outPoint.ticks; }),
        speed: msFieldOrError(function () { return clip.getSpeed(); }),
        hasProjectItem: hasProjectItem,
        mediaPath: msFieldOrError(function () { return clip.projectItem.getMediaPath(); }),
        projectItemName: msFieldOrError(function () { return clip.projectItem.name; }),
        projectItemType: msFieldOrError(function () { return clip.projectItem.type; }),
        projectItemIsSequence: msFieldOrError(function () {
            return typeof clip.projectItem.getSequence === 'function' ? true : false;
        })
    };
};

/**
 * msWalkSequence(argsJson) — args: { sequenceIndex? } (optional)
 * Every clip on every video/audio track, fully described. This is the
 * actual VS.getMediaSegments walk (08 §4) — full-sequence dump, not per-cue.
 * In Chrome DevTools, `copy(result)` copies the full object to the
 * clipboard if the console truncates it.
 *
 * Pass `sequenceIndex` (from msListSequences) to target a specific sequence
 * explicitly — do not rely on app.project.activeSequence having stuck from
 * a prior msSetActiveSequence call; it does not persist across separate
 * evalScript round-trips.
 */
var msWalkSequence = function (argsJson) {
    var args = argsJson ? JSON.parse(argsJson) : {};
    var seq = msResolveSequence(args);
    if (!seq) return msErr('Open a sequence first, or sequenceIndex is out of range.');

    var out = [];
    var i, j, track;

    for (i = 0; i < seq.videoTracks.numTracks; i++) {
        track = seq.videoTracks[i];
        for (j = 0; j < track.clips.numItems; j++) {
            out.push(msDescribeClip(track.clips[j], 'video', i, j));
        }
    }
    for (i = 0; i < seq.audioTracks.numTracks; i++) {
        track = seq.audioTracks[i];
        for (j = 0; j < track.clips.numItems; j++) {
            out.push(msDescribeClip(track.clips[j], 'audio', i, j));
        }
    }

    return msOk({ clips: out, clipCount: out.length });
};

/**
 * msClipsOnTrack(argsJson) — args: { trackType, trackIndex, sequenceIndex? }
 * Narrower than msWalkSequence — use this to inspect one specific
 * known-construct clip without wading through a huge dump. See
 * msWalkSequence's note on sequenceIndex.
 */
var msClipsOnTrack = function (argsJson) {
    var args = JSON.parse(argsJson);
    var seq = msResolveSequence(args);
    if (!seq) return msErr('Open a sequence first, or sequenceIndex is out of range.');

    var trackCount = args.trackType === 'audio' ? seq.audioTracks.numTracks : seq.videoTracks.numTracks;
    if (args.trackIndex < 0 || args.trackIndex >= trackCount) {
        return msErr('trackIndex ' + args.trackIndex + ' is out of range — this sequence has ' +
            trackCount + ' ' + args.trackType + ' track(s) (valid: 0-' + (trackCount - 1) + ').');
    }

    var track = args.trackType === 'audio' ? seq.audioTracks[args.trackIndex] : seq.videoTracks[args.trackIndex];
    var out = [];
    for (var j = 0; j < track.clips.numItems; j++) {
        out.push(msDescribeClip(track.clips[j], args.trackType, args.trackIndex, j));
    }
    return msOk({ clipCount: out.length, clips: out });
};

/**
 * msResolvePath(argsJson) — args: { path }
 * For step 3 (path-format normalisation): reports the native (fsName) form
 * of a mediaPath returned by msWalkSequence, and whether File sees it as
 * existing. Use this to compare forward/back slashes, UNC paths, and
 * drive-letter case against whatever msWalkSequence actually returned.
 */
var msResolvePath = function (argsJson) {
    var args = JSON.parse(argsJson);
    var f = new File(args.path);
    return msOk({ exists: f.exists, fsName: f.fsName, inputWas: args.path });
};

/**
 * msTimeWalk(argsJson) — args: { sequenceIndex? }
 * Time the walk on the longest available sequence. 08 §4 requires one walk
 * per request, not one per cue — this measures what that one walk actually
 * costs. See msWalkSequence's note on sequenceIndex.
 */
var msTimeWalk = function (argsJson) {
    var args = argsJson ? JSON.parse(argsJson) : {};
    var seq = msResolveSequence(args);
    if (!seq) return msErr('Open a sequence first, or sequenceIndex is out of range.');

    var t0 = new Date().getTime();
    var result = JSON.parse(msWalkSequence(argsJson));
    var t1 = new Date().getTime();

    if (!result.ok) return msErr(result.error);
    return msOk({ elapsedMs: t1 - t0, clipCount: result.data.clipCount });
};
