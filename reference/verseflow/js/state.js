/**
 * state.js — in-memory application state + localStorage persistence for mapping.
 */
(function () {
  'use strict';

  var LS_KEY = 'verseflow_mapping_v1';

  var state = {
    mogrtPath: null,
    mogrtFields: null,       // [{index, name, group, label}]
    mapping: {
      referenceIndex: null,  // field index (number)
      bodyIndex: null
    },
    scripturePath: null,
    scriptures: [],
    durationOverrideSec: null,
    targetVideoTrackIndex: 0,
    busy: false
  };

  /** Load persisted mapping for a given MOGRT path. */
  function loadMapping(mogrtPath) {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      var store = JSON.parse(raw);
      return store[mogrtPath] || null;
    } catch (e) {
      return null;
    }
  }

  /** Persist current mapping keyed by MOGRT path. */
  function saveMapping(mogrtPath, mapping) {
    try {
      var raw = localStorage.getItem(LS_KEY);
      var store = raw ? JSON.parse(raw) : {};
      store[mogrtPath] = mapping;
      localStorage.setItem(LS_KEY, JSON.stringify(store));
    } catch (e) {}
  }

  /** Get a shallow copy of current state (safe for reads). */
  function get() {
    return Object.assign({}, state, {
      mapping: Object.assign({}, state.mapping)
    });
  }

  /** Update top-level state properties. */
  function set(patch) {
    Object.assign(state, patch);
  }

  /** Update mapping only, and auto-persist if mogrtPath is set. */
  function setMapping(referenceIndex, bodyIndex) {
    state.mapping.referenceIndex = referenceIndex;
    state.mapping.bodyIndex = bodyIndex;
    if (state.mogrtPath !== null) {
      saveMapping(state.mogrtPath, { referenceIndex: referenceIndex, bodyIndex: bodyIndex });
    }
  }

  window.VFState = {
    get: get,
    set: set,
    setMapping: setMapping,
    loadMapping: loadMapping,
    saveMapping: saveMapping
  };
})();
