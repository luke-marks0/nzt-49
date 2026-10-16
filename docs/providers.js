import { PROMPTS, SCHEMAS } from './prompts.js';
import { TINKER_API_BASE } from './config.js';

export const DEFAULT_CRITIC_MODEL = 'gpt-6-astra';
const OPENAI_API = 'https://api.openai.com/v1/responses';
const MAX_RESPONSE = 8 * 1024 * 1024;
export class ProviderError extends Error { constructor(message) { super(message); this.name = 'ProviderError'; } }
const fail = message => { throw new ProviderError(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
export function isSecurePageContext(page = globalThis.location) {
  return !page || page.protocol === 'https:' || (page.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(page.hostname));
}
const strings = (value, required = false, unique = false) => Array.isArray(value) && (!required || value.length > 0) && value.every(nonempty) && (!unique || new Set(value).size === value.length);
function exact(value, keys) {
  if (!object(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('Astra returned an unexpected structured result.');
}
function reorder(items, ids) {
  if (!Array.isArray(items) || items.length !== ids.length || new Set(items.map(x => x?.id)).size !== ids.length || items.some(x => !ids.includes(x?.id))) fail('Astra returned missing, duplicate, or unknown draft IDs.');
  const mapped = new Map(items.map(item => [item.id, item]));
  return ids.map(id => mapped.get(id));
}
function redactCredentials(value, secrets, depth = 0) {
  if (depth > 40) fail('The provider response was too deeply nested.');
  if (typeof value === 'string') {
    for (const secret of secrets) if (secret) value = value.split(secret).join('[credential redacted]');
    return value;
  }
  if (Array.isArray(value)) return value.map(item => redactCredentials(item, secrets, depth + 1));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactCredentials(key, secrets, depth + 1), redactCredentials(item, secrets, depth + 1)]));
  return value;
}
export function continuationEndpoint(config) {
  let url;
  try { url = new URL(config.base_url); } catch { fail('Choose the Tinker completion endpoint.'); }
  if (config.base_api !== 'tinker' || url.username || url.password || url.search || url.hash || url.href.replace(/\/+$/, '') !== TINKER_API_BASE) fail('New continuations use only the Tinker raw-completion endpoint.');
  return TINKER_API_BASE + '/completions';
}
export function relayEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { fail('Enter the trusted Tinker relay URL.'); }
  if (!isSecurePageContext(url) || url.username || url.password || url.search || url.hash || !['', '/', '/completions', '/completions/'].includes(url.pathname)) fail('Use an HTTPS relay URL without credentials, query, or fragment. Local development may use loopback HTTP.');
  return url.origin + '/completions';
}

