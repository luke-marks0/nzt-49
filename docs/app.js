import { createRuntime } from "./runtime.js";
import { LiveProvider, DEFAULT_CRITIC_MODEL, isSecurePageContext as credentialsAllowedHere } from "./providers.js";
import { TINKER_API_BASE, DEFAULT_BASE_MODEL, DEFAULT_TINKER_RELAY_URL, migrateGenerationConfig } from "./config.js";

const credentials = { tinkerKey: "", openaiKey: "", tinkerRelayUrl: "" };
const HTTPS_REQUIRED = "Open NZT-49 over HTTPS to enter API keys or run models. Saved runs remain available to read and export.";
function getLiveSettings() {
  return {
    critic_ready: credentialsAllowedHere() && Boolean(credentials.openaiKey),
    critic_status: !credentialsAllowedHere() ? HTTPS_REQUIRED : "Add an OpenAI API key for Astra in Models.",
    continuation_ready: credentialsAllowedHere() && Boolean(credentials.tinkerKey && credentials.tinkerRelayUrl),
    continuation_status: !credentialsAllowedHere() ? HTTPS_REQUIRED : !credentials.tinkerRelayUrl ? "Apply a trusted Tinker relay URL in Models." : "Add a Tinker API key for continuations in Models.",
    critic_model: DEFAULT_CRITIC_MODEL,
    critic_backend: "openai",
    tinker_key: credentialsAllowedHere() && Boolean(credentials.tinkerKey),
    tinker_relay_ready: credentialsAllowedHere() && Boolean(credentials.tinkerRelayUrl),
    openai_key: credentialsAllowedHere() && Boolean(credentials.openaiKey),
    base_model: DEFAULT_BASE_MODEL,
    base_url: TINKER_API_BASE,
    base_api: "tinker",
    base_reasoning: "default",
  };
}
let runtime;
const runtimeReady = createRuntime({
  providerFactory: requestHook => new LiveProvider(requestHook, {
    tinkerKey: credentials.tinkerKey,
    openaiKey: credentials.openaiKey,
    tinkerRelayUrl: credentials.tinkerRelayUrl,
    criticModel: DEFAULT_CRITIC_MODEL,
  }),
  getLiveSettings,
}).then(value => { runtime = value; return value; });

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = { defaults: null, live: {}, runs: [], run: null, selectedTitle: null, selectedNode: null, view: "ideas", busy: false, credentialSaving: false, reviewStarting: null, reviewBudgetRunId: null, pollTimer: null, estimateTimer: null, estimateRequest: 0, runRequest: 0 };
const numberFields = ["title_count", "branch_factor", "beam_width", "depth", "grace_depth", "chunk_tokens", "exploration_fraction", "seed", "max_calls", "max_output_tokens"];
const prettyNumber = value => Number(value || 0).toLocaleString();
const readableStatus = value => ({running: "Running", completed: "Completed", stopped: "Stopped", failed: "Failed", budget_exhausted: "Budget reached"}[value] || value || "Preparing");
const readableNodeStatus = value => ({active: "Kept", finished: "Finished", expanded: "Expanded", pruned: "Pruned", final_pruned: "Final cut"}[value] || value || "Pending");
const text = (tag, content, className) => { const element = document.createElement(tag); element.textContent = content == null ? "" : String(content); if (className) element.className = className; return element; };

async function api(path, options = {}) {
  return (await runtimeReady).api(path, options);
}

function showError(id, message) { const element = $(id); element.textContent = message || ""; element.hidden = !message; }
function configFromForm() {
  const data = new FormData($("#experiment-form"));
  const config = {};
  for (const name of numberFields) config[name] = Number(data.get(name));
  config.concept = String(data.get("concept") || "").trim();
  config.authors = [...new Set(String(data.get("authors") || "").split(/\r?\n/).map(x => x.trim()).filter(Boolean))];
  config.temperatures = String(data.get("temperatures") || "").split(",").map(x => x.trim()).filter(Boolean).map(Number);
  config.title_mode = data.get("title_mode");
  config.selection_mode = data.get("selection_mode");
  config.base_model = String(data.get("base_model") || "").trim();
  config.base_url = TINKER_API_BASE;
  config.base_api = "tinker";
  config.base_reasoning = "default";
  return config;
}

function validateConfig(config) {
  if (!config.concept) return "Add a concept to explore.";
  if (!config.authors.length || config.authors.length > 50) return "Choose between 1 and 50 author lenses.";
  if (config.authors.some(author => author.length > 120)) return "Keep each author name under 121 characters.";
  if (config.title_count * (config.title_mode === "per_author" ? config.authors.length : 1) > 200) return "Choose at most 200 titles in total.";
  if (!config.temperatures.length || config.temperatures.length > 20 || config.temperatures.some(x => !Number.isFinite(x) || x < 0 || x > 2)) return "Enter temperatures from 0 to 2, separated by commas.";
  if (numberFields.some(key => !Number.isFinite(config[key]))) return "Check the numeric experiment settings.";
  return null;
}

