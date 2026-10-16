export const AUTHORS = ["Wei Dai", "Vladimir Nesov", "Vitalik Buterin", "Vanessa Kosoy", "Eliezer Yudkowsky", "Robin Hanson", "Cleo Nardo", "Buck Shlegeris", "Ryan Greenblatt", "Gwern"];
export const FINAL_REVIEW_BATCH_SIZE = 6;
export const SUMMARY_BATCH_SIZE = 40;
export const FINAL_INPUT_CHARS = 120000;
export const DEFAULTS = {
  concept: "Super scalable spending opportunities: ways to spend huge amounts of capital (at least billions) to do good, e.g. acquiring compute or buying galaxies.",
  authors: AUTHORS, title_count: 2, title_mode: "total", branch_factor: 2, beam_width: 2,
  depth: 3, grace_depth: 2, chunk_tokens: 320, temperatures: [0.9, 1.1, 1.3],
  exploration_fraction: 0.25, seed: 42, max_calls: 250, max_output_tokens: 220000,
  selection_mode: "guided", base_url: "https://openrouter.ai/api/v1",
  base_model: "nvidia/nemotron-3.5-lightning:free", base_api: "openrouter", base_reasoning: "off",
};

export class ValidationError extends Error { constructor(message) { super(message); this.name = "ValidationError"; } }
function fail(message) { throw new ValidationError(message); }
export function validate(data = {}) {
  if (!data || typeof data !== "object" || Array.isArray(data)) fail("Configuration must be an object.");
  const unknown = Object.keys(data).filter(key => !Object.hasOwn(DEFAULTS, key));
  if (unknown.length) fail(`Unknown configuration fields: ${unknown.sort().join(", ")}`);
  const c = structuredClone({...DEFAULTS, ...data});
  if (typeof c.concept !== "string" || !c.concept.trim() || c.concept.trim().length > 12000) fail("Concept must contain 1–12000 characters.");
  c.concept = c.concept.trim();
  if (!Array.isArray(c.authors) || c.authors.length < 1 || c.authors.length > 50) fail("Choose between 1 and 50 authors.");
  if (c.authors.some(a => typeof a !== "string" || !a.trim() || a.length > 120)) fail("Author names must contain 1–120 characters.");
  c.authors = [...new Set(c.authors.map(a => a.trim()))];
  const limits = {title_count: [1,200], branch_factor: [1,8], beam_width: [1,8], depth: [1,12], grace_depth: [1,3], chunk_tokens: [64,4096], seed: [0,2147483647], max_calls: [1,10000], max_output_tokens: [64,20000000]};
  for (const [key,[lo,hi]] of Object.entries(limits)) if (!Number.isInteger(c[key]) || c[key] < lo || c[key] > hi) fail(`${key} must be an integer between ${lo} and ${hi}.`);
  for (const [key,values] of Object.entries({title_mode: ["total","per_author"], selection_mode: ["guided","random"], base_api: ["openrouter","completions","chat"], base_reasoning: ["default","off"]})) if (!values.includes(c[key])) fail(`Invalid ${key}.`);
  if (!Array.isArray(c.temperatures) || c.temperatures.length < 1 || c.temperatures.length > 20) fail("Supply 1–20 temperatures.");
  if (c.temperatures.some(t => typeof t !== "number" || !Number.isFinite(t) || t < 0 || t > 2)) fail("Temperatures must be finite numbers between 0 and 2.");
  if (typeof c.exploration_fraction !== "number" || !Number.isFinite(c.exploration_fraction) || c.exploration_fraction < 0 || c.exploration_fraction > 1) fail("Exploration fraction must be between 0 and 1.");
  if (typeof c.base_model !== "string" || c.base_model.length > 200) fail("Model ID must be at most 200 characters.");
  if (typeof c.base_url !== "string" || /\s/.test(c.base_url)) fail("Endpoint must be a URL without whitespace.");
  let u; try { u = new URL(c.base_url); } catch { fail("Endpoint must be an HTTP(S) URL without credentials, query, or fragment."); }
  if (!["http:","https:"].includes(u.protocol) || !u.hostname || u.username || u.password || u.search || u.hash) fail("Endpoint must be an HTTP(S) URL without credentials, query, or fragment.");
  if (u.protocol === "http:" && !["localhost","127.0.0.1","[::1]"].includes(u.hostname)) fail("Remote model endpoints require HTTPS; HTTP is supported for local servers.");
  if (titleTotal(c) > 200) fail("An experiment supports at most 200 titles total.");
  return c;
}
export const titleTotal = c => c.title_count * (c.title_mode === "per_author" ? c.authors.length : 1);
export const assignments = c => Array.from({length: titleTotal(c)}, (_, i) => ({author: c.authors[i % c.authors.length], venue: i % 2 ? "personal blog" : "LessWrong"}));
export function estimate(c) {
  let active = 1, generated = 0, judgeCalls = 0, finalCandidates = 0;
  for (let depth = 1; depth <= c.depth; depth++) { const count = active * c.branch_factor; generated += count; judgeCalls += Math.ceil(count / 12); active = depth < c.grace_depth ? count : Math.min(count, c.beam_width); finalCandidates += active; }
  const total = titleTotal(c), titleCalls = Math.ceil(total / 20), reviewCalls = Math.ceil(finalCandidates * total / FINAL_REVIEW_BATCH_SIZE);
  let notes = finalCandidates * total, summaryCalls = 0;
  while (notes > SUMMARY_BATCH_SIZE) { const batches = Math.ceil(notes / SUMMARY_BATCH_SIZE); summaryCalls += batches; notes = batches * 8; }
  const finalCalls = reviewCalls + summaryCalls + 1, criticCalls = titleCalls + judgeCalls * total + finalCalls, baseCalls = generated * total;
  return {title_total: total, completion_calls: baseCalls, critic_calls: criticCalls, final_review_calls: finalCalls, max_calls: baseCalls + criticCalls, max_output_tokens: baseCalls * c.chunk_tokens + (titleCalls + finalCalls) * 8192 + judgeCalls * total * 4096, note: "Includes final review and idea synthesis. Long drafts may need extra review batches. This is not a dollar or input-token cap."};
}
