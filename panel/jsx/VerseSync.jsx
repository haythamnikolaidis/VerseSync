/**
 * VerseSync.jsx -- ExtendScript host, single consolidated file.
 * All code is inlined here to avoid #include path-resolution issues in Premiere 2026.
 *
 * NOTE: All helpers use `var fn = function(){}` rather than `function fn(){}`.
 * In Premiere 2026's ExtendScript engine, $.evalFile() does not hoist function
 * declarations into the persistent global scope. Using var expressions ensures
 * _ok, _err, and all private helpers are accessible when VS.* methods are
 * called from a later evalScript() call.
 *
 * ES3 and ASCII only. Every VS.* function takes one JSON string and returns
 * one JSON string; it never throws across the bridge (docs/08 section 1).
 */

// ---- JSON polyfill ----------------------------------------------------------
// Premiere 2026's ExtendScript engine (ES3) has no native JSON object.
// This minimal implementation uses only ASCII source characters to avoid
// encoding problems when the file is loaded via $.evalFile().

var JSON = JSON || {};

(function () {
    // Characters that must be escaped in JSON strings
    var MUST_ESCAPE = /[\x00-\x1f\\"]/g;

    var ESCAPES = {};
    ESCAPES['"']  = '\\"';
    ESCAPES['\\'] = '\\\\';
    ESCAPES['\b'] = '\\b';
    ESCAPES['\f'] = '\\f';
    ESCAPES['\n'] = '\\n';
    ESCAPES['\r'] = '\\r';
    ESCAPES['\t'] = '\\t';

    var escChar = function (c) {
        var e = ESCAPES[c];
        if (e) return e;
        return '\\u00' + ('0' + c.charCodeAt(0).toString(16)).slice(-2);
    };

    var escStr = function (s) {
        return '"' + s.replace(MUST_ESCAPE, escChar) + '"';
    };

    var str = function (val) {
        if (val === null)                          return 'null';
        var t = typeof val;
        if (t === 'boolean')                       return val ? 'true' : 'false';
        if (t === 'number')                        return isFinite(val) ? String(val) : 'null';
        if (t === 'string')                        return escStr(val);
        if (t === 'undefined' || t === 'function') return undefined;

        var i, out, k, v;

        if (val instanceof Array) {
            out = [];
            for (i = 0; i < val.length; i++) {
                v = str(val[i]);
                out.push(v === undefined ? 'null' : v);
            }
            return '[' + out.join(',') + ']';
        }

        out = [];
        for (k in val) {
            if (Object.prototype.hasOwnProperty.call(val, k)) {
                v = str(val[k]);
                if (v !== undefined) {
                    out.push(escStr(k) + ':' + v);
                }
            }
        }
        return '{' + out.join(',') + '}';
    };

    if (typeof JSON.stringify !== 'function') {
        JSON.stringify = function (value) { return str(value); };
    }

    if (typeof JSON.parse !== 'function') {
        // eval() is safe here -- we only parse strings we generated internally
        // through the bridge, never untrusted user input.
        JSON.parse = function (text) {
            return eval('(' + String(text) + ')');
        };
    }
}());

// ---- VS namespace -----------------------------------------------------------
var VS = {};

// ---- Constants --------------------------------------------------------------
var VS_VERSION = '1.0.0';
var VS_HOST_API = '1.1';
var VS_TICKS_PER_SECOND = 254016000000;

// docs/08 section 9
var VS_MSG_NO_SEQUENCE = 'Open a sequence in Premiere first.';

// ---- Response helpers -------------------------------------------------------

var _ok = function (data) {
    return JSON.stringify({ ok: true, data: data });
};

var _err = function (msg) {
    return JSON.stringify({ ok: false, error: String(msg) });
};

// Every VS.* function is built with _wrap, which parses the single JSON
// argument and turns any thrown error into an _err response.
var _wrap = function (name, fn) {
    return function (argsJson) {
        try {
            var args = {};
            if (argsJson !== undefined && argsJson !== null && argsJson !== '') {
                args = JSON.parse(argsJson);
            }
            return fn(args || {});
        } catch (e) {
            return _err(name + ': ' + e);
        }
    };
};

// ---- VS.ping ----------------------------------------------------------------

VS.ping = _wrap('ping', function (args) {
    return _ok({ pong: true, version: VS_VERSION, hostApi: VS_HOST_API });
});