function applyConfig(config) {
  if (!config) return;
  config = migrateGenerationConfig(config);
  const form = $("#experiment-form");
  for (const [key, value] of Object.entries(config)) {
    const input = form.elements.namedItem(key);
    if (input) input.value = Array.isArray(value) ? value.join(key === "authors" ? "\n" : ", ") : value;
  }
  updateFormLabels();
  renderModelConfig();
  scheduleEstimate();
}

function updateFormLabels() {
  $("#author-count").textContent = $("#authors").value.split(/\r?\n/).filter(x => x.trim()).length;
  $("#exploration-label").textContent = `${Math.round(Number($("#exploration-fraction").value) * 100)}%`;
  $("#api-note").textContent = "Raw text continuations via Tinker.";
}

function scheduleEstimate() {
  clearTimeout(state.estimateTimer);
  state.estimateTimer = setTimeout(estimate, 350);
}

async function estimate() {
  const config = configFromForm();
  const currentRequest = ++state.estimateRequest;
  if (validateConfig(config) || !$("#experiment-form").checkValidity()) {
    $("#estimate-detail").textContent = "Complete valid settings to calculate the estimate.";
    return;
  }
  try {
    const result = await api("/api/estimate", { method: "POST", body: JSON.stringify(config) });
    if (currentRequest !== state.estimateRequest) return;
    const calls = result.max_calls ?? (Number(result.completion_calls || 0) + Number(result.critic_calls || 0) + 1);
    const values = $("#estimate"); values.replaceChildren();
    const titles = text("span", prettyNumber(result.title_total)); titles.append(" ", text("small", "titles"));
    const callLabel = text("span", prettyNumber(calls)); callLabel.append(" ", text("small", "model calls"));
    values.append(titles, callLabel);
    const exceeds = calls > config.max_calls || result.max_output_tokens > config.max_output_tokens;
    $("#estimate-detail").textContent = `${prettyNumber(result.max_output_tokens)} output tokens reserved. ${exceeds ? "Your budget may stop this run early." : "Actual usage depends on pruning and early endings. API costs also include input tokens."}`;
  } catch (error) {
    if (currentRequest === state.estimateRequest) $("#estimate-detail").textContent = `Estimate unavailable: ${error.message}`;
  }
}

function setBusy(value) {
  state.busy = value;
  $("#run-live").disabled = value || state.credentialSaving || !liveReady();
  $("#run-live").textContent = value ? "Starting…" : "Run live";
  renderCredentialControl();
}

function credentialChangeBlocked() {
  return state.busy || Boolean(state.reviewStarting) || Boolean(runtime?.isRunning()) || runIsActive();
}

function renderCredentialControl() {
  const blocked = credentialChangeBlocked();
  const insecure = !credentialsAllowedHere();
  const inputs = [$("#tinker-key"), $("#openai-key")];
  const relayInput = $("#tinker-relay-url");
  const button = $("#use-api-keys");
  if (insecure) { inputs.forEach(input => { input.value = ""; }); credentials.tinkerKey = ""; credentials.openaiKey = ""; credentials.tinkerRelayUrl = ""; }
  inputs.forEach(input => { input.disabled = insecure || state.credentialSaving || blocked; });
  relayInput.disabled = insecure || state.credentialSaving || blocked;
  $("#tinker-key").placeholder = credentials.tinkerKey ? "Tinker key loaded · paste to replace" : "Paste your Tinker API key";
  $("#openai-key").placeholder = credentials.openaiKey ? "OpenAI key loaded · paste to replace" : "Paste your OpenAI API key";
  const hasChanges = inputs.some(input => input.value.trim()) || relayInput.value.trim() !== credentials.tinkerRelayUrl;
  button.disabled = insecure || state.credentialSaving || blocked || !hasChanges;
  button.title = insecure ? HTTPS_REQUIRED : blocked ? "Wait for the current run to finish before changing credentials." : "Use these keys until this tab is reloaded or closed";
  $("#api-keys-help").textContent = insecure ? HTTPS_REQUIRED : "Keys and relay settings stay in this tab’s memory. Reloading clears them.";
}

function normalizeRelayUrl(value) {
  if (!value) return "";
  let url;
  try { url = new URL(value); } catch (_) { throw new Error("Enter a valid Tinker relay URL."); }
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  const path = url.pathname.replace(/\/+$/, "");
  if ((url.protocol !== "https:" && !localHttp) || !url.hostname || url.username || url.password || url.search || url.hash || /\s/.test(value) || !["", "/completions"].includes(path)) {
    throw new Error("Use an HTTPS relay URL ending at its root or /completions, without credentials, a query, or a fragment. Localhost HTTP is supported for development.");
  }
  return url.origin + path;
}

