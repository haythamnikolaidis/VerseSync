'use strict';

var test = require('node:test');
var assert = require('node:assert');

var VS = require('../panel/js/lib/host-stub');

var SEQ_2997 = '6f1c2b7e-3a54-4d0e-9b6a-2c8d1e5f7a90';
var SEQ_25 = 'd27a05c3-91be-4e68-b3f0-5a4c8e6d1127';

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

  var segments = JSON.parse(VS.getMediaSegments('{}')).data.segments;
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
    sequenceID: SEQ_2997,
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
    sequenceID: SEQ_2997,
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
  var payload = JSON.stringify({ sequenceID: SEQ_2997, mogrtPath: 'x', trackIndex: 9, mapping: {}, cues: [] });
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
    sequenceID: SEQ_2997,
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

test('getSequenceInfo and getMediaSegments report the same sequenceID for the active sequence', function () {
  VS.__setScenario({ sequence: 'sequence-2997', segments: 'segments-split' });
  assert.strictEqual(JSON.parse(VS.getSequenceInfo('{}')).data.sequenceID, SEQ_2997);
  assert.strictEqual(JSON.parse(VS.getMediaSegments('{}')).data.sequenceID, SEQ_2997);

  VS.__setScenario({ sequence: 'sequence-25' });
  assert.strictEqual(JSON.parse(VS.getSequenceInfo('{}')).data.sequenceID, SEQ_25);
  assert.strictEqual(JSON.parse(VS.getMediaSegments('{}')).data.sequenceID, SEQ_25);
  VS.__setScenario({ sequence: 'sequence-2997', segments: 'segments-single' });
});

function sequenceGuardPayload(sequenceID) {
  var payload = {
    mogrtPath: 'D:/Templates/AV_Quote_04.mogrt',
    trackIndex: 2,
    mapping: { referenceIndex: 11, bodyIndex: 3 },
    cues: [{ id: 'cue_001', atTicks: '100000000000', durationTicks: '6000000000', reference: 'John 3:16 (KJV)', body: '...' }]
  };
  if (sequenceID !== undefined) { payload.sequenceID = sequenceID; }
  return JSON.stringify(payload);
}

test('insertCues: a sequenceID that no longer matches the active sequence inserts nothing (R-13)', function () {
  // Cues are mapped while the sermon sequence is active, then the editor clicks another tab.
  VS.__setScenario({ sequence: 'sequence-2997', segments: 'segments-single' });
  var captured = JSON.parse(VS.getMediaSegments('{}')).data.sequenceID;
  VS.__setScenario({ sequence: 'sequence-25' });
  try {
    var response = JSON.parse(VS.insertCues(sequenceGuardPayload(captured)));
    assert.deepStrictEqual(response, {
      ok: false,
      code: 'sequence_changed',
      error: 'The active sequence in Premiere changed after these cues were generated. ' +
        'Switch back to the original sequence tab, then click Insert again. Nothing was inserted.'
    });
    assert.strictEqual(response.data, undefined);

    // Switching back makes the identical payload succeed.
    VS.__setScenario({ sequence: 'sequence-2997' });
    var retry = JSON.parse(VS.insertCues(sequenceGuardPayload(captured)));
    assert.strictEqual(retry.ok, true);
    assert.strictEqual(retry.data.insertedCount, 1);
  } finally {
    VS.__setScenario({ sequence: 'sequence-2997' });
  }
});

test('insertCues: the sequence check runs before the track check', function () {
  // Track 9 is out of range for both sequences; the mismatch must be reported first.
  VS.__setScenario({ sequence: 'sequence-25' });
  var payload = JSON.stringify({ sequenceID: SEQ_2997, mogrtPath: 'x', trackIndex: 9, mapping: {}, cues: [] });
  var response = JSON.parse(VS.insertCues(payload));
  assert.strictEqual(response.code, 'sequence_changed');
  VS.__setScenario({ sequence: 'sequence-2997' });
});

test('insertCues: a missing or empty sequenceID is rejected without a code', function () {
  VS.__setScenario({ sequence: 'sequence-2997' });
  var expected = {
    ok: false,
    error: 'Internal error: insert request is missing the sequence ID. Please report this.'
  };
  assert.deepStrictEqual(JSON.parse(VS.insertCues(sequenceGuardPayload(undefined))), expected);
  assert.deepStrictEqual(JSON.parse(VS.insertCues(sequenceGuardPayload(''))), expected);
});

test('insertCues: with no active sequence the open-a-sequence message wins over the ID check', function () {
  VS.__setScenario({ sequence: 'sequence-none' });
  var response = JSON.parse(VS.insertCues(sequenceGuardPayload(SEQ_2997)));
  assert.deepStrictEqual(response, { ok: false, error: 'Open a sequence in Premiere first.' });
  VS.__setScenario({ sequence: 'sequence-2997' });
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
  var happy = JSON.parse(VS.validateTrack('{"trackIndex":2,"ranges":[]}'));
  assert.deepStrictEqual(happy, { ok: true, data: { conflicts: [] } });

  var bad = JSON.parse(VS.validateTrack('{"trackIndex":99,"ranges":[]}'));
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

test('activation: window.VS is NOT set inside Premiere (__adobe_cep__), even with ?stub=1', function () {
  global.window = { location: { search: '?stub=1' }, __adobe_cep__: {} };
  try {
    freshStub();
    assert.strictEqual(global.window.VS, undefined);
  } finally {
    delete global.window;
  }
});

test('activation: ?hostSequence and ?hostSegments query params select a scenario', function () {
  global.window = { location: { search: '?hostSequence=sequence-25&hostSegments=segments-duplicate' } };
  try {
    var stub = freshStub();
    assert.deepStrictEqual(stub.__getScenario(), { sequence: 'sequence-25', segments: 'segments-duplicate' });
  } finally {
    delete global.window;
    freshStub(); // restore a window-less module for any test file that runs after this one
  }
});
