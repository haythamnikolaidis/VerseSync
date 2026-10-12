/**
 * state.js — in-memory panel state, localStorage persistence, and the pure rules the setup UI
 * is built on (smart field defaults, mapping validation, the Analyse gate, progress maths).
 *
 * Ported from VerseFlow's state.js and extended. The persistence pattern is VerseFlow's:
 * a JSON blob in localStorage, every read and write wrapped in try/catch so a missing or
 * blocked store degrades to "nothing remembered" instead of an exception. Field mappings are
 * keyed by MOGRT path in their own blob so an editor with two templates never remaps on a
 * switch (docs/09 §3), and store field INDICES, never display names (two fields can both be
 * called "Text", risk R-8).
 *
 * Everything here is DOM-free so it runs under node:test unchanged. Spec: docs/09-ui-spec.md
 * §2–4, FR-1.7.
 */
(function () {
  'use strict';

  var SETTINGS_KEY = 'versesync_settings_v1';
  var MAPPING_KEY = 'versesync_mapping_v1';

  // Ranges and defaults from docs/09 §3 and docs/05 (duration_mode / fixed_duration_s).
  var LEAD_IN_DEFAULT_S = 0.5;
  var LEAD_IN_MIN_S = 0;
  var LEAD_IN_MAX_S = 3;
  var FIXED_DURATION_DEFAULT_S = 8;

  // Elapsed/ETA are unreliable in the first moments of a job, so the readout waits (docs/09 §4).
  var ETA_MIN_PROGRESS = 0.1;

  // docs/09 §3, copied from VerseFlow's smart defaults. Matched against the field's group.
  var REFERENCE_GROUP_RE = /descr|caption|sub|credit|author/i;
  var BODY_GROUP_RE = /title|main|quote|body/i;

  // Settings that survive a restart. The media file is deliberately absent (docs/09 §3).
  var PERSISTED = ['mogrtPath', 'translationId', 'trackIndex', 'durationMode', 'fixedDurationS',
                   'leadInS'];

  function defaults() {
    return {
      mediaPath: null,
      mogrtPath: null,
      mogrtFields: null,         // [{index, name, group, label}] once read
      mogrtBusy: false,
      mogrtError: null,
      mapping: { referenceIndex: null, bodyIndex: null },
      translations: null,        // null = not loaded yet
      translationId: null,
      videoTrackCount: 0,
      hasSequence: false,
      trackIndex: null,          // 0-based host track index; null = topmost
      durationMode: 'auto',
      fixedDurationS: FIXED_DURATION_DEFAULT_S,
      fixedText: String(FIXED_DURATION_DEFAULT_S),
      leadInS: LEAD_IN_DEFAULT_S,
      leadInText: String(LEAD_IN_DEFAULT_S),
      jobActive: false,
      cueDocument: null
    };
  }

  // ------------------------------------------------------------------ parsing

  /**
   * parseSeconds(text, min, max) -> {ok, value}. max may be null (no upper bound).
   * Rejects blanks, junk and out-of-range values.
   */
  function parseSeconds(text, min, max) {
    var s = String(text === undefined || text === null ? '' : text).replace(/^\s+|\s+$/g, '');
    if (s === '' || !/^[0-9]*\.?[0-9]+$|^[0-9]+\.$/.test(s)) { return { ok: false, value: null }; }
    var n = parseFloat(s);
    if (isNaN(n) || n < min || (max !== null && n > max)) { return { ok: false, value: null }; }
    return { ok: true, value: n };
  }

  function parseLeadIn(text) { return parseSeconds(text, LEAD_IN_MIN_S, LEAD_IN_MAX_S); }

  // A fixed duration of zero would insert invisible clips.
  function parseFixedDuration(text) {
    var r = parseSeconds(text, 0, null);
    return r.ok && r.value > 0 ? r : { ok: false, value: null };
  }

  // ------------------------------------------------------------------ mapping rules

  /**
   * smartDefaults(fields) -> {referenceIndex, bodyIndex}
   * Reference <- first field whose group matches REFERENCE_GROUP_RE; body <- first matching
   * BODY_GROUP_RE that is not the reference. A missing match falls back to the second / first
   * field (VerseFlow's behaviour), never the same field twice.
   */
  function smartDefaults(fields) {
    var list = fields || [];
    var ref = null;
    var body = null;
    var i;
    for (i = 0; i < list.length && ref === null; i++) {
      if (REFERENCE_GROUP_RE.test(list[i].group || '')) { ref = list[i].index; }
    }
    for (i = 0; i < list.length && body === null; i++) {
      if (list[i].index !== ref && BODY_GROUP_RE.test(list[i].group || '')) { body = list[i].index; }
    }
    if (ref === null && list.length >= 2) {
      ref = list[1].index === body ? list[0].index : list[1].index;
    }
    if (body === null && list.length >= 1) {
      for (i = 0; i < list.length && body === null; i++) {
        if (list[i].index !== ref) { body = list[i].index; }
      }
    }
    return { referenceIndex: ref, bodyIndex: body };
  }

  function hasField(fields, index) {
    for (var i = 0; i < (fields || []).length; i++) {
      if (fields[i].index === index) { return true; }
    }
    return false;
  }

  /** validateMapping(mapping) -> null or an editor-facing message. */
  function validateMapping(mapping) {
    if (mapping.referenceIndex !== null && mapping.bodyIndex !== null &&
        mapping.referenceIndex === mapping.bodyIndex) {
      return 'Reference and scripture text must use different fields.';
    }
    return null;
  }

  /** fieldLabel(field) -> "Group > Name" (the host supplies label; this is the fallback). */
  function fieldLabel(f) {
    return f.label || (f.group ? f.group + ' > ' + f.name : f.name);
  }

  // ------------------------------------------------------------------ tracks

  /** trackOptions(count) -> [{value, label}] listed V-high to V-low (value = 0-based index). */
  function trackOptions(count) {
    var out = [];
    for (var i = count - 1; i >= 0; i--) { out.push({ value: i, label: 'V' + (i + 1) }); }
    return out;
  }

  /** resolveTrack(saved, count) -> a valid 0-based index, defaulting to the topmost track. */
  function resolveTrack(saved, count) {
    if (count < 1) { return null; }
    if (typeof saved === 'number' && saved >= 0 && saved <= count - 1) { return saved; }
    return count - 1;
  }

  // ------------------------------------------------------------------ Analyse gate

  /**
   * analyseGate(s, strip) -> {enabled, reason}
   * s is the state; strip is VSSidecar.computeStrip(status, hasSequence). The reason is
   * always present when disabled (docs/09 §3: never just a greyed button) and is the FIRST
   * unmet condition, in the order an editor would fix them.
   */
  function analyseGate(s, strip) {
    function no(reason) { return { enabled: false, reason: reason }; }

    if (s.jobActive) { return no('An analysis is already running.'); }
    if (strip.kind === 'starting') { return no('Waiting for the transcription service to start.'); }
    if (strip.kind === 'unreachable') {
      return no('The transcription service is unavailable — see Details above.');
    }
    if (strip.kind === 'version_mismatch') {
      return no('The transcription service needs restarting — see Details above.');
    }
    if (!strip.analyseEnabled) { return no('Open a sequence in Premiere.'); }
    if (!s.mediaPath) { return no('Select a media file.'); }
    if (!s.mogrtPath) { return no('Select a template (.mogrt).'); }
    if (s.mogrtBusy) { return no('Reading template…'); }
    if (s.mogrtError) { return no('The template could not be read — select it again.'); }
    if (!s.mogrtFields || s.mogrtFields.length === 0) {
      return no('The template has no editable text fields.');
    }
    if (s.mapping.referenceIndex === null) { return no('Choose the reference field.'); }
    if (s.mapping.bodyIndex === null) { return no('Choose the scripture text field.'); }
    var mapErr = validateMapping(s.mapping);
    if (mapErr) { return no(mapErr); }
    if (s.translations === null) { return no('Loading translations…'); }
    if (!s.translationId) { return no('Choose a translation.'); }
    if (s.trackIndex === null || s.videoTrackCount < 1) { return no('Choose a target track.'); }
    if (!parseLeadIn(s.leadInText).ok) {
      return no('Lead-in must be a number from ' + LEAD_IN_MIN_S + ' to ' + LEAD_IN_MAX_S +
                ' seconds.');
    }
    if (s.durationMode === 'fixed' && !parseFixedDuration(s.fixedText).ok) {
      return no('Enter a fixed duration greater than 0 seconds.');
    }
    return { enabled: true, reason: '' };
  }

  // ------------------------------------------------------------------ job request

  /** jobRequest(s) -> the POST /jobs body (docs/07). Caller has already passed the gate. */
  function jobRequest(s) {
    var timing = {
      lead_in_s: s.leadInS,
      duration_mode: s.durationMode
    };
    if (s.durationMode === 'fixed') { timing.fixed_duration_s = s.fixedDurationS; }
    return {
      media_path: s.mediaPath,
      translation_id: s.translationId,
      options: { use_cache: true, timing: timing }
    };
  }

  // ------------------------------------------------------------------ progress view

  var PHASE_LABELS = {
    hashing: 'Reading media…',
    transcribing: 'Transcribing…',
    detecting: 'Finding scripture references…',
    resolving: 'Fetching verse text…',
    timing: 'Working out timing…'
  };

  /** formatClock(seconds) -> "m:ss" */
  function formatClock(sec) {
    var t = Math.max(0, Math.round(sec));
    var m = Math.floor(t / 60);
    var r = t % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  /** formatEta(seconds) -> "~1m04s" / "~42s" */
  function formatEta(sec) {
    var t = Math.max(0, Math.round(sec));
    if (t < 60) { return '~' + t + 's'; }
    var r = t % 60;
    return '~' + Math.floor(t / 60) + 'm' + (r < 10 ? '0' : '') + r + 's';
  }

  /**
   * progressView(snap, elapsedS, cacheHit) -> {percent, label, time}
   * snap: {phase, progress, eta_s}. The time readout appears only after 10% (docs/09 §4);
   * the sidecar's own ETA wins, falling back to linear extrapolation from elapsed time.
   */
  function progressView(snap, elapsedS, cacheHit) {
    var p = Math.min(1, Math.max(0, Number(snap && snap.progress) || 0));
    var label = (snap && PHASE_LABELS[snap.phase]) || 'Working…';
    if (cacheHit) { label = 'Using cached transcript · ' + label; }
    var time = '';
    if (p >= ETA_MIN_PROGRESS && p < 1) {
      var eta = snap && typeof snap.eta_s === 'number' ? snap.eta_s : (elapsedS / p) * (1 - p);
      time = 'elapsed ' + formatClock(elapsedS) + ' · ' + formatEta(eta) + ' left';
    }
    return { percent: Math.round(p * 100), label: label, time: time };
  }

  // ------------------------------------------------------------------ persistence + store

  function defaultStorage() {
    try { return window.localStorage; } catch (e) { return null; }
  }

  function readJson(storage, key) {
    try {
      var raw = storage && storage.getItem(key);
      if (!raw) { return null; }
      var v = JSON.parse(raw);
      return v && typeof v === 'object' ? v : null;
    } catch (e) { return null; }
  }

  function writeJson(storage, key, value) {
    try { storage.setItem(key, JSON.stringify(value)); } catch (e) { /* best effort */ }
  }

  /**
   * create(storage) -> store. storage is localStorage-shaped ({getItem, setItem}); omit it in
   * the panel to use window.localStorage. Saved settings are restored immediately.
   */
  function create(storage) {
    var store = storage === undefined ? defaultStorage() : storage;
    var state = defaults();

    function restore() {
      var saved = readJson(store, SETTINGS_KEY);
      if (!saved) { return; }
      if (typeof saved.mogrtPath === 'string') { state.mogrtPath = saved.mogrtPath; }
      if (typeof saved.translationId === 'string') { state.translationId = saved.translationId; }
      if (typeof saved.trackIndex === 'number') { state.trackIndex = saved.trackIndex; }
      if (saved.durationMode === 'auto' || saved.durationMode === 'fixed') {
        state.durationMode = saved.durationMode;
      }
      if (parseFixedDuration(saved.fixedDurationS).ok) {
        state.fixedDurationS = Number(saved.fixedDurationS);
        state.fixedText = String(state.fixedDurationS);
      }
      if (typeof saved.leadInS === 'number' && parseLeadIn(saved.leadInS).ok) {
        state.leadInS = saved.leadInS;
        state.leadInText = String(saved.leadInS);
      }
    }

    function persist() {
      var out = {};
      for (var i = 0; i < PERSISTED.length; i++) { out[PERSISTED[i]] = state[PERSISTED[i]]; }
      writeJson(store, SETTINGS_KEY, out);
    }

    function loadMapping(mogrtPath) {
      var all = readJson(store, MAPPING_KEY);
      var m = all && mogrtPath ? all[mogrtPath] : null;
      if (!m) { return null; }
      var ref = typeof m.referenceIndex === 'number' ? m.referenceIndex : null;
      var body = typeof m.bodyIndex === 'number' ? m.bodyIndex : null;
      return { referenceIndex: ref, bodyIndex: body };
    }

    function saveMapping(mogrtPath, mapping) {
      var all = readJson(store, MAPPING_KEY) || {};
      all[mogrtPath] = { referenceIndex: mapping.referenceIndex, bodyIndex: mapping.bodyIndex };
      writeJson(store, MAPPING_KEY, all);
    }

    restore();

    return {
      /** Shallow copy, safe to read. */
      get: function () {
        var copy = {};
        for (var k in state) { if (state.hasOwnProperty(k)) { copy[k] = state[k]; } }
        copy.mapping = { referenceIndex: state.mapping.referenceIndex, bodyIndex: state.mapping.bodyIndex };
        return copy;
      },
      /** Update top-level properties; persisted ones are written through. */
      set: function (patch) {
        var touched = false;
        for (var k in patch) {
          if (!patch.hasOwnProperty(k)) { continue; }
          state[k] = patch[k];
          if (PERSISTED.indexOf(k) !== -1) { touched = true; }
        }
        if (touched) { persist(); }
      },
      /**
       * Set the mapping and persist it under the current MOGRT path. A mapping that uses one
       * field twice is invalid and is neither remembered nor allowed to overwrite a good one.
       */
      setMapping: function (referenceIndex, bodyIndex) {
        state.mapping = { referenceIndex: referenceIndex, bodyIndex: bodyIndex };
        if (state.mogrtPath !== null &&
            validateMapping(state.mapping) === null) {
          saveMapping(state.mogrtPath, state.mapping);
        }
      },
      /** Lead-in text from the input. Only a valid value becomes the remembered setting. */
      setLeadInText: function (text) {
        state.leadInText = text;
        var r = parseLeadIn(text);
        if (r.ok) { state.leadInS = r.value; persist(); }
      },
      setFixedText: function (text) {
        state.fixedText = text;
        var r = parseFixedDuration(text);
        if (r.ok) { state.fixedDurationS = r.value; persist(); }
      },
      loadMapping: loadMapping,
      saveMapping: saveMapping
    };
  }

  var VSState = {
    SETTINGS_KEY: SETTINGS_KEY,
    MAPPING_KEY: MAPPING_KEY,
    LEAD_IN_DEFAULT_S: LEAD_IN_DEFAULT_S,
    LEAD_IN_MIN_S: LEAD_IN_MIN_S,
    LEAD_IN_MAX_S: LEAD_IN_MAX_S,
    FIXED_DURATION_DEFAULT_S: FIXED_DURATION_DEFAULT_S,
    create: create,
    parseLeadIn: parseLeadIn,
    parseFixedDuration: parseFixedDuration,
    smartDefaults: smartDefaults,
    hasField: hasField,
    validateMapping: validateMapping,
    fieldLabel: fieldLabel,
    trackOptions: trackOptions,
    resolveTrack: resolveTrack,
    analyseGate: analyseGate,
    jobRequest: jobRequest,
    progressView: progressView,
    formatClock: formatClock,
    formatEta: formatEta
  };

  if (typeof window !== 'undefined') { window.VSState = VSState; }
  if (typeof module !== 'undefined' && module.exports) { module.exports = VSState; }
})();
