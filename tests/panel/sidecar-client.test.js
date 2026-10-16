'use strict';

var test = require('node:test');
var assert = require('node:assert');
var http = require('node:http');
var path = require('node:path');

var Sidecar = require(path.join(__dirname, '..', '..', 'panel', 'js', 'sidecar.js'));
var Client = Sidecar.VSSidecarClient;

// Throwaway server: records every request and answers per handler(req, res, body).
function startServer(handler) {
  return new Promise(function (resolve) {
    var seen = [];
    var server = http.createServer(function (req, res) {
      var chunks = [];
      req.on('data', function (c) { chunks.push(c); });
      req.on('end', function () {
        var body = Buffer.concat(chunks).toString('utf8');
        seen.push({ method: req.method, url: req.url, headers: req.headers, body: body });
        handler(req, res, body);
      });
    });
    server.listen(0, '127.0.0.1', function () {
      resolve({
        port: server.address().port,
        seen: seen,
        close: function () { server.closeAllConnections(); return new Promise(function (r) { server.close(r); }); }
      });
    });
  });
}

function json(res, status, obj, extra) {
  var headers = { 'Content-Type': 'application/json', 'X-VerseSync-Api': '1.0' };
  for (var k in (extra || {})) { headers[k] = extra[k]; }
  res.writeHead(status, headers);
  res.end(JSON.stringify(obj));
}

function makeClient(port) {
  return Client.create({ transport: Sidecar.createNodeTransport(http), port: port, token: 'tok123' });
}

test('authenticated calls send the bearer token and the panel Origin', async function () {
  var srv = await startServer(function (req, res) { json(res, 200, { models: [] }); });
  try {
    var r = await makeClient(srv.port).models();
    assert.deepStrictEqual(r, { ok: true, data: { models: [] } });
    assert.strictEqual(srv.seen[0].headers.authorization, 'Bearer tok123');
    assert.strictEqual(srv.seen[0].headers.origin, 'cep://com.versesync.panel');
  } finally { await srv.close(); }
});

test('/health is sent without credentials', async function () {
  var srv = await startServer(function (req, res) { json(res, 200, { status: 'ready' }); });
  try {
    var r = await makeClient(srv.port).health();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.data.status, 'ready');
    assert.strictEqual(srv.seen[0].headers.authorization, undefined);
    assert.strictEqual(srv.seen[0].headers.origin, undefined);
  } finally { await srv.close(); }
});

test('POST bodies are JSON and routes map to the documented paths', async function () {
  var srv = await startServer(function (req, res) { json(res, 200, {}); });
  try {
    var c = makeClient(srv.port);
    await c.startJob({ media: 'a.wav' });
    await c.resolve('Romans 8:28', 'tr1');
    await c.job('j 1');
    await c.result('j1');
    await c.transcript('j1');
    await c.cancel('j1');
    await c.translations();
    await c.shutdown();
    var seen = srv.seen.map(function (s) { return s.method + ' ' + s.url; });
    assert.deepStrictEqual(seen, [
      'POST /jobs', 'POST /resolve', 'GET /jobs/j%201', 'GET /jobs/j1/result',
      'GET /jobs/j1/transcript', 'DELETE /jobs/j1', 'GET /translations', 'POST /shutdown'
    ]);
    assert.deepStrictEqual(JSON.parse(srv.seen[0].body), { media: 'a.wav' });
    assert.deepStrictEqual(JSON.parse(srv.seen[1].body),
      { reference: 'Romans 8:28', translation_id: 'tr1' });
  } finally { await srv.close(); }
});

test('an error envelope becomes {ok:false, error}', async function () {
  var srv = await startServer(function (req, res) {
    json(res, 404, { error: { code: 'job_not_found', message: 'No such job.', hint: 'Start a new one.' } });
  });
  try {
    var r = await makeClient(srv.port).job('nope');
    assert.deepStrictEqual(r, {
      ok: false,
      error: { code: 'job_not_found', message: 'No such job.', hint: 'Start a new one.', status: 404 }
    });
  } finally { await srv.close(); }
});

