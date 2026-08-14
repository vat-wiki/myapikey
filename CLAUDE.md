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

- **Storage:** `Store` (server/store.ts) owns a single **data directory** (default `~/.myapikey`, resolved at boot as `--data-dir` flag → `MYAPIKEY_DATA_DIR` env → `DEFAULT_DATA_DIR`). It holds `data.json` (the config, cached in memory, write-through on `update()`, serialized by a promise chain) and `logs.jsonl` (call history, one JSON object per line, retained up to ~90 days / 1M lines — `store.getLogs()` returns the most recent ~200 via a **tail read** for the Logs timeline, and `store.getStats(rangeMs)` aggregates the full retained history for `GET /admin/stats`; never held in memory). `store.getPaths()` exposes the resolved locations for the read-only display at `GET /admin/storage`. The CLI client profile lives at `~/.myapikey/client.json` (pinned to the default home, not the `--data-dir` override; legacy `~/.config/myapikey/config.json` is read as a fallback). On every startup `store.writeCredentialsFile()` writes a human-readable `credentials.txt` (web login + the agent api key) into the data dir — so the first-run login is recoverable even if the startup terminal is gone (closed / daemon / container); the first-run banner prints the creds and points to the file.
- **Auth:** two independent secrets. The **account** `{username, password}` gates `/admin` (HTTP Basic — web login + CLI config). The **API key** (`sk-myapikey-…`, `GateConfig.apiKey`) gates the two agent surfaces `/openai/v1` + `/anthropic/v1` (`Authorization: Bearer` or `x-api-key`). Neither works on the other's surface (`authMiddleware` vs `apiKeyMiddleware` in `auth.ts`). Each middleware is attached **inside** its sub-app before its routes (Hono only runs middleware registered before the route — this bit us once); the one deliberate exception is `GET …/v1/models` on both agent surfaces, which is a **public** discovery read (registered *before* the auth middleware in `proxyApi`) — it leaks only the enabled model names + `owned_by`, like `/health`. Rotate the API key via `POST /admin/api-key/rotate`.
- **Routing:** `/openai/v1/chat/completions`, `/openai/v1/responses`, and `/anthropic/v1/messages` all go through `dispatch()` (proxy.ts): parse body → look up `models[model]` → iterate `providers` in priority order, filtered by the requested `Format` → forward; **fail over** on 429/5xx/network, **return as-is** on other 4xx, **no failover once streaming has started**. Bodies are forwarded verbatim (re-stringified after parsing `model`); responses stream `upstream.body` straight through. The two surfaces are **separate sub-apps** (`proxyApi` returns `{ openai, anthropic }`), each with its own `/models`: `/openai/v1/models` lists openai-enabled models, `/anthropic/v1/models` lists anthropic-enabled ones — the split exists so an Anthropic client can discover its own models (a shared `/v1/models` couldn't tell the two apart). `/responses` is an openai-family endpoint **not implied by `format`** — it only routes to providers with `supportsResponses` set (most openai-compatible backends don't implement it).
- **Admin API** (`admin.ts`) is the single source of config truth; CLI and web are both clients. A provider has a **base URL per format**: `baseUrlOpenai` (incl. the version segment, e.g. `/v1` or Ark's `/api/v3`) and `baseUrlAnthropic` (**excl.** `/v1`, e.g. `https://api.anthropic.com`, or Volcengine Ark's coding-plan base `…/api/plan`). Ark has **two distinct surfaces with different credentials**: `/api/v3` (general API, takes a normal API key) vs `/api/plan` (coding-plan token, anthropic-only) — a plan token 401s on `/api/v3` and vice-versa, so confirm which surface a key belongs to before configuring (and `/api/plan` has no `/v1/models`, so discovery is always `[]` for it). The proxy appends `/chat/completions`, `/responses`, `/models` to the OpenAI base and `/v1/messages`, `/v1/models` to the Anthropic base — matching each ecosystem's own convention (Claude Code / the Anthropic SDK also append `/v1/messages`, which is why the Anthropic base excludes `/v1`). `upstreamTarget()` in proxy.ts owns this mapping.
- **Serving the web UI:** in prod, `createApp(store, { webDir })` serves the built `packages/web/dist` via `@hono/node-server/serve-static` with an SPA fallback to `index.html`. In dev, run the gateway (`npm run dev`) **and** vite (`npm run dev:web`); vite proxies `/openai`, `/anthropic`, and `/admin` to `:7800`.
- **Distribution:** published to npm as `myapikey` (the workspace **root** is the publishable package). `bin` points at `packages/core/src/cli/index.ts` (shebang `#!/usr/bin/env tsx`), so `npx myapikey serve` (and the other subcommands) work with no compile step. Because the published tarball is the root, runtime deps (hono, `@hono/node-server`, `@hono/zod-validator`, commander, zod, **tsx**) are declared in the **root** `package.json` `dependencies`; `files` ships `packages/core/src` + `packages/web/dist` (web UI is optional — `serve` falls back to a plain-text banner if dist is absent). CLI profile lives at `~/.myapikey/client.json`; CLI env prefix is `MYAPIKEY_` (`MYAPIKEY_URL` / `_USER` / `_PASS` / `_API_KEY`). Workspace sub-packages use the `@myapikey/*` scope but are `private`. Publishing, tagging, and GitHub Releases are all CI-driven (see Conventions): a push to `main` that introduces a new version auto-publishes to npm and creates the `vX.Y.Z` git tag + GitHub Release.

