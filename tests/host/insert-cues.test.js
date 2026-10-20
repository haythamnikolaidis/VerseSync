'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { loadJsx } = require('../lib/load-jsx');
const { createFakePremiere, AV_QUOTE_04_FIELDS } = require('../lib/fake-premiere');

const JSX = path.join(__dirname, '..', '..', 'panel', 'jsx', 'VerseSync.jsx');
const TEMPLATE = 'D:/Templates/AV_Quote_04.mogrt';
const BAD_TEMPLATE = 'D:/Templates/Missing.mogrt';
const TPS = 254016000000n; // ticks per second
// Property indices of the two Text fields in the fake AV_Quote_04.
const MAPPING = { referenceIndex: 3, bodyIndex: 11 };

function setup() {
  const fake = createFakePremiere();
  fake.addSequence({ id: 'seq-1', name: 'Main', videoTracks: 3, audioTracks: 1 });
  fake.registerMogrt(TEMPLATE, AV_QUOTE_04_FIELDS);
  return fake;
}

// Cues 10 s apart, each 4 s long: shorter than the template's own length, as
// the panel's timemap would clamp them, so nothing overlaps.
function makeCues(n) {
  const cues = [];
  for (let i = 0; i < n; i++) {
    cues.push({
      id: 'cue_' + i,
      atTicks: String(BigInt(i + 1) * 10n * TPS),
      durationTicks: String(4n * TPS),
      reference: 'Ref ' + i,
      body: 'Body text of cue number ' + i
    });
  }
  return cues;
}

function makeArgs(cues) {
  return {
    sequenceId: 'seq-1',
    mogrtPath: TEMPLATE,
    trackIndex: 2,
    mapping: MAPPING,
    cues: cues
  };
}

function insert(fake, args) {
  return JSON.parse(loadJsx(JSX, fake).VS.insertCues(JSON.stringify(args)));
}

function fieldValue(clip, index) {
  return JSON.parse(clip.getMGTComponent().properties[index].getValue());
}

test('20 cues land at 20 distinct absolute times with both fields and durations right', () => {
  const fake = setup();
  const cues = makeCues(20);
  const res = insert(fake, makeArgs(cues));
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.data.insertedCount, 20);
  assert.strictEqual(res.data.failedCount, 0);

  const clips = fake.app.project.activeSequence.videoTracks[2].clips;
  assert.strictEqual(clips.length, 20);
  const starts = clips.map((c) => c.start.ticks);
  assert.strictEqual(new Set(starts).size, 20);

  cues.forEach((cue, i) => {
    const clip = clips[i];
    assert.strictEqual(clip.start.ticks, cue.atTicks);
    assert.strictEqual(BigInt(clip.end.ticks) - BigInt(clip.start.ticks), BigInt(cue.durationTicks));
    const ref = fieldValue(clip, MAPPING.referenceIndex);
    const body = fieldValue(clip, MAPPING.bodyIndex);
    assert.strictEqual(ref.textEditValue, cue.reference);
    assert.deepStrictEqual(ref.fontTextRunLength, [cue.reference.length]);
    assert.strictEqual(body.textEditValue, cue.body);
    assert.deepStrictEqual(body.fontTextRunLength, [cue.body.length]);
  });
});

test('the undo log is exactly one begin/end pair', () => {
  const fake = setup();
  insert(fake, makeArgs(makeCues(20)));
  assert.deepStrictEqual(fake.undoLog, [
    { type: 'begin', name: 'VerseSync: Insert scriptures' },
    { type: 'end' }
  ]);
});

test('a mogrtPath that fails import is reported for every cue, with the undo group closed', () => {
  const fake = setup();
  fake.failImportFor(BAD_TEMPLATE);
  const args = makeArgs(makeCues(5));
  args.mogrtPath = BAD_TEMPLATE;
  const res = insert(fake, args);
  assert.strictEqual(res.data.failedCount, 5);
  assert.strictEqual(res.data.insertedCount, 0);
  assert.deepStrictEqual(res.data.results[0], {
    id: 'cue_0',
    ok: false,
    error: 'Premiere could not insert the template. Check the .mogrt path is still valid.'
  });
  assert.deepStrictEqual(fake.undoLog.map((e) => e.type), ['begin', 'end']);
});

