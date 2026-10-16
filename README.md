# NZT-49

A browser app for exploring macrostrategy ideas through branching synthetic posts. Astra proposes diverse titles, an OpenRouter model generates continuations, and Astra prunes branches, reviews complete drafts, and summarizes the best ideas.

**Open the app:** https://luke-marks0.github.io/nzt-49/

## Use

1. Enter your own OpenRouter key in **Models** and click **Use key in this tab**.
2. Select **OpenRouter (paid)** for Astra access. Titles, intermediate pruning, final pruning, and synthesis use `openai/gpt-6-astra` and are billed to your OpenRouter account. Your ChatGPT/Codex subscription is not used.
3. Choose any compatible OpenRouter continuation model ID. The preset is `nvidia/nemotron-3.5-lightning:free` with reasoning off; model availability and free limits can change.
4. Set a concept, title count, branching depth, temperatures, and budgets, then **Run live**. **Run demo** exercises the same workflow with clearly labeled canned fixtures and no model requests.

Keep the tab open during a run. Closing or reloading it stops execution; saved checkpoints remain available. An interrupted final review can resume without regenerating posts. Generation itself does not yet resume.

## Your data

- Runs are stored in **IndexedDB in your browser**, scoped to this app. There is no centralized run database, analytics, or server collecting results.
- The OpenRouter key stays in the open tab's memory. It is not stored in IndexedDB, localStorage, sessionStorage, exports, or this repository. Reloading clears it.
- Prompts and generated text are sent directly to OpenRouter and its selected model providers to run the experiment. They are subject to those providers' data policies. GitHub Pages serves only the app's static files.
- Export **Markdown** for the final ideas and drafts, or **JSON** for the complete tree and audit trail. JSON files can be imported into another browser. Importing does not upload the file.
- Browser storage can be cleared or evicted. Export runs you want to keep. Different devices and browser profiles have independent histories.
- No previous user runs or credentials are included in the repository. Demo examples are code fixtures, not saved user history.

## How the search works

Title counts may be total or per author. The default author lenses are Wei Dai, Vladimir Nesov, Vitalik Buterin, Vanessa Kosoy, Eliezer Yudkowsky, Robin Hanson, Cleo Nardo, Buck Shlegeris, Ryan Greenblatt, and Gwern. Drafts are synthetic; these people did not write or endorse them.

Generation proceeds in chunks, interleaved across titles. A grace period delays pruning, then per-title beam selection combines critic scores, a lexical duplication penalty, and seeded exploration. The random-selection control still obtains critiques and receives the same final review. Seeds control selection, not guaranteed provider generation reproducibility.

After generation, Astra reviews fully assembled surviving drafts and may reject every one. It then synthesizes up to eight ranked ideas with caveats and links to original draft paths. Large reviews and summaries are batched without silently truncating individual drafts. Pruned text stays in the branch map. Reviews are model judgments, not fact-checks or verified literature searches.

The call budget and reserved output-token budget include titles, continuations, critiques, and final synthesis. They are **not dollar caps** and exclude input tokens; API pricing includes input and reasoning/output usage. Requests are reserved before being sent; unused output reservations are not reclaimed. No automatic model substitutions or application retries occur.

The default OpenRouter adapter sends a raw `prompt` to `/api/v1/chat/completions`. **Chat comparison** sends messages instead. A raw prompt does not establish that a checkpoint is pretrained-only; check the model's provenance. High temperatures can produce incoherent or corrupted text.

## Development and hosting

This is a buildless app: `docs/` contains HTML, CSS, and browser ES modules. No server, package installation, or build step is needed.

```sh
# Node 20+ for offline tests
npm test

# Python 3 for a local static preview
python3 -m http.server 8766 --directory docs --bind 127.0.0.1
```

GitHub Pages publishes the `main` branch's `/docs` folder. Assets use relative paths to work at `/nzt-49/`. The `.nojekyll` file disables Jekyll processing.

Astra access uses [OpenRouter's Astra endpoint](https://openrouter.ai/openai/gpt-6-astra). Subscription-backed OpenAI sign-in currently has [local callback requirements](https://developers.openai.com/siwc/token-sharing-open-source/sign-in); this static app does not claim to provide that flow.