async function useApiKeys() {
  if (state.credentialSaving) return;
  showError("#api-keys-error", null);
  if (!credentialsAllowedHere()) {
    renderCredentialControl();
    showError("#api-keys-error", HTTPS_REQUIRED);
    return;
  }
  if (credentialChangeBlocked()) {
    showError("#api-keys-error", "Wait for the current run to finish before changing credentials.");
    return;
  }
  const tinkerKey = $("#tinker-key").value.trim();
  const openaiKey = $("#openai-key").value.trim();
  let relayUrl;
  try { relayUrl = normalizeRelayUrl($("#tinker-relay-url").value.trim()); }
  catch (error) { showError("#api-keys-error", error.message); return; }
  if (!tinkerKey && !openaiKey && relayUrl === credentials.tinkerRelayUrl) {
    showError("#api-keys-error", "Paste an API key or update your trusted Tinker relay URL first.");
    return;
  }
  if ([tinkerKey, openaiKey].some(key => key && !/^[\x21-\x7e]{1,512}$/.test(key))) {
    showError("#api-keys-error", "API keys must be at most 512 characters and contain no spaces.");
    return;
  }
  if (tinkerKey) credentials.tinkerKey = tinkerKey;
  if (openaiKey) credentials.openaiKey = openaiKey;
  credentials.tinkerRelayUrl = relayUrl;
  state.live = getLiveSettings();
  $("#tinker-key").value = "";
  $("#openai-key").value = "";
  $("#tinker-relay-url").value = relayUrl;
  $("#api-keys-status").textContent = "Connection settings applied for this tab. Keys are checked on the first request.";
  $("#api-keys-status").hidden = false;
  renderModelConfig();
}

function criticReady() {
  return credentialsAllowedHere() && Boolean(state.live.critic_ready && state.live.openai_key);
}

function liveReady() {
  return criticReady() && Boolean(state.live.continuation_ready && state.live.tinker_key && state.live.tinker_relay_ready);
}

function renderModelConfig() {
  $("#critic-model").textContent = state.live.critic_model || DEFAULT_CRITIC_MODEL;
  if (!$("#base-model").value && state.live.base_model) $("#base-model").value = state.live.base_model;
  const missing = [];
  if (!state.live.openai_key) missing.push("OpenAI key for Astra");
  if (!state.live.tinker_key) missing.push("Tinker key for continuations");
  if (!state.live.tinker_relay_ready) missing.push("trusted Tinker relay URL");
  $("#model-status").textContent = !credentialsAllowedHere() ? HTTPS_REQUIRED : !liveReady() ? `Missing: ${missing.join(" and ") || "model credentials"}.` : $("#base-model").value ? "Ready." : "Enter a continuation model ID.";
  $("#connection-dot").classList.toggle("ready", liveReady());
  $("#run-live").disabled = state.busy || state.credentialSaving || !liveReady();
  $("#run-live").title = !credentialsAllowedHere() ? HTTPS_REQUIRED : missing.length ? missing.join(". ") : "Start with Astra and the selected continuation model";
  renderCredentialControl();
  if (state.run) renderFinalReviewControls();
}

