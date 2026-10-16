import {seededRandom} from "../../docs/random.js";

// Canned fixtures only: no model calls or historical user data.
export const MECHANISMS = [
  ["Buying Time on the Compute Frontier", "compute capacity", "Purchase compute and power contracts that remain useful under several AI timelines.", "The bottleneck may be safe deployment rather than FLOPs. Additional capacity can accelerate actors with conflicting objectives."],
  ["A Market for Civilizational Backup Plans", "resilience", "Prepay for independent food, energy, and knowledge reserves with audited release conditions.", "Correlated governance failures could invalidate supposedly independent backups."],
  ["Buying Galaxies Requires a Theory of Ownership", "cosmic option value", "Fund the engineering and institutions needed to preserve future choices about reachable resources.", "A legal claim on remote matter is not control over it. Physical feasibility, travel time, and legitimacy dominate the valuation."],
  ["The Billion-Dollar Bottleneck Auction", "information markets", "Use staged procurement to discover which scarce inputs actually constrain beneficial projects.", "Bidders can manufacture apparent bottlenecks. Payment must depend on verified downstream capacity."],
  ["Spend on the Ability to Change Your Mind", "option preservation", "Acquire reversible infrastructure and conditional contracts rather than locking in a single forecast.", "Optionality is valuable only if someone can exercise it before the relevant window closes."],
  ["The Counterfactual Cost of Buying Everything", "general equilibrium", "Estimate how a trillion-dollar buyer changes prices, substitution, and other actors' behavior.", "The first billion's apparent return may disappear as suppliers extract rents or competitors respond."],
  ["An Endowment for Unfashionable Futures", "pluralistic governance", "Reserve independent funding streams for mutually incompatible but plausible long-term futures.", "Independence can become insulation from evidence unless allocations face periodic adversarial review."],
  ["Industrial Capacity as a Public Option", "industrial infrastructure", "Build power, transmission, and manufacturing capacity with enforceable public-benefit access rules.", "Construction times and local constraints can make nominal capital budgets unspendable."],
  ["What Would Count as Enough Evidence to Spend a Trillion?", "measurement", "Buy experiments that can change the next large allocation decision before buying its final deployment.", "Easy-to-measure proxies can crowd out the harder outcomes the experiment was meant to improve."],
  ["The Last Dollar and the Next Civilization", "intergenerational allocation", "Compare present interventions with resources held for future agents under explicit discount and survival assumptions.", "Patient capital can disappear through institutional drift long before its intended beneficiaries arrive."],
];
export class FixtureProvider {
  constructor(requestHook) { this.request = requestHook; }
  async call(data, role, cap) { return (await this.request({demo_fixture: true, max_tokens: cap}, role, async () => ({data, usage: {input_tokens: 0, output_tokens: 0}}))).data; }
  async titles(config, requested) { return this.call(requested.map((assignment, batchIndex) => { const i = (config._previous_titles || []).length + batchIndex; const [title,lens] = MECHANISMS[i % MECHANISMS.length]; return {...assignment, title: title + (i >= 10 ? ` · variation ${Math.floor(i/10)+1}` : ""), lens}; }), "critic", 8192); }
  async continue_post(config, title, prefix, temperature, seed) {
    const index = Number(title.id.split("-").at(-1)) - 1, [,lens,mechanism,caveat] = MECHANISMS[index % MECHANISMS.length];
    const alternatives = [
      `The opportunity is ${lens}. ${mechanism} A useful first question is which commitment could absorb billions without merely raising the price of a fixed resource.`,
      `Consider a staged purchase: a small tranche identifies a bottleneck, a larger tranche pays for its removal, and later tranches depend on observed capacity. ${caveat}`,
      `The interesting quantity is marginal social value after other actors respond. ${caveat} A serious proposal needs a counterfactual buyer, a deployment timetable, and a failure condition.`,
      "An enormous budget does not itself create an enormous opportunity. We should distinguish what can be purchased today from speculative future capacity, and separate beneficial outcomes from nominal ownership.",
      "There is also a less settled possibility: pay for institutions whose purpose is to preserve disagreement about future spending. The open question is whether this creates valuable options or only durable bureaucracy.",
    ];
    const text = (prefix ? "\n\n" : "") + alternatives[Math.floor(seededRandom(seed)() * alternatives.length)] + "\n\n[Offline fixture: this passage and its scores are illustrative, not model output.]";
    return this.call({text, finish_reason: "length", adapter: "demo", experimental_mode: "fixture"}, "base", config.chunk_tokens);
  }
  async evaluate(config, title, candidates) { return this.call(candidates.map(c => { const rng = seededRandom(config.seed + [...c.id].reduce((a,x) => a+x.codePointAt(0),0)); return {id:c.id, novelty:Math.round((.3+rng()*.65)*100)/100, usefulness:Math.round((.3+rng()*.65)*100)/100, coherence:.8, confidence:.5, idea:c.text.split("\n\n").at(-2).slice(0,220), reason:"Illustrative fixture score. Live mode asks the critic for an assessment of the actual continuation.", cluster:String(Math.floor(rng()*4)), flags:["offline fixture","not fact-checked"]}; }), "critic", 4096); }
  async final_review(config, posts) { if (!posts.length) return []; const seen = new Set(); return this.call(posts.map(post => { const key = JSON.stringify([post.title,post.lens]), keep = !seen.has(key); seen.add(key); const mechanism = MECHANISMS.find(m => post.title.startsWith(m[0])) || MECHANISMS[0]; return {id:post.id, keep, reason:keep ? "Offline fixture: kept this sample to illustrate final review." : "Offline fixture: rejected a repeated title to illustrate pruning.", idea:keep ? mechanism[2] : "", caveats:["Offline fixture; not a model assessment.",mechanism[3]]}; }), "critic", 8192); }
  async summarize(config, notes) {
    if (!notes.length) return {overview:"No useful ideas survived final review.",ideas:[]};
    const ideas = [], byText = new Map();
    for (const note of notes) { const text = note.idea ?? note.summary ?? "", key = text.trim().toLowerCase();
      if (byText.has(key)) { const existing = byText.get(key); existing.source_ids = [...new Set([...existing.source_ids,...note.source_ids])]; existing.caveats = [...new Set([...existing.caveats,...note.caveats])]; }
      else if (ideas.length < 8) { const idea = {title:note.title,summary:text,why_it_matters:note.reason ?? note.why_it_matters ?? "Illustrative fixture idea.",caveats:[...new Set(["Offline fixture; not a model synthesis.",...note.caveats])],source_ids:[...new Set(note.source_ids)]}; ideas.push(idea); byText.set(key,idea); }
    }
    return this.call({overview:"Offline fixture summary: these canned examples illustrate how reviewed ideas are grouped and traced to drafts.",ideas},"critic",8192);
  }
}
