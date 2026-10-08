#!/usr/bin/env node
/**
 * to_audacity.js — turn wtWalkScriptureGraphics' raw JSON into an Audacity
 * label-track import file, so T-02's ground-truth timestamps can be nudged
 * to the frame by ear in Audacity instead of hand-converting ticks/frames to
 * seconds.
 *
 * Usage:
 *   node to_audacity.js <graphics.json> <labels.txt> [meta.json]
 *
 * <graphics.json>  — paste the result of
 *     VFBridge.call('wtWalkScriptureGraphics', { audioTrackIndex: N }).then(r => copy(r))
 *   into this file. Accepts the bare { graphics: [...] } shape, the full
 *   { ok, data: { graphics: [...] } } bridge envelope, or a raw array —
 *   whichever you pasted. PASS audioTrackIndex when you call
 *   wtWalkScriptureGraphics (find it with wtWalkAudioClips first) — without
 *   it, each entry only has sequence-relative startSeconds, which will NOT
 *   line up with the raw audio file the moment anything was trimmed off the
 *   front or cut out of the middle during editing. This script uses
 *   sourceSeconds when present and falls back to startSeconds (with a loud
 *   warning) otherwise.
 *
 * <labels.txt>     — Audacity label-track import file (File > Import > Labels).
 *   Each line: start\tend\tlabel — point labels (start === end).
 *
 * [meta.json]      — sidecar mapping each label's stable "#N" index back to
 *   its full original record (reference guess, clip, ticks, etc.), consumed
 *   by from_audacity.js after you've edited in Audacity. Defaults to
 *   <labels.txt> with .meta.json instead of .txt.
 *
 * Label text is "#N <Title Main guess>" — the body/quote text, per request,
 * not the citation — so in Audacity you're matching what's actually spoken,
 * not a reference that may not be read aloud verbatim. The "#N" prefix is
 * the ONLY thing from_audacity.js uses to reconnect an edited label back to
 * its metadata (including the actual scripture reference) — it survives you
 * nudging, re-sorting, or retyping the rest of the label text in Audacity,
 * as long as you don't delete the prefix. Labels with no recognizable text
 * (parse failure) are marked "[NO-TEXT]" so they're easy to spot and fix by
 * ear/eye in Audacity before you export.
 */

var fs = require('fs');

var inPath = process.argv[2];
var outLabelsPath = process.argv[3];
var outMetaPath = process.argv[4] || outLabelsPath.replace(/\.[^./\\]+$/, '') + '.meta.json';

if (!inPath || !outLabelsPath) {
    console.error('Usage: node to_audacity.js <graphics.json> <labels.txt> [meta.json]');
    process.exit(1);
}

function loadGraphics(path) {
    var raw = fs.readFileSync(path, 'utf8');
    var parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed.graphics) return parsed.graphics;
    if (parsed.data && parsed.data.graphics) return parsed.data.graphics;
    throw new Error('Could not find a "graphics" array in ' + path + ' — check it is wtWalkScriptureGraphics\' output.');
}

