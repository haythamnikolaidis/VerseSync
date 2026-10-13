'use strict';

// Runs the real panel/jsx/VerseSync.jsx under Node against a mock of Premiere's object model
// (tests/lib/premiere-mock.js). This verifies the host's logic and its contract with the
// panel; it cannot verify that the real Premiere behaves like the mock, which is covered by
// the manual QA script and the spike evidence (docs/11-testing.md).

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var vm = require('node:vm');

var mock = require('./lib/premiere-mock');
var loadHost = require('./lib/load-host').loadHost;
var VSstub = require('../panel/js/lib/host-stub');

var FIXTURES_DIR = path.join(__dirname, 'fixtures', 'host');
var MOGRT = 'D:/Templates/AV_Quote_04.mogrt';

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name + '.json'), 'utf8'));
}

// A sequence for the mock, built from a getSequenceInfo fixture.
function sequenceFrom(fixture) {
  return {
    name: fixture.name,
    sequenceID: fixture.sequenceID,
    videoTracks: fixture.videoTrackCount,
    audioTracks: fixture.audioTrackCount,
    timebase: fixture.timebase,
    zeroPoint: fixture.zeroPointTicks,
    end: fixture.endTicks,
    playhead: fixture.playheadTicks
  };
}

function avQuoteTemplate(extra) {
  var t = { specs: mock.avQuote04Specs };
  Object.keys(extra || {}).forEach(function (k) { t[k] = extra[k]; });
  return t;
}

function setup(sequences, mogrts, options) {
  var premiere = mock.createPremiere({
    sequences: sequences,
    mogrts: mogrts || {}
  });
  return { premiere: premiere, host: loadHost(premiere, options) };
}

// Invariants that must hold after every host call, successful or not.
function assertCleanExit(premiere) {
  assert.strictEqual(premiere.state.undoDepth, 0, 'undo group left open');
  assert.strictEqual(premiere.state.fatalCalls, 0, 'host provoked a fatal ExtendScript error');
}

// ---- loading -------------------------------------------------------------------------------

test('loads with no native JSON and exposes every function as a var-expression global', function () {
  var env = setup([sequenceFrom(readFixture('sequence-2997'))]);
  ['ping', 'getSequenceInfo', 'getMogrtFields', 'setPlayhead'].forEach(function (name) {
    assert.strictEqual(typeof env.host.context.VS[name], 'function', name);
  });
});

test('the JSON polyfill is the one in use when the engine has no native JSON', function () {
  var env = setup([]);
  var parsed = JSON.parse(env.host.callRaw('ping'));
  assert.deepStrictEqual(parsed, { ok: true, data: { pong: true, version: '1.0.0', hostApi: '1.1' } });
  // The polyfill's stringify is a distinct function from Node's.
  assert.notStrictEqual(env.host.context.JSON.stringify, JSON.stringify);
});

test('polyfill stringify matches native output for the shapes the bridge carries', function () {
  var env = setup([]);
  var host = env.host.context;
  var samples = [
    { ok: true, data: { a: [1, 2.5, 'x', null, true, false], b: { c: 'q"\\\n\t\u0001' } } },
    { ok: false, error: 'Open a sequence in Premiere first \u2014 reading' },
    { ok: true, data: { fields: [] } },
    { s: 'Jesus wept. \u201cquoted\u201d \u00e9' }
  ];
  samples.forEach(function (sample) {
    // Rebuild the value inside the host's realm: the polyfill tests arrays with instanceof.
    var inRealm = vm.runInContext('(' + JSON.stringify(sample) + ')', host);
    var out = host.JSON.stringify(inRealm);
    assert.ok(/^[\x20-\x7e]*$/.test(out), 'polyfill output must be ASCII');
    assert.deepStrictEqual(JSON.parse(out), sample);
  });
  assert.strictEqual(host.JSON.stringify({ n: NaN, u: undefined }), '{"n":null}');
});

test('polyfill parse reads what stringify writes', function () {
  var env = setup([]);
  var host = env.host.context;
  var text = host.JSON.stringify({ path: 'D:\\Templates\\x.mogrt', n: [1, 2] });
  var back = host.JSON.parse(text);
  assert.strictEqual(back.path, 'D:\\Templates\\x.mogrt');
  assert.strictEqual(back.n[1], 2);
});

