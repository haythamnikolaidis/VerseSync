'use strict';

var test = require('node:test');
var assert = require('node:assert');
var path = require('node:path');

var root = path.join(__dirname, '..', '..');
var Insert = require(path.join(root, 'panel', 'js', 'insert.js'));
var Cues = require(path.join(root, 'panel', 'js', 'cues.js'));
var Timemap = require(path.join(root, 'panel', 'js', 'timemap.js'));
var loadJsx = require(path.join(root, 'tests', 'lib', 'load-jsx.js')).loadJsx;
var fakePremiere = require(path.join(root, 'tests', 'lib', 'fake-premiere.js'));

var JSX = path.join(root, 'panel', 'jsx', 'VerseSync.jsx');
var TEMPLATE = 'D:/Templates/AV_Quote_04.mogrt';

function fixture(dir, name) {
  return JSON.parse(JSON.stringify(
    require(path.join(root, 'tests', 'fixtures', dir, name))));
}

function modelFrom(name) {
  var loaded = Cues.load(JSON.stringify(fixture('cue-documents', name)));
  assert.ok(loaded.ok);
  return loaded.model;
}

function mapped(model, segmentsName) {
  var result = Timemap.mapCueDocument(model.toJSON(), {
    segments: fixture('host', segmentsName || 'segments-split.json'),
    seqInfo: fixture('host', 'sequence-2997.json')
  });
  model.applyPanelFlags(result.placements);
  return result.placements;
}

function settings(patch) {
  var s = {
    sidecarReady: true,
    sequenceOpen: true,
    mediaPath: 'C:\\media\\SERMON_A014.MXF',
    mogrtPath: TEMPLATE,
    mogrtFields: [{ index: 3, name: 'Text', group: 'Caption' }, { index: 11, name: 'Text', group: 'Title' }],
    translation: 'KJV',
    targetTrack: 2,
    referenceIndex: 3,
    bodyIndex: 11
  };
  Object.keys(patch || {}).forEach(function (k) { s[k] = patch[k]; });
  return s;
}

function ctxFor(model, placements, patch) {
  return {
    settings: settings(patch),
    sequenceId: '7f3c2a10-5b8e-4d21-9c47-1e6a0b93d5f2',
    model: model,
    placements: placements
  };
}

function simpleModel(cueFlags) {
  var base = fixture('cue-documents', 'happy-18-cues.json');
  base.cues = base.cues.slice(0, 3);
  base.cues.forEach(function (c, i) { c.flags = (cueFlags && cueFlags[i]) || []; c.enabled = true; });
  return Cues.load(JSON.stringify(base)).model;
}

function simplePlacements(model, patch) {
  var out = {};
  model.cues().forEach(function (c, i) {
    out[c.id] = {
      atTicks: String((i + 1) * 1000),
      durationTicks: '500',
      endTicks: String((i + 1) * 1000 + 500),
      panelFlags: (patch && patch[i]) || []
    };
  });
  return out;
}

test('a ready session has no blockers', function () {
  var model = modelFrom('happy-18-cues.json');
  var placements = mapped(model);
  assert.deepStrictEqual(Insert.blockers(ctxFor(model, placements)), []);
});

test('each shared blocker uses the VSState wording, in order', function () {
  var model = simpleModel();
  var placements = simplePlacements(model);
  function blockersWith(patch) { return Insert.blockers(ctxFor(model, placements, patch)); }

  assert.deepStrictEqual(blockersWith({ sequenceOpen: false }),
    ['Open a sequence in Premiere first.']);
  assert.deepStrictEqual(blockersWith({ mogrtPath: null, mogrtFields: null, referenceIndex: null, bodyIndex: null }),
    ['Select a template.']);
  assert.deepStrictEqual(blockersWith({ mogrtFields: [] }),
    ['This template has no editable text fields.']);
  assert.deepStrictEqual(blockersWith({ bodyIndex: null }), ['Map both template fields.']);
  assert.deepStrictEqual(blockersWith({ bodyIndex: 3 }),
    ['Reference and scripture must use different fields.']);
  assert.deepStrictEqual(blockersWith({ targetTrack: null }), ['Select a target track.']);
  assert.deepStrictEqual(blockersWith({ sequenceOpen: false, targetTrack: null }),
    ['Open a sequence in Premiere first.', 'Select a target track.']);
});

test('analyse-only conditions do not block insert', function () {
  var model = simpleModel();
  var placements = simplePlacements(model);
  var ctx = ctxFor(model, placements, { sidecarReady: false, mediaPath: null, translation: null });
  assert.deepStrictEqual(Insert.blockers(ctx), []);
});

