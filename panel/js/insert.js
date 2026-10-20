(function (root) {
  'use strict';

  // Journey B (docs/03 §4, docs/08 §6, docs/09 §6): decide whether Insert may run, build the
  // single VS.insertCues payload, word the overwrite confirmation, run the batch against the
  // host and keep the tally of what landed. Everything here is pure or takes the bridge as an
  // argument; the buttons and text live in main.js.
  //
  // ctx is { settings, sequenceId, model, placements } where settings is VSState's get() result,
  // sequenceId comes from the analysis (session.sequenceId), model is the VSCues model and
  // placements is VSTimemap.mapCueDocument's placements map.

  var State = root.VSState || (typeof require !== 'undefined' ? require('./state.js') : undefined);

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

  // ---- running the batch --------------------------------------------------------------------

  var UNDO_NOTE = 'One Ctrl+Z reverts the whole batch.';
  var MISSING_RESULT = 'The host did not report this cue.';

  function progressText(done, total) {
    return 'Inserting\u2026 ' + done + ' / ' + total;
  }

  function summaryText(placed, total) {
    var failed = total - placed;
    if (failed === 0) { return 'Placed ' + placed + ' of ' + total + '.'; }
    return 'Placed ' + placed + ' of ' + total + ' \u2014 ' + failed + ' failed, see details.';
  }

  // Exact sum of two tick strings (docs/08 §1: ticks are digit strings that may outgrow a double).
  function addTicks(a, b) {
    var out = '';
    var carry = 0;
    var i = a.length - 1;
    var j = b.length - 1;
    while (i >= 0 || j >= 0 || carry) {
      var sum = carry + (i >= 0 ? a.charCodeAt(i) - 48 : 0) + (j >= 0 ? b.charCodeAt(j) - 48 : 0);
      out = String(sum % 10) + out;
      carry = sum >= 10 ? 1 : 0;
      i--;
      j--;
    }
    return out === '' ? '0' : out;
  }

  // The ranges VS.validateTrack checks: where each cue is about to write.
  function rangesOf(payload) {
    var out = [];
    for (var i = 0; i < payload.cues.length; i++) {
      var c = payload.cues[i];
      out.push({ startTicks: c.atTicks, endTicks: addTicks(c.atTicks, c.durationTicks) });
    }
    return out;
  }

  // The same payload narrowed to the given cue ids, keeping its order (and so its sort).
  function onlyCues(payload, ids) {
    var out = {};
    Object.keys(payload).forEach(function (k) { out[k] = payload[k]; });
    out.cues = payload.cues.filter(function (c) { return ids.indexOf(c.id) !== -1; });
    return out;
  }

  // One Insert click after the blockers have passed (docs/09 §6): ask the host which clips the
  // cues would overwrite, confirm if there are any, then make the one insertCues call.
  // opts: { bridge, payload, confirm(text) -> boolean | Promise<boolean> }.
  // Resolves to { state: 'cancelled' } (the editor declined; nothing was inserted),
  // { state: 'error', error } (a host or bridge message, shown verbatim; nothing was inserted
  // unless the host says otherwise) or { state: 'done', results } with the host's per-cue results.
  function execute(opts) {
    var payload = opts.payload;
    return opts.bridge.call('validateTrack', {
      sequenceId: payload.sequenceId,
      trackIndex: payload.trackIndex,
      ranges: rangesOf(payload)
    }).then(function (check) {
      if (!check || !check.ok) {
        return { state: 'error', error: (check && check.error) || 'Could not check the target track.' };
      }
      var conflicts = check.data && check.data.conflicts ? check.data.conflicts : [];
      var go = conflicts.length === 0 ? true : opts.confirm(confirmText(conflicts, payload.trackIndex));
      return Promise.resolve(go).then(function (yes) {
        if (!yes) { return { state: 'cancelled' }; }
        return opts.bridge.call('insertCues', payload).then(function (res) {
          if (!res || !res.ok) {
            return { state: 'error', error: (res && res.error) || 'The insert failed.' };
          }
          return { state: 'done', results: res.data.results || [] };
        });
      });
    });
  }

  // The tally of one Insert, kept across Retry failed so the summary always reads against the
  // original batch. failures maps a cue id to the host's message for it.
  function newRun(payload) {
    return { order: payload.cues.map(function (c) { return c.id; }), placed: {}, failures: {} };
  }

  function recordResults(run, results) {
    var seen = {};
    results.forEach(function (r) {
      seen[r.id] = true;
      if (r.ok) {
        run.placed[r.id] = true;
        delete run.failures[r.id];
      } else {
        delete run.placed[r.id];
        run.failures[r.id] = r.error || 'Insert failed.';
      }
    });
    // A cue the host never mentioned was not placed, whatever else it said.
    run.order.forEach(function (id) {
      if (!seen[id] && !run.placed[id] && !Object.prototype.hasOwnProperty.call(run.failures, id)) {
        run.failures[id] = MISSING_RESULT;
      }
    });
    return run;
  }

  function placedCount(run) {
    return run.order.filter(function (id) { return run.placed[id]; }).length;
  }

  function failedIds(run) {
    return run.order.filter(function (id) {
      return Object.prototype.hasOwnProperty.call(run.failures, id);
    });
  }

  var Insert = {
    UNDO_NOTE: UNDO_NOTE,
    blockers: blockers,
    buildPayload: buildPayload,
    confirmText: confirmText,
    progressText: progressText,
    summaryText: summaryText,
    addTicks: addTicks,
    rangesOf: rangesOf,
    onlyCues: onlyCues,
    execute: execute,
    newRun: newRun,
    recordResults: recordResults,
    placedCount: placedCount,
    failedIds: failedIds
  };

  if (typeof module !== 'undefined' && module.exports) { module.exports = Insert; }
  // Always set the global too (see bridge.js): CEP's mixed-context leaks `module` into the
  // browser window, so this can't be an else-branch without breaking Premiere.
  root.VSInsert = Insert;
})(this);
