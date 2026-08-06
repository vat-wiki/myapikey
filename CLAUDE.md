# CLAUDE.md — MyAPIKey

Personal LLM API gateway. One address + one key → all configured models, pure passthrough.

## Architecture

npm workspaces monorepo, TypeScript throughout, run via `tsx` (no compile step for core; `tsc`/`vue-tsc` are typecheck-only).

```
packages/
  core/   Hono server + CLI + shared types (Node, ESM)
    src/
      shared/   types.ts, config.ts (data model + defaults)
      server/   store.ts, auth.ts, admin.ts, proxy.ts, app.ts
      cli/      index.ts (commander), client.ts, config.ts
  web/    Vue 3 + Vite SPA (full CRUD over the same /admin API)
```

- **Storage:** `Store` (server/store.ts) owns a single **data directory** (default `~/.myapikey`, resolved at boot as `--data-dir` flag → `MYAPIKEY_DATA_DIR` env → `DEFAULT_DATA_DIR`). It holds `data.json` (the config, cached in memory, write-through on `update()`, serialized by a promise chain) and `logs.jsonl` (recent calls, one JSON object per line, trimmed to the last ~200, read on demand via `store.getLogs()` — never held in memory). `store.getPaths()` exposes the resolved locations for the read-only display at `GET /admin/storage`. The CLI client profile lives at `~/.myapikey/client.json` (pinned to the default home, not the `--data-dir` override; legacy `~/.config/myapikey/config.json` is read as a fallback). On every startup `store.writeCredentialsFile()` writes a human-readable `credentials.txt` (web login + `/v1` api key) into the data dir — so the first-run login is recoverable even if the startup terminal is gone (closed / daemon / container); the first-run banner prints the creds and points to the file.
- **Auth:** two independent secrets. The **account** `{username, password}` gates `/admin` (HTTP Basic — web login + CLI config). The **API key** (`sk-myapikey-…`, `GateConfig.apiKey`) gates `/v1` (`Authorization: Bearer` or `x-api-key`). Neither works on the other's surface (`authMiddleware` vs `apiKeyMiddleware` in `auth.ts`). Each middleware is attached **inside** its sub-app before its routes (Hono only runs middleware registered before the route — this bit us once). Rotate the API key via `POST /admin/api-key/rotate`.
- **Routing:** `/v1/chat/completions`, `/v1/responses`, and `/v1/messages` all go through `dispatch()` (proxy.ts): parse body → look up `models[model]` → iterate `providers` in priority order, filtered by the requested `Format` → forward; **fail over** on 429/5xx/network, **return as-is** on other 4xx, **no failover once streaming has started**. Bodies are forwarded verbatim (re-stringified after parsing `model`); responses stream `upstream.body` straight through. `/responses` is an openai-family endpoint **not implied by `format`** — it only routes to providers with `supportsResponses` set (most openai-compatible backends don't implement it).
- **Admin API** (`admin.ts`) is the single source of config truth; CLI and web are both clients. A provider has a **base URL per format**: `baseUrlOpenai` (incl. the version segment, e.g. `/v1` or Ark's `/api/v3`) and `baseUrlAnthropic` (**excl.** `/v1`, e.g. `https://api.anthropic.com`, or Volcengine Ark's coding-plan base `…/api/plan`). Ark has **two distinct surfaces with different credentials**: `/api/v3` (general API, takes a normal API key) vs `/api/plan` (coding-plan token, anthropic-only) — a plan token 401s on `/api/v3` and vice-versa, so confirm which surface a key belongs to before configuring (and `/api/plan` has no `/v1/models`, so discovery is always `[]` for it). The proxy appends `/chat/completions`, `/responses`, `/models` to the OpenAI base and `/v1/messages`, `/v1/models` to the Anthropic base — matching each ecosystem's own convention (Claude Code / the Anthropic SDK also append `/v1/messages`, which is why the Anthropic base excludes `/v1`). `upstreamTarget()` in proxy.ts owns this mapping.
- **Serving the web UI:** in prod, `createApp(store, { webDir })` serves the built `packages/web/dist` via `@hono/node-server/serve-static` with an SPA fallback to `index.html`. In dev, run the gateway (`npm run dev`) **and** vite (`npm run dev:web`); vite proxies `/v1` and `/admin` to `:7800`.
- **Distribution:** published to npm as `myapikey` (the workspace **root** is the publishable package). `bin` points at `packages/core/src/cli/index.ts` (shebang `#!/usr/bin/env tsx`), so `npx myapikey serve` (and the other subcommands) work with no compile step. Because the published tarball is the root, runtime deps (hono, `@hono/node-server`, `@hono/zod-validator`, commander, zod, **tsx**) are declared in the **root** `package.json` `dependencies`; `files` ships `packages/core/src` + `packages/web/dist` (web UI is optional — `serve` falls back to a plain-text banner if dist is absent). CLI profile lives at `~/.myapikey/client.json`; CLI env prefix is `MYAPIKEY_` (`MYAPIKEY_URL` / `_USER` / `_PASS` / `_API_KEY`). Workspace sub-packages use the `@myapikey/*` scope but are `private`.

## Key decisions (from requirements grilling — don't quietly revert these)

1. Routing is **by model name** with a priority-ordered provider list + failover (not provider-prefixed names, not abstract aliases).
2. Model list is **discover + enable**: fetch each backend's `/models`, explicitly enable the ones you want, order backends per model.
3. **Dual-surface pure passthrough**, no OpenAI↔Anthropic translation. (Contract is upgradeable: translation can be added later without changing the agent-facing endpoints.)
4. Deployment target: **LAN / home server**, no TLS by default.
5. Config is **service-owned** (admin API is the interface), persisted to **one JSON file**, no database.
6. **Account and API key are separate** (revised — was originally one shared password for both). The login password admins the web/CLI; a distinct `sk-myapikey-…` key authenticates agent calls to `/v1`. Split because the shared-password design caused persistent UI confusion (one string labeled as both "password" and "API key").
7. Web is **full CRUD** (equal to the CLI), not read-only.
8. Stack: **TypeScript/Hono + Vue 3** (user prefers Vue over React).

## Commands

```bash
npm install
npm run build:web      # build SPA into packages/web/dist
npm start              # tsx ... serve  (gateway on :7800)
npm run dev            # gateway, watch
npm run dev:web        # vite dev server (proxies API to :7800)
npm run typecheck      # core (tsc) + web (vue-tsc)
```

## Conventions

- ESM throughout; relative imports are extensionless (tsx + bundler resolution).
- Testing the gateway by hand: spin up a mock upstream and run `serve` on a scratch port with `--data-dir /tmp/myapikey`; clean up with `fuser -k <port>/tcp` (tsx forks a child node process — `kill <npx-pid>` does **not** stop the actual server).
- Keep it minimal — the user pushes back on over-engineering (layered auth, databases, etc.). Add complexity only when a concrete need shows up.
