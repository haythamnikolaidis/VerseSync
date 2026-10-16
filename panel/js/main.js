(function (root) {
  'use strict';

  // Bootstrap stub: later tasks wire the sidecar and views in here.
  var hasCS = typeof root.CSInterface !== 'undefined';
  var bridge = root.VSBridge.create({
    csInterface: hasCS ? new root.CSInterface() : null,
    hostStub: root.VS,
    jsxPath: null
  });

  bridge.init().then(function () {
    return bridge.call('ping', {});
  }).then(function (res) {
    console.log('[VerseSync] VS.ping', JSON.stringify(res));
  });
})(this);