test('a 401 with no body is reported as unauthorized', async function () {
  var srv = await startServer(function (req, res) {
    res.writeHead(401, { 'X-VerseSync-Api': '1.0' });
    res.end();
  });
  try {
    var r = await makeClient(srv.port).models();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error.code, 'unauthorized');
    assert.strictEqual(r.error.status, 401);
  } finally { await srv.close(); }
});

test('a non-2xx without an envelope still maps to an error', async function () {
  var srv = await startServer(function (req, res) {
    res.writeHead(500, { 'X-VerseSync-Api': '1.0' });
    res.end('<html>boom</html>');
  });
  try {
    var r = await makeClient(srv.port).models();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error.code, 'http_500');
  } finally { await srv.close(); }
});

test('a 2xx with an unparseable body yields ok with null data', async function () {
  var srv = await startServer(function (req, res) {
    res.writeHead(200, { 'X-VerseSync-Api': '1.0' });
    res.end('not json');
  });
  try {
    var r = await makeClient(srv.port).models();
    assert.deepStrictEqual(r, { ok: true, data: null });
  } finally { await srv.close(); }
});

test('a closed port gives unreachable and does not reject', async function () {
  var srv = await startServer(function (req, res) { json(res, 200, {}); });
  var port = srv.port;
  await srv.close();
  var r = await makeClient(port).health();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'unreachable');
  assert.strictEqual(r.error.status, 0);
});

test('a server that hangs up mid-response gives unreachable', async function () {
  var srv = await startServer(function (req, res) { req.socket.destroy(); });
  try {
    var r = await makeClient(srv.port).models();
    assert.strictEqual(r.error.code, 'unreachable');
  } finally { await srv.close(); }
});

test('an API major version other than 1 is api_version_mismatch', async function () {
  var srv = await startServer(function (req, res) {
    json(res, 200, { status: 'ready' }, { 'X-VerseSync-Api': '2.0' });
  });
  try {
    var r = await makeClient(srv.port).health();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error.code, 'api_version_mismatch');
    assert.strictEqual(r.error.status, 200);
  } finally { await srv.close(); }
});

test('a minor version bump within major 1 is accepted', async function () {
  var srv = await startServer(function (req, res) {
    json(res, 200, { status: 'ready' }, { 'X-VerseSync-Api': '1.7' });
  });
  try {
    assert.strictEqual((await makeClient(srv.port).health()).ok, true);
  } finally { await srv.close(); }
});

test('a transport that rejects or throws never makes the client reject', async function () {
  var rejecting = Client.create({
    transport: { request: function () { return Promise.reject(new Error('x')); } }, port: 1, token: 't'
  });
  var throwing = Client.create({
    transport: { request: function () { throw new Error('x'); } }, port: 1, token: 't'
  });
  assert.strictEqual((await rejecting.health()).error.code, 'unreachable');
  assert.strictEqual((await throwing.health()).error.code, 'unreachable');
});

test('a malformed transport result is reported, not thrown', async function () {
  var odd = Client.create({
    transport: { request: function () { return Promise.resolve(undefined); } }, port: 1, token: 't'
  });
  assert.strictEqual((await odd.models()).error.code, 'unreachable');
});

// ---- SSE ----------------------------------------------------------------------------------

function collectStream(port, path) {
  var transport = Sidecar.createNodeTransport(http);
  return new Promise(function (resolve) {
    var events = [];
    transport.stream({ port: port, path: path, headers: { Authorization: 'Bearer tok123' } },
      function (name, data) { events.push([name, data]); },
      function (reason) { resolve({ events: events, reason: reason }); });
  });
}

test('SSE frames are parsed', async function () {
  var srv = await startServer(function (req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: progress\ndata: {"phase":"transcribing","progress":0.41}\n\n');
    res.write(': keep-alive\n\n');
    res.end('event: done\r\ndata: {"job_id":"j1"}\r\n\r\n');
  });
  try {
    var out = await collectStream(srv.port, '/jobs/j1/events');
    assert.deepStrictEqual(out.events, [
      ['progress', { phase: 'transcribing', progress: 0.41 }],
      ['done', { job_id: 'j1' }]
    ]);
    assert.strictEqual(out.reason, 'end');
    assert.strictEqual(srv.seen[0].headers.authorization, 'Bearer tok123');
    assert.strictEqual(srv.seen[0].headers.accept, 'text/event-stream');
  } finally { await srv.close(); }
});