test('works with native JSON present too', function () {
  var env = setup([sequenceFrom(readFixture('sequence-2997'))], {}, { nativeJson: true });
  assert.strictEqual(env.host.call('ping').ok, true);
  assert.strictEqual(env.host.call('getSequenceInfo').data.hasActiveSequence, true);
});

// ---- VS.ping ---------------------------------------------------------------------------------

test('ping answers pong, version and hostApi 1.1, same as the stub', function () {
  var env = setup([]);
  var res = env.host.call('ping');
  assert.deepStrictEqual(res, { ok: true, data: { pong: true, version: '1.0.0', hostApi: '1.1' } });
  assert.deepStrictEqual(res, JSON.parse(VSstub.ping('{}')));
});

test('ping needs no sequence and tolerates a missing argument', function () {
  var env = setup([]);
  assert.strictEqual(JSON.parse(env.host.context.VS.ping()).ok, true);
});

// ---- VS.getSequenceInfo --------------------------------------------------------------------------

['sequence-2997', 'sequence-23976', 'sequence-25'].forEach(function (name) {
  test('getSequenceInfo reproduces fixture ' + name + ' exactly', function () {
    var fixture = readFixture(name);
    var env = setup([sequenceFrom(fixture)]);
    assert.deepStrictEqual(env.host.call('getSequenceInfo'), { ok: true, data: fixture });
    assertCleanExit(env.premiere);
  });
});

test('getSequenceInfo returns the real ticks-per-frame integer as a string, not a derived value', function () {
  var cases = [
    { fixture: 'sequence-2997', ticksPerFrame: '8475667200' },
    { fixture: 'sequence-23976', ticksPerFrame: '10594584000' },
    { fixture: 'sequence-25', ticksPerFrame: '10160640000' }
  ];
  cases.forEach(function (c) {
    var env = setup([sequenceFrom(readFixture(c.fixture))]);
    var data = env.host.call('getSequenceInfo').data;
    assert.strictEqual(data.timebase, c.ticksPerFrame);
    assert.strictEqual(typeof data.timebase, 'string');
    assert.strictEqual(Number(data.timebase) % 1, 0);
  });
});

test('timebase is passed through even when it does not match the rounded frame rate', function () {
  // A float-derived tick count would be 8475666666.67-ish and drift; the host must not do that.
  var seq = sequenceFrom(readFixture('sequence-2997'));
  seq.timebase = '8475667200';
  var env = setup([seq]);
  var data = env.host.call('getSequenceInfo').data;
  assert.strictEqual(data.timebase, '8475667200');
  assert.notStrictEqual(data.timebase, String(Math.round(254016000000 / 29.97)));
});

test('every ticks field is reported as a string', function () {
  var seq = sequenceFrom(readFixture('sequence-25'));
  seq.zeroPoint = '914457600000000';
  var env = setup([seq]);
  var data = env.host.call('getSequenceInfo').data;
  ['playheadTicks', 'timebase', 'zeroPointTicks', 'endTicks'].forEach(function (k) {
    assert.strictEqual(typeof data[k], 'string', k);
  });
});

test('getSequenceInfo with no sequence open reports hasActiveSequence false, not an error', function () {
  var env = setup([]);
  assert.deepStrictEqual(env.host.call('getSequenceInfo'), { ok: true, data: readFixture('sequence-none') });
});

test('getSequenceInfo follows whichever sequence is active and stamps its ID', function () {
  var a = sequenceFrom(readFixture('sequence-2997'));
  var b = sequenceFrom(readFixture('sequence-25'));
  var env = setup([a, b]);
  assert.strictEqual(env.host.call('getSequenceInfo').data.sequenceID, a.sequenceID);
  env.premiere.app.project.activeSequence = env.premiere.sequences[1];
  assert.strictEqual(env.host.call('getSequenceInfo').data.sequenceID, b.sequenceID);
});

test('getSequenceInfo errors cleanly when Premiere reports no sequence ID', function () {
  var seq = sequenceFrom(readFixture('sequence-2997'));
  seq.sequenceID = undefined;
  var env = setup([seq]);
  var res = env.host.call('getSequenceInfo');
  assert.strictEqual(res.ok, false);
  assert.ok(res.error.length > 0);
});

test('getSequenceInfo errors cleanly on an unusable timebase', function () {
  ['0', 'abc', ''].forEach(function (bad) {
    var seq = sequenceFrom(readFixture('sequence-2997'));
    seq.timebase = bad;
    var env = setup([seq]);
    var res = env.host.call('getSequenceInfo');
    assert.strictEqual(res.ok, false, 'timebase ' + JSON.stringify(bad));
  });
});

