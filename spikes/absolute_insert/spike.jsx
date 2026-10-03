/**
 * spike.jsx — T-03: does importMGT() on a populated Premiere track overwrite
 * what's there, or insert-and-ripple everything after it?
 *
 * Standalone and self-contained — load it with $.evalFile() from any already-
 * open CEP panel's DevTools console (we reuse VerseFlow's debug-mode panel
 * rather than standing up a separate VerseSync extension for this spike).
 * It does not depend on VF.* from VerseFlow.jsx; it only needs an active
 * Premiere sequence in the same process.
 *
 * `var fn = function () {}` throughout, never `function fn() {}` — Premiere
 * 2026's $.evalFile() does not reliably hoist plain function declarations
 * into persistent global scope (see ../../docs/08-premiere-host-api.md §1.4).
 */

var spikeOk = function (data) {
    return JSON.stringify({ ok: true, data: data });
};

var spikeErr = function (msg) {
    return JSON.stringify({ ok: false, error: String(msg) });
};

var spikeBuildTime = function (ticksStr) {
    var t = new Time();
    t.ticks = ticksStr;
    return t;
};

// Premiere's internal tick rate is a fixed 254,016,000,000 ticks per second,
// independent of the sequence's frame rate — do not derive this from fps.
var SPIKE_TICKS_PER_SECOND = 254016000000;

/**
 * spikeSecondsToTicks(argsJson) — args: { seconds }
 * Use this instead of hand-computing tick values for atTicks/durationTicks.
 * A malformed tick string (wrong digit count, stray characters) passed
 * straight into importMGT/Time.ticks is a plausible cause of the fatal,
 * uncatchable ExtendScript crash this spike is prone to — always derive
 * ticks here or read them back from spikeSnapshotSequence, never by hand.
 */
var spikeSecondsToTicks = function (argsJson) {
    var args = JSON.parse(argsJson);
    return spikeOk({ ticks: String(Math.round(Number(args.seconds) * SPIKE_TICKS_PER_SECOND)) });
};

// Lifted from VerseFlow.jsx / jsx/modules/mogrt.jsx, unchanged — T-03 step 4
// exists specifically to characterise this function's edge behaviour.
var spikeSetClipDuration = function (clip, durationTicksStr) {
    var startNum = Number(clip.start.ticks);
    var endNum = startNum + Number(durationTicksStr);
    var endTime = spikeBuildTime(String(endNum));
    try {
        clip.end = endTime;
    } catch (e) {
        try {
            clip.outPoint = endTime;
        } catch (e2) {
            throw new Error('Could not set clip duration: ' + e2.toString());
        }
    }
};

/**
 * spikePing() — confirms this file (not VerseFlow.jsx) answered the call.
 */
var spikePing = function () {
    return spikeOk({ pong: true, file: 'spike.jsx' });
};

/**
 * spikeSnapshotSequence() -> every clip on every video/audio track.
 * Call before and after each test case and diff by eye (or with
 * spikeDiffSnapshots) to see what moved.
 */
var spikeSnapshotSequence = function () {
    var seq = app.project.activeSequence;
    if (!seq) return spikeErr('Open a sequence first.');

    var out = [];
    var i, j, track, clip;

    for (i = 0; i < seq.videoTracks.numTracks; i++) {
        track = seq.videoTracks[i];
        for (j = 0; j < track.clips.numItems; j++) {
            clip = track.clips[j];
            out.push({
                trackType: 'video', trackIndex: i, clipIndex: j,
                name: clip.name,
                startTicks: clip.start.ticks, endTicks: clip.end.ticks
            });
        }
    }
    for (i = 0; i < seq.audioTracks.numTracks; i++) {
        track = seq.audioTracks[i];
        for (j = 0; j < track.clips.numItems; j++) {
            clip = track.clips[j];
            out.push({
                trackType: 'audio', trackIndex: i, clipIndex: j,
                name: clip.name,
                startTicks: clip.start.ticks, endTicks: clip.end.ticks
            });
        }
    }
    return spikeOk({ clips: out, sequenceEndTicks: seq.end ? seq.end.ticks : null });
};

