import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine, pathText} from '../docs/engine.js';
import {LiveProvider, DEFAULT_CRITIC_MODEL} from '../docs/providers.js';
import {DEFAULTS} from '../docs/config.js';
import {validateImportedRun} from '../docs/storage.js';

const OPENAI_URL = 'https://api.openai.com/v1/responses';
const RELAY_URL = 'https://integration-relay.example.test';
const OPENAI_KEY = 'integration-openai-fixture-not-a-credential';
const TINKER_KEY = 'integration-tinker-fixture-not-a-credential';
const config = {...DEFAULTS, title_count: 1, branch_factor: 1, beam_width: 1, depth: 1};

function response(result) {
  return {
    status: 'completed', incomplete_details: null,
    output: [
      {type: 'reasoning', summary: []},
      {type: 'message', role: 'assistant', status: 'completed', content: [{type: 'output_text', text: JSON.stringify(result)}]},
    ],
    usage: {input_tokens: 10, output_tokens: 20},
  };
}

function harness({reviewOnly = false} = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const payload = JSON.parse(options.body);
    calls.push({url, options, payload});
    let result;
    if (url === RELAY_URL + '/completions') {
      assert.equal(reviewOnly, false, 'review must never call the continuation provider');
      result = {choices: [{text: 'Buy independently verified additional capacity through staged contracts.', finish_reason: 'stop'}], usage: {prompt_tokens: 3, completion_tokens: 4}};
    } else {
      assert.equal(url, OPENAI_URL, 'all critic requests go directly to OpenAI');
      const input = JSON.parse(payload.input);
      switch (payload.text.format.name) {
        case 'nzt_titles':
          result = {titles: input.assignments.map(assignment => ({...assignment, title: 'Capacity that can actually be added', lens: 'additional capacity'}))};
          break;
        case 'nzt_evaluate':
          result = {evaluations: input.candidates.map(candidate => ({id: candidate.id, novelty: 0.6, usefulness: 0.7, coherence: 0.8, confidence: 0.5, idea: 'Stage payments against additional capacity.', reason: 'Concrete mechanism in this fixture.', cluster: 'capacity', flags: []}))};
          break;
        case 'nzt_final_review':
          result = {decisions: input.posts.map(post => ({id: post.id, keep: true, reason: 'A usable mechanism for this integration fixture.', idea: 'Stage payments against independently verified additional capacity.', caveats: ['Synthetic test fixture; no evidence of effectiveness.']}))};
          break;
        case 'nzt_summarize':
          result = {overview: 'An illustrative capacity mechanism.', ideas: [{title: 'Pay for additional capacity', summary: 'Stage purchases against verified capacity.', why_it_matters: 'The distinction between ownership and additional output matters.', caveats: ['Synthetic integration fixture.'], source_ids: input.notes.flatMap(note => note.source_ids)}]};
          break;
        default:
          assert.fail('Unexpected critic request');
      }
      result = response(result);
    }
    return new Response(JSON.stringify(result), {status: 200});
  };
  return {
    calls,
    providerFactory: hook => new LiveProvider(hook, {
      openaiKey: OPENAI_KEY,
      ...(reviewOnly ? {} : {tinkerKey: TINKER_KEY, tinkerRelayUrl: RELAY_URL}),
      fetchImpl,
    }),
  };
}

function assertOpenAIRequest(call) {
  assert.equal(call.url, OPENAI_URL);
  assert.equal(call.options.headers.Authorization, 'Bearer ' + OPENAI_KEY);
  assert.equal(JSON.stringify(call).includes(TINKER_KEY), false);
  assert.equal(call.payload.model, DEFAULT_CRITIC_MODEL);
  assert.equal(call.payload.store, false);
  assert.equal(call.payload.text.format.type, 'json_schema');
  assert.equal(call.payload.text.format.strict, true);
  assert.equal(call.options.credentials, 'omit');
  assert.equal(call.options.redirect, 'error');
}

