'use strict';

var test = require('node:test');
var assert = require('node:assert');

var VS = require('../panel/js/lib/host-stub');

function freshStub() {
  delete require.cache[require.resolve('../panel/js/lib/host-stub')];
  return require('../panel/js/lib/host-stub');
}

test('ping', function () {
  var response = JSON.parse(VS.ping('{}'));
  assert.deepStrictEqual(response, { ok: true, data: { pong: true, version: '1.0.0', hostApi: '1.0' } });
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
  var payload = JSON.stringify({ mogrtPath: 'x', trackIndex: 9, mapping: {}, cues: [] });
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
