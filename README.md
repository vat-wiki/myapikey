# MyAPIKey

A personal LLM API gateway that **forwards by protocol, never translates**. Point every agent at one address with one API key; each call is routed verbatim to a backend speaking the same wire format — OpenAI (`/chat/completions`, `/responses`) or Anthropic (`/messages`) — with failover across your configured backends. Pure directional passthrough: unlike aggregators that convert between OpenAI and Anthropic, nothing is transformed — what you send is what reaches the backend, and what it returns is what your client gets. Designed for agents and CLIs first, with a web UI as an equal citizen.

## What it does

- **One address, one key** — point any agent tool at `http://<host>:7800` and authenticate with the gateway's API key. Your login password is separate and only for the web UI.
- **Three endpoints, zero translation** — `/v1/chat/completions` + `/v1/responses` (OpenAI) and `/v1/messages` (Anthropic) are each forwarded verbatim. The gateway never converts between formats; a call only reaches backends that speak its format.
- **Model-name routing with failover** — call `model: "gpt-4o"`; among the backends that serve it *and speak the call's format*, route to the highest-priority one and fall over on 429 / 5xx / timeout.
- **Discover + enable, per protocol** — fetch each backend's model list, then enable a model on OpenAI and/or Anthropic independently. Each protocol has its own toggle and its own ordered source chain.
- **SSE streaming** — streamed responses pass straight through.
- **Single JSON file** — all config in one `data.json`. No database.
- **CLI + Web are equal clients** of the same admin API. Configure either way.

## How routing works

The gateway is a **directional forwarder, not a translator**. One rule explains everything else:

1. **The endpoint decides the format.** `/v1/chat/completions` and `/v1/responses` are OpenAI-format calls; `/v1/messages` is Anthropic-format. The request body is forwarded as-is.
2. **Format filters the backends, and enable is per-format.** For a given `model`, only backends you've marked as speaking that format are candidates. You enable OpenAI and Anthropic independently — a model can be on for one and off for the other — and each enabled format has its own ordered source chain.
3. **Priority + failover, within a format.** Candidates are tried in your priority order; on 429 / 5xx / timeout the next is tried, other 4xx are returned as-is, and once streaming starts there is no failover.
4. **`/responses` is opt-in.** It's an OpenAI-family endpoint most OpenAI-compatible backends don't implement, so a backend must additionally be marked "supports responses" to receive `/responses` calls.

The consequence: **call with a protocol no backend speaks for that model and you get a 404 — not a silent translation.** That's the trade for zero-loss passthrough (translation could be layered on later without changing the agent-facing endpoints).

This is the core difference from aggregators like OpenRouter or one-api, which convert between OpenAI and Anthropic request/response shapes.

## Quick start

Run it instantly with no install (publishes as `myapikey` on npm):

```bash
npx myapikey serve   # runs the gateway on http://localhost:7800
```

Or install globally:

```bash
npm install -g myapikey
myapikey serve
```

From source (for development):

```bash
npm install
npm run build:web        # build the Vue UI (one time, and after UI changes)
npm start                # runs the gateway on http://localhost:7800
```

On first run it prints a generated username/password (web login) **and an API key** (for agents), and saves them to `~/.config/myapikey/config.json` for the CLI.

### Configure via CLI

```bash
# add a backend. The OpenAI base includes the version segment (/v1, or a vendor's
# own like Ark's /api/v3); the Anthropic base excludes /v1 (https://api.anthropic.com,
# Ark's /api/coding) — one base per selected format.
myapikey provider add openrouter --base-url-openai https://openrouter.ai/api/v1 --key sk-or-... --formats openai
myapikey provider add claude --base-url-anthropic https://api.anthropic.com --key sk-ant-... --formats anthropic

# see what models it offers
myapikey provider models openrouter

# enable a model on a protocol (here OpenAI), routed through it
myapikey model enable gpt-4o-mini --format openai --via openrouter

# add a fallback backend for the same model+format, then set priority (left = primary)
myapikey provider add backup --base-url-openai https://api.example.com/v1 --key sk-... --formats openai
myapikey model add-provider gpt-4o-mini backup --format openai
myapikey model prioritize gpt-4o-mini openrouter backup --format openai

myapikey model list        # see the per-format routing table
```

