(function (root) {
  'use strict';

  // Node-http transport and API client for the sidecar (docs/07 §1.2, §1.3, §2, §3).
  // Nothing here ever throws or rejects: every failure is returned as {ok:false, error}.

  var HOST = '127.0.0.1';
  // The panel's CEP origin (D21). Node lets us set Origin explicitly; browser pages cannot.
  var PANEL_ORIGIN = 'cep://com.versesync.panel';
  var API_HEADER = 'x-versesync-api';
  var SUPPORTED_API_MAJOR = 1;

  // ---- transport ------------------------------------------------------------------------

  function parseJson(text) {
    if (typeof text !== 'string' || text === '') { return null; }
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  function createNodeTransport(http) {
    // request() resolves {status, headers, json}; a network error resolves status 0.
    function request(opts) {
      return new Promise(function (resolve) {
        var settled = false;
        function finish(result) {
          if (!settled) {
            settled = true;
            resolve(result);
          }
        }
        var payload = null;
        var headers = {};
        var k;
        for (k in (opts.headers || {})) {
          if (Object.prototype.hasOwnProperty.call(opts.headers, k)) { headers[k] = opts.headers[k]; }
        }
        if (opts.body !== undefined && opts.body !== null) {
          payload = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
          headers['Content-Type'] = 'application/json';
          headers['Content-Length'] = Buffer.byteLength(payload);
        }
        try {
          var req = http.request({
            host: HOST,
            port: opts.port,
            path: opts.path,
            method: opts.method || 'GET',
            headers: headers
          }, function (res) {
            var chunks = [];
            res.setEncoding('utf8');
            res.on('data', function (c) { chunks.push(c); });
            res.on('end', function () {
              finish({ status: res.statusCode, headers: res.headers || {}, json: parseJson(chunks.join('')) });
            });
            res.on('error', function () { finish({ status: 0, headers: {}, json: null }); });
          });
          req.on('error', function () { finish({ status: 0, headers: {}, json: null }); });
          if (payload !== null) { req.write(payload); }
          req.end();
        } catch (e) {
          finish({ status: 0, headers: {}, json: null });
        }
      });
    }

    // Incremental SSE parser: feed() takes arbitrary chunks, emits whole events.
    function createSseParser(onEvent) {
      var buffer = '';
      var eventName = 'message';
      var dataLines = [];

      function dispatch() {
        if (dataLines.length > 0) {
          var data = parseJson(dataLines.join('\n'));
          if (data !== null) { onEvent(eventName, data); }
        }
        eventName = 'message';
        dataLines = [];
      }

      function line(text) {
        if (text === '') { dispatch(); return; }
        if (text.charAt(0) === ':') { return; }
        var idx = text.indexOf(':');
        var field = idx === -1 ? text : text.slice(0, idx);
        var value = idx === -1 ? '' : text.slice(idx + 1);
        if (value.charAt(0) === ' ') { value = value.slice(1); }
        if (field === 'event') { eventName = value; }
        else if (field === 'data') { dataLines.push(value); }
      }

      return {
        feed: function (chunk) {
          buffer += chunk;
          var parts = buffer.split(/\r\n|\n|\r/);
          buffer = parts.pop();
          for (var i = 0; i < parts.length; i++) { line(parts[i]); }
        }
      };
    }

    // stream() calls onEnd(reason) exactly once: 'end', 'error', 'http_<status>' or 'closed'.
    function stream(opts, onEvent, onEnd) {
      var ended = false;
      var closed = false;
      var req = null;
      function end(reason) {
        if (ended) { return; }
        ended = true;
        try { onEnd(closed ? 'closed' : reason); } catch (e) { /* caller's handler failed */ }
      }
      try {
        var headers = {};
        var k;
        for (k in (opts.headers || {})) {
          if (Object.prototype.hasOwnProperty.call(opts.headers, k)) { headers[k] = opts.headers[k]; }
        }
        headers.Accept = 'text/event-stream';
        req = http.request({
          host: HOST,
          port: opts.port,
          path: opts.path,
          method: 'GET',
          headers: headers
        }, function (res) {
          if (res.statusCode < 200 || res.statusCode > 299) {
            res.resume();
            end('http_' + res.statusCode);
            return;
          }
          var parser = createSseParser(function (name, data) {
            if (closed) { return; }
            try { onEvent(name, data); } catch (e) { /* caller's handler failed */ }
          });
          res.setEncoding('utf8');
          res.on('data', function (c) { parser.feed(c); });
          res.on('end', function () { end('end'); });
          res.on('error', function () { end('error'); });
          res.on('aborted', function () { end('error'); });
        });
        req.on('error', function () { end('error'); });
        req.end();
      } catch (e) {
        end('error');
      }
      return {
        close: function () {
          closed = true;
          if (req) { try { req.destroy(); } catch (e) { /* already gone */ } }
          end('closed');
        }
      };
    }

    return { request: request, stream: stream };
  }

  // ---- client ---------------------------------------------------------------------------

  function failure(code, message, hint, status) {
    return { ok: false, error: { code: code, message: message, hint: hint || '', status: status } };
  }

  function headerValue(headers, name) {
    if (!headers) { return undefined; }
    if (headers[name] !== undefined) { return headers[name]; }
    for (var k in headers) {
      if (Object.prototype.hasOwnProperty.call(headers, k) && k.toLowerCase() === name) { return headers[k]; }
    }
    return undefined;
  }

  function apiMajor(value) {
    var major = parseInt(String(value).split('.')[0], 10);
    return isNaN(major) ? null : major;
  }

  function create(opts) {
    var transport = opts.transport;
    var port = opts.port;
    var token = opts.token;

    function call(method, path, body, authenticated) {
      var headers = {};
      if (authenticated) {
        headers.Authorization = 'Bearer ' + token;
        headers.Origin = PANEL_ORIGIN;
      }
      var pending;
      try {
        pending = Promise.resolve(transport.request({
          method: method, port: port, path: path, headers: headers, body: body
        }));
      } catch (e) {
        pending = Promise.resolve({ status: 0 });
      }
      return pending.then(function (res) {
        if (!res || !res.status) {
          return failure('unreachable', 'The VerseSync sidecar is not responding.',
            'Check that the sidecar is running, then try again.', 0);
        }
        var version = headerValue(res.headers, API_HEADER);
        if (version !== undefined && apiMajor(version) !== SUPPORTED_API_MAJOR) {
          return failure('api_version_mismatch',
            'The sidecar speaks API version ' + version + ', but this panel needs version ' +
            SUPPORTED_API_MAJOR + '.x.',
            'Update VerseSync so the panel and the sidecar match.', res.status);
        }
        if (res.status < 200 || res.status > 299) {
          var env = res.json && res.json.error;
          if (env && typeof env === 'object') {
            return failure(env.code || 'internal', env.message || 'The sidecar reported an error.',
              env.hint, res.status);
          }
          if (res.status === 401) {
            return failure('unauthorized', 'The sidecar rejected the panel\'s credentials.',
              'Restart the sidecar so the panel can pick up a fresh token.', 401);
          }
          return failure('http_' + res.status, 'The sidecar returned HTTP ' + res.status + '.', '', res.status);
        }
        return { ok: true, data: res.json };
      }, function () {
        return failure('unreachable', 'The VerseSync sidecar is not responding.',
          'Check that the sidecar is running, then try again.', 0);
      }).then(null, function (e) {
        return failure('internal', 'Unexpected error talking to the sidecar: ' + (e && e.message), '', 0);
      });
    }

    function jobPath(id, suffix) {
      return '/jobs/' + encodeURIComponent(id) + (suffix || '');
    }

    return {
      health: function () { return call('GET', '/health', null, false); },
      models: function () { return call('GET', '/models', null, true); },
      translations: function () { return call('GET', '/translations', null, true); },
      startJob: function (req) { return call('POST', '/jobs', req, true); },
      job: function (id) { return call('GET', jobPath(id), null, true); },
      result: function (id) { return call('GET', jobPath(id, '/result'), null, true); },
      transcript: function (id) { return call('GET', jobPath(id, '/transcript'), null, true); },
      cancel: function (id) { return call('DELETE', jobPath(id), null, true); },
      resolve: function (refOrObj, translationId) {
        return call('POST', '/resolve', { reference: refOrObj, translation_id: translationId }, true);
      },
      shutdown: function () { return call('POST', '/shutdown', null, true); }
    };
  }

  var VSSidecarClient = { create: create };
  var VSSidecar = {
    PANEL_ORIGIN: PANEL_ORIGIN,
    createNodeTransport: createNodeTransport,
    VSSidecarClient: VSSidecarClient
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = VSSidecar;
  } else {
    root.VSSidecar = VSSidecar;
    root.VSSidecarClient = VSSidecarClient;
  }
})(this);