async function refreshHistory() {
  try {
    const result = await api("/api/runs");
    state.runs = Array.isArray(result) ? result : result.runs || [];
    const select = $("#run-history");
    select.replaceChildren(text("option", "This browser"));
    select.firstChild.value = "";
    for (const run of state.runs) {
      const date = new Date(run.created_at).toLocaleString([], {month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"});
      const option = text("option", `${run.mode === "demo" ? "Archived demo · " : ""}${date} · ${readableStatus(run.status)} · ${run.concept || run.config?.concept || run.id}`);
      option.value = run.id;
      select.append(option);
    }
    if (state.run) select.value = state.run.id;
    renderCredentialControl();
  } catch (error) { showError("#workspace-error", `Could not load this browser’s runs. ${error.message}`); }
}

async function startRun() {
  if (state.busy || state.credentialSaving) return;
  if (!credentialsAllowedHere()) { showError("#form-error", HTTPS_REQUIRED); return; }
  if (!liveReady()) { showError("#form-error", "Apply your Tinker key, OpenAI key, and a trusted Tinker relay URL in Models before starting a live run."); return; }
  if (!$("#experiment-form").reportValidity()) return;
  const config = configFromForm();
  const error = validateConfig(config);
  showError("#form-error", error);
  if (error) return;
  if (!config.base_model) { showError("#form-error", "Enter a continuation model ID."); $("#base-model").closest("details").open = true; $("#base-model").focus(); return; }
  setBusy(true);
  try {
    const run = await api("/api/runs", { method: "POST", body: JSON.stringify({ config, mode: "live" }) });
    clearTimeout(state.pollTimer);
    state.runRequest++;
    state.selectedTitle = null; state.selectedNode = null;
    state.run = run;
    state.reviewBudgetRunId = null;
    switchView("ideas");
    renderRun();
    await refreshHistory();
    schedulePoll();
    $("#experiment-panel").classList.remove("mobile-open");
    $("#toggle-controls").setAttribute("aria-expanded", "false");
    $("#run-workspace").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) { showError("#form-error", error.message); }
  finally { setBusy(false); }
}

async function loadRun(id) {
  if (!id) return;
  clearTimeout(state.pollTimer);
  const request = ++state.runRequest;
  try {
    const run = await api(`/api/runs/${encodeURIComponent(id)}`);
    if (request !== state.runRequest) return;
    state.run = run; state.selectedTitle = null; state.selectedNode = null;
    state.reviewBudgetRunId = null;
    showError("#workspace-error", null);
    switchView("ideas");
    renderRun(); schedulePoll();
  } catch (error) { if (request === state.runRequest) showError("#workspace-error", `Could not open the experiment. ${error.message}`); }
}

function schedulePoll() {
  clearTimeout(state.pollTimer);
  if (runIsActive()) state.pollTimer = setTimeout(pollRun, 1500);
}

function runIsActive() {
  return state.run?.mode === "live" && (state.run.status === "running" || ["reviewing", "summarizing"].includes(state.run.final_review?.status));
}

async function pollRun() {
  if (!state.run || !runIsActive()) return;
  const id = state.run.id;
  const request = state.runRequest;
  try {
    const run = await api(`/api/runs/${encodeURIComponent(id)}`);
    if (state.run?.id !== id || request !== state.runRequest) return;
    state.run = run;
    showError("#workspace-error", null);
    renderRun();
    if (!runIsActive()) refreshHistory();
  } catch (error) {
    if (state.run?.id === id && request === state.runRequest) showError("#workspace-error", `Connection interrupted; retrying. ${error.message}`);
  }
  if (state.run?.id === id && request === state.runRequest) schedulePoll();
}

function switchView(view) {
  state.view = view;
  for (const button of $$("[data-view]")) {
    const active = button.dataset.view === view;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
    $(`#view-${button.dataset.view}`).hidden = !active;
  }
}

function getTitle(id) { return state.run?.titles?.find(title => title.id === id); }
function getNode(id) { return state.run?.nodes?.find(node => node.id === id); }
function ancestry(node) {
  const path = []; const seen = new Set();
  while (node && !seen.has(node.id)) { path.unshift(node); seen.add(node.id); node = node.parent_id ? getNode(node.parent_id) : null; }
  return path;
}
function fullText(node) { return ancestry(node).map(part => part.text || "").join(""); }
function survivingNodes() {
  const run = state.run;
  if (!run) return [];
  if (Array.isArray(run.outputs)) return run.outputs.map(getNode).filter(Boolean);
  const nodes = run.nodes || [];
  return nodes.filter(node => ["active", "finished"].includes(node.status) && !nodes.some(child => child.parent_id === node.id));
}

function openBranch(id) {
  const node = getNode(id);
  if (!node) return;
  state.selectedTitle = node.title_id;
  state.selectedNode = node.id;
  switchView("branches");
  renderRun();
  $("#reader-panel").scrollTop = 0;
  $("#reader-panel").scrollIntoView({ behavior: "smooth", block: "start" });
}

function appendCaveats(container, caveats) {
  const items = Array.isArray(caveats) ? caveats : typeof caveats === "string" && caveats ? [caveats] : [];
  if (!items.length) return;
  const section = text("div", "", "idea-caveats");
  section.append(text("strong", "Caveats"));
  const list = text("ul", "");
  items.forEach(caveat => list.append(text("li", caveat)));
  section.append(list); container.append(section);
}

function canReviewFinalDrafts() {
  const run = state.run;
  return Boolean(run?.mode === "live" && !runIsActive() && (run.generation_completed || run.status === "completed") &&
    (!run.final_review || ["interrupted", "failed", "skipped"].includes(run.final_review.status)));
}

function renderFinalReviewControls() {
  const run = state.run;
  const starting = state.reviewStarting === run.id;
  const hidden = !canReviewFinalDrafts() && !starting;
  $("#final-review-controls").hidden = hidden;
  const button = $("#review-final-drafts");
  button.hidden = hidden;
  button.disabled = run.mode !== "live" || starting || state.credentialSaving || !criticReady();
  button.title = run.mode === "live" && !criticReady() ? (!credentialsAllowedHere() ? HTTPS_REQUIRED : "Add your OpenAI API key in Models to review saved drafts.") : "";
  button.textContent = starting ? "Starting review…" : "Review final drafts";
  const calls = $("#review-max-calls");
  const tokens = $("#review-max-output-tokens");
  if (state.reviewBudgetRunId !== run.id) {
    calls.value = run.config?.max_calls ?? "";
    tokens.value = run.config?.max_output_tokens ?? "";
    state.reviewBudgetRunId = run.id;
  }
  calls.disabled = starting;
  tokens.disabled = starting;
  $("#review-budget-note").textContent = "Totals include this run’s previous usage." + (run.mode === "live" && !criticReady() ? " Add your OpenAI API key in Models to review saved drafts." : "");
}

function renderBestIdeas() {
  const run = state.run;
  const review = run.final_review;
  const summary = review?.summary;
  const ideas = Array.isArray(summary?.ideas) ? summary.ideas : [];
  const candidates = review?.candidate_ids?.length || 0;
  const decisions = review?.decisions?.length || 0;
  const completedGeneration = run.generation_completed || run.status === "completed";
  const canReview = canReviewFinalDrafts();
  renderFinalReviewControls();
  const messages = {
    pending: "Final review begins after generation finishes.",
    reviewing: `Astra is reviewing the final drafts${candidates ? ` · ${decisions} of ${candidates} reviewed` : ""}.`,
    summarizing: "Astra is ranking and summarizing the kept ideas.",
    completed: ideas.length ? `${ideas.length} ranked idea${ideas.length === 1 ? "" : "s"} from the final review.` : "No ideas passed final review.",
    skipped: "Final review was skipped. See the run log for details.",
    failed: "Final review failed. Saved drafts and branches remain available.",
    interrupted: "Final review was interrupted. Saved drafts and review decisions remain available.",
  };
  $("#final-review-status").textContent = run.mode === "demo" ? "Archived demo results · read only; no live models were called." : review ? messages[review.status] || "Final review has not completed." :
    run.status === "running" ? "Not yet reviewed. Final review follows generation." : "Not yet reviewed.";
  $("#idea-count").textContent = prettyNumber(ideas.length);
  showError("#final-review-error", review?.error);
  const content = $("#best-ideas-content"); content.replaceChildren();
  if (summary?.overview) content.append(text("p", summary.overview, "best-ideas-overview"));
  if (!ideas.length) {
    const message = run.mode === "demo" ? "This archive has no saved idea summary. Its branches remain available to read and export." : review?.status === "completed" ? "The original drafts and review decisions are available in Branch map." :
      canReview ? "Review the saved final drafts. Raise the total budgets above if needed." :
      !completedGeneration && !runIsActive() ? "Generation did not complete. Inspect the saved branches or run log." :
      "You can inspect drafts and branches while the run progresses.";
    content.append(text("p", message, "gallery-intro"));
    return;
  }
  const list = text("div", "", "idea-list");
  ideas.forEach((idea, index) => {
    const sourceIds = Array.isArray(idea.source_ids) ? [...new Set(idea.source_ids)] : [];
    const card = text("article", "", "idea-card draft-card");
    const top = text("div", "", "draft-card-top");
    top.append(text("span", `IDEA ${String(index + 1).padStart(2, "0")}`, "idea-rank"),
      text("span", `${sourceIds.length} SOURCE${sourceIds.length === 1 ? "" : "S"}`));
    card.append(top, text("h3", idea.title || `Idea ${index + 1}`), text("p", idea.summary || "", "idea-summary"));
    if (idea.why_it_matters) {
      const importance = text("div", "", "idea-importance");
      importance.append(text("strong", "Why it matters"), text("p", idea.why_it_matters));
      card.append(importance);
    }
    appendCaveats(card, idea.caveats);
    const sources = text("div", "", "idea-sources");
    sourceIds.forEach(id => {
      const source = getNode(id);
      const link = text("button", source ? `Read ${id} →` : `${id} unavailable`, "button small secondary");
      link.type = "button"; link.disabled = !source; link.dataset.sourceId = id;
      if (source) link.title = getTitle(source.title_id)?.title || "Read original branch";
      link.addEventListener("click", () => openBranch(id)); sources.append(link);
    });
    card.append(sources); list.append(card);
  });
  content.append(list);
}

async function startFinalReview() {
  const id = state.run?.id;
  if (state.run?.mode !== "live") return;
  if (!credentialsAllowedHere()) { showError("#final-review-error", HTTPS_REQUIRED); return; }
  if (!criticReady()) { showError("#final-review-error", "Add your OpenAI API key in Models to review saved drafts."); return; }
  if (!id || state.reviewStarting || state.credentialSaving || !canReviewFinalDrafts()) return;
  const limits = {};
  for (const [key, selector, label, minimum, maximum] of [
    ["max_calls", "#review-max-calls", "Total call budget", 1, 10000],
    ["max_output_tokens", "#review-max-output-tokens", "Total output token budget", 64, 20000000],
  ]) {
    const input = $(selector);
    const value = Number(input.value);
    if (!input.value.trim() || !Number.isInteger(value) || value < minimum || value > maximum) {
      showError("#final-review-error", `${label} must be an integer between ${minimum} and ${maximum}.`);
      input.focus(); input.reportValidity();
      return;
    }
    limits[key] = value;
  }
  clearTimeout(state.pollTimer);
  const request = ++state.runRequest;
  state.reviewStarting = id;
  renderCredentialControl();
  renderBestIdeas();
  try {
    const run = await api(`/api/runs/${encodeURIComponent(id)}/final-review`, { method: "POST", body: JSON.stringify(limits) });
    if (state.run?.id !== id || request !== state.runRequest) return;
    state.run = run;
    renderRun(); schedulePoll(); refreshHistory();
  } catch (error) {
    if (state.run?.id === id && request === state.runRequest) showError("#final-review-error", `Could not start final review. ${error.message}`);
  } finally {
    if (state.reviewStarting === id) state.reviewStarting = null;
    renderCredentialControl();
    if (state.run?.id === id && request === state.runRequest) {
      renderFinalReviewControls();
    }
  }
}

function renderRun() {
  const run = state.run;
  if (!run) return;
  renderCredentialControl();
  $("#run-workspace").hidden = false;
  $("#run-id").textContent = `EXPERIMENT / ${run.id.slice(-8)}`;
  $("#run-concept").textContent = run.config?.concept || run.concept || "Untitled experiment";
  $("#run-mode").textContent = run.mode === "demo" ? "ARCHIVED DEMO" : "LIVE MODELS";
  $("#run-mode").classList.toggle("archive", run.mode === "demo");
  $("#run-status").textContent = run.mode === "demo" ? "Read only" : readableStatus(run.status);
  $("#run-status").classList.toggle("failed", run.mode === "live" && run.status === "failed");
  $("#archive-notice").hidden = run.mode !== "demo";
  $("#run-progress").textContent = run.mode === "demo" ? "Archived demo; this run cannot be continued." : run.progress || readableStatus(run.status);
  $("#activity-dot").classList.toggle("running", runIsActive());
  $("#run-usage").textContent = `${prettyNumber(run.usage?.calls)} ${run.mode === "demo" ? "simulated calls" : "calls"} · ${prettyNumber(run.usage?.output_tokens)} output tokens`;
  $("#stop-run").hidden = !runIsActive();
  $("#stop-run").disabled = false;
  $("#stop-run").textContent = "Stop run";
  showError("#run-error", run.error);
  $("#export-md").href = "#";
  $("#export-json").href = "#";
  $("#node-count").textContent = prettyNumber(run.nodes?.length);
  $("#draft-count").textContent = prettyNumber(survivingNodes().length);
  const titles = run.titles || [];
  if (!titles.some(title => title.id === state.selectedTitle)) state.selectedTitle = titles[0]?.id || null;
  const titleSelect = $("#title-select");
  titleSelect.replaceChildren();
  if (!titles.length) { const option = text("option", runIsActive() ? "Planning titles…" : "No saved titles"); option.value = ""; titleSelect.append(option); }
  for (const title of titles) { const option = text("option", title.title); option.value = title.id; titleSelect.append(option); }
  titleSelect.value = state.selectedTitle || "";
  titleSelect.disabled = !titles.length;
  if (!getNode(state.selectedNode) || getNode(state.selectedNode)?.title_id !== state.selectedTitle) {
    const nodes = (run.nodes || []).filter(node => node.title_id === state.selectedTitle);
    state.selectedNode = [...nodes].reverse().find(node => ["active", "finished"].includes(node.status))?.id || nodes[0]?.id || null;
  }
  renderBestIdeas(); renderTree(); renderReader(); renderGallery(); renderLog();
}

function renderTree() {
  const title = getTitle(state.selectedTitle);
  $("#title-lens").textContent = title ? `${title.author || "Custom"} lens${title.lens ? ` · ${title.lens}` : ""}` : "";
  const list = $("#tree-list");
  const oldScroll = list.scrollTop;
  list.replaceChildren();
  const nodes = (state.run?.nodes || []).filter(node => node.title_id === state.selectedTitle);
  if (!nodes.length) { list.append(text("p", runIsActive() ? "Waiting for the first continuations…" : "No continuations were generated for this title.", "tree-empty")); return; }
  const ordered = []; const visited = new Set();
  function visit(node) { if (visited.has(node.id)) return; visited.add(node.id); ordered.push(node); nodes.filter(child => child.parent_id === node.id).forEach(visit); }
  nodes.filter(node => !node.parent_id || !nodes.some(parent => parent.id === node.parent_id)).forEach(visit);
  nodes.forEach(visit);
  for (const node of ordered) {
    const button = text("button", "", `tree-node ${node.status}${node.id === state.selectedNode ? " selected" : ""}`);
    button.type = "button"; button.dataset.nodeId = node.id;
    button.style.setProperty("--indent", `${Math.min(Math.max(0, Number(node.depth || 1) - 1), 5) * 12}px`);
    button.style.setProperty("--connector", node.parent_id ? "block" : "none");
    button.setAttribute("aria-pressed", String(node.id === state.selectedNode));
    const meta = text("div", "", "node-meta");
    meta.append(text("i", "", `node-dot ${node.status}`), text("span", `D${node.depth} · T${node.temperature ?? "—"}`), text("span", readableNodeStatus(node.status), "node-status"));
    const preview = node.evaluation?.idea || node.text?.trim() || "Empty continuation";
    button.append(meta, text("div", preview, "node-preview"));
    button.addEventListener("click", () => { state.selectedNode = node.id; renderTree(); renderReader(); $("#reader-panel").scrollTop = 0; });
    list.append(button);
  }
  list.scrollTop = oldScroll;
}

function renderReader() {
  const panel = $("#reader-panel");
  const oldScroll = panel.scrollTop;
  const node = getNode(state.selectedNode);
  panel.replaceChildren();
  if (!node) {
    const empty = text("div", "", "reader-empty"); empty.append(text("p", "Select a branch.")); panel.append(empty); return;
  }
  const title = getTitle(node.title_id) || {};
  const path = ancestry(node);
  const top = text("div", "", "reader-topline");
  top.append(text("span", `${readableNodeStatus(node.status).toUpperCase()} PATH / ${path.length} CHUNK${path.length === 1 ? "" : "S"}`, "eyebrow"));
  const copy = text("button", "Copy text", "copy-button"); copy.type = "button";
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(`${title.title || ""}\n\nFictional draft inspired by the ${title.author || "selected author"} lens.\n\n${fullText(node)}`); copy.textContent = "Copied"; setTimeout(() => { copy.textContent = "Copy text"; }, 1800); }
    catch (_) { copy.textContent = "Use export instead"; }
  });
  top.append(copy);
  const byline = text("div", "", "reader-byline");
  byline.append(text("strong", `${title.author || "Custom author"} lens`), text("span", ` · ${title.venue || "Blog"} · Synthetic draft`));
  panel.append(top, text("h2", title.title || "Untitled continuation", "reader-title"), byline);
  panel.append(text("p", path.map(part => `Depth ${part.depth} · T${part.temperature ?? "—"}`).join("  →  "), "reader-path"));
  panel.append(text("div", fullText(node), "reader-body"));
  if (node.finish_reason === "length") panel.append(text("p", "This branch ends at a generation boundary. It may stop mid-sentence.", "continuation-note"));
  const decision = node.final_review || state.run.final_review?.decisions?.find(item => item.id === node.id);
  if (decision) {
    const card = text("aside", "", "final-review-card critic-card");
    const heading = text("div", "", "critic-heading");
    heading.append(text("span", decision.keep ? "FINAL REVIEW · KEPT" : "FINAL REVIEW · CUT", "eyebrow"));
    card.append(heading);
    if (decision.idea) card.append(text("h3", decision.idea));
    if (decision.reason) card.append(text("p", decision.reason));
    appendCaveats(card, decision.caveats);
    panel.append(card);
  }
  if (node.evaluation) panel.append(renderCritic(node));
  else panel.append(text("p", node.selection_reason || (state.run.config?.selection_mode === "random" ? "Random control condition: this continuation was selected without a critic ranking." : "The critic has not evaluated this continuation yet."), "evaluation-pending"));
  panel.scrollTop = oldScroll;
}

