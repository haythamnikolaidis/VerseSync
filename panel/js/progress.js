(function (root) {
  'use strict';

  // Status strip and progress view (docs/09 §2, §4). statusLine is a pure function; view is a
  // thin renderer over an element tree it builds itself. The sidecar client is not touched
  // here: Cancel is reported through the injected onCancel.

  // The readout needs enough progress for the ETA to mean something (docs/09 §4: "after 10%").
  var ETA_MIN_PROGRESS = 0.1;

  var PHASE_LABELS = {
    hashing: 'Hashing…',
    transcribing: 'Transcribing…',
    detecting: 'Detecting…',
    resolving: 'Resolving…',
    timing: 'Timing…'
  };

  // Where a cache hit lands the bar. Transcribing (weight 0.80) is skipped and the remaining
  // weights are renormalised (docs/07 §4); 0.8 is a chosen point just past the old transcribing
  // share, so the bar visibly jumps to the resolving phase.
  var CACHE_HIT_PROGRESS = 0.8;

  var CACHE_HIT_TEXT = 'Using cached transcript';

  // lifecycleState is a VSSidecar lifecycle state; health is the /health body, or for the
  // unreachable state the log path the lifecycle reports as its detail.
  function statusLine(lifecycleState, health, hasSequence) {
    if (lifecycleState === 'starting') {
      return { icon: '◌', text: 'starting transcription service…' };
    }
    if (lifecycleState === 'unreachable' || lifecycleState === 'version_mismatch') {
      var details = typeof health === 'string' ? health :
        (health && (health.logPath || health.message)) || '';
      var line = { icon: '✕', text: 'transcription service unavailable' };
      if (details) { line.details = details; }
      return line;
    }
    if (!hasSequence) { return { icon: '▲', text: 'no sequence open' }; }
    var h = health && typeof health === 'object' ? health : {};
    if (lifecycleState === 'degraded') {
      if (h.device === 'cpu') { return { icon: '▲', text: 'ready (CPU only)' }; }
      if (h.provider && h.provider.reachable === false) {
        return { icon: '▲', text: 'ready (Bible API unreachable)' };
      }
      return { icon: '▲', text: 'ready (degraded)' };
    }
    var parts = ['ready'];
    if (h.device) { parts.push(h.device); }
    if (h.model_loaded) { parts.push(h.model_loaded); }
    return { icon: '●', text: parts.join(' · ') };
  }

  // Draws a statusLine result into el. Details sit behind a button so the strip stays one line.
  function renderStatus(el, line) {
    var doc = el.ownerDocument;
    while (el.firstChild) { el.removeChild(el.firstChild); }
    var icon = doc.createElement('span');
    icon.className = 'vf-status-icon';
    icon.textContent = line.icon;
    var text = doc.createElement('span');
    text.className = 'vf-status-text';
    text.textContent = ' ' + line.text;
    el.appendChild(icon);
    el.appendChild(text);
    el.classList.toggle('vf-status--error', line.icon === '✕');
    if (line.details) {
      var btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'vf-btn vf-btn--small vf-status-details-btn';
      btn.textContent = 'Details';
      var pre = doc.createElement('div');
      pre.className = 'vf-status-details';
      pre.textContent = line.details;
      pre.hidden = true;
      btn.addEventListener('click', function () { pre.hidden = !pre.hidden; });
      el.appendChild(btn);
      el.appendChild(pre);
    }
  }

  function clock(seconds) {
    var s = Math.max(0, Math.round(seconds));
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  function pct(p) {
    return Math.round(Math.min(1, Math.max(0, p)) * 100);
  }

  // opts: root (the #progress section), onCancel, and optionally setupRoot (the #setup section,
  // which collapses to a one-line summary while a job runs).
  function view(opts) {
    var rootEl = opts.root;
    var onCancel = opts.onCancel || function () {};
    var setupRoot = opts.setupRoot || null;
    var doc = rootEl.ownerDocument;

    while (rootEl.firstChild) { rootEl.removeChild(rootEl.firstChild); }
    var wrap = doc.createElement('div');
    wrap.className = 'vf-progress-wrap';
    var phase = doc.createElement('div');
    phase.className = 'vf-progress-phase';
    var bar = doc.createElement('div');
    bar.className = 'vf-progress-bar';
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    var fill = doc.createElement('div');
    fill.className = 'vf-progress-fill';
    bar.appendChild(fill);
    var readout = doc.createElement('div');
    readout.className = 'vf-progress-text';
    readout.hidden = true;
    var cache = doc.createElement('div');
    cache.className = 'vf-progress-cache';
    cache.hidden = true;
    var cancel = doc.createElement('button');
    cancel.type = 'button';
    cancel.className = 'vf-btn vf-btn--small vf-progress-cancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', function () { onCancel(); });
    wrap.appendChild(phase);
    wrap.appendChild(bar);
    wrap.appendChild(readout);
    wrap.appendChild(cache);
    wrap.appendChild(cancel);
    rootEl.appendChild(wrap);
    rootEl.hidden = true;

    var summary = null;
    if (setupRoot) {
      summary = doc.createElement('button');
      summary.type = 'button';
      summary.className = 'vf-setup-summary';
      summary.hidden = true;
      summary.setAttribute('aria-expanded', 'false');
      setupRoot.parentNode.insertBefore(summary, setupRoot);
      summary.addEventListener('click', function () {
        var open = setupRoot.hidden;
        setupRoot.hidden = !open;
        summary.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    }

    function setBar(p) {
      var n = pct(p);
      fill.style.width = n + '%';
      bar.setAttribute('aria-valuenow', String(n));
    }

    return {
      // Called when a job starts; the summary line stands in for the collapsed setup.
      begin: function (summaryText) {
        setBar(0);
        phase.textContent = '';
        readout.hidden = true;
        cache.hidden = true;
        rootEl.hidden = false;
        if (summary) {
          summary.textContent = summaryText || 'Setup';
          summary.hidden = false;
          setupRoot.hidden = true;
          summary.setAttribute('aria-expanded', 'false');
        }
      },
      update: function (ev) {
        var p = typeof ev.progress === 'number' ? ev.progress : 0;
        rootEl.hidden = false;
        phase.textContent = PHASE_LABELS[ev.phase] || '';
        setBar(p);
        if (p > ETA_MIN_PROGRESS) {
          var text = 'elapsed ' + clock(ev.elapsed_s || 0);
          if (typeof ev.eta_s === 'number') { text += ' · about ' + clock(ev.eta_s) + ' left'; }
          readout.textContent = text;
          readout.hidden = false;
        } else {
          readout.hidden = true;
        }
      },
      cacheHit: function () {
        rootEl.hidden = false;
        cache.textContent = CACHE_HIT_TEXT;
        cache.hidden = false;
        phase.textContent = PHASE_LABELS.resolving;
        setBar(CACHE_HIT_PROGRESS);
      },
      // The job finished: the bar goes away and the one-line setup summary stays.
      done: function () {
        rootEl.hidden = true;
        readout.hidden = true;
        cache.hidden = true;
      }
    };
  }

  var Progress = {
    statusLine: statusLine,
    renderStatus: renderStatus,
    view: view,
    PHASE_LABELS: PHASE_LABELS
  };

  if (typeof module !== 'undefined' && module.exports) { module.exports = Progress; }
  // Always set the global too (see bridge.js): CEP's mixed-context leaks `module` into the
  // browser window, so this can't be an else-branch without breaking Premiere.
  root.VSProgress = Progress;
})(this);
