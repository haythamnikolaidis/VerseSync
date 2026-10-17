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

const { FatalHostError, AV_QUOTE_04_FIELDS } = require('../lib/fake-premiere');

const TEMPLATE = 'D:/Templates/AV_Quote_04.mogrt';

function mgtFake() {
  const { fake, seq } = sermonFake();
  fake.registerMogrt(TEMPLATE, AV_QUOTE_04_FIELDS, { durationTicks: '100' });
  return { fake: fake, seq: seq };
}

function span(clip) {
  return [clip.start.ticks, clip.end.ticks];
}

test('importMGT places a clip exactly at the requested ticks', () => {
  const { seq } = mgtFake();
  const clip = seq.importMGT(TEMPLATE, '1000', 1, 0);
  assert.deepStrictEqual(span(clip), ['1000', '1100']);
  assert.strictEqual(clip.name, 'AV_Quote_04');
  assert.deepStrictEqual(seq.videoTracks[1].clips, [clip]);
});

test('importMGT returns null for a template marked failing', () => {
  const { fake, seq } = mgtFake();
  fake.failImportFor(TEMPLATE);
  assert.strictEqual(seq.importMGT(TEMPLATE, '0', 0, 0), null);
  assert.strictEqual(seq.videoTracks[0].clips.length, 0);
});

test('importMGT of an unregistered template is NotModelled', () => {
  const { seq } = mgtFake();
  assert.throws(() => seq.importMGT('D:/other.mogrt', '0', 0, 0), /NotModelled/);
});

test('importMGT trims the tail of the clip it lands on (T-03 single overlap)', () => {
  const { fake, seq } = mgtFake();
  const before = fake.addClip(seq, 'video', 0, { startTicks: '0', endTicks: '500' });
  const after = fake.addClip(seq, 'video', 0, { startTicks: '600', endTicks: '900' });
  const added = seq.importMGT(TEMPLATE, '450', 0, 0);
  assert.deepStrictEqual(span(before), ['0', '450']);
  assert.deepStrictEqual(span(added), ['450', '550']);
  assert.deepStrictEqual(span(after), ['600', '900']);
  assert.deepStrictEqual(seq.videoTracks[0].clips, [before, added, after]);
  assert.deepStrictEqual(seq.videoTracks[0].overlaps(), []);
});

test('importMGT trims the front of a clip it encroaches on, in any order', () => {
  const { fake, seq } = mgtFake();
  const later = fake.addClip(seq, 'video', 0, { startTicks: '350', endTicks: '900' });
  const added = seq.importMGT(TEMPLATE, '300', 0, 0);
  assert.deepStrictEqual(span(added), ['300', '400']);
  assert.deepStrictEqual(span(later), ['400', '900']);
  assert.deepStrictEqual(seq.videoTracks[0].overlaps(), []);
});

test('importMGT removes a clip it fully covers and refuses an unmeasured split', () => {
  const { fake, seq } = mgtFake();
  const covered = fake.addClip(seq, 'video', 0, { startTicks: '310', endTicks: '390' });
  const added = seq.importMGT(TEMPLATE, '300', 0, 0);
  assert.deepStrictEqual(seq.videoTracks[0].clips, [added]);
  assert.strictEqual(covered.start.ticks, '310');
  fake.addClip(seq, 'video', 1, { startTicks: '0', endTicks: '1000' });
  assert.throws(() => seq.importMGT(TEMPLATE, '300', 1, 0), /NotModelled/);
});

test('getMGTComponent exposes the AV_Quote_04 group and text nodes', () => {
  const { seq } = mgtFake();
  const props = seq.importMGT(TEMPLATE, '0', 0, 0).getMGTComponent().properties;
  assert.strictEqual(props.numItems, 12);
  assert.strictEqual(props[2].propertyType, 10);
  assert.strictEqual(props[2].displayName, 'Title Main');
  assert.strictEqual(props[3].propertyType, 6);
  assert.strictEqual(props[3].displayName, 'Text');
  assert.strictEqual(props[10].propertyType, 4);
  assert.strictEqual(props[10].displayName, 'Description');
  assert.strictEqual(props[11].propertyType, 5);
  assert.strictEqual(props[11].displayName, 'Text');
});

