'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const Layout = require(path.join(root, 'panel', 'js', 'layout.js'));
const measurements = JSON.parse(fs.readFileSync(
  path.join(root, 'tests', 'fixtures', 'graphic-measurements.json'), 'utf8'));

function words(text) {
  return String(text).split(/\s+/).filter((w) => w !== '');
}

// Public-domain text (KJV) and made-up filler only; the licensed graphics are measured, not quoted.
const KJV_JOHN_3 = '16 For God so loved the world, that he gave his only begotten Son, that whosoever ' +
  'believeth in him should not perish, but have everlasting life. ' +
  '17 For God sent not his Son into the world to condemn the world; but that the world through him ' +
  'might be saved. ' +
  '18 He that believeth on him is not condemned: but he that believeth not is condemned already, ' +
  'because he hath not believed in the name of the only begotten Son of God.';
const JOHN_3 = { verse: 16, verse_end: 18 };

function filler(count, tag) {
  const out = [];
  for (let i = 0; i < count; i++) { out.push(tag + i); }
  return out.join(' ');
}

// ---------------------------------------------------------------------------------------------
// wrapText

test('wrapText breaks at the last word that fits and joins lines with a newline', () => {
  assert.strictEqual(
    Layout.wrapText('In the beginning God created the heaven and the earth.', 20),
    'In the beginning God\ncreated the heaven\nand the earth.');
});

test('wrapText fills a line up to exactly maxChars', () => {
  assert.strictEqual(Layout.wrapText('aaaa bbbb cccc', 9), 'aaaa bbbb\ncccc');
  assert.strictEqual(Layout.wrapText('aaaa bbbb cccc', 14), 'aaaa bbbb cccc');
  assert.strictEqual(Layout.wrapText('aaaa bbbb cccc', 8), 'aaaa\nbbbb\ncccc');
});

test('wrapText leaves text that fits on one line', () => {
  assert.strictEqual(Layout.wrapText('Jesus wept.', 80), 'Jesus wept.');
});

test('wrapText gives a word longer than maxChars its own line', () => {
  assert.strictEqual(
    Layout.wrapText('a supercalifragilistic b', 5),
    'a\nsupercalifragilistic\nb');
  assert.strictEqual(Layout.wrapText('abcdefghij', 3), 'abcdefghij');
});

test('wrapText splits on any whitespace and drops the old line breaks', () => {
  assert.strictEqual(Layout.wrapText('  one   two\nthree\tfour  ', 80), 'one two three four');
});

test('wrapText returns the text unchanged when maxChars is zero, negative or not a number', () => {
  const text = 'one  two\nthree';
  assert.strictEqual(Layout.wrapText(text, 0), text);
  assert.strictEqual(Layout.wrapText(text, -5), text);
  assert.strictEqual(Layout.wrapText(text, undefined), text);
  assert.strictEqual(Layout.wrapText(text, NaN), text);
});

test('wrapText of empty text is empty', () => {
  assert.strictEqual(Layout.wrapText('', 40), '');
  assert.strictEqual(Layout.wrapText('   ', 40), '');
  assert.strictEqual(Layout.wrapText(null, 40), '');
});

// ---------------------------------------------------------------------------------------------
// verseChunks

test('verseChunks starts a chunk at each expected verse number', () => {
  assert.deepStrictEqual(Layout.verseChunks('5 aaa bbb 6 ccc 7 ddd eee', { verse: 5, verse_end: 7 }), [
    '5 aaa bbb',
    '6 ccc',
    '7 ddd eee'
  ]);
});

test('verseChunks splits KJV John 3:16-18 into three verses', () => {
  const chunks = Layout.verseChunks(KJV_JOHN_3, JOHN_3);
  assert.strictEqual(chunks.length, 3);
  assert.ok(chunks[0].indexOf('16 For God so loved') === 0);
  assert.ok(chunks[1].indexOf('17 For God sent not') === 0);
  assert.ok(chunks[2].indexOf('18 He that believeth on him') === 0);
});

