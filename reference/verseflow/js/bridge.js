/**
 * bridge.js — thin, promisified wrapper around CSInterface.evalScript.
 * All host calls go through bridge.call(fnName, argObject) -> Promise.
 *
 * JSX loading strategy: we do NOT rely on the manifest ScriptPath cache.
 * Instead, loadJSX() uses $.evalFile() to explicitly load VerseFlow.jsx
 * at panel startup. This is more reliable in Premiere 2026 where the
 * ScriptPath may serve a stale cached version from a prior session.
 *
 * Path strategy: getSystemPath(EXTENSION) returns "Invalid Input Params" in
 * Premiere 2026. We fall back to deriving the extension root from
 * window.location.href, which is always correct inside a CEP panel.
 */
(function () {
  'use strict';

  var EVAL_ERROR      = 'EvalScript error.';
  var CALL_TIMEOUT_MS = 15000;

  var _cs = null;
  function _getCS() {
    if (!_cs) _cs = new CSInterface();
    return _cs;
  }

  // Promise that resolves when the JSX is loaded. All calls wait on this.
  var _jsxReady = null;

  // ── Extension root ────────────────────────────────────────────────────────

  /**
   * Return the absolute path to the extension's root directory.
   * Primary: CSInterface.getSystemPath — fast when it works.
   * Fallback: parse window.location.href — always available in CEP.
   *   file:///C:/path/to/extension/index.html
   *     → strip file:///  → C:/path/to/extension/index.html
   *     → strip filename  → C:/path/to/extension
   */
  function _getExtensionRoot() {
    try {
      var p = _getCS().getSystemPath(SystemPath.EXTENSION);
      if (p && p.length > 3 && p !== 'Invalid Input Params') {
        return p.replace(/\\/g, '/');
      }
    } catch (e) {}

    // Derive from the panel's own URL
    var href = decodeURIComponent(window.location.href);
    // Strip file:/// (Windows) or file:// (Mac) then remove the filename
    return href
      .replace(/^file:\/\/\//, '')   // file:///C:/...  → C:/...
      .replace(/^file:\/\//, '')     // file:///path    → /path  (already handled above on Win)
      .replace(/\/[^\/]+$/, '');     // strip /index.html
  }

  // ── Raw evalScript with timeout ───────────────────────────────────────────

  function rawEval(script) {
    return new Promise(function (resolve, reject) {
      var done  = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error('evalScript timed out (' + CALL_TIMEOUT_MS / 1000 + 's)'));
      }, CALL_TIMEOUT_MS);

      console.log('[VFBridge] ->', script.slice(0, 120));
      try {
        _getCS().evalScript(script, function (raw) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          console.log('[VFBridge] <-', String(raw).slice(0, 200));
          resolve(raw);
        });
      } catch (e) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new Error('evalScript threw: ' + e));
      }
    });
  }

  // ── JSX loader ────────────────────────────────────────────────────────────

  /**
   * loadJSX() -> Promise
   * Resolves once VerseFlow.jsx has been evaluated and VF.ping confirms it
   * loaded correctly. Call once at panel init; all subsequent call()s wait
   * on this promise automatically.
   */
  function loadJSX() {
    if (_jsxReady) return _jsxReady;

    _jsxReady = new Promise(function (resolve, reject) {
      var extRoot = _getExtensionRoot();
      var jsxPath = extRoot + '/jsx/VerseFlow.jsx';

      console.log('[VFBridge] Loading JSX from:', jsxPath);

      // $.evalFile evaluates the file in the persistent ExtendScript engine.
      // Unlike ScriptPath, this always reads the file fresh from disk.
      rawEval('$.evalFile("' + jsxPath + '")')
        .then(function (evalResult) {
          console.log('[VFBridge] $.evalFile result:', evalResult);

          // If $.evalFile itself threw, reject immediately rather than
          // silently falling through to the stale ScriptPath-cached VF.
          if (evalResult === EVAL_ERROR) {
            throw new Error(
              '$.evalFile failed for path: ' + jsxPath +
              '. Verify the extension is installed at that location.'
            );
          }

          // Verify VF.ping is now a callable function
          return rawEval('typeof VF.ping');
        })
        .then(function (pingType) {
          if (pingType === 'function') {
            console.log('[VFBridge] JSX loaded OK — VF.ping is a function');
            resolve();
          } else {
            throw new Error(
              'JSX loaded but VF.ping is not a function (got: ' + pingType + '). ' +
              'Check jsx/VerseFlow.jsx for errors.'
            );
          }
        })
        .catch(function (e) {
          _jsxReady = null; // allow retry
          reject(new Error('Failed to load JSX: ' + e.message));
        });
    });

    return _jsxReady;
  }

  // ── Public call() ─────────────────────────────────────────────────────────

  /**
   * call(fnName, argObject) -> Promise<data>
   * Waits for JSX to be loaded, then calls the function.
   */
  function call(fnName, argObject) {
    return loadJSX().then(function () {
      var argJson = argObject !== undefined ? JSON.stringify(argObject) : '{}';
      var script  = fnName + '(' + JSON.stringify(argJson) + ')';

      return rawEval(script).then(function (rawResult) {
        if (rawResult === EVAL_ERROR || rawResult === null || rawResult === undefined) {
          throw new Error(
            fnName + ' threw an ExtendScript error. ' +
            'Check the browser console for the raw response.'
          );
        }
        var parsed;
        try {
          parsed = JSON.parse(rawResult);
        } catch (e) {
          throw new Error('Non-JSON from ' + fnName + ': ' + rawResult);
        }
        if (!parsed.ok) {
          throw new Error(parsed.error || 'Host error in ' + fnName);
        }
        return parsed.data;
      });
    });
  }

  // ── Diagnostic ────────────────────────────────────────────────────────────

  function diagnose() {
    var lines = [];
    function step(label, fn) {
      return fn()
        .then(function (v) { lines.push('OK  ' + label + (v !== undefined ? ': ' + v : '')); })
        .catch(function (e) { lines.push('ERR ' + label + ': ' + e.message); });
    }

    var extRoot = _getExtensionRoot();
    var jsxPath = extRoot + '/jsx/VerseFlow.jsx';

    var p = step('__adobe_cep__ present', function () {
      return Promise.resolve(!!window.__adobe_cep__);
    });
    p = p.then(function () {
      return step('evalScript("1+1")', function () { return rawEval('1+1'); });
    });
    p = p.then(function () {
      return step('extension root', function () { return Promise.resolve(extRoot); });
    });
    p = p.then(function () {
      return step('$.evalFile JSX', function () {
        return rawEval('$.evalFile("' + jsxPath + '")')
          .then(function (r) {
            if (r === EVAL_ERROR) throw new Error('$.evalFile returned EvalScript error — bad path or JSX syntax error');
            return r;
          });
      });
    });
    p = p.then(function () {
      return step('typeof vfOk',    function () { return rawEval('typeof vfOk'); });
    });
    p = p.then(function () {
      return step('typeof JSON',    function () { return rawEval('typeof JSON'); });
    });
    p = p.then(function () {
      return step('typeof VF',      function () { return rawEval('typeof VF'); });
    });
    p = p.then(function () {
      return step('typeof VF.ping', function () { return rawEval('typeof VF.ping'); });
    });
    p = p.then(function () {
      return step('VF.ping call',   function () {
        // Wrap in try-catch so ExtendScript returns the real error message
        return rawEval('(function(){try{return VF.ping("{}");}catch(e){return "CAUGHT:"+e.toString();}})()')
          .then(function (r) {
            if (r === EVAL_ERROR) throw new Error('VF.ping threw before try-catch could run');
            if (String(r).indexOf('CAUGHT:') === 0) throw new Error(r);
            return r;
          });
      });
    });

    return p.then(function () { return lines.join('\n'); });
  }

  function addEventListener(type, handler) {
    _getCS().addEventListener(type, handler);
  }

  window.VFBridge = {
    loadJSX:          loadJSX,
    call:             call,
    diagnose:         diagnose,
    rawEval:          rawEval,
    addEventListener: addEventListener,
    getExtensionRoot: _getExtensionRoot
  };
})();
