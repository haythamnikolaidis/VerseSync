'use strict';

var test = require('node:test');
var assert = require('node:assert');

var VS = require('../panel/js/lib/host-stub');

// Must equal "sequenceId" in tests/fixtures/host/sequence-2997.json; the sync test enforces
// that getSequenceInfo returns the fixture, so a drift fails there.
var ID_2997 = '7f3c2a10-5b8e-4d21-9c47-1e6a0b93d5f2';

function freshStub() {
  delete require.cache[require.resolve('../panel/js/lib/host-stub')];
  return require('../panel/js/lib/host-stub');
}

test('ping', function () {
  var response = JSON.parse(VS.ping('{}'));
  assert.deepStrictEqual(response, { ok: true, data: { pong: true, version: '1.0.0', hostApi: '1.1' } });
});

test('ticks are strings everywhere, never numbers', function () {
  VS.__setScenario({ sequence: 'sequence-2997', segments: 'segments-split' });
  var seqInfo = JSON.parse(VS.getSequenceInfo('{}')).data;
  assert.strictEqual(typeof seqInfo.playheadTicks, 'string');
  assert.strictEqual(typeof seqInfo.timebase, 'string');
  assert.strictEqual(typeof seqInfo.zeroPointTicks, 'string');
  assert.strictEqual(typeof seqInfo.endTicks, 'string');

  var segments = JSON.parse(VS.getMediaSegments(JSON.stringify({ sequenceId: ID_2997 }))).data.segments;
  segments.forEach(function (seg) {
    assert.strictEqual(typeof seg.seqStartTicks, 'string');
    assert.strictEqual(typeof seg.seqEndTicks, 'string');
    assert.strictEqual(typeof seg.inPointTicks, 'string');
    assert.strictEqual(typeof seg.durationTicks, 'string');
  });

  var setHeadResult = JSON.parse(VS.setPlayhead('{"ticks":"358996428390000"}'));
  assert.strictEqual(typeof setHeadResult.data.ticks, 'string');
  assert.strictEqual(setHeadResult.data.ticks, '358996428390000');
});

test('insertCues: happy path echoes actualStartTicks as a string per cue', function () {
  VS.__setScenario({ sequence: 'sequence-2997' });
  var payload = JSON.stringify({
    sequenceId: ID_2997,
    mogrtPath: 'D:/Templates/AV_Quote_04.mogrt',
    trackIndex: 2,
    mapping: { referenceIndex: 11, bodyIndex: 3 },
    cues: [
      { id: 'cue_001', atTicks: '100000000000', durationTicks: '6000000000', reference: 'John 3:16 (KJV)', body: '…' },
      { id: 'cue_002', atTicks: '200000000000', durationTicks: '6000000000', reference: 'Romans 8:28 (KJV)', body: '…' }
    ]
  });
  var response = JSON.parse(VS.insertCues(payload));
  assert.strictEqual(response.ok, true);
  assert.strictEqual(response.data.insertedCount, 2);
  assert.strictEqual(response.data.failedCount, 0);
  assert.deepStrictEqual(response.data.results, [
    { id: 'cue_001', ok: true, actualStartTicks: '100000000000' },
    { id: 'cue_002', ok: true, actualStartTicks: '200000000000' }
  ]);
});

test('insertCues: rejects unsorted input with the exact §9 error string', function () {
  VS.__setScenario({ sequence: 'sequence-2997' });
  var payload = JSON.stringify({
    sequenceId: ID_2997,
    mogrtPath: 'D:/Templates/AV_Quote_04.mogrt',
    trackIndex: 2,
    mapping: { referenceIndex: 11, bodyIndex: 3 },
    cues: [
      { id: 'cue_002', atTicks: '200000000000' },
      { id: 'cue_001', atTicks: '100000000000' }
    ]
  });
  var response = JSON.parse(VS.insertCues(payload));
  assert.deepStrictEqual(response, {
    ok: false,
    error: 'Internal error: cues must be sorted by time. Please report this.'
  });
});

test('insertCues: out-of-range trackIndex errors', function () {
  VS.__setScenario({ sequence: 'sequence-2997' }); // videoTrackCount: 4, valid 0-3
  var payload = JSON.stringify({ sequenceId: ID_2997, mogrtPath: 'x', trackIndex: 9, mapping: {}, cues: [] });
  var response = JSON.parse(VS.insertCues(payload));
  assert.deepStrictEqual(response, {
    ok: false,
    error: 'Track V10 no longer exists in this sequence. Click Refresh.'
  });
});

