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

// ---- text layout: wrapping and splitting at insert time (docs/15) -------------------------------

var Layout = require(path.join(root, 'panel', 'js', 'layout.js'));

var FRAME = '8475667200';
var TPS = Timemap.TICKS_PER_SECOND;
var LAYOUT_ON = { autoWrap: true, maxCharsPerLine: 80, maxLinesPerGraphic: 4 };
var LAYOUT_OFF = { autoWrap: false, maxCharsPerLine: 80, maxLinesPerGraphic: 4 };
var SPLIT = { autoWrap: true, maxCharsPerLine: 60, maxLinesPerGraphic: 3 };

// Public-domain text (KJV), verse numbers included, as the Bible text service returns it.
var JOHN_3 = '16 For God so loved the world, that he gave his only begotten Son, that whosoever ' +
  'believeth in him should not perish, but have everlasting life. ' +
  '17 For God sent not his Son into the world to condemn the world; but that the world through him ' +
  'might be saved. ' +
  '18 He that believeth on him is not condemned: but he that believeth not is condemned already, ' +
  'because he hath not believed in the name of the only begotten Son of God.';

function ctxWith(model, placements, layout) {
  var ctx = ctxFor(model, placements, layout);
  ctx.frameTicks = FRAME;
  return ctx;
}

// Three enabled cues; the middle one is John 3:16-18 and splits into three graphics at 60 x 3,
// the other two are a single short line each.
function passageModel(patch) {
  var base = fixture('cue-documents', 'happy-18-cues.json');
  base.cues = base.cues.slice(0, 3);
  base.cues.forEach(function (c) { c.flags = []; c.enabled = true; });
  [0, 2].forEach(function (i) {
    base.cues[i].body = 'Jesus wept.';
    base.cues[i].body_word_count = 2;
  });
  var middle = base.cues[1];
  middle.reference = { book: 'John', osis: 'John', chapter: 3, verse: 16, verse_end: 18 };
  middle.reference_display = 'John 3:16-18 (KJV)';
  middle.body = JOHN_3;
  middle.body_word_count = JOHN_3.split(' ').length;
  Object.keys(patch || {}).forEach(function (k) { middle[k] = patch[k]; });
  var loaded = Cues.load(JSON.stringify(base));
  assert.ok(loaded.ok, loaded.error);
  return loaded.model;
}

// Frame-aligned placements: cue i starts at frame 100 + 1000 * i and lasts 300 frames.
function framePlacements(model) {
  var out = {};
  model.cues().forEach(function (c, i) {
    var at = BigInt(FRAME) * BigInt(100 + 1000 * i);
    var dur = BigInt(FRAME) * 300n;
    out[c.id] = { atTicks: String(at), durationTicks: String(dur), endTicks: String(at + dur), panelFlags: [] };
  });
  return out;
}

function partsOf(payload, cueId) {
  return payload.cues.filter(function (c) { return c.id === cueId || c.id.indexOf(cueId + '#') === 0; });
}

test('an unsplit cue goes in as it does today, apart from the line breaks in its body', function () {
  var model = modelFrom('happy-18-cues.json');
  var placements = mapped(model);
  var off = Insert.buildPayload(model, placements, ctxWith(model, placements, LAYOUT_OFF));
  var on = Insert.buildPayload(model, placements, ctxWith(model, placements, LAYOUT_ON));

  // Wrap off is exactly the payload from before layout existed.
  var expected = model.cues().filter(function (c) { return c.enabled; }).map(function (c) {
    return {
      id: c.id,
      atTicks: placements[c.id].atTicks,
      durationTicks: placements[c.id].durationTicks,
      reference: c.reference_display,
      body: c.body
    };
  }).sort(function (a, b) { return Number(a.atTicks) - Number(b.atTicks); });
  assert.deepStrictEqual(off.cues, expected);

  // Wrap on changes the body's line breaks and, for a cue that does not fit, the number of graphics.
  var byId = {};
  on.cues.forEach(function (c) { byId[c.id] = c; });
  var unsplit = expected.filter(function (c) { return byId[c.id + '#2'] === undefined; });
  assert.ok(unsplit.length > 0 && unsplit.length < expected.length);
  unsplit.forEach(function (c) {
    var got = byId[c.id];
    assert.strictEqual(got.body, Layout.wrapText(c.body, 80));
    assert.strictEqual(got.body.replace(/\n/g, ' '), c.body);
    assert.deepStrictEqual(Object.keys(got), Object.keys(c));
    ['id', 'atTicks', 'durationTicks', 'reference'].forEach(function (k) {
      assert.strictEqual(got[k], c[k]);
    });
  });
  assert.deepStrictEqual(
    { sequenceId: on.sequenceId, mogrtPath: on.mogrtPath, trackIndex: on.trackIndex, mapping: on.mapping },
    { sequenceId: off.sequenceId, mogrtPath: off.mogrtPath, trackIndex: off.trackIndex, mapping: off.mapping });
});

