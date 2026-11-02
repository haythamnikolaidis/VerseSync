'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const Layout = require(path.join(root, 'panel', 'js', 'layout.js'));

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
