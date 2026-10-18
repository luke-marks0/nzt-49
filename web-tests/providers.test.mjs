import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveProvider,continuationEndpoint,relayEndpoint,DEFAULT_CRITIC_MODEL,isSecurePageContext} from '../docs/providers.js';
import {DEFAULTS,TINKER_API_BASE} from '../docs/config.js';

const tinkerKey = 'fixture-tinker-key-not-a-credential';
const openaiKey = 'fixture-openai-key-not-a-credential';
const tinkerRelayUrl = 'https://relay.example.test';
const config = {...DEFAULTS,concept:'A test concept'};
const title = {title:'Idea',author:'Author',venue:'blog',lens:'mechanism'};
function setup(data, options={}) {
  const calls=[]; const records=[];
  const provider=new LiveProvider(async (payload,role,send)=>{records.push({payload,role});return send();},{tinkerKey,openaiKey,tinkerRelayUrl,fetchImpl:async(url,options)=>{
    calls.push({url,options});
    return new Response(JSON.stringify(data),{status:200});
  },...options});
  return {provider,calls,records};
}
const response = content => ({status:'completed',incomplete_details:null,output:[{type:'reasoning',summary:[]},{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(content)}]}],usage:{input_tokens:10,output_tokens:20}});

test('API keys require HTTPS except for exact loopback development hosts', () => {
  assert.equal(isSecurePageContext(new URL('https://nzt-49.luke.enterprises')), true);
  for (const host of ['localhost','127.0.0.1','[::1]']) assert.equal(isSecurePageContext(new URL('http://' + host + ':8766')), true);
  for (const url of ['http://nzt-49.luke.enterprises','http://localhost.evil.test','file:///index.html']) assert.equal(isSecurePageContext(new URL(url)), false);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
  try {
    Object.defineProperty(globalThis, 'location', {value: new URL('http://nzt-49.luke.enterprises'), configurable: true});
    assert.throws(() => setup({}), /over HTTPS/);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'location', previous);
    else delete globalThis.location;
  }
});

test('Tinker receives raw prompt through chosen relay with only its own key',async()=>{
  const {provider,calls,records}=setup({choices:[{finish_reason:'length',text:' continuation'}]});
  const result=await provider.continue_post(config,title,'prefix\n unfinished ',1.3,42);
  assert.equal(result.text,' continuation');
  assert.equal(result.adapter,'tinker');
  assert.equal(calls[0].url,tinkerRelayUrl+'/completions');
  assert.equal(calls[0].options.headers.Authorization,'Bearer '+tinkerKey);
  assert.equal(calls[0].options.redirect,'error');
  assert.equal(calls[0].options.credentials,'omit');
  assert.equal(records[0].payload.prompt.endsWith('prefix\n unfinished '),true);
  assert.equal(records[0].payload.temperature,1.3);
  assert.equal(records[0].payload.model,'Qwen/Qwen3.5-9B-Base');
  assert.deepEqual(Object.keys(records[0].payload).sort(),['max_tokens','model','prompt','temperature','top_p']);
  for(const key of [tinkerKey,openaiKey]) {
    assert.equal(JSON.stringify(records).includes(key),false);
    assert.equal(JSON.stringify(provider).includes(key),false);
  }
});

test('foreign upstream endpoints and unsafe relay URLs are rejected',()=>{
  for(const base_url of ['https://example.org/api/v1','https://openrouter.ai/api/v1',TINKER_API_BASE+'?key=x',TINKER_API_BASE+'/chat/completions']) assert.throws(()=>continuationEndpoint({...config,base_url}),{name:'ProviderError'});
  assert.equal(continuationEndpoint(config),TINKER_API_BASE+'/completions');
  for(const value of ['','http://relay.example.test','https://user:password@relay.example.test','https://relay.example.test?key=x','https://relay.example.test/other','https://relay.example.test/#x']) assert.throws(()=>relayEndpoint(value),{name:'ProviderError'});
  assert.equal(relayEndpoint('http://127.0.0.1:8787/'),'http://127.0.0.1:8787/completions');
});

test('new live runs require both keys and relay before making any paid title request',async()=>{
  const {Engine}=await import('../docs/engine.js');
  for(const options of [{tinkerKey:''},{openaiKey:''},{tinkerRelayUrl:''}]) {
    let networkCalls=0;
    assert.throws(()=>new Engine(config,{mode:'live',providerFactory:hook=>new LiveProvider(hook,{tinkerKey,openaiKey,tinkerRelayUrl,...options,fetchImpl:async()=>{networkCalls++;throw new Error('unexpected');}})}),{name:'ProviderError'});
    assert.equal(networkCalls,0);
  }
});