test('settings without the layout keys leave the body alone', function () {
  var model = simpleModel();
  var placements = simplePlacements(model);
  var payload = Insert.buildPayload(model, placements, ctxFor(model, placements));
  assert.deepStrictEqual(payload.cues.map(function (c) { return c.body; }),
    model.cues().map(function (c) { return c.body; }));
});

test('a passage that does not fit becomes parts that keep the reference and take ids #2, #3', function () {
  var model = passageModel();
  var placements = framePlacements(model);
  var payload = Insert.buildPayload(model, placements, ctxWith(model, placements, SPLIT));
  var ids = model.cues().map(function (c) { return c.id; });

  assert.deepStrictEqual(payload.cues.map(function (c) { return c.id; }),
    [ids[0], ids[1], ids[1] + '#2', ids[1] + '#3', ids[2]]);
  var parts = partsOf(payload, ids[1]);
  parts.forEach(function (p) {
    assert.strictEqual(p.reference, 'John 3:16-18 (KJV)');
    assert.ok(p.body.split('\n').length <= 3);
    assert.ok(p.body.split('\n').every(function (line) { return line.length <= 60; }));
    assert.deepStrictEqual(Object.keys(p), ['id', 'atTicks', 'durationTicks', 'reference', 'body']);
  });
  assert.strictEqual(parts.map(function (p) { return p.body; }).join(' ').replace(/\n/g, ' '), JOHN_3);
  assert.ok(parts[0].body.indexOf('16 For God') === 0 && parts[1].body.indexOf('17 For God') === 0);
});

test('parts sit back to back and their durations add up to the cue exactly', function () {
  var model = passageModel();
  var placements = framePlacements(model);
  var cue = model.cues()[1];
  var payload = Insert.buildPayload(model, placements, ctxWith(model, placements, SPLIT));
  var parts = partsOf(payload, cue.id);
  var p = placements[cue.id];

  assert.strictEqual(parts.length, 3);
  assert.strictEqual(parts[0].atTicks, p.atTicks);
  var sum = 0n;
  parts.forEach(function (part, i) {
    assert.strictEqual(BigInt(part.atTicks) % BigInt(FRAME), 0n);
    assert.ok(BigInt(part.durationTicks) > 0n);
    if (i > 0) {
      assert.strictEqual(BigInt(part.atTicks),
        BigInt(parts[i - 1].atTicks) + BigInt(parts[i - 1].durationTicks));
    }
    sum += BigInt(part.durationTicks);
  });
  assert.strictEqual(sum, BigInt(p.durationTicks));
  assert.strictEqual(BigInt(parts[2].atTicks) + BigInt(parts[2].durationTicks), BigInt(p.endTicks));
});