function sanitizeLabelText(s) {
    return String(s).replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function findField(textFields, groupName) {
    if (!textFields) return null;
    for (var i = 0; i < textFields.length; i++) {
        var f = textFields[i];
        if (f && typeof f.group === 'string' && f.group.trim().toLowerCase() === groupName.toLowerCase()) {
            return f;
        }
    }
    return null;
}

var graphics = loadGraphics(inPath);

function effectiveSeconds(g) {
    return (g.sourceResolved === true && typeof g.sourceSeconds === 'number') ? g.sourceSeconds : Number(g.startSeconds);
}

// Defensive — wtWalkScriptureGraphics already sorts by startTicks, but an
// edited/concatenated input file might not be. Sort by whichever time each
// entry will actually use as its label, not always sequence time.
graphics.sort(function (a, b) {
    return effectiveSeconds(a) - effectiveSeconds(b);
});

var labelLines = [];
var meta = [];
var missingTitleCount = 0;
var missingDescriptionCount = 0;
var sourceResolvedCount = 0;
var sourceUnresolvedCount = 0;

for (var i = 0; i < graphics.length; i++) {
    var g = graphics[i];
    var index = i + 1;

    var titleField = findField(g.textFields, 'Title Main');
    var descField = findField(g.textFields, 'Description');

    var bodyText;
    var noText = false;
    if (titleField && titleField.guess) {
        bodyText = titleField.guess;
    } else if (titleField && titleField.raw) {
        bodyText = titleField.raw;
        noText = true; // raw fallback, not a clean parse — flag it
    } else {
        bodyText = g.clipName || '(no text found)';
        noText = true;
        missingTitleCount++;
    }
    if (!descField) missingDescriptionCount++;

    var usedSource = g.sourceResolved === true && typeof g.sourceSeconds === 'number';
    if (typeof g.sourceSeconds !== 'undefined') {
        if (usedSource) sourceResolvedCount++; else sourceUnresolvedCount++;
    }

    var sanitized = sanitizeLabelText(bodyText);
    var flags = (noText ? ' [NO-TEXT]' : '') + (!usedSource && typeof g.sourceSeconds !== 'undefined' ? ' [SEQ-TIME-UNRESOLVED]' : '');
    var labelText = '#' + index + flags + ' ' + sanitized;

    var t = effectiveSeconds(g).toFixed(6);
    labelLines.push(t + '\t' + t + '\t' + labelText);

    meta.push({
        index: index,
        clipName: g.clipName,
        trackType: g.trackType,
        trackIndex: g.trackIndex,
        clipIndex: g.clipIndex,
        startTicks: g.startTicks,
        endTicks: g.endTicks,
        sequenceStartSeconds: Number(g.startSeconds),
        sequenceEndSeconds: Number(g.endSeconds),
        sourceSeconds: usedSource ? g.sourceSeconds : null,
        sourceResolved: usedSource,
        sourceResolutionNote: g.sourceResolutionNote || null,
        labelSeconds: effectiveSeconds(g),
        titleGuess: titleField ? titleField.guess : null,
        titleRaw: titleField ? titleField.raw : null,
        referenceGuess: descField ? descField.guess : null,
        referenceRaw: descField ? descField.raw : null,
        noTextFound: noText,
        noDescriptionFound: !descField
    });
}

fs.writeFileSync(outLabelsPath, labelLines.join('\n') + '\n', 'utf8');
fs.writeFileSync(outMetaPath, JSON.stringify(meta, null, 2), 'utf8');

console.log('Wrote ' + labelLines.length + ' labels to ' + outLabelsPath);
console.log('Wrote metadata sidecar to ' + outMetaPath);

if (sourceResolvedCount === 0 && sourceUnresolvedCount === 0) {
    console.log('');
    console.log('*** WARNING: no sourceSeconds field found on ANY graphic. ***');
    console.log('These labels are in SEQUENCE time, not source/raw-audio time —');
    console.log('they will NOT line up with the raw sermon audio file if anything');
    console.log('was trimmed off the front or cut during editing. Re-run with');
    console.log('wtWalkScriptureGraphics({ audioTrackIndex: N }) (find N with');
    console.log('wtWalkAudioClips first) and regenerate this file before importing.');
    console.log('');
} else if (sourceUnresolvedCount > 0) {
    console.log('WARNING: ' + sourceUnresolvedCount + ' graphic(s) could not be resolved to source time (marked [SEQ-TIME-UNRESOLVED] — check sourceResolutionNote in ' + outMetaPath + ') and fell back to sequence time for their label position.');
}
if (missingTitleCount > 0) {
    console.log('WARNING: ' + missingTitleCount + ' graphic(s) had no "Title Main" text at all (used clip name) — marked [NO-TEXT], check these by eye.');
}
if (missingDescriptionCount > 0) {
    console.log('NOTE: ' + missingDescriptionCount + ' graphic(s) had no "Description" group — from_audacity.js will leave their reference blank for you to fill in.');
}
console.log('Next: in Audacity, File > Import > Labels... on ' + outLabelsPath + ', import your raw sermon audio alongside it, edit/nudge each label to the frame, then File > Export > Export Labels...');
