// panel/js/lib/host-stub.js (T-39)
//
// A fake `VS` that answers every real host call (docs/08-premiere-host-api.md) with canned
// JSON, so the panel can be built and demoed with no Premiere licence and no Windows
// workstation. Vanilla ES5-compatible JS, no framework, no build step (13-technical-plan.md
// §8 code conventions) — this file is loaded by index.html as a plain <script> tag.
//
// Fixture data below is hand-synced with tests/fixtures/host/*.json. See
// tests/host-stub-fixtures-sync.test.js, which fails the suite if they ever drift — there is
// no runtime fetch of the JSON files because this stub must also work opened directly as a
// file:// page with no server, where fetch() of a local JSON file is unreliable in Chrome.
//
// Activation: window.VS is set only when CSInterface is absent, or behind an explicit
// ?stub=1 (even inside Premiere, for a developer who wants to force stub data). It must never
// activate inside Premiere by default.

(function () {
  'use strict';

  var hasWindow = typeof window !== 'undefined';

  var SEQUENCES = {
    'sequence-2997': {
      hasActiveSequence: true,
      sequenceId: '7f3c2a10-5b8e-4d21-9c47-1e6a0b93d5f2',
      name: 'Sermon 2026-09-14',
      videoTrackCount: 4,
      audioTrackCount: 6,
      playheadTicks: '457228800000000',
      timebase: '8475667200',
      frameRate: 29.97,
      zeroPointTicks: '914457600000000',
      endTicks: '723945600000000'
    },
    'sequence-23976': {
      hasActiveSequence: true,
      sequenceId: 'c41d9e68-2a07-4f5b-b3d1-85e0a7c2f946',
      name: 'Promo 2026-09-20',
      videoTrackCount: 2,
      audioTrackCount: 2,
      playheadTicks: '30481920000000',
      timebase: '10594584000',
      frameRate: 23.976,
      zeroPointTicks: '914457600000000',
      endTicks: '152409600000000'
    },
    'sequence-25': {
      hasActiveSequence: true,
      sequenceId: '0e8b5a37-d6c4-4192-a8f3-3b71c9d04e5a',
      name: 'UK Service 2026-09-27',
      videoTrackCount: 3,
      audioTrackCount: 4,
      playheadTicks: '228614400000000',
      timebase: '10160640000',
      frameRate: 25.0,
      zeroPointTicks: '914457600000000',
      endTicks: '457228800000000'
    },
    'sequence-none': {
      hasActiveSequence: false
    }
  };

  var SEGMENTS = {
    'segments-single': {
      matched: true,
      segments: [
        {
          trackType: 'video', trackIndex: 0,
          seqStartTicks: '0', seqEndTicks: '723945600000000',
          inPointTicks: '0', durationTicks: '723945600000000',
          speed: 1.0, name: 'SERMON_A014.MXF'
        }
      ],
      unsupported: []
    },
    'segments-split': {
      matched: true,
      segments: [
        {
          trackType: 'video', trackIndex: 0,
          seqStartTicks: '0', seqEndTicks: '228614400000000',
          inPointTicks: '0', durationTicks: '228614400000000',
          speed: 1.0, name: 'SERMON_A014.MXF'
        },
        {
          trackType: 'video', trackIndex: 0,
          seqStartTicks: '228614400000000', seqEndTicks: '457228800000000',
          inPointTicks: '304819200000000', durationTicks: '228614400000000',
          speed: 1.0, name: 'SERMON_A014.MXF'
        },
        {
          trackType: 'video', trackIndex: 0,
          seqStartTicks: '457228800000000', seqEndTicks: '647740800000000',
          inPointTicks: '533433600000000', durationTicks: '190512000000000',
          speed: 1.0, name: 'SERMON_A014.MXF'
        }
      ],
      unsupported: []
    },
    'segments-duplicate': {
      matched: true,
      segments: [
        {
          trackType: 'video', trackIndex: 0,
          seqStartTicks: '0', seqEndTicks: '15240960000000',
          inPointTicks: '101606400000000', durationTicks: '15240960000000',
          speed: 1.0, name: 'SERMON_A014.MXF'
        },
        {
          trackType: 'video', trackIndex: 0,
          seqStartTicks: '508032000000000', seqEndTicks: '523272960000000',
          inPointTicks: '101606400000000', durationTicks: '15240960000000',
          speed: 1.0, name: 'SERMON_A014.MXF'
        }
      ],
      unsupported: []
    },
    'segments-speed': {
      matched: true,
      segments: [],
      unsupported: [
        {
          trackType: 'video', trackIndex: 1,
          seqStartTicks: '457228800000000', seqEndTicks: '495837392000000',
          inPointTicks: '0', durationTicks: '38608592000000',
          speed: 2.0, name: 'SERMON_A014.MXF', reason: 'speed_change'
        }
      ]
    },
    'segments-none': {
      matched: false,
      segments: [],
      unsupported: []
    }
  };

  var MOGRT_FIELDS = {
    fields: [
      { index: 3, name: 'Text', group: 'Title Main', label: 'Title Main > Text' },
      { index: 11, name: 'Text', group: 'Description', label: 'Description > Text' }
    ]
  };

  // `focusedSequence` simulates the editor switching sequence tabs in Premiere after an analysis
  // (R-13, docs/08 §3): when set, it is the sequence the host sees as active, while the panel
  // still holds the sequenceId from the earlier getSequenceInfo. null means "no tab switch".
  var scenario = { sequence: 'sequence-2997', segments: 'segments-single', focusedSequence: null };

  function queryParam(name) {
    if (!hasWindow || !window.location || !window.location.search) { return null; }
    var re = new RegExp('(?:^|[?&])' + name + '=([^&]*)');
    var m = re.exec(window.location.search);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function applyQueryScenario() {
    var qSeq = queryParam('hostSequence');
    var qSeg = queryParam('hostSegments');
    if (qSeq && SEQUENCES[qSeq]) { scenario.sequence = qSeq; }
    if (qSeg && SEGMENTS[qSeg]) { scenario.segments = qSeg; }
  }

  function clone(value) { return JSON.parse(JSON.stringify(value)); }

  function ok(data) { return JSON.stringify({ ok: true, data: data }); }

  function fail(message) { return JSON.stringify({ ok: false, error: message }); }

  function activeSequence() {
    return SEQUENCES[scenario.focusedSequence || scenario.sequence];
  }

  function requireActiveSequence() {
    if (!activeSequence().hasActiveSequence) {
      return 'Open a sequence in Premiere first.';
    }
    return null;
  }

  // docs/08 §3 and §9 (D20): the three sequence-bound calls compare the caller's sequenceId to
  // the active sequence before doing anything else.
  function checkSequenceId(sequenceId) {
    var active = activeSequence();
    if (typeof sequenceId === 'string' && active.sequenceId === sequenceId) { return null; }
    var key;
    for (key in SEQUENCES) {
      if (SEQUENCES.hasOwnProperty(key) && typeof sequenceId === 'string' &&
          SEQUENCES[key].sequenceId === sequenceId) {
        return 'The active sequence changed since this analysis. Switch back to "' +
          SEQUENCES[key].name + '" or click Analyse again.';
      }
    }
    return 'Open a sequence in Premiere first.';
  }

  function requireSequence(sequenceId) {
    return requireActiveSequence() || checkSequenceId(sequenceId);
  }

  function checkTrackIndex(trackIndex) {
    var seq = activeSequence();
    if (typeof trackIndex !== 'number' || trackIndex < 0 || trackIndex > seq.videoTrackCount - 1) {
      return 'Track V' + (trackIndex + 1) + ' no longer exists in this sequence. Click Refresh.';
    }
    return null;
  }

  function looksLikeTheTestMogrt(path) {
    if (typeof path !== 'string') { return false; }
    var normalised = path.replace(/\\/g, '/').toLowerCase();
    return normalised.indexOf('av_quote_04.mogrt') !== -1;
  }

  var VS = {};

  VS.ping = function () {
    return ok({ pong: true, version: '1.0.0', hostApi: '1.1' });
  };

  VS.getSequenceInfo = function () {
    return ok(clone(activeSequence()));
  };

  VS.getMediaSegments = function (argJson) {
    var args = JSON.parse(argJson || '{}');
    var seqErr = requireSequence(args.sequenceId);
    if (seqErr) { return fail(seqErr); }
    return ok(clone(SEGMENTS[scenario.segments]));
  };

  VS.getMogrtFields = function (argJson) {
    if (!activeSequence().hasActiveSequence) {
      return fail(
        'Open a sequence in Premiere first — reading a template\'s fields requires an ' +
        'active sequence.'
      );
    }
    var args = JSON.parse(argJson || '{}');
    if (!looksLikeTheTestMogrt(args.path)) {
      return fail('Premiere could not insert the template. Check the .mogrt path is still valid.');
    }
    return ok(clone(MOGRT_FIELDS));
  };

  VS.insertCues = function (argJson) {
    var args = JSON.parse(argJson);
    var cues = args.cues || [];
    var i;

    var seqErr = requireSequence(args.sequenceId);
    if (seqErr) { return fail(seqErr); }

    for (i = 1; i < cues.length; i++) {
      if (Number(cues[i].atTicks) < Number(cues[i - 1].atTicks)) {
        return fail('Internal error: cues must be sorted by time. Please report this.');
      }
    }

    var trackErr = checkTrackIndex(args.trackIndex);
    if (trackErr) { return fail(trackErr); }

    var results = [];
    var insertedCount = 0;
    var failedCount = 0;
    for (i = 0; i < cues.length; i++) {
      var cue = cues[i];
      // Sentinel for manual/automated testing of the partial-failure summary (FR-7.7) — the
      // real host's equivalent trigger is a bad .mogrt path or a missing MGT component.
      if (typeof cue.id === 'string' && cue.id.indexOf('_importfail') !== -1) {
        results.push({
          id: cue.id,
          ok: false,
          error: 'Premiere could not insert the template. Check the .mogrt path is still valid.'
        });
        failedCount += 1;
      } else {
        results.push({ id: cue.id, ok: true, actualStartTicks: cue.atTicks });
        insertedCount += 1;
      }
    }
    return ok({ results: results, insertedCount: insertedCount, failedCount: failedCount });
  };

  VS.setPlayhead = function (argJson) {
    var args = JSON.parse(argJson);
    var activeErr = requireActiveSequence();
    if (activeErr) { return fail(activeErr); }
    return ok({ ticks: args.ticks });
  };

  VS.validateTrack = function (argJson) {
    var args = JSON.parse(argJson);
    var seqErr = requireSequence(args.sequenceId);
    if (seqErr) { return fail(seqErr); }
    var trackErr = checkTrackIndex(args.trackIndex);
    if (trackErr) { return fail(trackErr); }
    return ok({ conflicts: [] });
  };

  // ---- dev-only scenario switcher (not part of the frozen VS.* contract) ----

  VS.__setScenario = function (next) {
    if (next && next.sequence && SEQUENCES[next.sequence]) {
      scenario.sequence = next.sequence;
      scenario.focusedSequence = null; // a new base sequence ends any simulated tab switch
    }
    if (next && next.focusedSequence === null) { scenario.focusedSequence = null; }
    if (next && next.focusedSequence && SEQUENCES[next.focusedSequence]) {
      scenario.focusedSequence = next.focusedSequence;
    }
    if (next && next.segments && SEGMENTS[next.segments]) { scenario.segments = next.segments; }
  };

  VS.__getScenario = function () {
    return {
      sequence: scenario.sequence,
      segments: scenario.segments,
      focusedSequence: scenario.focusedSequence
    };
  };

  // ---- activation ----

  if (hasWindow) {
    applyQueryScenario();
    var hasCSInterface = typeof window.CSInterface !== 'undefined';
    var explicitStub = queryParam('stub') === '1';
    if (!hasCSInterface || explicitStub) {
      window.VS = VS;
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = VS;
  }
})();
