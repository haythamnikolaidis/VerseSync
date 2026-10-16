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

  var Review = {
    FLAGS: FLAGS,
    NO_TIMECODE: NO_TIMECODE,
    rowViewModel: rowViewModel
  };

  if (typeof module !== 'undefined' && module.exports) { module.exports = Review; }
  else { root.VSReview = Review; }
})(this);
