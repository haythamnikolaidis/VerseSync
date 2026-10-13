'use strict';

// A mock of the slice of Premiere's ExtendScript object model that panel/jsx/VerseSync.jsx
// touches (app, $, Time, CSXSEvent, Sequence, TrackItem, the MGT component), shaped from
// docs/08-premiere-host-api.md and the findings in spikes/*/RESULTS.md. Test tooling only.
//
// Behaviours deliberately reproduced from the spikes:
//  - ticks are strings everywhere, on Time objects and on seq.timebase / seq.zeroPoint
//  - importMGT with an out-of-range track offset is a FATAL error: the real engine skips
//    try/catch and leaves the undo group open. The mock records it in state.fatalCalls so a
//    test can assert the host never provokes one.
//  - undo groups are counted; state.undoDepth must be back to 0 after every host call
//  - an unknown .mogrt path makes importMGT return null

var TICKS_PER_SECOND = 254016000000;

function Time() {
  this.ticks = '0';
}

function makeTime(ticks) {
  var t = new Time();
  t.ticks = String(ticks);
  return t;
}

// A MOGRT parameter. `spec.value` is returned by getValue(); setValue() records its input.
function makeProperty(spec) {
  var prop = {
    displayName: spec.displayName,
    propertyType: spec.propertyType,
    written: [],
    getValue: function () {
      if (spec.getValueThrows) { throw new Error('getValue failed'); }
      return spec.value;
    },
    setValue: function (value, updateUI) {
      prop.written.push({ value: value, updateUI: updateUI });
      spec.value = value;
    }
  };
  return prop;
}

function textValue(text) {
  return JSON.stringify({ textEditValue: text, fontTextRunLength: [text.length] });
}

// Property specs for AV_Quote_04.mogrt (clip name "AV Quote 04", 46 properties, indices 0-45).
// This is not inferred: every displayName, GUID string, value type and the two text-leaf JSON
// blobs below were read directly off a scratch instance of the real template in real Premiere
// Pro 2026 (via VS.getMogrtFields's own insert-past-the-end technique, driven through
// VerseFlow's debug-mode CEP panel per spikes/README.md), during T-23's host verification pass.
// `Title Main` is a group header at index 2 immediately followed by its `Text` field at 3;
// `Description` is a group header at index 6 immediately followed by its `Text` field at 7 --
// matching the independently recorded dump in spikes/word_timestamps/graphic_raw.json. Premiere
// reports propertyType as undefined for every one of the 46 properties (confirmed live, not just
// for the two text fields); a group header's getValue() is a ';'-joined, ';'-terminated list of
// GUIDs; a text leaf's getValue() is a JSON blob with textEditValue and the font-run keys; the
// other 38 properties are a mix of plain numbers (color packs, sizes, offsets), two-element
// coordinate arrays (position/BG pairs) and three booleans (the per-group enable switches at the
// end) -- none of them a GUID-list string and none holding textEditValue, so none is picked up as
// a group or a field by vsIterateProperties.
var GUID_TEXT_GENERAL = '36ddb78d-d185-4be4-8129-397a0f2f10a6;759554ff-7827-42ec-bf0e-0e7e3ed93cd0;';
var GUID_TITLE = '31a1fe9e-5ef8-4a8e-80e3-f666166d3536;7f04d77d-3ccc-4c66-8c9b-54575c561ab0;' +
  'a01c7d4f-6fc2-4d1d-9e01-c4f849c5aa33;';
var GUID_DESC = '2d5d0175-b921-4096-be6d-4c48722fd097;5d119119-baa3-4e8d-99a5-5a9dd8064138;' +
  '6345f33d-b531-4e78-af33-bda39d03cb73;';
var GUID_GE_COLOR = 'd890d0fc-d4ed-4c80-ba4c-431fc0c52a2a;';
var GUID_GE_COLOR_TITLE = '42f987b0-9431-44fb-8f8d-863531eac537;27ef457e-3bed-4299-9acb-fc48189b861c;' +
  'c337eae7-e800-471b-9d74-c039a0dbdce2;620f3c11-5122-4e12-b643-af37a371c6be;';
