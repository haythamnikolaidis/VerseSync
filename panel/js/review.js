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
  function buildDetail(doc, cue, getTranscript) {
    var box = el(doc, 'div', 'vf-row-detail');
    var refLine = el(doc, 'div', 'vf-detail-reference');
    refLine.appendChild(el(doc, 'span', 'vf-detail-label', 'Reference '));
    refLine.appendChild(el(doc, 'span', 'vf-detail-value', cue.reference_display));
    box.appendChild(refLine);

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

    var cls = el(doc, 'div', 'vf-detail-classification');
    cls.appendChild(el(doc, 'span', 'vf-detail-label', 'Classification '));
    cls.appendChild(el(doc, 'span', 'vf-detail-value', classificationLine(cue)));
    box.appendChild(cls);
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

  // opts: { root, model, getPlacements, bridge, threshold, onSave, onLoad, onExport, onInsert }.
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
    var insertHint = el(doc, 'div', 'vf-hint vf-review-insert-hint',
      'Enable at least one scripture to insert.');

    [allBtn, noneBtn, flaggedBtn, saveWrap, insertBtn].forEach(function (n) { toolbar.appendChild(n); });
    header.appendChild(title);
    header.appendChild(toolbar);
    header.appendChild(insertHint);
    container.appendChild(header);
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
      insertHint.hidden = enabled !== 0;
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
      row.appendChild(buildDetail(doc, model.get(id), opts.getTranscript));
      row.classList.add('vf-row--expanded');
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
    rowViewModel: rowViewModel,
    contextViewModel: contextViewModel,
    create: create
  };

  if (typeof module !== 'undefined' && module.exports) { module.exports = Review; }
  else { root.VSReview = Review; }
})(this);