test('insertCues: no active sequence errors', function () {
  VS.__setScenario({ sequence: 'sequence-none' });
  var payload = JSON.stringify({ mogrtPath: 'x', trackIndex: 0, mapping: {}, cues: [] });
  var response = JSON.parse(VS.insertCues(payload));
  assert.deepStrictEqual(response, { ok: false, error: 'Open a sequence in Premiere first.' });
  VS.__setScenario({ sequence: 'sequence-2997' });
});

test('insertCues: a cue id ending in _importfail is a per-cue failure, not a top-level error', function () {
  VS.__setScenario({ sequence: 'sequence-2997' });
  var payload = JSON.stringify({
    sequenceId: ID_2997,
    mogrtPath: 'x',
    trackIndex: 2,
    mapping: {},
    cues: [
      { id: 'cue_001', atTicks: '100000000000' },
      { id: 'cue_002_importfail', atTicks: '200000000000' }
    ]
  });
  var response = JSON.parse(VS.insertCues(payload));
  assert.strictEqual(response.ok, true);
  assert.strictEqual(response.data.insertedCount, 1);
  assert.strictEqual(response.data.failedCount, 1);
  assert.strictEqual(response.data.results[1].ok, false);
  assert.strictEqual(
    response.data.results[1].error,
    'Premiere could not insert the template. Check the .mogrt path is still valid.'
  );
});

test('getMogrtFields: no active sequence errors with the field-discovery message', function () {
  VS.__setScenario({ sequence: 'sequence-none' });
  var response = JSON.parse(VS.getMogrtFields('{"path":"D:/Templates/AV_Quote_04.mogrt"}'));
  assert.deepStrictEqual(response, {
    ok: false,
    error: 'Open a sequence in Premiere first — reading a template\'s fields requires an active sequence.'
  });
  VS.__setScenario({ sequence: 'sequence-2997' });
});

test('getMogrtFields: an unrecognised path errors', function () {
  VS.__setScenario({ sequence: 'sequence-2997' });
  var response = JSON.parse(VS.getMogrtFields('{"path":"D:/Templates/some-other.mogrt"}'));
  assert.deepStrictEqual(response, {
    ok: false,
    error: 'Premiere could not insert the template. Check the .mogrt path is still valid.'
  });
});

test('validateTrack: happy path and out-of-range trackIndex', function () {
  VS.__setScenario({ sequence: 'sequence-2997' });
  var happy = JSON.parse(VS.validateTrack(JSON.stringify({ sequenceId: ID_2997, trackIndex: 2, ranges: [] })));
  assert.deepStrictEqual(happy, { ok: true, data: { conflicts: [] } });

  var bad = JSON.parse(VS.validateTrack(JSON.stringify({ sequenceId: ID_2997, trackIndex: 99, ranges: [] })));
  assert.deepStrictEqual(bad, {
    ok: false,
    error: 'Track V100 no longer exists in this sequence. Click Refresh.'
  });
});

test('setPlayhead: no active sequence errors', function () {
  VS.__setScenario({ sequence: 'sequence-none' });
  var response = JSON.parse(VS.setPlayhead('{"ticks":"1"}'));
  assert.deepStrictEqual(response, { ok: false, error: 'Open a sequence in Premiere first.' });
  VS.__setScenario({ sequence: 'sequence-2997' });
});

test('activation: window.VS is set when there is no CSInterface', function () {
  global.window = { location: { search: '' } };
  try {
    var stub = freshStub();
    assert.strictEqual(global.window.VS, stub);
  } finally {
    delete global.window;
  }
});

test('activation: window.VS is NOT set when CSInterface is present (real Premiere)', function () {
  global.window = { location: { search: '' }, CSInterface: function () {} };
  try {
    freshStub();
    assert.strictEqual(global.window.VS, undefined);
  } finally {
    delete global.window;
  }
});

test('activation: ?stub=1 forces activation even with CSInterface present', function () {
  global.window = { location: { search: '?stub=1' }, CSInterface: function () {} };
  try {
    var stub = freshStub();
    assert.strictEqual(global.window.VS, stub);
  } finally {
    delete global.window;
  }
});

test('activation: ?hostSequence and ?hostSegments query params select a scenario', function () {
  global.window = { location: { search: '?hostSequence=sequence-25&hostSegments=segments-duplicate' } };
  try {
    var stub = freshStub();
    assert.deepStrictEqual(stub.__getScenario(), { sequence: 'sequence-25', segments: 'segments-duplicate', focusedSequence: null });
  } finally {
    delete global.window;
    freshStub(); // restore a window-less module for any test file that runs after this one
  }
});

