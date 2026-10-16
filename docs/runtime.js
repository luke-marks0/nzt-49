import {DEFAULTS, validate, estimate, migrateGenerationConfig} from './config.js';
import {Engine, exportMarkdown} from './engine.js';
import {openRunStore, validateImportedRun, newRunId} from './storage.js';

const clone = value => structuredClone(value);
const now = () => new Date().toISOString();
const busyMessage = 'An experiment is already running in this browser. Stop it or wait before starting another.';
const lockName = 'nzt-49-generation';

function interrupted(run, message) {
  run.status = 'stopped';
  run.progress = message;
  if (['reviewing', 'summarizing'].includes(run.final_review?.status) || (run.generation_completed && run.final_review?.status === 'pending')) {
    run.final_review.status = 'interrupted';
    run.final_review.error = message;
  }
  run.events ??= [];
  run.events.push({time: now(), message});
  return run;
}

function safeLiveSettings(source = {}) {
  const result = {};
  for (const key of ['critic_ready', 'continuation_ready', 'tinker_relay_ready', 'tinker_key', 'openai_key']) result[key] = source[key] === true;
  for (const key of ['critic_model', 'critic_backend', 'critic_status', 'continuation_status', 'base_model', 'base_url', 'base_api', 'base_reasoning']) {
    if (typeof source[key] === 'string') result[key] = source[key].slice(0, 2000);
  }
  return result;
}

