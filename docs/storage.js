import {validate} from './config.js';

export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const DB_NAME = 'nzt-49-browser';
const RUN_STATUSES = new Set(['running', 'completed', 'stopped', 'failed', 'budget_exhausted']);
const NODE_STATUSES = new Set(['active', 'finished', 'expanded', 'pruned', 'final_pruned', 'failed']);
const REVIEW_STATUSES = new Set(['pending', 'reviewing', 'summarizing', 'completed', 'failed', 'interrupted', 'skipped']);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const clone = value => structuredClone(value);
const fail = message => { throw new Error(`Invalid NZT-49 run: ${message}`); };
const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) fail(`${label} must be an object.`);
  return value;
};
const string = (value, label, max = 2000000, allowEmpty = true) => {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) fail(`${label} must be ${allowEmpty ? 'a' : 'a nonempty'} string of at most ${max} characters.`);
  return value;
};
const number = (value, label, max = Number.MAX_SAFE_INTEGER, min = 0, integer = true) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) fail(`${label} is out of range.`);
  return value;
};
const list = (value, label, max = 20000) => {
  if (!Array.isArray(value) || value.length > max) fail(`${label} must be a list of at most ${max} items.`);
  return value;
};
const strings = (value, label, max = 20000, itemMax = 20000) => list(value, label, max).map(item => string(item, label, itemMax));
const id = (value, label) => {
  string(value, label, 128, false);
  if (!/^[A-Za-z0-9_-]+$/.test(value)) fail(`${label} contains invalid characters.`);
  return value;
};
const choice = (value, choices, label) => {
  if (!choices.has(value)) fail(`${label} is not recognized.`);
  return value;
};
const bool = (value, label) => {
  if (typeof value !== 'boolean') fail(`${label} must be true or false.`);
  return value;
};
const date = (value, label) => {
  string(value, label, 100, false);
  if (!Number.isFinite(Date.parse(value))) fail(`${label} is not a date.`);
  return value;
};
const unique = (values, label) => {
  if (new Set(values).size !== values.length) fail(`${label} contains duplicate IDs.`);
  return values;
};
const optionalString = (source, target, key, max = 20000) => {
  if (own(source, key)) target[key] = source[key] === null ? null : string(source[key], key, max);
};
const SECRET_FIELD = /^(?:headers?|authorization|proxy-authorization|x-api-key|x-tinker-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|(?:openrouter|openai|tinker)[-_]?(?:api[-_]?)?key|base[-_]?api[-_]?key|critic[-_]?api[-_]?key|password|credentials|secret|key)$/i;
const DANGEROUS_FIELD = new Set(['__proto__', 'prototype', 'constructor']);

// Audit payloads can contain arbitrary model JSON. Keep their structure, but
// never persist credential/header fields supplied by an imported file or adapter.
export function cleanAudit(value, depth = 0, budget = {remaining: 200000}) {
  if (depth > 40 || --budget.remaining < 0) fail('audit metadata is too deeply nested or too large.');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return string(value, 'audit text');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('audit numbers must be finite.');
    return value;
  }
  if (Array.isArray(value)) return list(value, 'audit array').map(item => cleanAudit(item, depth + 1, budget));
  object(value, 'audit metadata');
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_FIELD.test(key) || DANGEROUS_FIELD.has(key)) continue;
    string(key, 'metadata key', 200);
    result[key] = cleanAudit(item, depth + 1, budget);
  }
  return result;
}

function decision(source) {
  object(source, 'final decision');
  return {id: id(source.id, 'decision ID'), keep: bool(source.keep, 'decision keep'),
    reason: string(source.reason, 'decision reason', 50000, false),
    idea: string(source.idea ?? '', 'decision idea', 50000),
    caveats: strings(source.caveats ?? [], 'decision caveats', 200, 50000)};
}

function summary(source) {
  if (source === null || source === undefined) return null;
  object(source, 'summary');
  return {overview: string(source.overview, 'summary overview', 100000),
    ideas: list(source.ideas, 'summary ideas', 200).map(item => {
      object(item, 'summary idea');
      return {title: string(item.title, 'idea title', 2000, false), summary: string(item.summary, 'idea summary', 100000),
        why_it_matters: string(item.why_it_matters, 'idea importance', 100000),
        caveats: strings(item.caveats, 'idea caveats', 200, 50000),
        source_ids: unique(strings(item.source_ids, 'idea sources', 20000, 128), 'idea sources')};
    })};
}

function evaluation(source) {
  if (source === null || source === undefined) return null;
  object(source, 'evaluation');
  const result = {};
  for (const key of ['novelty', 'usefulness', 'coherence', 'confidence']) {
    if (own(source, key)) result[key] = number(source[key], key, 1, 0, false);
  }
  for (const key of ['idea', 'reason', 'cluster']) optionalString(source, result, key, 100000);
  if (own(source, 'flags')) result.flags = strings(source.flags, 'evaluation flags', 200, 20000);
  return result;
}

