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

// Property specs for AV_Quote_04.mogrt (clips named "AV Quote 04", 45 properties), taken from the
// real dump recorded in spikes/word_timestamps/graphic_raw.json: `Title Main` is a group header at
// index 2 immediately followed by its `Text` field at 3, `Description` is a group header at 6
// immediately followed by its `Text` field at 7. Premiere reports propertyType as undefined for
// every property, a group header's getValue() is a ';'-joined list of GUIDs, and a text leaf's
// getValue() is a JSON blob with textEditValue and the font-run keys. The dump records only the
// two text fields, so the other slots are non-text, non-group properties with placeholder names
// and plain numeric values; none of them is a header or holds textEditValue.
var GUID_TITLE = '31a1fe9e-5ef8-4a8e-80e3-f666166d3536;0b7c1a52-93d4-4c1e-8a57-5d2e6f0c9b11';
var GUID_DESC = '9e4d27c0-1b6a-4f3e-b2d8-7a5c3e918f40';
var AV_QUOTE_04_PROPERTY_COUNT = 45;

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
  var specs = [];
  var i;
  for (i = 0; i < AV_QUOTE_04_PROPERTY_COUNT; i++) {
    specs.push({ displayName: 'Property ' + i, value: 100 });
  }
  specs[2] = { displayName: 'Title Main', value: GUID_TITLE };
  specs[3] = { displayName: 'Text', value: realTextValue('The Light of His Favour Is upon You', 'Avenir-Light', false) };
  specs[6] = { displayName: 'Description', value: GUID_DESC };
  specs[7] = { displayName: 'Text', value: realTextValue('Message Title', 'Avenir-Black', true) };
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