test('a cue whose import fails is reported and the others still land', () => {
  const fake = setup();
  const seq = fake.app.project.activeSequence;
  const realImport = seq.importMGT;
  // Cue 2's import returns null; every other cue goes through the fake.
  seq.importMGT = function (p, ticks, v, a) {
    if (ticks === makeCues(5)[2].atTicks) {
      return null;
    }
    return realImport.call(seq, p, ticks, v, a);
  };
  const res = insert(fake, makeArgs(makeCues(5)));
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.data.insertedCount, 4);
  assert.strictEqual(res.data.failedCount, 1);
  assert.deepStrictEqual(res.data.results.map((r) => r.ok), [true, true, false, true, true]);
  assert.deepStrictEqual(res.data.results[2], {
    id: 'cue_2',
    ok: false,
    error: 'Premiere could not insert the template. Check the .mogrt path is still valid.'
  });
  assert.strictEqual(seq.videoTracks[2].clips.length, 4);
  assert.strictEqual(fake.openUndoGroups(), 0);
});

test('a template with no Motion Graphics component is reported with the section 9 message', () => {
  const fake = setup();
  const seq = fake.app.project.activeSequence;
  const realImport = seq.importMGT;
  seq.importMGT = function (p, ticks, v, a) {
    const clip = realImport.call(seq, p, ticks, v, a);
    clip.getMGTComponent = function () { return null; };
    return clip;
  };
  const res = insert(fake, makeArgs(makeCues(2)));
  assert.strictEqual(res.data.failedCount, 2);
  assert.strictEqual(
    res.data.results[0].error,
    'This template has no Motion Graphics component -- it may not be an After Effects template.'
  );
});

test('a cue that throws mid-way is isolated and the undo group still closes', () => {
  const fake = setup();
  const args = makeArgs(makeCues(3));
  args.mapping = { referenceIndex: 3, bodyIndex: 999 };
  const res = insert(fake, args);
  assert.strictEqual(res.data.failedCount, 3);
  assert.strictEqual(res.data.results[0].error, 'No property at index 999');
  // A failed cue must not leave a half-built default clip on the track.
  assert.strictEqual(fake.app.project.activeSequence.videoTracks[2].clips.length, 0);
  assert.deepStrictEqual(fake.undoLog.map((e) => e.type), ['begin', 'end']);
});

test('actualStartTicks is read back from the clip, not echoed from the request', () => {
  const fake = setup();
  const cues = makeCues(3);
  const res = insert(fake, makeArgs(cues));
  assert.deepStrictEqual(
    res.data.results.map((r) => ({ id: r.id, ok: r.ok, actualStartTicks: r.actualStartTicks })),
    cues.map((c) => ({ id: c.id, ok: true, actualStartTicks: c.atTicks }))
  );

  // If Premiere places the clip elsewhere, the result says so.
  const fake2 = setup();
  const seq = fake2.app.project.activeSequence;
  const realImport = seq.importMGT;
  seq.importMGT = function (p, ticks, v, a) {
    const clip = realImport.call(seq, p, ticks, v, a);
    clip.start = { ticks: String(BigInt(ticks) + 1n) };
    return clip;
  };
  const moved = insert(fake2, makeArgs(makeCues(1)));
  assert.strictEqual(moved.data.results[0].actualStartTicks, String(BigInt(makeCues(1)[0].atTicks) + 1n));
});

test('there are 20 progress events', () => {
  const fake = setup();
  const cues = makeCues(20);
  insert(fake, makeArgs(cues));
  const events = fake.events.filter((e) => e.type === 'com.versesync.progress');
  assert.strictEqual(events.length, 20);
  events.forEach((e, i) => {
    assert.deepStrictEqual(JSON.parse(e.data), { index: i, total: 20, id: 'cue_' + i, ok: true });
  });
});

test('progress events report failures with ok false', () => {
  const fake = setup();
  fake.failImportFor(TEMPLATE);
  insert(fake, makeArgs(makeCues(2)));
  const data = fake.events.map((e) => JSON.parse(e.data));
  assert.deepStrictEqual(data.map((d) => d.ok), [false, false]);
});

test('track.overlaps() stays empty when the durations come in pre-clamped', () => {
  const fake = setup();
  insert(fake, makeArgs(makeCues(20)));
  assert.deepStrictEqual(fake.app.project.activeSequence.videoTracks[2].overlaps(), []);
});
