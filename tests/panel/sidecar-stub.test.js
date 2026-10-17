'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const Stub = require(path.join(__dirname, '..', '..', 'panel', 'js', 'lib', 'sidecar-stub.js'));
const Sidecar = require(path.join(__dirname, '..', '..', 'panel', 'js', 'sidecar.js'));

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'cue-documents');

// A manual clock: timers fire only when the test advances time.
function fakeClock() {
  let time = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { at: time + ms, fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    advance: async (ms) => {
      const target = time + ms;
      for (;;) {
        let due = null;
        timers.forEach((t, id) => { if (t.at <= target && (!due || t.at < due.t.at)) { due = { id, t }; } });
        if (!due) { break; }
        timers.delete(due.id);
        time = due.t.at;
        due.t.fn();
        await new Promise((r) => setImmediate(r));
      }
      time = target;
    }
  };
}

function make(scenario) {
  const clock = fakeClock();
  const transport = Stub.create({
    scenario,
    fetchJson: (file) => Promise.resolve(JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8'))),
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });
  const client = Sidecar.VSSidecarClient.create({ transport, port: 0, token: 'stub' });
  return { clock, transport, client };
}

test('scenarioFromSearch picks a known scenario and defaults to happy', () => {
  assert.strictEqual(Stub.scenarioFromSearch('?stub=1&scenario=flagged'), 'flagged');
  assert.strictEqual(Stub.scenarioFromSearch('?stub=1'), 'happy');
  assert.strictEqual(Stub.scenarioFromSearch('?scenario=nope'), 'happy');
});

test('the client works against the stub transport', async () => {
  const { client } = make('happy');
  assert.strictEqual((await client.health()).data.status, 'ready');
  assert.strictEqual((await client.models()).data.models.length, 2);
  assert.strictEqual((await client.translations()).data.translations.length, 2);
});

test('a job runs for 2 s, then serves the scenario fixture', async () => {
  for (const scenario of Object.keys(Stub.SCENARIOS)) {
    const { clock, client } = make(scenario);
    const started = await client.startJob({ media_path: 'x.mxf', translation_id: 'kjv' });
    assert.ok(started.ok);
    const id = started.data.job_id;
    assert.strictEqual((await client.job(id)).data.status, 'running');
    assert.strictEqual((await client.result(id)).error.code, 'job_not_finished');
    await clock.advance(2000);
    assert.strictEqual((await client.job(id)).data.status, 'done');
    const result = await client.result(id);
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, Stub.SCENARIOS[scenario]), 'utf8'));
    assert.strictEqual(result.data.cues.length, fixture.cues.length);
    assert.strictEqual(result.data.job.id, id);
    assert.ok(Array.isArray((await client.transcript(id)).data));
  }
});

test('the event stream emits progress, then done, then ends', async () => {
  const { clock, transport, client } = make('happy');
  const id = (await client.startJob({ media_path: 'x.mxf', translation_id: 'kjv' })).data.job_id;
  const events = [];
  const ends = [];
  transport.stream(client.eventsRequest(id), (name, data) => events.push([name, data]),
    (reason) => ends.push(reason));
  await clock.advance(2000);
  const names = events.map((e) => e[0]);
  assert.ok(names.filter((n) => n === 'progress').length >= 3);
  assert.strictEqual(names[names.length - 1], 'done');
  assert.strictEqual(events[events.length - 1][1].cue_count, 18);
  assert.deepStrictEqual(ends, ['end']);
});

test('cancel stops the stream and the job reports cancelled', async () => {
  const { clock, transport, client } = make('happy');
  const id = (await client.startJob({ media_path: 'x.mxf', translation_id: 'kjv' })).data.job_id;
  const ends = [];
  transport.stream(client.eventsRequest(id), () => {}, (reason) => ends.push(reason));
  await clock.advance(600);
  await client.cancel(id);
  await clock.advance(600);
  assert.strictEqual((await client.job(id)).data.status, 'cancelled');
  assert.deepStrictEqual(ends, ['end']);
});

test('unknown jobs and routes are error envelopes, never rejections', async () => {
  const { client } = make('happy');
  assert.strictEqual((await client.job('job_nope')).error.code, 'job_not_found');
  assert.strictEqual((await client.startJob({})).error.code, 'bad_request');
});