test('Astra uses OpenAI Responses schema, private storage flag, and only OpenAI key',async()=>{
  const {provider,records,calls}=setup(response({titles:[title]}));
  assert.deepEqual(await provider.titles(config,[{author:'Author',venue:'blog'}]),[title]);
  assert.equal(calls[0].url,'https://api.openai.com/v1/responses');
  assert.equal(calls[0].options.headers.Authorization,'Bearer '+openaiKey);
  assert.equal(JSON.stringify(calls[0]).includes(tinkerKey),false);
  assert.equal(records[0].payload.model,DEFAULT_CRITIC_MODEL);
  assert.equal(records[0].payload.text.format.strict,true);
  assert.equal(records[0].payload.max_output_tokens,8192);
  assert.equal(records[0].payload.store,false);
  assert.deepEqual(records[0].payload.reasoning,{effort:'low'});
  assert.equal(records[0].payload.provider,undefined);
  await assert.rejects(provider.titles(config,[{author:'Other',venue:'blog'}]),/assignments/);
});

test('incomplete or refused Responses results are never accepted as judgments',async()=>{
  const good=response({titles:[title]});
  const refused=structuredClone(good);refused.output[1].content=[{type:'refusal',refusal:'No'}];
  for(const data of [{...good,status:'incomplete'},{...good,incomplete_details:{reason:'max_output_tokens'}},{...good,output:[]},refused]) {
    const {provider}=setup(data);
    await assert.rejects(provider.titles(config,[{author:'Author',venue:'blog'}]),/complete structured result/);
  }
});

test('whole draft review works with only OpenAI and strips author metadata from judge',async()=>{
  const decision={id:'node-1',keep:false,reason:'Corrupted ending',idea:'',caveats:[]};
  const {provider,records}=setup(response({decisions:[decision]}),{tinkerKey:'',tinkerRelayUrl:''});
  const post={id:'node-1',title:'Title',lens:'lens',text:'Useful beginning\nBROKEN ENDING',author:'Hidden author'};
  provider.preflightCritic();
  assert.deepEqual(await provider.final_review(config,[post]),[decision]);
  const sent=JSON.parse(records[0].payload.input);
  assert.equal(sent.posts[0].text,post.text);assert.equal(sent.posts[0].author,undefined);
});

test('summary rejects invented source ids and makes no call for empty notes',async()=>{
  const data={overview:'Summary',ideas:[{title:'Title',summary:'Idea',why_it_matters:'Reason',caveats:[],source_ids:['invented']}]};
  const {provider,records}=setup(response(data));
  assert.deepEqual(await provider.summarize(config,[]),{overview:'No useful ideas survived final review.',ideas:[]});
  assert.equal(records.length,0);
  await assert.rejects(provider.summarize(config,[{title:'Title',idea:'Idea',reason:'Reason',caveats:[],source_ids:['node-1']}]),/source references/);
});

test('errors and upstream credential echoes cannot leak either key into saved records',async()=>{
  const {provider}=setup({}, {fetchImpl:async()=>new Response(tinkerKey+' '+openaiKey,{status:401})});
  await assert.rejects(provider.http('openai',{}),error=>error.message.includes('401')&&![tinkerKey,openaiKey].some(key=>error.message.includes(key)));
  const echo=setup({choices:[{finish_reason:'length',text:tinkerKey+' '+openaiKey}]});
  const result=await echo.provider.continue_post(config,title,'prefix',1.3,42);
  assert.equal(result.text,'[credential redacted] [credential redacted]');
});

test('Tinker chat-shaped output is rejected instead of silently changing generation mode',async()=>{
  const {provider}=setup({choices:[{finish_reason:'stop',message:{content:'chat reply'}}]});
  await assert.rejects(provider.continue_post(config,title,'prefix',1,1),/no raw completion/);
});

test('JSON-escaped credential echoes are removed before audit records can be saved',async()=>{
  const escaped = [...openaiKey].map(char => '\\u' + char.charCodeAt(0).toString(16).padStart(4,'0')).join('');
  const {provider}=setup({}, {fetchImpl:async()=>new Response('{"note":"'+escaped+'"}',{status:200})});
  assert.deepEqual(await provider.http('openai',{}),{note:'[credential redacted]'});
});
