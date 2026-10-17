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

  // Directory part of a path and a sibling of it, keeping whichever separator the path uses
  // (cep.fs hands back Windows paths on Windows and POSIX paths on macOS).
  function dirname(p) {
    var i = Math.max(String(p).lastIndexOf('/'), String(p).lastIndexOf('\\'));
    return i === -1 ? '' : String(p).slice(0, i);
  }

  function sibling(p, name) {
    var dir = dirname(p);
    if (dir === '') { return name; }
    return dir + (String(p).charAt(dir.length) === '\\' ? '\\' : '/') + name;
  }

  // deps: { document, bridge, client, transport, storage, fs, sleep, pollMs, watchJob, confirm }.
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
    var Insert = load('VSInsert', './insert.js');
    var watchJob = deps.watchJob || Sidecar.watchJob;

    var app = {};
    var statusEl = doc.getElementById('status');
    var setupEl = doc.getElementById('setup');
    var reviewEl = doc.getElementById('review');
    var insertEl = doc.getElementById('insert');
    var setupState = State.create({ storage: deps.storage });
    var confirmFn = deps.confirm || function (text) {
      return typeof root.confirm === 'function' ? root.confirm(text) : false;
    };
    var inserting = false;
    var undoNoteShown = false;
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
      clear(insertEl);
      insertEl.hidden = true;
    }

    // Load cue document, for the states that have no review toolbar to hold it. With the sidecar
    // down nothing else can start, so this is the way in to load-and-insert (docs/03 §8). A failed
    // load reports into the note beside the button.
    var loadNote = null;
    function loadPrompt() {
      var wrap = el(doc, 'div', 'vf-load-prompt');
      var btn = el(doc, 'button', 'vf-btn vf-btn--small vf-load-doc', 'Load cue document');
      btn.type = 'button';
      btn.addEventListener('click', function () { loadDocument(); });
      loadNote = el(doc, 'div', 'vf-inline-error vf-load-note');
      loadNote.setAttribute('role', 'alert');
      loadNote.hidden = true;
      wrap.appendChild(btn);
      wrap.appendChild(loadNote);
      return wrap;
    }

    // Before any analysis the review area holds only the prompt (docs/09 §7).
    function showIdle() {
      clear(reviewEl);
      reviewEl.appendChild(el(doc, 'div', 'vf-hint vf-review-idle', Review.IDLE_TEXT));
      reviewEl.appendChild(loadPrompt());
      reviewEl.hidden = false;
    }
    showIdle();

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
      reviewEl.appendChild(loadPrompt());
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
        manualOffsetTicks: s.manualOffsetTicks,
        placementChoice: s.placementChoice
      });
      return s.mapping;
    }

    // Source seconds for a sequence position: through the media segments, or through the typed
    // start offset when the media could not be matched (docs/05 §5.4). Null when the position is
    // not over this media.
    function sourceAt(s, ticks) {
      if (s.manualOffsetTicks !== null && s.manualOffsetTicks !== undefined &&
          !(s.segments && s.segments.matched)) {
        var seconds = Timemap.ticksToSeconds(Number(ticks) - Number(s.manualOffsetTicks));
        return seconds < 0 ? null : seconds;
      }
      return Timemap.toSource(Timemap.buildMap(s.segments), ticks);
    }

    // The timing edits of the review rows (docs/09 §5.3): one frame is the sequence timebase.
    function timingFor(s) {
      return {
        nudgedSource: function (atTicks, frames) {
          return sourceAt(s, Timemap.shiftFrames(atTicks, frames, s.seqInfo.timebase));
        },
        playheadSource: function () {
          return bridge.call('getSequenceInfo', {}).then(function (res) {
            if (!res || !res.ok || !res.data || !res.data.hasActiveSequence) { return null; }
            return sourceAt(s, res.data.playheadTicks);
          });
        }
      };
    }

    function renderReview(notice) {
      var s = app.session;
      clear(reviewEl);
      if (notice) { reviewEl.appendChild(el(doc, 'div', 'vf-warning vf-review-notice', notice)); }
      s.placementChoice = {};
      var body = el(doc, 'div', 'vf-review-body');
      reviewEl.appendChild(body);
      s.review = Review.create({
        root: body,
        model: s.model,
        getPlacements: function () { return s.mapping.placements; },
        bridge: bridge,
        getTranscript: function () { return loadTranscript(s); },
        client: client,
        getTranslationId: function () { return s.request.translation_id; },
        getDurationMode: function () {
          var timing = s.request.options && s.request.options.timing;
          return timing && timing.duration_mode;
        },
        timing: timingFor(s),
        timecodeOf: function (ticks) { return Timemap.timecode(ticks, s.seqInfo); },
        onChoosePlacement: function (id, ticks) {
          s.placementChoice[id] = ticks;
          remap();
        },
        onChange: function () { remap(); },
        onSave: saveDocument,
        onLoad: loadDocument,
        onExport: exportTxt,
        onInsert: function () { return startInsert(null); }
      });
      reviewEl.hidden = false;
    }

    // ---- Insert (docs/09 §6) --------------------------------------------------------------

    function showInsert(nodes) {
      clear(insertEl);
      nodes.forEach(function (n) { insertEl.appendChild(n); });
      insertEl.hidden = nodes.length === 0;
    }

    function insertError(lines) {
      var box = el(doc, 'div', 'vf-inline-error vf-insert-error');
      box.setAttribute('role', 'alert');
      lines.forEach(function (line) { box.appendChild(el(doc, 'div', 'vf-insert-error-line', line)); });
      showInsert([box]);
    }

    // Setup and review stay inert while the batch runs. Only controls that were live are
    // touched, so unlocking cannot enable one that was disabled for its own reason.
    function lockControls() {
      var locked = [];
      [setupEl, reviewEl].forEach(function (area) {
        var found = area.querySelectorAll('button, input, select');
        for (var i = 0; i < found.length; i++) {
          if (!found[i].disabled) { found[i].disabled = true; locked.push(found[i]); }
        }
        area.setAttribute('aria-busy', 'true');
      });
      return function unlock() {
        locked.forEach(function (c) { c.disabled = false; });
        [setupEl, reviewEl].forEach(function (area) { area.removeAttribute('aria-busy'); });
        if (app.session && app.session.review) { app.session.review.updateHeader(); }
      };
    }

    function insertButton() { return reviewEl.querySelector('.vf-review-insert'); }

    function showProgress(done, total) {
      var btn = insertButton();
      if (btn) { btn.textContent = Insert.progressText(done, total); }
    }

    // CSXS progress events: data is the JSON the host wrote, index is zero-based.
    var insertTotal = 0;
    function onInsertProgress(evt) {
      if (!inserting) { return; }
      try {
        var d = JSON.parse(evt.data);
        showProgress(d.index + 1, d.total || insertTotal);
      } catch (e) {
        // an unreadable event only loses one tick of the counter
      }
    }
    if (bridge.onEvent) { bridge.onEvent('com.versesync.progress', onInsertProgress); }

    function renderSummary(run, firstUndo) {
      var s = app.session;
      var placed = Insert.placedCount(run);
      var text = Insert.summaryText(placed, run.order.length);
      if (firstUndo) { text += ' ' + Insert.UNDO_NOTE; }
      var nodes = [el(doc, 'div', 'vf-insert-summary', text)];
      nodes[0].setAttribute('role', 'status');
      var failed = Insert.failedIds(run);
      if (failed.length > 0) {
        var details = el(doc, 'details', 'vf-insert-details');
        details.appendChild(el(doc, 'summary', 'vf-insert-details-title', 'Details'));
        var list = el(doc, 'ul', 'vf-insert-failures');
        failed.forEach(function (id) {
          var cue = s.model.get(id);
          list.appendChild(el(doc, 'li', 'vf-insert-failure',
            (cue ? cue.reference_display : id) + ' — ' + run.failures[id]));
        });
        details.appendChild(list);
        nodes.push(details);
        var retry = el(doc, 'button', 'vf-btn vf-btn--small vf-insert-retry', 'Retry failed');
        retry.type = 'button';
        retry.addEventListener('click', function () { startInsert(failed); });
        nodes.push(retry);
      }
      showInsert(nodes);
    }

    // The Insert click flow. retryIds is null for a whole batch, or the failed cue ids of the
    // current run for Retry failed. The review state is never touched.
    function startInsert(retryIds) {
      var s = app.session;
      if (inserting || !s) { return Promise.resolve(); }
      var ctx = {
        settings: setupState.get(),
        sequenceId: s.sequenceId,
        model: s.model,
        placements: s.mapping.placements
      };
      var stop = Insert.blockers(ctx);
      if (stop.length > 0) { insertError(stop); return Promise.resolve(); }
      var payload = Insert.buildPayload(s.model, s.mapping.placements, ctx);
      if (retryIds) { payload = Insert.onlyCues(payload, retryIds); }
      if (payload.cues.length === 0) {
        insertError(['None of the failed cues are still enabled.']);
        return Promise.resolve();
      }
      var run = retryIds && s.insertRun ? s.insertRun : Insert.newRun(payload);
      inserting = true;
      insertTotal = payload.cues.length;
      var unlock = lockControls();
      showInsert([]);
      showProgress(0, insertTotal);
      return Insert.execute({ bridge: bridge, payload: payload, confirm: confirmFn }).then(function (out) {
        inserting = false;
        unlock();
        if (out.state === 'error') { insertError([out.error]); return; }
        if (out.state === 'cancelled') { showInsert([]); return; }
        s.insertRun = Insert.recordResults(run, out.results);
        var firstUndo = !undoNoteShown && Insert.placedCount(s.insertRun) > 0;
        if (firstUndo) { undoNoteShown = true; }
        renderSummary(s.insertRun, firstUndo);
      }).then(null, function (e) {
        if (inserting) { inserting = false; unlock(); }
        insertError(['Unexpected error: ' + (e && e.message)]);
      });
    }

    // ---- Save, Load, Export (docs/09 §5.4) ------------------------------------------------

    function say(text, isError) {
      if (app.session && app.session.review) {
        app.session.review.setMessage(text, isError);
      } else if (loadNote && reviewEl.contains(loadNote)) {
        loadNote.textContent = text || '';
        loadNote.hidden = !text;
      }
    }

    // cep.fs answers { err: 0, data } and uses a non-zero err (or no data) for a cancelled dialog.
    function chooseSavePath(title, extension, defaultName) {
      if (!deps.fs || !deps.fs.showSaveDialog) { return null; }
      var res = deps.fs.showSaveDialog(title, null, [extension], defaultName);
      return res && res.err === 0 && res.data ? res.data : null;
    }

    function writeText(path, text) {
      var res = deps.fs.writeFile(path, text, 'utf8');
      return !!res && res.err === 0;
    }

    // The transcript sibling named by words_ref (D22): fetched from the sidecar for a job
    // result, read from the loaded file's directory for a loaded document. Resolves to the text
    // to write, or null when there is none.
    function transcriptText(s) {
      if (s.jobId && client) {
        return client.transcript(s.jobId).then(function (res) {
          return res && res.ok ? JSON.stringify(res.data) : null;
        });
      }
      if (s.loadedFrom) {
        var read = deps.fs.readFile(sibling(s.loadedFrom, s.model.toJSON().transcript.words_ref), 'utf8');
        return Promise.resolve(read && read.err === 0 ? read.data : null);
      }
      return Promise.resolve(null);
    }

    // The transcript words for the expanded rows: fetched once per document (the promise is kept
    // on the session), resolving to the word array or null when there is none.
    function loadTranscript(s) {
      if (!s.transcriptWords) {
        s.transcriptWords = Promise.resolve().then(function () {
          return transcriptText(s);
        }).then(function (text) {
          if (text === null) { return null; }
          var words = JSON.parse(text);
          return Array.isArray(words) ? words : null;
        }).catch(function () { return null; });
      }
      return s.transcriptWords;
    }

    function saveDocument() {
      var s = app.session;
      var path = chooseSavePath('Save cue document', 'json', 'cues.json');
      if (!path) { return Promise.resolve(); }
      if (!writeText(path, Cues.serialize(s.model))) {
        say('The cue document could not be saved.', true);
        return Promise.resolve();
      }
      var ref = sibling(path, s.model.toJSON().transcript.words_ref);
      return transcriptText(s).then(function (text) {
        if (text !== null && !writeText(ref, text)) {
          say('The cue document was saved, but its transcript could not be written.', true);
          return;
        }
        say('Saved ' + basename(path) + '.', false);
      });
    }

    function exportTxt() {
      var path = chooseSavePath('Export as VerseFlow .txt', 'txt', 'scriptures.txt');
      if (!path) { return; }
      if (writeText(path, Cues.exportVerseFlowTxt(app.session.model))) {
        say('Exported ' + basename(path) + '.', false);
      } else {
        say('The export could not be saved.', true);
      }
    }

    // Load trusts nothing positional: the file holds source seconds only, so the sequence and the
    // media placements are read afresh and the document is mapped against them.
    function loadDocument() {
      if (!deps.fs || !deps.fs.showOpenDialog) { return Promise.resolve(); }
      var picked = deps.fs.showOpenDialog(false, false, 'Load cue document', null, ['json']);
      if (!picked || picked.err !== 0 || !picked.data || !picked.data[0]) { return Promise.resolve(); }
      var path = picked.data[0];
      var read = deps.fs.readFile(path, 'utf8');
      if (!read || read.err !== 0) { say('That file could not be read.', true); return Promise.resolve(); }
      var loaded = Cues.load(read.data);
      if (!loaded.ok) { say(loaded.error, true); return Promise.resolve(); }
      var request = { media_path: loaded.model.toJSON().job.media_path };
      return place(loaded.model, request, null, loadDocument, path).then(function (mapping) {
        if (!mapping) { return; }
        renderReview(loaded.warning || null);
      }).then(null, function (e) {
        say('Unexpected error: ' + (e && e.message), true);
      });
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
    function place(model, request, jobId, retry, loadedFrom) {
      var again = retry || retryAnalyse;
      return bridge.call('getSequenceInfo', {}).then(function (info) {
        if (!info || !info.ok) {
          showProblem((info && info.error) || 'Could not read the sequence.', '', again);
          return null;
        }
        if (!info.data.hasActiveSequence) {
          showProblem('Open a sequence in Premiere first.', '', again);
          return null;
        }
        var seqInfo = info.data;
        return bridge.call('getMediaSegments', {
          mediaPath: request.media_path,
          sequenceId: seqInfo.sequenceId
        }).then(function (segs) {
          if (!segs || !segs.ok) {
            showProblem((segs && segs.error) || 'Could not read the media placements.', '',
              again);
            return null;
          }
          app.session = {
            jobId: jobId,
            loadedFrom: loadedFrom || null,
            request: request,
            sequenceId: seqInfo.sequenceId,
            seqInfo: seqInfo,
            segments: segs.data,
            model: model,
            manualOffsetTicks: null,
            mapping: null,
            review: null,
            insertRun: null,
            transcriptWords: null
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
        return place(loaded.model, request, jobId, retryAnalyse, null).then(function (mapping) {
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
      if (!client) {
        showProblem("Transcription service isn't ready.", '', retryAnalyse);
        return Promise.resolve();
      }
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
      }).then(null, function (e) {
        showProblem('Unexpected error: ' + (e && e.message), '', retryAnalyse);
      });
    };

    app.onCancel = function () {
      if (activeJobId && client) { client.cancel(activeJobId); }
    };

    app.remap = remap;

    app.setup = Setup.create({
      root: setupEl,
      state: setupState,
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
      }).then(null, function () {
        hasSequence = false;
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