When installed, `myapikey` is the `bin` entry pointing at the CLI. From source, `npm start` runs `serve`, and `npm run dev` runs `serve` with watch reload.

### Wire up an agent

```bash
# Show the connection info (base url + api key)
myapikey whoami
```

Then set, for an OpenAI-compatible tool (covers `/chat/completions` **and** `/responses`):

```bash
export OPENAI_BASE_URL=http://localhost:7800/v1
export OPENAI_API_KEY=<gateway api key>
```

Or for Anthropic / Claude Code:

```bash
export ANTHROPIC_BASE_URL=http://localhost:7800
export ANTHROPIC_API_KEY=<gateway api key>
```

`/v1` takes the API key (`Authorization: Bearer` or `x-api-key`); `/admin` takes the account password (HTTP Basic). Run `myapikey whoami` to see both. So whichever field a tool calls "API key", the **API key** goes there — not your login password.

Whichever endpoint you point a tool at, the gateway forwards in that tool's format and never translates — so make sure each model you call is backed by at least one source speaking that format (see [How routing works](#how-routing-works)).

## Web UI

Visit `http://localhost:7800`, sign in with your username/password. Full CRUD: manage backends, discover & enable models, drag-order priority (up/down), and watch recent calls. Same admin API the CLI uses.

## CLI reference

| Command | |
|---|---|
| `serve [--port 7800] [--data path] [--web-dir path]` | run the gateway |
| `whoami` | print connection info for agents |
| `provider add <name> --base-url-openai URL [--base-url-anthropic URL] --key KEY --formats openai,anthropic` | add a backend |
| `provider list` | list backends |
| `provider models <ref>` | discover models offered by a backend |
| `provider remove <ref>` | remove a backend (id or name) |
| `model enable <name> --format <fmt> [--via <ref>]` | enable a model on a protocol (openai/anthropic) |
| `model disable <name> --format <fmt>` | disable one protocol (keeps config) |
| `model list` | show the per-format routing table |
| `model add-provider <name> <ref> --format <fmt>` | add a fallback backend for a protocol |
| `model remove-provider <name> <ref> --format <fmt>` | remove a backend from a protocol |
| `model prioritize <name> <ref>... --format <fmt>` | set source order for a protocol |
| `model remove <name>` | remove a model entirely (both protocols) |
| `call <model> [prompt...]` | quick test through the gateway |

Global flags: `-u/--url`, `--user`, `--pass`, `--api-key` (or `MYAPIKEY_URL` / `MYAPIKEY_USER` / `MYAPIKEY_PASS` / `MYAPIKEY_API_KEY` env vars).

## API surface

- `POST /v1/chat/completions` — OpenAI-format proxy (API key)
- `POST /v1/responses` — OpenAI Responses API (API key; only sources marked "supports responses")
- `POST /v1/messages` — Anthropic-format proxy (API key)
- `GET /v1/models` — models enabled on the OpenAI path, OpenAI list shape (Anthropic-only models aren't listed here — call them via `/v1/messages`)
- `/admin/providers`, `/admin/models`, `/admin/logs`, `/admin/account`, `/admin/api-key` — config API (account password)
- `GET /health` — public liveness check

## Development

```bash
npm run dev          # gateway with watch reload (port 7800)
npm run dev:web      # vite dev server (proxies /v1 and /admin to :7800)
npm run typecheck    # tsc (core) + vue-tsc (web)
```

## Notes / non-goals

- **No OpenAI↔Anthropic translation.** If a backend doesn't speak the format an agent used, that call fails. (Addable later without changing the agent contract.)
- **No database.** One `data.json`; recent calls are an in-memory ring buffer.
- **No TLS.** Intended for LAN / home-server use behind your own network. Put it behind a reverse proxy with TLS if you expose it beyond.
- The account (login) password and the API key are **separate**. The API key is what agents use; rotate it (`POST /admin/api-key/rotate` or the web UI) if a tool's config leaks. Don't hand either to untrusted code paths.
