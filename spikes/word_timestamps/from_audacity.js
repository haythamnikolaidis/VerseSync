#!/usr/bin/env node
/**
 * from_audacity.js — turn an edited Audacity label-track export back into
 * T-02's ground-truth CSV (see spikes/word_timestamps/console-driver.md,
 * "Building the timing file").
 *
 * Usage:
 *   node from_audacity.js <edited-labels.txt> <meta.json> <ground_truth.csv> [--fps 29.97]
 *
 * <edited-labels.txt> — Audacity's File > Export > Export Labels... output,
 *   after you've nudged each point to the true word onset by ear.
 * <meta.json>         — the sidecar written by to_audacity.js for this same
 *   sermon, used to recover each label's scripture reference (the
 *   "Description" group guess) and original clip info via its "#N" prefix.
 * [--fps]             — optional. If given, adds a start_timecode_hint
 *   column (HH:MM:SS:FF, non-drop-frame) for jumping back into Premiere.
 *   Omit if you don't need it — start_seconds is what the error measurement
 *   in T-02 actually uses.
 *
 * Labels you added or fully retyped by hand in Audacity (no "#N" prefix, or
 * a prefix with no matching entry in meta.json) are kept as rows with
 * source=manual and an empty reference — fill those in yourself afterward
 * (this covers paraphrased mentions you timed by ear with no graphic at all).
 */

var fs = require('fs');

var args = process.argv.slice(2);
var fpsArgIndex = args.indexOf('--fps');
var fps = null;
if (fpsArgIndex !== -1) {
    fps = Number(args[fpsArgIndex + 1]);
    args.splice(fpsArgIndex, 2);
}

var labelsPath = args[0];
var metaPath = args[1];
var outCsvPath = args[2];

if (!labelsPath || !metaPath || !outCsvPath) {
    console.error('Usage: node from_audacity.js <edited-labels.txt> <meta.json> <ground_truth.csv> [--fps 29.97]');
    process.exit(1);
}

function csvEscape(s) {
    if (s === null || typeof s === 'undefined') return '';
    var str = String(s);
    if (/[",\n]/.test(str)) {
        return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

function secondsToTimecode(seconds, fps) {
    var totalFrames = Math.round(seconds * fps);
    var nominalFps = Math.round(fps);
    var ff = totalFrames % nominalFps;
    var totalSeconds = Math.floor(totalFrames / nominalFps);
    var ss = totalSeconds % 60;
    var totalMinutes = Math.floor(totalSeconds / 60);
    var mm = totalMinutes % 60;
    var hh = Math.floor(totalMinutes / 60);
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return pad(hh) + ':' + pad(mm) + ':' + pad(ss) + ':' + pad(ff);
    // Non-drop-frame display only — see spike.jsx's note on wtSetPlayhead/
    // timecode for why this won't exactly match Premiere's own drop-frame
    // display at 29.97/59.94, even though the frame count is exact.
}

var meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
var metaByIndex = {};
meta.forEach(function (m) { metaByIndex[m.index] = m; });

var rawLines = fs.readFileSync(labelsPath, 'utf8').split(/\r?\n/).filter(function (l) { return l.trim().length > 0; });

var rows = [];
var manualCount = 0;
var unmatchedPrefixCount = 0;

rawLines.forEach(function (line) {
    var parts = line.split('\t');
    if (parts.length < 3) {
        console.error('Skipping malformed line (expected start\\tend\\tlabel): ' + line);
        return;
    }
    var startSeconds = Number(parts[0]);
    var label = parts.slice(2).join('\t'); // tolerate a stray literal tab inside label text

    var m = /^#(\d+)\s*(\[NO-TEXT\]\s*)?(.*)$/.exec(label);
    var row = {
        startSeconds: startSeconds,
        label: label,
        source: 'manual',
        reference: '',
        notes: ''
    };

    if (m) {
        var idx = Number(m[1]);
        var metaEntry = metaByIndex[idx];
        if (metaEntry) {
            row.source = 'graphic';
            row.reference = metaEntry.referenceGuess || metaEntry.referenceRaw || '';
            var noteBits = ['orig #' + idx, metaEntry.clipName ? ('clip "' + metaEntry.clipName + '"') : null,
                (metaEntry.trackType + metaEntry.trackIndex + '/' + metaEntry.clipIndex)];
            if (!metaEntry.referenceGuess) noteBits.push('reference not auto-parsed — verify/fill by hand');
            if (metaEntry.noTextFound) noteBits.push('body text was not auto-parsed either — check original clip');
            row.notes = noteBits.filter(Boolean).join('; ');
        } else {
            unmatchedPrefixCount++;
            row.notes = 'label had "#' + idx + '" prefix but no matching entry in meta.json — check meta.json is for the same sermon/run';
        }
    } else {
        manualCount++;
        row.notes = 'no "#N" prefix — added or fully retyped by hand in Audacity; fill in reference manually';
    }

    rows.push(row);
});

rows.sort(function (a, b) { return a.startSeconds - b.startSeconds; });

var header = ['index', 'reference', 'start_seconds', 'start_timecode_hint', 'source', 'confirmed', 'notes'];
var csvLines = [header.join(',')];

rows.forEach(function (row, i) {
    var timecodeHint = fps ? secondsToTimecode(row.startSeconds, fps) : '';
    var cols = [
        i + 1,
        csvEscape(row.reference),
        row.startSeconds.toFixed(3),
        timecodeHint,
        row.source,
        'true', // this file only exists because you confirmed each point by ear in Audacity
        csvEscape(row.notes)
    ];
    csvLines.push(cols.join(','));
});

fs.writeFileSync(outCsvPath, csvLines.join('\n') + '\n', 'utf8');

console.log('Wrote ' + rows.length + ' rows to ' + outCsvPath);
if (manualCount > 0) {
    console.log(manualCount + ' row(s) had no "#N" prefix (added/retyped by hand) — reference left blank, fill in manually.');
}
if (unmatchedPrefixCount > 0) {
    console.log('WARNING: ' + unmatchedPrefixCount + ' row(s) had a "#N" prefix that did not match meta.json — double check you used the right meta.json for this labels file.');
}
if (!fps) {
    console.log('No --fps given — start_timecode_hint column left blank. Pass --fps <sequence fps> if you want it filled in.');
}
