import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../docs/engine.js';
import {DEFAULTS} from '../docs/config.js';
import {cleanAudit, validateImportedRun, MAX_IMPORT_BYTES, openRunStore} from '../docs/storage.js';
import {createRuntime} from '../docs/runtime.js';

const copy = value => structuredClone(value);
const config = {...DEFAULTS, title_count: 1, depth: 2, branch_factor: 2, beam_width: 1, grace_depth: 1};
async function fixture() {
  const engine = new Engine(config, {mode: 'demo'});
  await engine.run();
  assert.equal(engine.state.status, 'completed');
  return engine.snapshot();
}
function memoryStore(initial = []) {
  const data = new Map(initial.map(run => [run.id, copy(run)]));
  let lease = null;
  return {data, get: async id => copy(data.get(id) ?? null), list: async () => copy([...data.values()]),
    save: async run => { data.set(run.id, copy(cleanAudit(run))); }, close() {},
    claimLease: async owner => { if (lease && lease !== owner) return false; lease = owner; return true; },
    releaseLease: async owner => { if (lease === owner) lease = null; }};
}
function fakeLocks() {
  let held = false;
  return {request: async (name, options, callback) => {
    if (held) return callback(null);
    held = true;
    try { return await callback({name}); } finally { held = false; }
  }};
}
const noChannels = {channelFactory: null};
async function settle(runtime) {
  for (let i = 0; i < 500 && runtime.isRunning(); i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(runtime.isRunning(), false, 'run completed');
}

test('valid complete run round-trips, including full ancestry and final-review metadata', async () => {
  const run = await fixture();
  assert.deepEqual(validateImportedRun(JSON.stringify(run)), run);
});

test('import rejects malformed links, cycles, duplicate IDs, unknown summary sources and output resurrection', async () => {
  const run = await fixture();
  for (const mutate of [
    value => { value.nodes[0].parent_id = value.nodes[0].id; },
    value => { value.nodes[0].title_id = 'missing'; },
    value => { value.nodes[1].id = value.nodes[0].id; },
    value => { value.final_review.summary.ideas[0].source_ids = ['missing']; },
    value => { value.final_review.summary = null; },
    value => { value.final_review.candidate_ids = []; },
    value => { value.outputs = [value.nodes.find(node => node.status === 'pruned').id]; },
  ]) {
    const malformed = copy(run); mutate(malformed);
    assert.throws(() => validateImportedRun(malformed), /Invalid NZT-49 run/);
  }
  run.outputs = [];
  assert.deepEqual(validateImportedRun(run).outputs, []);
});

test('import strips unknown metadata and credential/header fields, rejects secret config fields', async () => {
  const run = await fixture();
  run.secret = 'root-secret';
  run.nodes[0].dangerous = 'unknown';
  run.requests[0].request.headers = {Authorization: 'bearer private'};
  run.requests[0].request.api_key = 'private';
  run.requests[0].response.credentials = {token: 'private'};
  run.requests[0].response.nested = {openrouter_api_key: 'private', keep: 'safe'};
  const clean = validateImportedRun(run);
  assert.equal(clean.secret, undefined);
  assert.equal(clean.nodes[0].dangerous, undefined);
  assert.equal(JSON.stringify(clean).includes('private'), false);
  assert.deepEqual(clean.requests[0].response.nested, {keep: 'safe'});
  run.config.api_key = 'private';
  assert.throws(() => validateImportedRun(run), /Unknown configuration/);
});

test('import rejects invalid types, nonfinite numbers and oversized files', async () => {
  const run = await fixture();
  run.nodes[0].temperature = Infinity;
  assert.throws(() => validateImportedRun(run), /temperature/);
  assert.throws(() => validateImportedRun(' '.repeat(MAX_IMPORT_BYTES + 1)), /20 MB/);
  assert.throws(() => validateImportedRun('{'), /valid JSON/);
  assert.throws(() => cleanAudit({a: NaN}), /finite/);
  assert.deepEqual(cleanAudit(JSON.parse('{"__proto__":{"polluted":true},"safe":1}')), {safe: 1});
});

test('browser storage requires IndexedDB instead of silently losing history', async () => {
  await assert.rejects(() => openRunStore({indexedDB: null}), /cannot save experiments/);
});

test('new browser starts empty; demo generation, polling and exports use local history', async () => {
  const store = memoryStore();
  let factoryCalls = 0;
  const runtime = await createRuntime({store, locks: fakeLocks(), ...noChannels, providerFactory: () => { factoryCalls++; throw new Error('demo must not call live provider'); }});
  assert.deepEqual(await runtime.api('/api/runs'), []);
  const run = await runtime.api('/api/runs', {method: 'POST', body: JSON.stringify({mode: 'demo', config})});
  await settle(runtime);
  const result = await runtime.api(`/api/runs/${run.id}`);
  assert.equal(result.status, 'completed');
  assert.equal(result.requests, undefined);
  assert.equal(factoryCalls, 0);
  assert.equal((await runtime.api('/api/runs')).length, 1);
  assert.match(await runtime.exportRun(run.id, 'markdown'), /## Best ideas/);
  assert.ok(JSON.parse(await runtime.exportRun(run.id, 'json')).requests.length);
  await runtime.close();
});

test('imports get fresh IDs without modifying originals or prior runs', async () => {
  const original = await fixture();
  const store = memoryStore([original]);
  const runtime = await createRuntime({store, locks: fakeLocks(), ...noChannels});
  const imported = await runtime.importRun(original);
  assert.notEqual(imported.id, original.id);
  assert.equal((await runtime.api('/api/runs')).length, 2);
  assert.deepEqual(store.data.get(original.id), original);
  assert.equal(imported.requests, undefined);
  await runtime.close();
});

test('reload recovers interrupted runs while preserving text and completed reviews', async () => {
  const original = await fixture();
  original.status = 'running'; original.final_review.status = 'summarizing';
  const store = memoryStore([original]);
  const runtime = await createRuntime({store, locks: fakeLocks(), ...noChannels});
  const recovered = await runtime.api(`/api/runs/${original.id}`);
  assert.equal(recovered.status, 'stopped');
  assert.equal(recovered.final_review.status, 'interrupted');
  assert.deepEqual(recovered.nodes, original.nodes);
  await runtime.close();
});

test('reload makes final review retryable if generation finished before review started', async () => {
  const original = await fixture();
  original.status = 'running';
  original.generation_completed = true;
  original.final_review.status = 'pending';
  original.final_review.summary = null;
  const store = memoryStore([original]);
  const runtime = await createRuntime({store, locks: fakeLocks(), ...noChannels});
  const recovered = await runtime.api(`/api/runs/${original.id}`);
  assert.equal(recovered.status, 'stopped');
  assert.equal(recovered.final_review.status, 'interrupted');
  assert.deepEqual(recovered.nodes, original.nodes);
  await runtime.api(`/api/runs/${original.id}/final-review`, {method: 'POST', body: {max_calls: 300}});
  await settle(runtime);
  assert.equal((await runtime.api(`/api/runs/${original.id}`)).final_review.status, 'completed');
  await runtime.close();
});

test('second tab cannot recover or overwrite a run held by another tab', async () => {
  const original = await fixture(); original.status = 'running';
  const store = memoryStore([original]);
  const runtime = await createRuntime({store, locks: {request: async (name, options, callback) => callback(null)}, ...noChannels});
  assert.equal((await runtime.api(`/api/runs/${original.id}`)).status, 'running');
  await assert.rejects(() => runtime.api('/api/runs', {method: 'POST', body: {mode: 'demo', config}}), /already running/);
  assert.deepEqual(store.data.get(original.id), original);
  await runtime.close();
});

test('model settings are refreshed and return only safe flags; live start requires critic access', async () => {
  let settings = {critic_ready: false, critic_status: 'Add a key', api_key: 'private'};
  const runtime = await createRuntime({store: memoryStore(), locks: fakeLocks(), ...noChannels, getLiveSettings: () => settings});
  assert.equal((await runtime.api('/api/config')).live.api_key, undefined);
  await assert.rejects(() => runtime.api('/api/runs', {method: 'POST', body: {mode: 'live', config}}), /Add a key/);
  settings = {critic_ready: true, base_model: 'new-model', base_key: 'private', openrouter_key: true};
  const updated = await runtime.api('/api/config');
  assert.equal(updated.defaults.base_model, 'new-model');
  assert.equal(updated.live.base_key, false);
  assert.equal(updated.live.openrouter_key, true);
  await runtime.close();
});

test('saved demo final review can resume with larger budgets and no live provider', async () => {
  const original = await fixture();
  original.final_review.status = 'interrupted'; original.final_review.summary = null;
  const store = memoryStore([original]);
  const runtime = await createRuntime({store, locks: fakeLocks(), ...noChannels, providerFactory: () => { throw new Error('not live'); }});
  await runtime.api(`/api/runs/${original.id}/final-review`, {method: 'POST', body: {max_calls: 300}});
  await settle(runtime);
  const result = await runtime.api(`/api/runs/${original.id}`);
  assert.equal(result.final_review.status, 'completed');
  assert.equal(result.config.max_calls, 300);
  assert.deepEqual(result.nodes, original.nodes);
  assert.ok(result.usage.calls > original.usage.calls);
  await runtime.close();
});
