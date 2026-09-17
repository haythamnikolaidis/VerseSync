// T-04 spike — source→sequence mapping characterisation.
// Run from Premiere: File > Scripts > Run Script File... (or the ExtendScript Toolkit
// attached to Premiere) with a sequence open containing the constructs under test.
//
// Writes a log to spikes/media_segments/RESULTS.raw.txt next to this file — ExtendScript's
// $.writeln only reaches an attached ESTK console, not a plain script run, so a file is the
// reliable capture path. Copy/summarise that raw log into RESULTS.md by hand.
//
// Per VerseFlow's hard-won ExtendScript rules (docs/08-premiere-host-api.md §1):
//   - helpers are `var fn = function(){}`, never `function fn(){}`
//   - one file, no #include
//   - ticks are stringified for display only here; this script does its own math in numbers.

(function () {
    var OUT_PATH = Folder.desktop.fsName + "/verse_sync_media_segments_results.txt";
    // Edit OUT_PATH above if you want the log elsewhere, e.g.
    // "D:/Development/Personal/VerseSync/spikes/media_segments/RESULTS.raw.txt".
    // (Folder.desktop.fsName is used instead of "~" — "~" expansion in File() is unreliable
    // on Windows ExtendScript and was producing an empty/wrong-location file.)

    var lines = [];
    var log = function (s) { lines.push(s); };

    var normalisePath = function (p) {
        if (!p) return "";
        var s = String(p);
        s = s.replace(/\\/g, "/");
        return s.toLowerCase();
    };

    var describeClip = function (clip, trackType, trackIndex, clipIndex) {
        var pi = null;
        var mediaPath = "<no projectItem>";
        var err = "";
        try {
            pi = clip.projectItem;
            if (pi && pi.getMediaPath) {
                mediaPath = pi.getMediaPath();
            } else if (pi) {
                mediaPath = "<projectItem present, no getMediaPath()>";
            }
        } catch (e) {
            err = "EXCEPTION reading projectItem/getMediaPath: " + e.toString();
        }

        var start = "", end = "", inPoint = "", speed = "";
        try { start = clip.start ? clip.start.ticks : "<no .start>"; } catch (e1) { start = "EXC:" + e1; }
        try { end = clip.end ? clip.end.ticks : "<no .end>"; } catch (e2) { end = "EXC:" + e2; }
        try { inPoint = clip.inPoint ? clip.inPoint.ticks : "<no .inPoint>"; } catch (e3) { inPoint = "EXC:" + e3; }
        try { speed = clip.getSpeed ? clip.getSpeed() : "<no getSpeed()>"; } catch (e4) { speed = "EXC:" + e4; }

        var name = "";
        try { name = clip.name || "<unnamed>"; } catch (e5) { name = "EXC:" + e5; }

        log("  [" + trackType + " V/A" + trackIndex + " clip " + clipIndex + "] name=" + name);
        log("      mediaPath      = " + mediaPath);
        log("      mediaPath norm = " + normalisePath(mediaPath));
        log("      start.ticks    = " + start);
        log("      end.ticks      = " + end);
        log("      inPoint.ticks  = " + inPoint);
        log("      speed          = " + speed);
        if (err) log("      ERROR = " + err);
    };

    var main = function () {
        log("=== T-04 media-segments spike ===");
        log("Run at: " + new Date().toString());

        if (!app.project || !app.project.activeSequence) {
            log("NO ACTIVE SEQUENCE — open the sermon sequence and re-run.");
            writeOut();
            return;
        }

        var seq = app.project.activeSequence;
        log("Active sequence: " + seq.name);
        log("videoTracks: " + seq.videoTracks.numTracks + "  audioTracks: " + seq.audioTracks.numTracks);

        var t0 = new Date().getTime();
        var totalClips = 0;

        for (var vi = 0; vi < seq.videoTracks.numTracks; vi++) {
            var vTrack = seq.videoTracks[vi];
            log("-- Video track " + vi + " (" + vTrack.clips.numItems + " clips) --");
            for (var vj = 0; vj < vTrack.clips.numItems; vj++) {
                describeClip(vTrack.clips[vj], "video", vi, vj);
                totalClips++;
            }
        }

        for (var ai = 0; ai < seq.audioTracks.numTracks; ai++) {
            var aTrack = seq.audioTracks[ai];
            log("-- Audio track " + ai + " (" + aTrack.clips.numItems + " clips) --");
            for (var aj = 0; aj < aTrack.clips.numItems; aj++) {
                describeClip(aTrack.clips[aj], "audio", ai, aj);
                totalClips++;
            }
        }

        var t1 = new Date().getTime();
        log("=== Walk complete: " + totalClips + " clips in " + (t1 - t0) + " ms ===");

        writeOut();
    };

    var writeOut = function () {
        var f = new File(OUT_PATH);
        var opened = f.open("w");
        if (!opened) {
            alert("T-04 spike: FAILED to open output file for writing:\n" + OUT_PATH +
                  "\nerror: " + f.error);
            return;
        }
        f.encoding = "UTF-8";
        var content = lines.join("\n");
        var wrote = f.write(content);
        f.close();
        alert("T-04 spike complete.\n" +
              "Lines written: " + lines.length + "\n" +
              "write() returned: " + wrote + "\n" +
              "Log: " + OUT_PATH);
    };

    try {
        main();
    } catch (fatal) {
        log("FATAL EXCEPTION: " + fatal.toString() +
            (fatal.line ? (" (line " + fatal.line + ")") : ""));
        writeOut();
    }
})();
