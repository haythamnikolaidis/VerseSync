'use strict';

// A fake window.cep.fs with the real API's shape, as listed from Premiere 26.5 (T-30.H):
// there is no showSaveDialog, only showSaveDialogEx, and readFile/writeFile reject any
// encoding but cep.encoding.UTF8 ("UTF-8") with err 5. The earlier per-test fakes accepted
// anything, which hid both mistakes until a real save was tried.

var ERR_INVALID_PARAMS = 5;
var ERR_NOT_FOUND = 3;
var UTF8 = 'UTF-8';

function create(media) {
  var f = { files: {}, saveAnswers: [], openAnswers: [], saveTitles: [] };
  f.showOpenDialog = function (multiple, directory, title, initial, extensions) {
    if (extensions.indexOf('mogrt') !== -1) { return { err: 0, data: ['C:\\t\\AV_Quote_04.mogrt'] }; }
    if (extensions.indexOf('json') !== -1) { return { err: 0, data: [f.openAnswers.shift()] }; }
    return { err: 0, data: [media] };
  };
  // showSaveDialogEx(title, initialPath, fileTypes, defaultName, friendlyFilePrefix, prompt, nameFieldLabel)
  f.showSaveDialogEx = function (title) {
    f.saveTitles.push(title);
    return { err: 0, data: f.saveAnswers.shift() };
  };
  f.writeFile = function (p, data, encoding) {
    if (encoding !== UTF8) { return { err: ERR_INVALID_PARAMS }; }
    f.files[p] = data;
    return { err: 0 };
  };
  f.readFile = function (p, encoding) {
    if (encoding !== UTF8) { return { err: ERR_INVALID_PARAMS, data: '' }; }
    return Object.prototype.hasOwnProperty.call(f.files, p) ?
      { err: 0, data: f.files[p] } : { err: ERR_NOT_FOUND, data: '' };
  };
  return f;
}

module.exports = { create: create, UTF8: UTF8 };
