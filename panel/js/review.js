(function (root) {
  'use strict';

  // Review list (docs/09 §5). rowViewModel is pure; create renders the collapsed rows.

  // Flag table from docs/09 §5.2: colour class suffix and the text label shown beside it, so a
  // flag never relies on colour alone (docs/09 §8).
  var FLAGS = {
    low_confidence: { color: 'amber', label: 'low confidence' },
    overlap: { color: 'amber', label: 'overlap' },
    truncated: { color: 'grey', label: 'truncated' },
    long_passage: { color: 'amber', label: 'long passage' },
    text_unavailable: { color: 'red', label: 'text unavailable' },
    passage_not_found: { color: 'red', label: 'passage not found' },
    chapter_only: { color: 'amber', label: 'chapter only' },
    suppressed_duplicate: { color: 'grey', label: 'duplicate' },
    cut_from_edit: { color: 'grey', label: 'cut from edit' },
    multiple_placements: { color: 'amber', label: 'multiple placements' },
    speed_change_unsupported: { color: 'red', label: 'speed change' }
  };

  var NO_TIMECODE = '--:--:--:--';

  // Flags a successful re-resolve clears: the new text exists, so these no longer apply
  // (docs/09 §5.3).
  var RESOLVED_FLAGS = ['text_unavailable', 'passage_not_found', 'chapter_only'];

  // The exact empty-state texts of docs/09 §7.
  var IDLE_TEXT = 'Select a media file and click Analyse.';
  var EMPTY_TEXT = 'No scripture references found. Check the audio has speech, or try a larger model.';
  var INSERT_HINT = 'Enable at least one scripture to insert.';
  var RETRY_TEXT_LABEL = 'Retry text fetch';
  var PROVIDER_DOWN_TEXT = 'The Bible text could not be fetched for some cues.';

  var NO_TEXT_SERVICE = 'The text service is not running, so references cannot be re-resolved.';

  function loadModule(name, file) {
    if (root[name]) { return root[name]; }
    return typeof require !== 'undefined' ? require(file) : undefined;
  }

  // Words that can follow a book name inside a spoken reference ("six, nineteen and twenty",
  // "8, 28", "verses 1 through 4"). Chosen so the emphasised span covers the whole mention.
  var REF_WORD = /^(\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|and|through|to|verse|verses|chapter|uh|um)$/i;

  function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  // Splits the snippet around the matched mention. The sidecar sends no offsets, so the span is
  // found from the reference's book name plus the number words that follow it. When the book is
  // not spoken verbatim (fuzzy match), the whole snippet is returned unmarked.
  function splitSnippet(snippet, cue) {
    var text = snippet || '';
    var book = cue.reference && cue.reference.book ? String(cue.reference.book) : '';
    var name = book.replace(/^\d+\s+/, '').split(/\s+/).pop();
    if (!name) { return { before: text, match: '', after: '' }; }
    var m = new RegExp('\\b' + escapeRegExp(name) + '\\b', 'i').exec(text);
    if (!m) { return { before: text, match: '', after: '' }; }
    var start = m.index;
    var end = m.index + m[0].length;
    var rest = /^(?:[\s,.:\-–—]+([A-Za-z0-9]+))/;
    for (;;) {
      var next = rest.exec(text.slice(end));
      if (!next || !REF_WORD.test(next[1])) { break; }
      end += next[0].length;
    }
    // A leading spoken ordinal ("First Corinthians") belongs to the mention.
    var lead = /(first|second|third|1st|2nd|3rd)\s+$/i.exec(text.slice(0, start));
    if (lead) { start -= lead[0].length; }
    return { before: text.slice(0, start), match: text.slice(start, end), after: text.slice(end) };
  }

  function uniqueFlags(cue, placement) {
    var seen = {};
    var out = [];
    var all = (cue.flags || []).concat((placement && placement.panelFlags) || []);
    for (var i = 0; i < all.length; i++) {
      if (!seen[all[i]]) { seen[all[i]] = true; out.push(all[i]); }
    }
    return out;
  }

  // cue: a Cue Document cue; placement: one VSTimemap.mapCueDocument placement (or undefined);
  // threshold: the confidence threshold (0.55 by default, docs/09 §5.1).
  function rowViewModel(cue, placement, threshold) {
    var limit = typeof threshold === 'number' ? threshold : 0.55;
    var placed = !!(placement && placement.timecode);
    var flags = uniqueFlags(cue, placement).map(function (flag) {
      var def = FLAGS[flag] || { color: 'grey', label: flag.replace(/_/g, ' ') };
      return { flag: flag, color: def.color, label: def.label };
    });
    return {
      id: cue.id,
      enabled: !!cue.enabled,
      placed: placed,
      timecode: placed ? placement.timecode : NO_TIMECODE,
      reference: cue.reference_display,
      badge: cue.classification === 'read' ? 'READ' : 'PARAPHRASE',
      confidence: {
        text: Math.round(cue.confidence * 100) + '%',
        amber: cue.confidence < limit
      },
      duration: cue.source_duration_s.toFixed(1) + 's',
      snippet: splitSnippet(cue.snippet, cue),
      flags: flags
    };
  }

  // Words shown either side of the matched span in the transcript context (docs/09 §5.3).
  var CONTEXT_WORDS = 15;

  var CONTEXT_MISSING = 'Transcript not available for this document.';

  // Pure view model of the transcript context. words is the transcript array
  // ([{text,start,end}]); a cue with no detection block (manual) or a word_span outside the
  // transcript has no context (null). The matched span is word_span (inclusive); a word is in
  // the read span when its midpoint falls inside read_start_s..read_end_s.
  function contextViewModel(cue, words) {
    if (!cue.detection || !words || !cue.detection.word_span) { return null; }
    var first = cue.detection.word_span[0];
    var last = cue.detection.word_span[1];
    if (first < 0 || last >= words.length || last < first) { return null; }
    var hasRead = cue.classification === 'read' &&
      typeof cue.read_start_s === 'number' && typeof cue.read_end_s === 'number';
    var from = Math.max(0, first - CONTEXT_WORDS);
    var to = Math.min(words.length - 1, last + CONTEXT_WORDS);
    var out = [];
    for (var i = from; i <= to; i++) {
      var w = words[i];
      var mid = (w.start + w.end) / 2;
      out.push({
        text: w.text,
        match: i >= first && i <= last,
        read: hasRead && mid >= cue.read_start_s && mid <= cue.read_end_s
      });
    }
    return out;
  }

  // The cue fields a successful resolve replaces (docs/09 §5.3). passage is the sidecar's
  // Passage, reference the canonical reference object (from the editor's choice or parsed from the
  // passage). timing is { durationMode } - the paraphrase duration is recomputed only in auto mode,
  // because a fixed duration is the editor's own choice. Pure; the caller applies it with
  // model.edit, which also marks the cue edited.
  function resolvePatch(cue, reference, passage, timing) {
    var Duration = loadModule('VSDuration', './duration.js');
    var patch = {
      reference: reference,
      reference_display: passage.reference_display,
      body: passage.body,
      body_word_count: passage.word_count,
      body_truncated: !!passage.truncated,
      flags: (cue.flags || []).filter(function (f) { return RESOLVED_FLAGS.indexOf(f) === -1; })
    };
    var auto = !timing || timing.durationMode !== 'fixed';
    if (auto && cue.classification === 'paraphrase') {
      patch.source_duration_s = Duration.resolveDurationSeconds({ wordCount: passage.word_count }, null);
    }
    return patch;
  }

  // The editable reference text: the display without its "(KJV)" suffix.
  function referenceText(cue) {
    return String(cue.reference_display).replace(/\s*\([^)]*\)\s*$/, '');
  }

  function classificationLine(cue) {
    if (cue.classification !== 'read') { return 'PARAPHRASE'; }
    var cov = typeof cue.read_coverage === 'number' ? ' (coverage ' + cue.read_coverage.toFixed(2) + ')' : '';
    return 'READ' + cov;
  }

  function el(doc, tag, cls, text) {
    var node = doc.createElement(tag);
    if (cls) { node.className = cls; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }

  function buildRow(doc, vm) {
    var row = el(doc, 'div', 'row');
    row.setAttribute('data-cue-id', vm.id);

    var line1 = el(doc, 'div', 'vf-row-main');
    var box = el(doc, 'input', 'vf-row-check');
    box.type = 'checkbox';
    box.setAttribute('aria-label', 'Enable ' + vm.reference);
    var tc = el(doc, 'button', 'vf-row-timecode', vm.timecode);
    tc.type = 'button';
    tc.disabled = !vm.placed;
    tc.title = 'Move the playhead here';
    var ref = el(doc, 'span', 'vf-row-reference', vm.reference);
    var flags = el(doc, 'span', 'vf-row-flags');
    line1.appendChild(box);
    line1.appendChild(tc);
    line1.appendChild(ref);
    line1.appendChild(flags);

    var line2 = el(doc, 'div', 'vf-row-meta');
    line2.appendChild(el(doc, 'span', 'vf-row-badge', vm.badge));
    line2.appendChild(el(doc, 'span', 'vf-row-sep', ' \u00B7 '));
    line2.appendChild(el(doc, 'span', 'vf-row-confidence' + (vm.confidence.amber ? ' vf-flag--amber' : ''),
      vm.confidence.text));
    line2.appendChild(el(doc, 'span', 'vf-row-sep', ' \u00B7 '));
    line2.appendChild(el(doc, 'span', 'vf-row-duration', vm.duration));

    var snip = el(doc, 'div', 'vf-row-snippet');
    snip.appendChild(doc.createTextNode(vm.snippet.before));
    if (vm.snippet.match) { snip.appendChild(el(doc, 'mark', 'vf-row-match', vm.snippet.match)); }
    snip.appendChild(doc.createTextNode(vm.snippet.after));

    row.appendChild(line1);
    row.appendChild(line2);
    row.appendChild(snip);
    return row;
  }

  function renderContext(doc, holder, words) {
    var vm = contextViewModel(holder.cue, words);
    holder = holder.node;
    while (holder.firstChild) { holder.removeChild(holder.firstChild); }
    if (!vm) { holder.appendChild(el(doc, 'div', 'vf-hint vf-ctx-missing', CONTEXT_MISSING)); return; }
    var line = el(doc, 'div', 'vf-ctx-text');
    vm.forEach(function (w, i) {
      if (i > 0) { line.appendChild(doc.createTextNode(' ')); }
      if (w.match && (i === 0 || !vm[i - 1].match)) { line.appendChild(el(doc, 'span', 'vf-ctx-arrow', '\u25B8')); }
      var cls = 'vf-ctx-word' + (w.match ? ' vf-ctx-match' : '') + (w.read ? ' vf-ctx-read' : '');
      line.appendChild(el(doc, 'span', cls, w.text));
      if (w.match && (i === vm.length - 1 || !vm[i + 1].match)) { line.appendChild(el(doc, 'span', 'vf-ctx-arrow', '\u25C2')); }
    });
    holder.appendChild(line);
  }

  // The expanded part of a row: reference, verse text (read-only), transcript context and the
  // classification line. getTranscript() resolves to the word array or null.
  // editor: { reason() -> string|null (why editing is off), resolve(text), choose(alternative),
  // timecode, timing, setDuration(text), remove() }.
  function buildDetail(doc, cue, getTranscript, editor) {
    var box = el(doc, 'div', 'vf-row-detail');
    var refLine = el(doc, 'div', 'vf-detail-reference');
    refLine.appendChild(el(doc, 'span', 'vf-detail-label', 'Reference '));
    var input = el(doc, 'input', 'vf-detail-reference-input');
    input.type = 'text';
    input.value = referenceText(cue);
    input.setAttribute('aria-label', 'Reference');
    var redo = el(doc, 'button', 'vf-btn vf-btn--small vf-detail-resolve', '\u21BB');
    redo.type = 'button';
    redo.title = 'Look up this reference';
    redo.setAttribute('aria-label', 'Re-resolve reference');
    refLine.appendChild(input);
    refLine.appendChild(redo);
    box.appendChild(refLine);
    var refError = el(doc, 'div', 'vf-inline-error vf-detail-reference-error');
    refError.setAttribute('role', 'alert');
    refError.hidden = true;
    box.appendChild(refError);

    var alts = [];
    (cue.alternatives || []).forEach(function (alt) {
      var b = el(doc, 'button', 'vf-btn vf-btn--small vf-detail-alternative',
        alt.reference_display + ' \u00B7 ' + Math.round(alt.confidence * 100) + '%');
      b.type = 'button';
      b.title = alt.reason || '';
      b.addEventListener('click', function () { run(alt); });
      alts.push(b);
    });
    if (alts.length > 0) {
      var altLine = el(doc, 'div', 'vf-detail-alternatives');
      altLine.appendChild(el(doc, 'span', 'vf-detail-label', 'Or '));
      alts.forEach(function (b) { altLine.appendChild(b); });
      box.appendChild(altLine);
    }

    var places = editor.placements;
    if (places && places.alternatives.length > 0) {
      var placeLine = el(doc, 'div', 'vf-detail-placements');
      placeLine.appendChild(el(doc, 'span', 'vf-detail-label', 'Also placed at '));
      places.alternatives.forEach(function (alt) {
        var b = el(doc, 'button', 'vf-btn vf-btn--small vf-detail-placement', alt.timecode);
        b.type = 'button';
        b.title = 'Use this placement';
        b.addEventListener('click', function () { places.choose(alt.ticks); });
        placeLine.appendChild(b);
      });
      box.appendChild(placeLine);
    }

    var busy = false;
    function sync() {
      var reason = editor.reason();
      var off = busy || !!reason;
      input.disabled = !!reason;
      redo.disabled = off;
      alts.forEach(function (b) { b.disabled = off; });
      if (reason) { show(reason); }
    }
    function show(text) {
      refError.textContent = text || '';
      refError.hidden = !text;
    }
    // The row is rebuilt after a successful edit, so only a failure has anything to update here.
    function run(alt) {
      if (busy) { return; }
      busy = true;
      show('');
      sync();
      var started = alt ? editor.choose(alt) : editor.resolve(input.value);
      started.then(function (message) {
        busy = false;
        if (message) { show(message); }
        sync();
      });
    }
    redo.addEventListener('click', function () { run(null); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); run(null); }
    });
    sync();

    var verse = el(doc, 'div', 'vf-detail-verse');
    verse.appendChild(el(doc, 'span', 'vf-detail-body', cue.body));
    if ((cue.flags || []).indexOf('long_passage') !== -1) {
      verse.appendChild(el(doc, 'span', 'vf-detail-truncated',
        ' \u2026 (long passage: the text ends here)'));
    }
    box.appendChild(verse);

    if (cue.detection) {
      box.appendChild(el(doc, 'div', 'vf-detail-label', 'Transcript context'));
      var ctx = el(doc, 'div', 'vf-detail-context');
      box.appendChild(ctx);
      Promise.resolve(getTranscript ? getTranscript() : null).then(function (words) {
        renderContext(doc, { cue: cue, node: ctx }, words);
      }, function () {
        renderContext(doc, { cue: cue, node: ctx }, null);
      });
    }

    box.appendChild(buildTiming(doc, cue, editor));

    var cls = el(doc, 'div', 'vf-detail-classification');
    cls.appendChild(el(doc, 'span', 'vf-detail-label', 'Classification '));
    cls.appendChild(el(doc, 'span', 'vf-detail-value', classificationLine(cue)));
    box.appendChild(cls);

    var del = el(doc, 'button', 'vf-btn vf-btn--small vf-detail-delete', 'Delete');
    del.type = 'button';
    del.addEventListener('click', function () { editor.remove(); });
    box.appendChild(del);
    return box;
  }

  // The Timing row of the expanded row (docs/09 §5.3): anchor timecode, frame nudges, set to the
  // playhead, and the duration override. editor.timing is null when the panel cannot read the
  // sequence, which leaves the anchor controls disabled.
  function buildTiming(doc, cue, editor) {
    var box = el(doc, 'div', 'vf-detail-timing');
    var anchorLine = el(doc, 'div', 'vf-detail-anchor');
    anchorLine.appendChild(el(doc, 'span', 'vf-detail-label', 'Timing '));
    anchorLine.appendChild(el(doc, 'span', 'vf-detail-anchor-value',
      'anchor ' + (editor.timecode || NO_TIMECODE) + ' '));
    var live = !!editor.timing && !!editor.timecode;
    function timingButton(cls, text, label, run) {
      var b = el(doc, 'button', 'vf-btn vf-btn--small ' + cls, text);
      b.type = 'button';
      b.setAttribute('aria-label', label);
      b.addEventListener('click', function () { run(b); });
      anchorLine.appendChild(b);
      return b;
    }
    var error = el(doc, 'div', 'vf-inline-error vf-detail-timing-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    function show(text) {
      error.textContent = text || '';
      error.hidden = !text;
    }
    function done(promise) {
      show('');
      Promise.resolve(promise).then(function (text) { if (text) { show(text); } });
    }
    var back = timingButton('vf-detail-nudge-back', '-1f', 'Move one frame earlier',
      function () { done(editor.timing.nudge(-1)); });
    var fwd = timingButton('vf-detail-nudge-forward', '+1f', 'Move one frame later',
      function () { done(editor.timing.nudge(1)); });
    var head = timingButton('vf-detail-playhead', '\u2316', 'Set the anchor to the playhead',
      function () { done(editor.timing.toPlayhead()); });
    back.disabled = !live;
    fwd.disabled = !live;
    head.disabled = !editor.timing;
    box.appendChild(anchorLine);

    var durLine = el(doc, 'div', 'vf-detail-duration');
    durLine.appendChild(el(doc, 'span', 'vf-detail-label', 'Duration '));
    var dur = el(doc, 'input', 'vf-detail-duration-input');
    dur.type = 'text';
    dur.value = cue.source_duration_s.toFixed(1);
    dur.setAttribute('aria-label', 'Duration in seconds');
    durLine.appendChild(dur);
    durLine.appendChild(el(doc, 'span', 'vf-detail-unit', ' s'));
    if (cue.classification === 'read' && typeof cue.read_coverage === 'number') {
      durLine.appendChild(el(doc, 'span', 'vf-detail-read', '  read ' + Math.round(cue.read_coverage * 100) + '%'));
    }
    function commit() {
      show('');
      var text = editor.setDuration(dur.value);
      if (text) { show(text); }
    }
    dur.addEventListener('change', commit);
    dur.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
    });
    box.appendChild(durLine);
    box.appendChild(error);
    return box;
  }

  // Applies the parts of a view model that change when a cue is toggled or re-flagged.
  function updateRow(doc, row, vm) {
    row.className = 'row' + (vm.enabled ? '' : ' vf-row--disabled') +
      (row.querySelector('.vf-row-detail') ? ' vf-row--expanded' : '');
    row.querySelector('.vf-row-timecode').textContent = vm.timecode;
    row.querySelector('.vf-row-timecode').disabled = !vm.placed;
    row.querySelector('.vf-row-check').checked = vm.enabled;
    var holder = row.querySelector('.vf-row-flags');
    while (holder.firstChild) { holder.removeChild(holder.firstChild); }
    vm.flags.forEach(function (f) {
      holder.appendChild(el(doc, 'span', 'vf-flag vf-flag--' + f.color + ' vf-flag-' + f.flag,
        '\u2691 ' + f.label));
    });
  }

  // opts: { root, model, getPlacements, bridge, threshold, client, getTranslationId, getDurationMode,
  // isAvailable, timing, timecodeOf, onChoosePlacement, onTranscript, onChange, onSave, onLoad, onExport, onInsert }. client.resolve edits a cue's
  // reference; onChange(id) runs after each edit so the caller re-maps before the list redraws.
  // getPlacements() returns the VSTimemap.mapCueDocument placements map. bridge moves the playhead
  // (the timecode button); getTranscript() resolves to the transcript words or null. The on* callbacks run the Save menu entries and the Insert button.
  function create(opts) {
    var container = opts.root;
    var doc = container.ownerDocument;
    var model = opts.model;
    var threshold = opts.threshold;
    var rows = {};

    var flaggedOnly = false;

    var header = el(doc, 'div', 'vf-review-header');
    var title = el(doc, 'div', 'vf-review-title');
    var toolbar = el(doc, 'div', 'vf-review-actions');
    var message = el(doc, 'div', 'vf-review-message');
    message.setAttribute('role', 'status');
    message.hidden = true;
    var list = el(doc, 'div', 'vf-review-list');

    function button(cls, text) {
      var b = el(doc, 'button', 'vf-btn vf-btn--small ' + cls, text);
      b.type = 'button';
      return b;
    }

    var allBtn = button('vf-review-all', 'All');
    var noneBtn = button('vf-review-none', 'None');
    var flaggedBtn = button('vf-review-flagged', 'Flagged only');
    flaggedBtn.setAttribute('aria-pressed', 'false');
    var saveBtn = button('vf-review-save', 'Save \u25BE');
    saveBtn.setAttribute('aria-haspopup', 'true');
    saveBtn.setAttribute('aria-expanded', 'false');
    var menu = el(doc, 'div', 'vf-review-menu');
    menu.hidden = true;
    var menuItems = [
      { cls: 'vf-review-save-doc', text: 'Save cue document', run: 'onSave' },
      { cls: 'vf-review-load-doc', text: 'Load cue document', run: 'onLoad' },
      { cls: 'vf-review-export-txt', text: 'Export as VerseFlow .txt', run: 'onExport' }
    ];
    var saveWrap = el(doc, 'span', 'vf-review-save-wrap');
    saveWrap.appendChild(saveBtn);
    saveWrap.appendChild(menu);
    var insertBtn = button('vf-btn--accent vf-review-insert', 'Insert');
    var insertHint = el(doc, 'div', 'vf-hint vf-review-insert-hint', INSERT_HINT);
    var addBtn = button('vf-review-add', 'Add cue');
    var addForm = el(doc, 'div', 'vf-review-add-form');
    addForm.hidden = true;
    var addInput = el(doc, 'input', 'vf-review-add-input');
    addInput.type = 'text';
    addInput.placeholder = 'Reference, e.g. John 3:16';
    addInput.setAttribute('aria-label', 'Reference for the new cue');
    var addGo = button('vf-review-add-go', 'Add at playhead');
    addForm.appendChild(addInput);
    addForm.appendChild(addGo);
    var addError = el(doc, 'div', 'vf-inline-error vf-review-add-error');
    addError.setAttribute('role', 'alert');
    addError.hidden = true;
    var banner = el(doc, 'div', 'vf-warning vf-review-banner');
    banner.setAttribute('role', 'status');
    banner.hidden = true;
    var bannerText = el(doc, 'span', 'vf-review-banner-text', PROVIDER_DOWN_TEXT + ' ');
    var retryBtn = button('vf-review-retry-text', RETRY_TEXT_LABEL);
    banner.appendChild(bannerText);
    banner.appendChild(retryBtn);
    var emptyNote = el(doc, 'div', 'vf-hint vf-review-empty', EMPTY_TEXT);
    emptyNote.hidden = true;
    var transcriptLink = el(doc, 'button', 'vf-link vf-review-transcript-link', 'Open the transcript');
    transcriptLink.type = 'button';
    transcriptLink.addEventListener('click', function () { if (opts.onTranscript) { opts.onTranscript(); } });
    emptyNote.appendChild(doc.createTextNode(' '));
    emptyNote.appendChild(transcriptLink);

    [allBtn, noneBtn, flaggedBtn, addBtn, saveWrap, insertBtn].forEach(function (n) { toolbar.appendChild(n); });
    header.appendChild(title);
    header.appendChild(toolbar);
    header.appendChild(insertHint);
    header.appendChild(addForm);
    header.appendChild(addError);
    container.appendChild(header);
    container.appendChild(banner);
    container.appendChild(emptyNote);
    container.appendChild(message);
    container.appendChild(list);

    function placementOf(id) {
      var all = opts.getPlacements ? opts.getPlacements() : null;
      return all ? all[id] : undefined;
    }

    function flaggedCount(cues) {
      var n = 0;
      cues.forEach(function (cue) {
        if (rowViewModel(cue, placementOf(cue.id), threshold).flags.length > 0) { n++; }
      });
      return n;
    }

    function updateHeader() {
      var cues = model.cues();
      var enabled = model.enabledCount();
      title.textContent = 'REVIEW \u2014 ' + cues.length + ' found \u00B7 ' +
        enabled + ' enabled [\u2691 ' + flaggedCount(cues) + ']';
      insertBtn.textContent = 'Insert ' + enabled + (enabled === 1 ? ' scripture' : ' scriptures');
      insertBtn.disabled = enabled === 0;
      // With no cues at all the empty note speaks instead, so the hint only covers "all off".
      insertHint.hidden = enabled !== 0 || cues.length === 0;
      emptyNote.hidden = cues.length !== 0;
      transcriptLink.hidden = !opts.onTranscript;
      banner.hidden = !cues.some(function (cue) {
        return (cue.flags || []).indexOf('text_unavailable') !== -1;
      });
    }

    // "Flagged only" hides the rows that carry no flag (docs/09 §5.4).
    function applyFilter() {
      Object.keys(rows).forEach(function (id) {
        var hasFlags = rowViewModel(model.get(id), placementOf(id), threshold).flags.length > 0;
        rows[id].hidden = flaggedOnly && !hasFlags;
      });
    }

    // Status text above the list (a failed save or load); '' clears it.
    function setMessage(text, isError) {
      message.textContent = text || '';
      message.className = 'vf-review-message' + (isError ? ' vf-inline-error' : ' vf-hint');
      message.hidden = !text;
    }

    function setAll(enabled) {
      model.cues().forEach(function (cue) { model.setEnabled(cue.id, enabled); });
      Object.keys(rows).forEach(refreshRow);
      updateHeader();
    }

    function closeMenu() {
      menu.hidden = true;
      saveBtn.setAttribute('aria-expanded', 'false');
    }

    allBtn.addEventListener('click', function () { setAll(true); });
    noneBtn.addEventListener('click', function () { setAll(false); });
    flaggedBtn.addEventListener('click', function () {
      flaggedOnly = !flaggedOnly;
      flaggedBtn.setAttribute('aria-pressed', flaggedOnly ? 'true' : 'false');
      flaggedBtn.classList.toggle('vf-btn--active', flaggedOnly);
      applyFilter();
    });
    saveBtn.addEventListener('click', function () {
      menu.hidden = !menu.hidden;
      saveBtn.setAttribute('aria-expanded', menu.hidden ? 'false' : 'true');
    });
    menuItems.forEach(function (item) {
      var b = el(doc, 'button', 'vf-review-menu-item ' + item.cls, item.text);
      b.type = 'button';
      b.addEventListener('click', function () {
        closeMenu();
        if (opts[item.run]) { opts[item.run](); }
      });
      menu.appendChild(b);
    });
    insertBtn.addEventListener('click', function () { if (opts.onInsert) { opts.onInsert(); } });

    function sorted(cues) {
      var items = cues.map(function (cue, i) {
        var p = placementOf(cue.id);
        var placed = !!(p && p.timecode);
        return { cue: cue, index: i, placed: placed, ticks: placed ? Number(p.atTicks) : 0 };
      });
      items.sort(function (a, b) {
        if (a.placed !== b.placed) { return a.placed ? -1 : 1; }
        if (a.ticks !== b.ticks) { return a.ticks - b.ticks; }
        return a.index - b.index;
      });
      return items;
    }

    function refreshRow(id) {
      var vm = rowViewModel(model.get(id), placementOf(id), threshold);
      updateRow(doc, rows[id], vm);
      rows[id].hidden = flaggedOnly && vm.flags.length === 0;
      return vm;
    }

    // Clicking the row body expands or collapses it; the checkbox and the timecode keep their
    // own behaviour.
    function toggleExpanded(id) {
      var row = rows[id];
      var open = row.querySelector('.vf-row-detail');
      if (open) {
        row.removeChild(open);
        row.classList.remove('vf-row--expanded');
        return;
      }
      row.appendChild(buildDetail(doc, model.get(id), opts.getTranscript, editorFor(id)));
      row.classList.add('vf-row--expanded');
    }

    // Why reference editing is off, or null. Once a call finds the sidecar unreachable the
    // reason sticks, so every row says so without another failed request.
    var textServiceDown = null;
    function editingOff() {
      if (textServiceDown) { return textServiceDown; }
      if (!opts.client) { return NO_TEXT_SERVICE; }
      if (opts.isAvailable && !opts.isAvailable()) { return NO_TEXT_SERVICE; }
      return null;
    }

    // Resolves one reference for a cue. Success edits the cue, re-maps, and rebuilds the list
    // (the cue may move) with the row still open; the promise then yields ''. Failure yields the
    // message to show inline and leaves the cue unchanged.
    function resolveCue(id, request, fallbackReference, batch) {
      var translationId = opts.getTranslationId ? opts.getTranslationId() : null;
      return opts.client.resolve(request, translationId).then(function (res) {
        if (!res.ok) {
          if (res.error && res.error.code === 'unreachable') { textServiceDown = res.error.message; }
          return (res.error && res.error.message) || 'Could not look up that reference.';
        }
        var reference = fallbackReference || res.data.reference ||
          referenceFromDisplay(res.data.reference_display);
        if (!reference) { return 'Could not read the reference the text service returned.'; }
        var cue = model.get(id);
        try {
          model.edit(id, resolvePatch(cue, reference, res.data,
            { durationMode: opts.getDurationMode ? opts.getDurationMode() : 'auto' }));
        } catch (e) {
          return e.message;
        }
        if (opts.onChange) { opts.onChange(id); }
        if (batch) { return ''; }
        render();
        toggleExpanded(id);
        return '';
      });
    }

    // Re-resolves every cue the provider could not supply text for, one at a time, then redraws
    // once. Stops at the first failure so a dead provider costs one request, not one per cue.
    function retryTextFetch() {
      var ids = model.cues().filter(function (cue) {
        return (cue.flags || []).indexOf('text_unavailable') !== -1;
      }).map(function (cue) { return cue.id; });
      if (editingOff()) { setMessage(editingOff(), true); return Promise.resolve(); }
      retryBtn.disabled = true;
      setMessage('', false);
      var failure = '';
      var chain = Promise.resolve();
      ids.forEach(function (id) {
        chain = chain.then(function () {
          if (failure) { return undefined; }
          return resolveCue(id, model.get(id).reference, model.get(id).reference, true)
            .then(function (text) { failure = text; });
        });
      });
      return chain.then(function () {
        retryBtn.disabled = false;
        render();
        if (failure) { setMessage(failure, true); }
      });
    }
    retryBtn.addEventListener('click', function () { retryTextFetch(); });

    // Add cue (docs/09 §5.4): the typed reference at the current playhead. Origin manual,
    // confidence 1.0. The duration is the paraphrase default for the verse's length.
    var NO_ADD_PLAYHEAD = 'Move the playhead over the media first.';
    function showAddError(text) {
      addError.textContent = text || '';
      addError.hidden = !text;
    }
    function addCue() {
      var Duration = loadModule('VSDuration', './duration.js');
      var text = addInput.value.trim();
      showAddError('');
      var off = editingOff();
      if (off) { showAddError(off); return Promise.resolve(); }
      if (text === '') { showAddError('Type a reference first.'); return Promise.resolve(); }
      if (!opts.timing) { showAddError(NO_ADD_PLAYHEAD); return Promise.resolve(); }
      addGo.disabled = true;
      return Promise.resolve().then(function () { return opts.timing.playheadSource(); })
        .then(function (seconds) {
          if (seconds === null || seconds === undefined) { return NO_ADD_PLAYHEAD; }
          var translationId = opts.getTranslationId ? opts.getTranslationId() : null;
          return opts.client.resolve(text, translationId).then(function (res) {
            if (!res.ok) {
              if (res.error && res.error.code === 'unreachable') { textServiceDown = res.error.message; }
              return (res.error && res.error.message) || 'Could not look up that reference.';
            }
            var reference = res.data.reference || referenceFromDisplay(res.data.reference_display);
            if (!reference) { return 'Could not read the reference the text service returned.'; }
            try {
              model.addManual({
                reference: reference,
                reference_display: res.data.reference_display,
                body: res.data.body,
                body_word_count: res.data.word_count,
                source_anchor_s: seconds,
                source_duration_s: Duration.resolveDurationSeconds({ wordCount: res.data.word_count }, null)
              });
            } catch (e) {
              return e.message;
            }
            addInput.value = '';
            addForm.hidden = true;
            return '';
          });
        }, function () { return NO_ADD_PLAYHEAD; })
        .then(function (failure) {
          addGo.disabled = false;
          if (failure) { showAddError(failure); return; }
          if (opts.onChange) { opts.onChange(null); }
          render();
        });
    }
    addBtn.addEventListener('click', function () {
      addForm.hidden = !addForm.hidden;
      showAddError('');
      if (!addForm.hidden) { addInput.focus(); }
    });
    addGo.addEventListener('click', function () { addCue(); });
    addInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); addCue(); }
    });

    function referenceFromDisplay(display) {
      var Cues = loadModule('VSCues', './cues.js');
      return Cues.referenceFromDisplay(display);
    }

    // After a timing edit: re-map the whole list (so the overlap sweep runs again), redraw in the
    // new order and keep the row open.
    function afterTiming(id) {
      if (opts.onChange) { opts.onChange(id); }
      render();
      toggleExpanded(id);
    }

    // Stores a new anchor, in source seconds. Yields '' on success or the message to show.
    function setAnchor(id, seconds) {
      if (seconds === null || seconds === undefined) { return null; }
      try {
        model.edit(id, { source_anchor_s: seconds });
      } catch (e) {
        return e.message;
      }
      afterTiming(id);
      return '';
    }

    var OFF_MEDIA = 'That frame is outside the media.';
    var NO_PLAYHEAD = 'The playhead isn\'t over this media.';

    // The timing actions of a row; null when the panel has no sequence to measure against.
    // opts.timing: { nudgedSource(atTicks, frames) -> seconds|null,
    // playheadSource() -> Promise<seconds|null> }; seconds are source seconds.
    function timingFor(id) {
      var t = opts.timing;
      if (!t) { return null; }
      return {
        nudge: function (frames) {
          var p = placementOf(id);
          if (!p || !p.timecode) { return Promise.resolve(OFF_MEDIA); }
          var result = setAnchor(id, t.nudgedSource(p.atTicks, frames));
          return Promise.resolve(result === null ? OFF_MEDIA : result);
        },
        toPlayhead: function () {
          return Promise.resolve(t.playheadSource()).then(function (seconds) {
            var result = setAnchor(id, seconds);
            return result === null ? NO_PLAYHEAD : result;
          }, function () { return NO_PLAYHEAD; });
        }
      };
    }

    // The other sequence positions of a multiple-placements cue, as timecodes. Choosing one hands
    // its (snapped) ticks to opts.onChoosePlacement, which keeps the pick in panel state and
    // re-maps; the list then redraws with the row open.
    function placementsFor(id, p) {
      if (!p || !p.alternatives || p.alternatives.length === 0 || !opts.timecodeOf ||
          !opts.onChoosePlacement) { return null; }
      return {
        alternatives: p.alternatives.map(function (ticks) {
          return { ticks: ticks, timecode: opts.timecodeOf(ticks) };
        }),
        choose: function (ticks) {
          opts.onChoosePlacement(id, ticks);
          render();
          toggleExpanded(id);
        }
      };
    }

    function editorFor(id) {
      var p = placementOf(id);
      return {
        reason: editingOff,
        resolve: function (text) { return resolveCue(id, String(text).trim(), null); },
        choose: function (alt) { return resolveCue(id, alt.reference, alt.reference); },
        timecode: p && p.timecode ? p.timecode : '',
        timing: timingFor(id),
        placements: placementsFor(id, p),
        // The duration is stored as typed, in seconds; the re-map clips it to the frame grid.
        setDuration: function (text) {
          var seconds = Number(String(text).trim());
          if (String(text).trim() === '' || !isFinite(seconds) || seconds <= 0) {
            return 'Enter a duration in seconds, greater than zero.';
          }
          try {
            model.edit(id, { source_duration_s: seconds });
          } catch (e) {
            return e.message;
          }
          afterTiming(id);
          return '';
        },
        remove: function () {
          model.remove(id);
          if (opts.onChange) { opts.onChange(id); }
          render();
        }
      };
    }

    function movePlayhead(id) {
      var p = placementOf(id);
      if (!p || !p.timecode || !opts.bridge) { return; }
      opts.bridge.call('setPlayhead', { ticks: String(p.atTicks) });
    }

    function onToggle(id, checked) {
      model.setEnabled(id, checked);
      refreshRow(id);
      updateHeader();
    }

    // Full render: rebuilds every row, sorted by sequence timecode, cut cues last.
    function render() {
      while (list.firstChild) { list.removeChild(list.firstChild); }
      rows = {};
      sorted(model.cues()).forEach(function (item) {
        var vm = rowViewModel(item.cue, placementOf(item.cue.id), threshold);
        var row = buildRow(doc, vm);
        row.querySelector('.vf-row-check').addEventListener('change', function (e) {
          onToggle(item.cue.id, e.target.checked);
        });
        row.querySelector('.vf-row-timecode').addEventListener('click', function () {
          movePlayhead(item.cue.id);
        });
        row.addEventListener('click', function (e) {
          var t = e.target;
          if (t.closest && (t.closest('.vf-row-check') || t.closest('.vf-row-timecode') ||
              t.closest('.vf-row-detail'))) { return; }
          toggleExpanded(item.cue.id);
        });
        rows[item.cue.id] = row;
        updateRow(doc, row, vm);
        list.appendChild(row);
      });
      applyFilter();
      updateHeader();
    }

    render();
    return {
      render: render,
      refreshRow: refreshRow,
      updateHeader: updateHeader,
      setMessage: setMessage
    };
  }

  var Review = {
    FLAGS: FLAGS,
    NO_TIMECODE: NO_TIMECODE,
    IDLE_TEXT: IDLE_TEXT,
    EMPTY_TEXT: EMPTY_TEXT,
    INSERT_HINT: INSERT_HINT,
    RETRY_TEXT_LABEL: RETRY_TEXT_LABEL,
    rowViewModel: rowViewModel,
    contextViewModel: contextViewModel,
    resolvePatch: resolvePatch,
    create: create
  };

  if (typeof module !== 'undefined' && module.exports) { module.exports = Review; }
  else { root.VSReview = Review; }
})(this);