test('verseChunks keeps text before the first number in the first chunk', () => {
  assert.deepStrictEqual(Layout.verseChunks('lead in words 5 aaa 6 bbb', { verse: 5, verse_end: 6 }), [
    'lead in words 5 aaa',
    '6 bbb'
  ]);
});

test('verseChunks copes with a missing first number', () => {
  assert.deepStrictEqual(Layout.verseChunks('aaa bbb 6 ccc ddd 7 eee', { verse: 5, verse_end: 7 }), [
    'aaa bbb',
    '6 ccc ddd',
    '7 eee'
  ]);
});

test('verseChunks does not split at a number that is not the next expected verse', () => {
  assert.deepStrictEqual(Layout.verseChunks('5 in the year 7 of kings 5 again 6 end', { verse: 5, verse_end: 6 }), [
    '5 in the year 7 of kings 5 again',
    '6 end'
  ]);
  assert.deepStrictEqual(Layout.verseChunks('5 seven 7 kings 6 end', { verse: 5, verse_end: 6 }), [
    '5 seven 7 kings',
    '6 end'
  ]);
});

test('verseChunks needs whole tokens, so 16, 6, and 6th do not match verse 6', () => {
  assert.deepStrictEqual(Layout.verseChunks('5 a 16 b 6, c 6th d 6 e', { verse: 5, verse_end: 6 }), [
    '5 a 16 b 6, c 6th d',
    '6 e'
  ]);
});

test('verseChunks ignores numbers past verse_end', () => {
  assert.deepStrictEqual(Layout.verseChunks('5 a 6 b 7 c', { verse: 5, verse_end: 6 }), ['5 a', '6 b 7 c']);
});

test('verseChunks stops looking when a verse number is missing in the middle', () => {
  assert.deepStrictEqual(Layout.verseChunks('5 a 6 b 8 c', { verse: 5, verse_end: 8 }), ['5 a', '6 b 8 c']);
});

test('verseChunks gives one chunk for a single verse, a chapter-only or an out-of-range reference', () => {
  const body = '5 aaa 6 bbb 7 ccc';
  assert.deepStrictEqual(Layout.verseChunks(body, { verse: 5 }), [body]);
  assert.deepStrictEqual(Layout.verseChunks(body, { verse: 5, verse_end: 5 }), [body]);
  assert.deepStrictEqual(Layout.verseChunks(body, { verse: 7, verse_end: 5 }), [body]);
  assert.deepStrictEqual(Layout.verseChunks(body, { chapter: 3 }), [body]);
  assert.deepStrictEqual(Layout.verseChunks(body, undefined), [body]);
  assert.deepStrictEqual(Layout.verseChunks(body, { verse: 0, verse_end: 3 }), [body]);
});

test('verseChunks gives one chunk when none of the reference verse numbers are in the body', () => {
  const body = 'aaa bbb ccc';
  assert.deepStrictEqual(Layout.verseChunks(body, { verse: 20, verse_end: 22 }), [body]);
});

test('verseChunks chunks join back to the body words', () => {
  const chunks = Layout.verseChunks(KJV_JOHN_3, JOHN_3);
  assert.deepStrictEqual(words(chunks.join(' ')), words(KJV_JOHN_3));
});

// ---------------------------------------------------------------------------------------------
// layoutCue

const SETTINGS = { wrapEnabled: true, wrapChars: 80, maxLines: 4 };

function cueOf(body, reference) {
  return { id: 'c1', body: body, reference: reference || {} };
}

function lineCount(text) { return text.split('\n').length; }

test('layoutCue returns one wrapped graphic when the passage fits', () => {
  const parts = Layout.layoutCue(cueOf('5 aaa bbb ccc 6 ddd eee fff', { verse: 5, verse_end: 6 }),
    { wrapEnabled: true, wrapChars: 12, maxLines: 4 });
  assert.deepStrictEqual(parts, [{ body: '5 aaa bbb\nccc 6 ddd\neee fff', firstVerse: 5 }]);
});