function renderCritic(node) {
  const evaluation = node.evaluation;
  const card = text("aside", "", "critic-card");
  const heading = text("div", "", "critic-heading");
  heading.append(text("span", "CRITIC’S NOTEBOOK", "eyebrow"), text("span", evaluation.cluster || "", "cluster-badge"));
  card.append(heading);
  const scores = text("div", "", "scores");
  for (const key of ["novelty", "usefulness", "coherence", "confidence"]) {
    const score = Number(evaluation[key]);
    const column = text("div", "", "score");
    column.append(text("div", Number.isFinite(score) ? `${Math.round(score * 100)}` : "—", "score-value"), text("div", `${key[0].toUpperCase() + key.slice(1)} /100`, "score-label"));
    const track = text("div", "", "score-track"); const fill = text("div", "", "score-fill"); fill.style.width = `${Number.isFinite(score) ? Math.max(0, Math.min(100, score * 100)) : 0}%`; track.append(fill); column.append(track); scores.append(column);
  }
  card.append(scores);
  if (evaluation.idea) card.append(text("h3", evaluation.idea));
  if (evaluation.reason) card.append(text("p", evaluation.reason));
  if (node.selection_reason) card.append(text("p", node.selection_reason, "selection-note"));
  if (evaluation.flags?.length) { const flags = text("div", "", "critic-flags"); evaluation.flags.forEach(flag => flags.append(text("span", flag))); card.append(flags); }
  return card;
}

