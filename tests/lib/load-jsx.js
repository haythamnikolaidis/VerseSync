'use strict';

// Loads panel/jsx/VerseSync.jsx (or any ES3 host script) into a fresh vm
// context that looks like Premiere's ExtendScript engine: the globals are
// app, $, CSXSEvent and File, and there is no native JSON, so the script's own
// polyfill is what gets exercised (docs/08 section 1).

const fs = require('fs');
const vm = require('vm');

function notModelled(name) {
  return function NotModelled() {
    throw new Error('NotModelled: ' + name + ' is not part of the fake Premiere yet');
  };
}

function assertAscii(source, jsxPath) {
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) > 127) {
      const line = source.slice(0, i).split('\n').length;
      throw new Error(
        'Host script ' + jsxPath + ' must be ASCII only; found non-ASCII character U+' +
        source.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0') + ' on line ' + line
      );
    }
  }
}

function loadJsx(jsxPath, fake) {
  const source = fs.readFileSync(jsxPath, 'utf8');
  assertAscii(source, jsxPath);

  const sandbox = {
    app: fake.app,
    $: fake.$,
    CSXSEvent: fake.CSXSEvent || notModelled('CSXSEvent'),
    File: fake.File || notModelled('File')
  };
  const context = vm.createContext(sandbox);
  // ExtendScript has no native JSON object.
  vm.runInContext('delete globalThis.JSON;', context);
  vm.runInContext(source, context, { filename: jsxPath });
  return { VS: context.VS, context: context };
}

module.exports = { loadJsx: loadJsx };
