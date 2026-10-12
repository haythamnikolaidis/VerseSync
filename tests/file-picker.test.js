'use strict';

// pickFileCEP (ported from VerseFlow) against a fake window.cep. The real dialog needs Premiere.

var test = require('node:test');
var assert = require('node:assert');

var VSSetup = require('../panel/js/setup');

function fakeCep(result, calls) {
  return { fs: { showOpenDialog: function () {
    calls.push(Array.prototype.slice.call(arguments));
    if (result instanceof Error) { throw result; }
    return result;
  } } };
}

test('passes the title and extensions to cep.fs.showOpenDialog and returns the first path', function () {
  var calls = [];
  var r = VSSetup.pickFileCEP(fakeCep({ err: 0, data: ['D:/a.mxf', 'D:/b.mxf'] }, calls),
                              'Select the sermon media', ['mp4', 'mxf']);
  assert.deepStrictEqual(r, { path: 'D:/a.mxf' });
  // (allowMultiple, chooseDirectory, title, initialPath, fileTypes)
  assert.deepStrictEqual(calls[0], [false, false, 'Select the sermon media', null, ['mp4', 'mxf']]);
});

test('a cancelled dialog is a null path, not an error', function () {
  assert.deepStrictEqual(VSSetup.pickFileCEP(fakeCep({ err: 0, data: [] }, []), 't', ['mogrt']), { path: null });
  assert.deepStrictEqual(VSSetup.pickFileCEP(fakeCep({ err: 1, data: null }, []), 't', ['mogrt']), { path: null });
});

test('a missing or throwing dialog reports an error instead of throwing', function () {
  assert.ok(VSSetup.pickFileCEP(undefined, 't', []).error);
  assert.ok(VSSetup.pickFileCEP({ fs: {} }, 't', []).error);
  assert.ok(VSSetup.pickFileCEP(fakeCep(new Error('boom'), []), 't', []).error);
});

test('the media filter offers the audio/video extensions from FR-1.1', function () {
  assert.deepStrictEqual(VSSetup.MEDIA_EXTENSIONS,
    ['wav', 'mp3', 'm4a', 'aac', 'flac', 'mp4', 'mov', 'mxf']);
});