var GUID_GE_POSITION = 'a2c4512f-1fbe-4123-a017-18b1aea479d3;';
var GUID_GE_POSITION_TITLE = '4cf1fca6-1e3a-45e9-a4da-a6f02348c4d1;';
var GUID_GE_SIZE = '414beba1-69bb-4278-b0b6-aa12520a5d88;';
var GUID_GE_SIZE_TITLE = '4143bbfd-05d6-4c98-828a-9f1e9b9355f8;05603570-b7d8-4a6b-951c-9feae2622bec;';
var GUID_ALLGFX_GENERAL = 'dff6ae34-2f5a-4357-b52c-6af46d6c1738;fba57559-a9ef-4ce3-950d-366597f5427a;';
var GUID_ALLGFX_SHADOW = 'cd833e97-e96d-45c6-b3d5-7a677e3f57d4;e5e606ad-46aa-4fe7-8583-3f598c1d27cc;' +
  '975f0164-a192-4ca5-ad50-b1a1b609e1e4;';
var GUID_SHADOW_TITLE_TEXT = 'c057de23-aa90-4a6f-b7c6-a1627be39000;25b277ef-253b-4071-9173-928ee3c5c548;' +
  '2cb2f075-5943-495d-b2a9-5db3be7c4f4e;01f0fc0e-129a-49ea-9e09-6f3e055a2789;';
var GUID_SHADOW_TITLE_GREL = '154ff4a2-7d6b-4552-8a0e-1eb07a276b85;b994bcf1-d501-47ee-a54f-df3bcfec0b22;' +
  'dbc0ea71-33d7-418c-8f7c-8dff0fcd4190;18e7c0dd-34fd-4884-bc29-bec5130a7ab2;';
var GUID_SHADOW_DESC = '3016b5e0-77f4-4b27-a165-44f83478aec2;68eb0244-c3bd-48db-8d53-396297b24af4;' +
  '0dcf8a0f-4ff4-403d-a2fa-dbb62bcc3a05;551f5e3e-1c18-450b-9d63-89294a6d98fd;';
var GUID_SWITCHES = 'ca398c14-4803-4b98-9277-3ba685732cc3;e05bd439-00e5-47b0-98ce-e43c426227bc;' +
  '8b77420b-cca5-4522-90d7-ff7f25498b49;';
var AV_QUOTE_04_PROPERTY_COUNT = 46;

function realTextValue(text, font, caps) {
  return JSON.stringify({
    capPropFontEdit: true,
    capPropFontFauxStyleEdit: true,
    capPropFontSizeEdit: true,
    capPropTextRunCount: 1,
    fontEditValue: [font],
    fontFSAllCapsValue: [caps],
    fontFSBoldValue: [!caps],
    fontFSItalicValue: [false],
    fontFSSmallCapsValue: [false],
    fontSizeEditValue: [40],
    fontTextRunLength: [text.length],
    textEditValue: text
  });
}

