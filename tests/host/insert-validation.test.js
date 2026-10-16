'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { loadJsx } = require('../lib/load-jsx');
const { createFakePremiere } = require('../lib/fake-premiere');

const JSX = path.join(__dirname, '..', '..', 'panel', 'jsx', 'VerseSync.jsx');

function setup() {
  const fake = createFakePremiere();
  fake.addSequence({ id: 'seq-1', name: 'Main', videoTracks: 3, audioTracks: 1 });
  const other = fake.addSequence({ id: 'seq-2', name: 'Other', videoTracks: 1, audioTracks: 1 });
  fake.app.project.sequences = { numSequences: 2, 0: fake.sequences[0], 1: other };
  return fake;
}

function goodArgs() {
  return {
    sequenceId: 'seq-1',
    mogrtPath: 'D:/Templates/AV_Quote_04.mogrt',
    trackIndex: 2,
    mapping: { referenceIndex: 11, bodyIndex: 3 },
    cues: [
      { id: 'a', atTicks: '100', durationTicks: '50', reference: 'r', body: 'b' },
      { id: 'b', atTicks: '358996428390000', durationTicks: '6878765400000', reference: 'r', body: 'b' }
    ]
  };
}

function rejects(mutate, expected) {
  const fake = setup();
  const args = goodArgs();
  mutate(args);
  const res = JSON.parse(loadJsx(JSX, fake).VS.insertCues(JSON.stringify(args)));
  assert.deepStrictEqual(res, { ok: false, error: expected });
  assert.deepStrictEqual(fake.undoLog, []);
}

const UNSORTED = 'Internal error: cues must be sorted by time. Please report this.';

test('missing sequenceId is rejected', () => {
  rejects(function (a) { delete a.sequenceId; }, 'Open a sequence in Premiere first.');
});

test('unknown sequenceId is rejected', () => {
  rejects(function (a) { a.sequenceId = 'nope'; }, 'Open a sequence in Premiere first.');
});

test('a sequenceId of another sequence names that sequence', () => {
  rejects(function (a) { a.sequenceId = 'seq-2'; },
    'The active sequence changed since this analysis. Switch back to "Other" or click Analyse again.');
});

test('track index past the end is rejected without touching the track', () => {
  rejects(function (a) { a.trackIndex = 3; },
    'Track V4 no longer exists in this sequence. Click Refresh.');
});

test('negative and fractional track indices are rejected', () => {
  rejects(function (a) { a.trackIndex = -1; },
    'Track V0 no longer exists in this sequence. Click Refresh.');
  rejects(function (a) { a.trackIndex = 1.5; },
    'Track V? no longer exists in this sequence. Click Refresh.');
});

test('non-numeric track index is rejected', () => {
  rejects(function (a) { a.trackIndex = '1'; },
    'Track V? no longer exists in this sequence. Click Refresh.');
});

test('empty mogrtPath is rejected', () => {
  rejects(function (a) { a.mogrtPath = ''; }, 'insertCues: mogrtPath must be a non-empty string');
});

test('non-integer mapping indices are rejected', () => {
  const msg = 'insertCues: mapping.referenceIndex and mapping.bodyIndex must be integers';
  rejects(function (a) { a.mapping.referenceIndex = '11'; }, msg);
  rejects(function (a) { delete a.mapping.bodyIndex; }, msg);
  rejects(function (a) { delete a.mapping; }, msg);
});

test('equal mapping indices are rejected', () => {
  rejects(function (a) { a.mapping.bodyIndex = 11; },
    'insertCues: mapping.referenceIndex and mapping.bodyIndex must differ');
});

test('atTicks and durationTicks must be digit strings', () => {
  const msg0 = 'insertCues: cue 0 needs atTicks and durationTicks as digit strings';
  rejects(function (a) { a.cues[0].atTicks = 100; }, msg0);
  rejects(function (a) { a.cues[0].atTicks = '-5'; }, msg0);
  rejects(function (a) { a.cues[0].durationTicks = '1.5'; }, msg0);
  rejects(function (a) { delete a.cues[0].durationTicks; }, msg0);
  rejects(function (a) { a.cues[1].atTicks = ''; },
    'insertCues: cue 1 needs atTicks and durationTicks as digit strings');
});

test('zero durationTicks is rejected', () => {
  rejects(function (a) { a.cues[1].durationTicks = '000'; },
    'insertCues: cue 1 durationTicks must be greater than zero');
});

test('unsorted cues are rejected, including beyond 2^53', () => {
  rejects(function (a) { a.cues.reverse(); }, UNSORTED);
  rejects(function (a) {
    a.cues[0].atTicks = '358996428390001';
    a.cues[1].atTicks = '358996428390000';
  }, UNSORTED);
});

test('equal atTicks are accepted by validation', () => {
  const fake = setup();
  const args = goodArgs();
  args.cues[1].atTicks = args.cues[0].atTicks;
  const res = JSON.parse(loadJsx(JSX, fake).VS.insertCues(JSON.stringify(args)));
  assert.notStrictEqual(res.error, UNSORTED);
  assert.deepStrictEqual(fake.undoLog, []);
});
