'use strict';

// A scriptable fake of the slice of Premiere's ExtendScript DOM that
// VerseSync touches. It reproduces what the spikes measured, not ideal
// behaviour (spikes/media_segments/RESULTS.md). Where the spikes are silent
// it throws NotModelled instead of guessing. Test code only: never deploy.
// Real-Premiere confirmation of every behaviour here is T-25.H.

// In/out points of a speed-changed clip are unusable garbage in Premiere
// (T-04, v5/c2 row). This is the value that spike measured.
const GARBAGE_IN_POINT_TICKS = '672181757672727';

// Default ticks-per-frame; 8475667200 is the value used in docs/08 section 3.
const DEFAULT_TIMEBASE = '8475667200';

function notModelled(what) {
  return new Error('NotModelled: ' + what + ' is not part of the fake Premiere');
}

function time(ticks) {
  return { ticks: String(ticks) };
}

function createClip(opts) {
  const speed = opts.speed === undefined ? 1 : opts.speed;
  const hasProjectItem = opts.projectItem !== false;
  const mediaPath = opts.mediaPath === undefined ? '' : opts.mediaPath;
  // Speed-changed clips: getSpeed() is real, in/out are garbage (T-04).
  const inTicks = speed !== 1 && opts.inPointTicks === undefined
    ? GARBAGE_IN_POINT_TICKS
    : (opts.inPointTicks === undefined ? '0' : opts.inPointTicks);

  const clip = {
    name: opts.name === undefined ? '' : opts.name,
    start: time(opts.startTicks),
    end: time(opts.endTicks),
    inPoint: time(inTicks),
    // A null projectItem is real (T-04): chaining off it throws a TypeError.
    // Nested and multicam clips have a projectItem whose getMediaPath() is ''.
    projectItem: hasProjectItem
      ? { name: opts.name === undefined ? '' : opts.name, getMediaPath: function () { return mediaPath; } }
      : null,
    getSpeed: function () { return speed; }
  };
  return clip;
}

function createTrackCollection(count) {
  const tracks = { numTracks: 0 };
  for (let i = 0; i < count; i++) {
    tracks[i] = { clips: [] };
  }
  tracks.numTracks = count;
  return tracks;
}

function createFakePremiere() {
  const sequences = [];
  const state = { activeId: null };
  const fake = {
    undoLog: [],
    sequences: sequences
  };

  const project = {
    name: 'Fake Project'
  };
  Object.defineProperty(project, 'activeSequence', {
    enumerable: true,
    get: function () {
      for (let i = 0; i < sequences.length; i++) {
        if (sequences[i].sequenceID === state.activeId) {
          return sequences[i];
        }
      }
      return null;
    }
  });

  fake.app = { project: project };
  fake.$ = { global: {}, writeln: function () {} };

  fake.addSequence = function (opts) {
    const o = opts || {};
    let playhead = '0';
    const seq = {
      sequenceID: o.id === undefined ? 'seq-' + (sequences.length + 1) : o.id,
      name: o.name === undefined ? 'Sequence ' + (sequences.length + 1) : o.name,
      timebase: o.timebase === undefined ? DEFAULT_TIMEBASE : String(o.timebase),
      zeroPoint: o.zeroPointTicks === undefined ? '0' : String(o.zeroPointTicks),
      end: o.endTicks === undefined ? '0' : String(o.endTicks),
      videoTracks: createTrackCollection(o.videoTracks === undefined ? 1 : o.videoTracks),
      audioTracks: createTrackCollection(o.audioTracks === undefined ? 1 : o.audioTracks),
      getPlayerPosition: function () { return time(playhead); },
      setPlayerPosition: function (ticks) { playhead = String(ticks); }
    };
    for (let i = 0; i < sequences.length; i++) {
      if (sequences[i].sequenceID === seq.sequenceID) {
        throw new Error('Duplicate sequence id: ' + seq.sequenceID);
      }
    }
    sequences.push(seq);
    if (state.activeId === null) {
      state.activeId = seq.sequenceID;
    }
    return seq;
  };

  fake.addClip = function (seq, kind, trackIndex, opts) {
    let tracks;
    if (kind === 'video') {
      tracks = seq.videoTracks;
    } else if (kind === 'audio') {
      tracks = seq.audioTracks;
    } else {
      throw new Error("addClip kind must be 'video' or 'audio', got " + kind);
    }
    if (!(trackIndex >= 0 && trackIndex < tracks.numTracks)) {
      throw new Error('addClip: no ' + kind + ' track ' + trackIndex);
    }
    const clip = createClip(opts || {});
    tracks[trackIndex].clips.push(clip);
    return clip;
  };

  // app.project.activeSequence follows UI focus between calls (R-13).
  fake.focusSequence = function (id) {
    for (let i = 0; i < sequences.length; i++) {
      if (sequences[i].sequenceID === id) {
        state.activeId = id;
        return;
      }
    }
    throw new Error('focusSequence: unknown sequence id ' + id);
  };

  fake.notModelled = notModelled;
  return fake;
}

module.exports = { createFakePremiere: createFakePremiere, GARBAGE_IN_POINT_TICKS: GARBAGE_IN_POINT_TICKS };
