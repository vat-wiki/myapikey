# CLAUDE.md — my-ai-gate

Personal LLM API gateway. One address + one password → all configured models, pure passthrough.

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

- **Storage:** `Store` (server/store.ts) owns a single JSON file (`data.json`), cached in memory, write-through on `update()`, serialized by a promise chain. Recent calls live in an in-memory ring buffer (`store.logs`), not persisted.
- **Auth:** single `{username, password}`. `auth.ts` accepts the password from `Authorization: Bearer`, `x-api-key`, or HTTP Basic. The middleware is attached **inside** each sub-app before its routes (Hono only runs middleware registered before the route — this bit us once).
- **Routing:** `/v1/chat/completions` and `/v1/messages` both go through `dispatch()` (proxy.ts): parse body → look up `models[model]` → iterate `providers` in priority order, filtered by the requested `Format` → forward; **fail over** on 429/5xx/network, **return as-is** on other 4xx, **no failover once streaming has started**. Bodies are forwarded verbatim (re-stringified after parsing `model`); responses stream `upstream.body` straight through.
- **Admin API** (`admin.ts`) is the single source of config truth; CLI and web are both clients. Provider `baseUrl` **includes `/v1`**; the proxy appends `/chat/completions`, `/messages`, `/models`.
- **Serving the web UI:** in prod, `createApp(store, { webDir })` serves the built `packages/web/dist` via `@hono/node-server/serve-static` with an SPA fallback to `index.html`. In dev, run the gateway (`npm run dev`) **and** vite (`npm run dev:web`); vite proxies `/v1` and `/admin` to `:7800`.

## Key decisions (from requirements grilling — don't quietly revert these)

1. Routing is **by model name** with a priority-ordered provider list + failover (not provider-prefixed names, not abstract aliases).
2. Model list is **discover + enable**: fetch each backend's `/models`, explicitly enable the ones you want, order backends per model.
3. **Dual-surface pure passthrough**, no OpenAI↔Anthropic translation. (Contract is upgradeable: translation can be added later without changing the agent-facing endpoints.)
4. Deployment target: **LAN / home server**, no TLS by default.
5. Config is **service-owned** (admin API is the interface), persisted to **one JSON file**, no database.
6. **Single account/password** for both calling and admin — simplicity over compartmentalization (explicit user call).
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
- Testing the gateway by hand: spin up a mock upstream and run `serve` on a scratch port with `--data /tmp/x.json`; clean up with `fuser -k <port>/tcp` (tsx forks a child node process — `kill <npx-pid>` does **not** stop the actual server).
- Keep it minimal — the user pushes back on over-engineering (layered auth, databases, etc.). Add complexity only when a concrete need shows up.