export async function createRuntime({providerFactory, getLiveSettings = () => ({}), store: injectedStore,
  locks = globalThis.navigator?.locks, channelFactory = globalThis.BroadcastChannel ? name => new BroadcastChannel(name) : null} = {}) {
  const store = injectedStore ?? await openRunStore();
  const owner = newRunId();
  let active = null;
  let starting = false;
  let closed = false;
  let releaseExecution = null;
  const unsaved = new Map();
  const channel = channelFactory?.('nzt-49-runtime') ?? null;
  if (channel) channel.onmessage = event => {
    if (event.data?.type === 'stop' && event.data.id === active?.engine.state.id) active.engine.stop();
  };

  async function acquireExecution() {
    if (locks?.request) {
      return await new Promise((resolve, reject) => {
        let release;
        const held = new Promise(done => { release = done; });
        locks.request(lockName, {ifAvailable: true}, async lock => {
          if (!lock) { resolve(null); return; }
          resolve(async () => release());
          await held;
        }).catch(reject);
      });
    }
    if (!await store.claimLease(owner)) return null;
    let released = false;
    const timer = setInterval(() => {
      store.claimLease(owner).then(claimed => { if (!claimed) active?.engine.stop(); }).catch(() => active?.engine.stop());
    }, 30000);
    return async () => {
      if (released) return;
      released = true; clearInterval(timer); await store.releaseLease(owner);
    };
  }

  async function recoverOrphans() {
    for (const run of await store.list()) {
      if (run.status === 'running' && run.id !== active?.engine.state.id) {
        await store.save(interrupted(run, 'The browser run ended before completion. The last saved checkpoint is preserved.'));
      }
    }
  }

  // Only the holder of the cross-tab execution lock may recover checkpoints.
  const startupRelease = await acquireExecution();
  if (startupRelease) {
    try { await recoverOrphans(); } finally { await startupRelease(); }
  }

  async function liveSettings() { return safeLiveSettings(await getLiveSettings()); }

  async function getRun(id, {includeRequests = false} = {}) {
    let run = active?.engine.state.id === id ? active.engine.snapshot() : unsaved.get(id) ?? await store.get(id);
    if (!run) throw new Error('Unknown experiment. It may belong to another browser or have been removed.');
    run = clone(run);
    if (!includeRequests) delete run.requests;
    return run;
  }

  async function listRuns() {
    const runs = await store.list();
    for (const run of unsaved.values()) {
      const index = runs.findIndex(item => item.id === run.id);
      if (index >= 0) runs[index] = run; else runs.push(run);
    }
    if (active) {
      const index = runs.findIndex(run => run.id === active.engine.state.id);
      if (index >= 0) runs[index] = active.engine.snapshot(); else runs.push(active.engine.snapshot());
    }
    return runs.sort((a, b) => b.created_at.localeCompare(a.created_at)).map(run => ({
      id: run.id, status: run.status, mode: run.mode, created_at: run.created_at, concept: run.config.concept,
    }));
  }

  async function launch(makeEngine, reviewOnly = false) {
    if (closed) throw new Error('This app session is closed. Reload the page to continue.');
    if (starting || active) throw new Error(busyMessage);
    starting = true;
    let release;
    try {
      release = await acquireExecution();
      if (!release) throw new Error(busyMessage);
      releaseExecution = release;
      await recoverOrphans();
      const engine = await makeEngine(run => store.save(run));
      const current = {engine, done: null};
      active = current;
      await engine.ready;
      const initial = engine.snapshot();
      current.done = Promise.resolve().then(() => engine.run({reviewOnly})).catch(async error => {
        engine.state.status = 'failed';
        engine.state.error = 'The experiment stopped because browser storage could not save a checkpoint. Export available results before reloading.';
        engine.state.progress = engine.state.error;
        unsaved.set(engine.state.id, engine.snapshot());
        try { await store.save(engine.snapshot()); unsaved.delete(engine.state.id); } catch (_) { /* The in-memory snapshot remains exportable. */ }
      }).finally(async () => {
        if (active === current) active = null;
        await release();
        if (releaseExecution === release) releaseExecution = null;
      });
      return initial;
    } catch (error) {
      if (release) await release();
      if (releaseExecution === release) releaseExecution = null;
      active = null;
      throw error;
    } finally { starting = false; }
  }

  function payload(options) {
    if (options.body === undefined || options.body === '') return {};
    if (typeof options.body === 'string') {
      try { return JSON.parse(options.body); } catch (_) { throw new Error('Request body must contain valid JSON.'); }
    }
    return options.body;
  }

  async function api(path, options = {}) {
    const method = (options.method ?? 'GET').toUpperCase();
    const route = path.split('?')[0];
    if (route === '/api/config' && method === 'GET') {
      const live = await liveSettings();
      const defaults = clone(DEFAULTS);
      for (const key of ['base_model', 'base_url', 'base_api', 'base_reasoning']) if (live[key]) defaults[key] = live[key];
      return {defaults: migrateGenerationConfig(defaults), live};
    }
    if (route === '/api/estimate' && method === 'POST') return estimate(migrateGenerationConfig(payload(options)));
    if (route === '/api/runs' && method === 'GET') return listRuns();
    if (route === '/api/runs' && method === 'POST') {
      const body = payload(options);
      if (!body || typeof body !== 'object' || Array.isArray(body) || body.mode !== 'live') throw new Error('Only live experiments can be started.');
      const config = migrateGenerationConfig(body.config);
      const live = await liveSettings();
      if (!live.openai_key || !live.critic_ready) throw new Error(live.critic_status || 'Add your OpenAI API key for Astra in Models before starting.');
      if (!live.tinker_key) throw new Error(live.continuation_status || 'Add your Tinker API key for continuations in Models before starting.');
      if (!live.tinker_relay_ready) throw new Error(live.continuation_status || 'Configure the Tinker relay URL in Models before starting.');
      if (!live.continuation_ready) throw new Error(live.continuation_status || 'Tinker continuations are not ready. Check Models before starting.');
      config.base_model = config.base_model.trim();
      if (!config.base_model) throw new Error('Enter a continuation model ID before starting a live run.');
      if (!providerFactory) throw new Error('The live model provider is unavailable. Reload the page.');
      return launch(onSave => new Engine(config, {mode: 'live', providerFactory, onSave}));
    }
    const match = /^\/api\/runs\/([A-Za-z0-9_-]{1,128})(?:\/(stop|final-review|export))?$/.exec(route);
    if (!match) throw new Error('Unknown app operation.');
    const [, id, action] = match;
    if (!action && method === 'GET') return getRun(id);
    if (action === 'stop' && method === 'POST') {
      const run = await getRun(id);
      if (active?.engine.state.id === id) active.engine.stop();
      else if (run.status === 'running' && channel) channel.postMessage({type: 'stop', id});
      else if (run.status === 'running') throw new Error('Stop this experiment in the tab where it is running.');
      return run;
    }
    if (action === 'final-review' && method === 'POST') {
      const limits = payload(options);
      if (!limits || typeof limits !== 'object' || Array.isArray(limits) || Object.keys(limits).some(key => !['max_calls', 'max_output_tokens'].includes(key))) throw new Error('Final review accepts only total call and output-token budgets.');
      const run = await getRun(id, {includeRequests: true});
      if (run.mode !== 'live') throw new Error('Archived demo experiments are read-only. Start a new live experiment to generate and review ideas.');
      const previous = {max_calls: run.config.max_calls, max_output_tokens: run.config.max_output_tokens};
      run.config = validate({...run.config, ...limits});
      const updated = {max_calls: run.config.max_calls, max_output_tokens: run.config.max_output_tokens};
      if (JSON.stringify(previous) !== JSON.stringify(updated)) run.events.push({time: now(), message: 'Final-review total budgets updated', previous, updated});
      const live = await liveSettings();
      if (!live.openai_key || !live.critic_ready) throw new Error(live.critic_status || 'Add your OpenAI API key for Astra in Models before reviewing.');
      if (!providerFactory) throw new Error('The live model provider is unavailable. Reload the page.');
      return launch(onSave => Engine.forFinalReview(run, {providerFactory, onSave}), true);
    }
    if (action === 'export' && method === 'GET') return exportRun(id, new URLSearchParams(path.split('?')[1] ?? '').get('format') ?? 'json');
    throw new Error('Unknown app operation.');
  }

  async function exportRun(id, format = 'json') {
    const run = await getRun(id, {includeRequests: true});
    if (format === 'markdown') return exportMarkdown(run);
    if (format !== 'json') throw new Error('Choose JSON or Markdown export.');
    return JSON.stringify(run, null, 2);
  }

  async function importRun(data) {
    const run = validateImportedRun(data);
    run.id = newRunId();
    if (run.status === 'running') interrupted(run, 'Imported a saved checkpoint. Generation is stopped; existing text is preserved.');
    run.events.push({time: now(), message: 'Imported into this browser as a new experiment.'});
    await store.save(run);
    const result = clone(run); delete result.requests; return result;
  }

  return {
    api, exportRun, importRun, isRunning: () => Boolean(active || starting),
    async close() {
      closed = true;
      active?.engine.stop();
      if (active?.done) await active.done;
      if (releaseExecution) await releaseExecution();
      channel?.close();
      store.close?.();
    },
  };
}
