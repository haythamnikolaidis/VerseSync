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

  // Sidecar status strip (docs/09 §2). Outside CEP there is no process API, so it stays idle.
  function initSidecar() {
    var el = document.getElementById('sidecar-status');
    if (!window.__adobe_cep__ || !window.cep) {
      el.textContent = 'Transcription service: not available outside Premiere';
      return;
    }
    var cs = new CSInterface();
    var client = VSSidecar.create(VSSidecar.cepPlatform({
      cep: window.cep,
      appData: cs.getSystemPath(SystemPath.USER_DATA)
    }));
    function render(status) {
      var strip = VSSidecar.computeStrip(status, true);
      el.textContent = strip.text + (strip.detail ? ' \u2014 ' + strip.detail.message +
        ' Log: ' + strip.detail.logPath : '');
    }
    client.onStatus(render);
    client.connect().then(function () {
      return client.resumeJob({});
    });
    window.VSSidecarClient = client;
  }

  function init() {
    initSidecar();
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