test('getSequenceInfo never throws when Premiere itself throws', function () {
  var env = setup([sequenceFrom(readFixture('sequence-2997'))]);
  env.premiere.sequences[0].getPlayerPosition = function () { throw new Error('boom'); };
  var res = env.host.call('getSequenceInfo');
  assert.strictEqual(res.ok, false);
  assert.ok(/boom/.test(res.error));
});

// ---- VS.getMogrtFields -----------------------------------------------------------------------------

function mogrtEnv(seqOpts, template) {
  var mogrts = {};
  mogrts[MOGRT] = template || avQuoteTemplate();
  return setup([seqOpts || sequenceFrom(readFixture('sequence-2997'))], mogrts);
}

test('both Text fields of AV_Quote_04 come back with distinct indices and group-qualified labels', function () {
  var env = mogrtEnv();
  var res = env.host.call('getMogrtFields', { path: MOGRT });
  assert.deepStrictEqual(res, { ok: true, data: readFixture('mogrt-fields') });
  assert.strictEqual(res.data.fields.length, 2);
  assert.notStrictEqual(res.data.fields[0].index, res.data.fields[1].index);
  assert.deepStrictEqual(res.data.fields.map(function (f) { return f.label; }),
    ['Title Main > Text', 'Description > Text']);
  assert.deepStrictEqual(res.data.fields.map(function (f) { return f.name; }), ['Text', 'Text']);
  assertCleanExit(env.premiere);
});

test('matches the stub field-for-field', function () {
  var env = mogrtEnv();
  var real = env.host.call('getMogrtFields', { path: MOGRT });
  assert.deepStrictEqual(real, JSON.parse(VSstub.getMogrtFields(JSON.stringify({ path: MOGRT }))));
});

test('field discovery inserts one scratch clip past the end of the sequence on the top track, inside an undo group', function () {
  var fixture = readFixture('sequence-2997');
  var env = mogrtEnv(sequenceFrom(fixture));
  env.host.call('getMogrtFields', { path: MOGRT });
  var calls = env.premiere.state.importCalls;
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].path, MOGRT);
  assert.strictEqual(calls[0].videoOffset, fixture.videoTrackCount - 1);
  assert.strictEqual(calls[0].audioOffset, 0);
  assert.strictEqual(calls[0].ticks, String(Number(fixture.endTicks) + 60 * mock.TICKS_PER_SECOND));
  assert.ok(Number(calls[0].ticks) > Number(fixture.endTicks));
  assert.strictEqual(calls[0].undoDepth, 1, 'insert must happen inside the undo group');
  assert.strictEqual(typeof calls[0].ticks, 'string');
});

test('the scratch clip is removed and the timeline is left untouched', function () {
  var env = mogrtEnv();
  env.host.call('getMogrtFields', { path: MOGRT });
  var inserted = env.premiere.state.insertedClips;
  assert.strictEqual(inserted.length, 1);
  assert.strictEqual(inserted[0].removed, true);
  for (var i = 0; i < env.premiere.sequences[0].videoTracks.numTracks; i++) {
    assert.strictEqual(env.premiere.sequences[0].videoTracks[i].clips.numItems, 0);
  }
  assertCleanExit(env.premiere);
});

test('cached nothing: two calls insert and remove two scratch clips', function () {
  var env = mogrtEnv();
  env.host.call('getMogrtFields', { path: MOGRT });
  env.host.call('getMogrtFields', { path: MOGRT });
  assert.strictEqual(env.premiere.state.importCalls.length, 2);
  assertCleanExit(env.premiere);
});

test('detection strategy 1: propertyType 6 is a text field', function () {
  var env = mogrtEnv(null, { specs: function () {
    return [{ displayName: 'Source Text', propertyType: 6, value: 'plain' }];
  } });
  var res = env.host.call('getMogrtFields', { path: MOGRT });
  assert.deepStrictEqual(res.data.fields.map(function (f) { return f.index; }), [0]);
});

test('detection strategy 2: propertyType 5 is a text field', function () {
  var env = mogrtEnv(null, { specs: function () {
    return [
      { displayName: 'Scale', propertyType: 1, value: 1 },
      { displayName: 'Source Text', propertyType: 5, value: 'plain' }
    ];
  } });
  var res = env.host.call('getMogrtFields', { path: MOGRT });
  assert.deepStrictEqual(res.data.fields.map(function (f) { return f.index; }), [1]);
});

