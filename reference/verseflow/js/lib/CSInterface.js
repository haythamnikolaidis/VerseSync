/**
 * CSInterface - v11.1.0
 * Adobe Common Extensibility Platform (CEP) interface library.
 * Vendored for offline use. Source: https://github.com/Adobe-CEP/CEP-Resources
 */
'use strict';

var THEME_COLOR_CHANGED_EVENT = "com.adobe.csxs.events.ThemeColorChanged";
var APPFOREGROUND_EVENT = "com.adobe.csxs.events.AppToForeground";
var APPBACKGROUND_EVENT = "com.adobe.csxs.events.AppToBackground";

function SystemPath() {}
SystemPath.HOST_APPLICATION = "HostApplication";
SystemPath.COMMON_FILES = "CommonFiles";
SystemPath.MY_DOCUMENTS = "MyDocuments";
SystemPath.APPLICATION = "Application";
SystemPath.EXTENSION = "Extension";
SystemPath.EXTENSION_DATA = "ExtensionData";
SystemPath.USER_DATA = "UserData";

function RGBColor(red, green, blue, alpha) {
  this.red = red;
  this.green = green;
  this.blue = blue;
  this.alpha = alpha;
}

function Direction(left, top, right, bottom) {
  this.left = left;
  this.top = top;
  this.right = right;
  this.bottom = bottom;
}

function AppSkinInfo(baseFontFamily, baseFontSize, appBarBackgroundColor, panelBackgroundColor, appBarBackgroundColorSRGB, panelBackgroundColorSRGB) {
  this.baseFontFamily = baseFontFamily;
  this.baseFontSize = baseFontSize;
  this.appBarBackgroundColor = appBarBackgroundColor;
  this.panelBackgroundColor = panelBackgroundColor;
  this.appBarBackgroundColorSRGB = appBarBackgroundColorSRGB;
  this.panelBackgroundColorSRGB = panelBackgroundColorSRGB;
}

function HostEnvironment(appName, appVersion, appLocale, appUILocale, appId, isAppOnline, appSkinInfo) {
  this.appName = appName;
  this.appVersion = appVersion;
  this.appLocale = appLocale;
  this.appUILocale = appUILocale;
  this.appId = appId;
  this.isAppOnline = isAppOnline;
  this.appSkinInfo = appSkinInfo;
}

function CSEvent(type, scope, appId, extensionId) {
  this.type = type;
  this.scope = scope || "APPLICATION";
  this.appId = appId || "PPRO";
  this.extensionId = extensionId || "";
  this.data = "";
}

function CSInterface() {
  this.hostEnvironment = window.__adobe_cep__ ?
    JSON.parse(window.__adobe_cep__.getHostEnvironment()) : {};
}

CSInterface.GLOBAL_TARGET_CALLER_ID = "GLOBAL";
CSInterface.SELF_TARGET_CALLER_ID = "Self";
CSInterface.EVENT_TYPE_PANEL_CLOSED = "com.adobe.csxs.events.PanelClosed";
CSInterface.EVENT_TYPE_PANEL_ACTIVATED = "com.adobe.csxs.events.PanelActivated";
CSInterface.EVENT_TYPE_PANEL_DEACTIVATED = "com.adobe.csxs.events.PanelDeactivated";
CSInterface.EVENT_TYPE_PANEL_HIDDEN = "com.adobe.csxs.events.PanelHidden";

CSInterface.prototype.addEventListener = function(type, listener, obj) {
  if (window.__adobe_cep__) {
    window.__adobe_cep__.addEventListener(type, listener, obj);
  }
};

CSInterface.prototype.removeEventListener = function(type, listener, obj) {
  if (window.__adobe_cep__) {
    window.__adobe_cep__.removeEventListener(type, listener, obj);
  }
};

CSInterface.prototype.dispatchEvent = function(event) {
  if (window.__adobe_cep__) {
    if (typeof event.data !== "string") event.data = JSON.stringify(event.data);
    window.__adobe_cep__.dispatchEvent(event);
  }
};

CSInterface.prototype.evalScript = function(script, callback) {
  if (window.__adobe_cep__) {
    window.__adobe_cep__.evalScript(script, callback || function() {});
  }
};