test('no enabled cue blocks with the review hint', function () {
  var model = simpleModel();
  model.cues().forEach(function (c) { model.setEnabled(c.id, false); });
  var placements = simplePlacements(model);
  assert.deepStrictEqual(Insert.blockers(ctxFor(model, placements)),
    ['Enable at least one scripture to insert.']);
});

test('every flag that cannot be placed blocks, and names the cue ids', function () {
  var cueFlags = ['text_unavailable', 'passage_not_found', 'chapter_only'];
  var model = simpleModel(cueFlags.map(function (f) { return [f]; }));
  var ids = model.cues().map(function (c) { return c.id; });
  assert.deepStrictEqual(Insert.blockers(ctxFor(model, simplePlacements(model))),
    ['Resolve the flagged cues before inserting: ' + ids.join(', ')]);

  ['cut_from_edit', 'speed_change_unsupported'].forEach(function (flag) {
    var m = simpleModel();
    var placements = simplePlacements(m, [[], [flag], []]);
    assert.deepStrictEqual(Insert.blockers(ctxFor(m, placements)),
      ['Resolve the flagged cues before inserting: ' + m.cues()[1].id]);
  });
});

test('flags that only warn do not block', function () {
  var model = simpleModel([['low_confidence'], ['long_passage'], ['truncated']]);
  var placements = simplePlacements(model, [['overlap'], ['multiple_placements'], ['truncated']]);
  assert.deepStrictEqual(Insert.blockers(ctxFor(model, placements)), []);
});

test('a disabled flagged cue does not block', function () {
  var model = simpleModel([['text_unavailable'], [], []]);
  model.setEnabled(model.cues()[0].id, false);
  assert.deepStrictEqual(Insert.blockers(ctxFor(model, simplePlacements(model))), []);
});

test('blockers keep their order: shared, then enabled count, then flagged', function () {
  var model = simpleModel([['text_unavailable'], [], []]);
  var placements = simplePlacements(model);
  var out = Insert.blockers(ctxFor(model, placements, { targetTrack: null }));
  assert.deepStrictEqual(out, [
    'Select a target track.',
    'Resolve the flagged cues before inserting: ' + model.cues()[0].id
  ]);
  model.cues().forEach(function (c) { model.setEnabled(c.id, false); });
  assert.deepStrictEqual(Insert.blockers(ctxFor(model, placements, { targetTrack: null })), [
    'Select a target track.',
    'Enable at least one scripture to insert.'
  ]);
});

test('the payload carries the session values and the cue fields', function () {
  var model = simpleModel();
  var placements = simplePlacements(model);
  var payload = Insert.buildPayload(model, placements, ctxFor(model, placements));
  var first = model.cues()[0];
  assert.deepStrictEqual(Object.keys(payload),
    ['sequenceId', 'mogrtPath', 'trackIndex', 'mapping', 'cues']);
  assert.strictEqual(payload.sequenceId, '7f3c2a10-5b8e-4d21-9c47-1e6a0b93d5f2');
  assert.strictEqual(payload.mogrtPath, TEMPLATE);
  assert.strictEqual(payload.trackIndex, 2);
  assert.deepStrictEqual(payload.mapping, { referenceIndex: 3, bodyIndex: 11 });
  assert.deepStrictEqual(payload.cues[0], {
    id: first.id,
    atTicks: '1000',
    durationTicks: '500',
    reference: first.reference_display,
    body: first.body
  });
});

test('sorting is numeric, not by string', function () {
  var model = simpleModel();
  var placements = simplePlacements(model);
  var ids = model.cues().map(function (c) { return c.id; });
  placements[ids[0]].atTicks = '10';
  placements[ids[1]].atTicks = '9';
  placements[ids[2]].atTicks = '100';
  var payload = Insert.buildPayload(model, placements, ctxFor(model, placements));
  assert.deepStrictEqual(payload.cues.map(function (c) { return c.atTicks; }), ['9', '10', '100']);
  assert.deepStrictEqual(payload.cues.map(function (c) { return c.id; }), [ids[1], ids[0], ids[2]]);
});

test('sorting stays exact beyond 2^53 ticks', function () {
  var model = simpleModel();
  var placements = simplePlacements(model);
  var ids = model.cues().map(function (c) { return c.id; });
  placements[ids[0]].atTicks = '9007199254740993';
  placements[ids[1]].atTicks = '9007199254740992';
  placements[ids[2]].atTicks = '999999999999999';
  var payload = Insert.buildPayload(model, placements, ctxFor(model, placements));
  assert.deepStrictEqual(payload.cues.map(function (c) { return c.id; }), [ids[2], ids[1], ids[0]]);
});