/**
 * spikeDiffSnapshots(argsJson) — args: { before: [...], after: [...] }
 * Groups by (trackType, trackIndex) and reports the full before/after
 * interval list for any track whose clip count or ticks changed at all.
 *
 * Deliberately does NOT try to match individual clips by name — this
 * project's tracks have many clips sharing the same MOGRT-derived name
 * ("AV Quote 04"), so a name-keyed match silently collides and hides real
 * changes (confirmed: it reported no diff on a track where a clip had
 * visibly been trimmed). Raw before/after lists per track are unambiguous;
 * read them directly rather than trusting an auto-generated "moved" label.
 */
var spikeDiffSnapshots = function (argsJson) {
    var args = JSON.parse(argsJson);
    var trackKey = function (c) { return c.trackType + ':' + c.trackIndex; };
    var simplify = function (c) { return { clipIndex: c.clipIndex, name: c.name, startTicks: c.startTicks, endTicks: c.endTicks }; };

    var grouped = {};
    var i;
    for (i = 0; i < args.before.length; i++) {
        var bk = trackKey(args.before[i]);
        if (!grouped[bk]) grouped[bk] = { before: [], after: [] };
        grouped[bk].before.push(simplify(args.before[i]));
    }
    for (i = 0; i < args.after.length; i++) {
        var ak = trackKey(args.after[i]);
        if (!grouped[ak]) grouped[ak] = { before: [], after: [] };
        grouped[ak].after.push(simplify(args.after[i]));
    }

    var changedTracks = [];
    for (var k in grouped) {
        var g = grouped[k];
        if (JSON.stringify(g.before) !== JSON.stringify(g.after)) {
            changedTracks.push({
                track: k,
                beforeCount: g.before.length, afterCount: g.after.length,
                before: g.before, after: g.after
            });
        }
    }

    return spikeOk({ changedTracks: changedTracks });
};

/**
 * spikeTrackCounts() -> { videoTrackCount, audioTrackCount }
 * importMGT with an out-of-range trackIndex throws a fatal ExtendScript
 * exception that try/catch cannot intercept (shows up as the opaque
 * "EvalScript error." sentinel in bridge.js, not a clean spikeErr). Check
 * this first whenever a spike call dies that way. Video tracks are
 * zero-indexed: V3 is trackIndex 2, not 3.
 */
var spikeTrackCounts = function () {
    var seq = app.project.activeSequence;
    if (!seq) return spikeErr('Open a sequence first.');
    return spikeOk({
        videoTrackCount: seq.videoTracks.numTracks,
        audioTrackCount: seq.audioTracks.numTracks
    });
};

/**
 * spikeClipsOnTrack(argsJson) — args: { trackType, trackIndex }
 * Narrower than spikeSnapshotSequence — use this to check what's actually on
 * one track (e.g. is trackIndex 3 populated at all?) without a huge dump that
 * the DevTools console truncates. In Chrome DevTools, `copy(result)` copies
 * the full object to the clipboard if you do need the whole thing untruncated.
 */
var spikeClipsOnTrack = function (argsJson) {
    var args = JSON.parse(argsJson);
    var seq = app.project.activeSequence;
    if (!seq) return spikeErr('Open a sequence first.');

    var trackCount = args.trackType === 'audio' ? seq.audioTracks.numTracks : seq.videoTracks.numTracks;
    if (args.trackIndex < 0 || args.trackIndex >= trackCount) {
        return spikeErr('trackIndex ' + args.trackIndex + ' is out of range — this sequence has ' +
            trackCount + ' ' + args.trackType + ' track(s) (valid: 0-' + (trackCount - 1) + ').');
    }

    var track = args.trackType === 'audio' ? seq.audioTracks[args.trackIndex] : seq.videoTracks[args.trackIndex];
    var out = [];
    for (var j = 0; j < track.clips.numItems; j++) {
        var clip = track.clips[j];
        out.push({ clipIndex: j, name: clip.name, startTicks: clip.start.ticks, endTicks: clip.end.ticks });
    }
    return spikeOk({ clipCount: out.length, clips: out });
};