export class LiveProvider {
  #tinkerKey;
  #openaiKey;
  #relayUrl;
  constructor(requestHook, { tinkerKey = '', openaiKey = '', tinkerRelayUrl = '', criticModel = DEFAULT_CRITIC_MODEL, fetchImpl = globalThis.fetch } = {}) {
    if (!isSecurePageContext()) fail('Open NZT-49 over HTTPS before using an API key.');
    for (const [key, name] of [[tinkerKey, 'Tinker'], [openaiKey, 'OpenAI']]) if (typeof key !== 'string' || (key && !/^[\x21-\x7e]{1,1024}$/.test(key))) fail(`Enter a valid ${name} key for this tab.`);
    if (criticModel !== DEFAULT_CRITIC_MODEL) fail('This experiment uses the explicitly selected Astra model.');
    this.#tinkerKey = tinkerKey;
    this.#openaiKey = openaiKey;
    this.#relayUrl = tinkerRelayUrl;
    this.request = requestHook;
    this.criticModel = criticModel;
    this.criticBackend = 'openai';
    this.fetchImpl = fetchImpl;
  }
  preflightCritic() {
    if (!this.#openaiKey) fail('Enter an OpenAI API key for Astra.');
  }
  preflight(config) {
    continuationEndpoint(config);
    if (!nonempty(config.base_model)) fail('Choose an explicit continuation model ID.');
    if (!this.#tinkerKey) fail('Enter a Tinker API key for continuations.');
    relayEndpoint(this.#relayUrl);
    this.preflightCritic();
  }
  async http(service, payload) {
    if (!isSecurePageContext()) fail('Open NZT-49 over HTTPS before using an API key.');
    if (!['openai', 'tinker'].includes(service)) fail('Unknown model service.');
    const name = service === 'openai' ? 'OpenAI' : 'Tinker';
    const key = service === 'openai' ? this.#openaiKey : this.#tinkerKey;
    if (!key) fail(`Enter a ${name} API key for this tab.`);
    const url = service === 'openai' ? OPENAI_API : relayEndpoint(this.#relayUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000);
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify(payload), signal: controller.signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer',
      });
      if (!response.ok) fail(`${name}${service === 'tinker' ? ' or its relay' : ''} returned HTTP ${response.status}. Check the model, key, credits, and rate limits.`);
      let raw;
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const chunks = []; let size = 0;
        while (true) {
          const {done, value} = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_RESPONSE) { await reader.cancel(); fail('The provider response exceeded the size limit.'); }
          chunks.push(value);
        }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        raw = new TextDecoder().decode(bytes);
      } else raw = await response.text();
      if (raw.length > MAX_RESPONSE) fail('The provider response exceeded the size limit.');
      // An upstream diagnostic must not copy a credential into browser history.
      for (const secret of [this.#tinkerKey, this.#openaiKey]) if (secret) raw = raw.split(secret).join('[credential redacted]');
      let result;
      try { result = JSON.parse(raw); } catch { fail(`${name} returned invalid JSON.`); }
      result = redactCredentials(result, [this.#tinkerKey, this.#openaiKey]);
      if (!object(result) || result.error) fail(`${name} could not complete the request. Check model access, credits, and limits.`);
      const usage = result.usage;
      if (usage != null && (!object(usage) || ['prompt_tokens','completion_tokens','input_tokens','output_tokens'].some(k => usage[k] != null && (!Number.isSafeInteger(usage[k]) || usage[k] < 0)))) fail(`${name} returned invalid token usage.`);
      return result;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      fail(`${name} request failed or timed out. Check your connection${service === 'tinker' ? ' and the relay URL' : ' and API access'}. Saved drafts are preserved.`);
    } finally { clearTimeout(timeout); }
  }
  async critic(kind, data, cap) {
    this.preflightCritic();
    const payload = {
      model: this.criticModel, instructions: PROMPTS[kind], input: JSON.stringify(data),
      max_output_tokens: cap, store:false, reasoning:{effort:'low'},
      text:{format:{type:'json_schema',name:'nzt_' + kind,strict:true,schema:SCHEMAS[kind]}},
    };
    const result = await this.request(payload, 'critic', () => this.http('openai', payload));
    const messages = Array.isArray(result.output) ? result.output.filter(item => item?.type === 'message') : [];
    if (result.status !== 'completed' || result.incomplete_details || messages?.length !== 1 || messages[0].role !== 'assistant' || messages[0].status !== 'completed' || !Array.isArray(messages[0].content) || messages[0].content.some(item => item.type !== 'output_text' || !nonempty(item.text))) fail('Astra did not return a complete structured result; partial judgments and refusals were rejected.');
    const content = messages[0].content.map(item => item.text).join('');
    let parsed;
    try { parsed = JSON.parse(content); } catch { fail('Astra returned invalid structured JSON.'); }
    if (!object(parsed)) fail('Astra returned an invalid structured result.');
    return parsed;
  }
  async titles(config, assignments) {
    if (!assignments.length) return [];
    const result = await this.critic('titles', {concept:config.concept,assignments,previous_titles:config._previous_titles || []}, 8192);
    exact(result,['titles']);
    if (!Array.isArray(result.titles) || result.titles.length !== assignments.length) fail('Astra returned the wrong number of titles.');
    for (const [index,title] of result.titles.entries()) {
      exact(title,['title','author','venue','lens']);
      if (!Object.values(title).every(nonempty) || title.author !== assignments[index].author || title.venue !== assignments[index].venue) fail('Astra returned invalid titles or changed the author assignments.');
    }
    if (new Set(result.titles.map(t=>t.title.trim().toLowerCase())).size !== result.titles.length) fail('Astra repeated a title; the batch was rejected.');
    return result.titles;
  }
  async continue_post(config, title, prefix, temperature, seed) {
    continuationEndpoint(config);
    if (!nonempty(config.base_model) || !Number.isFinite(temperature) || temperature < 0 || !Number.isInteger(config.chunk_tokens) || config.chunk_tokens < 1 || typeof prefix !== 'string') fail('Invalid continuation settings.');
    const prompt = 'SYNTHETIC IDEATION EXPERIMENT: This is a fictional, unpublished draft, not a real post or an author\'s statement.\nExplore the concept through the intellectual interests associated with the named author.\n' +
      `Concept: ${config.concept}\nConceptual lens: ${title.lens}\n\nVenue: ${title.venue}\nTitle: ${title.title}\nImagined author: ${title.author}\n\n` + prefix;
    const payload = {model:config.base_model,prompt,temperature,top_p:1,max_tokens:config.chunk_tokens};
    const result = await this.request(payload,'base',()=>this.http('tinker',payload));
    const choice = result.choices?.[0];
    if (result.choices?.length !== 1 || !['stop','length'].includes(choice?.finish_reason) || choice.message?.refusal) fail('The continuation was filtered, incomplete, or invalid.');
    const text = choice.text;
    if (!nonempty(text)) fail('Tinker returned no raw completion text. Check the model ID and token limit.');
    return {text,finish_reason:choice.finish_reason,adapter:'tinker',response_shape:'text',experimental_mode:'raw_completion'};
  }
  async evaluate(config, title, candidates) {
    if (!candidates.length) return [];
    const result = await this.critic('evaluate',{concept:config.concept,title:title.title,lens:title.lens,candidates:candidates.map(({id,text})=>({id,text}))},4096);
    exact(result,['evaluations']);
    const values = reorder(result.evaluations,candidates.map(x=>x.id));
    for (const value of values) {
      exact(value,['id','novelty','usefulness','coherence','confidence','idea','reason','cluster','flags']);
      if (!['id','idea','reason','cluster'].every(k=>nonempty(value[k])) || !strings(value.flags)) fail('Astra returned invalid evaluation text.');
      if (['novelty','usefulness','coherence','confidence'].some(k=>!Number.isFinite(value[k]) || value[k]<0 || value[k]>1)) fail('Astra returned an invalid score.');
    }
    return values;
  }
  async final_review(config, posts) {
    if (!posts.length) return [];
    const result = await this.critic('final_review',{concept:config.concept,posts:posts.map(({id,title,lens,text})=>({id,title,lens,text}))},8192);
    exact(result,['decisions']);
    const values = reorder(result.decisions,posts.map(x=>x.id));
    for (const value of values) {
      exact(value,['id','keep','reason','idea','caveats']);
      if (typeof value.keep !== 'boolean' || !nonempty(value.reason) || typeof value.idea !== 'string' || (value.keep&&!nonempty(value.idea)) || !strings(value.caveats)) fail('Astra returned an invalid final-review decision.');
    }
    return values;
  }
  async summarize(config, notes) {
    if (!notes.length) return {overview:'No useful ideas survived final review.',ideas:[]};
    const normalized = notes.map(note=>({title:note.title,idea:note.idea??note.summary,reason:note.reason??note.why_it_matters,caveats:note.caveats,source_ids:note.source_ids}));
    if (normalized.some(n=>!['title','idea','reason'].every(k=>nonempty(n[k])) || !strings(n.caveats) || !strings(n.source_ids,true,true))) fail('Invalid reviewed idea notes.');
    const allowed = new Set(normalized.flatMap(n=>n.source_ids));
    const result = await this.critic('summarize',{concept:config.concept,notes:normalized},8192);
    exact(result,['overview','ideas']);
    if (!nonempty(result.overview) || !Array.isArray(result.ideas) || result.ideas.length<1 || result.ideas.length>8) fail('Astra returned an invalid synthesis.');
    for (const value of result.ideas) {
      exact(value,['title','summary','why_it_matters','caveats','source_ids']);
      if (!['title','summary','why_it_matters'].every(k=>nonempty(value[k])) || !strings(value.caveats) || !strings(value.source_ids,true,true) || value.source_ids.some(id=>!allowed.has(id))) fail('Astra returned invalid summary text or source references.');
    }
    return result;
  }
}
