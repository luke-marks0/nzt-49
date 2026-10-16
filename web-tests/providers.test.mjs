import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveProvider,continuationEndpoint,DEFAULT_CRITIC_MODEL,isSecurePageContext} from '../docs/providers.js';

const key = 'fixture-key-not-a-credential';
const config = {concept:'A test concept',base_model:'fixture/model',base_url:'https://openrouter.ai/api/v1',base_api:'openrouter',base_reasoning:'off',chunk_tokens:320};
function setup(data, options={}) {
  const calls=[]; const records=[];
  const provider=new LiveProvider(async (payload,role,send)=>{records.push({payload,role});return send();},{openrouterKey:key,astraEnabled:true,fetchImpl:async(url,options)=>{
    calls.push({url,options});
    return new Response(JSON.stringify(data),{status:200});
  },...options});
  return {provider,calls,records};
}
const response = content => ({choices:[{finish_reason:'stop',message:{content:JSON.stringify(content)}}],usage:{prompt_tokens:10,completion_tokens:20}});

test('API keys require HTTPS except for exact loopback development hosts', () => {
  assert.equal(isSecurePageContext(new URL('https://nzt-49.lukemarks.bot')), true);
  for (const host of ['localhost','127.0.0.1','[::1]']) assert.equal(isSecurePageContext(new URL('http://' + host + ':8766')), true);
  for (const url of ['http://nzt-49.lukemarks.bot','http://localhost.evil.test','file:///index.html']) assert.equal(isSecurePageContext(new URL(url)), false);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
  try {
    Object.defineProperty(globalThis, 'location', {value: new URL('http://nzt-49.lukemarks.bot'), configurable: true});
    assert.throws(() => setup({}), /over HTTPS/);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'location', previous);
    else delete globalThis.location;
  }
});

test('key only goes in OpenRouter headers, never recorded request',async()=>{
  const {provider,calls,records}=setup({choices:[{finish_reason:'length',text:' continuation'}]});
  const result=await provider.continue_post(config,{title:'Title',author:'Author',venue:'blog',lens:'lens'},'prefix',1.3,42);
  assert.equal(result.text,' continuation');
  assert.equal(calls[0].url,'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[0].options.headers.Authorization,'Bearer '+key);
  assert.equal(calls[0].options.redirect,'error');
  assert.equal(calls[0].options.credentials,'omit');
  assert.equal(JSON.stringify(records).includes(key),false);
  assert.equal(JSON.stringify(provider).includes(key),false);
  assert.equal(records[0].payload.prompt.endsWith('prefix'),true);
  assert.deepEqual(records[0].payload.reasoning,{enabled:false});
  assert.equal(records[0].payload.messages,undefined);
});
test('foreign origins, deceptive URLs and mismatched routes rejected',()=>{
  for(const base_url of ['https://example.org/api/v1','https://openrouter.ai.evil.test/api/v1','https://openrouter.ai@evil.test/api/v1','http://openrouter.ai/api/v1','https://openrouter.ai/api/v1?key=x','https://openrouter.ai/api/v1/completions']){
    assert.throws(()=>continuationEndpoint({...config,base_url}),{name:'ProviderError'});
  }
});
test('Astra requires explicit opt-in before any network request',async()=>{
  const {provider,calls,records}=setup({}, {astraEnabled:false});
  await assert.rejects(provider.titles(config,[{author:'Author',venue:'blog'}]),/Enable paid Astra/);
  assert.equal(calls.length,0); assert.equal(records.length,0);
});
test('title JSON schema uses exact Astra model and validates assignments',async()=>{
  const title={title:'Idea',author:'Author',venue:'blog',lens:'mechanism'};
  const {provider,records}=setup(response({titles:[title]}));
  assert.deepEqual(await provider.titles(config,[{author:'Author',venue:'blog'}]),[title]);
  assert.equal(records[0].payload.model,DEFAULT_CRITIC_MODEL);
  assert.equal(records[0].payload.response_format.json_schema.strict,true);
  assert.equal(records[0].payload.max_tokens,8192);
  await assert.rejects(provider.titles(config,[{author:'Other',venue:'blog'}]),/assignments/);
});
test('truncated structured response rejected',async()=>{
  const data=response({titles:[]});data.choices[0].finish_reason='length';
  const {provider}=setup(data);
  await assert.rejects(provider.titles(config,[{author:'A',venue:'blog'}]),/complete structured result/);
});
test('whole draft review rejects all and strips author metadata from judge',async()=>{
  const decision={id:'node-1',keep:false,reason:'Corrupted ending',idea:'',caveats:[]};
  const {provider,records}=setup(response({decisions:[decision]}));
  const post={id:'node-1',title:'Title',lens:'lens',text:'Useful beginning\nBROKEN ENDING',author:'Hidden author'};
  assert.deepEqual(await provider.final_review(config,[post]),[decision]);
  const sent=JSON.parse(records[0].payload.messages[1].content);
  assert.equal(sent.posts[0].text,post.text);assert.equal(sent.posts[0].author,undefined);
});
test('summary rejects invented source ids and makes no call for empty notes',async()=>{
  const data={overview:'Summary',ideas:[{title:'Title',summary:'Idea',why_it_matters:'Reason',caveats:[],source_ids:['invented']}]};
  const {provider,records}=setup(response(data));
  assert.deepEqual(await provider.summarize(config,[]),{overview:'No useful ideas survived final review.',ideas:[]});
  assert.equal(records.length,0);
  await assert.rejects(provider.summarize(config,[{title:'Title',idea:'Idea',reason:'Reason',caveats:[],source_ids:['node-1']}]),/source references/);
});
test('HTTP errors do not disclose upstream body or credentials',async()=>{
  const {provider}=setup({}, {fetchImpl:async()=>new Response('error with '+key,{status:401})});
  await assert.rejects(provider.http('https://openrouter.ai/api/v1/chat/completions',{}),error=>error.message.includes('401')&&!error.message.includes(key));
});

test('engine validates endpoint before any paid title call',async()=>{
  const {Engine}=await import('../docs/engine.js');
  let networkCalls=0;
  assert.throws(()=>new Engine({...config,base_url:'https://example.org/api/v1'},{mode:'live',providerFactory:hook=>new LiveProvider(hook,{openrouterKey:key,astraEnabled:true,fetchImpl:async()=>{networkCalls++;throw new Error('unexpected');}})}),/only to https/);
  assert.equal(networkCalls,0);
});
