(function (root) {
  'use strict';

  // Promise-based wrapper around CSInterface.evalScript (docs/08 §1), ported from
  // reference/verseflow/js/bridge.js. Kept from VerseFlow: the explicit $.evalFile() at init
  // (bypasses Premiere's ScriptPath cache) and the "EvalScript error." sentinel handling.
  // call() and init() never throw and never reject.

  var EVAL_ERROR = 'EvalScript error.';

  function fail(message) {
    return { ok: false, error: message };
  }

  // Turn the raw string a host function returned into {ok, data|error}.
  function parseResult(raw) {
    if (raw === EVAL_ERROR) {
      return fail('EvalScript error.');
    }
    if (typeof raw !== 'string' || raw === '') {
      return fail('Empty response from host');
    }
    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return fail('Host returned invalid JSON: ' + raw.slice(0, 120));
    }
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.ok !== 'boolean') {
      return fail('Host response has no ok flag: ' + raw.slice(0, 120));
    }
    return parsed;
  }

  // Extension root from the panel's own URL, e.g. file:///C:/ext/index.html -> C:/ext
  // (VerseFlow found getSystemPath unreliable in Premiere 2026).
  function pageLocation() {
    return typeof location !== 'undefined' ? location : (root.location || null);
  }

  function defaultJsxPath() {
    var href = '';
    try {
      href = decodeURIComponent(pageLocation().href);
    } catch (e) {
      href = '';
    }
    var dir = href
      .replace(/^file:\/\/\//, '')
      .replace(/^file:\/\//, '')
      .replace(/[?#].*$/, '')
      .replace(/\/[^\/]*$/, '');
    return dir + '/jsx/VerseSync.jsx';
  }

  function stubRequested() {
    try {
      return /[?&]stub=1(&|$)/.test(String(pageLocation().search || ''));
    } catch (e) {
      return false;
    }
  }

  function create(options) {
    options = options || {};
    var cs = options.csInterface || null;
    var hostStub = options.hostStub || null;
    var jsxPath = options.jsxPath || null;
    var mode = (!cs || stubRequested()) ? 'stub' : 'premiere';

    function evalRaw(script) {
      return new Promise(function (resolve) {
        try {
          cs.evalScript(script, function (raw) { resolve(raw); });
        } catch (e) {
          resolve(EVAL_ERROR);
        }
      });
    }

    function callStub(fnName, argJson) {
      try {
        if (!hostStub || typeof hostStub[fnName] !== 'function') {
          return Promise.resolve(fail('Unknown host function: ' + fnName));
        }
        return Promise.resolve(parseResult(hostStub[fnName](argJson)));
      } catch (e) {
        return Promise.resolve(fail('Host stub threw: ' + e));
      }
    }

    function callHost(fnName, args) {
      var argJson;
      try {
        argJson = JSON.stringify(args === undefined ? {} : args);
      } catch (e) {
        return Promise.resolve(fail('Arguments are not serialisable: ' + e));
      }
      if (mode === 'stub') {
        return callStub(fnName, argJson);
      }
      return evalRaw('VS.' + fnName + '(' + JSON.stringify(argJson) + ')').then(parseResult);
    }

    // Load the host explicitly, then ping it. Resolves {ok, data|error}.
    function init() {
      if (mode === 'stub') {
        return callHost('ping', {});
      }
      var path = String(jsxPath || defaultJsxPath()).replace(/\\/g, '/');
      return evalRaw('$.evalFile(' + JSON.stringify(path) + ')').then(function (loaded) {
        if (loaded === EVAL_ERROR) {
          return fail('$.evalFile failed for ' + path);
        }
        return callHost('ping', {});
      });
    }

    function onEvent(type, handler) {
      if (!cs || typeof cs.addEventListener !== 'function') {
        return;
      }
      cs.addEventListener(type, function (evt) {
        try {
          handler(evt);
        } catch (e) {
          // a faulty handler must not break the host event loop
        }
      });
    }

    return {
      mode: mode,
      init: init,
      call: callHost,
      onEvent: onEvent
    };
  }

  var Bridge = { create: create, parseResult: parseResult };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Bridge;
  } else {
    root.VSBridge = Bridge;
  }
})(this);
