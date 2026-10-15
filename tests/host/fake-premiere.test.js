'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadJsx } = require('../lib/load-jsx');

function writeTemp(name, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-jsx-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
}

test('loadJsx evaluates a script that sees app and $ but no native JSON', () => {
  const fake = { app: { project: { name: 'p' } }, $: { tag: 'dollar' } };
  const file = writeTemp('trivial.jsx', [
    'var VS = {};',
    'VS.projectName = app.project.name;',
    'VS.dollar = $.tag;',
    'VS.jsonType = typeof JSON;',
    'VS.hasEvent = typeof CSXSEvent;',
    'VS.hasFile = typeof File;'
  ].join('\n'));
  const loaded = loadJsx(file, fake);
  assert.strictEqual(loaded.VS.projectName, 'p');
  assert.strictEqual(loaded.VS.dollar, 'dollar');
  assert.strictEqual(loaded.VS.jsonType, 'undefined');
  assert.strictEqual(loaded.VS.hasEvent, 'function');
  assert.strictEqual(loaded.VS.hasFile, 'function');
  assert.ok(loaded.context);
});

test('loadJsx rejects non-ASCII source with a clear error', () => {
  const file = writeTemp('bad.jsx', 'var a = 1;\nvar b = "café";\n');
  assert.throws(() => loadJsx(file, { app: {}, $: {} }), /ASCII only.*U\+00E9.*line 2/);
});

const { createFakePremiere, GARBAGE_IN_POINT_TICKS } = require('../lib/fake-premiere');

function sermonFake() {
  const fake = createFakePremiere();
  const seq = fake.addSequence({
    id: 'seq-a', name: 'Sermon', timebase: '8475667200',
    zeroPointTicks: '914457600000000', endTicks: '689538816000000',
    videoTracks: 2, audioTracks: 1
  });
  return { fake: fake, seq: seq };
}

test('sequence exposes id, name, timebase, zeroPoint, end and track counts', () => {
  const { fake, seq } = sermonFake();
  const active = fake.app.project.activeSequence;
  assert.strictEqual(active, seq);
  assert.strictEqual(active.sequenceID, 'seq-a');
  assert.strictEqual(active.name, 'Sermon');
  assert.strictEqual(active.timebase, '8475667200');
  assert.strictEqual(active.zeroPoint, '914457600000000');
  assert.strictEqual(active.end, '689538816000000');
  assert.strictEqual(active.videoTracks.numTracks, 2);
  assert.strictEqual(active.audioTracks.numTracks, 1);
});

test('player position round-trips as a ticks string', () => {
  const { seq } = sermonFake();
  assert.strictEqual(seq.getPlayerPosition().ticks, '0');
  seq.setPlayerPosition('355622400000000');
  assert.strictEqual(seq.getPlayerPosition().ticks, '355622400000000');
});

test('addClip builds a plain clip with string ticks and a projectItem', () => {
  const { fake, seq } = sermonFake();
  const clip = fake.addClip(seq, 'video', 1, {
    name: 'A001.MXF', startTicks: '100', endTicks: '900', inPointTicks: '50',
    mediaPath: 'D:/Sermons/A001.MXF'
  });
  assert.deepStrictEqual(seq.videoTracks[1].clips, [clip]);
  assert.strictEqual(clip.start.ticks, '100');
  assert.strictEqual(clip.end.ticks, '900');
  assert.strictEqual(clip.inPoint.ticks, '50');
  assert.strictEqual(clip.name, 'A001.MXF');
  assert.strictEqual(clip.getSpeed(), 1);
  assert.strictEqual(clip.projectItem.getMediaPath(), 'D:/Sermons/A001.MXF');
});

test('audio clips live on audio tracks', () => {
  const { fake, seq } = sermonFake();
  const clip = fake.addClip(seq, 'audio', 0, { startTicks: 0, endTicks: 10, mediaPath: 'x.wav' });
  assert.strictEqual(seq.audioTracks[0].clips[0], clip);
  assert.strictEqual(seq.videoTracks[0].clips.length, 0);
  assert.strictEqual(clip.start.ticks, '0');
});

test('null projectItem is supported and chaining off it throws', () => {
  const { fake, seq } = sermonFake();
  const clip = fake.addClip(seq, 'video', 0, { startTicks: '0', endTicks: '10', projectItem: false });
  assert.strictEqual(clip.projectItem, null);
  assert.throws(() => clip.projectItem.getMediaPath(), TypeError);
});

test('nested and multicam clips have a projectItem whose media path is empty', () => {
  const { fake, seq } = sermonFake();
  const nested = fake.addClip(seq, 'video', 0, { name: 'Sermon Nest', startTicks: '0', endTicks: '10' });
  const multicam = fake.addClip(seq, 'video', 1, {
    name: 'Multi cam', startTicks: '0', endTicks: '10', mediaPath: ''
  });
  [nested, multicam].forEach((clip) => {
    assert.notStrictEqual(clip.projectItem, null);
    assert.strictEqual(clip.projectItem.getMediaPath(), '');
    assert.strictEqual(clip.getSpeed(), 1);
  });
});

test('speed-changed clip reports its multiplier and garbage in/out ticks', () => {
  const { fake, seq } = sermonFake();
  const clip = fake.addClip(seq, 'video', 0, {
    startTicks: '0', endTicks: '10', mediaPath: 'D:/18830001.MP4', speed: 1.1
  });
  assert.strictEqual(clip.getSpeed(), 1.1);
  assert.strictEqual(clip.inPoint.ticks, GARBAGE_IN_POINT_TICKS);
  assert.strictEqual(clip.projectItem.getMediaPath(), 'D:/18830001.MP4');
});

test('focusSequence changes app.project.activeSequence', () => {
  const { fake, seq } = sermonFake();
  const other = fake.addSequence({ id: 'seq-b', name: 'Other' });
  assert.strictEqual(fake.app.project.activeSequence, seq);
  fake.focusSequence('seq-b');
  assert.strictEqual(fake.app.project.activeSequence, other);
  assert.throws(() => fake.focusSequence('nope'), /unknown sequence/);
});

test('a loaded script sees the focused sequence between calls', () => {
  const { fake } = sermonFake();
  fake.addSequence({ id: 'seq-b', name: 'Other' });
  const file = writeTemp('seq.jsx', [
    'var VS = {};',
    'VS.activeId = function () { return app.project.activeSequence.sequenceID; };'
  ].join('\n'));
  const { VS } = loadJsx(file, fake);
  assert.strictEqual(VS.activeId(), 'seq-a');
  fake.focusSequence('seq-b');
  assert.strictEqual(VS.activeId(), 'seq-b');
});