/**
 * spikeTrackSummary() -> clip count per track, all video and audio tracks.
 * Cheap scan to spot a genuinely empty track or a gap, without the full
 * per-clip dump of spikeSnapshotSequence.
 */
var spikeTrackSummary = function () {
    var seq = app.project.activeSequence;
    if (!seq) return spikeErr('Open a sequence first.');

    var out = [];
    var i;
    for (i = 0; i < seq.videoTracks.numTracks; i++) {
        out.push({ trackType: 'video', trackIndex: i, clipCount: seq.videoTracks[i].clips.numItems });
    }
    for (i = 0; i < seq.audioTracks.numTracks; i++) {
        out.push({ trackType: 'audio', trackIndex: i, clipCount: seq.audioTracks[i].clips.numItems });
    }
    return spikeOk({ tracks: out });
};

/**
 * spikeResolvePath(argsJson) — args: { path }
 * Reports the native (fsName) form of a path and whether File sees it as
 * existing. VerseFlow's own VF.pickFile() returns File.openDialog()'s
 * .fsName — a backslash path on Windows — and that's the only form ever
 * exercised by VerseFlow's working insert path. Use the returned fsName as
 * mogrtPath, not a hand-typed forward-slash path.
 */
var spikeResolvePath = function (argsJson) {
    var args = JSON.parse(argsJson);
    var f = new File(args.path);
    return spikeOk({ exists: f.exists, fsName: f.fsName, inputWas: args.path });
};

/**
 * spikeFlushUndoGroups(argsJson) — args: { count }
 * If importMGT's failure is a FATAL ExtendScript exception rather than a
 * catchable one, it aborts the whole evalScript call — skipping our catch
 * block and leaving app.endUndoGroup() never called. Every failed insertAt
 * attempt so far may have left an unclosed undo group open, and a pile of
 * unbalanced groups is a known way to make Premiere's undo manager choke on
 * all subsequent edits (explaining a crash on inputs that should trivially
 * work, like an empty track). Call this to close out any stray open groups
 * before retrying.
 */
var spikeFlushUndoGroups = function (argsJson) {
    var args = JSON.parse(argsJson);
    var n = args.count || 20;
    var closed = 0;
    for (var i = 0; i < n; i++) {
        try { app.endUndoGroup(); closed++; } catch (e) { break; }
    }
    return spikeOk({ closedAttempts: closed });
};

/**
 * spikeInsertAt(argsJson) — args: { mogrtPath, trackIndex, atTicks }
 * T-03 steps 2 & 3: single insert on a populated track, an empty track, or
 * past the sequence end.
 *
 * Deliberately NOT wrapped in app.beginUndoGroup/endUndoGroup. importMGT's
 * failure mode on this build is a FATAL ExtendScript exception that skips
 * our catch block entirely (confirmed empirically) — so begin/end pairing
 * around it is unsafe: a failed call leaves the group open, and a pile of
 * unclosed groups then breaks every subsequent edit, including ones that
 * should trivially work. Undo manually in Premiere (Ctrl+Z) between cases;
 * if things do get stuck, call spikeFlushUndoGroups.
 */
var spikeInsertAt = function (argsJson) {
    var args = JSON.parse(argsJson);
    var seq = app.project.activeSequence;
    if (!seq) return spikeErr('Open a sequence first.');

    if (args.trackIndex < 0 || args.trackIndex >= seq.videoTracks.numTracks) {
        return spikeErr('trackIndex ' + args.trackIndex + ' is out of range — this sequence has ' +
            seq.videoTracks.numTracks + ' video track(s) (valid: 0-' +
            (seq.videoTracks.numTracks - 1) + ', i.e. V1-V' + seq.videoTracks.numTracks + ').');
    }

    try {
        var clip = seq.importMGT(args.mogrtPath, args.atTicks, args.trackIndex, 0);
        if (!clip) return spikeErr('importMGT returned null.');
        return spikeOk({
            requestedAtTicks: args.atTicks,
            actualStartTicks: clip.start.ticks,
            actualEndTicks: clip.end.ticks,
            name: clip.name
        });
    } catch (e) {
        return spikeErr('insertAt error: ' + e.toString());
    }
};

