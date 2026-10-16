import test from "node:test";
import assert from "node:assert/strict";
import {Engine, pathText, exportMarkdown, select, reviewBatches} from "../docs/engine.js";
import {DEFAULTS, validate, estimate, assignments} from "../docs/config.js";
import {DemoProvider} from "../docs/demo.js";

const small = {title_count:1,branch_factor:1,depth:1};
class RecordingProvider extends DemoProvider {
  constructor(hook) { super(hook); this.titleInputs=[]; this.prefixes=[]; this.ratings=[]; this.posts=[]; this.notes=[]; }
  async titles(config, requested) { this.titleInputs.push(structuredClone({config,requested})); return super.titles(config,requested); }
  async continue_post(config,title,prefix,temperature,seed) { this.prefixes.push({title,prefix,temperature,seed}); return this.call({text:` [${title.id}:${seed}] `,finish_reason:this.finishReason||"length"},"base",config.chunk_tokens); }
  async evaluate(config,title,candidates) { this.ratings.push(structuredClone(candidates)); return this.call(candidates.map(c=>({id:c.id,novelty:.8,usefulness:.8,coherence:.8,confidence:.5,idea:`Idea ${c.id}`,reason:"Test assessment",cluster:c.id,flags:[]})),"critic",4096); }
  async final_review(config,posts) { this.posts.push(...structuredClone(posts)); return this.call(posts.map(p=>({id:p.id,keep:!this.rejectAll,reason:"Test review",idea:this.rejectAll?"":`Mechanism ${p.id}`,caveats:["Unverified fixture"]})),"critic",8192); }
  async summarize(config,notes) { this.notes.push(structuredClone(notes)); if(this.failSummaryAt===this.notes.length) return this.request({max_tokens:8192},"critic",async()=>{const e=new Error("Test summary failure"); e.name="ProviderError"; throw e;}); return super.summarize(config,notes); }
}
function setup(config={},options={}) { let provider; const engine=new Engine({...small,...config},{...options,providerFactory:hook=>{provider=new RecordingProvider(hook); return provider;}}); return {engine,provider}; }
function savedDrafts(seed,count) { const state=structuredClone(seed); state.status="completed"; state.generation_completed=true; state.final_review={status:"pending",candidate_ids:[],decisions:[],summary:null}; state.nodes=Array.from({length:count},(_,i)=>({...structuredClone(seed.nodes[0]),id:`node-${i+1}`,parent_id:null,status:"finished",text:`complete text ${i+1}`})); state.outputs=state.nodes.map(n=>n.id); state.config.max_calls=250; state.config.max_output_tokens=1000000; return state; }

