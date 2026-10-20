// Paste into the VerseSync panel's DevTools console (http://localhost:7781) to run the T-25.H
// checks against real Premiere. Everything hangs off `HV`; nothing here ships in the panel.
//
//   HV.cfg.mogrt = 'C:/path/AV_Quote_04.mogrt';   // set once
//   await HV.info();            // check 1: run it twice, and after a sequence-tab switch
//   await HV.fields();          // check 2
//   await HV.segments('C:/path/media.mxf');        // check 3 (also prints the walk time)
//   await HV.insert(20);        // check 4: then press Ctrl+Z ONCE in Premiere
//   await HV.insert(5, true);   // check 5: cue 2 is broken on purpose (set HV.cfg.referenceIndex/bodyIndex first!)
//   await HV.diag();            // undo-group probe
//   await HV.rawProps();        // raw MOGRT property dump (why is `group` empty?)
//   await HV.stale();           // check 6: switch sequence tab first, then run this
//   await HV.validate();        // check 7: run on a populated track
(function () {
  var TPS = 254016000000; // ticks per second
  var cs = new CSInterface();
  var HV = (window.HV = { cfg: { mogrt: '', track: 0, referenceIndex: 0, bodyIndex: 1 } });

  HV.call = function (fn, args) {
    return new Promise(function (resolve) {
      var script = 'VS.' + fn + '(' + JSON.stringify(JSON.stringify(args || {})) + ')';
      cs.evalScript(script, function (raw) {
        try { resolve(JSON.parse(raw)); } catch (e) { resolve({ raw: raw }); }
      });
    });
  };

  HV.info = async function () {
    var a = await HV.call('getSequenceInfo');
    var b = await HV.call('getSequenceInfo');
    console.log('sequenceId stable across calls:', a.data && b.data && a.data.sequenceId === b.data.sequenceId);
    console.log('timebase:', a.data && a.data.timebase, 'frameRate:', a.data && a.data.frameRate);
    HV.seq = a.data;
    return a;
  };

  HV.fields = async function () {
    var r = await HV.call('getMogrtFields', { path: HV.cfg.mogrt });
    console.table(r.data && r.data.fields);
    console.log(JSON.stringify(r.data && r.data.fields));
    return r;
  };

  // Undo-group probe: does this Premiere expose the undo-group calls the host relies on?
  HV.diag = function () {
    var probes = ['typeof app.beginUndoGroup', 'typeof app.endUndoGroup',
                  'typeof app.project.beginUndoGroup', 'app.version'];
    return Promise.all(probes.map(function (p) {
      return new Promise(function (res) { cs.evalScript(p, function (r) { console.log(p, '=>', r); res(r); }); });
    }));
  };

  // Dumps every MOGRT property's raw index, propertyType, displayName and name so we can see
  // why `group` is empty. Imports a scratch clip past the sequence end and removes it again.
  HV.rawProps = function () {
    var js = '(function(){var out=[];var seq=app.project.activeSequence;' +
      'var t=String(Number(seq.end)+254016000000*30);' +
      'var c=seq.importMGT(' + JSON.stringify(HV.cfg.mogrt) + ',t,seq.videoTracks.numTracks-1,0);' +
      'var m=c.getMGTComponent();var n=m.properties.numItems;' +
      'for(var i=0;i<n;i++){var p=m.properties[i];var o={i:i};' +
      'try{o.type=p.propertyType}catch(e){o.type="err"}' +
      'try{o.displayName=p.displayName}catch(e){o.displayName="err"}' +
      'try{o.name=p.name}catch(e){o.name="err"}' +
      'try{var v=p.getValue();o.vt=typeof v;o.v=(typeof v==="string")?v.slice(0,40):String(v)}catch(e){o.vt="throws"}' +
      'try{o.keys=(function(){var k=[];for(var x in p){k.push(x)}return k.join(",")})()}catch(e){}' +
      'out.push(o)}' +
      'try{c.remove(false,true)}catch(e){}return JSON.stringify(out)})()';
    return new Promise(function (res) {
      cs.evalScript(js, function (raw) {
        try { console.table(JSON.parse(raw)); } catch (e) { console.log(raw); }
        res(raw);
      });
    });
  };

  HV.segments = async function (mediaPath) {
    if (!HV.seq) await HV.info();
    var t0 = performance.now();
    var r = await HV.call('getMediaSegments', { sequenceId: HV.seq.sequenceId, mediaPath: mediaPath });
    console.log('walk time ms:', Math.round(performance.now() - t0));
    console.log(JSON.stringify(r, null, 1));
    return r;
  };

  // n cues, 10 s apart starting 10 s after the playhead's sequence start, 3 s long each.
  HV.insert = async function (n, breakSecond) {
    if (!HV.seq) await HV.info();
    var cues = [];
    for (var i = 0; i < n; i++) {
      cues.push({
        id: 'hv-' + i,
        atTicks: String((10 + i * 10) * TPS),
        durationTicks: String(3 * TPS),
        reference: 'Test ' + (i + 1) + ':1',
        body: 'Cue number ' + (i + 1)
      });
    }
    // Passes the up-front checks (which only look at the ticks) but throws inside the host loop,
    // so it is a per-cue failure while the others still land.
    if (breakSecond && cues[1]) { delete cues[1].reference; }
    var r = await HV.call('insertCues', {
      sequenceId: HV.seq.sequenceId,
      trackIndex: HV.cfg.track,
      mogrtPath: HV.cfg.mogrt,
      mapping: { referenceIndex: HV.cfg.referenceIndex, bodyIndex: HV.cfg.bodyIndex },
      cues: cues
    });
    console.log(JSON.stringify(r, null, 1));
    return r;
  };

  // Call after switching to a different sequence tab: expect the D20 message and no insert.
  HV.stale = async function () {
    if (!HV.seq) { console.warn('Run HV.info() on the ORIGINAL sequence first, then switch tabs.'); return; }
    var r = await HV.call('insertCues', {
      sequenceId: HV.seq.sequenceId, trackIndex: HV.cfg.track, mogrtPath: HV.cfg.mogrt,
      mapping: { referenceIndex: HV.cfg.referenceIndex, bodyIndex: HV.cfg.bodyIndex },
      cues: [{ id: 'hv-stale', atTicks: String(5 * TPS), durationTicks: String(TPS), reference: 'x', body: 'x' }]
    });
    console.log(JSON.stringify(r, null, 1));
    return r;
  };

  // One range covering the first 100 s of the track; expect a conflict per overlapping clip.
  HV.validate = async function () {
    if (!HV.seq) await HV.info();
    var r = await HV.call('validateTrack', {
      sequenceId: HV.seq.sequenceId, trackIndex: HV.cfg.track,
      ranges: [{ startTicks: '0', endTicks: String(100 * TPS) }]
    });
    console.log(JSON.stringify(r, null, 1));
    return r;
  };

  console.log('HV ready. Set HV.cfg.mogrt, then run HV.info().');
})();