/**
 * spikeInsertBatch(argsJson) — args: { mogrtPath, trackIndex, cues: [{id, atTicks}] }
 * T-03 step 5: build `cues` ascending, out-of-order, or descending — this
 * function just inserts in array order and reports readback vs. requested
 * position for every cue.
 *
 * No undo-group wrapping, same reasoning as spikeInsertAt: a fatal crash on
 * any one cue would abort the whole function and skip app.endUndoGroup(),
 * leaving a stuck group. The per-cue try/catch below only helps for
 * genuinely catchable errors — a fatal one still aborts the whole batch, so
 * check the result count against args.cues.length.
 */
var spikeInsertBatch = function (argsJson) {
    var args = JSON.parse(argsJson);
    var seq = app.project.activeSequence;
    if (!seq) return spikeErr('Open a sequence first.');

    if (args.trackIndex < 0 || args.trackIndex >= seq.videoTracks.numTracks) {
        return spikeErr('trackIndex ' + args.trackIndex + ' is out of range — this sequence has ' +
            seq.videoTracks.numTracks + ' video track(s) (valid: 0-' +
            (seq.videoTracks.numTracks - 1) + ', i.e. V1-V' + seq.videoTracks.numTracks + ').');
    }

    var results = [];
    for (var i = 0; i < args.cues.length; i++) {
        var cue = args.cues[i];
        try {
            var clip = seq.importMGT(args.mogrtPath, cue.atTicks, args.trackIndex, 0);
            if (!clip) throw new Error('importMGT returned null');
            results.push({
                id: cue.id, ok: true,
                requestedAtTicks: cue.atTicks,
                actualStartTicks: clip.start.ticks,
                actualEndTicks: clip.end.ticks
            });
        } catch (e) {
            results.push({ id: cue.id, ok: false, error: e.toString() });
        }
    }
    return spikeOk({ results: results });
};

/**
 * spikeExtendClipDuration(argsJson) — args: { trackType, trackIndex, clipIndex, durationTicks }
 * T-03 step 4: push a clip's out-point into whatever sits after it and report
 * the neighbour's start/end before and after. No undo-group wrapping, same
 * reasoning as spikeInsertAt.
 */
var spikeExtendClipDuration = function (argsJson) {
    var args = JSON.parse(argsJson);
    var seq = app.project.activeSequence;
    if (!seq) return spikeErr('Open a sequence first.');

    var trackCount = args.trackType === 'audio' ? seq.audioTracks.numTracks : seq.videoTracks.numTracks;
    if (args.trackIndex < 0 || args.trackIndex >= trackCount) {
        return spikeErr('trackIndex ' + args.trackIndex + ' is out of range — this sequence has ' +
            trackCount + ' ' + args.trackType + ' track(s) (valid: 0-' + (trackCount - 1) + ').');
    }

    var track = args.trackType === 'audio' ? seq.audioTracks[args.trackIndex] : seq.videoTracks[args.trackIndex];
    var clip = track.clips[args.clipIndex];
    if (!clip) return spikeErr('No clip at that index.');

    var next = track.clips[args.clipIndex + 1] || null;
    var before = {
        clipEndTicks: clip.end.ticks,
        nextName: next ? next.name : null,
        nextStartTicks: next ? next.start.ticks : null
    };

    try {
        spikeSetClipDuration(clip, args.durationTicks);
        var nextAfter = track.clips[args.clipIndex + 1] || null;
        var after = {
            clipEndTicks: clip.end.ticks,
            nextName: nextAfter ? nextAfter.name : null,
            nextStartTicks: nextAfter ? nextAfter.start.ticks : null
        };
        return spikeOk({ before: before, after: after });
    } catch (e) {
        return spikeErr('extendClipDuration error: ' + e.toString());
    }
};