test('detection strategy 3: a getValue() blob containing textEditValue is a text field', function () {
  var env = mogrtEnv(null, { specs: function () {
    return [
      { displayName: 'Scale', propertyType: 1, value: 100 },
      { displayName: 'Mystery', propertyType: 0, value: mock.textValue('hello') },
      { displayName: 'Other string', propertyType: 0, value: 'no key here' },
      { displayName: 'Throws', propertyType: 0, getValueThrows: true }
    ];
  } });
  var res = env.host.call('getMogrtFields', { path: MOGRT });
  assert.deepStrictEqual(res.data.fields.map(function (f) { return f.index; }), [1]);
  assert.strictEqual(res.data.fields[0].name, 'Mystery');
});

test('group nodes of type 10 and type 4 set the group of the fields that follow and are not fields', function () {
  var env = mogrtEnv(null, { specs: function () {
    return [
      { displayName: 'G10', propertyType: 10 },
      { displayName: 'A', propertyType: 6, value: 'x' },
      { displayName: 'G4', propertyType: 4 },
      { displayName: 'B', propertyType: 6, value: 'x' }
    ];
  } });
  var fields = env.host.call('getMogrtFields', { path: MOGRT }).data.fields;
  assert.deepStrictEqual(fields, [
    { index: 1, name: 'A', group: 'G10', label: 'G10 > A' },
    { index: 3, name: 'B', group: 'G4', label: 'G4 > B' }
  ]);
});

test('AV_Quote_04 as Premiere really reports it: no propertyType anywhere, groups found by GUID-list value', function () {
  var specs = mock.avQuote04Specs();
  specs.forEach(function (spec) { assert.strictEqual(spec.propertyType, undefined); });
  assert.strictEqual(specs.length, 46);
  var guidListRe = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12};?)+$/i;
  assert.ok(guidListRe.test(specs[2].value));
  assert.ok(guidListRe.test(specs[6].value));
  assert.strictEqual(specs[3].displayName, 'Text');
  assert.strictEqual(specs[7].displayName, 'Text');
  var env = mogrtEnv();
  var fields = env.host.call('getMogrtFields', { path: MOGRT }).data.fields;
  assert.deepStrictEqual(fields.map(function (f) { return f.group; }), ['Title Main', 'Description']);
  assert.deepStrictEqual(fields.map(function (f) { return f.index; }), [3, 7]);
});

test('a GUID-list header sets the group even when propertyType is undefined, and is not a field', function () {
  var env = mogrtEnv(null, { specs: function () {
    return [
      { displayName: 'Grp', value: 'aaaaaaaa-1111-2222-3333-444444444444' },
      { displayName: 'Body', value: mock.textValue('x') }
    ];
  } });
  var fields = env.host.call('getMogrtFields', { path: MOGRT }).data.fields;
  assert.deepStrictEqual(fields, [{ index: 1, name: 'Body', group: 'Grp', label: 'Grp > Body' }]);
});

test('a template with no groups gets numbered labels so identical names stay distinguishable', function () {
  var env = mogrtEnv(null, { specs: function () {
    return [
      { displayName: 'Text', propertyType: 6, value: 'x' },
      { displayName: 'Text', propertyType: 6, value: 'y' }
    ];
  } });
  var fields = env.host.call('getMogrtFields', { path: MOGRT }).data.fields;
  assert.deepStrictEqual(fields.map(function (f) { return f.label; }), ['Text #1', 'Text #2']);
  assert.deepStrictEqual(fields.map(function (f) { return f.index; }), [0, 1]);
});

test('a template with no text fields yields an empty list, not an error', function () {
  var env = mogrtEnv(null, { specs: function () {
    return [{ displayName: 'Scale', propertyType: 1, value: 100 }];
  } });
  assert.deepStrictEqual(env.host.call('getMogrtFields', { path: MOGRT }), { ok: true, data: { fields: [] } });
});

test('an unreadable properties collection yields an empty list and still cleans up', function () {
  var env = mogrtEnv(null, avQuoteTemplate({ numItemsThrows: true }));
  var res = env.host.call('getMogrtFields', { path: MOGRT });
  assert.deepStrictEqual(res, { ok: true, data: { fields: [] } });
  assertCleanExit(env.premiere);
  assert.strictEqual(env.premiere.state.insertedClips[0].removed, true);
});

