import test from "node:test";
import assert from "node:assert/strict";
import {handleRequest,parseAllowedOrigins,DEFAULT_ALLOWED_ORIGINS,TINKER_COMPLETIONS_URL} from "../relay/handler.js";
import worker from "../relay/worker.js";

const origin="https://nzt-49.lukemarks.bot";
const key="tinker-private-fixture-key";
const payload={model:"Qwen/Qwen3.5-9B-Base",prompt:" exact prefix \n",max_tokens:320,temperature:1.3,top_p:1};
function request({body=payload,path="/completions",method="POST",headers={}}={}) {
  return new Request(`https://relay.example${path}`,{method,headers:{Origin:origin,"Content-Type":"application/json",Authorization:`Bearer ${key}`,...headers},...(["GET","HEAD"].includes(method)?{}:{body:typeof body==="string"?body:JSON.stringify(body)})});
}
function completion(text=" continuation") { return new Response(JSON.stringify({id:"fixture",choices:[{text,finish_reason:"length"}],usage:{prompt_tokens:10,completion_tokens:3}}),{status:200,headers:{"Content-Type":"application/json"}}); }
function preflight(requestOrigin=origin,headers="authorization,content-type") { return new Request("https://relay.example/completions",{method:"OPTIONS",headers:{Origin:requestOrigin,"Access-Control-Request-Method":"POST","Access-Control-Request-Headers":headers}}); }