// ---- sequence identity (D20, risk R-13; docs/08 §3 and §9) ----

var CHANGED_MESSAGE =
  'The active sequence changed since this analysis. Switch back to "Sermon 2026-09-14" or click Analyse again.';

function insertPayload(extra) {
  var base = {
    mogrtPath: 'D:/Templates/AV_Quote_04.mogrt',
    trackIndex: 2,
    mapping: { referenceIndex: 11, bodyIndex: 3 },
    cues: [{ id: 'cue_001', atTicks: '100000000000', durationTicks: '6000000000' }]
  };
  Object.keys(extra).forEach(function (key) { base[key] = extra[key]; });
  return JSON.stringify(base);
}

test('sequence identity: getSequenceInfo returns a distinct sequenceId per sequence', function () {
  var seen = {};
  ['sequence-2997', 'sequence-23976', 'sequence-25'].forEach(function (name) {
    VS.__setScenario({ sequence: name });
    var id = JSON.parse(VS.getSequenceInfo('{}')).data.sequenceId;
    assert.strictEqual(typeof id, 'string');
    assert.ok(id.length > 0);
    assert.strictEqual(seen[id], undefined);
    seen[id] = true;
  });
  VS.__setScenario({ sequence: 'sequence-2997' });
});

test('sequence identity: a matching sequenceId passes on all three calls', function () {
  VS.__setScenario({ sequence: 'sequence-2997' });
  assert.strictEqual(JSON.parse(VS.getMediaSegments(JSON.stringify({ sequenceId: ID_2997 }))).ok, true);
  assert.strictEqual(
    JSON.parse(VS.validateTrack(JSON.stringify({ sequenceId: ID_2997, trackIndex: 2, ranges: [] }))).ok,
    true
  );
  assert.strictEqual(JSON.parse(VS.insertCues(insertPayload({ sequenceId: ID_2997 }))).ok, true);
});

test('sequence identity: a mismatched sequenceId returns the exact §9 message on all three calls', function () {
  VS.__setScenario({ sequence: 'sequence-2997' });
  VS.__setScenario({ focusedSequence: 'sequence-25' }); // editor switched tab after Analyse
  var expected = { ok: false, error: CHANGED_MESSAGE };
  assert.deepStrictEqual(JSON.parse(VS.getMediaSegments(JSON.stringify({ sequenceId: ID_2997 }))), expected);
  assert.deepStrictEqual(
    JSON.parse(VS.validateTrack(JSON.stringify({ sequenceId: ID_2997, trackIndex: 2, ranges: [] }))),
    expected
  );
  assert.deepStrictEqual(JSON.parse(VS.insertCues(insertPayload({ sequenceId: ID_2997 }))), expected);
  VS.__setScenario({ focusedSequence: null });
  assert.strictEqual(JSON.parse(VS.insertCues(insertPayload({ sequenceId: ID_2997 }))).ok, true);
});

test('sequence identity: the message names the sequence that owns the ID, not the active one', function () {
  VS.__setScenario({ sequence: 'sequence-25', focusedSequence: 'sequence-2997' });
  var idOf25 = '0e8b5a37-d6c4-4192-a8f3-3b71c9d04e5a';
  var response = JSON.parse(VS.insertCues(insertPayload({ sequenceId: idOf25 })));
  assert.deepStrictEqual(response, {
    ok: false,
    error: 'The active sequence changed since this analysis. Switch back to "UK Service 2026-09-27" or click Analyse again.'
  });
  VS.__setScenario({ sequence: 'sequence-2997' });
});

test('sequence identity: a sequenceId that matches no sequence returns the open-a-sequence message', function () {
  VS.__setScenario({ sequence: 'sequence-2997' });
  var response = JSON.parse(VS.insertCues(insertPayload({ sequenceId: 'no-such-sequence' })));
  assert.deepStrictEqual(response, { ok: false, error: 'Open a sequence in Premiere first.' });
});

test('sequence identity: a missing sequenceId on insertCues is ok:false and inserts nothing', function () {
  VS.__setScenario({ sequence: 'sequence-2997' });
  var response = JSON.parse(VS.insertCues(insertPayload({})));
  assert.strictEqual(response.ok, false);
  assert.strictEqual(response.data, undefined);
});

test('sequence identity: __setScenario({ sequence }) clears a simulated tab switch', function () {
  VS.__setScenario({ focusedSequence: 'sequence-25' });
  VS.__setScenario({ sequence: 'sequence-2997' });
  assert.strictEqual(VS.__getScenario().focusedSequence, null);
});
