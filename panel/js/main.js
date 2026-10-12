/**
 * main.js — panel bootstrap.
 * Load order: host-stub.js -> CSInterface.js -> bridge.js -> main.js
 */
(function () {
  'use strict';

  var statusLine = document.getElementById('status-line');
  var btnPing = document.getElementById('btn-ping');
  var diagOutput = document.getElementById('diag-output');

  function setStatus(text, kind) {
    statusLine.textContent = text;
    statusLine.className = 'vs-status' + (kind ? ' vs-status--' + kind : '');
  }

  function showDiag(text) {
    diagOutput.textContent = text;
    diagOutput.hidden = false;
  }

  function ping() {
    return VSBridge.api.ping().then(function (res) {
      if (res.ok) {
        setStatus('Host connected (' + VSBridge.mode() + ', v' + res.data.version + ')', 'ok');
        showDiag(JSON.stringify(res, null, 2));
      } else {
        setStatus('Host unavailable: ' + res.error, 'error');
        showDiag(JSON.stringify(res, null, 2));
      }
      return res;
    });
  }

  // Sidecar client. Inside Premiere it launches and attaches to the real sidecar. In a plain
  // browser a developer can point the panel at a running mock with
  //   ?sidecarPort=NNNN&sidecarToken=TOKEN
  // otherwise the strip reports the service as unavailable (docs/09 §2).
  function createClient() {
    if (window.__adobe_cep__ && window.cep) {
      var cs = new CSInterface();
      return VSSidecar.create(VSSidecar.cepPlatform({
        cep: window.cep,
        appData: cs.getSystemPath(SystemPath.USER_DATA)
      }));
    }
    var m = /[?&]sidecarPort=(\d+)&sidecarToken=([^&]+)/.exec(window.location.search || '');
    if (!m) { return null; }
    var lock = { pid: 1, port: Number(m[1]), token: decodeURIComponent(m[2]) };
    return VSSidecar.create({
      logPath: '',
      fetch: function (url, init) { return window.fetch(url, init); },
      storage: {
        get: function (k) { return window.localStorage.getItem(k); },
        set: function (k, v) { window.localStorage.setItem(k, v); },
        remove: function (k) { window.localStorage.removeItem(k); }
      },
      sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
      readLock: function () { return Promise.resolve(lock); },
      deleteLock: function () { return Promise.resolve(); },
      isPidAlive: function () { return Promise.resolve(true); },
      launch: function () {
        return Promise.resolve({ ok: false, error: 'Launching is not available outside Premiere.' });
      }
    });
  }

  function initSetup() {
    var client = createClient();
    window.VSSidecarClient = client;
    window.VSSetupUI = VSSetup.mount({ client: client });
    if (client) { client.connect(); }
  }

  function init() {
    initSetup();
    btnPing.addEventListener('click', ping);

    // Load the host script explicitly before any other call; bypasses the ScriptPath cache.
    setStatus('Loading host script…');
    VSBridge.loadJSX().then(function (loaded) {
      if (!loaded.ok) {
        setStatus(loaded.error, 'error');
        return;
      }
      return ping();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
