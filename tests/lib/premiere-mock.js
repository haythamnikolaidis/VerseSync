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

// Property specs modelled on AV_Quote_04.mogrt: two groups, each holding one text field, and
// both fields display as "Text". Group nodes use type 10 in one place and type 4 in the
// other; the two text fields are matched by type 6 and type 5 respectively.
function avQuote04Specs() {
  return [
    { displayName: 'Title Main', propertyType: 10 },                                   // 0
    { displayName: 'Position', propertyType: 1, value: [0.5, 0.5] },                   // 1
    { displayName: 'Scale', propertyType: 1, value: 100 },                             // 2
    { displayName: 'Text', propertyType: 6, value: textValue('Title') },               // 3
    { displayName: 'Fill', propertyType: 1, value: [1, 1, 1, 1] },                     // 4
    { displayName: 'Opacity', propertyType: 1, value: 100 },                           // 5
    { displayName: 'Description', propertyType: 4 },                                   // 6
    { displayName: 'Position', propertyType: 1, value: [0.5, 0.8] },                   // 7
    { displayName: 'Scale', propertyType: 1, value: 100 },                             // 8
    { displayName: 'Fill', propertyType: 1, value: [1, 1, 1, 1] },                     // 9
    { displayName: 'Opacity', propertyType: 1, value: 100 },                           // 10
    { displayName: 'Text', propertyType: 5, value: textValue('Description') }          // 11
  ];
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