test('verse_offsets_s time the parts, and a nudged cue moves them with it', function () {
  var model = passageModel({ verse_offsets_s: { '17': 4, '18': 7 } });
  var placements = framePlacements(model);
  var cue = model.cues()[1];
  var first = partsOf(Insert.buildPayload(model, placements, ctxWith(model, placements, SPLIT)), cue.id);
  var starts = first.map(function (c) { return BigInt(c.atTicks); });
  var at = BigInt(placements[cue.id].atTicks);
  function snapped(seconds) {
    var f = BigInt(FRAME);
    return at + ((BigInt(Math.round(seconds * TPS)) + f / 2n) / f) * f;
  }
  assert.deepStrictEqual(starts, [at, snapped(4), snapped(7)]);

  // Nudge by 5 frames: the same offsets from a later anchor, so every part moves by the same amount.
  var nudged = {};
  Object.keys(placements).forEach(function (id) { nudged[id] = Object.assign({}, placements[id]); });
  var shift = BigInt(FRAME) * 5n;
  nudged[cue.id].atTicks = String(BigInt(nudged[cue.id].atTicks) + shift);
  var moved = partsOf(Insert.buildPayload(model, nudged, ctxWith(model, nudged, SPLIT)), cue.id);
  assert.deepStrictEqual(moved.map(function (c) { return BigInt(c.atTicks); }),
    starts.map(function (s) { return s + shift; }));
  assert.deepStrictEqual(moved.map(function (c) { return c.durationTicks; }),
    first.map(function (c) { return c.durationTicks; }));
});

test('with no recorded offsets the parts share the cue by their words', function () {
  var model = passageModel();
  var placements = framePlacements(model);
  var cue = model.cues()[1];
  var parts = partsOf(Insert.buildPayload(model, placements, ctxWith(model, placements, SPLIT)), cue.id);
  var words = parts.map(function (p) { return p.body.split(/\s+/).length; });
  var durations = parts.map(function (p) { return BigInt(p.durationTicks); });
  var longest = words.indexOf(Math.max.apply(null, words));
  assert.ok(durations.every(function (d) { return d <= durations[longest]; }));
});

test('parts of two cues are ordered by start, and equal starts keep part order', function () {
  var model = passageModel();
  var placements = framePlacements(model);
  var ids = model.cues().map(function (c) { return c.id; });
  // The last cue starts inside the split cue's span, between two of its parts.
  placements[ids[2]].atTicks = String(BigInt(placements[ids[1]].atTicks) + BigInt(FRAME) * 150n);
  var payload = Insert.buildPayload(model, placements, ctxWith(model, placements, SPLIT));
  var starts = payload.cues.map(function (c) { return BigInt(c.atTicks); });
  starts.forEach(function (s, i) { if (i > 0) { assert.ok(s >= starts[i - 1]); } });
  assert.deepStrictEqual(partsOf(payload, ids[1]).map(function (c) { return c.id; }),
    [ids[1], ids[1] + '#2', ids[1] + '#3']);
});

test('the conflict check covers every part of a split cue', async function () {
  var model = passageModel();
  var placements = framePlacements(model);
  var payload = Insert.buildPayload(model, placements, ctxWith(model, placements, SPLIT));
  var ranges = Insert.rangesOf(payload);
  assert.strictEqual(ranges.length, 5);
  ranges.forEach(function (r, i) {
    assert.strictEqual(r.startTicks, payload.cues[i].atTicks);
    assert.strictEqual(BigInt(r.endTicks),
      BigInt(payload.cues[i].atTicks) + BigInt(payload.cues[i].durationTicks));
  });

  var sent = [];
  var bridge = {
    call: function (name, args) {
      sent.push({ name: name, args: args });
      return Promise.resolve({ ok: true, data: { conflicts: [
        { rangeIndex: 1, existingClipName: 'A' },
        { rangeIndex: 3, existingClipName: 'B' }
      ] } });
    }
  };
  var asked = [];
  var out = await Insert.execute({
    bridge: bridge, payload: payload, model: model,
    confirm: function (text) { asked.push(text); return false; }
  });
  assert.strictEqual(out.state, 'cancelled');
  assert.deepStrictEqual(sent[0].args.ranges, ranges);
  // Two of one cue's parts overwrite clips, and that is one cue.
  assert.deepStrictEqual(asked, ['1 of your cues will overwrite an existing clip on V3. Continue?']);
});

test('confirm text counts a split cue once, and each range as a cue without the payload', function () {
  var model = passageModel();
  var placements = framePlacements(model);
  var payload = Insert.buildPayload(model, placements, ctxWith(model, placements, SPLIT));
  var text = Insert.confirmText([
    { rangeIndex: 0, existingClipName: 'A' },
    { rangeIndex: 1, existingClipName: 'B' },
    { rangeIndex: 2, existingClipName: 'C' },
    { rangeIndex: 3, existingClipName: 'D' }
  ], 2, payload, model);
  assert.strictEqual(text, '2 of your cues will overwrite existing clips on V3. Continue?');
  assert.strictEqual(Insert.confirmText([{ rangeIndex: 0 }, { rangeIndex: 1 }], 2),
    '2 of your cues will overwrite existing clips on V3. Continue?');
});

