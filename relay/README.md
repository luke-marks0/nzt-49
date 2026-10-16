# Tinker relay

This small relay lets the browser app call Tinker's raw completions API, whose endpoint currently rejects browser CORS preflights. It forwards each caller's own Tinker key to one fixed HTTPS endpoint. It has no shared key, account database, run storage, request logs, or model fallback. The main app still keeps runs in the browser.

## Run locally

Use Node 20 or later, with no dependencies:

```sh
node relay/serve.mjs
```

The server binds only to `127.0.0.1:8787`. Preview the app at port 8765 or 8766 on `localhost` or `127.0.0.1`, and use `http://127.0.0.1:8787/completions` as the relay endpoint. `--port 8788` selects another local relay port. Hosted HTTPS pages may additionally restrict local-network requests; a local app preview avoids that browser restriction.

## Deploy to Cloudflare Workers

The Worker uses the same handler. No bindings or secrets are needed. Review the name and origin list in `wrangler.toml`, then use an authenticated Wrangler CLI:

```sh
npx wrangler deploy --config relay/wrangler.toml
```

This command publishes the relay; it has not been run as part of creating these files. Use the resulting HTTPS URL with `/completions` appended in the app. `ALLOWED_ORIGINS` is a comma-separated list of exact browser origins. It defaults to the NZT-49 custom domain, its GitHub Pages origin, and local preview ports 8765/8766. To change the local runner's list, set `NZT_RELAY_ALLOWED_ORIGINS`. Wildcards and non-local HTTP origins are rejected.

The code does not log requests or persist credentials, and Worker observability is disabled in the configuration. The hosting provider still processes requests as infrastructure; do not enable request-body or authorization-header logging. Origin checks prevent unintended browser access but are not caller authentication: non-browser clients can set an Origin header. Each request must supply its own Tinker key and uses that account's allowance.

## Protocol

`POST /completions` requires an allowed `Origin`, `Content-Type: application/json`, and `Authorization: Bearer <Tinker key>`. Its JSON body accepts only `model`, `prompt`, `max_tokens`, and optional `temperature` and `top_p`. The relay preserves the prompt and sampling values. `max_tokens` must be 1–32768, temperature 0–2, and top-p greater than 0 and at most 1. Requests are limited to 1 MiB and responses to 8 MiB. A request times out after 180 seconds; a timed-out upstream request may still incur usage, so the relay never retries automatically.

All requests go to `https://tinker.thinkingmachines.dev/services/tinker-prod/oai/api/v1/completions`; redirects are rejected. Successful completion JSON is returned with credential echoes and credential metadata removed. Errors contain only a safe `{ "error": { "code": "...", "message": "..." } }` object. Upstream rate limits return HTTP 429 with `upstream_rate_limited`; timeouts return HTTP 504 with `upstream_timeout`. No raw upstream error body is returned.

`OPTIONS /completions` supports browser preflight. `GET /health` returns only service availability and makes no Tinker request. Neither endpoint verifies model access or credits.

Run the offline handler tests with `node --test web-tests/relay.test.mjs` from the repository root. No test sends a live model request.
