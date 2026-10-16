'use strict';

// Test helper: runs tools/mock_sidecar.py as a real process for the integration tests.
// Every process it starts, directly or through the lifecycle's childProcess wrapper, is
// killed by cleanup(), so a failing test never leaves a sidecar behind.

var childProcess = require('node:child_process');
var fs = require('node:fs');
var os = require('node:os');
var path = require('node:path');

var MOCK_PATH = path.join(__dirname, '..', '..', '..', 'tools', 'mock_sidecar.py');

function pythonAvailable() {
  var res = childProcess.spawnSync('python3', ['--version'], { stdio: 'ignore' });
  return !res.error && res.status === 0;
}

// A temp world: APPDATA and VERSESYNC_HOME point inside it, so the mock's lock file lands
// exactly where the lifecycle looks for it (<APPDATA>/VerseSync/sidecar.json).
function createMockEnv() {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), 'versesync-mock-'));
  var home = path.join(root, 'VerseSync');
  var env = { APPDATA: root, VERSESYNC_HOME: home };
  var children = [];

  function childEnv() {
    var merged = {};
    var k;
    for (k in process.env) {
      if (Object.prototype.hasOwnProperty.call(process.env, k)) { merged[k] = process.env[k]; }
    }
    for (k in env) {
      if (Object.prototype.hasOwnProperty.call(env, k)) { merged[k] = env[k]; }
    }
    return merged;
  }

  // The command the lifecycle should launch: python3 mock_sidecar.py --port 0 <flags>.
  function launchCommand(flags) {
    return ['python3', MOCK_PATH, '--port', '0'].concat(flags || []);
  }

  // Drop-in for the lifecycle's childProcess: same spawn, but with the temp env and tracking.
  var tracked = {
    spawnCount: 0,
    spawn: function (exe, args, options) {
      tracked.spawnCount++;
      var opts = {};
      for (var k in options) {
        if (Object.prototype.hasOwnProperty.call(options, k)) { opts[k] = options[k]; }
      }
      opts.env = childEnv();
      var child = childProcess.spawn(exe, args, opts);
      children.push(child);
      return child;
    }
  };

  function readLock() {
    return JSON.parse(fs.readFileSync(path.join(home, 'sidecar.json'), 'utf8'));
  }

  // Starts the mock directly and resolves with its port and token, parsed from stdout.
  function spawnMock(flags) {
    return new Promise(function (resolve, reject) {
      var child = childProcess.spawn('python3', launchCommand(flags).slice(1),
        { env: childEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
      children.push(child);
      var out = '';
      var port = null;
      var token = null;
      child.on('error', reject);
      child.on('exit', function () { reject(new Error('mock exited before printing its port')); });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', function (chunk) {
        out += chunk;
        var p = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
        var t = /token: (\S+)/.exec(out);
        if (p) { port = Number(p[1]); }
        if (t) { token = t[1]; }
        if (port !== null && token !== null) {
          resolve({ port: port, token: token, pid: child.pid, child: child });
        }
      });
    });
  }

  function cleanup() {
    var pids = children.map(function (c) { return c.pid; });
    try { pids.push(readLock().pid); } catch (e) { /* no lock file was written */ }
    pids.forEach(function (pid) {
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch (e) { /* already gone */ } }
    });
    children.forEach(function (c) {
      if (c.stdout) { c.stdout.destroy(); }
    });
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* temp dir busy */ }
  }

  return {
    env: env,
    home: home,
    launchCommand: launchCommand,
    childProcess: tracked,
    readLock: readLock,
    spawnMock: spawnMock,
    cleanup: cleanup
  };
}

module.exports = { MOCK_PATH: MOCK_PATH, pythonAvailable: pythonAvailable, createMockEnv: createMockEnv };
