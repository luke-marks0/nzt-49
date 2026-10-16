# NZT-49

A browser app for exploring macrostrategy ideas through branching synthetic posts. Astra proposes diverse titles, a Tinker base model generates raw continuations, and Astra prunes branches, reviews complete drafts, and summarizes the best ideas.

**App address:** https://nzt-49.lukemarks.bot/ (DNS and HTTPS setup pending).

## Use

1. Enter your **Tinker API key**, **OpenAI API key**, and trusted **Tinker relay URL** in Models, then click **Use keys in this tab**. Tinker calls pass through that relay; the OpenAI key goes directly to OpenAI. A relay deployment is required for live generation; see [relay setup](relay/README.md).
2. Astra uses `gpt-6-astra` through OpenAI's Responses API for titles, intermediate pruning, final pruning, and synthesis. This uses OpenAI API billing, not a ChatGPT/Codex subscription. Tinker bills continuation calls separately.
3. Choose a supported Tinker model ID or `tinker://…/sampler_weights/…` path. The preset is `Qwen/Qwen3.5-9B-Base`, documented by Tinker as a pretrained, non-chat-tuned model. Custom checkpoints may have been fine-tuned; check their provenance.
4. Set a concept, title count, branching depth, temperatures, and budgets, then **Run live**. **Run demo** exercises the same workflow with clearly labeled canned fixtures and no model requests.

Keep the tab open during a run. Closing or reloading it stops execution; saved checkpoints remain available. An interrupted final review can resume with only an OpenAI key, without regenerating posts. Generation itself does not yet resume. Older exported runs remain readable; reusing their settings switches new generation to Tinker without changing the original run.

## Your data

- Runs are stored in **IndexedDB in your browser**, scoped to this app. There is no centralized run database, analytics, or server collecting results.
- API keys and the relay connection setting stay in the open tab's memory. They are not stored in IndexedDB, localStorage, sessionStorage, exports, or this repository. Reloading clears them. Imported runs cannot change the relay address.
- Astra prompts and generated text go directly to OpenAI with `store: false`. Tinker prompts and the Tinker key pass through the selected relay to Tinker. The relay has no database, key storage, request logging, or run history; its Cloudflare observability is disabled. Provider retention policies still apply. Use a relay you trust.
- Export **Markdown** for the final ideas and drafts, or **JSON** for the complete tree and audit trail. JSON files can be imported into another browser. Importing does not upload the file.
- Browser storage can be cleared or evicted. Export runs you want to keep. Different devices and browser profiles have independent histories.
- No previous user runs or credentials are included in the repository. Demo examples are code fixtures, not saved user history.

## How the search works

Title counts may be total or per author. The default author lenses are Wei Dai, Vladimir Nesov, Vitalik Buterin, Vanessa Kosoy, Eliezer Yudkowsky, Robin Hanson, Cleo Nardo, Buck Shlegeris, Ryan Greenblatt, and Gwern. Drafts are synthetic; these people did not write or endorse them.

Generation proceeds in chunks, interleaved across titles. A grace period delays pruning, then per-title beam selection combines critic scores, a lexical duplication penalty, and seeded exploration. The random-selection control still obtains critiques and receives the same final review. Seeds control selection, not guaranteed provider generation reproducibility.

After generation, Astra reviews fully assembled surviving drafts and may reject every one. It then synthesizes up to eight ranked ideas with caveats and links to original draft paths. Large reviews and summaries are batched without silently truncating individual drafts. Pruned text stays in the branch map. Reviews are model judgments, not fact-checks or verified literature searches.

The call budget and reserved output-token budget include titles, continuations, critiques, and final synthesis. They are **not dollar caps** and exclude input tokens; API pricing includes input and reasoning/output usage. Requests are reserved before being sent; unused output reservations are not reclaimed. No automatic model substitutions or application retries occur.

Tinker receives a raw `prompt` at its OpenAI-compatible `/completions` endpoint, with no chat template, chat messages, or reasoning-mode wrapper. New runs never call OpenRouter. High temperatures can produce incoherent or corrupted text. Tinker's compatible inference API is currently a beta intended for experiments and internal use, with variable throughput.

## Development and hosting

The interface is buildless: `docs/` contains HTML, CSS, and browser ES modules served by GitHub Pages. The small Cloudflare Worker in `relay/` is needed because Tinker's completion endpoint currently rejects browser CORS preflights. The Worker forwards only raw-completion requests to Tinker's fixed endpoint; it does not host the app or save runs.

```sh
# Node 20+ for offline tests
npm test

# Python 3 for a local static preview
python3 -m http.server 8766 --directory docs --bind 127.0.0.1

# Optional local Tinker relay; enter http://127.0.0.1:8787 in Models
node relay/serve.mjs
```

GitHub Pages publishes the `main` branch's `/docs` folder. Assets use relative paths to work at `/nzt-49/`. The `.nojekyll` file disables Jekyll processing.

The dedicated domain requires a `CNAME` DNS record for `nzt-49.lukemarks.bot` pointing to `luke-marks0.github.io`. Enable HTTPS in the repository's Pages settings after GitHub issues the certificate. Live API access is disabled on public HTTP pages; loopback HTTP is supported for local development.

API references: [Tinker raw completions](https://tinker-docs.thinkingmachines.ai/tinker/compatible-apis/openai/), [Tinker base-model example](https://tinker-docs.thinkingmachines.ai/tutorials/basics/hello-tinker/), [OpenAI Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), and [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses).