test('layoutCue keeps a multi-verse passage together when it fits', () => {
  const parts = Layout.layoutCue(cueOf(KJV_JOHN_3, JOHN_3), { wrapEnabled: true, wrapChars: 80, maxLines: 12 });
  assert.strictEqual(parts.length, 1);
  assert.deepStrictEqual(words(parts[0].body), words(KJV_JOHN_3));
});

test('layoutCue splits between verses when the passage does not fit', () => {
  const parts = Layout.layoutCue(cueOf(KJV_JOHN_3, JOHN_3), { wrapEnabled: true, wrapChars: 80, maxLines: 4 });
  assert.ok(parts.length >= 2);
  parts.forEach((p) => assert.ok(lineCount(p.body) <= 4, p.body));
  assert.strictEqual(parts[0].firstVerse, 16);
  // Each later part begins on the verse number it is labelled with.
  parts.slice(1).forEach((p) => {
    assert.strictEqual(words(p.body)[0], String(p.firstVerse));
  });
  assert.deepStrictEqual(words(parts.map((p) => p.body).join(' ')), words(KJV_JOHN_3));
});

test('layoutCue packs as many whole verses as fit onto each graphic', () => {
  const verse = ' wwww wwww wwww wwww wwww wwww wwww wwww';
  const body = '1' + verse + ' 2' + verse + ' 3' + verse + ' 4' + verse;
  const parts = Layout.layoutCue(cueOf(body, { verse: 1, verse_end: 4 }),
    { wrapEnabled: true, wrapChars: 16, maxLines: 4 });
  // One verse takes 3 lines at 16 characters, so two verses never share a four-line graphic.
  assert.strictEqual(parts.length, 4);
  assert.deepStrictEqual(parts.map((p) => p.firstVerse), [1, 2, 3, 4]);

  const roomy = Layout.layoutCue(cueOf(body, { verse: 1, verse_end: 4 }),
    { wrapEnabled: true, wrapChars: 40, maxLines: 4 });
  roomy.forEach((p) => assert.ok(lineCount(p.body) <= 4));
  assert.ok(roomy.length < 4, 'verses share graphics when they fit');
  assert.ok(roomy.length > 1);
});

test('layoutCue cuts a single verse that is too long for one graphic', () => {
  const body = filler(60, 'w');
  const parts = Layout.layoutCue(cueOf(body, { verse: 7 }), { wrapEnabled: true, wrapChars: 30, maxLines: 3 });
  assert.ok(parts.length > 1);
  parts.forEach((p) => assert.ok(lineCount(p.body) <= 3, p.body));
  parts.slice(0, -1).forEach((p) => assert.strictEqual(lineCount(p.body), 3));
  assert.deepStrictEqual(words(parts.map((p) => p.body).join(' ')), words(body));
});

test('layoutCue cuts an oversized verse inside a multi-verse passage and carries on', () => {
  const body = '1 ' + filler(3, 'a') + ' 2 ' + filler(40, 'b') + ' 3 ' + filler(3, 'c');
  const parts = Layout.layoutCue(cueOf(body, { verse: 1, verse_end: 3 }),
    { wrapEnabled: true, wrapChars: 20, maxLines: 2 });
  parts.forEach((p) => assert.ok(lineCount(p.body) <= 2, p.body));
  assert.deepStrictEqual(words(parts.map((p) => p.body).join(' ')), words(body));
  assert.strictEqual(parts[0].firstVerse, 1);
  assert.strictEqual(parts[1].firstVerse, 2);
  // The continuation of verse 2 does not begin on a verse.
  assert.strictEqual(parts[2].firstVerse, null);
});