test('no sequence open: the exact field-discovery message, no exception, nothing inserted', function () {
  var env = setup([], {});
  var res = env.host.call('getMogrtFields', { path: MOGRT });
  assert.deepStrictEqual(res, {
    ok: false,
    error: 'Open a sequence in Premiere first \u2014 reading a template\'s fields requires an active sequence.'
  });
  assert.strictEqual(env.premiere.state.importCalls.length, 0);
  assertCleanExit(env.premiere);
});

test('missing path is rejected before anything touches the timeline', function () {
  var env = mogrtEnv();
  [{}, { path: '' }, '{}'].forEach(function (args) {
    var res = env.host.call('getMogrtFields', args);
    assert.strictEqual(res.ok, false);
  });
  assert.strictEqual(env.premiere.state.importCalls.length, 0);
});

test('importMGT returning null gives the exact template message and closes the undo group', function () {
  var env = mogrtEnv();
  var res = env.host.call('getMogrtFields', { path: 'D:/Templates/missing.mogrt' });
  assert.deepStrictEqual(res, {
    ok: false,
    error: 'Premiere could not insert the template. Check the .mogrt path is still valid.'
  });
  assertCleanExit(env.premiere);
  assert.deepStrictEqual(env.premiere.state.undoLog, ['begin:VS_scratch', 'end']);
});

test('importMGT throwing gives the same message and closes the undo group', function () {
  var env = mogrtEnv();
  env.premiere.state.importThrows = true;
  var res = env.host.call('getMogrtFields', { path: MOGRT });
  assert.strictEqual(res.error, 'Premiere could not insert the template. Check the .mogrt path is still valid.');
  assertCleanExit(env.premiere);
});

test('a template without an MGT component gives the exact message and the scratch clip is removed', function () {
  var env = mogrtEnv(null, avQuoteTemplate({ noComponent: true }));
  var res = env.host.call('getMogrtFields', { path: MOGRT });
  assert.deepStrictEqual(res, {
    ok: false,
    error: 'This template has no Motion Graphics component \u2014 it may not be an After Effects template.'
  });
  assert.strictEqual(env.premiere.state.insertedClips[0].removed, true);
  assertCleanExit(env.premiere);
});

test('getMGTComponent throwing is reported as the missing-component message', function () {
  var env = mogrtEnv(null, avQuoteTemplate({ componentThrows: true }));
  var res = env.host.call('getMogrtFields', { path: MOGRT });
  assert.strictEqual(res.ok, false);
  assert.ok(/no Motion Graphics component/.test(res.error));
  assertCleanExit(env.premiere);
});

test('a failing clip.remove() does not turn a successful discovery into an error', function () {
  var env = mogrtEnv(null, avQuoteTemplate({ removeThrows: true }));
  var res = env.host.call('getMogrtFields', { path: MOGRT });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.data.fields.length, 2);
  assertCleanExit(env.premiere);
});

test('works when beginUndoGroup is unavailable, and never calls endUndoGroup for a group it did not open', function () {
  var env = mogrtEnv();
  env.premiere.state.beginUndoThrows = true;
  var res = env.host.call('getMogrtFields', { path: MOGRT });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(env.premiere.state.undoLog, []);
});

test('a sequence with no video tracks is refused instead of provoking a fatal out-of-range insert', function () {
  var seq = sequenceFrom(readFixture('sequence-2997'));
  seq.videoTracks = 0;
  var env = mogrtEnv(seq);
  var res = env.host.call('getMogrtFields', { path: MOGRT });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(env.premiere.state.importCalls.length, 0);
  assertCleanExit(env.premiere);
});

test('a sequence with no end time falls back to an hour plus the scratch offset', function () {
  var env = mogrtEnv();
  env.premiere.sequences[0].end = null;
  env.host.call('getMogrtFields', { path: MOGRT });
  var ticks = env.premiere.state.importCalls[0].ticks;
  assert.strictEqual(ticks, String(3660 * mock.TICKS_PER_SECOND));
});

test('target the top video track of whichever sequence is active', function () {
  var a = sequenceFrom(readFixture('sequence-2997'));
  var b = sequenceFrom(readFixture('sequence-23976'));
  var mogrts = {};
  mogrts[MOGRT] = avQuoteTemplate();
  var env = setup([a, b], mogrts);
  env.premiere.app.project.activeSequence = env.premiere.sequences[1];
  env.host.call('getMogrtFields', { path: MOGRT });
  assert.strictEqual(env.premiere.state.importCalls[0].videoOffset, b.videoTracks - 1);
});