function renderGallery() {
  const gallery = $("#view-drafts"); gallery.replaceChildren();
  const nodes = survivingNodes();
  if (!nodes.length) {
    const empty = text("div", "", "gallery-empty"); empty.append(text("p", runIsActive() ? "Generating drafts…" : "No surviving drafts. See branches or run log.")); gallery.append(empty); return;
  }
  gallery.append(text("p", `${nodes.length} ${runIsActive() ? "currently surviving" : "surviving"} path${nodes.length === 1 ? "" : "s"}. Multiple paths may share a title and opening.`, "gallery-intro"));
  nodes.forEach((node, index) => {
    const title = getTitle(node.title_id) || {};
    const card = text("article", "", "draft-card");
    const top = text("div", "", "draft-card-top"); top.append(text("span", `DRAFT ${String(index + 1).padStart(2, "0")}`), text("span", `${ancestry(node).length} CHUNKS · ${readableNodeStatus(node.status).toUpperCase()}`));
    card.append(top, text("h2", title.title), text("p", `${title.author || "Custom"} lens · Fictional draft`, "draft-card-author"), text("p", node.evaluation?.idea || fullText(node).slice(0, 500), "draft-card-excerpt"));
    const button = text("button", "Read this path →", "button small secondary"); button.type = "button";
    button.addEventListener("click", () => openBranch(node.id));
    card.append(button); gallery.append(card);
  });
}

