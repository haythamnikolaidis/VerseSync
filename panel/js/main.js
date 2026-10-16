(function (root) {
  'use strict';

  // Panel bootstrap and the Analyse -> review flow (docs/03 §4 Journey A, docs/09 §7).
  // createApp takes every outside dependency as an argument so tests can pass fakes; the boot
  // code at the bottom builds the real ones.

  function load(name, file) {
    if (root[name]) { return root[name]; }
    return typeof require !== 'undefined' ? require(file) : undefined;
  }

  function basename(p) {
    var parts = String(p).split(/[\\/]/);
    return parts[parts.length - 1] || String(p);
  }

  function el(doc, tag, cls, text) {
    var node = doc.createElement(tag);
    if (cls) { node.className = cls; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }

  function clear(node) {
    while (node.firstChild) { node.removeChild(node.firstChild); }
  }

  // Turns "HH:MM:SS:FF" (non-drop-frame, the display form of VSTimemap.timecode) into the
  // sequence tick offset docs/05 §5.4 asks for. The display timecode includes the sequence's zero
  // point, which mapping does not, so it is taken back out. Returns { ticks } (a string) or
  // { error }.
  function parseTimecode(text, seqInfo) {
    var m = /^\s*(\d+):(\d{1,2}):(\d{1,2}):(\d{1,2})\s*$/.exec(String(text));
    if (!m) { return { error: 'Enter a timecode as HH:MM:SS:FF.' }; }
    var fps = Math.round(seqInfo.frameRate);
    var mm = parseInt(m[2], 10);
    var ss = parseInt(m[3], 10);
    var ff = parseInt(m[4], 10);
    if (mm > 59 || ss > 59 || ff >= fps) { return { error: 'That timecode is not valid for this sequence.' }; }
    var frames = ((parseInt(m[1], 10) * 60 + mm) * 60 + ss) * fps + ff;
    var ticks = frames * Number(seqInfo.timebase) - Number(seqInfo.zeroPointTicks || 0);
    if (ticks < 0) { return { error: 'That timecode is before the start of the sequence.' }; }
    return { ticks: String(ticks) };
  }

  // deps: { document, bridge, client, transport, storage, fs, sleep, pollMs, watchJob }.
  // client may be null when no sidecar is available; setup then keeps Analyse disabled.
  function createApp(deps) {
    var doc = deps.document;
    var bridge = deps.bridge;
    var client = deps.client || null;
    var Progress = load('VSProgress', './progress.js');
    var Setup = load('VSSetup', './setup.js');
    var State = load('VSState', './state.js');
    var Cues = load('VSCues', './cues.js');
    var Timemap = load('VSTimemap', './timemap.js');
    var Review = load('VSReview', './review.js');
    var Sidecar = load('VSSidecar', './sidecar.js');
    var watchJob = deps.watchJob || Sidecar.watchJob;

    var app = {};
    var statusEl = doc.getElementById('status');
    var setupEl = doc.getElementById('setup');
    var reviewEl = doc.getElementById('review');
    var hasSequence = false;
    var lastHealth = { state: 'starting', detail: null };
    var lastRequest = null;
    var activeJobId = null;

    // What the later tasks need: the job (for the transcript), the sequence the analysis ran
    // against (T-30 inserts into it), the model, and the current mapping.
    app.session = null;

    function drawStatus() {
      Progress.renderStatus(statusEl,
        Progress.statusLine(lastHealth.state, lastHealth.detail, hasSequence));
    }

    app.setLifecycle = function (state, detail) {
      lastHealth = { state: state, detail: detail };
      drawStatus();
    };

    app.progress = Progress.view({
      root: doc.getElementById('progress'),
      setupRoot: setupEl,
      onCancel: function () { if (app.onCancel) { app.onCancel(); } }
    });
    drawStatus();

    // ---- the review area ------------------------------------------------------------------

    function resetReview() {
      clear(reviewEl);
      reviewEl.hidden = true;
    }

    // A message in the review area, optionally with a hint line and a Retry button.
    function showProblem(message, hint, retry) {
      app.progress.done();
      clear(reviewEl);
      var box = el(doc, 'div', 'vf-failure');
      box.setAttribute('role', 'alert');
      box.appendChild(el(doc, 'div', 'vf-inline-error vf-failure-message', message));
      if (hint) { box.appendChild(el(doc, 'div', 'vf-hint vf-failure-hint', hint)); }
      if (retry) {
        var btn = el(doc, 'button', 'vf-btn vf-failure-retry', 'Retry');
        btn.type = 'button';
        btn.addEventListener('click', retry);
        box.appendChild(btn);
      }
      reviewEl.appendChild(box);
      reviewEl.hidden = false;
    }

    function retryAnalyse() { if (lastRequest) { app.analyse(lastRequest); } }

    function showJobError(err) {
      var e = err || {};
      showProblem(e.message || 'The analysis failed.', e.hint, retryAnalyse);
    }

    function remap() {
      var s = app.session;
      s.mapping = Timemap.mapCueDocument(s.model.toJSON(), {
        seqInfo: s.seqInfo,
        segments: s.segments,
        manualOffsetTicks: s.manualOffsetTicks
      });
      return s.mapping;
    }

    function renderReview(notice) {
      var s = app.session;
      clear(reviewEl);
      if (notice) { reviewEl.appendChild(el(doc, 'div', 'vf-warning vf-review-notice', notice)); }
      if (s.model.cues().length === 0) {
        reviewEl.appendChild(el(doc, 'div', 'vf-hint vf-review-empty',
          'No scripture references found. Check the audio has speech, or try a larger model.'));
      } else {
        var body = el(doc, 'div', 'vf-review-body');
        reviewEl.appendChild(body);
        s.review = Review.create({
          root: body,
          model: s.model,
          getPlacements: function () { return s.mapping.placements; },
          bridge: bridge
        });
      }
      reviewEl.hidden = false;
    }

    // docs/09 §7 "Media not in the sequence": nothing can be placed until the editor says where
    // frame 0 of the media sits (docs/05 §5.4).
    function showManualOffset() {
      var s = app.session;
      clear(reviewEl);
      var box = el(doc, 'div', 'vf-manual-offset');
      box.appendChild(el(doc, 'div', 'vf-warning vf-review-notice',
        basename(s.request.media_path) + " isn't in this sequence."));
      var label = el(doc, 'label', 'vf-label', 'Enter a start timecode manually');
      label.setAttribute('for', 'review-manual-offset');
      var input = el(doc, 'input', 'vf-input-text');
      input.type = 'text';
      input.id = 'review-manual-offset';
      input.setAttribute('placeholder', 'HH:MM:SS:FF');
      var apply = el(doc, 'button', 'vf-btn vf-btn--small', 'Apply');
      apply.type = 'button';
      apply.id = 'review-manual-apply';
      var error = el(doc, 'div', 'vf-inline-error');
      error.setAttribute('role', 'alert');
      error.hidden = true;
      apply.addEventListener('click', function () { applyOffset(input.value, error); });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { applyOffset(input.value, error); }
      });
      box.appendChild(label);
      box.appendChild(input);
      box.appendChild(apply);
      box.appendChild(error);
      reviewEl.appendChild(box);
      reviewEl.hidden = false;
    }

    function applyOffset(text, errorEl) {
      var parsed = parseTimecode(text, app.session.seqInfo);
      if (parsed.error) {
        errorEl.textContent = parsed.error;
        errorEl.hidden = false;
        return;
      }
      app.session.manualOffsetTicks = parsed.ticks;
      var mapping = remap();
      app.session.model.applyPanelFlags(mapping.placements);
      renderReview('Positions come from the start timecode you entered, so they are approximate ' +
        'if the audio was cut.');
    }

    // ---- Analyse -> review ----------------------------------------------------------------

    // Steps 11-12 of Journey A: where do the media's frames sit in the open sequence?
    function place(model, request, jobId) {
      return bridge.call('getSequenceInfo', {}).then(function (info) {
        if (!info || !info.ok) {
          showProblem((info && info.error) || 'Could not read the sequence.', '', retryAnalyse);
          return null;
        }
        if (!info.data.hasActiveSequence) {
          showProblem('Open a sequence in Premiere first.', '', retryAnalyse);
          return null;
        }
        var seqInfo = info.data;
        return bridge.call('getMediaSegments', {
          mediaPath: request.media_path,
          sequenceId: seqInfo.sequenceId
        }).then(function (segs) {
          if (!segs || !segs.ok) {
            showProblem((segs && segs.error) || 'Could not read the media placements.', '',
              retryAnalyse);
            return null;
          }
          app.session = {
            jobId: jobId,
            request: request,
            sequenceId: seqInfo.sequenceId,
            seqInfo: seqInfo,
            segments: segs.data,
            model: model,
            manualOffsetTicks: null,
            mapping: null,
            review: null
          };
          var mapping = remap();
          if (mapping.unmatched) { showManualOffset(); return null; }
          model.applyPanelFlags(mapping.placements);
          return mapping;
        });
      });
    }

    function onJobDone(jobId, request) {
      app.progress.done();
      return client.result(jobId).then(function (res) {
        if (!res.ok) { showJobError(res.error); return; }
        var loaded = Cues.load(JSON.stringify(res.data));
        if (!loaded.ok) { showProblem(loaded.error, '', retryAnalyse); return; }
        return place(loaded.model, request, jobId).then(function (mapping) {
          if (mapping) { renderReview(loaded.warning || null); }
        });
      }).then(null, function (e) {
        showProblem('Unexpected error: ' + (e && e.message), '', retryAnalyse);
      });
    }

    app.analyse = function (request) {
      lastRequest = request;
      app.session = null;
      activeJobId = null;
      resetReview();
      app.progress.begin(basename(request.media_path));
      return client.startJob(request).then(function (res) {
        if (!res.ok) { showJobError(res.error); return; }
        var jobId = res.data.job_id;
        activeJobId = jobId;
        if (res.data.cache_hit) { app.progress.cacheHit(); }
        watchJob({
          client: client,
          transport: deps.transport,
          storage: deps.storage,
          sleep: deps.sleep,
          pollMs: deps.pollMs,
          jobId: jobId,
          onProgress: function (ev) { app.progress.update(ev); },
          onDone: function () { onJobDone(jobId, request); },
          onFailed: showJobError,
          onCancelled: function () { showProblem('The analysis was cancelled.', '', retryAnalyse); }
        });
      });
    };

    app.onCancel = function () {
      if (activeJobId && client) { client.cancel(activeJobId); }
    };

    app.remap = remap;

    app.setup = Setup.create({
      root: setupEl,
      state: State.create({ storage: deps.storage }),
      bridge: bridge,
      fs: deps.fs,
      client: client,
      onAnalyse: function (request) { app.analyse(request); }
    });
    app.ready = app.setup.ready;

    app.start = function () {
      return bridge.init().then(function () {
        return bridge.call('ping', {});
      }).then(function (res) {
        console.log('[VerseSync] VS.ping', JSON.stringify(res));
        return bridge.call('getSequenceInfo', {});
      }).then(function (res) {
        hasSequence = !!(res && res.ok && res.data && res.data.hasActiveSequence);
        drawStatus();
      });
    };

    return app;
  }

  // Without cep.fs (a plain browser, as in tools/panel_smoke.js) the file dialogs cannot open, so
  // they answer with the files the host stub knows (the media name matches the stub segments, the
  // template is the one VS.getMogrtFields accepts).
  var stubFs = {
    showOpenDialog: function (multiple, directory, title, initialPath, extensions) {
      var template = extensions && extensions.indexOf('mogrt') !== -1;
      return { err: 0, data: [template ? 'C:\\Stub\\AV_Quote_04.mogrt' : 'C:\\Stub\\SERMON_A014.MXF'] };
    }
  };

  function storageOrNull() {
    try { return root.localStorage || null; } catch (e) { return null; }
  }

  function boot() {
    var hasCS = typeof root.CSInterface !== 'undefined';
    var bridge = load('VSBridge', './bridge.js').create({
      csInterface: hasCS ? new root.CSInterface() : null,
      hostStub: root.VS,
      jsxPath: null
    });

    // Without Node the Node transport cannot work, so the fixture-backed stub transport stands
    // in for the sidecar. With Node there is no client until the sidecar lifecycle supplies one.
    var transport = null;
    var client = null;
    if (typeof require === 'undefined' && root.VSSidecarStub) {
      transport = root.VSSidecarStub.create({
        scenario: root.VSSidecarStub.scenarioFromSearch(root.location && root.location.search)
      });
      client = root.VSSidecar.VSSidecarClient.create({ transport: transport, port: 0, token: 'stub' });
    }

    var app = createApp({
      document: root.document,
      bridge: bridge,
      client: client,
      transport: transport,
      storage: storageOrNull(),
      fs: root.cep && root.cep.fs ? root.cep.fs : stubFs
    });
    root.VSApp = app;

    if (client) {
      client.health().then(function (res) {
        console.log('[VerseSync] stub sidecar health', JSON.stringify(res));
        if (res.ok) { app.setLifecycle(res.data.status, res.data); }
      });
    }
    app.start();
  }

  var Main = { createApp: createApp, parseTimecode: parseTimecode };

  if (typeof module !== 'undefined' && module.exports) { module.exports = Main; }
  else { root.VSMain = Main; }

  if (root.document && root.document.getElementById) { boot(); }
})(this);
