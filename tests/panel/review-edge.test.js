'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var JSDOM = require('jsdom').JSDOM;

var root = path.join(__dirname, '..', '..');
var panel = path.join(root, 'panel');
var Review = require(path.join(panel, 'js', 'review.js'));
var Cues = require(path.join(panel, 'js', 'cues.js'));
var Timemap = require(path.join(panel, 'js', 'timemap.js'));
var validate = require(path.join(root, 'tests', 'lib', 'validate-cue-document.js')).validate;

var TIMEBASE = '8475667200';
var SEQ_INFO = { timebase: TIMEBASE, frameRate: 29.97, zeroPointTicks: '0' };
var ONCE = {
  matched: true,
  segments: [{ seqStartTicks: '0', seqEndTicks: String(Timemap.secondsToTicks(2000)), inPointTicks: '0' }],
  unsupported: []
};
// The same source used again 3000 s later (a recap): two valid placements for every cue.
var TWICE = {
  matched: true,
  segments: [
    ONCE.segments[0],
    {
      seqStartTicks: String(Timemap.secondsToTicks(3000)),
      seqEndTicks: String(Timemap.secondsToTicks(5000)),
      inPointTicks: '0'
    }
  ],
  unsupported: []
};

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'cue-documents', name), 'utf8'));
}

function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

function waitFor(predicate) {
  return new Promise(function (resolve, reject) {
    var n = 0;
    (function poll() {
      if (predicate()) { resolve(); return; }
      if (++n > 200) { reject(new Error('timed out')); return; }
      setTimeout(poll, 5);
    })();
  });
}

function passage(display, body, words) {
  return {
    reference_display: display + ' (KJV)',
    body: body,
    word_count: words,
    truncated: false
  };
}

// A client answering from a table; `down` makes every call report an unreachable service.
function fakeClient(table) {
  var c = { calls: [], down: false };
  c.resolve = function (request) {
    c.calls.push(request);
    if (c.down) {
      return Promise.resolve({ ok: false, error: { code: 'unreachable', message: 'The text service is down.' } });
    }
    var key = typeof request === 'string' ? request : JSON.stringify(request);
    var data = table[key];
    return Promise.resolve(data ?
      { ok: true, data: data } :
      { ok: false, error: { code: 'bad_request', message: 'No such reference.' } });
  };
  return c;
}

function build(name, o) {
  o = o || {};
  var dom = new JSDOM('<div id="host"></div>');
  var doc = dom.window.document;
  var model = Cues.load(JSON.stringify(fixture(name))).model;
  var segments = o.segments || ONCE;
  var state = { playhead: o.playhead === undefined ? '0' : o.playhead, mapping: null, choice: {} };
  function remap() {
    state.mapping = Timemap.mapCueDocument(model.toJSON(), {
      seqInfo: SEQ_INFO, segments: segments, placementChoice: state.choice
    });
  }
  remap();
  var client = o.client || fakeClient({});
  var review = Review.create({
    root: doc.getElementById('host'),
    model: model,
    getPlacements: function () { return state.mapping.placements; },
    client: client,
    timing: {
      nudgedSource: function () { return null; },
      playheadSource: function () {
        return Promise.resolve(state.playhead === null ? null :
          Timemap.toSource(Timemap.buildMap(segments), state.playhead));
      }
    },
    timecodeOf: function (ticks) { return Timemap.timecode(ticks, SEQ_INFO); },
    onChoosePlacement: function (id, ticks) { state.choice[id] = ticks; remap(); },
    onChange: remap
  });
  return {
    doc: doc, model: model, state: state, review: review, client: client,
    $: function (sel) { return doc.querySelector(sel); },
    row: function (id) { return doc.querySelector('.row[data-cue-id="' + id + '"]'); },
    ids: function () {
      return Array.prototype.map.call(doc.querySelectorAll('.row'), function (r) {
        return r.getAttribute('data-cue-id');
      });
    }
  };
}

test('a manual cue appears in timecode order with 100% confidence', async function () {
  var client = fakeClient({ 'John 3:16': passage('John 3:16', 'For God so loved the world.', 6) });
  var c = build('happy-18-cues.json', { client: client, playhead: String(Timemap.secondsToTicks(100)) });
  var before = c.ids();
  c.$('.vf-review-add').click();
  assert.strictEqual(c.$('.vf-review-add-form').hidden, false);
  c.$('.vf-review-add-input').value = 'John 3:16';
  c.$('.vf-review-add-go').click();
  await waitFor(function () { return c.ids().length === before.length + 1; });
  var id = c.model.cues().filter(function (cue) { return cue.origin === 'manual'; })[0].id;
  assert.strictEqual(id, 'cue_m001');
  var cue = c.model.get(id);
  assert.strictEqual(cue.confidence, 1);
  assert.strictEqual(cue.source_anchor_s, 100);
  assert.strictEqual(c.row(id).querySelector('.vf-row-confidence').textContent, '100%');
  // The placements are in ascending time, so the new cue sits where 100 s falls in the order.
  var ticks = c.ids().map(function (i) { return c.state.mapping.placements[i]; })
    .filter(function (p) { return p.timecode; })
    .map(function (p) { return Number(p.atTicks); });
  var sortedTicks = ticks.slice().sort(function (a, b) { return a - b; });
  assert.deepStrictEqual(ticks, sortedTicks);
  assert.strictEqual(c.ids().indexOf(id), ticks.filter(function (t) {
    return t < Number(c.state.mapping.placements[id].atTicks);
  }).length);
  assert.deepStrictEqual(validate(c.model.toJSON()), []);
});