export function validateImportedRun(input) {
  let source = input;
  if (typeof input === 'string') {
    if (new TextEncoder().encode(input).byteLength > MAX_IMPORT_BYTES) fail('file exceeds 20 MB.');
    try { source = JSON.parse(input); } catch (_) { fail('file is not valid JSON.'); }
  } else {
    let serialized;
    try { serialized = JSON.stringify(input); } catch (_) { fail('file must contain ordinary JSON data.'); }
    if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > MAX_IMPORT_BYTES) fail('file exceeds 20 MB.');
  }
  object(source, 'run');
  const config = validate(source.config);
  const result = {
    id: id(source.id, 'run ID'), mode: choice(source.mode, new Set(['live', 'demo']), 'mode'),
    status: choice(source.status, RUN_STATUSES, 'status'), created_at: date(source.created_at, 'creation date'),
    config, progress: string(source.progress ?? '', 'progress', 50000),
    error: source.error == null ? null : string(source.error, 'error', 50000),
    generation_completed: source.generation_completed === undefined ? source.status === 'completed' : bool(source.generation_completed, 'generation completion'),
    titles: [], nodes: [], outputs: [], usage: {}, events: [], requests: [], provenance: {},
  };
  result.titles = list(source.titles, 'titles', 200).map(item => {
    object(item, 'title');
    return {id: id(item.id, 'title ID'), title: string(item.title, 'title', 2000, false),
      author: string(item.author, 'author', 120, false), venue: string(item.venue, 'venue', 2000),
      lens: string(item.lens, 'lens', 20000)};
  });
  const titleIds = new Set(unique(result.titles.map(item => item.id), 'titles'));
  result.nodes = list(source.nodes, 'nodes', 20000).map(item => {
    object(item, 'node');
    const node = {id: id(item.id, 'node ID'), title_id: id(item.title_id, 'node title'),
      parent_id: item.parent_id === null ? null : id(item.parent_id, 'parent ID'),
      depth: number(item.depth, 'depth', 12, 1), text: string(item.text, 'node text'),
      status: choice(item.status, NODE_STATUSES, 'node status'), evaluation: evaluation(item.evaluation)};
    if (!titleIds.has(node.title_id)) fail('a node refers to an unknown title.');
    for (const key of ['finish_reason', 'selection_reason', 'adapter', 'response_shape', 'experimental_mode']) optionalString(item, node, key, 100000);
    if (own(item, 'temperature')) node.temperature = number(item.temperature, 'temperature', 2, 0, false);
    if (own(item, 'seed')) node.seed = number(item.seed, 'seed', 2147483647);
    if (own(item, 'request_index')) node.request_index = number(item.request_index, 'request index', 10000);
    if (item.final_review != null) node.final_review = decision(item.final_review);
    return node;
  });
  unique(result.nodes.map(item => item.id), 'nodes');
  const nodes = new Map(result.nodes.map(item => [item.id, item]));
  const parentIds = new Set();
  for (const node of result.nodes) {
    if (node.parent_id !== null) {
      const parent = nodes.get(node.parent_id);
      if (!parent || parent.title_id !== node.title_id || parent.depth !== node.depth - 1) fail('a parent link is missing, cyclic, or crosses titles/depths.');
      parentIds.add(parent.id);
    } else if (node.depth !== 1) fail('a root node must have depth 1.');
    if (node.final_review && node.final_review.id !== node.id) fail('a node decision has a different ID.');
  }
  result.outputs = unique(strings(source.outputs, 'outputs', 20000, 128), 'outputs');
  for (const output of result.outputs) {
    const node = nodes.get(output);
    if (!node || parentIds.has(output) || !['active', 'finished'].includes(node.status)) fail('an output is not a surviving leaf.');
  }
  const usage = object(source.usage ?? {}, 'usage');
  for (const key of ['calls', 'input_tokens', 'output_tokens', 'reserved_output_tokens']) result.usage[key] = number(usage[key] ?? 0, key);
  result.events = list(source.events ?? [], 'events', 30000).map(event => {
    object(event, 'event');
    const clean = {time: date(event.time, 'event date'), message: string(event.message, 'event message', 100000)};
    for (const key of ['previous', 'updated']) if (own(event, key)) {
      const limits = object(event[key], 'budget changes');
      clean[key] = {};
      for (const limit of ['max_calls', 'max_output_tokens']) if (own(limits, limit)) clean[key][limit] = number(limits[limit], limit);
    }
    return clean;
  });
  result.requests = list(source.requests ?? [], 'requests', 10000).map(record => {
    object(record, 'request record');
    const item = {index: number(record.index, 'request index', 10000, 1), role: choice(record.role, new Set(['base', 'critic']), 'request role'),
      time: date(record.time, 'request date'), status: choice(record.status, new Set(['pending', 'failed', 'completed']), 'request status'),
      request: cleanAudit(object(record.request, 'request payload'))};
    if (own(record, 'response')) item.response = cleanAudit(record.response);
    return item;
  });
  const provenance = object(source.provenance ?? {}, 'provenance');
  for (const key of ['synthetic', 'author_labels_are_prompt_cues', 'judge_scores_are_not_fact_checks', 'demo_fixtures']) {
    if (own(provenance, key)) result.provenance[key] = bool(provenance[key], key);
  }
  for (const key of ['algorithm', 'base_api', 'base_model', 'critic_model', 'critic_backend', 'output_limit_mode', 'final_critic_model', 'final_critic_backend', 'final_review']) optionalString(provenance, result.provenance, key, 100000);
  if (own(provenance, 'base_url')) result.provenance.base_url = validate({...config, base_url: provenance.base_url}).base_url;
  if (source.final_review != null) {
    const review = object(source.final_review, 'final review');
    result.final_review = {status: choice(review.status, REVIEW_STATUSES, 'review status'),
      candidate_ids: unique(strings(review.candidate_ids ?? [], 'review candidates', 20000, 128), 'review candidates'),
      decisions: list(review.decisions ?? [], 'review decisions', 20000).map(decision), summary: summary(review.summary)};
    for (const key of ['started_at', 'completed_at']) if (own(review, key)) result.final_review[key] = date(review[key], key);
    optionalString(review, result.final_review, 'error', 100000);
    unique(result.final_review.decisions.map(item => item.id), 'review decisions');
    for (const reference of [...result.final_review.candidate_ids, ...result.final_review.decisions.map(item => item.id)]) if (!nodes.has(reference)) fail('final review refers to an unknown node.');
    const candidates = new Set(result.final_review.candidate_ids);
    for (const item of result.final_review.decisions) if (!candidates.has(item.id)) fail('a final decision is not among the review candidates.');
    for (const reference of candidates) if (parentIds.has(reference)) fail('a final-review candidate is not a complete leaf path.');
    if (result.final_review.status === 'completed') {
      if (!result.final_review.summary) fail('completed final review is missing its summary.');
      if (result.final_review.decisions.length !== candidates.size) fail('completed final review is missing decisions.');
      const retained = new Set(result.final_review.decisions.filter(item => item.keep).map(item => item.id));
      for (const idea of result.final_review.summary.ideas) for (const reference of idea.source_ids) if (!retained.has(reference)) fail('a final summary cites a rejected or unreviewed draft.');
    }
    if (own(review, 'summary_passes')) result.final_review.summary_passes = list(review.summary_passes, 'summary passes', 10000).map(pass => {
      object(pass, 'summary pass');
      const hash = string(pass.input_hash, 'summary input hash', 100, false);
      if (!/^[a-f0-9]{64}$/.test(hash)) fail('summary input hash must be SHA-256.');
      return {level: number(pass.level, 'summary level', 8), input_hash: hash, result: summary(pass.result)};
    });
    const summaries = [result.final_review.summary, ...(result.final_review.summary_passes ?? []).map(pass => pass.result)];
    for (const value of summaries) for (const idea of value?.ideas ?? []) for (const reference of idea.source_ids) if (!nodes.has(reference)) fail('a summary refers to an unknown node.');
  }
  return result;
}

