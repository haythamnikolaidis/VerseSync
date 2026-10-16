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
var Duration = require(path.join(panel, 'js', 'duration.js'));
var validate = require(path.join(root, 'tests', 'lib', 'validate-cue-document.js')).validate;

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'cue-documents', name), 'utf8'));
}

function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

function waitFor(predicate) {
  return new Promise(function (resolve, reject) {
    var tries = 0;
    (function poll() {
      if (predicate()) { resolve(); return; }
      tries += 1;
      if (tries > 500) { reject(new Error('timed out')); return; }
      setTimeout(poll, 2);
    })();
  });
}

var LONG_BODY = new Array(61).join('word ').trim(); // 60 words

function passage(display, body) {
  return {
    reference_display: display, body: body, verses: [], word_count: body.split(' ').length,
    translation: { id: 'kjv-id', abbreviation: 'KJV', name: 'King James Version', attribution: '' },
    truncated: false, source: 'cache'
  };
}

// A client whose answers come from a table keyed by the request (string or object).
function fakeClient(answers) {
  var c = { requests: [] };
  c.resolve = function (request, translationId) {
    c.requests.push({ request: request, translationId: translationId });
    var key = typeof request === 'string' ? request : JSON.stringify(request);
    var answer = answers[key];
    if (!answer) {
      return Promise.resolve({ ok: false, error: { code: 'bad_request', message: 'No such reference.' } });
    }
    return Promise.resolve(answer);
  };
  return c;
}

function build(name, o) {
  o = o || {};
  var dom = new JSDOM('<div id="host"></div>');
  var doc = dom.window.document;
  var loaded = Cues.load(JSON.stringify(fixture(name)));
  var model = loaded.model;
  var remaps = [];
  var review = Review.create({
    root: doc.getElementById('host'),
    model: model,
    getPlacements: function () { return {}; },
    client: o.client === undefined ? null : o.client,
    getTranslationId: function () { return 'kjv-id'; },
    getDurationMode: function () { return o.mode || 'auto'; },
    onChange: function (id) { remaps.push(id); }
  });
  var t = {
    doc: doc, model: model, review: review, remaps: remaps,
    row: function (id) { return doc.querySelector('.row[data-cue-id="' + id + '"]'); },
    open: function (id) { t.row(id).querySelector('.vf-row-snippet').click(); return t.row(id); }
  };
  return t;
}

test('a valid edit updates the text, the flags, the duration and the origin, and re-maps', async function () {
  var client = fakeClient({
    'Romans 8:29': { ok: true, data: passage('Romans 8:29 (KJV)', LONG_BODY) }
  });
  var t = build('flagged.json', { client: client });
  var cue = t.model.cues()[0];
  var id = cue.id;
  t.model.edit(id, { flags: ['text_unavailable', 'chapter_only', 'low_confidence'], classification: 'paraphrase' });
  var row = t.open(id);
  var input = row.querySelector('.vf-detail-reference-input');
  input.value = 'Romans 8:29';
  row.querySelector('.vf-detail-resolve').click();
  await waitFor(function () { return t.remaps.length === 1; });
  await tick();

  var after = t.model.get(id);
  assert.strictEqual(after.reference_display, 'Romans 8:29 (KJV)');
  assert.deepStrictEqual(after.reference, { book: 'Romans', osis: 'Rom', chapter: 8, verse: 29 });
  assert.strictEqual(after.body, LONG_BODY);
  assert.strictEqual(after.body_word_count, 60);
  assert.strictEqual(after.body_truncated, false);
  assert.deepStrictEqual(after.flags, ['low_confidence']);
  assert.strictEqual(after.origin, 'edited');
  assert.strictEqual(after.source_duration_s, Duration.resolveDurationSeconds({ wordCount: 60 }, null));
  assert.notStrictEqual(after.source_duration_s, cue.source_duration_s);
  assert.deepStrictEqual(client.requests[0], { request: 'Romans 8:29', translationId: 'kjv-id' });
  assert.deepStrictEqual(validate(t.model.toJSON()), []);
  assert.ok(t.row(id).querySelector('.vf-row-detail'), 'the row stays open');
});

