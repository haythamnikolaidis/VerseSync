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

class FatalHostError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FatalHostError';
  }
}

function notModelled(what) {
  return new Error('NotModelled: ' + what + ' is not part of the fake Premiere');
}

function time(ticks) {
  return { ticks: String(ticks) };
}

// Default length of a freshly imported MOGRT clip. Copied from the clip length
// the absolute_insert spike used (spikes/absolute_insert/RESULTS.md, Case 5);
// a template can override it with registerMogrt(path, fields, { durationTicks }).
const DEFAULT_MOGRT_DURATION_TICKS = '1473292800000';

// Property types VerseFlow's _iterateProperties walks: 10 and 4 are group
// nodes, 6 and 5 are source text. Anything else is a non-text parameter.
const PROP_OTHER = 2;

// The AV_Quote_04 template of docs/08 section 5: two fields both named Text,
// in groups 'Title Main' (index 3) and 'Description' (index 11). The group
// and text types deliberately mix 10/6 and 4/5 so both detection branches run.
const AV_QUOTE_04_FIELDS = [
  { name: 'Text', group: 'Title Main', groupType: 10, textType: 6, padBefore: 2 },
  { name: 'Text', group: 'Description', groupType: 4, textType: 5, padBefore: 6 }
];

function textBlob() {
  return JSON.stringify({ textEditValue: '', fontTextRunLength: [0] });
}

function makeProperty(type, displayName, initial) {
  let value = initial;
  return {
    propertyType: type,
    displayName: displayName,
    getValue: function () { return value; },
    // Premiere stores exactly what it is given; the JSON string written by
    // the host script must be readable back unchanged (docs/08 section 5).
    setValue: function (v, updateUI) {
      if (updateUI !== undefined && typeof updateUI !== 'boolean') {
        throw new Error('setValue: updateUI must be boolean');
      }
      value = v;
    }
  };
}

function buildMgtComponent(fields) {
  const list = [];
  fields.forEach(function (f) {
    for (let i = 0; i < (f.padBefore || 0); i++) {
      list.push(makeProperty(PROP_OTHER, 'Param ' + list.length, 0));
    }
    list.push(makeProperty(f.groupType, f.group, ''));
    list.push(makeProperty(f.textType, f.name, textBlob()));
  });
  const properties = { numItems: list.length };
  list.forEach(function (p, i) { properties[i] = p; });
  return { properties: properties };
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
    inPoint: time(inTicks),
    // A null projectItem is real (T-04): chaining off it throws a TypeError.
    // Nested and multicam clips have a projectItem whose getMediaPath() is ''.
    projectItem: hasProjectItem
      ? { name: opts.name === undefined ? '' : opts.name, getMediaPath: function () { return mediaPath; } }
      : null,
    getSpeed: function () { return speed; },
    getMGTComponent: function () {
      throw notModelled('getMGTComponent on a clip that is not an imported MOGRT');
    },
    remove: function () { throw new Error('clip is not on a track'); }
  };
  // Assigning clip.end only sets the property. Premiere does not resolve
  // overlaps when it is set (T-03, Case 4), so neither does the fake; use
  // track.overlaps() to see what it left behind.
  let endTime = time(opts.endTicks);
  Object.defineProperty(clip, 'end', {
    enumerable: true,
    get: function () { return endTime; },
    set: function (t) {
      if (!t || t.ticks === undefined) {
        throw new Error('clip.end must be assigned a Time with .ticks');
      }
      endTime = time(t.ticks);
    }
  });
  return clip;
}

function createTrack() {
  const track = {
    clips: [],
    // Pairs of clips whose ranges intersect. Clips that merely touch
    // (end == next start) are not overlapping.
    overlaps: function () {
      const out = [];
      for (let i = 0; i < track.clips.length; i++) {
        for (let j = i + 1; j < track.clips.length; j++) {
          const a = track.clips[i];
          const b = track.clips[j];
          if (BigInt(a.start.ticks) < BigInt(b.end.ticks) && BigInt(b.start.ticks) < BigInt(a.end.ticks)) {
            out.push([a, b]);
          }
        }
      }
      return out;
    }
  };
  return track;
}

// Premiere treats an out-of-range track index as a fatal host error that the
// script's own try/catch cannot intercept (T-03). The collection is a Proxy
// so any numeric read outside 0..numTracks-1 raises it through onFatal.
function createTrackCollection(count, label, onFatal) {
  const raw = { numTracks: count };
  for (let i = 0; i < count; i++) {
    raw[i] = createTrack();
  }
  return new Proxy(raw, {
    get: function (target, key) {
      if (typeof key === 'string' && /^-?\d+$/.test(key) && !(key in target)) {
        throw onFatal(label + '[' + key + '] is out of range (numTracks=' + target.numTracks + ')');
      }
      return target[key];
    }
  });
}