test('layoutCue handles a single word longer than the line', () => {
  const long = 'x'.repeat(50);
  const parts = Layout.layoutCue(cueOf('aa ' + long + ' bb ' + long, {}), { wrapEnabled: true, wrapChars: 10, maxLines: 2 });
  parts.forEach((p) => assert.ok(lineCount(p.body) <= 2, p.body));
  assert.deepStrictEqual(words(parts.map((p) => p.body).join(' ')), ['aa', long, 'bb', long]);
});

test('layoutCue with maxLines 1 puts one line on each graphic', () => {
  const parts = Layout.layoutCue(cueOf(filler(12, 'q'), {}), { wrapEnabled: true, wrapChars: 15, maxLines: 1 });
  assert.ok(parts.length > 1);
  parts.forEach((p) => assert.strictEqual(lineCount(p.body), 1));
});

test('layoutCue with wrap off returns the body unchanged as one graphic', () => {
  const body = '16 For God so loved\nthe world, ' + filler(100, 'z');
  const parts = Layout.layoutCue(cueOf(body, JOHN_3), { wrapEnabled: false, wrapChars: 20, maxLines: 1 });
  assert.deepStrictEqual(parts, [{ body: body, firstVerse: null }]);
});

test('layoutCue without a usable line width returns the body unchanged', () => {
  const body = filler(30, 'k');
  assert.deepStrictEqual(Layout.layoutCue(cueOf(body), { wrapEnabled: true, wrapChars: 0, maxLines: 2 }),
    [{ body: body, firstVerse: null }]);
});

test('layoutCue never changes the cue it is given', () => {
  const cue = cueOf(KJV_JOHN_3, JOHN_3);
  const before = JSON.stringify(cue);
  Layout.layoutCue(cue, SETTINGS);
  assert.strictEqual(JSON.stringify(cue), before);
});

test('layoutCue of an empty body is one empty graphic', () => {
  assert.deepStrictEqual(Layout.layoutCue(cueOf(''), SETTINGS), [{ body: '', firstVerse: null }]);
});

test('layoutCue treats a missing maxLines as no limit', () => {
  const parts = Layout.layoutCue(cueOf(filler(80, 'm')), { wrapEnabled: true, wrapChars: 20 });
  assert.strictEqual(parts.length, 1);
});

test('layoutCue holds its limits on pseudo-random input', () => {
  let seed = 12345;
  function next(n) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  }
  for (let round = 0; round < 300; round++) {
    const verseCount = 1 + next(5);
    const first = 1 + next(30);
    const pieces = [];
    for (let v = 0; v < verseCount; v++) {
      if (next(6) !== 0) { pieces.push(String(first + v)); }
      const n = 1 + next(40);
      for (let i = 0; i < n; i++) { pieces.push('x'.repeat(1 + next(next(4) === 0 ? 150 : 12))); }
    }
    const wrapChars = 20 + next(101);
    const maxLines = 1 + next(12);
    const body = pieces.join(' ');
    const parts = Layout.layoutCue(cueOf(body, { verse: first, verse_end: first + verseCount - 1 }),
      { wrapEnabled: true, wrapChars: wrapChars, maxLines: maxLines });
    parts.forEach((p) => {
      assert.ok(lineCount(p.body) <= maxLines, 'round ' + round + ' exceeded maxLines');
      p.body.split('\n').forEach((line) => {
        assert.ok(line.length <= wrapChars || words(line).length === 1, 'round ' + round + ' line too long');
      });
    });
    assert.deepStrictEqual(words(parts.map((p) => p.body).join(' ')), words(body), 'round ' + round);
  }
});

// ---------------------------------------------------------------------------------------------
// The 33 measured graphics

// Rebuilds a body with the same word lengths and verse numbers as a measured graphic. The words
// are made-up letters, so the fixture needs no scripture text.
function bodyOf(graphic) {
  const numbers = {};
  graphic.verse_number_words.forEach((pair) => { numbers[pair[0]] = pair[1]; });
  return graphic.word_lengths.map((len, i) => {
    if (numbers[i] !== undefined) { return String(numbers[i]); }
    let word = '';
    for (let c = 0; c < len; c++) { word += String.fromCharCode(97 + ((i * 7 + c * 3) % 26)); }
    return word;
  }).join(' ');
}