## Key decisions (from requirements grilling — don't quietly revert these)

1. Routing is **by model name** with a priority-ordered provider list + failover (not provider-prefixed names, not abstract aliases).
2. Model list is **discover + enable**: fetch each backend's `/models`, explicitly enable the ones you want, order backends per model.
3. **Dual-surface pure passthrough**, no OpenAI↔Anthropic translation. (Contract is upgradeable: translation can be added later without changing the agent-facing endpoints.)
4. Deployment target: **LAN / home server**, no TLS by default.
5. Config is **service-owned** (admin API is the interface), persisted to **one JSON file**, no database.
6. **Account and API key are separate** (revised — was originally one shared password for both). The login password admins the web/CLI; a distinct `sk-myapikey-…` key authenticates agent calls to `/openai/v1` + `/anthropic/v1`. Split because the shared-password design caused persistent UI confusion (one string labeled as both "password" and "API key").
7. Web is **full CRUD** (equal to the CLI), not read-only.
8. Stack: **TypeScript/Hono + Vue 3** (user prefers Vue over React).

## Commands

```bash
npm install
npm run build:web      # build SPA into packages/web/dist
npm start              # tsx ... serve  (gateway on :7800)
npm run dev            # gateway, watch
npm run dev:web        # vite dev server (proxies API to :7800)
npm run typecheck      # core src + core tests (tsc) + web (vue-tsc)
npm test               # vitest run  (unit + integration, ~200 tests)
npm run test:watch     # vitest in watch mode
npm run test:coverage  # vitest with v8 coverage
npm run test:e2e       # playwright (real gateway process + mock upstream)
```

## Testing

Three tiers, run by default as part of `npm test` + `npm run test:e2e`:

- **Unit / integration (Vitest)** — `packages/core/test/**` + `packages/web/test/**`. Vitest resolves the extensionless `.ts` source the same way tsx does (no compile step). Explicit imports only (`import { describe, it, expect, vi } from "vitest"`) — no globals. Web tests that touch `localStorage`/`document` opt into jsdom with a leading `// @vitest-environment jsdom` line.
  - Shared helpers live in `packages/core/test/helpers/`: `store.ts` (temp-dir `Store` factories), `mock.ts` (`mockFetch(routes)` — replaces `globalThis.fetch` with a recording spy returning real `Response`s; `.restore()` in `afterEach`), `fixtures.ts` (`makeProvider`/`fe`/`makeModel`/`makeLog`/`buildConfig`/`seedStore`), `json.ts` (typed `json<T>(res)` for response bodies). Hono apps are driven in-process via `app.request(...)` — no port.
  - Coverage: `shared/config`, `auth` (+ cross-secret isolation), `app` wiring/webDir fallback, `store` (migrations v1→v4, logs tail-read/trim, stats aggregation, circuit-breaker escalation), `proxy.dispatch` (failover, model-mapping, circuit skip, `/openai/v1/models` + `/anthropic/v1/models`), the full `/admin` CRUD, CLI `client`/`config`, and web `api`/`lib`.