test('SSE frames split across chunks are reassembled', async function () {
  var pieces = ['event: prog', 'ress\nda', 'ta: {"progress":', '0.5}\n', '\nevent: done\ndata: {"a"', ':1}\n\n'];
  var srv = await startServer(function (req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    var i = 0;
    (function next() {
      if (i >= pieces.length) { res.end(); return; }
      res.write(pieces[i++]);
      setTimeout(next, 10);
    })();
  });
  try {
    var out = await collectStream(srv.port, '/jobs/j1/events');
    assert.deepStrictEqual(out.events, [['progress', { progress: 0.5 }], ['done', { a: 1 }]]);
  } finally { await srv.close(); }
});

test('SSE multi-line data is joined and invalid JSON is skipped', async function () {
  var srv = await startServer(function (req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: progress\ndata: {"a":\ndata: 1}\n\n');
    res.end('event: progress\ndata: {oops\n\nevent: progress\ndata: {"b":2}\n\n');
  });
  try {
    var out = await collectStream(srv.port, '/x');
    assert.deepStrictEqual(out.events, [['progress', { a: 1 }], ['progress', { b: 2 }]]);
  } finally { await srv.close(); }
});

test('SSE with a non-2xx status ends with http_<status>', async function () {
  var srv = await startServer(function (req, res) { res.writeHead(404); res.end(); });
  try {
    var out = await collectStream(srv.port, '/jobs/x/events');
    assert.deepStrictEqual(out.events, []);
    assert.strictEqual(out.reason, 'http_404');
  } finally { await srv.close(); }
});

test('SSE to a closed port ends with error and does not throw', async function () {
  var srv = await startServer(function (req, res) { res.end(); });
  var port = srv.port;
  await srv.close();
  var out = await collectStream(port, '/jobs/x/events');
  assert.strictEqual(out.reason, 'error');
});

test('SSE dropped by the server mid-stream ends with error', async function () {
  var srv = await startServer(function (req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: progress\ndata: {"p":1}\n\n', function () { setTimeout(function () { req.socket.destroy(); }, 20); });
  });
  try {
    var out = await collectStream(srv.port, '/x');
    assert.deepStrictEqual(out.events, [['progress', { p: 1 }]]);
    assert.strictEqual(out.reason, 'error');
  } finally { await srv.close(); }
});

test('SSE close() stops delivery and reports closed once', async function () {
  var srv = await startServer(function (req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: progress\ndata: {"p":1}\n\n');
  });
  try {
    var transport = Sidecar.createNodeTransport(http);
    var reasons = [];
    var events = [];
    var handle;
    await new Promise(function (resolve) {
      handle = transport.stream({ port: srv.port, path: '/x', headers: {} },
        function (name, data) { events.push(data); handle.close(); resolve(); },
        function (reason) { reasons.push(reason); });
    });
    handle.close();
    await new Promise(function (r) { setTimeout(r, 30); });
    assert.deepStrictEqual(events, [{ p: 1 }]);
    assert.deepStrictEqual(reasons, ['closed']);
  } finally { await srv.close(); }
});

test('a throwing SSE handler does not break the stream', async function () {
  var srv = await startServer(function (req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('event: a\ndata: {"n":1}\n\nevent: a\ndata: {"n":2}\n\n');
  });
  try {
    var transport = Sidecar.createNodeTransport(http);
    var got = [];
    var reason = await new Promise(function (resolve) {
      transport.stream({ port: srv.port, path: '/x', headers: {} },
        function (name, data) { got.push(data.n); throw new Error('handler'); },
        function (r) { resolve(r); });
    });
    assert.deepStrictEqual(got, [1, 2]);
    assert.strictEqual(reason, 'end');
  } finally { await srv.close(); }
});

test('a transport whose http.request throws still resolves', async function () {
  var boom = { request: function () { throw new Error('no'); } };
  var transport = Sidecar.createNodeTransport(boom);
  var res = await transport.request({ method: 'GET', port: 1, path: '/', headers: {} });
  assert.strictEqual(res.status, 0);
  var reason = await new Promise(function (resolve) {
    transport.stream({ port: 1, path: '/', headers: {} }, function () {}, resolve);
  });
  assert.strictEqual(reason, 'error');
});