function referenceOf(graphic) {
  return { verse: graphic.verse, verse_end: graphic.verse_end === null ? undefined : graphic.verse_end };
}

test('the measurements cover 33 graphics and agree with themselves', () => {
  assert.strictEqual(measurements.graphics.length, 33);
  measurements.graphics.forEach((g) => {
    assert.strictEqual(g.line_lengths.reduce((a, b) => a + b, 0) + g.line_lengths.length - 1, g.characters,
      g.reference + ' #' + g.label_index);
    assert.strictEqual(bodyOf(g).split(' ').length, g.word_lengths.length);
  });
});

test('the measurements match the longest line, line count and character count in docs/15', () => {
  const gs = measurements.graphics;
  assert.strictEqual(Math.max.apply(null, gs.map((g) => g.line_lengths.length)), 4);
  assert.strictEqual(Math.max.apply(null, gs.map((g) => g.characters)), 292);
  assert.ok(Math.max.apply(null, gs.map((g) => Math.max.apply(null, g.line_lengths))) <= 88);
});

test('no measured graphic is over the limit at 80 characters and 4 lines, and none loses a word', () => {
  measurements.graphics.forEach((g) => {
    const body = bodyOf(g);
    const parts = Layout.layoutCue(cueOf(body, referenceOf(g)), SETTINGS);
    parts.forEach((p) => {
      assert.ok(lineCount(p.body) <= 4, g.reference + ' #' + g.label_index);
      p.body.split('\n').forEach((line) => {
        assert.ok(line.length <= 80 || words(line).length === 1, g.reference + ' #' + g.label_index);
      });
    });
    assert.deepStrictEqual(words(parts.map((p) => p.body).join(' ')), words(body));
  });
});

test('every measured graphic fits one graphic at 80 characters and 4 lines', () => {
  measurements.graphics.forEach((g) => {
    const parts = Layout.layoutCue(cueOf(bodyOf(g), referenceOf(g)), SETTINGS);
    assert.strictEqual(parts.length, 1, g.reference + ' #' + g.label_index);
  });
});

test('measured graphics stay within the limits at other settings too', () => {
  [[45, 4], [60, 3], [80, 2], [120, 12], [20, 1]].forEach((pair) => {
    measurements.graphics.forEach((g) => {
      const body = bodyOf(g);
      const parts = Layout.layoutCue(cueOf(body, referenceOf(g)),
        { wrapEnabled: true, wrapChars: pair[0], maxLines: pair[1] });
      parts.forEach((p) => assert.ok(lineCount(p.body) <= pair[1], g.reference + ' at ' + pair.join('x')));
      assert.deepStrictEqual(words(parts.map((p) => p.body).join(' ')), words(body));
    });
  });
});

test('2 Corinthians 4:6-9 as one passage becomes two graphics, verses 6-7 and 8-9', () => {
  const pieces = measurements.graphics.filter((g) => g.reference.indexOf('2 Corinthians 4:6-9') === 0);
  assert.strictEqual(pieces.length, 3);
  const merged = {
    word_lengths: [].concat.apply([], pieces.map((g) => g.word_lengths)),
    verse_number_words: []
  };
  let offset = 0;
  pieces.forEach((g) => {
    g.verse_number_words.forEach((pair) => { merged.verse_number_words.push([pair[0] + offset, pair[1]]); });
    offset += g.word_lengths.length;
  });
  const body = bodyOf(merged);
  const parts = Layout.layoutCue(cueOf(body, { verse: 6, verse_end: 9 }), SETTINGS);
  parts.forEach((p) => assert.ok(lineCount(p.body) <= 4));
  assert.deepStrictEqual(parts.map((p) => p.firstVerse), [6, 8]);
  assert.deepStrictEqual(words(parts.map((p) => p.body).join(' ')), words(body));
});
