# MyAPIKey

[![npm version](https://img.shields.io/npm/v/myapikey?logo=npm)](https://www.npmjs.com/package/myapikey)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![node](https://img.shields.io/badge/node.js-%3E%3D18-339933?logo=node.js&logoColor=white)](#quick-start)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](#development)

English | [简体中文](README.zh-CN.md)

**One address, one key, all your models — without translation.**

MyAPIKey is a personal LLM gateway. Point every AI tool you use (Claude Code, OpenAI-compatible CLIs, editors, scripts) at a single local address with a single API key. Each call is forwarded **as-is** to a backend that speaks the same wire format, with automatic failover when a backend is down. Nothing is converted between OpenAI and Anthropic formats — what you send is exactly what reaches the backend.

> Built for a home server / LAN. No database, no TLS by default, no translation layer — just a thin, transparent forwarder you fully control.

---

## Table of contents

- [What is this, and who is it for?](#what-is-this-and-who-is-it-for)
- [Quick start](#quick-start)
- [Add your first backend](#add-your-first-backend)
- [Connect a tool](#connect-a-tool)
- [How routing works](#how-routing-works)
- [Model name mapping](#model-name-mapping)
- [Web UI](#web-ui)
- [CLI reference](#cli-reference)
- [API surface](#api-surface)
- [Storage](#storage)
- [Development](#development)
- [Notes and non-goals](#notes-and-non-goals)

---

## What is this, and who is it for?

If any of these sound familiar, MyAPIKey is for you:

- You juggle **several API keys** across OpenAI, Anthropic, OpenRouter, a local model, etc., and you're tired of pasting a different one into every tool.
- You want **one stable address** for your agents, even when the provider behind it changes.
- You want **automatic fallback** — if your primary backend rate-limits or goes down, the next one takes over.
- You want to **rename or swap a model** without editing every tool's config.
- You'd like a **log of every call** (latency, status, which backend served it).

MyAPIKey gives you all of that. You keep your real provider keys inside the gateway; your tools only ever know `http://<host>:7800` and one `sk-myapikey-…` key.

**The one thing to know up front:** the gateway **forwards in your tool's native format and never translates**. A call to the OpenAI endpoint reaches an OpenAI-speaking backend; a call to the Anthropic endpoint reaches an Anthropic-speaking backend. This keeps your requests and responses lossless. (See [How routing works](#how-routing-works) once you're set up.)

---

## Quick start

Requires **Node.js 18+**. No install needed — run it straight from npm:

```bash
npx myapikey serve          # → http://localhost:7800
```

Or install it globally:

```bash
npm install -g myapikey
myapikey serve
```

On first run it prints generated credentials **and saves them to a file** so you can't lose them:

```
  First run — here are your credentials (save them):
    username : <random>     (web login)
    password : <random>     (web login)
    api key  : sk-myapikey-…  (put this in the tool's "api key" field)
  ↳ also written to ~/.myapikey/credentials.txt
```

Open `http://localhost:7800` in a browser and sign in with the **username / password** to reach the web UI. The **API key** is separate — that's what your AI tools use later.

> Forgot the credentials? `cat ~/.myapikey/credentials.txt` (regenerated on every start). Override the data location with `--data-dir <path>` or the `MYAPIKEY_DATA_DIR` env var.

That's the gateway running. Next, give it a backend to forward to.

---

## Add your first backend

A **backend** (provider) is one upstream API: OpenAI, Anthropic, OpenRouter, a local Ollama, a vendor like Volcengine Ark, etc. You add it once with its real key, then enable models through it.

### Easiest: the web UI

1. Open the **Models** tab → **Add backend**.
2. Enter a name, the backend's base URL(s), and its API key.
3. Pick the wire format(s) it speaks: `openai`, `anthropic` (or both).
4. Save, then click **discover** to pull its model list.
5. **Enable** the models you want, per format slot.

### Or, the CLI

```bash
# An OpenAI-compatible backend. The OpenAI base includes the version segment
# (e.g. /v1, or a vendor's own like Ark's /api/v3).
myapikey provider add openai-direct \
  --base-url-openai https://api.openai.com/v1 \
  --key sk-... \
  --formats openai

# An Anthropic backend. The Anthropic base EXCLUDES /v1
# (https://api.anthropic.com, or Ark's /api/plan).
myapikey provider add anthropic-direct \
  --base-url-anthropic https://api.anthropic.com \
  --key sk-ant-... \
  --formats anthropic

# See what each offers, then enable a model on a slot:
myapikey provider models openai-direct
myapikey model enable gpt-4o-mini --format openai --via openai-direct
```

That model is now reachable through the gateway. To add a **fallback** for the same model (used when the first one fails), add another backend and chain it:

```bash
myapikey provider add backup --base-url-openai https://api.openrouter.ai/api/v1 --key sk-or-... --formats openai
myapikey model add-provider gpt-4o-mini backup --format openai
myapikey model prioritize gpt-4o-mini openai-direct backup --format openai   # left = primary
myapikey model list        # see the routing table
```

> `--format` selects the routing **slot**: `openai` (for `/openai/v1/chat/completions`), `anthropic` (for `/anthropic/v1/messages`), or `responses` (for `/openai/v1/responses`). The `responses` slot only accepts backends you've marked **supportsResponses** — set that toggle in the web UI (the CLI doesn't expose it yet).

---

## Connect a tool

Once a model is enabled, point any agent at the gateway. Get your connection info:

```bash
myapikey whoami      # prints base url + api key + ready-to-paste env lines
```

For an **OpenAI-compatible** tool (covers `/chat/completions` *and* `/responses`):

```bash
export OPENAI_BASE_URL=http://localhost:7800/openai/v1
export OPENAI_API_KEY=<gateway api key>
```

For **Anthropic / Claude Code**:

```bash
export ANTHROPIC_BASE_URL=http://localhost:7800/anthropic
export ANTHROPIC_API_KEY=<gateway api key>
```

> Whatever a tool calls its "API key" field, put the **gateway API key** there — *not* your web login password. The login password is only for the web UI and CLI admin commands.

Quick smoke test without any tool:

```bash
myapikey call gpt-4o-mini "Say hello in one sentence."
```

**Why two base URLs?** The gateway exposes two separate agent surfaces — `/openai/v1` and `/anthropic/v1` — each with its own `GET /models` (an OpenAI client discovers only openai-enabled models, an Anthropic client only anthropic-enabled ones). Each ecosystem's SDK appends its own paths, so the OpenAI SDK points at `…/openai/v1` (it appends `/chat/completions`, `/responses`, `/models`) and the Anthropic SDK / Claude Code points at `…/anthropic` (it appends `/v1/messages`, `/v1/models`).

**Raw HTTP** (no SDK) — hit either surface directly with the gateway API key as a `Bearer` token:

```bash
# OpenAI family
curl http://localhost:7800/openai/v1/chat/completions \
  -H "Authorization: Bearer <gateway api key>" -H "Content-Type: application/json" \
  -d '{"model":"<model>","messages":[{"role":"user","content":"hi"}]}'

# Anthropic family
curl http://localhost:7800/anthropic/v1/messages \
  -H "Authorization: Bearer <gateway api key>" -H "Content-Type: application/json" \
  -d '{"model":"<model>","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}'
```

Whichever endpoint you point a tool at, the gateway forwards in that format and never translates — so make sure each model you call is backed by at least one source on the matching slot ([see below](#how-routing-works)).

---

## How routing works

The gateway is a **directional forwarder, not a translator**. Four rules explain everything:

1. **The endpoint picks the slot.** `/openai/v1/chat/completions` → the **openai** slot. `/openai/v1/responses` → the **responses** slot. `/anthropic/v1/messages` → the **anthropic** slot. Each is a distinct wire format, and the body is forwarded verbatim — nothing is converted.

2. **Each model has three independent slots.** For one model you can enable `openai`, `responses`, and `anthropic` separately, and each has its own ordered source chain. Enable a model only on the slots its backends actually speak.

3. **A source qualifies per slot.** The `openai` and `anthropic` slots accept sources carrying that wire format; the `responses` slot only accepts sources marked `supportsResponses` (most OpenAI-compatible backends don't implement the Responses API). A `supportsResponses` source can sit in the **openai** chain *and* the **responses** chain at once.

4. **Priority + failover, within a slot.** Candidates are tried in your priority order. On `429` / `5xx` / timeout, the gateway tries the next one — and the failing source enters a brief **circuit-breaker cooldown** (exponential, 30 s → 5 min) so later calls skip it until it recovers; a success closes the circuit. Other `4xx` errors are returned as-is (they're the caller's fault, not the backend's). Once streaming has started, there's no failover.

**The trade-off this buys you:** call an endpoint no source serves for that model and you get a `404` — not a silent translation. That's the price of zero-loss passthrough. (Translation could be layered on later without changing the agent-facing endpoints.)

This is the core difference from aggregators like OpenRouter or one-api, which convert between OpenAI and Anthropic request/response shapes.

---

## Model name mapping

Sometimes the name a tool asks for isn't the name the backend expects. MyAPIKey can **rewrite the model name per source**, on the way through — still pure passthrough, no format translation.

Set it in the web UI (**Models** tab): when adding a source, there's an **upstream model** field; or edit it inline on any chain member. (Not exposed in the CLI yet.)

Use it to:

- **Alias a friendly name to a versioned id** — expose `claude-sonnet-4` to your tools, while the gateway sends `claude-sonnet-4-20250514` upstream.
- **Point one public name at different real models per source** — e.g. your `gpt-4` slot's primary source sends `gpt-4o`, its fallback sends `gpt-4-turbo`.
- **Bridge naming quirks** between two backends that implement the "same" model under different ids.

If no mapping is set for a source, the public model name is sent unchanged.

---

## Web UI

Visit `http://localhost:7800`, sign in with your username/password. Ships in **English and Chinese** (toggle in the top bar). Five tabs:

- **Connect** — copy-paste base URL / API key / login, plus ready-to-use SDK env lines.
- **Models** — full CRUD: add sources, discover & enable models per slot, drag-order priority, toggle each slot, set [model name mapping](#model-name-mapping), and run an end-to-end **test** call against any model + slot.
- **Logs** — live recent-calls timeline (latency, status, source, format), with circuit-breaker cooldown events shown alongside the failures that triggered them.
- **Stats** — aggregate call counts / success rate / latency (p50, p95) by model, source, format, and day, over a selectable range (24h / 7d / 30d / 90d / all).
- **Settings** — rotate the API key, change the account password, view/reset circuit-breaker state, and see where `data.json` + `logs.jsonl` live.

It's the same admin API the CLI uses — configure either way.

---

## CLI reference

| Command | |
|---|---|
| `serve [--port 7800] [--data-dir <dir>] [--web-dir <path>]` | run the gateway |
| `whoami` | print connection info for agents (base url, api key, login, example env) |
| `provider add <name> --base-url-openai URL [--base-url-anthropic URL] --key KEY --formats openai,anthropic` | add a backend (set `supportsResponses` in the web UI) |
| `provider list` | list backends |
| `provider models <ref>` | discover models offered by a backend |
| `provider remove <ref>` | remove a backend (id or name) |
| `model enable <name> --format <fmt> [--via <ref>]` | enable a model on a slot (openai / anthropic / responses) |
| `model disable <name> --format <fmt>` | disable one slot (keeps config) |
| `model list` | show the per-slot routing table |
| `model add-provider <name> <ref> --format <fmt>` | add a fallback source for a slot |
| `model remove-provider <name> <ref> --format <fmt>` | remove a source from a slot |
| `model prioritize <name> <ref>... --format <fmt>` | set source order for a slot (left = primary) |
| `model remove <name>` | remove a model entirely (all slots) |
| `call <model> [prompt...]` | quick test through the gateway (OpenAI path) |

`<ref>` is a provider id or name. Global flags: `-u/--url`, `--user`, `--pass`, `--api-key` (or `MYAPIKEY_URL` / `MYAPIKEY_USER` / `MYAPIKEY_PASS` / `MYAPIKEY_API_KEY` env vars).

---

## API surface

**Agent-facing (two surfaces, one API key — `Authorization: Bearer` or `x-api-key`):**

- `POST /openai/v1/chat/completions` — OpenAI-format proxy
- `POST /openai/v1/responses` — OpenAI Responses API (only sources marked `supportsResponses`)
- `GET /openai/v1/models` — models enabled on the **openai** slot, OpenAI list shape
- `POST /anthropic/v1/messages` — Anthropic-format proxy
- `GET /anthropic/v1/models` — models enabled on the **anthropic** slot, OpenAI list shape
- `GET /health` — public liveness check

**Admin (`/admin`, account password — HTTP Basic):**

- `/admin/account` `GET` / `PUT` — read or change username/password (either field optional)
- `/admin/api-key` `GET`, `/admin/api-key/rotate` `POST` — the key agents use
- `/admin/connection` `GET` — detected LAN IP (for pointing other machines at the gateway)
- `/admin/providers`, `/admin/providers/:id` `POST`/`PUT`/`DELETE`, `/admin/providers/:id/discover` `POST` — backend CRUD + model discovery
- `/admin/models`, `/admin/models/:name/{providers,priority,map,disable,test}` — routing-table CRUD, [per-source name mapping](#model-name-mapping), and end-to-end test
- `/admin/logs` `GET` — recent calls (tail of the on-disk log)
- `/admin/stats?range=24h|7d|30d|90d|all` `GET` — aggregate stats over retained history
- `/admin/storage` `GET` — where `data.json` + `logs.jsonl` live
- `/admin/circuit` `GET`, `/admin/circuit/:id/reset` `POST` — circuit-breaker snapshot + manual reset

---

## Storage

Everything lives in one data directory (default `~/.myapikey`):

| File | Contents |
|---|---|
| `data.json` | all config — providers, the per-model routing table, account, API key |
| `logs.jsonl` | call history, one JSON object per line (retained ~90 days / 1 M lines) |
| `credentials.txt` | human-readable web login + API key, regenerated on every startup |
| `client.json` | CLI client profile (base url + login + API key) |

Override the directory with `--data-dir <path>` or `MYAPIKEY_DATA_DIR`. Call logs are never held in memory: the Logs timeline tail-reads the newest ~200 entries, and stats stream over the full retained file on demand.

---

## Development

```bash
npm install
npm run build:web      # build the Vue UI into packages/web/dist (one time, and after UI changes)
npm start              # tsx ... serve  (gateway on :7800)
npm run dev            # gateway, with watch reload
npm run dev:web        # vite dev server (proxies /openai, /anthropic, and /admin to :7800)
npm run typecheck      # tsc (core) + vue-tsc (web)
```

Testing the gateway by hand: spin up a mock upstream and run `serve` on a scratch port with `--data-dir /tmp/myapikey`.

---

## Notes and non-goals

- **No OpenAI↔Anthropic translation.** If a backend doesn't speak the format an agent used, that call fails (`404`). Addable later without changing the agent contract.
- **No database.** One `data.json` for config; `logs.jsonl` for retained call history.
- **No TLS.** Intended for LAN / home-server use on your own network. Put it behind a reverse proxy with TLS if you expose it beyond that.
- **The login password and the API key are separate.** The API key is what agents use; rotate it (`POST /admin/api-key/rotate` or the web UI) if a tool's config leaks. Don't hand either to untrusted code.