- **End-to-end (Playwright)** — `tests/e2e/`. `world.ts` boots a REAL `tsx … serve` child process (own process group, torn down cleanly) on `:7807` against a throwaway data dir, plus a scripted mock upstream on `:7808`; `gateway.spec.ts` drives real HTTP (health, the two auth surfaces' isolation, routing, failover, `/openai/v1/models`). Not under Vitest's `include`, so the two runners never collide.
- **Typecheck covers tests too** — `packages/core/tsconfig.test.json` (src+test) is wired into `npm run typecheck`, so latent type errors in tests fail the gate (Vitest's esbuild strips types without checking).

Three subtle behaviors the suite pinned down (asserted as the code actually behaves, not as one might assume):

1. **Stats future-ts skew guard is windowed only.** `getStats` drops entries with `ts > now+60s` only when `rangeMs > 0`; the "all history" query (`rangeMs === 0`) returns everything including future-dated rows.
2. **All-providers-fail logs the last *upstream* status.** When every provider fails, the client gets a `502` but the logged row's `status` is the last upstream status seen (e.g. `500`), not `502`.
3. **`POST /admin/providers/:id/discover` never 502s.** `refreshDiscovery()` swallows fetch errors and returns `[]`, so the endpoint's `catch → 502` branch is unreachable — a failed upstream yields `200 { models: [] }`. (Graceful degradation; flagged in case the 502 was meant to surface failures.)

## Conventions

- ESM throughout; relative imports are extensionless (tsx + bundler resolution).
- Testing the gateway by hand: spin up a mock upstream and run `serve` on a scratch port with `--data-dir /tmp/myapikey`; clean up with `fuser -k <port>/tcp` (tsx forks a child node process — `kill <npx-pid>` does **not** stop the actual server).
- Keep it minimal — the user pushes back on over-engineering (layered auth, databases, etc.). Add complexity only when a concrete need shows up.
- Work directly on the `main` branch, and `git push` to `origin main` after each development task completes.
- **Bump the version before every push that changes the shipped package.** After a task's code changes, bump the version as a separate `chore(release): vX.Y.Z` commit, then push both together. Feature → minor bump, fix/chore → patch. Run `npm version 0.x.y --no-git-tag-version` (it updates the version field in both `package.json` and `package-lock.json`), commit, push — do **not** pass `--git-tag-version`: CI creates the tag + release (below). Pure tooling/docs/CI changes that don't touch the published tarball (`.github/`, `CLAUDE.md`, tests-only) need **no** version bump — a bump there would ship a code-identical npm release and a pointless GitHub Release. Only the **root** package is versioned (it's the publishable `myapikey`) — the `@myapikey/*` workspace sub-packages stay pinned at `0.1.0`.
- **Release pipeline is CI-driven** (`.github/workflows/ci.yml`): when a push to `main` introduces a version not yet on npm, the `publish` job publishes `myapikey@X.Y.Z` to npm (with provenance), and the `release` job creates the `vX.Y.Z` git tag (pointing at the release commit) + a GitHub Release with auto-generated notes. So after you bump + push, **do not** manually `npm publish`, `git tag`, or `gh release create` — CI does all three, idempotently (each step skips if the version/release already exists, so a re-run or a no-op push stays green). The agent's per-task flow is unchanged: bump → `chore(release)` commit → push.