function avQuote04Specs() {
  // Indices and displayNames below are the literal order Premiere returned on the real
  // template; see the file-header comment for how this was captured.
  var specs = [
    { displayName: 'Quote #04', value: 'Quotes | Imocean' },
    { displayName: 'Text – GENERAL SETTINGS', value: GUID_TEXT_GENERAL },
    { displayName: 'Title Main', value: GUID_TITLE },
    { displayName: 'Text',
      value: realTextValue('The Light of His Favour Is upon You', 'Avenir-Light', false) },
    { displayName: 'Color', value: 72337973781266176 },
    { displayName: 'Position', value: [0.11197916666667, 0.64814814814815] },
    { displayName: 'Description', value: GUID_DESC },
    { displayName: 'Text', value: realTextValue('Message Title', 'Avenir-Black', true) },
    { displayName: 'Color', value: 72337973781266176 },
    { displayName: 'Position', value: [0.11197916666667, 0.88148148148148] },
    { displayName: 'Graphic Elements – COLOR', value: GUID_GE_COLOR },
    { displayName: 'Title Main', value: GUID_GE_COLOR_TITLE },
    { displayName: 'Color #1', value: 72093880807383552 },
    { displayName: 'Color Position #1', value: [0, 0] },
    { displayName: 'Color #2', value: 72093880807383552 },
    { displayName: 'Color Position #2', value: [1, 1] },
    { displayName: 'Graphic Elements – POSITION', value: GUID_GE_POSITION },
    { displayName: 'Title Main', value: GUID_GE_POSITION_TITLE },
    { displayName: 'BG', value: [0.1046875, 0.60277777777778] },
    { displayName: 'Graphic Elements – SIZE', value: GUID_GE_SIZE },
    { displayName: 'Title Main', value: GUID_GE_SIZE_TITLE },
    { displayName: 'BG – X', value: 71 },
    { displayName: 'BG – Y', value: 21 },
    { displayName: 'All Graphics – GENERAL SETTINGS', value: GUID_ALLGFX_GENERAL },
    { displayName: 'Position', value: [0, 0] },
    { displayName: 'Size', value: 100 },
    { displayName: 'All Graphics – SHADOW', value: GUID_ALLGFX_SHADOW },
    { displayName: 'Title Main (Text)', value: GUID_SHADOW_TITLE_TEXT },
    { displayName: 'Color', value: 72057594037927936 },
    { displayName: 'Opacity', value: 0 },
    { displayName: 'Distance', value: 0 },
    { displayName: 'Softness', value: 0 },
    { displayName: 'Title Main (Gr.El.)', value: GUID_SHADOW_TITLE_GREL },
    { displayName: 'Color', value: 72057594037927936 },
    { displayName: 'Opacity', value: 0 },
    { displayName: 'Distance', value: 0 },
    { displayName: 'Softness', value: 0 },
    { displayName: 'Description', value: GUID_SHADOW_DESC },
    { displayName: 'Color', value: 72057594037927936 },
    { displayName: 'Opacity', value: 0 },
    { displayName: 'Distance', value: 0 },
    { displayName: 'Softness', value: 0 },
    { displayName: 'Switch ON / OFF', value: GUID_SWITCHES },
    { displayName: 'Title Main (Text)', value: true },
    { displayName: 'Title Main (Gr.El.)', value: true },
    { displayName: 'Description', value: true }
  ];
  if (specs.length !== AV_QUOTE_04_PROPERTY_COUNT) {
    throw new Error('avQuote04Specs() drifted from the recorded property count');
  }
  return specs;
}

// Premiere's MGT component: `properties` is a collection with numItems and index access.
function makeMgtComponent(specs, opts) {
  var properties = { numItems: specs.length };
  var list = [];
  specs.forEach(function (spec, i) {
    list.push(makeProperty(spec));
    properties[i] = list[i];
  });
  if (opts && opts.numItemsThrows) {
    Object.defineProperty(properties, 'numItems', {
      get: function () { throw new Error('numItems failed'); }
    });
  }
  return { properties: properties, list: list };
}

function makeTrack(kind) {
  var clips = { numItems: 0 };
  return {
    kind: kind,
    clips: clips,
    _items: [],
    _add: function (clip) {
      this._items.push(clip);
      clips[this._items.length - 1] = clip;
      clips.numItems = this._items.length;
    },
    _remove: function (clip) {
      var idx = this._items.indexOf(clip);
      var i;
      if (idx < 0) { return; }
      this._items.splice(idx, 1);
      for (i = 0; i <= this._items.length; i++) { delete clips[i]; }
      for (i = 0; i < this._items.length; i++) { clips[i] = this._items[i]; }
      clips.numItems = this._items.length;
    }
  };
}

function makeTrackCollection(kind, count) {
  var coll = { numTracks: count };
  for (var i = 0; i < count; i++) { coll[i] = makeTrack(kind); }
  return coll;
}