test('a fixed duration mode keeps the duration', async function () {
  var client = fakeClient({
    'Romans 8:29': { ok: true, data: passage('Romans 8:29 (KJV)', LONG_BODY) }
  });
  var t = build('flagged.json', { client: client, mode: 'fixed' });
  var id = t.model.cues()[0].id;
  t.model.edit(id, { classification: 'paraphrase', source_duration_s: 8 });
  var row = t.open(id);
  row.querySelector('.vf-detail-reference-input').value = 'Romans 8:29';
  row.querySelector('.vf-detail-resolve').click();
  await waitFor(function () { return t.remaps.length === 1; });
  assert.strictEqual(t.model.get(id).source_duration_s, 8);
});

test('Jude 5:1 shows the error inline and leaves the cue unchanged', async function () {
  var client = fakeClient({
    'Jude 5:1': { ok: false, error: { code: 'bad_request', message: 'Jude has only 1 chapter.' } }
  });
  var t = build('happy-18-cues.json', { client: client });
  var id = t.model.cues()[0].id;
  var before = JSON.stringify(t.model.get(id));
  var row = t.open(id);
  row.querySelector('.vf-detail-reference-input').value = 'Jude 5:1';
  row.querySelector('.vf-detail-resolve').click();
  var err = row.querySelector('.vf-detail-reference-error');
  await waitFor(function () { return !err.hidden; });
  assert.strictEqual(err.textContent, 'Jude has only 1 chapter.');
  assert.strictEqual(JSON.stringify(t.model.get(id)), before);
  assert.strictEqual(t.remaps.length, 0);
  assert.strictEqual(row.querySelector('.vf-detail-resolve').disabled, false, 'the editor can try again');
});

test('choosing the alternative in alternatives.json switches to Psalm 12:2', async function () {
  var alt = fixture('alternatives.json').cues[0].alternatives[0];
  var client = fakeClient({});
  client.resolve = function (request, translationId) {
    client.last = { request: request, translationId: translationId };
    return Promise.resolve({ ok: true, data: passage(alt.reference_display, alt.body) });
  };
  var t = build('alternatives.json', { client: client });
  var id = t.model.cues()[0].id;
  var row = t.open(id);
  row.querySelector('.vf-detail-alternative').click();
  await waitFor(function () { return t.remaps.length === 1; });
  var after = t.model.get(id);
  assert.strictEqual(after.reference_display, 'Psalm 12:2 (KJV)');
  assert.deepStrictEqual(after.reference, alt.reference);
  assert.strictEqual(after.body, alt.body);
  assert.deepStrictEqual(client.last.request, alt.reference);
  assert.strictEqual(after.flags.indexOf('chapter_only'), -1);
  assert.strictEqual(after.origin, 'edited');
  assert.deepStrictEqual(validate(t.model.toJSON()), []);
});

test('with no sidecar the field is disabled and gives a reason', function () {
  var t = build('happy-18-cues.json', { client: null });
  var row = t.open(t.model.cues()[0].id);
  assert.strictEqual(row.querySelector('.vf-detail-reference-input').disabled, true);
  assert.strictEqual(row.querySelector('.vf-detail-resolve').disabled, true);
  assert.match(row.querySelector('.vf-detail-reference-error').textContent, /text service is not running/);
});

test('an unreachable sidecar disables the field after the first failed call', async function () {
  var client = fakeClient({});
  client.resolve = function () {
    return Promise.resolve({ ok: false, error: { code: 'unreachable', message: 'The VerseSync sidecar is not responding.' } });
  };
  var t = build('happy-18-cues.json', { client: client });
  var id = t.model.cues()[0].id;
  var row = t.open(id);
  row.querySelector('.vf-detail-resolve').click();
  var input = row.querySelector('.vf-detail-reference-input');
  await waitFor(function () { return input.disabled; });
  assert.strictEqual(row.querySelector('.vf-detail-reference-error').textContent,
    'The VerseSync sidecar is not responding.');
  var other = t.open(t.model.cues()[1].id);
  assert.strictEqual(other.querySelector('.vf-detail-reference-input').disabled, true);
});