// ---- VS.setPlayhead ----------------------------------------------------------------------------------

test('setPlayhead moves the playhead and echoes the ticks as a string', function () {
  var env = setup([sequenceFrom(readFixture('sequence-2997'))]);
  var res = env.host.call('setPlayhead', { ticks: '358996428390000' });
  assert.deepStrictEqual(res, { ok: true, data: { ticks: '358996428390000' } });
  assert.deepStrictEqual(env.premiere.sequences[0].playerMoves, ['358996428390000']);
  assert.strictEqual(env.host.call('getSequenceInfo').data.playheadTicks, '358996428390000');
  assertCleanExit(env.premiere);
});

test('setPlayhead matches the stub response shape', function () {
  var env = setup([sequenceFrom(readFixture('sequence-2997'))]);
  var args = { ticks: '30481920000000' };
  assert.deepStrictEqual(env.host.call('setPlayhead', args), JSON.parse(VSstub.setPlayhead(JSON.stringify(args))));
});

test('setPlayhead moves the playhead of the active sequence only', function () {
  var env = setup([sequenceFrom(readFixture('sequence-2997')), sequenceFrom(readFixture('sequence-25'))]);
  env.host.call('setPlayhead', { ticks: '0' });
  assert.strictEqual(env.premiere.sequences[0].playerMoves.length, 1);
  assert.strictEqual(env.premiere.sequences[1].playerMoves.length, 0);
});

test('setPlayhead with no sequence open returns the exact message', function () {
  var env = setup([]);
  assert.deepStrictEqual(env.host.call('setPlayhead', { ticks: '1000' }), {
    ok: false,
    error: 'Open a sequence in Premiere first.'
  });
});

test('setPlayhead rejects malformed ticks without calling Premiere', function () {
  var env = setup([sequenceFrom(readFixture('sequence-2997'))]);
  [{}, { ticks: 12 }, { ticks: '' }, { ticks: '12.5' }, { ticks: '-5' }, { ticks: '1e9' }, { ticks: null }]
    .forEach(function (args) {
      var res = env.host.call('setPlayhead', args);
      assert.strictEqual(res.ok, false, JSON.stringify(args));
    });
  assert.strictEqual(env.premiere.sequences[0].playerMoves.length, 0);
  assertCleanExit(env.premiere);
});

test('setPlayhead reports a Premiere failure as an error envelope', function () {
  var env = setup([sequenceFrom(readFixture('sequence-2997'))]);
  env.premiere.sequences[0].setPlayerPosition = function () { throw new Error('no player'); };
  var res = env.host.call('setPlayhead', { ticks: '5' });
  assert.strictEqual(res.ok, false);
  assert.ok(/no player/.test(res.error));
});

// ---- every function, no sequence ----------------------------------------------------------------------

test('with no sequence open no function throws and each returns a parseable envelope', function () {
  var env = setup([]);
  var argsFor = {
    ping: {},
    getSequenceInfo: {},
    getMogrtFields: { path: MOGRT },
    setPlayhead: { ticks: '0' }
  };
  Object.keys(argsFor).forEach(function (fn) {
    var raw = env.host.callRaw(fn, argsFor[fn]);
    assert.strictEqual(typeof raw, 'string', fn);
    var parsed = JSON.parse(raw);
    assert.strictEqual(typeof parsed.ok, 'boolean', fn);
    if (!parsed.ok) {
      assert.ok(/^Open a sequence in Premiere first/.test(parsed.error), fn);
    }
  });
  assertCleanExit(env.premiere);
});

test('malformed argument JSON yields an error envelope, never an exception', function () {
  var env = setup([sequenceFrom(readFixture('sequence-2997'))]);
  ['getMogrtFields', 'setPlayhead'].forEach(function (fn) {
    var parsed = JSON.parse(env.host.callRaw(fn, '{not json'));
    assert.strictEqual(parsed.ok, false, fn);
    assert.strictEqual(typeof parsed.error, 'string');
  });
});

test('error envelopes carry only ok and error unless a code is given', function () {
  var env = setup([]);
  var res = env.host.call('setPlayhead', { ticks: '1' });
  assert.deepStrictEqual(Object.keys(res).sort(), ['error', 'ok']);
});