test("relay forwards caller key and exact payload only to fixed Tinker HTTPS target",async()=>{
  let received; const response=await handleRequest(request(),{fetchImpl:async(url,options)=>{received={url,options};return completion();}});
  assert.equal(response.status,200); assert.equal(received.url,TINKER_COMPLETIONS_URL); assert.equal(received.options.headers.Authorization,`Bearer ${key}`); assert.deepEqual(JSON.parse(received.options.body),payload);
  assert.equal(received.options.redirect,"error"); assert.equal(received.options.credentials,"omit"); assert.equal(received.options.referrerPolicy,"no-referrer");
  assert.deepEqual(Object.keys(received.options.headers).sort(),["Authorization","Content-Type"]); assert.equal(response.headers.get("access-control-allow-origin"),origin); assert.equal(response.headers.get("cache-control"),"no-store"); assert.equal(response.headers.get("access-control-allow-credentials"),null); assert.doesNotMatch(await response.text(),new RegExp(key));
});
test("CORS preflight accepts only configured exact origins and declared headers",async()=>{
  for(const allowed of DEFAULT_ALLOWED_ORIGINS) { const response=await handleRequest(preflight(allowed)); assert.equal(response.status,204); assert.equal(response.headers.get("access-control-allow-origin"),allowed); assert.match(response.headers.get("access-control-allow-headers"),/Authorization/); assert.match(response.headers.get("vary"),/Origin/); }
  const custom=await handleRequest(preflight("https://preview.example"),{allowedOrigins:["https://preview.example"]}); assert.equal(custom.status,204);
  for(const disallowed of ["https://evil.example","https://nzt-49.lukemarks.bot.evil.example","http://localhost:9999","null"]) { const response=await handleRequest(preflight(disallowed)); assert.equal(response.status,403); assert.equal(response.headers.get("access-control-allow-origin"),null); }
  const badHeaders=await handleRequest(preflight(origin,"authorization,x-target-url")); assert.equal(badHeaders.status,400);
});
test("foreign or missing Origin cannot send credentials upstream",async()=>{
  let sent=0; const options={fetchImpl:async()=>{sent++;return completion();}};
  for(const supplied of ["https://evil.example",""]) { const response=await handleRequest(request({headers:{Origin:supplied}}),options); assert.equal(response.status,403); }
  assert.equal(sent,0);
});
test("health is stateless and never contacts Tinker",async()=>{
  const response=await handleRequest(new Request("https://relay.example/health"),{fetchImpl:async()=>{throw new Error("must not call");}}); assert.equal(response.status,200); assert.deepEqual(await response.json(),{ok:true,service:"nzt-49-tinker-relay"});
  const denied=await handleRequest(request({path:"/health",method:"GET",headers:{Origin:"https://evil.example"}})); assert.equal(denied.status,403);
});
test("worker entry applies configured origin list",async()=>{
  const accepted=await worker.fetch(preflight("https://custom.example"),{ALLOWED_ORIGINS:"https://custom.example"}); assert.equal(accepted.status,204);
  const rejected=await worker.fetch(preflight(),{ALLOWED_ORIGINS:"https://custom.example"}); assert.equal(rejected.status,403);
  assert.throws(()=>parseAllowedOrigins("*")); assert.throws(()=>parseAllowedOrigins("http://remote.example")); assert.throws(()=>parseAllowedOrigins("https://custom.example/path"));
});
test("route, content type and authorization errors are safe and make no model call",async()=>{
  let sent=0; const options={fetchImpl:async()=>{sent++;return completion();}};
  for(const [input,status] of [[{path:"/proxy?url=https://evil.example"},404],[{path:"/completions?url=https://evil.example"},404],[{method:"GET"},405],[{headers:{"Content-Type":"text/plain"}},415],[{headers:{Authorization:""}},401],[{headers:{Authorization:"Basic private"}},401],[{headers:{Authorization:"Bearer contains whitespace"}},401]]) {
    const response=await handleRequest(request(input),options); assert.equal(response.status,status); assert.doesNotMatch(await response.text(),/private-fixture|contains whitespace/);
  }
  assert.equal(sent,0);
});
test("strict payload validation rejects unknown destinations and invalid sampling fields",async()=>{
  let sent=0; const options={fetchImpl:async()=>{sent++;return completion();}};
  for(const body of [null,[],{...payload,url:"https://evil.example"},{...payload,headers:{Authorization:"bad"}},{...payload,n:1},{...payload,model:""},{...payload,model:"has space"},{...payload,prompt:[]},{...payload,max_tokens:0},{...payload,max_tokens:32769},{...payload,max_tokens:1.5},{...payload,temperature:-1},{...payload,temperature:2.1},{...payload,temperature:true},{...payload,top_p:0},{...payload,top_p:1.1},{...payload,top_p:null}]) {
    const response=await handleRequest(request({body}),options); assert.equal(response.status,400); assert.equal((await response.json()).error.code,"invalid_payload");
  }
  assert.equal(sent,0);
});
test("malformed JSON and both declared and streamed request size limits are enforced",async()=>{
  let sent=0; const options={maxRequestBytes:200,fetchImpl:async()=>{sent++;return completion();}};
  const malformed=await handleRequest(request({body:"{ broken private-value"}),options); assert.equal(malformed.status,400); assert.doesNotMatch(await malformed.text(),/private-value/);
  const declared=await handleRequest(request({headers:{"Content-Length":"201"}}),options); assert.equal(declared.status,413);
  const actual=await handleRequest(request({body:{...payload,prompt:"x".repeat(300)}}),options); assert.equal(actual.status,413); assert.equal(sent,0);
});
test("upstream redirects are rejected without forwarding caller credentials elsewhere",async()=>{
  const calls=[]; const response=await handleRequest(request(),{fetchImpl:async(url,options)=>{calls.push({url,options}); return new Response("private upstream redirect",{status:302,headers:{Location:"https://evil.example"}});}});
  assert.equal(calls.length,1); assert.equal(calls[0].url,TINKER_COMPLETIONS_URL); assert.equal(calls[0].options.redirect,"error"); assert.equal(response.status,502); assert.equal(response.headers.get("location"),null); assert.doesNotMatch(await response.text(),/evil|private upstream/);
});
test("upstream rate and authentication failures preserve safe codes without raw bodies",async()=>{
  for(const [status,code] of [[429,"upstream_rate_limited"],[401,"upstream_authentication"],[403,"upstream_authentication"],[400,"upstream_rejected"],[404,"upstream_rejected"],[422,"upstream_rejected"],[503,"upstream_error"]]) {
    const response=await handleRequest(request(),{fetchImpl:async()=>new Response(`${key} private upstream diagnostic`,{status,headers:{"Set-Cookie":"private=value"}})});
    assert.equal(response.status,status===503?502:status); const body=await response.json(); assert.equal(body.error.code,code); assert.doesNotMatch(JSON.stringify(body),/private|fixture/); assert.equal(response.headers.get("set-cookie"),null); assert.equal(response.headers.get("access-control-allow-origin"),origin);
  }
});
test("successful responses cannot echo the credential in content or metadata",async()=>{
  const response=await handleRequest(request(),{fetchImpl:async()=>new Response(JSON.stringify({choices:[{text:`echo ${key}`,finish_reason:"stop"}],headers:{Authorization:`Bearer ${key}`},api_key:key,nested:{[key]:"value"}}),{status:200})});
  const raw=await response.text(); assert.equal(response.status,200); assert.doesNotMatch(raw,new RegExp(key)); const body=JSON.parse(raw); assert.equal(body.headers,undefined); assert.equal(body.api_key,undefined); assert.match(body.choices[0].text,/credential redacted/);
});
test("escaped credential echoes are removed after JSON decoding",async()=>{
  const specialKey='fixture"key\\with-escapes'; const response=await handleRequest(request({headers:{Authorization:`Bearer ${specialKey}`}}),{fetchImpl:async()=>completion(specialKey)}); const body=await response.json(); assert.equal(response.status,200); assert.equal(body.choices[0].text,"[credential redacted]");
});
test("invalid, oversized and excessively nested upstream responses are rejected",async()=>{
  for(const upstream of [new Response("not json"),new Response("[]"),new Response(JSON.stringify({error:{message:key}}))]) { const response=await handleRequest(request(),{fetchImpl:async()=>upstream}); assert.equal(response.status,502); assert.doesNotMatch(await response.text(),new RegExp(key)); }
  const oversized=await handleRequest(request(),{maxResponseBytes:200,fetchImpl:async()=>completion("x".repeat(300))}); assert.equal((await oversized.json()).error.code,"response_too_large");
  const declared=await handleRequest(request(),{maxResponseBytes:200,fetchImpl:async()=>new Response("{}",{headers:{"Content-Length":"201"}})}); assert.equal((await declared.json()).error.code,"response_too_large");
  let nested={}; for(let i=0;i<45;i++) nested={nested}; const deep=await handleRequest(request(),{fetchImpl:async()=>new Response(JSON.stringify(nested))}); assert.equal(deep.status,502);
});
test("timeouts abort the upstream request and never retry",async()=>{
  let calls=0,aborted=false; const response=await handleRequest(request(),{timeoutMs:5,fetchImpl:async(url,{signal})=>{calls++;return new Promise((resolve,reject)=>signal.addEventListener("abort",()=>{aborted=true;reject(new Error("private abort detail"));},{once:true}));}});
  assert.equal(response.status,504); const body=await response.json(); assert.equal(body.error.code,"upstream_timeout"); assert.match(body.error.message,/may still finish/); assert.doesNotMatch(JSON.stringify(body),/private/); assert.equal(calls,1); assert.equal(aborted,true);
});
test("network failures do not expose arbitrary exception details",async()=>{
  const response=await handleRequest(request(),{fetchImpl:async()=>{throw new Error(`${key} private network diagnostics`);}}); assert.equal(response.status,502); assert.equal((await response.json()).error.code,"upstream_unavailable");
});
