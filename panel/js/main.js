(function (root) {
  'use strict';

  // Bootstrap stub: later tasks wire the sidecar and views in here.
  var hasCS = typeof root.CSInterface !== 'undefined';
  var bridge = root.VSBridge.create({
    csInterface: hasCS ? new root.CSInterface() : null,
    hostStub: root.VS,
    jsxPath: null
  });

  // Without Node (a plain browser, as in tools/panel_smoke.js) the Node transport cannot
  // work, so the fixture-backed stub transport stands in for the sidecar.
  if (typeof require === 'undefined' && root.VSSidecarStub) {
    var stubTransport = root.VSSidecarStub.create({
      scenario: root.VSSidecarStub.scenarioFromSearch(root.location && root.location.search)
    });
    root.VSSidecar.VSSidecarClient.create({ transport: stubTransport, port: 0, token: 'stub' })
      .health().then(function (res) {
        console.log('[VerseSync] stub sidecar health', JSON.stringify(res));
      });
  }

  bridge.init().then(function () {
    return bridge.call('ping', {});
  }).then(function (res) {
    console.log('[VerseSync] VS.ping', JSON.stringify(res));
  });
})(this);
