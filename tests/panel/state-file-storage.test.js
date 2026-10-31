'use strict';

// fileStorage: panel settings written through to a file (T-30.H step 8). CEP's localStorage only
// reached disk on a clean Premiere quit, so a crash lost the session's settings.

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var os = require('node:os');
var path = require('node:path');

var State = require(path.join(__dirname, '..', '..', 'panel', 'js', 'state.js'));

function tmpFile(t) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-state-'));
  t.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });
  return path.join(dir, 'panel-state.json');
}

function memory(initial) {
  var data = Object.assign({}, initial || {});
  return {
    data: data,
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem: function (k, v) { data[k] = String(v); },
    removeItem: function (k) { delete data[k]; }
  };
}

test('every setItem is on disk immediately, before any shutdown', function (t) {
  var file = tmpFile(t);
  var store = State.fileStorage({ fs: fs, path: file });
  store.setItem('versesync.state', '{"version":1}');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { 'versesync.state': '{"version":1}' });
  assert.ok(!fs.existsSync(file + '.tmp'), 'the temp file is renamed into place');
});

test('a new instance (a Premiere restart) reads what the last one wrote', function (t) {
  var file = tmpFile(t);
  State.fileStorage({ fs: fs, path: file }).setItem('k', 'v');
  assert.strictEqual(State.fileStorage({ fs: fs, path: file }).getItem('k'), 'v');
});

test('settings restore through State.create across a restart', function (t) {
  var file = tmpFile(t);
  var first = State.create({ storage: State.fileStorage({ fs: fs, path: file }) });
  first.set({ mogrtPath: 'C:/t/AV_Quote_04.mogrt', translation: 'kjv', targetTrack: 2 });
  first.set({ referenceIndex: 7, bodyIndex: 3 });
  var second = State.create({ storage: State.fileStorage({ fs: fs, path: file }) }).get();
  assert.strictEqual(second.mogrtPath, 'C:/t/AV_Quote_04.mogrt');
  assert.strictEqual(second.translation, 'kjv');
  assert.strictEqual(second.targetTrack, 2);
  assert.strictEqual(second.referenceIndex, 7);
  assert.strictEqual(second.bodyIndex, 3);
});

test('a key missing from the file is migrated once from the old localStorage', function (t) {
  var file = tmpFile(t);
  var old = memory({ 'versesync.state': 'from-localStorage' });
  var store = State.fileStorage({ fs: fs, path: file, fallback: old });
  assert.strictEqual(store.getItem('versesync.state'), 'from-localStorage');
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8'))['versesync.state'], 'from-localStorage');
  old.setItem('versesync.state', 'stale');
  assert.strictEqual(State.fileStorage({ fs: fs, path: file, fallback: old }).getItem('versesync.state'),
    'from-localStorage', 'once in the file, the file wins');
});

test('removeItem clears the key in both places, so it does not migrate back', function (t) {
  var file = tmpFile(t);
  var old = memory({ activeJobId: 'job_1' });
  var store = State.fileStorage({ fs: fs, path: file, fallback: old });
  store.setItem('activeJobId', 'job_2');
  store.removeItem('activeJobId');
  assert.strictEqual(store.getItem('activeJobId'), null);
  assert.strictEqual(old.getItem('activeJobId'), null);
});

test('a corrupt file reads as empty instead of throwing', function (t) {
  var file = tmpFile(t);
  fs.writeFileSync(file, '{not json');
  var store = State.fileStorage({ fs: fs, path: file });
  assert.strictEqual(store.getItem('k'), null);
  store.setItem('k', 'v');
  assert.strictEqual(State.fileStorage({ fs: fs, path: file }).getItem('k'), 'v');
});

test('an unwritable location keeps working in memory for the session', function (t) {
  var file = path.join(tmpFile(t), 'no', 'such', 'dir', 'panel-state.json');
  var store = State.fileStorage({ fs: fs, path: file });
  store.setItem('k', 'v');
  assert.strictEqual(store.getItem('k'), 'v');
});
