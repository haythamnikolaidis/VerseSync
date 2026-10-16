'use strict';

// Loads panel/jsx/VerseSync.jsx (or any ES3 host script) into a fresh vm
// context that looks like Premiere's ExtendScript engine: the globals are
// app, $, CSXSEvent, Time and File, and there is no native JSON, so the
// script's own polyfill is what gets exercised (docs/08 section 1).

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
    Time: fake.Time || notModelled('Time'),
    File: fake.File || notModelled('File')
  };
  const context = vm.createContext(sandbox);
  // ExtendScript has no native JSON object.
  vm.runInContext('delete globalThis.JSON;', context);
  vm.runInContext(source, context, { filename: jsxPath });
  // A FatalHostError cannot be caught by the script (T-03). The vm cannot skip
  // a script's catch, so the fake records the error and each VS entry point
  // rethrows it to the Node caller once the call returns.
  const VS = context.VS;
  if (VS && typeof fake.fatal !== 'undefined') {
    Object.keys(VS).forEach(function (key) {
      const fn = VS[key];
      if (typeof fn !== 'function') {
        return;
      }
      VS[key] = function () {
        const result = fn.apply(this, arguments);
        if (fake.fatal !== null) {
          const err = fake.fatal;
          fake.fatal = null;
          throw err;
        }
        return result;
      };
    });
  }
  return { VS: VS, context: context };
}

module.exports = { loadJsx: loadJsx };