test('add cue reports an unknown reference and a playhead off the media without adding', async function () {
  var c = build('happy-18-cues.json');
  var count = c.model.cues().length;
  c.$('.vf-review-add').click();
  c.$('.vf-review-add-input').value = 'Nowhere 1:1';
  c.$('.vf-review-add-go').click();
  await waitFor(function () { return !c.$('.vf-review-add-error').hidden; });
  assert.strictEqual(c.$('.vf-review-add-error').textContent, 'No such reference.');
  c.state.playhead = null;
  c.$('.vf-review-add-go').click();
  await waitFor(function () {
    return c.$('.vf-review-add-error').textContent === 'Move the playhead over the media first.';
  });
  assert.strictEqual(c.model.cues().length, count);
});

test('choosing a placement alternative moves the cue', function () {
  var c = build('alternatives.json', { segments: TWICE });
  var id = 'cue_a02';
  var first = c.state.mapping.placements[id];
  assert.strictEqual(first.alternatives.length, 1);
  c.row(id).querySelector('.vf-row-snippet').click();
  var button = c.row(id).querySelector('.vf-detail-placement');
  assert.strictEqual(button.textContent, Timemap.timecode(first.alternatives[0], SEQ_INFO));
  button.click();
  var moved = c.state.mapping.placements[id];
  assert.strictEqual(moved.atTicks, first.alternatives[0]);
  assert.strictEqual(moved.alternatives[0], first.atTicks);
  assert.strictEqual(c.row(id).querySelector('.vf-row-timecode').textContent, moved.timecode);
  // The choice is panel state only: the document still anchors at the same source second.
  assert.strictEqual(c.model.get(id).source_anchor_s, 759.5);
  assert.ok(c.row(id).querySelector('.vf-row-detail'), 'the row stays open');
  // Picking the original position again moves it back.
  c.row(id).querySelector('.vf-detail-placement').click();
  assert.strictEqual(c.state.mapping.placements[id].atTicks, first.atTicks);
});

test('a cue with one placement lists no alternatives', function () {
  var c = build('alternatives.json');
  c.row('cue_a02').querySelector('.vf-row-snippet').click();
  assert.strictEqual(c.row('cue_a02').querySelector('.vf-detail-placements'), null);
});

test('empty.json shows the nothing-found message', function () {
  var c = build('empty.json');
  var note = c.$('.vf-review-empty');
  assert.ok(note && !note.hidden);
  assert.ok(note.textContent.indexOf(Review.EMPTY_TEXT) === 0);
  assert.strictEqual(c.$('.vf-review-insert-hint').hidden, true);
  assert.strictEqual(c.$('.vf-review-insert').disabled, true);
});

test('the idle text is the exact docs/09 section 7 sentence', function () {
  assert.strictEqual(Review.IDLE_TEXT, 'Select a media file and click Analyse.');
});

test('all cues disabled shows the insert hint and disables Insert', function () {
  var c = build('happy-18-cues.json');
  assert.strictEqual(c.$('.vf-review-insert-hint').hidden, true);
  c.$('.vf-review-none').click();
  assert.strictEqual(c.$('.vf-review-insert-hint').hidden, false);
  assert.strictEqual(c.$('.vf-review-insert-hint').textContent, 'Enable at least one scripture to insert.');
  assert.strictEqual(c.$('.vf-review-insert').disabled, true);
  c.$('.vf-review-all').click();
  assert.strictEqual(c.$('.vf-review-insert-hint').hidden, true);
});

test('the flagged fixture shows the retry banner and Retry text fetch re-resolves the cues', async function () {
  var doc = fixture('flagged.json');
  var stuck = doc.cues.filter(function (cue) { return cue.flags.indexOf('text_unavailable') !== -1; });
  assert.ok(stuck.length > 0);
  var table = {};
  stuck.forEach(function (cue) {
    table[JSON.stringify(cue.reference)] = passage('Psalm 1:1', 'Blessed is the man.', 4);
  });
  var c = build('flagged.json', { client: fakeClient(table) });
  var banner = c.$('.vf-review-banner');
  assert.strictEqual(banner.hidden, false);
  assert.strictEqual(c.$('.vf-review-retry-text').textContent, 'Retry text fetch');
  c.$('.vf-review-retry-text').click();
  await waitFor(function () { return c.$('.vf-review-banner').hidden; });
  assert.strictEqual(c.client.calls.length, stuck.length);
  stuck.forEach(function (cue) {
    assert.strictEqual(c.model.get(cue.id).flags.indexOf('text_unavailable'), -1);
    assert.strictEqual(c.model.get(cue.id).body, 'Blessed is the man.');
  });
});

test('a provider that is still down keeps the banner after one failed request', async function () {
  var client = fakeClient({});
  var c = build('flagged.json', { client: client });
  client.down = true;
  c.$('.vf-review-retry-text').click();
  await waitFor(function () { return !c.$('.vf-review-message').hidden; });
  await tick();
  assert.strictEqual(client.calls.length, 1);
  assert.strictEqual(c.$('.vf-review-banner').hidden, false);
  assert.strictEqual(c.$('.vf-review-message').textContent, 'The text service is down.');
  assert.strictEqual(c.$('.vf-review-retry-text').disabled, false);
});

test('no banner when no cue lacks text', function () {
  var c = build('happy-18-cues.json');
  assert.strictEqual(c.$('.vf-review-banner').hidden, true);
});
