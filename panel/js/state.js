(function (root) {
  'use strict';

  // Panel state and persistence (docs/09 §3, FR-1.7). Ported from the pattern in
  // reference/verseflow/js/state.js: localStorage, wrapped in try/catch, field mappings
  // keyed by MOGRT path. Storage is injected so tests can pass a fake.

  var STORAGE_KEY = 'versesync.state';
  var SCHEMA_VERSION = 1;

  // Keys that are never written to storage. mediaPath is the one FR-1.7 excludes; the others are
  // live readings (sidecar health, open sequence, fields read from the template) that would be
  // stale after a restart, so they are re-read each session rather than restored.
  var TRANSIENT = ['mediaPath', 'sidecarReady', 'sequenceOpen', 'mogrtFields'];

  var DEFAULTS = {
    mediaPath: null,
    sidecarReady: false,
    sequenceOpen: false,
    mogrtPath: null,
    mogrtFields: null,
    translation: null,
    targetTrack: null,
    durationMode: 'auto',
    fixedDurationSec: null,
    leadInSec: 0.5
  };

  var MAPPING_KEYS = ['referenceIndex', 'bodyIndex'];

  function isTransient(key) {
    return TRANSIENT.indexOf(key) !== -1;
  }

  function isIndex(v) {
    return typeof v === 'number' && isFinite(v) && v >= 0 && Math.floor(v) === v;
  }

  function load(storage) {
    var empty = { settings: {}, mappings: {} };
    try {
      var raw = storage.getItem(STORAGE_KEY);
      if (!raw) { return empty; }
      var doc = JSON.parse(raw);
      if (!doc || doc.version !== SCHEMA_VERSION) { return empty; }
      return { settings: doc.settings || {}, mappings: doc.mappings || {} };
    } catch (e) {
      return empty;
    }
  }

  function create(opts) {
    var storage = opts && opts.storage;
    var loaded = load(storage);
    var values = {};
    var mappings = loaded.mappings;
    var key;

    for (key in DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
        values[key] = DEFAULTS[key];
      }
    }
    for (key in loaded.settings) {
      if (Object.prototype.hasOwnProperty.call(loaded.settings, key) && !isTransient(key) &&
          Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
        values[key] = loaded.settings[key];
      }
    }

    function persist() {
      var settings = {};
      var k;
      for (k in values) {
        if (Object.prototype.hasOwnProperty.call(values, k) && !isTransient(k)) {
          settings[k] = values[k];
        }
      }
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify({
          version: SCHEMA_VERSION,
          settings: settings,
          mappings: mappings
        }));
      } catch (e) {
        // Storage can be full or blocked; the in-memory state still works for this session.
      }
    }

    function fieldMappingFor(mogrtPath) {
      var m = mappings[mogrtPath];
      if (!m || !isIndex(m.referenceIndex) || !isIndex(m.bodyIndex)) { return null; }
      return { referenceIndex: m.referenceIndex, bodyIndex: m.bodyIndex };
    }

    function setFieldMapping(mogrtPath, mapping) {
      // Indices only, never display names: names can repeat across groups (R-8).
      mappings[mogrtPath] = {
        referenceIndex: mapping.referenceIndex,
        bodyIndex: mapping.bodyIndex
      };
      persist();
    }

    function get() {
      var out = {};
      var k;
      for (k in values) {
        if (Object.prototype.hasOwnProperty.call(values, k)) { out[k] = values[k]; }
      }
      var m = values.mogrtPath === null ? null : fieldMappingFor(values.mogrtPath);
      out.referenceIndex = m ? m.referenceIndex : null;
      out.bodyIndex = m ? m.bodyIndex : null;
      return out;
    }

    function set(patch) {
      var mapping = {};
      var hasMapping = false;
      var k;
      for (k in patch) {
        if (!Object.prototype.hasOwnProperty.call(patch, k)) { continue; }
        if (MAPPING_KEYS.indexOf(k) !== -1) {
          mapping[k] = patch[k];
          hasMapping = true;
        } else {
          values[k] = patch[k];
        }
      }
      if (hasMapping && values.mogrtPath !== null) {
        var cur = get();
        setFieldMapping(values.mogrtPath, {
          referenceIndex: 'referenceIndex' in mapping ? mapping.referenceIndex : cur.referenceIndex,
          bodyIndex: 'bodyIndex' in mapping ? mapping.bodyIndex : cur.bodyIndex
        });
        return;
      }
      persist();
    }

    return {
      get: get,
      set: set,
      fieldMappingFor: fieldMappingFor,
      setFieldMapping: setFieldMapping
    };
  }

  // VerseFlow's smart-default patterns (docs/09 §3). Matched against the field's group name.
  var REFERENCE_RE = /descr|caption|sub|credit|author/i;
  var BODY_RE = /title|main|quote|body/i;

  function smartDefaults(fields) {
    var referenceIndex = null;
    var bodyIndex = null;
    var i;
    for (i = 0; i < fields.length; i++) {
      var f = fields[i];
      var group = String(f.group || '');
      if (referenceIndex === null && REFERENCE_RE.test(group)) {
        referenceIndex = f.index;
      } else if (bodyIndex === null && BODY_RE.test(group)) {
        bodyIndex = f.index;
      }
    }
    return { referenceIndex: referenceIndex, bodyIndex: bodyIndex };
  }

  function analyseBlockers(s) {
    var out = [];
    if (!s.sidecarReady) { out.push("Transcription service isn't ready."); }
    if (!s.sequenceOpen) { out.push('Open a sequence in Premiere first.'); }
    if (!s.mediaPath) { out.push('Select a media file.'); }
    var hasTemplate = !!s.mogrtPath;
    if (!hasTemplate) { out.push('Select a template.'); }
    if (hasTemplate && s.mogrtFields && s.mogrtFields.length === 0) {
      out.push('This template has no editable text fields.');
    }
    var hasFields = !!(s.mogrtFields && s.mogrtFields.length > 0);
    var refSet = isIndex(s.referenceIndex);
    var bodySet = isIndex(s.bodyIndex);
    if (hasTemplate && hasFields && !(refSet && bodySet)) { out.push('Map both template fields.'); }
    if (refSet && bodySet && s.referenceIndex === s.bodyIndex) {
      out.push('Reference and scripture must use different fields.');
    }
    if (!s.translation) { out.push('Select a translation.'); }
    if (s.targetTrack === null || s.targetTrack === undefined) { out.push('Select a target track.'); }
    return out;
  }

  var State = {
    create: create,
    smartDefaults: smartDefaults,
    analyseBlockers: analyseBlockers
  };

  if (typeof module !== 'undefined' && module.exports) { module.exports = State; }
  // Always set the global too (see bridge.js): CEP's mixed-context leaks `module` into the
  // browser window, so this can't be an else-branch without breaking Premiere.
  root.VSState = State;
})(this);
