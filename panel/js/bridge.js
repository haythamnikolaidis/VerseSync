/**
 * bridge.js — promisified wrapper around CSInterface.evalScript.
 *
 * Every host call goes through VSBridge.call(fnName, argObject) and resolves to
 *   { ok: true,  data: ... }   or   { ok: false, error: "message" }.
 * The returned promise NEVER rejects and no function here throws: the host cannot throw
 * across the bridge (docs/08 §1), so the panel does not pretend it can.
 *
 * JSX loading: the manifest ScriptPath is not relied on. loadJSX() explicitly $.evalFile()s
 * jsx/VerseSync.jsx at init, which always reads the file fresh from disk. Premiere's
 * ScriptPath cache can otherwise serve a stale host script from an earlier session.
 *
 * Failure sentinel: evalScript reports ExtendScript failures by passing the string
 * "EvalScript error." to the callback instead of raising anything, so that string (and the
 * "undefined"/empty results of a host function that returned nothing) is checked explicitly.
 *
 * Extension root: getSystemPath(EXTENSION) returns "Invalid Input Params" in Premiere 2026,
 * so the root falls back to being derived from window.location.href.
 *
 * Stub: when not running inside Premiere (no window.__adobe_cep__) and js/lib/host-stub.js
 * has installed window.VS, calls are routed to the stub. Inside Premiere the stub is never
 * used, even if ?stub=1 is present.
 */