test('textEditValue and fontTextRunLength written through setValue read back', () => {
  const { seq } = mgtFake();
  const props = seq.importMGT(TEMPLATE, '0', 0, 0).getMGTComponent().properties;
  const data = JSON.parse(props[3].getValue());
  data.textEditValue = 'For God so loved the world';
  data.fontTextRunLength = [26];
  props[3].setValue(JSON.stringify(data), true);
  const back = JSON.parse(props[3].getValue());
  assert.strictEqual(back.textEditValue, 'For God so loved the world');
  assert.deepStrictEqual(back.fontTextRunLength, [26]);
  assert.strictEqual(JSON.parse(props[11].getValue()).textEditValue, '');
});

test('getMGTComponent on a plain clip is NotModelled', () => {
  const { fake, seq } = sermonFake();
  const clip = fake.addClip(seq, 'video', 0, { startTicks: '0', endTicks: '10' });
  assert.throws(() => clip.getMGTComponent(), /NotModelled/);
});

test('clip.remove detaches a clip from its track', () => {
  const { seq } = mgtFake();
  const clip = seq.importMGT(TEMPLATE, '0', 0, 0);
  clip.remove(false, true);
  assert.strictEqual(seq.videoTracks[0].clips.length, 0);
});

test('undo groups are logged and an imbalance is detectable', () => {
  const { fake } = sermonFake();
  assert.strictEqual(fake.openUndoGroups(), 0);
  fake.app.beginUndoGroup('VS_insert');
  assert.strictEqual(fake.openUndoGroups(), 1);
  fake.app.endUndoGroup();
  assert.strictEqual(fake.openUndoGroups(), 0);
  assert.deepStrictEqual(fake.undoLog, [{ type: 'begin', name: 'VS_insert' }, { type: 'end' }]);
  fake.app.endUndoGroup();
  assert.strictEqual(fake.openUndoGroups(), -1);
});

test('assigning clip.end leaves an overlap that track.overlaps() reports (T-03 Case 4)', () => {
  const { fake, seq } = sermonFake();
  const a = fake.addClip(seq, 'video', 0, { startTicks: '0', endTicks: '100' });
  const b = fake.addClip(seq, 'video', 0, { startTicks: '100', endTicks: '200' });
  assert.deepStrictEqual(seq.videoTracks[0].overlaps(), []);
  a.end = { ticks: '150' };
  assert.strictEqual(a.end.ticks, '150');
  assert.strictEqual(b.start.ticks, '100');
  assert.deepStrictEqual(seq.videoTracks[0].overlaps(), [[a, b]]);
});

test('CSXSEvent.dispatch records to fake.events', () => {
  const { fake } = sermonFake();
  const ev = new fake.CSXSEvent();
  ev.type = 'com.versesync.progress';
  ev.data = '{"done":1}';
  ev.dispatch();
  assert.deepStrictEqual(fake.events, [
    { type: 'com.versesync.progress', data: '{"done":1}', scope: 'APPLICATION' }
  ]);
});

test('a loaded script can dispatch CSXSEvent through the sandbox global', () => {
  const { fake } = sermonFake();
  const file = writeTemp('evt.jsx', [
    'var VS = {};',
    'VS.emit = function () { var e = new CSXSEvent(); e.type = "t"; e.data = "d"; e.dispatch(); };'
  ].join('\n'));
  loadJsx(file, fake).VS.emit();
  assert.strictEqual(fake.events[0].type, 't');
});

test('out-of-range track access is fatal, uncatchable by script try/catch', () => {
  const { fake, seq } = sermonFake();
  assert.strictEqual(seq.videoTracks.numTracks, 2);
  const file = writeTemp('fatal.jsx', [
    'var VS = {};',
    'VS.caught = false;',
    'VS.run = function () {',
    '  app.beginUndoGroup("VS_insert");',
    '  try { app.project.activeSequence.videoTracks[5].clips; } catch (e) { VS.caught = true; }',
    '  app.endUndoGroup();',
    '  return "finished";',
    '};'
  ].join('\n'));
  const { VS } = loadJsx(file, fake);
  assert.throws(() => VS.run(), (err) => err instanceof FatalHostError && /videoTracks\[5\]/.test(err.message));
  assert.strictEqual(fake.fatalErrors.length, 1);
  assert.strictEqual(fake.fatal, null);
});

test('a fatal track error inside a script leaves the undo group open', () => {
  const { fake } = sermonFake();
  const file = writeTemp('fatal2.jsx', [
    'var VS = {};',
    'VS.run = function () {',
    '  app.beginUndoGroup("VS_insert");',
    '  var t = app.project.activeSequence.videoTracks[9];',
    '  app.endUndoGroup();',
    '};'
  ].join('\n'));
  assert.throws(() => loadJsx(file, fake).VS.run(), FatalHostError);
  assert.strictEqual(fake.openUndoGroups(), 1);
});
