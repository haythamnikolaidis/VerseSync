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

    var readToken = 0;

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
      });
    }

    function onPickMedia() {
      var p = pickFile(fs, 'Select audio or video file', MEDIA_EXTENSIONS);
      if (!p) { return; }
      state.set({ mediaPath: p });
      setPath(mediaName, p, 'No file selected');
    }

    function onPickTemplate() {
      var p = pickFile(fs, 'Select Motion Graphics template', ['mogrt']);
      if (!p) { return null; }
      return loadTemplate(p);
    }

    mediaBtn.addEventListener('click', onPickMedia);
    templateBtn.addEventListener('click', onPickTemplate);
    refSelect.addEventListener('change', persistMapping);
    bodySelect.addEventListener('change', persistMapping);

    // Initial render: the media file is never restored; the template and its fields are
    // re-read from disk because the fields are not persisted.
    var initial = state.get();
    setPath(mediaName, null, 'No file selected');
    setPath(templateName, initial.mogrtPath, 'No template selected');
    fillSelect(refSelect, [], null);
    fillSelect(bodySelect, [], null);
    clearMessage();
    var ready = initial.mogrtPath ? loadTemplate(initial.mogrtPath) : Promise.resolve();

    return {
      ready: ready,
      pickMedia: onPickMedia,
      pickTemplate: onPickTemplate
    };
  }

  var Setup = { create: create, MEDIA_EXTENSIONS: MEDIA_EXTENSIONS };

  if (typeof module !== 'undefined' && module.exports) { module.exports = Setup; }
  else { root.VSSetup = Setup; }
})(this);