// opts: name, sequenceID, videoTracks, audioTracks, timebase, zeroPoint, end, playhead
function makeSequence(state, opts) {
  var playhead = String(opts.playhead === undefined ? '0' : opts.playhead);
  var seq = {
    name: opts.name,
    sequenceID: opts.sequenceID,
    timebase: String(opts.timebase),
    zeroPoint: String(opts.zeroPoint === undefined ? '0' : opts.zeroPoint),
    end: makeTime(opts.end === undefined ? '0' : opts.end),
    videoTracks: makeTrackCollection('video', opts.videoTracks === undefined ? 1 : opts.videoTracks),
    audioTracks: makeTrackCollection('audio', opts.audioTracks === undefined ? 1 : opts.audioTracks),
    playerMoves: [],
    getPlayerPosition: function () { return makeTime(playhead); },
    setPlayerPosition: function (ticks) {
      if (typeof ticks !== 'string' || !/^[0-9]+$/.test(ticks)) {
        state.fatalCalls += 1;
        throw new Error('fatal: malformed ticks passed to setPlayerPosition');
      }
      playhead = ticks;
      seq.playerMoves.push(ticks);
    },
    importMGT: function (path, ticks, videoOffset, audioOffset) {
      state.importCalls.push({
        path: path, ticks: ticks, videoOffset: videoOffset, audioOffset: audioOffset,
        undoDepth: state.undoDepth
      });
      if (typeof ticks !== 'string' || !/^[0-9]+$/.test(ticks) ||
          typeof videoOffset !== 'number' || videoOffset < 0 ||
          videoOffset >= seq.videoTracks.numTracks) {
        state.fatalCalls += 1;
        throw new Error('fatal: importMGT argument out of range');
      }
      if (state.importThrows) { throw new Error('importMGT blew up'); }
      var template = state.mogrts[path];
      if (!template) { return null; }
      var track = seq.videoTracks[videoOffset];
      var mgt = template.noComponent ? null : makeMgtComponent(template.specs(), template);
      var clip = {
        name: 'AV Quote 04',
        start: makeTime(ticks),
        end: makeTime(String(Number(ticks) + 5 * TICKS_PER_SECOND)),
        mgt: mgt,
        removed: false,
        getMGTComponent: function () {
          if (template.componentThrows) { throw new Error('getMGTComponent failed'); }
          return mgt;
        },
        remove: function () {
          if (template.removeThrows) { throw new Error('remove failed'); }
          clip.removed = true;
          track._remove(clip);
        }
      };
      track._add(clip);
      state.insertedClips.push(clip);
      return clip;
    }
  };
  return seq;
}

// Builds a fresh Premiere environment. `scenario` may carry `mogrts` ({path: {specs, ...}}) and
// `sequences` (array of makeSequence opts); the first sequence starts active.
function createPremiere(scenario) {
  scenario = scenario || {};
  var state = {
    undoDepth: 0,
    undoLog: [],
    fatalCalls: 0,
    importCalls: [],
    insertedClips: [],
    mogrts: scenario.mogrts || {},
    importThrows: false,
    beginUndoThrows: false
  };

  var sequences = (scenario.sequences || []).map(function (o) { return makeSequence(state, o); });
  var project = {
    activeSequence: sequences.length ? sequences[0] : null,
    sequences: sequences
  };

  var app = {
    project: project,
    beginUndoGroup: function (name) {
      if (state.beginUndoThrows) { throw new Error('beginUndoGroup unavailable'); }
      state.undoDepth += 1;
      state.undoLog.push('begin:' + name);
    },
    endUndoGroup: function () {
      state.undoDepth -= 1;
      state.undoLog.push('end');
    }
  };

  var dollar = {
    lines: [],
    writeln: function (s) { dollar.lines.push(String(s)); },
    os: 'Windows',
    version: '14.0.0'
  };

  return {
    app: app,
    $: dollar,
    Time: Time,
    CSXSEvent: function () { this.dispatch = function () {}; },
    state: state,
    sequences: sequences
  };
}

module.exports = {
  TICKS_PER_SECOND: TICKS_PER_SECOND,
  createPremiere: createPremiere,
  makeSequence: makeSequence,
  avQuote04Specs: avQuote04Specs,
  textValue: textValue
};
