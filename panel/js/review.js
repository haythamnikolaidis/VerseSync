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
    var tc = el(doc, 'span', 'vf-row-timecode', vm.timecode);
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

  // Applies the parts of a view model that change when a cue is toggled or re-flagged.
  function updateRow(doc, row, vm) {
    row.className = 'row' + (vm.enabled ? '' : ' vf-row--disabled');
    row.querySelector('.vf-row-check').checked = vm.enabled;
    var holder = row.querySelector('.vf-row-flags');
    while (holder.firstChild) { holder.removeChild(holder.firstChild); }
    vm.flags.forEach(function (f) {
      holder.appendChild(el(doc, 'span', 'vf-flag vf-flag--' + f.color + ' vf-flag-' + f.flag,
        '\u2691 ' + f.label));
    });
  }

  // opts: { root, model, getPlacements, bridge, threshold }. getPlacements() returns the
  // VSTimemap.mapCueDocument placements map. bridge is accepted for the expanded row (T-29.6).
  function create(opts) {
    var container = opts.root;
    var doc = container.ownerDocument;
    var model = opts.model;
    var threshold = opts.threshold;
    var rows = {};

    var header = el(doc, 'div', 'vf-review-header');
    var list = el(doc, 'div', 'vf-review-list');
    container.appendChild(header);
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
      header.textContent = 'REVIEW \u2014 ' + cues.length + ' found \u00B7 ' +
        model.enabledCount() + ' enabled [\u2691 ' + flaggedCount(cues) + ']';
    }

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
      return vm;
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
        rows[item.cue.id] = row;
        updateRow(doc, row, vm);
        list.appendChild(row);
      });
      updateHeader();
    }

    render();
    return { render: render, refreshRow: refreshRow, updateHeader: updateHeader };
  }

  var Review = {
    FLAGS: FLAGS,
    NO_TIMECODE: NO_TIMECODE,
    rowViewModel: rowViewModel,
    create: create
  };

  if (typeof module !== 'undefined' && module.exports) { module.exports = Review; }
  else { root.VSReview = Review; }
})(this);
