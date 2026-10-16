import {validate, assignments, ValidationError, FINAL_REVIEW_BATCH_SIZE, SUMMARY_BATCH_SIZE, FINAL_INPUT_CHARS} from "./config.js";
import {seededRandom} from "./random.js";

const clone = value => structuredClone(value);
const now = () => new Date().toISOString();
class BudgetExhausted extends Error {}
class Stopped extends Error {}
const fail = message => { throw new ValidationError(message); };
function auditCopy(value) {
  if (Array.isArray(value)) return value.map(auditCopy);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key,item]) => [key, /authorization|api[_-]?key|access[_-]?token|auth[_-]?token|secret|^headers$|^(?:openrouter|openai|tinker)[_-]?key$/i.test(key) ? "[redacted]" : auditCopy(item)]));
  return value;
}
function stableJSON(value) {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJSON(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
async function inputHash(value) { const bytes = new TextEncoder().encode(stableJSON(value)); const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes); return [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2,"0")).join(""); }
export function reviewBatches(items, maxItems) {
  const groups = []; let batch = [], size = 0;
  for (const item of items) { const length = JSON.stringify(item).length;
    if (length > FINAL_INPUT_CHARS) fail("A final-review input is too long to review in full. Reduce depth or chunk size; all generated text is saved.");
    if (batch.length && (batch.length >= maxItems || size + length > FINAL_INPUT_CHARS)) { groups.push(batch); batch=[]; size=0; }
    batch.push(item); size += length;
  }
  if (batch.length) groups.push(batch);
  return groups;
}
export function pathText(nodes, nodeId) {
  const byId = new Map(nodes.map(n => [n.id,n])), chunks = [], visited = new Set();
  while (nodeId != null) { if (visited.has(nodeId) || !byId.has(nodeId)) fail("Draft ancestry is incomplete or cyclic."); visited.add(nodeId); const node = byId.get(nodeId); chunks.push(node.text); nodeId = node.parent_id; }
  return chunks.reverse().join("");
}
const quality = n => .50*n.evaluation.usefulness + .35*n.evaluation.novelty + .15*n.evaluation.coherence;
function similarity(a,b) { const x=new Set(a.toLowerCase().match(/[\p{L}\p{N}_]+/gu)||[]), y=new Set(b.toLowerCase().match(/[\p{L}\p{N}_]+/gu)||[]); return [...x].filter(v=>y.has(v)).length/Math.max(1,new Set([...x,...y]).size); }
function sample(items,count,rng) { const pool=[...items], result=[]; for(let i=0;i<count;i++) result.push(pool.splice(Math.floor(rng()*pool.length),1)[0]); return result; }
export function select(candidates,c,depth,titleIndex) {
  const width=Math.min(c.beam_width,candidates.length);
  if(depth<c.grace_depth) return Object.fromEntries(candidates.map(n=>[n.id,"Grace period: let the idea develop before pruning."]));
  const rng=seededRandom(c.seed+depth*100003+titleIndex);
  if(c.selection_mode==="random") return Object.fromEntries(sample(candidates,width,rng).map(n=>[n.id,"Random-pruning control; critic scores did not affect selection."]));
  const step=(depth-c.grace_depth)*assignments(c).length+titleIndex, exploratory=Math.floor((step+1)*width*c.exploration_fraction)-Math.floor(step*width*c.exploration_fraction);
  const selected=[], remaining=[...candidates], reasons={};
  for(let i=0;i<width-exploratory;i++) { const value=n=>quality(n)-.20*Math.max(0,...selected.map(s=>similarity(n.evaluation.idea,s.evaluation.idea)))-.10*Number(selected.some(s=>s.evaluation.cluster===n.evaluation.cluster)); let best=remaining[0]; for(const n of remaining.slice(1)) if(value(n)>value(best)) best=n; selected.push(best); remaining.splice(remaining.indexOf(best),1); reasons[best.id]="Retained for idea value with a duplicate-idea penalty."; }
  for(const node of sample(remaining,exploratory,rng)) reasons[node.id]="Exploration slot: retained independently of critic rank.";
  return reasons;
}

