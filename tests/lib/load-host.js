'use strict';

// Loads panel/jsx/VerseSync.jsx the way Premiere does: as a script evaluated once in a global
// scope, after which VS.* is called by name from later "evalScript" calls. The scope is a
// fresh vm context holding only the Premiere mock, so nothing leaks in from Node.
//
// By default the context has no native JSON, like the real ES3 engine, which makes the file's
// own JSON polyfill the one under test. Test tooling only.

var fs = require('node:fs');
var path = require('node:path');
var vm = require('node:vm');

var JSX_PATH = path.join(__dirname, '..', '..', 'panel', 'jsx', 'VerseSync.jsx');

function loadHost(premiere, options) {
  var opts = options || {};
  var context = vm.createContext({
    app: premiere.app,
    $: premiere.$,
    Time: premiere.Time,
    CSXSEvent: premiere.CSXSEvent
  });
  if (!opts.nativeJson) {
    vm.runInContext('delete this.JSON;', context);
  }
  vm.runInContext(fs.readFileSync(JSX_PATH, 'utf8'), context, { filename: JSX_PATH });

  // Each call is a separate evaluation in the shared global scope, as evalScript is. It
  // returns the raw string the host produced, which must be a JSON envelope.
  function callRaw(fnName, args) {
    var argJson = args === undefined ? '{}' : (typeof args === 'string' ? args : JSON.stringify(args));
    context.__argJson = argJson;
    return vm.runInContext('VS.' + fnName + '(__argJson)', context);
  }

  function call(fnName, args) {
    return JSON.parse(callRaw(fnName, args));
  }

  return { context: context, call: call, callRaw: callRaw, jsxPath: JSX_PATH };
}

module.exports = { loadHost: loadHost, JSX_PATH: JSX_PATH };
