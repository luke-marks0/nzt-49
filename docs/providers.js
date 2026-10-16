import { PROMPTS, SCHEMAS } from './prompts.js';

export const DEFAULT_CRITIC_MODEL = 'openai/gpt-6-astra';
const API = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_RESPONSE = 8 * 1024 * 1024;
export class ProviderError extends Error { constructor(message) { super(message); this.name = 'ProviderError'; } }
const fail = message => { throw new ProviderError(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const strings = (value, required = false, unique = false) => Array.isArray(value) && (!required || value.length > 0) && value.every(nonempty) && (!unique || new Set(value).size === value.length);
function exact(value, keys) {
  if (!object(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('Astra returned an unexpected structured result.');
}
function reorder(items, ids) {
  if (!Array.isArray(items) || items.length !== ids.length || new Set(items.map(x => x?.id)).size !== ids.length || items.some(x => !ids.includes(x?.id))) fail('Astra returned missing, duplicate, or unknown draft IDs.');
  const mapped = new Map(items.map(item => [item.id, item]));
  return ids.map(id => mapped.get(id));
}
export function continuationEndpoint(config) {
  let url;
  try { url = new URL(config.base_url); } catch { fail('Choose a valid OpenRouter endpoint.'); }
  if (url.origin !== 'https://openrouter.ai' || url.username || url.password || url.search || url.hash) fail('This browser app sends keys only to https://openrouter.ai.');
  const suffix = config.base_api === 'completions' ? '/completions' : '/chat/completions';
  const path = url.pathname.replace(/\/+$/, '');
  if (path === '/api/v1') return url.origin + path + suffix;
  if (path !== '/api/v1' + suffix) fail('The endpoint does not match the selected completion API.');
  return url.origin + path;
}

export class LiveProvider {
  #key;
  constructor(requestHook, { openrouterKey, criticModel = DEFAULT_CRITIC_MODEL, astraEnabled = false, fetchImpl = globalThis.fetch } = {}) {
    if (typeof openrouterKey !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(openrouterKey)) fail('Enter an OpenRouter key for this tab.');
    if (criticModel !== DEFAULT_CRITIC_MODEL) fail('This experiment uses the explicitly selected Astra model.');
    this.#key = openrouterKey;
    this.request = requestHook;
    this.criticModel = criticModel;
    this.astraEnabled = astraEnabled === true;
    this.fetchImpl = fetchImpl;
  }
  preflight(config) {
    continuationEndpoint(config);
    if (!nonempty(config.base_model)) fail('Choose an explicit continuation model ID.');
    if (!this.astraEnabled) fail('Enable paid Astra through OpenRouter before starting a live run.');
  }
  async http(url, payload) {
    if (new URL(url).origin !== 'https://openrouter.ai') fail('The key can only be sent to OpenRouter.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000);
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.#key },
        body: JSON.stringify(payload), signal: controller.signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer',
      });
      if (!response.ok) fail(`OpenRouter returned HTTP ${response.status}. Check the model, key, credits, and rate limits.`);
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
      raw = raw.split(this.#key).join('[credential redacted]');
      let result;
      try { result = JSON.parse(raw); } catch { fail('OpenRouter returned invalid JSON.'); }
      if (!object(result) || result.error) fail('OpenRouter could not complete the request. Check model access, credits, and limits.');
      const usage = result.usage;
      if (usage != null && (!object(usage) || ['prompt_tokens','completion_tokens','input_tokens','output_tokens'].some(k => usage[k] != null && (!Number.isSafeInteger(usage[k]) || usage[k] < 0)))) fail('OpenRouter returned invalid token usage.');
      return result;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      fail('OpenRouter request failed or timed out. Check your connection and browser access to the API. Saved drafts are preserved.');
    } finally { clearTimeout(timeout); }
  }
  async critic(kind, data, cap) {
    if (!this.astraEnabled) fail('Enable paid Astra through OpenRouter before starting a live run.');
    const payload = {
      model: this.criticModel, messages: [{role:'system',content:PROMPTS[kind]}, {role:'user',content:JSON.stringify(data)}],
      max_tokens: cap, stream:false, reasoning:{effort:'low'},
      response_format:{type:'json_schema',json_schema:{name:'nzt_' + kind,strict:true,schema:SCHEMAS[kind]}},
      provider:{require_parameters:true},
    };
    const result = await this.request(payload, 'critic', () => this.http(API, payload));
    const choice = result.choices?.[0];
    if (result.choices?.length !== 1 || choice?.finish_reason !== 'stop' || choice.message?.refusal || !nonempty(choice.message?.content)) fail('Astra did not return a complete structured result; partial judgments were rejected.');
    let parsed;
    try { parsed = JSON.parse(choice.message.content); } catch { fail('Astra returned invalid structured JSON.'); }
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
    const url = continuationEndpoint(config);
    if (!nonempty(config.base_model) || !Number.isFinite(temperature) || temperature < 0 || !Number.isInteger(config.chunk_tokens) || config.chunk_tokens < 1 || typeof prefix !== 'string') fail('Invalid continuation settings.');
    const prompt = 'SYNTHETIC IDEATION EXPERIMENT: This is a fictional, unpublished draft, not a real post or an author\'s statement.\nExplore the concept through the intellectual interests associated with the named author.\n' +
      `Concept: ${config.concept}\nConceptual lens: ${title.lens}\n\nVenue: ${title.venue}\nTitle: ${title.title}\nImagined author: ${title.author}\n\n` + prefix;
    const payload = {model:config.base_model,temperature,top_p:1,n:1,max_tokens:config.chunk_tokens,stream:false,provider:{require_parameters:true}};
    if (config.base_api === 'chat') payload.messages = [
      {role:'system',content:'Continue the supplied fictional draft directly from its exact ending. Return only new continuation text. Preserve sentence fragments and whitespace. Do not repeat, summarize, or revise the prefix, or add introductory commentary.'},
      {role:'user',content:prompt},
    ]; else payload.prompt = prompt;
    if (config.base_reasoning === 'off') payload.reasoning = {enabled:false};
    const result = await this.request(payload,'base',()=>this.http(url,payload));
    const choice = result.choices?.[0];
    if (result.choices?.length !== 1 || !['stop','length'].includes(choice?.finish_reason) || choice.message?.refusal) fail('The continuation was filtered, incomplete, or invalid.');
    const text = typeof choice.text === 'string' ? choice.text : choice.message?.content;
    if (!nonempty(text)) fail('No continuation text returned. Disable continuation reasoning or increase chunk tokens.');
    return {text,finish_reason:choice.finish_reason,adapter:config.base_api,response_shape:typeof choice.text === 'string'?'text':'message.content',experimental_mode:config.base_api==='chat'?'chat_comparison':'raw_completion'};
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