function createFakePremiere() {
  const sequences = [];
  const state = { activeId: null, failImport: {}, templates: {} };
  const fake = {
    undoLog: [],
    events: [],
    sequences: sequences,
    // The first uncaught FatalHostError. loadJsx rethrows it to the Node
    // caller once the script call returns, whatever the script caught.
    fatal: null,
    fatalErrors: []
  };

  function raiseFatal(message) {
    const err = new FatalHostError(message);
    fake.fatalErrors.push(err);
    if (fake.fatal === null) {
      fake.fatal = err;
    }
    return err;
  }

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
      videoTracks: createTrackCollection(o.videoTracks === undefined ? 1 : o.videoTracks, 'videoTracks', raiseFatal),
      audioTracks: createTrackCollection(o.audioTracks === undefined ? 1 : o.audioTracks, 'audioTracks', raiseFatal),
      importMGT: function (path, ticks, vTrackIndex, aTrackIndex) {
        return importMgt(seq, path, ticks, vTrackIndex, aTrackIndex);
      },
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
    attach(tracks[trackIndex], clip);
    return clip;
  };

  // Puts a clip on a track, keeping the track ordered by start like Premiere's
  // item array, and gives it the remove() that detaches it again.
  function attach(track, clip) {
    track.clips.push(clip);
    track.clips.sort(function (a, b) {
      const d = BigInt(a.start.ticks) - BigInt(b.start.ticks);
      return d < 0n ? -1 : (d > 0n ? 1 : 0);
    });
    clip.remove = function (ripple) {
      if (ripple) {
        throw notModelled('clip.remove with ripple');
      }
      track.clips.splice(track.clips.indexOf(clip), 1);
    };
  }

  // sequence.importMGT overwrites: whichever existing clip the new one
  // overlaps loses the overlapped part, from either edge, whatever the
  // insertion order (T-03, Cases 1 and 5). The new clip lands exactly at the
  // requested ticks. The audio track index is accepted and ignored: the spikes
  // never measured an audio effect of it.
  function importMgt(seq, path, ticks, vTrackIndex, aTrackIndex) {
    void aTrackIndex;
    const track = seq.videoTracks[vTrackIndex];
    if (state.failImport[path]) {
      return null;
    }
    const tpl = state.templates[path];
    if (!tpl) {
      throw notModelled('importMGT of unregistered template ' + path);
    }
    const start = BigInt(ticks);
    const end = start + BigInt(tpl.durationTicks);
    track.clips.slice().forEach(function (c) {
      const cs = BigInt(c.start.ticks);
      const ce = BigInt(c.end.ticks);
      if (!(cs < end && start < ce)) {
        return;
      }
      if (cs >= start && ce <= end) {
        track.clips.splice(track.clips.indexOf(c), 1);
      } else if (cs < start && ce > end) {
        throw notModelled('importMGT inside an existing clip (the spikes never measured a split)');
      } else if (cs < start) {
        c.end = time(start);
      } else {
        c.start = time(end);
      }
    });
    const base = String(path).split(/[\\/]/).pop().replace(/\.[^.]*$/, '');
    const clip = createClip({ name: base, startTicks: start, endTicks: end, projectItem: false });
    // One component per clip, so what the host writes can be read back.
    let mgt = null;
    clip.getMGTComponent = function () {
      if (mgt === null) {
        mgt = buildMgtComponent(tpl.fields);
      }
      return mgt;
    };
    attach(track, clip);
    return clip;
  }

  fake.registerMogrt = function (path, fields, opts) {
    state.templates[path] = {
      fields: fields,
      durationTicks: String(opts && opts.durationTicks !== undefined ? opts.durationTicks : DEFAULT_MOGRT_DURATION_TICKS)
    };
  };

  fake.failImportFor = function (path) {
    state.failImport[path] = true;
  };

  fake.app.beginUndoGroup = function (name) {
    fake.undoLog.push({ type: 'begin', name: String(name) });
  };
  fake.app.endUndoGroup = function () {
    fake.undoLog.push({ type: 'end' });
  };
  // begin minus end: 0 when balanced, positive when a group was left open,
  // negative when endUndoGroup ran without a matching begin.
  fake.openUndoGroups = function () {
    let n = 0;
    fake.undoLog.forEach(function (e) { n += e.type === 'begin' ? 1 : -1; });
    return n;
  };

  // ExtendScript usage: var e = new CSXSEvent(); e.type = ...; e.data = ...; e.dispatch();
  fake.CSXSEvent = function CSXSEvent() {
    this.type = '';
    this.data = '';
    this.scope = 'APPLICATION';
  };
  fake.CSXSEvent.prototype.dispatch = function () {
    fake.events.push({ type: this.type, data: this.data, scope: this.scope });
  };

  // ExtendScript usage: var t = new Time(); t.ticks = '254016000000';
  fake.Time = function Time() {
    this.ticks = '0';
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

module.exports = {
  createFakePremiere: createFakePremiere,
  FatalHostError: FatalHostError,
  AV_QUOTE_04_FIELDS: AV_QUOTE_04_FIELDS,
  GARBAGE_IN_POINT_TICKS: GARBAGE_IN_POINT_TICKS
};