test('a cue whose own id ends in #2 is not read as a second part when the model is known', function () {
  var model = passageModel();
  var ids = model.cues().map(function (c) { return c.id; });
  model.get(ids[2]).id = ids[0] + '#2';
  var placements = framePlacements(model);
  var payload = Insert.buildPayload(model, placements, ctxWith(model, placements, SPLIT));
  var conflicts = [{ rangeIndex: 0 }, { rangeIndex: 4 }];
  assert.strictEqual(payload.cues[4].id, ids[0] + '#2');
  assert.strictEqual(Insert.confirmText(conflicts, 0, payload, model),
    '2 of your cues will overwrite existing clips on V1. Continue?');
  assert.strictEqual(Insert.confirmText(conflicts, 0, payload),
    '1 of your cues will overwrite an existing clip on V1. Continue?');
});

test('wrapped text is never written back to the cue document', function () {
  var model = passageModel();
  var placements = framePlacements(model);
  var before = JSON.stringify([model.toJSON(), placements]);
  Insert.buildPayload(model, placements, ctxWith(model, placements, SPLIT));
  Insert.buildPayload(model, placements, ctxWith(model, placements, LAYOUT_ON));
  assert.strictEqual(JSON.stringify([model.toJSON(), placements]), before);
  assert.strictEqual(model.cues()[1].body, JOHN_3);
});

test('a split cue needs the frame length to be timed', function () {
  var model = passageModel();
  var placements = framePlacements(model);
  assert.throws(function () {
    Insert.buildPayload(model, placements, ctxFor(model, placements, SPLIT));
  }, /No frame length/);
  assert.doesNotThrow(function () {
    Insert.buildPayload(model, placements, ctxFor(model, placements, LAYOUT_OFF));
  });
});

test('graphicsFor lists the graphics of one cue, timed when it has a placement', function () {
  var model = passageModel();
  var placements = framePlacements(model);
  var cue = model.cues()[1];
  var timed = Insert.graphicsFor(cue, placements[cue.id], SPLIT, FRAME);
  assert.deepStrictEqual(timed.map(function (g) { return g.id; }), [cue.id, cue.id + '#2', cue.id + '#3']);
  assert.ok(timed.every(function (g) {
    return typeof g.atTicks === 'string' && typeof g.durationTicks === 'string';
  }));
  var untimed = Insert.graphicsFor(cue, null, SPLIT, FRAME);
  assert.deepStrictEqual(untimed.map(function (g) { return g.body; }), timed.map(function (g) { return g.body; }));
  assert.ok(untimed.every(function (g) { return g.atTicks === null && g.durationTicks === null; }));
  assert.strictEqual(Insert.graphicsFor(cue, placements[cue.id], LAYOUT_OFF, FRAME).length, 1);
});

test('a split batch is accepted by the host and every graphic lands', function () {
  var model = passageModel();
  var placements = framePlacements(model);
  var ctx = ctxWith(model, placements, SPLIT);
  ctx.sequenceId = 'seq-1';
  var payload = Insert.buildPayload(model, placements, ctx);
  assert.strictEqual(payload.cues.length, 5);

  var fake = fakePremiere.createFakePremiere();
  fake.addSequence({ id: 'seq-1', name: 'Main', videoTracks: 3, audioTracks: 1 });
  fake.registerMogrt(TEMPLATE, fakePremiere.AV_QUOTE_04_FIELDS);
  var res = JSON.parse(loadJsx(JSX, fake).VS.insertCues(JSON.stringify(payload)));
  assert.strictEqual(res.ok, true, res.error);
  assert.strictEqual(res.data.insertedCount, 5);
  assert.deepStrictEqual(res.data.results.map(function (r) { return r.id; }),
    payload.cues.map(function (c) { return c.id; }));
});
