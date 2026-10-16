(function (root) {
  'use strict';

  // The Cue Document model (docs/07 §5). It holds the schema-shaped document and never stores
  // ticks: placements come from VSTimemap and are recomputed by the caller after every edit.

  var SUPPORTED_MAJOR = '1';
  var KNOWN_MINOR = 0;

  // Flags the panel adds after mapping (docs/07 §5.1). A cue that gets one of the first two for
  // the first time is switched off once, because it cannot be placed as detected.
  var DISABLING_PANEL_FLAGS = ['cut_from_edit', 'speed_change_unsupported'];

  var ORIGINS = ['detected', 'manual', 'edited'];
  var CLASSIFICATIONS = ['read', 'paraphrase'];

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function isNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function isNonNegative(v) {
    return isNumber(v) && v >= 0;
  }

  // Mirrors the cue rules in schemas/cue-document.schema.json. Returns a list of problems.
  function validateCue(cue) {
    var errors = [];
    function need(ok, message) { if (!ok) { errors.push(message); } }
    var ref = cue.reference;

    need(typeof cue.id === 'string' && cue.id.length > 0, 'id must be a non-empty string');
    need(typeof cue.enabled === 'boolean', 'enabled must be a boolean');
    need(ORIGINS.indexOf(cue.origin) !== -1, 'origin must be detected, manual or edited');
    need(ref && typeof ref === 'object' && typeof ref.book === 'string' &&
      typeof ref.osis === 'string' && ref.chapter % 1 === 0 && ref.chapter >= 1,
      'reference must have book, osis and chapter');
    need(typeof cue.reference_display === 'string' && cue.reference_display.length > 0,
      'reference_display must be a non-empty string');
    need(typeof cue.body === 'string', 'body must be a string');
    need(isNumber(cue.body_word_count) && cue.body_word_count >= 0 &&
      cue.body_word_count % 1 === 0, 'body_word_count must be a non-negative integer');
    need(typeof cue.body_truncated === 'boolean', 'body_truncated must be a boolean');
    need(isNonNegative(cue.source_anchor_s), 'source_anchor_s must be >= 0');
    need(isNonNegative(cue.source_duration_s), 'source_duration_s must be >= 0');
    need(isNonNegative(cue.mention_start_s), 'mention_start_s must be >= 0');
    need(isNonNegative(cue.mention_end_s), 'mention_end_s must be >= 0');
    need(CLASSIFICATIONS.indexOf(cue.classification) !== -1,
      'classification must be read or paraphrase');
    need(isNumber(cue.confidence) && cue.confidence >= 0 && cue.confidence <= 1,
      'confidence must be between 0 and 1');
    need(typeof cue.snippet === 'string', 'snippet must be a string');
    need(Array.isArray(cue.flags), 'flags must be an array');
    need(Array.isArray(cue.alternatives), 'alternatives must be an array');
    return errors;
  }

  function parseVersion(text) {
    var m = /^(\d+)\.(\d+)$/.exec(String(text));
    return m ? { major: m[1], minor: parseInt(m[2], 10) } : null;
  }

  function createModel(doc) {
    var data = clone(doc);
    var cueList = data.cues;
    var disabledByPanel = {}; // cue id -> true once a panel flag has switched it off

    function indexOf(id) {
      for (var i = 0; i < cueList.length; i++) {
        if (cueList[i].id === id) { return i; }
      }
      return -1;
    }

    function find(id) {
      var i = indexOf(id);
      return i === -1 ? null : cueList[i];
    }

    function mustFind(id) {
      var cue = find(id);
      if (!cue) { throw new Error('No cue with id ' + id); }
      return cue;
    }

    function nextManualId() {
      var max = 0;
      for (var i = 0; i < cueList.length; i++) {
        var m = /^cue_m(\d+)$/.exec(cueList[i].id);
        if (m) { max = Math.max(max, parseInt(m[1], 10)); }
      }
      var n = String(max + 1);
      while (n.length < 3) { n = '0' + n; }
      return 'cue_m' + n;
    }

    return {
      cues: function () { return cueList; },

      get: function (id) { return find(id); },

      setEnabled: function (id, enabled) {
        mustFind(id).enabled = !!enabled;
      },

      enabledCount: function () {
        var n = 0;
        for (var i = 0; i < cueList.length; i++) {
          if (cueList[i].enabled) { n++; }
        }
        return n;
      },

      // placements is { [id]: { panelFlags: [...] } } as VSTimemap.mapCueDocument returns.
      applyPanelFlags: function (placements) {
        for (var i = 0; i < cueList.length; i++) {
          var cue = cueList[i];
          var placement = placements && placements[cue.id];
          if (!placement || disabledByPanel[cue.id]) { continue; }
          var flags = placement.panelFlags || [];
          for (var j = 0; j < DISABLING_PANEL_FLAGS.length; j++) {
            if (flags.indexOf(DISABLING_PANEL_FLAGS[j]) !== -1) {
              disabledByPanel[cue.id] = true;
              cue.enabled = false;
              break;
            }
          }
        }
      },

      // Throws, leaving the cue untouched, if the patched cue would be invalid.
      edit: function (id, patch) {
        var cue = mustFind(id);
        var next = clone(cue);
        var keys = Object.keys(patch);
        for (var i = 0; i < keys.length; i++) {
          if (keys[i] === 'id') { throw new Error('A cue id cannot be edited'); }
          next[keys[i]] = clone(patch[keys[i]]);
        }
        if (next.origin !== 'manual') { next.origin = 'edited'; }
        var errors = validateCue(next);
        if (errors.length > 0) { throw new Error('Invalid cue edit: ' + errors.join('; ')); }
        cueList[indexOf(id)] = next;
      },

      addManual: function (fields) {
        var cue = {
          id: nextManualId(),
          enabled: true,
          origin: 'manual',
          reference: clone(fields.reference),
          reference_display: fields.reference_display,
          body: fields.body,
          body_word_count: fields.body_word_count,
          body_truncated: false,
          source_anchor_s: fields.source_anchor_s,
          source_duration_s: fields.source_duration_s,
          mention_start_s: fields.source_anchor_s,
          mention_end_s: fields.source_anchor_s,
          classification: 'paraphrase',
          confidence: 1.0,
          snippet: '',
          flags: [],
          alternatives: []
        };
        var errors = validateCue(cue);
        if (errors.length > 0) { throw new Error('Invalid manual cue: ' + errors.join('; ')); }
        cueList.push(cue);
        return cue.id;
      },

      remove: function (id) {
        var i = indexOf(id);
        if (i === -1) { throw new Error('No cue with id ' + id); }
        cueList.splice(i, 1);
        delete disabledByPanel[id];
      },

      // The document as stored: schema-shaped, with no panel-only state (that lives in closures).
      toJSON: function () { return clone(data); }
    };
  }

  // docs/07 §5.2: accept a matching major, warn on a newer minor, refuse any other major.
  function load(jsonText) {
    var doc;
    try {
      doc = JSON.parse(jsonText);
    } catch (e) {
      return { ok: false, error: 'This file is not a valid cue document: ' + e.message };
    }
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.cues)) {
      return { ok: false, error: 'This file is not a valid cue document.' };
    }
    var version = parseVersion(doc.schema_version);
    if (!version) {
      return { ok: false, error: 'This file is not a valid cue document.' };
    }
    if (version.major !== SUPPORTED_MAJOR) {
      return {
        ok: false,
        error: 'This cue document was made by a newer VerseSync (version ' +
          doc.schema_version + ') and can\'t be opened.'
      };
    }
    var result = { ok: true, model: createModel(doc) };
    if (version.minor > KNOWN_MINOR) {
      result.warning = 'This cue document is version ' + doc.schema_version +
        ', newer than this VerseSync understands. Some details may be ignored.';
    }
    return result;
  }

  // The saved file: the schema-shaped document as pretty JSON with a trailing newline.
  function serialize(model) {
    return JSON.stringify(model.toJSON(), null, 2) + '\n';
  }

  // VerseFlow block format (docs/06 §2): reference line, body on one line, blank line between
  // blocks. Only enabled cues with a body are written, in source anchor order (stable, so cues
  // with equal anchors keep document order).
  function exportVerseFlowTxt(model) {
    var picked = [];
    var all = model.cues();
    for (var i = 0; i < all.length; i++) {
      var cue = all[i];
      if (cue.enabled && cue.body.replace(/\s+/g, ' ').trim() !== '') {
        picked.push({ cue: cue, index: i });
      }
    }
    picked.sort(function (a, b) {
      return (a.cue.source_anchor_s - b.cue.source_anchor_s) || (a.index - b.index);
    });
    var blocks = [];
    for (var j = 0; j < picked.length; j++) {
      blocks.push(picked[j].cue.reference_display.trim() + '\n' +
        picked[j].cue.body.replace(/\s+/g, ' ').trim() + '\n');
    }
    return blocks.join('\n');
  }

  var Cues = {
    load: load,
    validateCue: validateCue,
    serialize: serialize,
    exportVerseFlowTxt: exportVerseFlowTxt
  };

  if (typeof module !== 'undefined' && module.exports) { module.exports = Cues; }
  else { root.VSCues = Cues; }
})(this);
