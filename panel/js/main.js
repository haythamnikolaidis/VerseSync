(function (root) {
  'use strict';

  // Bootstrap: later tasks wire the sidecar, setup and review views in here.
  var hasCS = typeof root.CSInterface !== 'undefined';
  var bridge = root.VSBridge.create({
    csInterface: hasCS ? new root.CSInterface() : null,
    hostStub: root.VS,
    jsxPath: null
  });

  // Status strip and progress view (T-27.4). Exposed on VSApp so the smoke harness can drive
  // them with --eval; job wiring replaces those calls in a later task.
  var app = root.VSApp = {};
  var statusEl = root.document.getElementById('status');
  var hasSequence = false;
  var lastHealth = { state: 'starting', detail: null };

  function drawStatus() {
    root.VSProgress.renderStatus(statusEl,
      root.VSProgress.statusLine(lastHealth.state, lastHealth.detail, hasSequence));
  }

  app.setLifecycle = function (state, detail) {
    lastHealth = { state: state, detail: detail };
    drawStatus();
  };
  app.progress = root.VSProgress.view({
    root: root.document.getElementById('progress'),
    setupRoot: root.document.getElementById('setup'),
    onCancel: function () { if (app.onCancel) { app.onCancel(); } }
  });
  drawStatus();

  // Without Node (a plain browser, as in tools/panel_smoke.js) the Node transport cannot
  // work, so the fixture-backed stub transport stands in for the sidecar.
  if (typeof require === 'undefined' && root.VSSidecarStub) {
    var stubTransport = root.VSSidecarStub.create({
      scenario: root.VSSidecarStub.scenarioFromSearch(root.location && root.location.search)
    });
    root.VSSidecar.VSSidecarClient.create({ transport: stubTransport, port: 0, token: 'stub' })
      .health().then(function (res) {
        console.log('[VerseSync] stub sidecar health', JSON.stringify(res));
        if (res.ok) { app.setLifecycle(res.data.status, res.data); }
      });
  }

  bridge.init().then(function () {
    return bridge.call('ping', {});
  }).then(function (res) {
    console.log('[VerseSync] VS.ping', JSON.stringify(res));
    return bridge.call('getSequenceInfo', {});
  }).then(function (res) {
    hasSequence = !!(res && res.ok && res.data && res.data.hasActiveSequence);
    drawStatus();
  });
})(this);
