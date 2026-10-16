'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadJsx } = require('../lib/load-jsx');
const { createFakePremiere } = require('../lib/fake-premiere');

const JSX = path.join(__dirname, '..', '..', 'panel', 'jsx', 'VerseSync.jsx');
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'host');
const MEDIA = 'D:/Sermons/SERMON_A014.MXF';
const OTHER = 'D:/Sermons/BROLL_001.MXF';

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, 'segments-' + name + '.json'), 'utf8'));
}

function call(fake, args) {
  return JSON.parse(loadJsx(JSX, fake).VS.getMediaSegments(JSON.stringify(args)));
}

function newFake() {
  const fake = createFakePremiere();
  const seq = fake.addSequence({ id: 'seq-1', name: 'Main', videoTracks: 3, audioTracks: 2 });
  return { fake: fake, seq: seq };
}

// Builds a timeline in which every fixture entry is a clip of MEDIA, plus an
// unrelated clip that must never be reported.
function timelineFor(expected) {
  const { fake, seq } = newFake();
  expected.segments.concat(expected.unsupported).forEach(function (s) {
    fake.addClip(seq, s.trackType, s.trackIndex, {
      name: s.name,
      mediaPath: MEDIA,
      startTicks: s.seqStartTicks,
      endTicks: s.seqEndTicks,
      inPointTicks: s.inPointTicks,
      speed: s.speed
    });
  });
  fake.addClip(seq, 'video', 2, {
    name: 'BROLL_001.MXF', mediaPath: OTHER, startTicks: '0', endTicks: '1000'
  });
  return fake;
}

['single', 'split', 'duplicate', 'speed', 'none'].forEach(function (name) {
  test('segments-' + name + ' fixture is reproduced exactly', () => {
    const expected = fixture(name);
    const res = call(timelineFor(expected), { sequenceId: 'seq-1', mediaPath: MEDIA });
    assert.deepStrictEqual(res, { ok: true, data: expected });
  });
});

test('video and audio tracks are both walked', () => {
  const { fake, seq } = newFake();
  fake.addClip(seq, 'video', 1, {
    name: 'V', mediaPath: MEDIA, startTicks: '0', endTicks: '100', inPointTicks: '5'
  });
  fake.addClip(seq, 'audio', 1, {
    name: 'A', mediaPath: MEDIA, startTicks: '0', endTicks: '100', inPointTicks: '5'
  });
  const res = call(fake, { sequenceId: 'seq-1', mediaPath: MEDIA });
  assert.deepStrictEqual(
    res.data.segments.map((s) => [s.trackType, s.trackIndex]),
    [['video', 1], ['audio', 1]]
  );
  assert.strictEqual(res.data.segments[1].durationTicks, '100');
});

test('a clip with a null projectItem is skipped without throwing', () => {
  const { fake, seq } = newFake();
  fake.addClip(seq, 'video', 0, { name: 'Gap', projectItem: false, startTicks: '0', endTicks: '10' });
  fake.addClip(seq, 'video', 0, {
    name: 'X', mediaPath: MEDIA, startTicks: '10', endTicks: '20'
  });
  const res = call(fake, { sequenceId: 'seq-1', mediaPath: MEDIA });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.data.segments.length, 1);
  assert.deepStrictEqual(res.data.unsupported, []);
});

test('a nested-style clip with an empty media path goes to unsupported', () => {
  const { fake, seq } = newFake();
  fake.addClip(seq, 'video', 1, {
    name: 'Nested Seq', mediaPath: '', startTicks: '0', endTicks: '50'
  });
  const res = call(fake, { sequenceId: 'seq-1', mediaPath: MEDIA });
  assert.deepStrictEqual(res.data, {
    matched: false,
    segments: [],
    unsupported: [{
      trackType: 'video', trackIndex: 1, name: 'Nested Seq', reason: 'unresolvable_media'
    }]
  });
});

test('paths match across UNC, backslash, slash and case variants', () => {
  const variants = [
    ['//Server/Share/Sermon.mxf', '\\\\SERVER\\share\\sermon.MXF'],
    ['D:\\Sermons\\A.MXF', 'd:/sermons//a.mxf'],
    ['d:/x/a.mxf', 'D:\\X\\A.mxf']
  ];
  variants.forEach(function (pair) {
    const { fake, seq } = newFake();
    fake.addClip(seq, 'video', 0, {
      name: 'C', mediaPath: pair[0], startTicks: '0', endTicks: '10'
    });
    const res = call(fake, { sequenceId: 'seq-1', mediaPath: pair[1] });
    assert.strictEqual(res.data.matched, true, pair.join(' vs '));
  });
});

test('a UNC path does not match its single-slash look-alike', () => {
  const { fake, seq } = newFake();
  fake.addClip(seq, 'video', 0, {
    name: 'C', mediaPath: '//server/share/a.mxf', startTicks: '0', endTicks: '10'
  });
  const res = call(fake, { sequenceId: 'seq-1', mediaPath: '/server/share/a.mxf' });
  assert.strictEqual(res.data.matched, false);
});

test('a mismatched sequenceId returns the D20 message with the matching name', () => {
  const { fake } = newFake();
  const other = fake.addSequence({ id: 'seq-2', name: 'Other Cut' });
  fake.app.project.sequences = { numSequences: 2, 0: fake.sequences[0], 1: other };
  const res = call(fake, { sequenceId: 'seq-2', mediaPath: MEDIA });
  assert.deepStrictEqual(res, {
    ok: false,
    error: 'The active sequence changed since this analysis. Switch back to "Other Cut" or click Analyse again.'
  });
});

test('a missing or unknown sequenceId gives the no-sequence message', () => {
  const { fake } = newFake();
  fake.app.project.sequences = { numSequences: 1, 0: fake.sequences[0] };
  const msg = 'Open a sequence in Premiere first.';
  assert.deepStrictEqual(call(fake, { mediaPath: MEDIA }), { ok: false, error: msg });
  assert.deepStrictEqual(call(fake, { sequenceId: 'nope', mediaPath: MEDIA }), { ok: false, error: msg });
});

test('no active sequence gives the no-sequence message', () => {
  const fake = createFakePremiere();
  const res = call(fake, { sequenceId: 'seq-1', mediaPath: MEDIA });
  assert.deepStrictEqual(res, { ok: false, error: 'Open a sequence in Premiere first.' });
});