export class Engine {
  constructor(config={}, {mode="live",providerFactory,onSave=async()=>{}}={}) {
    const c=validate(config); if(mode!=="live") fail("Only live runs are supported.");
    this.onSave=onSave; this.stopped=false; this._requestQueue=Promise.resolve();
    const id=[...globalThis.crypto.getRandomValues(new Uint8Array(8))].map(x=>x.toString(16).padStart(2,"0")).join("");
    this.state={id,config:c,mode,status:"running",created_at:now(),error:null,progress:"Preparing titles",titles:[],nodes:[],outputs:[],generation_completed:false,final_review:{status:"pending",candidate_ids:[],decisions:[],summary:null},usage:{calls:0,input_tokens:0,output_tokens:0,reserved_output_tokens:0},events:[],requests:[],provenance:{synthetic:true,author_labels_are_prompt_cues:true,judge_scores_are_not_fact_checks:true,algorithm:"per-title beam; grace period; diversity penalty; seeded exploration browser v1",base_api:c.base_api,base_model:c.base_model,base_url:c.base_url,output_limit_mode:"request_reservation"}};
    this.provider=this.makeProvider(providerFactory);
    this.provider.preflight?.(c);
    this.state.provenance.critic_backend=this.provider.criticBackend || "openai";
    if(this.provider.criticModel) this.state.provenance.critic_model=this.provider.criticModel;
    this.ready=this.save();
  }
  makeProvider(factory) { const hook=this.request.bind(this); if(factory) return factory(hook); fail("Live mode requires a configured model provider."); }
  snapshot() { return clone(this.state); }
  stop() { this.stopped=true; }
  async save() { await this.onSave(this.snapshot()); }
  async event(message) { this.state.progress=message; this.state.events.push({time:now(),message}); await this.save(); }
  request(payload,role,send) { const result=this._requestQueue.then(()=>this._request(payload,role,send)); this._requestQueue=result.catch(()=>{}); return result; }
  async _request(payload,role,send) {
    if(this.stopped) throw new Stopped();
    const u=this.state.usage,c=this.state.config,allowance=payload.max_output_tokens ?? payload.max_tokens ?? 0;
    if(!Number.isInteger(allowance)||allowance<0) fail("Model requests require a valid output-token allowance.");
    if(u.calls>=c.max_calls||u.reserved_output_tokens+allowance>c.max_output_tokens) throw new BudgetExhausted("Request or reserved output-token budget reached. All generated branches were saved.");
    u.calls++; u.reserved_output_tokens+=allowance;
    const record={index:u.calls,role,time:now(),request:auditCopy(payload),status:"pending"}; this.state.requests.push(record); await this.save();
    let result; try { result=await send(); } catch(error) { record.status="failed"; await this.save(); throw error; }
    const usage=result?.usage||{}, input=usage.input_tokens ?? usage.prompt_tokens ?? 0, output=usage.output_tokens ?? usage.completion_tokens ?? 0;
    if(!Number.isFinite(input)||input<0||!Number.isFinite(output)||output<0) { record.status="failed"; await this.save(); fail("Model returned invalid token usage."); }
    u.input_tokens+=input; u.output_tokens+=output; u.reserved_output_tokens+=Math.max(0,output-allowance);
    Object.assign(record,{status:"completed",response:auditCopy(result)}); await this.save(); return result;
  }
  static forFinalReview(state,{providerFactory,onSave=async()=>{}}={}) {
    if(state.mode!=="live") fail("Archived demo runs are read-only. Start a live run to generate and review posts.");
    if(!(state.generation_completed||state.status==="completed")) fail("Finish generation before reviewing final drafts.");
    if(state.final_review?.status==="completed") fail("This run already has a completed final review.");
    const engine=Object.create(Engine.prototype); engine.onSave=onSave; engine.stopped=false; engine._requestQueue=Promise.resolve(); engine.state=clone(state); engine.state.config=validate(state.config);
    Object.assign(engine.state,{status:"running",error:null,generation_completed:true}); engine.state.final_review ??= {status:"pending",candidate_ids:[],decisions:[],summary:null}; engine.state.requests ??=[]; engine.state.provenance ??={};
    engine.provider=engine.makeProvider(providerFactory);
    engine.provider.preflightCritic?.();
    engine.state.provenance.final_critic_backend=engine.provider.criticBackend || "openai";
    if(engine.provider.criticModel) engine.state.provenance.final_critic_model=engine.provider.criticModel;
    engine.ready=engine.event("Preparing final review of saved drafts"); return engine;
  }
  async run({reviewOnly=false}={}) {
    try { await this.ready; if(!reviewOnly) { await this._run(); this.state.generation_completed=true; await this.save(); } await this._finalize(); this.state.status="completed"; await this.event("Experiment complete. Final review and best ideas are ready."); }
    catch(error) {
      if(error instanceof Stopped) { this.state.status="stopped"; await this.event("Stopped after the current request. Generated text is preserved."); }
      else if(error instanceof BudgetExhausted) { this.state.status="budget_exhausted"; await this.event(error.message); }
      else { this.state.status="failed"; this.state.error=error instanceof ValidationError||error?.name==="ProviderError" ? error.message : "Experiment failed; saved branches remain available."; await this.event(this.state.error); }
    } finally { const review=this.state.final_review; if(review.status!=="completed") { review.status=this.state.generation_completed ? (this.state.status==="failed" ? "failed" : "interrupted") : "skipped"; review.error=this.state.error||this.state.progress; } this._outputs(); await this.save(); }
    return this.snapshot();
  }
  _outputs() { const parents=new Set(this.state.nodes.map(n=>n.parent_id)); this.state.outputs=this.state.nodes.filter(n=>!parents.has(n.id)&&["active","finished"].includes(n.status)).map(n=>n.id); }
  async _finalize() {
    const c=this.state.config,s=this.state,review=s.final_review;
    if(review.status==="completed") return; if(this.stopped) throw new Stopped();
    if(!review.started_at) { this._outputs(); Object.assign(review,{candidate_ids:[...s.outputs],decisions:[],started_at:now()}); }
    Object.assign(review,{status:"reviewing",error:null}); s.provenance.final_review="whole drafts; allow all rejected; summary from reviewed idea notes";
    const titles=new Map(s.titles.map(t=>[t.id,t])), nodes=new Map(s.nodes.map(n=>[n.id,n])), reviewed=new Set(review.decisions.map(d=>d.id));
    const posts=review.candidate_ids.filter(id=>!reviewed.has(id)).map(id=>({id,title:titles.get(nodes.get(id).title_id).title,lens:titles.get(nodes.get(id).title_id).lens,text:pathText(s.nodes,id)}));
    await this.event(`Final review · ${review.candidate_ids.length} fully assembled drafts`);
    for(const group of reviewBatches(posts,FINAL_REVIEW_BATCH_SIZE)) {
      const decisions=await this.provider.final_review(c,group), ids=new Set(group.map(p=>p.id));
      if(!Array.isArray(decisions)||decisions.length!==group.length||new Set(decisions.map(d=>d.id)).size!==group.length||decisions.some(d=>!ids.has(d.id)||typeof d.keep!=="boolean")) fail("Final-review decisions did not match the supplied drafts.");
      review.decisions.push(...decisions); await this.event(`Final review · ${review.decisions.length}/${review.candidate_ids.length} drafts assessed`);
    }
    for(const decision of review.decisions) { const node=nodes.get(decision.id); node.final_review=clone(decision); if(!decision.keep) node.status="final_pruned"; }
    this._outputs(); review.status="summarizing"; await this.event(`Summarizing best ideas · ${s.outputs.length} drafts retained`);
    let notes=review.decisions.filter(d=>d.keep).map(d=>({title:titles.get(nodes.get(d.id).title_id).title,idea:d.idea,reason:d.reason,caveats:d.caveats,source_ids:[d.id]})), completed=false;
    for(let level=0;level<8;level++) {
      if(this.stopped) throw new Stopped(); const groups=reviewBatches(notes,SUMMARY_BATCH_SIZE);
      if(groups.length<=1) { review.summary=await this.provider.summarize(c,notes); completed=true; break; }
      const combined=[];
      for(const group of groups) { if(this.stopped) throw new Stopped(); const key=await inputHash(group), cached=(review.summary_passes||[]).find(p=>p.input_hash===key); let summary;
        if(cached) summary=cached.result; else { summary=await this.provider.summarize(c,group); (review.summary_passes ??=[]).push({level,input_hash:key,result:clone(summary)}); }
        combined.push(...summary.ideas); await this.save();
      }
      if(combined.length>=notes.length&&JSON.stringify(combined).length>=JSON.stringify(notes).length) fail("Idea synthesis did not reduce the input. Reviewed drafts are saved; retry the final review."); notes=combined;
    }
    if(!completed) fail("Idea synthesis exceeded its reduction limit; reviewed drafts are saved.");
    Object.assign(review,{status:"completed",completed_at:now(),error:null}); await this.save();
  }
  async _run() {
    const c=this.state.config,s=this.state,requested=assignments(c);
    for(let start=0;start<requested.length;start+=20) {
      const group=requested.slice(start,start+20),batch=await this.provider.titles({...c,_previous_titles:s.titles.map(t=>t.title)},group);
      if(!Array.isArray(batch)||batch.length!==group.length) fail("Critic returned the wrong number of titles.");
      for(let i=0;i<batch.length;i++) { const item=batch[i]; if(typeof item.title!=="string"||!item.title.trim()) fail("Critic returned an empty title."); if(s.titles.some(t=>t.title.trim().toLowerCase()===item.title.trim().toLowerCase())) fail("Critic repeated a title from an earlier batch; partial results were saved."); s.titles.push({...item,...requested[start+i],id:`title-${start+i+1}`}); }
      await this.event(`Generated ${s.titles.length} of ${requested.length} titles`);
    }
    const frontiers=Object.fromEntries(s.titles.map(t=>[t.id,[null]]));
    for(let depth=1;depth<=c.depth;depth++) for(let titleIndex=0;titleIndex<s.titles.length;titleIndex++) {
      if(this.stopped) throw new Stopped(); const title=s.titles[titleIndex],parents=frontiers[title.id]; if(!parents.length) continue;
      await this.event(`Round ${depth}/${c.depth} · ${title.title}`); const children=[];
      for(const parent of parents) { const prefix=parent ? pathText(s.nodes,parent.id) : "";
        for(let branch=0;branch<c.branch_factor;branch++) {
          const number=s.nodes.length,temperature=c.temperatures[(branch+depth-1+titleIndex)%c.temperatures.length],seed=(c.seed+number*7919)%2147483647;
          const result=await this.provider.continue_post(c,title,prefix,temperature,seed); if(typeof result.text!=="string"||!result.text.trim()) fail("The continuation endpoint returned empty text.");
          const node={id:`node-${number+1}`,title_id:title.id,parent_id:parent?.id??null,depth,text:result.text,temperature,seed,finish_reason:result.finish_reason??"length",status:"active",selection_reason:"Awaiting evaluation",evaluation:null,request_index:s.usage.calls,adapter:result.adapter??c.base_api,response_shape:result.response_shape??null,experimental_mode:result.experimental_mode??null};
          children.push(node); s.nodes.push(node); this._outputs(); await this.save();
        }
        if(parent) parent.status="expanded";
      }
      for(let offset=0;offset<children.length;offset+=12) { const group=children.slice(offset,offset+12),ratings=await this.provider.evaluate(c,title,group.map(n=>({id:n.id,text:pathText(s.nodes,n.id)}))), mapped=new Map(ratings.map(e=>[e.id,e]));
        if(ratings.length!==group.length||mapped.size!==group.length||group.some(n=>!mapped.has(n.id))) fail("Critic evaluation IDs did not match the candidate branches.");
        for(const node of group) { const {id,...evaluation}=mapped.get(node.id); node.evaluation=evaluation; } await this.save();
      }
      const survivors=select(children,c,depth,titleIndex); frontiers[title.id]=[];
      for(const child of children) if(!Object.hasOwn(survivors,child.id)) { child.status="pruned"; child.selection_reason="Outside this title's beam after selection; archived without deletion."; } else { child.selection_reason=survivors[child.id]; if(child.finish_reason==="stop") child.status="finished"; else frontiers[title.id].push(child); }
      this._outputs(); await this.save();
    }
  }
}

