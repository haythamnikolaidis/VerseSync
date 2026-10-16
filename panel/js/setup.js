(function (root) {
  'use strict';

  // Setup view, part 1 (docs/09 §3): media file, template, and the Reference / Scripture field
  // mapping. The markup lives in index.html under #setup; this module binds to it. State, the
  // host bridge and the cep.fs dialogs are all injected so tests can pass fakes.

  // Audio and video containers the transcription service can read. cep.fs filters by bare
  // extension, without the dot.
  var State = typeof require !== 'undefined' ? require('./state.js') : root.VSState;

  var MEDIA_EXTENSIONS = [
    'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg',
    'mp4', 'mov', 'mkv', 'avi', 'm4v', 'webm', 'mxf'
  ];

  var EMPTY_FIELDS_WARNING =
    'No editable text fields were found in this template. Templates must be authored in ' +
    'After Effects with text layers exposed as Essential Graphics properties.';

  var LEAD_IN_DEFAULT = 0.5;
  var LEAD_IN_MIN = 0;
  var LEAD_IN_MAX = 3;
  // Fixed-duration default from docs/05 §3 (fixed_duration_s: 8.0); used when the input is
  // empty or not a positive number so a Fixed request always carries a usable value.
  var FIXED_DURATION_DEFAULT = 8;

  function clampLeadIn(v) {
    var n = parseFloat(v);
    if (!isFinite(n)) { return LEAD_IN_DEFAULT; }
    return Math.min(LEAD_IN_MAX, Math.max(LEAD_IN_MIN, n));
  }

  function positiveOr(v, fallback) {
    var n = parseFloat(v);
    return isFinite(n) && n > 0 ? n : fallback;
  }

  function basename(p) {
    var parts = String(p).split(/[\\/]/);
    return parts[parts.length - 1] || String(p);
  }

  function fieldLabel(f) {
    if (f.label) { return f.label; }
    return f.group ? f.group + ' > ' + f.name : String(f.name);
  }

  // cep.fs.showOpenDialog(allowMultiple, chooseDirectory, title, initialPath, fileTypes)
  // returns { err: 0, data: [paths] }; a cancelled dialog gives an empty data array.
  function pickFile(fs, title, extensions) {
    var res = fs.showOpenDialog(false, false, title, null, extensions);
    if (!res || res.err !== 0 || !res.data || res.data.length === 0) { return null; }
    return res.data[0];
  }

  function create(opts) {
    var rootEl = opts.root;
    var state = opts.state;
    var bridge = opts.bridge;
    var fs = opts.fs;

    var mediaBtn = rootEl.querySelector('#setup-media-btn');
    var mediaName = rootEl.querySelector('#setup-media-name');
    var templateBtn = rootEl.querySelector('#setup-template-btn');
    var templateName = rootEl.querySelector('#setup-template-name');
    var message = rootEl.querySelector('#setup-template-msg');
    var refSelect = rootEl.querySelector('#setup-reference');
    var bodySelect = rootEl.querySelector('#setup-body');

    var client = opts.client || null;
    var onAnalyse = opts.onAnalyse || function () {};
    var translationSelect = rootEl.querySelector('#setup-translation');
    var attribution = rootEl.querySelector('#setup-attribution');
    var trackSelect = rootEl.querySelector('#setup-track');
    var trackRefresh = rootEl.querySelector('#setup-track-refresh');
    var durationAuto = rootEl.querySelector('#setup-duration-auto');
    var durationFixed = rootEl.querySelector('#setup-duration-fixed');
    var durationSec = rootEl.querySelector('#setup-duration-sec');
    var leadIn = rootEl.querySelector('#setup-leadin');
    var analyseBtn = rootEl.querySelector('#setup-analyse');
    var analyseReason = rootEl.querySelector('#setup-analyse-reason');

    var readToken = 0;
    var translations = [];

    function showMessage(text, kind) {
      message.textContent = text;
      message.className = kind;
      message.hidden = false;
    }

    function clearMessage() {
      message.textContent = '';
      message.hidden = true;
    }

    function setPath(nameEl, p, emptyText) {
      if (p) {
        nameEl.textContent = basename(p);
        nameEl.title = p;
      } else {
        nameEl.textContent = emptyText;
        nameEl.title = '';
      }
    }

    function fillSelect(select, fields, selected) {
      while (select.firstChild) { select.removeChild(select.firstChild); }
      var doc = select.ownerDocument;
      var placeholder = doc.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Select a field…';
      select.appendChild(placeholder);
      var i;
      for (i = 0; i < fields.length; i++) {
        var o = doc.createElement('option');
        o.value = String(fields[i].index);
        o.textContent = fieldLabel(fields[i]);
        select.appendChild(o);
      }
      select.value = selected === null || selected === undefined ? '' : String(selected);
      select.disabled = fields.length === 0;
    }

    function selectedIndex(select) {
      return select.value === '' ? null : parseInt(select.value, 10);
    }

    function renderFields(path, fields) {
      var mapping = fields.length > 0
        ? (state.fieldMappingFor(path) || State.smartDefaults(fields))
        : { referenceIndex: null, bodyIndex: null };
      fillSelect(refSelect, fields, mapping.referenceIndex);
      fillSelect(bodySelect, fields, mapping.bodyIndex);
      if (fields.length > 0) {
        persistMapping();
      }
    }

    function persistMapping() {
      state.set({
        referenceIndex: selectedIndex(refSelect),
        bodyIndex: selectedIndex(bodySelect)
      });
    }

    function setBusy(busy) {
      templateBtn.disabled = busy;
      refSelect.disabled = busy || refSelect.options.length <= 1;
      bodySelect.disabled = busy || bodySelect.options.length <= 1;
    }

    // Reads the template's fields and applies them. Resolves once the view is updated.
    function loadTemplate(path) {
      var token = ++readToken;
      setBusy(true);
      showMessage('Reading template…', 'vf-count');
      return bridge.call('getMogrtFields', { path: path }).then(function (res) {
        if (token !== readToken) { return; }
        setBusy(false);
        if (!res || !res.ok) {
          showMessage((res && res.error) || 'Could not read the template.', 'vf-inline-error');
          updateAnalyse();
          return;
        }
        var fields = (res.data && res.data.fields) || [];
        state.set({ mogrtPath: path, mogrtFields: fields });
        setPath(templateName, path, 'No template selected');
        renderFields(path, fields);
        if (fields.length === 0) {
          showMessage(EMPTY_FIELDS_WARNING, 'vf-warning');
        } else {
          clearMessage();
        }
        updateAnalyse();
      }).then(null, function () {
        if (token !== readToken) { return; }
        setBusy(false);
        showMessage('Could not read the template.', 'vf-inline-error');
        updateAnalyse();
      });
    }

    // Analyse is enabled exactly when State.analyseBlockers is empty; otherwise the first
    // blocker is shown beside it so a disabled button always says why.
    function updateAnalyse() {
      var blockers = State.analyseBlockers(state.get());
      analyseBtn.disabled = blockers.length > 0;
      analyseReason.textContent = blockers.length > 0 ? blockers[0] : '';
    }

    function onPickMedia() {
      var p = pickFile(fs, 'Select audio or video file', MEDIA_EXTENSIONS);
      if (!p) { return; }
      state.set({ mediaPath: p });
      setPath(mediaName, p, 'No file selected');
      updateAnalyse();
    }

    function option(doc, value, text) {
      var o = doc.createElement('option');
      o.value = value;
      o.textContent = text;
      return o;
    }

    function clearSelect(select) {
      while (select.firstChild) { select.removeChild(select.firstChild); }
    }

    function showAttribution() {
      var id = translationSelect.value;
      var text = '';
      var i;
      for (i = 0; i < translations.length; i++) {
        if (translations[i].id === id) { text = translations[i].attribution || ''; }
      }
      attribution.textContent = text;
    }

    function renderTranslations(list) {
      translations = list;
      clearSelect(translationSelect);
      var doc = translationSelect.ownerDocument;
      translationSelect.appendChild(option(doc, '', 'Select a translation…'));
      var i;
      for (i = 0; i < list.length; i++) {
        translationSelect.appendChild(option(doc, list[i].id,
          list[i].abbreviation + ' \u2014 ' + list[i].name));
      }
      var saved = state.get().translation;
      var known = false;
      for (i = 0; i < list.length; i++) { if (list[i].id === saved) { known = true; } }
      if (!known) {
        saved = list.length === 1 ? list[0].id : null;
        state.set({ translation: saved });
      }
      translationSelect.value = saved === null ? '' : saved;
      translationSelect.disabled = false;
      showAttribution();
    }

    // The translation list doubles as the sidecar health signal: a failed call means the
    // service is unreachable, so the control is disabled and Analyse says why.
    function loadTranslations() {
      if (!client) { return Promise.resolve(); }
      return client.translations().then(function (res) {
        if (res && res.ok) {
          state.set({ sidecarReady: true });
          renderTranslations((res.data && res.data.translations) || []);
        } else {
          state.set({ sidecarReady: false });
          translationSelect.disabled = true;
        }
        updateAnalyse();
      }).then(null, function () {
        state.set({ sidecarReady: false });
        translationSelect.disabled = true;
        updateAnalyse();
      });
    }

    // Track values are zero-based host indices (V1 = 0); labels are one-based and listed
    // topmost first.
    function renderTracks(count) {
      clearSelect(trackSelect);
      var doc = trackSelect.ownerDocument;
      var i;
      for (i = count - 1; i >= 0; i--) {
        trackSelect.appendChild(option(doc, String(i), 'V' + (i + 1)));
      }
      var saved = state.get().targetTrack;
      var keep = typeof saved === 'number' && saved >= 0 && saved < count;
      var chosen = keep ? saved : (count > 0 ? count - 1 : null);
      trackSelect.value = chosen === null ? '' : String(chosen);
      trackSelect.disabled = count === 0;
      state.set({ targetTrack: chosen });
    }

    function loadTracks() {
      return bridge.call('getSequenceInfo', {}).then(function (res) {
        var info = res && res.ok && res.data;
        var open = !!(info && info.hasActiveSequence);
        state.set({ sequenceOpen: open });
        renderTracks(open ? (info.videoTrackCount || 0) : 0);
        updateAnalyse();
      }).then(null, function () {
        state.set({ sequenceOpen: false });
        renderTracks(0);
        updateAnalyse();
      });
    }

    function onTranslationChange() {
      state.set({ translation: translationSelect.value === '' ? null : translationSelect.value });
      showAttribution();
      updateAnalyse();
    }

    function onTrackChange() {
      state.set({ targetTrack: trackSelect.value === '' ? null : parseInt(trackSelect.value, 10) });
      updateAnalyse();
    }

    function onDurationChange() {
      var fixed = durationFixed.checked;
      durationSec.disabled = !fixed;
      if (fixed) {
        var sec = positiveOr(durationSec.value, positiveOr(state.get().fixedDurationSec,
          FIXED_DURATION_DEFAULT));
        durationSec.value = String(sec);
        state.set({ durationMode: 'fixed', fixedDurationSec: sec });
      } else {
        state.set({ durationMode: 'auto' });
      }
    }

    function onLeadInChange() {
      var v = clampLeadIn(leadIn.value);
      leadIn.value = String(v);
      state.set({ leadInSec: v });
    }

    // docs/07 POST /jobs body. Fields the panel does not expose (model, device, detection...)
    // are left to the sidecar's configured defaults; duration settings travel in options.timing
    // under the docs/05 §3 parameter names.
    function buildRequest() {
      var s = state.get();
      var timing = { lead_in_s: s.leadInSec, duration_mode: s.durationMode };
      if (s.durationMode === 'fixed') { timing.fixed_duration_s = s.fixedDurationSec; }
      return {
        media_path: s.mediaPath,
        translation_id: s.translation,
        options: { timing: timing }
      };
    }

    function onAnalyseClick() {
      if (State.analyseBlockers(state.get()).length > 0) { return; }
      onAnalyse(buildRequest());
    }

    function onPickTemplate() {
      var p = pickFile(fs, 'Select Motion Graphics template', ['mogrt']);
      if (!p) { return null; }
      return loadTemplate(p);
    }

    mediaBtn.addEventListener('click', onPickMedia);
    templateBtn.addEventListener('click', onPickTemplate);
    refSelect.addEventListener('change', function () { persistMapping(); updateAnalyse(); });
    bodySelect.addEventListener('change', function () { persistMapping(); updateAnalyse(); });
    translationSelect.addEventListener('change', onTranslationChange);
    trackSelect.addEventListener('change', onTrackChange);
    trackRefresh.addEventListener('click', loadTracks);
    durationAuto.addEventListener('change', onDurationChange);
    durationFixed.addEventListener('change', onDurationChange);
    durationSec.addEventListener('change', onDurationChange);
    leadIn.addEventListener('change', onLeadInChange);
    analyseBtn.addEventListener('click', onAnalyseClick);

    // Initial render: the media file is never restored; the template and its fields are
    // re-read from disk because the fields are not persisted.
    var initial = state.get();
    setPath(mediaName, null, 'No file selected');
    setPath(templateName, initial.mogrtPath, 'No template selected');
    fillSelect(refSelect, [], null);
    fillSelect(bodySelect, [], null);
    clearMessage();
    durationFixed.checked = initial.durationMode === 'fixed';
    durationAuto.checked = !durationFixed.checked;
    durationSec.value = initial.fixedDurationSec ? String(initial.fixedDurationSec) : '';
    durationSec.disabled = !durationFixed.checked;
    leadIn.value = String(clampLeadIn(initial.leadInSec));
    clearSelect(translationSelect);
    clearSelect(trackSelect);
    updateAnalyse();
    var ready = Promise.all([
      initial.mogrtPath ? loadTemplate(initial.mogrtPath) : null,
      loadTranslations(),
      loadTracks()
    ]).then(function () { updateAnalyse(); });

    return {
      ready: ready,
      refreshTracks: loadTracks,
      refreshTranslations: loadTranslations,
      pickMedia: onPickMedia,
      pickTemplate: onPickTemplate
    };
  }

  var Setup = { create: create, MEDIA_EXTENSIONS: MEDIA_EXTENSIONS };

  if (typeof module !== 'undefined' && module.exports) { module.exports = Setup; }
  else { root.VSSetup = Setup; }
})(this);