test('LiveProvider and Engine complete the real Responses/raw-completion contracts with isolated keys and saved audit state', async () => {
  const {calls, providerFactory} = harness();
  const checkpoints = [];
  const engine = new Engine(config, {mode: 'live', providerFactory, onSave: async state => { checkpoints.push(state); }});
  const state = await engine.run();

  assert.equal(state.status, 'completed');
  assert.equal(state.final_review.status, 'completed');
  assert.equal(calls.length, 5);
  assert.deepEqual(calls.map(call => call.payload.text?.format.name ?? 'continuation'), ['nzt_titles', 'continuation', 'nzt_evaluate', 'nzt_final_review', 'nzt_summarize']);
  const continuation = calls[1];
  assert.equal(continuation.url, RELAY_URL + '/completions');
  assert.equal(continuation.options.headers.Authorization, 'Bearer ' + TINKER_KEY);
  assert.equal(JSON.stringify(continuation).includes(OPENAI_KEY), false);
  assert.equal(continuation.payload.model, config.base_model);
  assert.equal(continuation.payload.max_tokens, config.chunk_tokens);
  assert.equal(typeof continuation.payload.prompt, 'string');
  assert.equal(continuation.payload.messages, undefined);
  assert.equal(continuation.payload.temperature, config.temperatures[0]);
  for (const call of calls.filter(call => call !== continuation)) assertOpenAIRequest(call);

  const post = JSON.parse(calls[3].payload.input).posts[0];
  assert.equal(post.text, pathText(state.nodes, post.id));
  assert.equal(post.author, undefined);
  assert.deepEqual(state.final_review.summary.ideas[0].source_ids, state.outputs);
  assert.equal(state.provenance.base_api, 'tinker');
  assert.equal(state.provenance.critic_backend, 'openai');
  assert.equal(state.provenance.critic_model, DEFAULT_CRITIC_MODEL);
  assert.equal(state.usage.calls, 5);
  assert.equal(state.usage.input_tokens, 43);
  assert.equal(state.usage.output_tokens, 84);
  assert.ok(state.requests.every(record => record.status === 'completed'));
  for (const key of [OPENAI_KEY, TINKER_KEY]) assert.equal(JSON.stringify(checkpoints).includes(key), false);
  assert.deepEqual(validateImportedRun(state), state);
});

test('LiveProvider and Engine review a legacy run using only OpenAI while preserving old generation and provenance', async () => {
  const initial = new Engine(config, {providerFactory: harness().providerFactory});
  const legacy = await initial.run();
  Object.assign(legacy.config, {base_api: 'openrouter', base_url: 'https://openrouter.ai/api/v1', base_model: 'historical/completion-model', base_reasoning: 'off'});
  Object.assign(legacy.provenance, {demo_fixtures: false, base_api: 'openrouter', base_url: legacy.config.base_url, base_model: legacy.config.base_model, critic_backend: 'openrouter', critic_model: 'historical/critic'});
  delete legacy.final_review;
  delete legacy.generation_completed;
  for (const node of legacy.nodes) delete node.final_review;
  const previous = structuredClone(legacy);
  const {calls, providerFactory} = harness({reviewOnly: true});
  const engine = Engine.forFinalReview(legacy, {providerFactory});
  const state = await engine.run({reviewOnly: true});

  assert.equal(state.status, 'completed');
  assert.equal(state.final_review.status, 'completed');
  assert.deepEqual(calls.map(call => call.payload.text.format.name), ['nzt_final_review', 'nzt_summarize']);
  for (const call of calls) assertOpenAIRequest(call);
  assert.deepEqual(state.config, previous.config);
  assert.deepEqual(state.nodes.map(node => node.text), previous.nodes.map(node => node.text));
  assert.deepEqual(state.titles, previous.titles);
  assert.equal(state.provenance.base_api, 'openrouter');
  assert.equal(state.provenance.base_model, 'historical/completion-model');
  assert.equal(state.provenance.critic_backend, 'openrouter');
  assert.equal(state.provenance.critic_model, 'historical/critic');
  assert.equal(state.provenance.final_critic_backend, 'openai');
  assert.equal(state.provenance.final_critic_model, DEFAULT_CRITIC_MODEL);
  assert.equal(state.usage.calls, previous.usage.calls + 2);
  assert.deepEqual(legacy, previous, 'review must not mutate the input run');
  for (const key of [OPENAI_KEY, TINKER_KEY]) assert.equal(JSON.stringify(state).includes(key), false);
  assert.deepEqual(validateImportedRun(state), state);
});