test('equal starts keep document order', function () {
  var model = simpleModel();
  var placements = simplePlacements(model);
  var ids = model.cues().map(function (c) { return c.id; });
  ids.forEach(function (id) { placements[id].atTicks = '500'; });
  var payload = Insert.buildPayload(model, placements, ctxFor(model, placements));
  assert.deepStrictEqual(payload.cues.map(function (c) { return c.id; }), ids);
});

test('disabled cues are excluded', function () {
  var model = simpleModel();
  var placements = simplePlacements(model);
  var ids = model.cues().map(function (c) { return c.id; });
  model.setEnabled(ids[1], false);
  var payload = Insert.buildPayload(model, placements, ctxFor(model, placements));
  assert.deepStrictEqual(payload.cues.map(function (c) { return c.id; }), [ids[0], ids[2]]);
});

test('an enabled cue without a placement is an error, not a silent gap', function () {
  var model = simpleModel();
  var placements = simplePlacements(model);
  delete placements[model.cues()[1].id];
  assert.throws(function () {
    Insert.buildPayload(model, placements, ctxFor(model, placements));
  }, /No placement for cue/);
});

test('building the payload does not change the model or the placements', function () {
  var model = modelFrom('happy-18-cues.json');
  var placements = mapped(model);
  var before = JSON.stringify([model.toJSON(), placements]);
  Insert.buildPayload(model, placements, ctxFor(model, placements));
  assert.strictEqual(JSON.stringify([model.toJSON(), placements]), before);
});

test('confirm text for one conflict and for several', function () {
  assert.strictEqual(Insert.confirmText([{ rangeIndex: 3, existingClipName: 'Lower Third 02' }], 2),
    '1 of your cues will overwrite an existing clip on V3. Continue?');
  assert.strictEqual(Insert.confirmText([
    { rangeIndex: 0, existingClipName: 'A' },
    { rangeIndex: 3, existingClipName: 'B' },
    { rangeIndex: 7, existingClipName: 'C' }
  ], 2), '3 of your cues will overwrite existing clips on V3. Continue?');
});

test('confirm text counts cues, not clips, and names the right track', function () {
  var text = Insert.confirmText([
    { rangeIndex: 1, existingClipName: 'A' },
    { rangeIndex: 1, existingClipName: 'B' },
    { rangeIndex: 4, existingClipName: 'C' }
  ], 0);
  assert.strictEqual(text, '2 of your cues will overwrite existing clips on V1. Continue?');
});

test('the happy fixture payload never overlaps and is frame-aligned', function () {
  var model = modelFrom('happy-18-cues.json');
  var placements = mapped(model);
  var payload = Insert.buildPayload(model, placements, ctxFor(model, placements));
  assert.strictEqual(payload.cues.length, model.enabledCount());
  var timebase = BigInt(fixture('host', 'sequence-2997.json').timebase);
  var prevEnd = -1n;
  payload.cues.forEach(function (c) {
    var start = BigInt(c.atTicks);
    var end = start + BigInt(c.durationTicks);
    assert.ok(start >= prevEnd, c.id + ' starts before the previous cue ends');
    assert.ok(BigInt(c.durationTicks) > 0n);
    assert.strictEqual(start % timebase, 0n);
    assert.strictEqual(BigInt(c.durationTicks) % timebase, 0n);
    prevEnd = end;
  });
});

// The T-25.1 input contract, proved against the host itself on the fake: a payload that passes
// Insert.blockers is accepted by VS.insertCues, and every cue lands.
test('the payload satisfies the host input contract', function () {
  var model = modelFrom('happy-18-cues.json');
  var placements = mapped(model);
  var ctx = ctxFor(model, placements);
  ctx.sequenceId = 'seq-1';
  assert.deepStrictEqual(Insert.blockers(ctx), []);
  var payload = Insert.buildPayload(model, placements, ctx);

  var fake = fakePremiere.createFakePremiere();
  fake.addSequence({ id: 'seq-1', name: 'Main', videoTracks: 3, audioTracks: 1 });
  fake.registerMogrt(TEMPLATE, fakePremiere.AV_QUOTE_04_FIELDS);
  var res = JSON.parse(loadJsx(JSX, fake).VS.insertCues(JSON.stringify(payload)));
  assert.strictEqual(res.ok, true, res.error);
  assert.strictEqual(res.data.insertedCount, payload.cues.length);
  assert.strictEqual(res.data.failedCount, 0);
});