export function newRunId() {
  return [...crypto.getRandomValues(new Uint8Array(8))].map(value => value.toString(16).padStart(2, '0')).join('');
}

export async function openRunStore({indexedDB: database = globalThis.indexedDB, name = DB_NAME} = {}) {
  if (!database) throw new Error('This browser cannot save experiments. Enable browser storage or use a regular browser window.');
  const db = await new Promise((resolve, reject) => {
    const request = database.open(name, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('runs')) request.result.createObjectStore('runs', {keyPath: 'id'});
      if (!request.result.objectStoreNames.contains('leases')) request.result.createObjectStore('leases', {keyPath: 'id'});
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Browser storage could not be opened. Check storage permissions.'));
    request.onblocked = () => reject(new Error('Close other NZT-49 tabs to finish opening browser storage.'));
  });
  db.onversionchange = () => db.close();
  const transaction = (store, mode, action) => new Promise((resolve, reject) => {
    let value;
    const tx = db.transaction(store, mode);
    tx.oncomplete = () => resolve(value);
    tx.onerror = tx.onabort = () => reject(new Error('Browser storage could not save this experiment. Export your work and check available storage.'));
    action(tx.objectStore(store), result => { value = result; });
  });
  return {
    get: id => transaction('runs', 'readonly', (store, done) => { const request = store.get(id); request.onsuccess = () => done(request.result ?? null); }),
    list: () => transaction('runs', 'readonly', (store, done) => { const request = store.getAll(); request.onsuccess = () => done(request.result); }),
    save: run => transaction('runs', 'readwrite', (store, done) => { store.put(cleanAudit(run)); done(run.id); }),
    remove: id => transaction('runs', 'readwrite', (store, done) => { store.delete(id); done(true); }),
    claimLease: (owner, ttl = 120000) => transaction('leases', 'readwrite', (store, done) => {
      const request = store.get('generation');
      request.onsuccess = () => {
        const lease = request.result;
        if (lease && lease.owner !== owner && lease.expires > Date.now()) { done(false); return; }
        store.put({id: 'generation', owner, expires: Date.now() + ttl}); done(true);
      };
    }),
    releaseLease: owner => transaction('leases', 'readwrite', (store, done) => {
      const request = store.get('generation');
      request.onsuccess = () => { if (request.result?.owner === owner) store.delete('generation'); done(true); };
    }),
    close: () => db.close(),
  };
}