(function () {
  'use strict';

  var EVAL_ERROR = 'EvalScript error.';
  var CALL_TIMEOUT_MS = 15000;
  var JSX_RELATIVE_PATH = '/jsx/VerseSync.jsx';

  // The seven calls of the host contract (docs/08).
  var HOST_FUNCTIONS = [
    'ping', 'getSequenceInfo', 'getMediaSegments', 'getMogrtFields',
    'insertCues', 'setPlayhead', 'validateTrack'
  ];

  var _cs = null;
  var _jsxReady = null;

  function _fail(message) {
    return { ok: false, error: String(message) };
  }

  function _log() {
    if (typeof console !== 'undefined' && console.log) {
      console.log.apply(console, arguments);
    }
  }

  function _insidePremiere() {
    return typeof window !== 'undefined' && !!window.__adobe_cep__;
  }

  function _stub() {
    if (_insidePremiere()) { return null; }
    if (typeof window !== 'undefined' && window.VS && typeof window.VS.ping === 'function') {
      return window.VS;
    }
    return null;
  }

  function _getCS() {
    if (!_cs) { _cs = new CSInterface(); }
    return _cs;
  }

  function _getExtensionRoot() {
    try {
      var p = _getCS().getSystemPath(SystemPath.EXTENSION);
      if (p && p.length > 3 && p !== 'Invalid Input Params') {
        return p.replace(/\\/g, '/');
      }
    } catch (e) { /* fall through to the URL-derived root */ }

    var href = decodeURIComponent(window.location.href);
    return href
      .replace(/^file:\/\/\//, '')   // file:///C:/x/index.html -> C:/x/index.html
      .replace(/^file:\/\//, '')     // file:///x/index.html (mac) -> /x/index.html
      .replace(/\/[^\/]+$/, '');     // strip /index.html
  }

  /** rawEval(script) -> Promise<string>. Resolves with the raw string, rejects on timeout/throw. */
  function rawEval(script) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) { return; }
        done = true;
        reject(new Error('evalScript timed out (' + CALL_TIMEOUT_MS / 1000 + 's)'));
      }, CALL_TIMEOUT_MS);

      _log('[VSBridge] ->', String(script).slice(0, 120));
      try {
        _getCS().evalScript(script, function (raw) {
          if (done) { return; }
          done = true;
          clearTimeout(timer);
          _log('[VSBridge] <-', String(raw).slice(0, 200));
          resolve(raw);
        });
      } catch (e) {
        if (done) { return; }
        done = true;
        clearTimeout(timer);
        reject(new Error('evalScript threw: ' + e));
      }
    });
  }

  /** Parse a host response string into {ok,data}|{ok,error}. Never throws. */
  function _parseHostResult(fnName, raw) {
    if (raw === EVAL_ERROR) {
      return _fail(fnName + ' threw an ExtendScript error (EvalScript error.)');
    }
    if (raw === null || raw === undefined || raw === '' || raw === 'undefined') {
      return _fail(fnName + ' returned no result');
    }
    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return _fail('Non-JSON from ' + fnName + ': ' + raw);
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.ok !== 'boolean') {
      return _fail('Malformed response from ' + fnName + ': ' + raw);
    }
    if (!parsed.ok) {
      return _fail(parsed.error || 'Host error in ' + fnName);
    }
    return { ok: true, data: parsed.data };
  }

  function _argJson(argObject) {
    return JSON.stringify(argObject !== undefined ? argObject : {});
  }

  /**
   * loadJSX() -> Promise<{ok,data}|{ok,error}>
   * Evaluates the host script fresh from disk and confirms VS.ping is callable. Call once at
   * init; call() waits on it. A failure is not cached, so a later call retries.
   */
  function loadJSX() {
    if (_jsxReady) { return _jsxReady; }

    if (_stub()) {
      return Promise.resolve({ ok: true, data: { stub: true } });
    }

    var attempt = new Promise(function (resolve) {
      var jsxPath;
      try {
        jsxPath = _getExtensionRoot() + JSX_RELATIVE_PATH;
      } catch (e) {
        resolve(_fail('Could not determine the extension path: ' + e));
        return;
      }
      _log('[VSBridge] Loading JSX from:', jsxPath);

      rawEval('$.evalFile(' + JSON.stringify(jsxPath) + ')')
        .then(function (evalResult) {
          if (evalResult === EVAL_ERROR) {
            return _fail(
              '$.evalFile failed for ' + jsxPath +
              '. Verify the extension is installed at that location and the script has no syntax error.'
            );
          }
          // Confirm the freshly evaluated script defines the contract, rather than trusting
          // whatever an earlier session may have left in the persistent engine.
          return rawEval('typeof VS === "object" && typeof VS.ping').then(function (t) {
            if (t === 'function') { return { ok: true, data: { path: jsxPath } }; }
            return _fail('Host script loaded but VS.ping is not a function (got: ' + t + ').');
          });
        })
        .then(resolve, function (e) {
          resolve(_fail('Failed to load JSX: ' + (e && e.message ? e.message : e)));
        });
    }).then(function (result) {
      if (!result.ok) { _jsxReady = null; }  // allow retry
      return result;
    });

    _jsxReady = attempt;
    return attempt;
  }

  /**
   * call(fnName, argObject) -> Promise<{ok,data}|{ok,error}>
   * Waits for loadJSX(), invokes VS.<fnName>(<JSON string>) and parses the JSON string reply.
   */
  function call(fnName, argObject) {
    return loadJSX().then(function (loaded) {
      if (!loaded.ok) { return loaded; }

      var argJson;
      try {
        argJson = _argJson(argObject);
      } catch (e) {
        return _fail('Could not serialise arguments for ' + fnName + ': ' + e);
      }

      var stub = _stub();
      if (stub) {
        if (typeof stub[fnName] !== 'function') {
          return _fail('Unknown host function: ' + fnName);
        }
        try {
          return _parseHostResult(fnName, stub[fnName](argJson));
        } catch (e) {
          return _fail(fnName + ' threw in the host stub: ' + e);
        }
      }

      return rawEval('VS.' + fnName + '(' + JSON.stringify(argJson) + ')').then(
        function (raw) { return _parseHostResult(fnName, raw); },
        function (e) { return _fail(e && e.message ? e.message : e); }
      );
    }).then(null, function (e) {
      return _fail(e && e.message ? e.message : e);
    });
  }

  function addEventListener(type, handler) {
    try {
      _getCS().addEventListener(type, handler);
    } catch (e) { /* no CEP runtime (browser/stub): nothing to listen to */ }
  }

  var api = {};
  HOST_FUNCTIONS.forEach(function (name) {
    api[name] = function (argObject) { return call(name, argObject); };
  });

  var VSBridge = {
    loadJSX: loadJSX,
    call: call,
    rawEval: rawEval,
    addEventListener: addEventListener,
    getExtensionRoot: _getExtensionRoot,
    mode: function () { return _stub() ? 'stub' : 'host'; },
    api: api
  };

  if (typeof window !== 'undefined') {
    window.VSBridge = VSBridge;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = VSBridge;
  }
})();
