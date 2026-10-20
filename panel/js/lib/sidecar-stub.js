(function (root) {
  'use strict';

  // Browser-only sidecar transport (docs/tasks/T-49). A plain browser page has no Node, so it
  // cannot use VSSidecar.createNodeTransport; this transport has the same interface
  // (request / stream) and answers from the golden Cue Document fixtures instead.

  var FIXTURE_DIR = '/tests/fixtures/cue-documents/';
  // Same scenario names and files as tools/mock_sidecar.py SCENARIOS.
  var SCENARIOS = {
    happy: 'happy-18-cues.json',
    flagged: 'flagged.json',
    alternatives: 'alternatives.json',
    empty: 'empty.json'
  };
  var DEFAULT_SCENARIO = 'happy';

  // Spec: T-49 step 1 ("jobs finish after a simulated 2 s of progress events").
  var JOB_MS = 2000;
  // Chosen: four progress events per job, enough to move a progress bar without flooding it.
  var TICK_MS = 500;
  var API_VERSION = '1.0';

  // Phase weights from docs/07 §4, as in tools/mock_sidecar.py.
  var PHASES = [
    ['hashing', 0.02],
    ['transcribing', 0.80],
    ['detecting', 0.05],
    ['resolving', 0.10],
    ['timing', 0.03]
  ];

  var MODELS = [
    {
      name: 'large-v3-turbo',
      word_timestamp_quality: 'good',
      supported_quantizations: { cuda: ['float16', 'bfloat16', 'float32'], cpu: ['float32'] },
      downloaded: true,
      recommended: true
    },
    {
      name: 'distil-large-v3',
      word_timestamp_quality: 'medium',
      supported_quantizations: { cuda: ['float16'], cpu: ['float32'] },
      downloaded: true,
      recommended: false
    }
  ];

  var TRANSLATIONS = [
    {
      id: 'de4e12af7f28f599-02',
      abbreviation: 'KJV',
      name: 'King James Version',
      attribution: 'Public domain.',
      cache_allowed: true
    },
    {
      id: '06125adad2d5898a-01',
      abbreviation: 'ESV',
      name: 'English Standard Version',
      attribution: 'Crossway. Used by permission. All rights reserved.',
      cache_allowed: false
    }
  ];

  function scenarioFromSearch(search) {
    var match = /[?&]scenario=([^&#]*)/.exec(search || '');
    var name = match ? decodeURIComponent(match[1]) : DEFAULT_SCENARIO;
    return Object.prototype.hasOwnProperty.call(SCENARIOS, name) ? name : DEFAULT_SCENARIO;
  }

  function fetchFixture(file) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', FIXTURE_DIR + file);
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); } catch (e) { reject(e); }
        } else {
          reject(new Error('HTTP ' + xhr.status + ' for ' + file));
        }
      };
      xhr.onerror = function () { reject(new Error('Network error for ' + file)); };
      xhr.send();
    });
  }

  function errorBody(code, message, retryable) {
    return { error: { code: code, message: message, detail: null, retryable: retryable, hint: null } };
  }

  function reply(status, json) {
    return { status: status, headers: { 'x-versesync-api': API_VERSION }, json: json };
  }

  function phaseAt(progress) {
    var cumulative = 0;
    for (var i = 0; i < PHASES.length; i++) {
      cumulative += PHASES[i][1];
      if (progress <= cumulative + 1e-9) { return PHASES[i][0]; }
    }
    return PHASES[PHASES.length - 1][0];
  }

  // opts: { scenario, fetchJson(file) -> Promise<object>, now(), setTimeout, clearTimeout }
  function create(opts) {
    opts = opts || {};
    var scenario = Object.prototype.hasOwnProperty.call(SCENARIOS, opts.scenario) ?
      opts.scenario : DEFAULT_SCENARIO;
    var fetchJson = opts.fetchJson || fetchFixture;
    var now = opts.now || function () { return new Date().getTime(); };
    var schedule = opts.setTimeout || function (fn, ms) { return setTimeout(fn, ms); };
    var unschedule = opts.clearTimeout || function (id) { clearTimeout(id); };
    var jobs = {};
    var nextJob = 1;
    var cached = null;

    function fixture() {
      if (!cached) { cached = fetchJson(SCENARIOS[scenario]); }
      return cached;
    }

    function copyOf(doc) { return JSON.parse(JSON.stringify(doc)); }

    function elapsed(job) { return now() - job.startedAt; }

    function statusOf(job) {
      if (job.cancelled) { return 'cancelled'; }
      return elapsed(job) >= JOB_MS ? 'done' : 'running';
    }

    function progressOf(job) {
      if (statusOf(job) === 'done') { return 1; }
      return Math.min(1, Math.max(0, elapsed(job) / JOB_MS));
    }

    function snapshot(job) {
      var status = statusOf(job);
      var progress = progressOf(job);
      var seconds = elapsed(job) / 1000;
      return {
        job_id: job.id,
        status: status,
        phase: phaseAt(progress),
        progress: Math.round(progress * 10000) / 10000,
        elapsed_s: Math.round(seconds * 10) / 10,
        eta_s: status === 'running' && progress > 0.01 ?
          Math.round(Math.max(0, seconds / progress - seconds) * 10) / 10 : null,
        message: status === 'done' ? 'Done' : status === 'cancelled' ? 'Cancelled' : 'Transcribing audio',
        error: null
      };
    }

    function syntheticTranscript(doc) {
      var highest = -1;
      doc.cues.forEach(function (cue) {
        [cue].concat(cue.alternatives || []).forEach(function (c) {
          var span = c.detection && c.detection.word_span;
          if (span && span[1] > highest) { highest = span[1]; }
        });
      });
      var words = [];
      // Same synthetic shape as tools/mock_sidecar.py: "word<i>" at 0.4 s per word, p = 0.95.
      for (var i = 0; i <= highest; i++) {
        words.push({
          text: 'word' + i,
          start: Math.round(i * 400) / 1000,
          end: Math.round((i + 1) * 400) / 1000,
          probability: 0.95
        });
      }
      return words;
    }

    function jobFromPath(path) {
      var m = /^\/jobs\/([^/?]+)(\/events|\/result|\/transcript)?$/.exec(path.split('?')[0]);
      if (!m) { return null; }
      var job = jobs[decodeURIComponent(m[1])];
      return job ? { job: job, suffix: m[2] || '' } : { job: null, suffix: m[2] || '' };
    }

    function notFound(path) {
      return reply(404, errorBody('bad_request', 'No such route: ' + path, false));
    }

    function route(opts) {
      var method = opts.method || 'GET';
      var path = opts.path.split('?')[0];
      if (method === 'GET' && path === '/health') {
        return Promise.resolve(reply(200, {
          status: 'ready',
          api_version: API_VERSION,
          sidecar_version: 'stub',
          device: 'cpu',
          model_loaded: MODELS[0].name,
          gpu: null,
          provider: { id: 'stub', reachable: true },
          active_jobs: 0
        }));
      }
      if (method === 'GET' && path === '/models') {
        return Promise.resolve(reply(200, { models: MODELS }));
      }
      if (method === 'GET' && path === '/translations') {
        return Promise.resolve(reply(200, { provider: 'stub', translations: TRANSLATIONS }));
      }
      if (method === 'POST' && path === '/jobs') {
        var body = typeof opts.body === 'string' ? JSON.parse(opts.body) : (opts.body || {});
        if (!body.media_path || !body.translation_id) {
          return Promise.resolve(reply(400,
            errorBody('bad_request', 'media_path and translation_id are required.', false)));
        }
        var job = { id: 'job_stub' + nextJob, startedAt: now(), cancelled: false };
        nextJob += 1;
        jobs[job.id] = job;
        return Promise.resolve(reply(202, {
          job_id: job.id, status: 'queued', cache_hit: false, estimated_duration_s: JOB_MS / 1000
        }));
      }
      if (method === 'POST' && path === '/shutdown') {
        return Promise.resolve(reply(200, { status: 'shutting_down' }));
      }
      var found = jobFromPath(path);
      if (found && (method === 'GET' || method === 'DELETE')) {
        var j = found.job;
        if (!j) {
          return Promise.resolve(reply(404, errorBody('job_not_found', 'No such job.', false)));
        }
        if (method === 'DELETE' && !found.suffix) {
          j.cancelled = true;
          return Promise.resolve(reply(200, { job_id: j.id, status: 'cancelling' }));
        }
        if (method === 'GET' && !found.suffix) { return Promise.resolve(reply(200, snapshot(j))); }
        if (method === 'GET' && found.suffix !== '/events') {
          if (statusOf(j) !== 'done') {
            return Promise.resolve(reply(409, errorBody('job_not_finished',
              'Job ' + j.id + ' is ' + statusOf(j) + ', not done.', true)));
          }
          return fixture().then(function (doc) {
            if (found.suffix === '/transcript') { return reply(200, syntheticTranscript(doc)); }
            var result = copyOf(doc);
            result.job.id = j.id;
            return reply(200, result);
          }, function () {
            return reply(500, errorBody('internal', 'The stub fixture could not be loaded.', false));
          });
        }
      }
      return Promise.resolve(notFound(path));
    }

    function request(opts) {
      try {
        return Promise.resolve(route(opts)).then(null, function () { return { status: 0, headers: {}, json: null }; });
      } catch (e) {
        return Promise.resolve({ status: 0, headers: {}, json: null });
      }
    }

    // Emits a progress event every TICK_MS, then done, then ends. onEnd is called exactly once.
    function stream(opts, onEvent, onEnd) {
      var found = jobFromPath(opts.path);
      var ended = false;
      var timer = null;
      function end(reason) {
        if (ended) { return; }
        ended = true;
        if (timer !== null) { unschedule(timer); timer = null; }
        onEnd(reason);
      }
      if (!found || !found.job || found.suffix !== '/events') {
        schedule(function () { end('http_404'); }, 0);
        return { close: function () { end('closed'); } };
      }
      var job = found.job;
      function tick() {
        timer = null;
        if (ended) { return; }
        var status = statusOf(job);
        if (status === 'cancelled') { end('end'); return; }
        var progress = progressOf(job);
        if (status === 'done') {
          fixture().then(function (doc) {
            if (ended) { return; }
            onEvent('progress', { phase: 'timing', progress: 1, eta_s: 0 });
            onEvent('done', { job_id: job.id, cue_count: doc.cues.length });
            end('end');
          }, function () { end('error'); });
          return;
        }
        onEvent('progress', { phase: phaseAt(progress), progress: Math.round(progress * 10000) / 10000,
          eta_s: snapshot(job).eta_s });
        timer = schedule(tick, TICK_MS);
      }
      timer = schedule(tick, TICK_MS);
      return { close: function () { end('closed'); } };
    }

    return { request: request, stream: stream };
  }

  var Stub = {
    SCENARIOS: SCENARIOS,
    JOB_MS: JOB_MS,
    scenarioFromSearch: scenarioFromSearch,
    create: create
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Stub;
  }
  // Always set the global too (see bridge.js): CEP's mixed-context leaks `module` into the
  // browser window, so this can't be an else-branch without breaking Premiere.
  root.VSSidecarStub = Stub;
})(this);