function renderLog() {
  const log = $("#view-log"); log.replaceChildren();
  const events = state.run?.events || [];
  if (!events.length) { log.append(text("p", "No events recorded yet.", "log-empty")); return; }
  for (const event of [...events].reverse()) {
    const row = text("div", "", "log-row");
    const date = new Date(event.time);
    const time = text("time", Number.isNaN(date.getTime()) ? event.time || "—" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    if (!Number.isNaN(date.getTime())) time.dateTime = date.toISOString();
    row.append(time, text("p", event.message)); log.append(row);
  }
}

async function exportCurrentRun(format) {
  const id = state.run?.id;
  if (!id) return;
  try {
    const content = await (await runtimeReady).exportRun(id, format);
    const extension = format === "markdown" ? "md" : "json";
    const blob = new Blob([content], { type: format === "markdown" ? "text/markdown;charset=utf-8" : "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `nzt-49-${id}.${extension}`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) { showError("#workspace-error", `Could not export this run. ${error.message}`); }
}

async function importRunFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  $("#import-run").disabled = true;
  showError("#workspace-error", null);
  try {
    if (file.size > 20 * 1024 * 1024) throw new Error("Choose an NZT-49 JSON export smaller than 20 MB.");
    let data;
    try { data = JSON.parse(await file.text()); }
    catch (_) { throw new Error("Choose a valid NZT-49 JSON export."); }
    const run = await (await runtimeReady).importRun(data);
    await refreshHistory();
    await loadRun(run.id);
  } catch (error) { showError("#workspace-error", `Could not import this run. ${error.message}`); }
  finally { event.target.value = ""; $("#import-run").disabled = false; }
}

$("#experiment-form").addEventListener("submit", event => { event.preventDefault(); startRun(); });
$("#import-run").addEventListener("click", () => $("#import-file").click());
$("#import-file").addEventListener("change", importRunFile);
$("#export-md").addEventListener("click", event => { event.preventDefault(); exportCurrentRun("markdown"); });
$("#export-json").addEventListener("click", event => { event.preventDefault(); exportCurrentRun("json"); });
$("#use-api-keys").addEventListener("click", useApiKeys);
for (const selector of ["#tinker-key", "#openai-key", "#tinker-relay-url"]) {
  $(selector).addEventListener("input", () => { showError("#api-keys-error", null); $("#api-keys-status").hidden = true; renderCredentialControl(); });
  $(selector).addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); useApiKeys(); } });
}
$("#review-final-drafts").addEventListener("click", startFinalReview);
$("#experiment-form").addEventListener("input", event => { if (["tinker-key", "openai-key", "tinker-relay-url"].includes(event.target.id)) return; updateFormLabels(); renderModelConfig(); scheduleEstimate(); showError("#form-error", null); });
$("#run-history").addEventListener("change", event => loadRun(event.target.value));
$("#title-select").addEventListener("change", event => { state.selectedTitle = event.target.value; state.selectedNode = null; renderRun(); $("#reader-panel").scrollTop = 0; });
$("#toggle-controls").addEventListener("click", () => { const open = $("#experiment-panel").classList.toggle("mobile-open"); $("#toggle-controls").setAttribute("aria-expanded", String(open)); });
$("#load-settings").addEventListener("click", () => { applyConfig(state.run?.config); $("#experiment-panel").classList.add("mobile-open"); $("#toggle-controls").setAttribute("aria-expanded", "true"); $("#concept").focus(); });
$("#stop-run").addEventListener("click", async () => {
  const id = state.run?.id;
  if (!id || state.run.mode !== "live") return;
  $("#stop-run").disabled = true; $("#stop-run").textContent = "Stopping…";
  try { const run = await api(`/api/runs/${encodeURIComponent(id)}/stop`, { method: "POST", body: "{}" }); if (state.run?.id === id) { state.run = run; renderRun(); schedulePoll(); refreshHistory(); } }
  catch (error) { showError("#workspace-error", `Could not stop the experiment. ${error.message}`); $("#stop-run").disabled = false; $("#stop-run").textContent = "Stop run"; }
});
for (const button of $$("[data-view]")) {
  button.addEventListener("click", () => switchView(button.dataset.view));
  button.addEventListener("keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); const tabs = $$("[data-view]"); let index = tabs.indexOf(button);
    index = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    switchView(tabs[index].dataset.view); tabs[index].focus();
  });
}

window.addEventListener("beforeunload", event => {
  if (!runtime?.isRunning()) return;
  event.preventDefault();
  event.returnValue = "";
});

async function initialize() {
  $("#tinker-relay-url").value = DEFAULT_TINKER_RELAY_URL;
  updateFormLabels();
  renderModelConfig();
  const results = await Promise.allSettled([api("/api/config"), refreshHistory()]);
  const configResult = results[0];
  if (configResult.status === "fulfilled") { state.defaults = configResult.value.defaults; state.live = configResult.value.live || {}; applyConfig(state.defaults); renderModelConfig(); }
  else { renderModelConfig(); showError("#workspace-error", `Could not initialize browser storage. ${configResult.reason.message}`); scheduleEstimate(); }
}
initialize();
