// Stateless transport: credentials arrive with each request and are never saved.
export const TINKER_COMPLETIONS_URL = "https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1/completions";
export const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
  "https://nzt-49.lukemarks.bot", "https://luke-marks0.github.io",
  "http://127.0.0.1:8765", "http://localhost:8765",
  "http://127.0.0.1:8766", "http://localhost:8766",
]);
export const MAX_REQUEST_BYTES = 1024 * 1024;
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
class BodyTooLarge extends Error {}

export function parseAllowedOrigins(value) {
  const origins = value === undefined || value === null || value === "" ? [...DEFAULT_ALLOWED_ORIGINS] : Array.isArray(value) ? value : String(value).split(",").map(x => x.trim()).filter(Boolean);
  if (!origins.length || origins.some(origin => {
    if (typeof origin !== "string") return true;
    try { const url = new URL(origin); return origin !== url.origin || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1","localhost","[::1]"].includes(url.hostname))); }
    catch { return true; }
  })) throw new Error("Relay origins must be explicit HTTPS origins or local development origins.");
  return [...new Set(origins)];
}

async function readBounded(message, maxBytes) {
  const length = Number(message.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) { await message.body?.cancel(); throw new BodyTooLarge(); }
  if (!message.body) return "";
  const reader = message.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) { const {done,value} = await reader.read(); if (done) break; size += value.byteLength; if (size > maxBytes) { await reader.cancel(); throw new BodyTooLarge(); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function validPayload(value) {
  if (!object(value) || Object.keys(value).some(key => !["model","prompt","max_tokens","temperature","top_p"].includes(key))) return false;
  if (typeof value.model !== "string" || !/^[\x21-\x7e]{1,512}$/.test(value.model)) return false;
  if (typeof value.prompt !== "string" || value.prompt.length > MAX_REQUEST_BYTES) return false;
  if (!Number.isInteger(value.max_tokens) || value.max_tokens < 1 || value.max_tokens > 32768) return false;
  if (Object.hasOwn(value,"temperature") && (typeof value.temperature !== "number" || !Number.isFinite(value.temperature) || value.temperature < 0 || value.temperature > 2)) return false;
  if (Object.hasOwn(value,"top_p") && (typeof value.top_p !== "number" || !Number.isFinite(value.top_p) || value.top_p <= 0 || value.top_p > 1)) return false;
  return true;
}

function scrub(value,key,depth=0) {
  if (depth > 40) throw new Error("Nested response");
  if (typeof value === "string") return value.split(key).join("[credential redacted]");
  if (Array.isArray(value)) return value.map(item => scrub(item,key,depth+1));
  if (object(value)) {
    const result = Object.create(null);
    for (const [name,item] of Object.entries(value)) {
      if (/authorization|api[_-]?key|access[_-]?token|auth[_-]?token|secret|^headers?$|^credentials$|^password$|^key$/i.test(name) || ["__proto__","constructor","prototype"].includes(name)) continue;
      result[name.split(key).join("[credential redacted]")] = scrub(item,key,depth+1);
    }
    return result;
  }
  return value;
}

export async function handleRequest(request, {
  allowedOrigins = DEFAULT_ALLOWED_ORIGINS, fetchImpl = globalThis.fetch,
  timeoutMs = 180000, maxRequestBytes = MAX_REQUEST_BYTES, maxResponseBytes = MAX_RESPONSE_BYTES,
} = {}) {
  const origin = request.headers.get("origin");
  let allowed;
  try { allowed = new Set(parseAllowedOrigins(allowedOrigins)); } catch { return new Response(JSON.stringify({error:{code:"relay_configuration",message:"The relay origin configuration is invalid."}}),{status:500,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}}); }
  const cors = {"Vary":"Origin", "Cache-Control":"no-store", "X-Content-Type-Options":"nosniff"};
  if (allowed.has(origin)) cors["Access-Control-Allow-Origin"] = origin;
  const reply = (status,body,extra={}) => new Response(body === null ? null : JSON.stringify(body),{status,headers:{...cors,...(body===null?{}:{"Content-Type":"application/json; charset=utf-8"}),...extra}});
  const error = (status,code,message) => reply(status,{error:{code,message}});
  let url; try { url = new URL(request.url); } catch { return error(400,"invalid_request","Invalid relay request."); }
  if (url.pathname === "/health" && request.method === "GET" && !url.search) {
    if (origin && !allowed.has(origin)) return error(403,"origin_denied","This origin is not allowed to use the relay.");
    return reply(200,{ok:true,service:"nzt-49-tinker-relay"});
  }
  if (url.pathname !== "/completions" || url.search) return error(404,"not_found","Unknown relay route.");
  if (!allowed.has(origin)) return error(403,"origin_denied","This origin is not allowed to use the relay.");
  if (request.method === "OPTIONS") {
    const method = request.headers.get("access-control-request-method");
    const headers = (request.headers.get("access-control-request-headers")||"").toLowerCase().split(",").map(x=>x.trim()).filter(Boolean);
    if (method !== "POST" || headers.some(name=>!["authorization","content-type"].includes(name))) return error(400,"invalid_preflight","The relay accepts POST with Authorization and Content-Type headers.");
    return reply(204,null,{"Access-Control-Allow-Methods":"POST, OPTIONS","Access-Control-Allow-Headers":"Authorization, Content-Type","Access-Control-Max-Age":"600"});
  }
  if (request.method !== "POST") return reply(405,{error:{code:"method_not_allowed",message:"Use POST for completions."}},{"Allow":"POST, OPTIONS"});
  if ((request.headers.get("content-type")||"").split(";")[0].trim().toLowerCase() !== "application/json") return error(415,"unsupported_media_type","Use application/json.");
  const authorization = request.headers.get("authorization") || "";
  const match = /^Bearer ([\x21-\x7e]{1,512})$/i.exec(authorization);
  if (!match) return error(401,"missing_credentials","Supply a Tinker API key in the Authorization header.");
  const key = match[1]; let payload;
  try { payload = JSON.parse(await readBounded(request,maxRequestBytes)); }
  catch (failure) { return failure instanceof BodyTooLarge ? error(413,"request_too_large","The completion request exceeds the relay size limit.") : error(400,"invalid_json","The completion request must contain valid JSON."); }
  if (!validPayload(payload)) return error(400,"invalid_payload","Supply model, prompt, and max_tokens (1–32768), with optional temperature (0–2) and top_p (greater than 0 and at most 1). No other fields are accepted.");
  const controller = new AbortController(); let timedOut = false;
  const timer = setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);
  try {
    const upstream = await fetchImpl(TINKER_COMPLETIONS_URL,{
      method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+key},
      body:JSON.stringify(payload),redirect:"error",credentials:"omit",referrerPolicy:"no-referrer",signal:controller.signal,
    });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      if (upstream.status === 429) return error(429,"upstream_rate_limited","Tinker rate limited this request. Check your account limits before retrying.");
      if ([401,403].includes(upstream.status)) return error(upstream.status,"upstream_authentication","Tinker rejected the supplied key or model permissions.");
      if ([400,404,422].includes(upstream.status)) return error(upstream.status,"upstream_rejected","Tinker rejected the model or completion settings. Check the model ID and account access.");
      return error(502,"upstream_error","Tinker could not complete the request.");
    }
    let result;
    try { result = JSON.parse(await readBounded(upstream,maxResponseBytes)); }
    catch (failure) { if (timedOut) throw failure; return failure instanceof BodyTooLarge ? error(502,"response_too_large","The Tinker response exceeded the relay size limit.") : error(502,"invalid_upstream_response","Tinker returned an invalid completion response."); }
    if (!object(result) || result.error) return error(502,"upstream_error","Tinker could not complete the request.");
    const cleaned = scrub(result,key);
    if (encoder.encode(JSON.stringify(cleaned)).byteLength > maxResponseBytes) return error(502,"response_too_large","The Tinker response exceeded the relay size limit.");
    return reply(200,cleaned);
  } catch {
    return timedOut ? error(504,"upstream_timeout","The Tinker request timed out. It may still finish upstream; check usage before retrying.") : error(502,"upstream_unavailable","The relay could not reach Tinker. Saved drafts remain in your browser.");
  } finally { clearTimeout(timer); }
}
