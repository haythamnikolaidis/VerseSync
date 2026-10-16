(function (root) {
  'use strict';

  // Journey B, steps 1-2 (docs/03 §4, docs/08 §6, docs/09 §6): decide whether Insert may run,
  // build the single VS.insertCues payload, and word the overwrite confirmation. Pure functions
  // only; the click flow that calls the host lives elsewhere.
  //
  // ctx is { settings, sequenceId, model, placements } where settings is VSState's get() result,
  // sequenceId comes from the analysis (session.sequenceId), model is the VSCues model and
  // placements is VSTimemap.mapCueDocument's placements map.

  var State = typeof require !== 'undefined' ? require('./state.js') : root.VSState;

  // The analyse-time blockers that still matter once a document exists. The strings are taken
  // from VSState, so the two lists can never drift apart. Media, translation and sidecar are
  // left out: the analysis already ran.
  var SHARED_BLOCKERS = [
    'Open a sequence in Premiere first.',
    'Select a template.',
    'This template has no editable text fields.',
    'Map both template fields.',
    'Reference and scripture must use different fields.',
    'Select a target track.'
  ];

  var NO_ENABLED = 'Enable at least one scripture to insert.';
  var FLAGGED_PREFIX = 'Resolve the flagged cues before inserting: ';

  // Flags an enabled cue cannot be inserted with: three come from the sidecar and sit on the
  // cue, two are added by the panel after mapping and sit on the placement (docs/07 §5.1).
  var BLOCKING_CUE_FLAGS = ['text_unavailable', 'passage_not_found', 'chapter_only'];
  var BLOCKING_PLACEMENT_FLAGS = ['cut_from_edit', 'speed_change_unsupported'];

  function hasAny(list, wanted) {
    if (!list) { return false; }
    for (var i = 0; i < wanted.length; i++) {
      if (list.indexOf(wanted[i]) !== -1) { return true; }
    }
    return false;
  }

  function enabledCues(model) {
    var out = [];
    var all = model.cues();
    for (var i = 0; i < all.length; i++) {
      if (all[i].enabled) { out.push(all[i]); }
    }
    return out;
  }

  function flaggedIds(model, placements) {
    var ids = [];
    var cues = enabledCues(model);
    for (var i = 0; i < cues.length; i++) {
      var placement = placements && placements[cues[i].id];
      if (hasAny(cues[i].flags, BLOCKING_CUE_FLAGS) ||
          (placement && hasAny(placement.panelFlags, BLOCKING_PLACEMENT_FLAGS))) {
        ids.push(cues[i].id);
      }
    }
    return ids;
  }

  function blockers(ctx) {
    var out = [];
    var fromState = State.analyseBlockers(ctx.settings);
    for (var i = 0; i < fromState.length; i++) {
      if (SHARED_BLOCKERS.indexOf(fromState[i]) !== -1) { out.push(fromState[i]); }
    }
    if (ctx.model.enabledCount() === 0) { out.push(NO_ENABLED); }
    var flagged = flaggedIds(ctx.model, ctx.placements);
    if (flagged.length > 0) { out.push(FLAGGED_PREFIX + flagged.join(', ')); }
    return out;
  }

  // Tick strings hold non-negative integers with no leading zeros (docs/08 §1), so a longer
  // string is a larger number and equal lengths compare lexicographically. That is exact for
  // values beyond 2^53, which a Number parse would not be.
  function compareTicks(a, b) {
    if (a.length !== b.length) { return a.length < b.length ? -1 : 1; }
    if (a === b) { return 0; }
    return a < b ? -1 : 1;
  }

  // Only enabled cues, sorted ascending by atTicks as the host requires (docs/08 §6). Equal
  // starts keep document order. Every blocker must be clear before this is called, so an
  // enabled cue without a placement is a programming error and throws.
  function buildPayload(model, placements, ctx) {
    var picked = [];
    var cues = enabledCues(model);
    for (var i = 0; i < cues.length; i++) {
      var placement = placements && placements[cues[i].id];
      if (!placement) { throw new Error('No placement for cue ' + cues[i].id); }
      picked.push({
        index: i,
        cue: {
          id: cues[i].id,
          atTicks: placement.atTicks,
          durationTicks: placement.durationTicks,
          reference: cues[i].reference_display,
          body: cues[i].body
        }
      });
    }
    picked.sort(function (a, b) {
      return compareTicks(a.cue.atTicks, b.cue.atTicks) || (a.index - b.index);
    });
    var sorted = [];
    for (var j = 0; j < picked.length; j++) { sorted.push(picked[j].cue); }
    return {
      sequenceId: ctx.sequenceId,
      mogrtPath: ctx.settings.mogrtPath,
      trackIndex: ctx.settings.targetTrack,
      mapping: {
        referenceIndex: ctx.settings.referenceIndex,
        bodyIndex: ctx.settings.bodyIndex
      },
      cues: sorted
    };
  }

  // conflicts is VS.validateTrack's data.conflicts: one entry per overwritten clip, so a cue
  // that covers two clips appears twice. The sentence counts cues, not clips.
  function confirmText(conflicts, trackIndex) {
    var seen = {};
    var count = 0;
    for (var i = 0; i < conflicts.length; i++) {
      var key = String(conflicts[i].rangeIndex);
      if (!Object.prototype.hasOwnProperty.call(seen, key)) {
        seen[key] = true;
        count++;
      }
    }
    var track = 'V' + (trackIndex + 1);
    if (count === 1) {
      return '1 of your cues will overwrite an existing clip on ' + track + '. Continue?';
    }
    return count + ' of your cues will overwrite existing clips on ' + track + '. Continue?';
  }

  var Insert = {
    blockers: blockers,
    buildPayload: buildPayload,
    confirmText: confirmText
  };

  if (typeof module !== 'undefined' && module.exports) { module.exports = Insert; }
  else { root.VSInsert = Insert; }
})(this);
