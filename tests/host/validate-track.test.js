'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { loadJsx } = require('../lib/load-jsx');
const { createFakePremiere } = require('../lib/fake-premiere');

const JSX = path.join(__dirname, '..', '..', 'panel', 'jsx', 'VerseSync.jsx');

function setup() {
  const fake = createFakePremiere();
  const seq = fake.addSequence({ id: 'seq-1', name: 'Main', videoTracks: 3, audioTracks: 1 });
  return { fake, seq };
}

function run(fake, args) {
  return JSON.parse(loadJsx(JSX, fake).VS.validateTrack(JSON.stringify(args)));
}

function range(s, e) {
  return { startTicks: String(s), endTicks: String(e) };
}

test('an empty track has no conflicts', () => {
  const { fake } = setup();
  const res = run(fake, { sequenceId: 'seq-1', trackIndex: 2, ranges: [range(0, 100)] });
  assert.deepStrictEqual(res, { ok: true, data: { conflicts: [] } });
  assert.deepStrictEqual(fake.undoLog, []);
});

test('a populated track reports three conflicts', () => {
  const { fake, seq } = setup();
  fake.addClip(seq, 'video', 2, { name: 'Lower Third 01', startTicks: 0, endTicks: 150 });
  fake.addClip(seq, 'video', 2, { name: 'Lower Third 02', startTicks: 150, endTicks: 400 });
  fake.addClip(seq, 'video', 2, { name: 'Lower Third 03', startTicks: 1000, endTicks: 1100 });
  fake.addClip(seq, 'video', 1, { name: 'Other Track', startTicks: 0, endTicks: 5000 });
  const res = run(fake, {
    sequenceId: 'seq-1',
    trackIndex: 2,
    ranges: [range(100, 200), range(500, 900), range(1050, 1200)]
  });
  assert.deepStrictEqual(res, {
    ok: true,
    data: {
      conflicts: [
        { rangeIndex: 0, existingClipName: 'Lower Third 01' },
        { rangeIndex: 0, existingClipName: 'Lower Third 02' },
        { rangeIndex: 2, existingClipName: 'Lower Third 03' }
      ]
    }
  });
});

test('a clip that only touches a range does not conflict', () => {
  const { fake, seq } = setup();
  fake.addClip(seq, 'video', 0, { name: 'Edge', startTicks: 100, endTicks: 200 });
  const res = run(fake, {
    sequenceId: 'seq-1',
    trackIndex: 0,
    ranges: [range(0, 100), range(200, 300)]
  });
  assert.deepStrictEqual(res, { ok: true, data: { conflicts: [] } });
});

test('large tick values compare without precision loss', () => {
  const { fake, seq } = setup();
  fake.addClip(seq, 'video', 0, {
    name: 'Late', startTicks: '358996428390000', endTicks: '358996428390100'
  });
  const res = run(fake, {
    sequenceId: 'seq-1',
    trackIndex: 0,
    ranges: [range('358996428390099', '358996428390200')]
  });
  assert.strictEqual(res.data.conflicts.length, 1);
});

test('an invalid track is rejected before the track is touched', () => {
  const { fake } = setup();
  const res = run(fake, { sequenceId: 'seq-1', trackIndex: 3, ranges: [range(0, 100)] });
  assert.deepStrictEqual(res, {
    ok: false,
    error: 'Track V4 no longer exists in this sequence. Click Refresh.'
  });
});

test('a wrong sequence id is rejected', () => {
  const { fake } = setup();
  const res = run(fake, { sequenceId: 'nope', trackIndex: 0, ranges: [] });
  assert.strictEqual(res.ok, false);
});