test("configuration preserves defaults, author assignments, and conservative budget estimates",()=>{
  const c=validate({}); assert.equal(c.base_model,"nvidia/nemotron-3.5-lightning:free"); assert.equal(c.base_reasoning,"off"); assert.equal(estimate(c).max_calls,30); assert.equal(estimate(c).max_output_tokens,63744);
  const requested=assignments(validate({title_count:2,title_mode:"per_author",authors:["A","B"]})); assert.equal(requested.length,4); assert.deepEqual(requested.map(x=>x.author),["A","B","A","B"]); assert.equal(requested[1].venue,"personal blog");
  c.authors.push("changed"); assert.equal(DEFAULTS.authors.length,10);
});
test("configuration rejects non-finite parameters, unsafe URLs, and unexpected credential fields",()=>{
  for(const bad of [{seed:true},{temperatures:[NaN]},{depth:0},{base_url:"https://user:pass@example.com"},{base_url:"http://example.com"},{base_url:"https://example.com/?key=value"},{api_key:"private"},{title_count:200,title_mode:"per_author"}]) assert.throws(()=>validate(bad));
  assert.equal(validate({base_url:"http://127.0.0.1:8080"}).base_url,"http://127.0.0.1:8080");
});
test("demo completes final review and summary without network access",async()=>{
  const engine=new Engine(small),state=await engine.run(); assert.equal(state.status,"completed"); assert.equal(state.final_review.status,"completed"); assert.ok(state.final_review.summary.ideas.length); assert.equal(state.usage.calls,5); assert.ok(state.requests.every(r=>r.request.demo_fixture));
  const markdown=exportMarkdown(state); assert.match(markdown,/OFFLINE DEMO/); assert.match(markdown,/## Best ideas/); assert.match(markdown,/Source paths: node-1/); assert.match(markdown,/Partial draft/);
});
test("checkpoints and snapshots do not expose mutable engine state",async()=>{
  const checkpoints=[]; const {engine}=setup({}, {onSave:async state=>{checkpoints.push(state); state.config.concept="mutated copy";}}); const state=await engine.run(); assert.notEqual(state.config.concept,"mutated copy"); assert.ok(checkpoints.length>5); const copy=engine.snapshot(); copy.nodes[0].text="mutated"; assert.notEqual(engine.state.nodes[0].text,"mutated");
});
test("continuations, evaluation and final review receive exact ancestral text only",async()=>{
  const {engine,provider}=setup({branch_factor:2,beam_width:2,depth:2}); const state=await engine.run(); assert.equal(state.status,"completed"); assert.equal(state.nodes.length,6);
  for(const post of provider.posts) { assert.equal(post.text,pathText(state.nodes,post.id)); assert.deepEqual(Object.keys(post).sort(),["id","lens","text","title"]); }
  for(const batch of provider.ratings) for(const candidate of batch) assert.equal(candidate.text,pathText(state.nodes,candidate.id));
  for(const input of provider.prefixes.filter(x=>x.prefix)) assert.ok(state.nodes.some(n=>pathText(state.nodes,n.id)===input.prefix));
  assert.equal(state.outputs.length,2);
});
test("titles are batched with previous titles and per-author counts retained",async()=>{
  const {engine,provider}=setup({authors:["A","B"],title_count:11,title_mode:"per_author",max_output_tokens:1000000}); const state=await engine.run(); assert.equal(state.status,"completed"); assert.equal(state.titles.length,22); assert.equal(provider.titleInputs.length,2); assert.equal(provider.titleInputs[1].config._previous_titles.length,20); assert.equal(state.titles.filter(t=>t.author==="A").length,11);
});
test("grace period retains all branches, then each title has its own beam",async()=>{
  const {engine}=setup({title_count:2,branch_factor:3,beam_width:1,depth:2,grace_depth:2}); const state=await engine.run(); assert.equal(state.status,"completed"); assert.equal(state.nodes.filter(n=>n.depth===1).length,6); assert.ok(state.nodes.filter(n=>n.depth===1).every(n=>n.status==="expanded")); assert.equal(state.outputs.length,2); assert.equal(new Set(state.outputs.map(id=>state.nodes.find(n=>n.id===id).title_id)).size,2);
});
test("selection is deterministic and small beams accumulate exploration slots",()=>{
  const c=validate({beam_width:1,exploration_fraction:.25,grace_depth:1,title_count:1}), nodes=Array.from({length:4},(_,i)=>({id:String(i),evaluation:{usefulness:i/4,novelty:i/4,coherence:1,idea:`idea ${i}`,cluster:String(i)}}));
  const decisions=Array.from({length:8},(_,i)=>select(nodes,c,i+1,0)); assert.deepEqual(decisions,Array.from({length:8},(_,i)=>select(nodes,c,i+1,0))); assert.equal(decisions.filter(d=>Object.values(d)[0].startsWith("Exploration")).length,2);
  const random=select(nodes,{...c,selection_mode:"random"},1,0); assert.match(Object.values(random)[0],/Random-pruning/);
});
test("endpoint stop ends a path without discarding it or expanding again",async()=>{
  const {engine,provider}=setup({depth:4}); provider.finishReason="stop"; const state=await engine.run(); assert.equal(state.status,"completed"); assert.equal(provider.prefixes.length,1); assert.equal(state.nodes[0].status,"finished"); assert.deepEqual(state.outputs,["node-1"]);
});
test("every request reserves its budget before sending and preserves unjudged text",async()=>{
  const {engine,provider}=setup({max_calls:2}); const state=await engine.run(); assert.equal(state.status,"budget_exhausted"); assert.equal(state.nodes.length,1); assert.equal(provider.ratings.length,1); assert.equal(state.requests.length,2); assert.equal(state.nodes[0].evaluation,null); assert.deepEqual(state.outputs,["node-1"]); assert.equal(state.final_review.status,"skipped");
  const tokens=setup({max_output_tokens:8191}); const empty=await tokens.engine.run(); assert.equal(empty.usage.calls,0); assert.equal(empty.status,"budget_exhausted");
});
test("reported excess usage is charged and blocks later requests",async()=>{
  const {engine}=setup({max_output_tokens:8192}); await engine.ready;
  await engine.request({max_tokens:8192},"critic",async()=>({usage:{prompt_tokens:12,completion_tokens:9000}})); assert.equal(engine.state.usage.reserved_output_tokens,9000); assert.equal(engine.state.usage.input_tokens,12); let sent=false;
  await assert.rejects(engine.request({max_tokens:1},"critic",async()=>{sent=true;return {};})); assert.equal(sent,false);
});
test("request hooks serialize asynchronous sends and redact credential metadata",async()=>{
  const {engine}=setup(); await engine.ready; const order=[]; const send=i=>async()=>{order.push(`start${i}`);await new Promise(resolve=>setTimeout(resolve,2));order.push(`end${i}`);return {headers:{Authorization:"private-test-value"},usage:{output_tokens:1}};};
  await Promise.all([engine.request({max_tokens:1,api_key:"private-test-value",OPENROUTER_API_KEY:"private-test-value"},"base",send(1)),engine.request({max_tokens:1},"base",send(2))]); assert.deepEqual(order,["start1","end1","start2","end2"]); assert.doesNotMatch(JSON.stringify(engine.state.requests),/private-test-value/);
});
test("stop preserves an in-flight continuation and sends no later request",async()=>{
  const {engine,provider}=setup({depth:2}); const original=provider.continue_post.bind(provider); provider.continue_post=async(...args)=>{const result=await original(...args);engine.stop();return result;}; const state=await engine.run(); assert.equal(state.status,"stopped"); assert.equal(state.nodes.length,1); assert.equal(state.usage.calls,2); assert.equal(state.nodes[0].evaluation,null);
});
test("final review may reject every draft without reviving old outputs",async()=>{
  const {engine,provider}=setup(); provider.rejectAll=true; const state=await engine.run(); assert.equal(state.status,"completed"); assert.deepEqual(state.outputs,[]); assert.equal(state.nodes[0].status,"final_pruned"); assert.deepEqual(state.final_review.summary.ideas,[]); assert.equal(state.usage.calls,4); assert.match(exportMarkdown(state),/No useful ideas survived/);
});
test("failed final synthesis resumes without regenerating or re-reviewing saved drafts",async()=>{
  const {engine,provider}=setup(); provider.failSummaryAt=1; const state=await engine.run(); assert.equal(state.status,"failed"); assert.equal(state.generation_completed,true); assert.equal(state.final_review.decisions.length,1);
  let retryProvider; const retry=Engine.forFinalReview(state,{providerFactory:hook=>(retryProvider=new RecordingProvider(hook))}); const result=await retry.run({reviewOnly:true}); assert.equal(result.status,"completed"); assert.equal(retryProvider.prefixes.length,0); assert.equal(retryProvider.posts.length,0); assert.equal(retryProvider.notes.length,1); assert.equal(result.nodes[0].text,state.nodes[0].text); assert.equal(result.usage.calls,state.usage.calls+1);
});
test("completed legacy generation can be reviewed while incomplete generation cannot",async()=>{
  const {engine}=setup(); const seed=await engine.run(); const legacy=savedDrafts(seed,2); delete legacy.final_review; delete legacy.generation_completed; const retry=Engine.forFinalReview(legacy); const result=await retry.run({reviewOnly:true}); assert.equal(result.status,"completed"); assert.equal(result.nodes[0].text,legacy.nodes[0].text);
  assert.throws(()=>Engine.forFinalReview({...seed,status:"stopped",generation_completed:false}),/Finish generation/); assert.throws(()=>Engine.forFinalReview(seed),/already has/);
});
test("oversized final drafts fail explicitly without truncation or model call",async()=>{
  const {engine}=setup(); const state=savedDrafts(await engine.run(),1); state.nodes[0].text="x".repeat(120001); let provider; const retry=Engine.forFinalReview(state,{providerFactory:hook=>(provider=new RecordingProvider(hook))}); const result=await retry.run({reviewOnly:true}); assert.equal(result.status,"failed"); assert.match(result.error,/too long/); assert.equal(provider.posts.length,0); assert.equal(result.nodes[0].text.length,120001); assert.deepEqual(result.outputs,["node-1"]);
  assert.deepEqual(reviewBatches([{x:1},{x:2},{x:3}],2).map(x=>x.length),[2,1]);
});
test("hierarchical synthesis preserves original sources and reuses successful cached batches",async()=>{
  const {engine}=setup(); const state=savedDrafts(await engine.run(),81); let first; const attempt=Engine.forFinalReview(state,{providerFactory:hook=>(first=new RecordingProvider(hook))}); first.failSummaryAt=2; const interrupted=await attempt.run({reviewOnly:true}); assert.equal(interrupted.status,"failed"); assert.equal(interrupted.final_review.decisions.length,81); assert.equal(interrupted.final_review.summary_passes.length,1);
  let second; const retry=Engine.forFinalReview(interrupted,{providerFactory:hook=>(second=new RecordingProvider(hook))}); const complete=await retry.run({reviewOnly:true}); assert.equal(complete.status,"completed"); assert.equal(second.posts.length,0); assert.equal(second.notes.length,3); assert.equal(complete.final_review.summary_passes.length,3); const ids=new Set(state.outputs); assert.ok(complete.final_review.summary.ideas.every(idea=>idea.source_ids.every(id=>ids.has(id))));
});
test("path text preserves whitespace, excludes siblings, and rejects damaged ancestry",()=>{
  const nodes=[{id:"a",parent_id:null,text:" first "},{id:"b",parent_id:"a",text:"\nsecond"},{id:"c",parent_id:"a",text:"sibling"}]; assert.equal(pathText(nodes,"b")," first \nsecond"); assert.throws(()=>pathText(nodes,"missing"),/incomplete/); assert.throws(()=>pathText([{id:"a",parent_id:"a",text:""}],"a"),/cyclic/);
});
test("arbitrary provider errors do not leak raw exception content",async()=>{
  const {engine,provider}=setup(); provider.titles=async()=>{throw new Error("private credential material");}; const state=await engine.run(); assert.equal(state.status,"failed"); assert.doesNotMatch(JSON.stringify(state),/private credential/);
});
