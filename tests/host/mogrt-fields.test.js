'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadJsx } = require('../lib/load-jsx');
const { createFakePremiere, AV_QUOTE_04_FIELDS, AV_QUOTE_04_FIELDS_NO_TYPES } = require('../lib/fake-premiere');

const JSX = path.join(__dirname, '..', '..', 'panel', 'jsx', 'VerseSync.jsx');
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'host', 'mogrt-fields.json');
const TEMPLATE = 'D:/Templates/AV_Quote_04.mogrt';

function fakeWithTemplate(fields) {
  const fake = createFakePremiere();
  fake.addSequence({ id: 'seq-1', name: 'Main', endTicks: '254016000000', videoTracks: 2 });
  fake.registerMogrt(TEMPLATE, fields);
  return fake;
}

function call(fake, args) {
  const raw = loadJsx(JSX, fake).VS.getMogrtFields(JSON.stringify(args));
  return JSON.parse(raw);
}

function scratchClipCount(fake) {
  const seq = fake.app.project.activeSequence;
  let n = 0;
  for (let t = 0; t < seq.videoTracks.numTracks; t++) {
    n += seq.videoTracks[t].clips.length;
  }
  return n;
}

test('getMogrtFields output equals the mogrt-fields fixture', () => {
  const expected = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const res = call(fakeWithTemplate(AV_QUOTE_04_FIELDS), { path: TEMPLATE });
  assert.deepStrictEqual(res, { ok: true, data: expected });
});

test('groups are found when the host reports no propertyType (Premiere 26.5)', () => {
  const res = call(fakeWithTemplate(AV_QUOTE_04_FIELDS_NO_TYPES), { path: TEMPLATE });
  assert.deepStrictEqual(res.data.fields.map((x) => x.label), ['Title Main > Text', 'Description > Text']);
  assert.deepStrictEqual(res.data.fields.map((x) => x.group), ['Title Main', 'Description']);
});

test('both Text fields come back with different indices and group labels', () => {
  const res = call(fakeWithTemplate(AV_QUOTE_04_FIELDS), { path: TEMPLATE });
  const f = res.data.fields;
  assert.strictEqual(f.length, 2);
  assert.strictEqual(f[0].name, 'Text');
  assert.strictEqual(f[1].name, 'Text');
  assert.notStrictEqual(f[0].index, f[1].index);
  assert.deepStrictEqual(f.map((x) => x.label), ['Title Main > Text', 'Description > Text']);
});

test('the scratch clip is removed and the undo groups balance', () => {
  const fake = fakeWithTemplate(AV_QUOTE_04_FIELDS);
  call(fake, { path: TEMPLATE });
  assert.strictEqual(scratchClipCount(fake), 0);
  assert.strictEqual(fake.openUndoGroups(), 0);
  assert.strictEqual(fake.undoLog[0].type, 'begin');
});

test('undo groups balance when importMGT returns null', () => {
  const fake = fakeWithTemplate(AV_QUOTE_04_FIELDS);
  fake.failImportFor(TEMPLATE);
  const res = call(fake, { path: TEMPLATE });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(
    res.error,
    'Premiere could not insert the template. Check the .mogrt path is still valid.'
  );
  assert.strictEqual(fake.openUndoGroups(), 0);
});

test('no sequence gives the field-discovery message', () => {
  const fake = createFakePremiere();
  const res = call(fake, { path: TEMPLATE });
  assert.deepStrictEqual(res, {
    ok: false,
    error: 'Open a sequence in Premiere first -- reading a template\'s fields requires an active sequence.'
  });
  assert.strictEqual(fake.openUndoGroups(), 0);
});

test('a missing path is reported', () => {
  const res = call(fakeWithTemplate(AV_QUOTE_04_FIELDS), {});
  assert.deepStrictEqual(res, { ok: false, error: 'No path provided' });
});

test('a template with no text fields gives an empty list', () => {
  const res = call(fakeWithTemplate([]), { path: TEMPLATE });
  assert.deepStrictEqual(res, { ok: true, data: { fields: [] } });
});