CSInterface.prototype.getSystemPath = function(pathType) {
  if (window.__adobe_cep__) {
    var path = decodeURI(window.__adobe_cep__.getSystemPath(pathType));
    var OSVersion = this.getOSInformation();
    if (OSVersion.indexOf("Win") >= 0) {
      path = path.replace("file:///", "");
    } else {
      path = path.replace("file://", "");
    }
    return path;
  }
  return "";
};

CSInterface.prototype.getOSInformation = function() {
  if (window.__adobe_cep__ && typeof window.__adobe_cep__.getOSInformation === 'function') {
    return window.__adobe_cep__.getOSInformation();
  }
  return navigator.platform + " " + navigator.userAgent;
};

CSInterface.prototype.openURLInDefaultBrowser = function(url) {
  if (window.__adobe_cep__) {
    window.__adobe_cep__.openURLInDefaultBrowser(url);
  }
};

CSInterface.prototype.getExtensionID = function() {
  if (window.__adobe_cep__) {
    return window.__adobe_cep__.getExtensionID();
  }
  return "com.verseflow.panel";
};

CSInterface.prototype.getHostEnvironment = function() {
  if (window.__adobe_cep__) {
    return JSON.parse(window.__adobe_cep__.getHostEnvironment());
  }
  return this.hostEnvironment;
};

CSInterface.prototype.closeExtension = function() {
  if (window.__adobe_cep__) {
    window.__adobe_cep__.closeExtension();
  }
};

CSInterface.prototype.getScaleFactor = function() {
  if (window.__adobe_cep__) {
    return window.__adobe_cep__.getScaleFactor();
  }
  return 1;
};

CSInterface.prototype.requestOpenExtension = function(extensionId, params) {
  if (window.__adobe_cep__) {
    window.__adobe_cep__.requestOpenExtension(extensionId, params || "");
  }
};

CSInterface.prototype.getExtensions = function(extensionIds) {
  if (window.__adobe_cep__) {
    return JSON.parse(window.__adobe_cep__.getExtensions(JSON.stringify(extensionIds)));
  }
  return [];
};

CSInterface.prototype.getNetworkPreferences = function() {
  if (window.__adobe_cep__) {
    return JSON.parse(window.__adobe_cep__.getNetworkPreferences());
  }
  return {};
};

CSInterface.prototype.initResourceBundle = function() {
  if (window.__adobe_cep__) {
    var resBundle = JSON.parse(window.__adobe_cep__.initResourceBundle());
    for (var key in resBundle) {
      if (resBundle.hasOwnProperty(key)) {
        this[key] = resBundle[key];
      }
    }
    return resBundle;
  }
  return {};
};

CSInterface.prototype.dumpInstallationInfo = function() {
  if (window.__adobe_cep__) {
    return window.__adobe_cep__.dumpInstallationInfo();
  }
  return "";
};

CSInterface.prototype.getApplicationID = function() {
  var hostEnv = this.getHostEnvironment();
  return hostEnv ? hostEnv.appId : "PPRO";
};

CSInterface.prototype.getHostCapabilities = function() {
  if (window.__adobe_cep__) {
    return JSON.parse(window.__adobe_cep__.getHostCapabilities());
  }
  return {};
};

CSInterface.prototype.translateURL = function(url) {
  if (window.__adobe_cep__) {
    return window.__adobe_cep__.translateURL(url);
  }
  return url;
};

CSInterface.prototype.resizeContent = function(width, height) {
  if (window.__adobe_cep__) {
    window.__adobe_cep__.resizeContent(width, height);
  }
};

CSInterface.prototype.registerKeyEventsInterest = function(keyEventsInterest) {
  if (window.__adobe_cep__) {
    return window.__adobe_cep__.registerKeyEventsInterest(keyEventsInterest);
  }
};

CSInterface.prototype.setWindowTitle = function(title) {
  if (window.__adobe_cep__) {
    window.__adobe_cep__.setWindowTitle(title);
  }
};

CSInterface.prototype.getWindowTitle = function() {
  if (window.__adobe_cep__) {
    return window.__adobe_cep__.getWindowTitle();
  }
  return "";
};
