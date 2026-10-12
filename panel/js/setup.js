/**
 * setup.js — the Setup panel, status strip and progress view (docs/09-ui-spec.md §2–4).
 *
 * Load order: ... bridge.js -> sidecar.js -> state.js -> setup.js -> main.js
 *
 * All rules (defaults, validation, the Analyse gate, progress maths) live in state.js; this
 * file only reads the controls, calls the host and sidecar, and renders. mount() takes its
 * collaborators as arguments so a test can swap any of them.
 */
(function () {
  'use strict';

  var MEDIA_EXTENSIONS = ['wav', 'mp3', 'm4a', 'aac', 'flac', 'mp4', 'mov', 'mxf'];
  // Sequence changes (opened, closed, tracks added) are noticed by polling the host; there is
  // no CEP event for them. Two seconds feels live and costs one tiny evalScript per tick.
  var SEQUENCE_POLL_MS = 2000;

  // ------------------------------------------------------------------ file picker

  /**
   * pickFileCEP(cep, title, extensions) -> {path} | {path:null, error?}
   * Ported from VerseFlow. Uses window.cep.fs.showOpenDialog, which runs in the panel process;
   * ExtendScript's File.openDialog fails in Premiere 2026. A cancelled dialog is not an error.
   */
  function pickFileCEP(cep, title, extensions) {
    if (!cep || !cep.fs || !cep.fs.showOpenDialog) {
      return { path: null, error: 'The file dialog is not available. Try updating Premiere Pro.' };
    }
    var result;
    try {
      result = cep.fs.showOpenDialog(false, false, title, null, extensions);
    } catch (e) {
      return { path: null, error: 'The file dialog failed to open.' };
    }
    if (!result || result.err !== 0 || !result.data || result.data.length === 0) {
      return { path: null };
    }
    return { path: result.data[0] };
  }

  function basename(p) {
    return String(p || '').replace(/\\/g, '/').split('/').pop();
  }

  // ------------------------------------------------------------------ mount

  /**
   * mount(deps) -> controller
   * deps: { client (sidecar client or null), bridge, storage, pickFile(title, exts),
   *         doc, startPolling (default true) }
   */
  function mount(deps) {
    var doc = deps.doc || document;
    var bridge = deps.bridge || window.VSBridge;
    var client = deps.client || null;
    var pick = deps.pickFile || function (title, exts) { return pickFileCEP(window.cep, title, exts); };
    var store = VSState.create(deps.storage);

    function $(id) { return doc.getElementById(id); }
    var el = {
      strip: $('sidecar-status'), details: $('strip-details'),
      setup: $('setup-section'), summary: $('setup-summary'), body: $('setup-body'),
      btnMedia: $('btn-media'), mediaName: $('media-name'), mediaNote: $('media-note'),
      btnMogrt: $('btn-mogrt'), mogrtName: $('mogrt-name'), mogrtWarn: $('mogrt-warning'),
      selRef: $('sel-ref'), selBody: $('sel-body'), mapErr: $('mapping-error'),
      selTrans: $('sel-translation'), transAttr: $('translation-attr'),
      selTrack: $('sel-track'), btnRefresh: $('btn-refresh-track'), trackNote: $('track-note'),
      radioAuto: $('dur-auto'), radioFixed: $('dur-fixed'), inFixed: $('input-fixed'),
      inLead: $('input-leadin'),
      btnAnalyse: $('btn-analyse'), reason: $('analyse-reason'),
      progress: $('progress-section'), pLabel: $('progress-label'), pFill: $('progress-fill'),
      pBar: $('progress-bar'), pPct: $('progress-pct'), pTime: $('progress-time'),
      btnCancel: $('btn-cancel'),
      jobError: $('job-error'), jobErrMsg: $('job-error-message'),
      jobErrHint: $('job-error-hint'), btnRetry: $('btn-retry'),
      fields: $('setup-fields'), review: $('review-area')
    };

    var sequenceKey = '';
    var detailsOpen = false;
    var job = null;           // { id, startedAt, cacheHit, watcher, snap }
    var tickTimer = null;
    var resumed = false;
    var translationsRequested = false;
    var lastError = null;     // { message, hint } for the Retry view
    var summaryText = '';
    var collapsed = false;

    // ---- strip

    function sidecarStatus() {
      if (client) { return client.getStatus(); }
      return { state: 'unreachable', message: 'Not available outside Premiere.', logPath: '' };
    }

    function currentStrip() {
      return VSSidecar.computeStrip(sidecarStatus(), store.get().hasSequence);
    }

    function renderStrip() {
      var strip = currentStrip();
      el.strip.className = 'vs-strip vs-strip--' + strip.kind;
      el.strip.textContent = strip.text;
      if (strip.action === 'details' || (strip.action && client)) {
        var b = doc.createElement('button');
        b.className = 'vs-btn vs-btn--small';
        b.type = 'button';
        b.textContent = strip.action === 'relaunch' ? 'Restart service' : 'Details';
        b.addEventListener('click', function () {
          if (strip.action === 'relaunch') { client.relaunch(); return; }
          detailsOpen = !detailsOpen;
          renderStrip();
        });
        el.strip.appendChild(doc.createTextNode(' '));
        el.strip.appendChild(b);
      }
      var showDetail = strip.detail && detailsOpen;
      el.details.hidden = !showDetail;
      if (showDetail) {
        el.details.textContent = strip.detail.message +
          (strip.detail.logPath ? '\nLog: ' + strip.detail.logPath : '');
      }
    }

    // ---- setup controls

    function fillSelect(sel, options, chosen, placeholder) {
      sel.innerHTML = '';
      var first = doc.createElement('option');
      first.value = '';
      first.textContent = placeholder;
      sel.appendChild(first);
      for (var i = 0; i < options.length; i++) {
        var o = doc.createElement('option');
        o.value = String(options[i].value);
        o.textContent = options[i].label;
        sel.appendChild(o);
      }
      sel.value = chosen === null || chosen === undefined ? '' : String(chosen);
    }

    function renderFieldSelects() {
      var s = store.get();
      var opts = (s.mogrtFields || []).map(function (f) {
        return { value: f.index, label: VSState.fieldLabel(f) };
      });
      fillSelect(el.selRef, opts, s.mapping.referenceIndex, '— choose field —');
      fillSelect(el.selBody, opts, s.mapping.bodyIndex, '— choose field —');
      el.selRef.disabled = el.selBody.disabled = opts.length === 0;
    }

    function renderTranslations() {
      var s = store.get();
      var strip = currentStrip();
      var list = s.translations || [];
      fillSelect(el.selTrans, list.map(function (t) {
        return { value: t.id, label: t.name + (t.abbreviation ? ' (' + t.abbreviation + ')' : '') };
      }), s.translationId, list.length ? '— choose translation —' : '— unavailable —');
      el.selTrans.disabled = list.length === 0 || strip.kind === 'unreachable' ||
        strip.kind === 'starting';
      var chosen = null;
      for (var i = 0; i < list.length; i++) { if (list[i].id === s.translationId) { chosen = list[i]; } }
      el.transAttr.textContent = chosen ? chosen.attribution || '' : '';
    }

    function renderTracks() {
      var s = store.get();
      var opts = VSState.trackOptions(s.videoTrackCount);
      fillSelect(el.selTrack, opts, s.trackIndex, opts.length ? '— choose track —' : '— no sequence —');
      el.selTrack.disabled = opts.length === 0;
    }

    function renderMogrt() {
      var s = store.get();
      el.mogrtName.textContent = s.mogrtPath ? basename(s.mogrtPath) : 'No template selected';
      el.mogrtName.title = s.mogrtPath || '';
      el.btnMogrt.disabled = s.mogrtBusy || s.jobActive;
      el.btnMogrt.textContent = s.mogrtBusy ? 'Reading template…' : 'Select…';
      var warn = '';
      if (s.mogrtError) {
        warn = s.mogrtError;
      } else if (s.mogrtFields && s.mogrtFields.length === 0) {
        warn = 'This template has no editable text fields. It may be a Premiere-authored ' +
          'template, which isn’t supported — use an After Effects–authored one.';
      }
      el.mogrtWarn.textContent = warn;
      el.mogrtWarn.hidden = !warn;
    }

    function renderMedia() {
      var s = store.get();
      el.mediaName.textContent = s.mediaPath ? basename(s.mediaPath) : 'No media selected';
      el.mediaName.title = s.mediaPath || '';
    }

    function renderDuration() {
      var s = store.get();
      el.radioAuto.checked = s.durationMode === 'auto';
      el.radioFixed.checked = s.durationMode === 'fixed';
      el.inFixed.disabled = s.durationMode !== 'fixed';
      if (doc.activeElement !== el.inFixed) { el.inFixed.value = s.fixedText; }
      if (doc.activeElement !== el.inLead) { el.inLead.value = s.leadInText; }
    }

    function renderGate() {
      var s = store.get();
      var gate = VSState.analyseGate(s, currentStrip());
      el.btnAnalyse.disabled = !gate.enabled;
      el.reason.textContent = gate.enabled ? '' : gate.reason;
      el.reason.hidden = gate.enabled;
      var mapErr = VSState.validateMapping(s.mapping);
      el.mapErr.textContent = mapErr || '';
      el.mapErr.hidden = !mapErr;
      // A fieldset disables every control inside it, and re-enables them all afterwards.
      el.fields.disabled = s.jobActive;
    }

    function renderAll() {
      renderStrip();
      renderMedia();
      renderMogrt();
      renderFieldSelects();
      renderTranslations();
      renderTracks();
      renderDuration();
      renderGate();
      renderSummary();
    }

    // ---- collapse / summary

    function buildSummary() {
      var s = store.get();
      var track = s.trackIndex === null ? '' : 'V' + (s.trackIndex + 1);
      var trans = '';
      (s.translations || []).forEach(function (t) { if (t.id === s.translationId) { trans = t.abbreviation || t.name; } });
      var parts = [s.mediaPath ? basename(s.mediaPath) : null,
                   s.mogrtPath ? basename(s.mogrtPath).replace(/\.mogrt$/i, '') : null,
                   trans || null, track || null,
                   s.durationMode === 'fixed' ? s.fixedDurationS + 's' : 'Auto',
                   'lead-in ' + s.leadInS + 's'];
      return parts.filter(function (p) { return p; }).join(' · ');
    }

    function setCollapsed(on) {
      collapsed = on;
      renderSummary();
    }

    function renderSummary() {
      if (collapsed) { summaryText = buildSummary(); }
      el.summary.hidden = !collapsed;
      el.body.hidden = collapsed;
      el.summary.textContent = '▸ SETUP — ' + summaryText;
    }

    // ---- progress

    function showProgress(on) { el.progress.hidden = !on; }

    function renderProgress() {
      if (!job) { return; }
      var elapsed = (Date.now() - job.startedAt) / 1000;
      var v = VSState.progressView(job.snap, elapsed, job.cacheHit);
      el.pLabel.textContent = v.label;
      el.pFill.style.width = v.percent + '%';
      el.pBar.setAttribute('aria-valuenow', String(v.percent));
      el.pPct.textContent = v.percent + '%';
      el.pTime.textContent = v.time;
      el.progress.className = 'vs-progress' + (job.cacheHit ? ' vs-progress--cached' : '');
    }

    function stopTicking() {
      if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    }

    function endJob() {
      stopTicking();
      if (job && job.watcher) { job.watcher.stop(); }
      job = null;
      store.set({ jobActive: false });
    }

    function showJobError(err) {
      lastError = err;
      el.jobErrMsg.textContent = err.message || 'The analysis failed.';
      el.jobErrHint.textContent = err.hint || '';
      el.jobErrHint.hidden = !err.hint;
      el.jobError.hidden = false;
    }

    function beginView(cacheHit, id, startedAt) {
      job = { id: id, startedAt: startedAt || Date.now(), cacheHit: !!cacheHit, watcher: null,
              snap: { phase: 'hashing', progress: 0 } };
      store.set({ jobActive: true, cueDocument: null });
      el.jobError.hidden = true;
      showProgress(true);
      setCollapsed(true);
      renderProgress();
      renderAll();
      stopTicking();
      tickTimer = setInterval(renderProgress, 500);
    }

    var handlers = {
      onProgress: function (snap) {
        if (!job) { return; }
        job.snap = snap;
        renderProgress();
      },
      onDone: function (payload) {
        if (!job) { return; }
        var id = job.id;
        job.snap = { phase: 'timing', progress: 1 };
        renderProgress();
        client.getResult(id).then(function (r) {
          endJob();
          showProgress(false);
          if (r.ok) {
            store.set({ cueDocument: r.data });
            var n = (r.data.cues || []).length;
            el.review.textContent = n === 0
              ? 'No scripture references found. Check the audio has speech, or try a larger model.'
              : n + (n === 1 ? ' scripture found.' : ' scriptures found.');
          } else {
            setCollapsed(false);
            showJobError(r.error);
          }
          renderAll();
        });
      },
      onFailed: function (err) {
        endJob();
        showProgress(false);
        setCollapsed(false);
        if (!err || err.code !== 'cancelled') {
          showJobError(err || { message: 'The analysis failed.' });
        }
        renderAll();
      }
    };

    function startAnalyse() {
      var s = store.get();
      if (!VSState.analyseGate(s, currentStrip()).enabled || !client) { return; }
      var body = VSState.jobRequest(s);
      el.btnAnalyse.disabled = true;
      client.startJob(body).then(function (r) {
        if (!r.ok) {
          showJobError(r.error);
          renderAll();
          return;
        }
        beginView(r.data.cache_hit, r.data.job_id);
        job.watcher = client.watchJob(r.data.job_id, handlers);
      });
    }

    function cancelAnalyse() {
      if (!job || !client) { return; }
      el.btnCancel.disabled = true;
      var id = job.id;
      client.cancelJob(id).then(function (r) {
        el.btnCancel.disabled = false;
        if (!r.ok) {
          showJobError(r.error);
          return;
        }
        // The watcher reports the cancelled snapshot; if the job was already gone, finish here.
        if (job && job.id === id) { handlers.onFailed({ code: 'cancelled' }); }
      });
    }

    // After a panel reload, rejoin a job that was running (NFR-3).
    function resume() {
      if (resumed || !client) { return; }
      resumed = true;
      client.resumeJob(handlers).then(function (r) {
        if (r.ok && r.data) {
          beginView(false, r.data.job_id);
          job.watcher = r.data.watcher;
        }
      });
    }

    // ---- host: sequence and template

    function applySequence(info) {
      var has = !!(info && info.hasActiveSequence);
      var count = has ? Number(info.videoTrackCount) || 0 : 0;
      var s = store.get();
      var track = count ? VSState.resolveTrack(s.trackIndex, count) : null;
      store.set({ hasSequence: has, videoTrackCount: count, trackIndex: has ? track : s.trackIndex });
      // sequenceID (hostApi 1.1) and any other extra field are ignored here.
    }

    function refreshSequence() {
      return bridge.api.getSequenceInfo().then(function (res) {
        var key = JSON.stringify(res);
        var changed = key !== sequenceKey;
        sequenceKey = key;
        if (res.ok) {
          el.trackNote.hidden = true;
          applySequence(res.data);
        } else {
          applySequence(null);
          el.trackNote.textContent = res.error;
          el.trackNote.hidden = false;
        }
        if (changed) {
          renderTracks();
          renderStrip();
          renderGate();
        }
        // A saved template waiting for a sequence is read as soon as one opens.
        var s = store.get();
        if (s.hasSequence && s.mogrtPath && s.mogrtFields === null && !s.mogrtBusy && !s.mogrtError) {
          return loadTemplate(s.mogrtPath);
        }
      });
    }

    /** Read a template's fields and apply the right mapping: saved for this path, else smart. */
    function loadTemplate(path) {
      store.set({ mogrtPath: path, mogrtBusy: true, mogrtError: null });
      renderMogrt();
      renderGate();
      return bridge.api.getMogrtFields({ path: path }).then(function (res) {
        if (store.get().mogrtPath !== path) { return; }
        if (!res.ok) {
          store.set({ mogrtBusy: false, mogrtError: res.error, mogrtFields: null });
        } else {
          var fields = (res.data && res.data.fields) || [];
          store.set({ mogrtBusy: false, mogrtFields: fields });
          var defs = VSState.smartDefaults(fields);
          var saved = store.loadMapping(path);
          var ref = saved && VSState.hasField(fields, saved.referenceIndex) ? saved.referenceIndex : defs.referenceIndex;
          var body = saved && VSState.hasField(fields, saved.bodyIndex) ? saved.bodyIndex : defs.bodyIndex;
          store.setMapping(ref, body);
        }
        renderMogrt();
        renderFieldSelects();
        renderGate();
        renderSummary();
      });
    }

    // ---- sidecar: translations, status

    function loadTranslations() {
      if (!client || translationsRequested) { return; }
      translationsRequested = true;
      client.translations().then(function (r) {
        if (!r.ok) { translationsRequested = false; return; }
        var list = r.data.translations || [];
        var s = store.get();
        var chosen = null;
        var i;
        for (i = 0; i < list.length; i++) { if (list[i].id === s.translationId) { chosen = list[i].id; } }
        // With nothing valid remembered, offer the bundled public-domain WEB if it is listed;
        // never silently pick a licensed translation.
        for (i = 0; chosen === null && i < list.length; i++) {
          if (list[i].abbreviation === 'WEB') { chosen = list[i].id; }
        }
        store.set({ translations: list, translationId: chosen });
        renderTranslations();
        renderGate();
        renderSummary();
      });
    }

    function onSidecarStatus() {
      var st = sidecarStatus().state;
      if (st === 'ready' || st === 'degraded') {
        loadTranslations();
        resume();
      } else if (st === 'unreachable' || st === 'version_mismatch') {
        translationsRequested = false;
      }
      renderStrip();
      renderTranslations();
      renderGate();
    }

    // ---- events

    el.btnMedia.addEventListener('click', function () {
      var r = pick('Select the sermon media', MEDIA_EXTENSIONS);
      if (r.error) { el.mediaNote.textContent = r.error; el.mediaNote.hidden = false; return; }
      el.mediaNote.hidden = true;
      if (r.path) { store.set({ mediaPath: r.path }); renderMedia(); renderGate(); renderSummary(); }
    });

    el.btnMogrt.addEventListener('click', function () {
      var r = pick('Select a Motion Graphics Template', ['mogrt']);
      if (r.error) { el.mogrtWarn.textContent = r.error; el.mogrtWarn.hidden = false; return; }
      if (r.path) { store.set({ mogrtFields: null }); loadTemplate(r.path); }
    });

    function onMappingChange() {
      var ref = el.selRef.value === '' ? null : parseInt(el.selRef.value, 10);
      var body = el.selBody.value === '' ? null : parseInt(el.selBody.value, 10);
      store.setMapping(ref, body);
      renderGate();
    }
    el.selRef.addEventListener('change', onMappingChange);
    el.selBody.addEventListener('change', onMappingChange);

    el.selTrans.addEventListener('change', function () {
      store.set({ translationId: el.selTrans.value || null });
      renderTranslations();
      renderGate();
      renderSummary();
    });

    el.selTrack.addEventListener('change', function () {
      store.set({ trackIndex: el.selTrack.value === '' ? null : parseInt(el.selTrack.value, 10) });
      renderGate();
    });

    el.btnRefresh.addEventListener('click', function () { refreshSequence(); });

    function onDurationMode() {
      store.set({ durationMode: el.radioFixed.checked ? 'fixed' : 'auto' });
      renderDuration();
      renderGate();
    }
    el.radioAuto.addEventListener('change', onDurationMode);
    el.radioFixed.addEventListener('change', onDurationMode);
    el.inFixed.addEventListener('input', function () { store.setFixedText(el.inFixed.value); renderGate(); });
    el.inLead.addEventListener('input', function () { store.setLeadInText(el.inLead.value); renderGate(); });

    el.btnAnalyse.addEventListener('click', startAnalyse);
    el.btnCancel.addEventListener('click', cancelAnalyse);
    el.btnRetry.addEventListener('click', function () { el.jobError.hidden = true; startAnalyse(); });
    el.summary.addEventListener('click', function () { setCollapsed(false); });

    // ---- start

    if (client) { client.onStatus(onSidecarStatus); }
    showProgress(false);
    el.jobError.hidden = true;
    renderAll();

    bridge.loadJSX().then(function (loaded) {
      if (!loaded.ok) {
        el.trackNote.textContent = loaded.error;
        el.trackNote.hidden = false;
        return;
      }
      return refreshSequence().then(function () {
        if (deps.startPolling !== false) {
          setInterval(refreshSequence, SEQUENCE_POLL_MS);
          if (typeof window !== 'undefined') { window.addEventListener('focus', refreshSequence); }
        }
      });
    });
    onSidecarStatus();

    return {
      store: store,
      refreshSequence: refreshSequence,
      loadTemplate: loadTemplate
    };
  }

  var VSSetup = { mount: mount, pickFileCEP: pickFileCEP, MEDIA_EXTENSIONS: MEDIA_EXTENSIONS };
  if (typeof window !== 'undefined') { window.VSSetup = VSSetup; }
  if (typeof module !== 'undefined' && module.exports) { module.exports = VSSetup; }
})();
