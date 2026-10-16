import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine} from '../docs/engine.js';
import {DEFAULTS, DEFAULT_BASE_MODEL, TINKER_API_BASE} from '../docs/config.js';
import {FixtureProvider} from './helpers/fixture-provider.mjs';
import {cleanAudit, validateImportedRun, MAX_IMPORT_BYTES, openRunStore} from '../docs/storage.js';
import {createRuntime} from '../docs/runtime.js';

const copy = value => structuredClone(value);
const config = {...DEFAULTS, title_count: 1, depth: 2, branch_factor: 2, beam_width: 1, grace_depth: 1};
async function fixture() {
  const engine = new Engine(config, {mode: 'live', providerFactory: hook => new FixtureProvider(hook)});
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
const readySettings = {critic_ready: true, openai_key: true, continuation_ready: true, tinker_key: true, tinker_relay_ready: true};
const createTestRuntime = options => createRuntime({providerFactory: hook => new FixtureProvider(hook), getLiveSettings: () => readySettings, ...options});
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
  run.requests[0].response.OPENAI_API_KEY = 'private';
  run.requests[0].response.TINKER_API_KEY = 'private';
  run.requests[0].response['X-Tinker-Api-Key'] = 'private';
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

test('new browser starts empty; live generation, polling and exports use local history', async () => {
  const store = memoryStore();
  let factoryCalls = 0;
  const runtime = await createTestRuntime({store, locks: fakeLocks(), ...noChannels, providerFactory: hook => { factoryCalls++; return new FixtureProvider(hook); }});
  assert.deepEqual(await runtime.api('/api/runs'), []);
  const run = await runtime.api('/api/runs', {method: 'POST', body: JSON.stringify({mode: 'live', config})});
  await settle(runtime);
  const result = await runtime.api(`/api/runs/${run.id}`);
  assert.equal(result.status, 'completed');
  assert.equal(result.requests, undefined);
  assert.equal(factoryCalls, 1);
  assert.equal((await runtime.api('/api/runs')).length, 1);
  assert.match(await runtime.exportRun(run.id, 'markdown'), /## Best ideas/);
  assert.ok(JSON.parse(await runtime.exportRun(run.id, 'json')).requests.length);
  await runtime.close();
});

test('non-live runs are rejected before reading credentials, constructing providers, or saving history', async () => {
  const store = memoryStore();
  let factories = 0, settingsReads = 0;
  const runtime = await createTestRuntime({store, locks: fakeLocks(), ...noChannels,
    getLiveSettings: () => { settingsReads++; return readySettings; },
    providerFactory: hook => { factories++; return new FixtureProvider(hook); }});
  for (const mode of ['demo', 'fixture', '', null, undefined]) {
    await assert.rejects(() => runtime.api('/api/runs', {method: 'POST', body: {mode, config}}), /Only live experiments/);
  }
  assert.equal(settingsReads, 0);
  assert.equal(factories, 0);
  assert.equal(runtime.isRunning(), false);
  assert.deepEqual(await runtime.api('/api/runs'), []);
  assert.equal(store.data.size, 0);
  await runtime.close();
});

test('historical demo archives can be read, imported and exported but cannot be reviewed or mutated', async () => {
  const archived = await fixture();
  archived.mode = 'demo';
  archived.provenance.demo_fixtures = true;
  archived.final_review.status = 'interrupted';
  archived.final_review.summary = null;
  const store = memoryStore([archived]);
  let factories = 0, settingsReads = 0;
  const runtime = await createTestRuntime({store, locks: fakeLocks(), ...noChannels,
    getLiveSettings: () => { settingsReads++; return readySettings; },
    providerFactory: hook => { factories++; return new FixtureProvider(hook); }});
  assert.equal((await runtime.api('/api/runs'))[0].mode, 'demo');
  const loaded = await runtime.api(`/api/runs/${archived.id}`);
  assert.equal(loaded.mode, 'demo');
  assert.deepEqual(loaded.nodes, archived.nodes);
  assert.deepEqual(JSON.parse(await runtime.exportRun(archived.id, 'json')), archived);
  assert.match(await runtime.exportRun(archived.id, 'markdown'), /OFFLINE DEMO/);
  const imported = await runtime.importRun(archived);
  assert.equal(imported.mode, 'demo');
  assert.notEqual(imported.id, archived.id);
  assert.deepEqual(imported.nodes, archived.nodes);
  const importedBefore = copy(store.data.get(imported.id));
  for (const id of [archived.id, imported.id]) {
    await assert.rejects(() => runtime.api(`/api/runs/${id}/final-review`, {method: 'POST', body: {max_calls: 500, max_output_tokens: 500000}}), /demo experiments are read-only/);
  }
  assert.equal(settingsReads, 0);
  assert.equal(factories, 0);
  assert.equal(runtime.isRunning(), false);
  assert.deepEqual(store.data.get(archived.id), archived);
  assert.deepEqual(store.data.get(imported.id), importedBefore);
  await runtime.close();
});

test('imports get fresh IDs without modifying originals or prior runs', async () => {
  const original = await fixture();
  const store = memoryStore([original]);
  const runtime = await createTestRuntime({store, locks: fakeLocks(), ...noChannels});
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
  const runtime = await createTestRuntime({store, locks: fakeLocks(), ...noChannels});
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
  const runtime = await createTestRuntime({store, locks: fakeLocks(), ...noChannels});
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
  const runtime = await createTestRuntime({store, locks: {request: async (name, options, callback) => callback(null)}, ...noChannels});
  assert.equal((await runtime.api(`/api/runs/${original.id}`)).status, 'running');
  await assert.rejects(() => runtime.api('/api/runs', {method: 'POST', body: {mode: 'live', config}}), /already running/);
  assert.deepEqual(store.data.get(original.id), original);
  await runtime.close();
});

test('model settings are refreshed and return only safe flags; live start requires critic access', async () => {
  let settings = {critic_ready: false, critic_status: 'Add a key', api_key: 'private'};
  const runtime = await createTestRuntime({store: memoryStore(), locks: fakeLocks(), ...noChannels, getLiveSettings: () => settings});
  assert.equal((await runtime.api('/api/config')).live.api_key, undefined);
  await assert.rejects(() => runtime.api('/api/runs', {method: 'POST', body: {mode: 'live', config}}), /Add a key/);
  settings = {critic_ready: true, base_model: 'new-model', tinker_key: 'private', openai_key: true};
  const updated = await runtime.api('/api/config');
  assert.equal(updated.defaults.base_model, 'new-model');
  assert.equal(updated.live.tinker_key, false);
  assert.equal(updated.live.openai_key, true);
  assert.equal(updated.live.base_key, undefined);
  assert.equal(updated.live.openrouter_key, undefined);
  await runtime.close();
});

test('full live runs require two ready keys and an explicit continuation model before invoking a provider', async () => {
  let settings = {critic_ready: true, openai_key: true, continuation_ready: false, tinker_key: false};
  let created = 0;
  const runtime = await createTestRuntime({store: memoryStore(), locks: fakeLocks(), ...noChannels,
    getLiveSettings: () => settings, providerFactory: hook => { created++; return new FixtureProvider(hook); }});
  const start = override => runtime.api('/api/runs', {method: 'POST', body: {mode: 'live', config: {...config, ...override}}});
  await assert.rejects(() => start(), /Tinker API key/);
  settings = {critic_ready: true, openai_key: false, continuation_ready: true, tinker_key: true};
  await assert.rejects(() => start(), /OpenAI API key/);
  settings = {critic_ready: false, openai_key: true, continuation_ready: true, tinker_key: true};
  await assert.rejects(() => start(), /OpenAI API key/);
  settings = {critic_ready: true, openai_key: true, continuation_ready: false, tinker_key: true, tinker_relay_ready: false};
  await assert.rejects(() => start(), /Tinker relay URL/);
  settings = {...readySettings, tinker_relay_ready: false};
  await assert.rejects(() => start(), /Tinker relay URL/);
  settings = {...readySettings, continuation_ready: false};
  await assert.rejects(() => start(), /continuations are not ready/);
  settings = {...readySettings, base_model: DEFAULT_BASE_MODEL};
  await assert.rejects(() => start({base_model: ' '}), /model ID/);
  assert.equal(created, 0);
  const run = await start();
  await settle(runtime);
  assert.equal((await runtime.api(`/api/runs/${run.id}`)).status, 'completed');
  assert.equal(created, 1);
  await runtime.close();
});

test('relay connection settings never enter stored configs or migrate from imported runs', async () => {
  const run = await fixture();
  run.tinker_relay_url = 'https://untrusted.example';
  run.provenance.tinker_relay_url = 'https://untrusted.example';
  const clean = validateImportedRun(run);
  assert.equal(clean.tinker_relay_url, undefined);
  assert.equal(clean.provenance.tinker_relay_url, undefined);
  run.config.tinker_relay_url = 'https://untrusted.example';
  assert.throws(() => validateImportedRun(run), /Unknown configuration/);
  const runtime = await createTestRuntime({store: memoryStore(), locks: fakeLocks(), ...noChannels,
    getLiveSettings: () => ({tinker_relay_ready: true, tinker_relay_url: 'https://configured.example'})});
  const settings = await runtime.api('/api/config');
  assert.equal(settings.live.tinker_relay_ready, true);
  assert.equal(settings.live.tinker_relay_url, undefined);
  assert.equal(settings.defaults.tinker_relay_url, undefined);
  await runtime.close();
});

test('legacy history and imports retain provider provenance; reused settings create Tinker runs', async () => {
  const legacy = await fixture();
  Object.assign(legacy.config, {base_api: 'openrouter', base_url: 'https://openrouter.ai/api/v1', base_model: 'old/completion-model', base_reasoning: 'off'});
  Object.assign(legacy.provenance, {base_api: 'openrouter', base_url: legacy.config.base_url, base_model: legacy.config.base_model, critic_backend: 'openrouter', critic_model: 'old/critic'});
  assert.deepEqual(validateImportedRun(legacy), legacy);
  const store = memoryStore([legacy]);
  const runtime = await createTestRuntime({store, locks: fakeLocks(), ...noChannels});
  const loaded = await runtime.api(`/api/runs/${legacy.id}`);
  assert.deepEqual(loaded.config, legacy.config);
  assert.deepEqual(loaded.provenance, legacy.provenance);
  const imported = await runtime.importRun(legacy);
  assert.deepEqual(imported.config, legacy.config);
  assert.deepEqual(imported.provenance, legacy.provenance);
  const reused = await runtime.api('/api/runs', {method: 'POST', body: {mode: 'live', config: legacy.config}});
  await settle(runtime);
  assert.equal(reused.config.base_api, 'tinker');
  assert.equal(reused.config.base_url, TINKER_API_BASE);
  assert.equal(reused.config.base_model, DEFAULT_BASE_MODEL);
  assert.equal(reused.config.concept, legacy.config.concept);
  assert.deepEqual(store.data.get(legacy.id), legacy);
  await runtime.close();
});

test('legacy final review uses only OpenAI readiness and preserves original generation settings', async () => {
  const legacy = await fixture();
  legacy.mode = 'live';
  Object.assign(legacy.config, {base_api: 'openrouter', base_url: 'https://openrouter.ai/api/v1', base_model: 'old/model', base_reasoning: 'off'});
  Object.assign(legacy.provenance, {base_api: 'openrouter', base_url: legacy.config.base_url, base_model: 'old/model'});
  legacy.final_review = {status: 'pending', candidate_ids: [], decisions: [], summary: null};
  const settings = {critic_ready: true, openai_key: true, continuation_ready: false, tinker_key: false};
  let continuations = 0;
  const runtime = await createTestRuntime({store: memoryStore([legacy]), locks: fakeLocks(), ...noChannels, getLiveSettings: () => settings,
    providerFactory: hook => {
      const provider = new FixtureProvider(hook);
      provider.continue_post = () => { continuations++; throw new Error('must not regenerate'); };
      return provider;
    }});
  await runtime.api(`/api/runs/${legacy.id}/final-review`, {method: 'POST', body: {}});
  await settle(runtime);
  const reviewed = await runtime.api(`/api/runs/${legacy.id}`);
  assert.equal(reviewed.status, 'completed');
  assert.equal(reviewed.final_review.status, 'completed');
  assert.equal(continuations, 0);
  assert.deepEqual(reviewed.config, legacy.config);
  assert.equal(reviewed.provenance.base_api, 'openrouter');
  assert.equal(reviewed.provenance.base_model, 'old/model');
  assert.deepEqual(reviewed.nodes.map(node => node.text), legacy.nodes.map(node => node.text));
  await runtime.close();
});

test('saved live final review can resume with larger budgets and an injected provider', async () => {
  const original = await fixture();
  original.final_review.status = 'interrupted'; original.final_review.summary = null;
  const store = memoryStore([original]);
  const runtime = await createTestRuntime({store, locks: fakeLocks(), ...noChannels});
  await runtime.api(`/api/runs/${original.id}/final-review`, {method: 'POST', body: {max_calls: 300}});
  await settle(runtime);
  const result = await runtime.api(`/api/runs/${original.id}`);
  assert.equal(result.final_review.status, 'completed');
  assert.equal(result.config.max_calls, 300);
  assert.deepEqual(result.nodes, original.nodes);
  assert.ok(result.usage.calls > original.usage.calls);
  await runtime.close();
});
