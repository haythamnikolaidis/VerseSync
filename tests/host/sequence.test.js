'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadJsx } = require('../lib/load-jsx');
const { createFakePremiere } = require('../lib/fake-premiere');

const JSX = path.join(__dirname, '..', '..', 'panel', 'jsx', 'VerseSync.jsx');
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'host');
const NO_SEQUENCE = 'Open a sequence in Premiere first.';

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name + '.json'), 'utf8'));
}

// Builds a fake whose active sequence reproduces a fixture's values.
function fakeFor(info) {
  const fake = createFakePremiere();
  if (info.hasActiveSequence) {
    const seq = fake.addSequence({
      id: info.sequenceId,
      name: info.name,
      timebase: info.timebase,
      zeroPointTicks: info.zeroPointTicks,
      endTicks: info.endTicks,
      videoTracks: info.videoTrackCount,
      audioTracks: info.audioTrackCount
    });
    seq.setPlayerPosition(info.playheadTicks);
  }
  return fake;
}

function call(fake, fn, args) {
  const raw = loadJsx(JSX, fake).VS[fn](args === undefined ? '{}' : JSON.stringify(args));
  return JSON.parse(raw);
}

test('ping reports the host API version', () => {
  const res = call(createFakePremiere(), 'ping');
  assert.deepStrictEqual(res, { ok: true, data: { pong: true, version: '1.0.0', hostApi: '1.1' } });
});

['sequence-2997', 'sequence-23976', 'sequence-25', 'sequence-none'].forEach(function (name) {
  test('getSequenceInfo equals the ' + name + ' fixture', () => {
    const expected = fixture(name);
    const res = call(fakeFor(expected), 'getSequenceInfo');
    assert.deepStrictEqual(res, { ok: true, data: expected });
  });
});

test('getSequenceInfo passes timebase through as the string Premiere reports', () => {
  const fake = fakeFor(fixture('sequence-23976'));
  assert.strictEqual(call(fake, 'getSequenceInfo').data.timebase, '10594584000');
});

test('setPlayhead moves the playhead of the active sequence', () => {
  const fake = fakeFor(fixture('sequence-2997'));
  const res = call(fake, 'setPlayhead', { ticks: '358996428390000' });
  assert.deepStrictEqual(res, { ok: true, data: { ticks: '358996428390000' } });
  assert.strictEqual(fake.app.project.activeSequence.getPlayerPosition().ticks, '358996428390000');
  assert.strictEqual(call(fake, 'getSequenceInfo').data.playheadTicks, '358996428390000');
});

test('setPlayhead with no sequence open returns the exact message', () => {
  const res = call(createFakePremiere(), 'setPlayhead', { ticks: '1' });
  assert.deepStrictEqual(res, { ok: false, error: NO_SEQUENCE });
});

test('setPlayhead rejects a missing ticks argument without throwing', () => {
  const res = call(fakeFor(fixture('sequence-25')), 'setPlayhead', {});
  assert.strictEqual(res.ok, false);
});

test('malformed arguments come back as an error response, never a throw', () => {
  const VS = loadJsx(JSX, fakeFor(fixture('sequence-25'))).VS;
  const res = JSON.parse(VS.setPlayhead('{not json'));
  assert.strictEqual(res.ok, false);
});