export function exportMarkdown(state) {
  const lines=["# NZT-49: synthetic macrostrategy drafts","",state.config.concept,"",`Mode: ${state.mode} · Run: ${state.id} · Status: ${state.status}`,"","These are synthetic speculative drafts. Author names are generation cues, not attribution or endorsement. Claims and citations require independent checking.",""];
  if(state.mode==="demo") lines.push("**OFFLINE DEMO: canned passages and illustrative scores; no models were called.**","");
  else if(state.provenance?.output_limit_mode==="advisory_for_codex") lines.push("Codex critic output allowances are advisory, so a completed call can exceed its reserved amount. Reported excess counts against the run budget before the next request.","");
  const review=state.final_review||{}; lines.push("## Best ideas","");
  if(review.status==="completed") { lines.push(review.summary.overview,""); review.summary.ideas.forEach((idea,i)=>{ lines.push(`### ${i+1}. ${idea.title}`,"",idea.summary,"",idea.why_it_matters,"",`Source paths: ${idea.source_ids.join(", ")}`,""); if(idea.caveats.length) lines.push(`Caveats: ${idea.caveats.join("; ")}`,""); }); }
  else { lines.push("Final review is not complete; these drafts have not passed final pruning.",""); if(review.error) lines.push(review.error,""); }
  if(review.decisions?.length) { lines.push("## Final review decisions",""); lines.push(...review.decisions.map(d=>`- ${d.id} — ${d.keep?"Keep":"Prune"}: ${d.reason}`),""); }
  lines.push("## Configuration","","```json",JSON.stringify(state.config,null,2),"```","");
  const titles=new Map(state.titles.map(t=>[t.id,t])),nodes=new Map(state.nodes.map(n=>[n.id,n]));
  for(const id of state.outputs) { const n=nodes.get(id),t=titles.get(n.title_id); lines.push(`## ${t.title}`,"",`Author cue: ${t.author} · Venue cue: ${t.venue} · Path: ${id}`,"",n.finish_reason==="stop"?"Endpoint reported an end of generation; editorial completeness is unverified.":"Partial draft: continuation reached the experiment's depth or budget limit.","",pathText(state.nodes,id),"","### Critic assessment","",JSON.stringify(n.evaluation,null,2),""); }
  lines.push("Full ancestry, discarded branches, requests, model responses, and selection reasons are retained in the JSON export."); return lines.join("\n");
}
