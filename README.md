# MyAPIKey

A personal LLM API gateway that **forwards by protocol, never translates**. Point every agent at one address with one API key; each call is routed verbatim to a backend speaking the same wire format — OpenAI (`/chat/completions`, `/responses`) or Anthropic (`/messages`) — with failover and a circuit breaker across your configured backends. Pure directional passthrough: unlike aggregators that convert between OpenAI and Anthropic, nothing is transformed — what you send is what reaches the backend, and what it returns is what your client gets. Designed for agents and CLIs first, with a web UI as an equal citizen.

## What it does

- **One address, one key** — point any agent tool at `http://<host>:7800` and authenticate with the gateway's API key. Your login password is separate and only for the web UI / CLI.
- **Three endpoints, zero translation** — `/v1/chat/completions` (OpenAI), `/v1/responses` (OpenAI Responses), and `/v1/messages` (Anthropic) are each forwarded verbatim. The gateway never converts between formats; a call only reaches backends that speak its format.
- **Per-slot routing with failover** — each model has **three independent routing slots** (`openai`, `responses`, `anthropic`), each with its own enable flag and ordered source chain. Within a slot, route to the highest-priority source and fall over on 429 / 5xx / timeout.
- **Circuit breaker** — a source that fails transiently enters an exponential cooldown (30 s → 5 min) and is skipped until it recovers, so flaky backends stop poisoning your calls.
- **Discover + enable, per slot** — fetch each backend's model list, then enable a model on whichever slots you want. Each slot has its own toggle and source chain.
- **SSE streaming** — streamed responses pass straight through.
- **Call history + stats** — every call is logged to disk (~90-day / 1 M-line retention); the web UI shows a recent-calls timeline and aggregate stats by model / source / format / day, with latency percentiles.
- **Single JSON file** — all config in one `data.json`. No database.
- **CLI + Web are equal clients** of the same admin API (web UI ships in English and Chinese). Configure either way.

## How routing works

The gateway is a **directional forwarder, not a translator**. One rule explains everything else:

1. **The endpoint decides the slot.** `/v1/chat/completions` → the **openai** slot; `/v1/responses` → the **responses** slot; `/v1/messages` → the **anthropic** slot. Each is a distinct wire format, and the request body is forwarded as-is — nothing is converted.
2. **Each model has three independent slots.** For a given model you can enable **openai**, **responses**, and **anthropic** separately, and each has its own ordered source chain. Enable a model on just the slots its backends actually speak.
3. **A source qualifies per slot.** openai/anthropic slots accept sources carrying that wire format; the **responses** slot only accepts sources you've marked `supportsResponses` (most OpenAI-compatible backends don't implement the Responses API). A `supportsResponses` source can sit in the **openai** chain *and* the **responses** chain at once.
4. **Priority + failover, within a slot.** Candidates are tried in your priority order. On 429 / 5xx / timeout the gateway tries the next — and the failing source enters a brief **circuit-breaker cooldown** (exponential, 30 s → 5 min) so subsequent calls skip it until it recovers; a success closes the circuit. Other 4xx are returned as-is. Once streaming has started there is no failover.

The consequence: **call an endpoint no source serves for that model and you get a 404 — not a silent translation.** That's the trade for zero-loss passthrough (translation could be layered on later without changing the agent-facing endpoints).

This is the core difference from aggregators like OpenRouter or one-api, which convert between OpenAI and Anthropic request/response shapes.

## Quick start

Run it instantly with no install (published as `myapikey` on npm):

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

On first run it prints a generated username/password (web login) **and an API key** (for agents), and writes them — plus a `credentials.txt` you can `cat` anytime you forget — into the data dir (`~/.myapikey` by default; override with `--data-dir` or `MYAPIKEY_DATA_DIR`). The CLI profile is saved to `~/.myapikey/client.json` so client commands work without flags.

### Configure via CLI

```bash
# add a backend. The OpenAI base includes the version segment (/v1, or a vendor's
# own like Ark's /api/v3); the Anthropic base excludes /v1 (https://api.anthropic.com,
# Ark's /api/plan) — one base per selected format.
myapikey provider add openrouter --base-url-openai https://openrouter.ai/api/v1 --key sk-or-... --formats openai
myapikey provider add claude --base-url-anthropic https://api.anthropic.com --key sk-ant-... --formats anthropic

# see what models it offers
myapikey provider models openrouter

# enable a model on a slot (here openai), routed through it
myapikey model enable gpt-4o-mini --format openai --via openrouter

# add a fallback source for the same model+slot, then set priority (left = primary)
myapikey provider add backup --base-url-openai https://api.example.com/v1 --key sk-... --formats openai
myapikey model add-provider gpt-4o-mini backup --format openai
myapikey model prioritize gpt-4o-mini openrouter backup --format openai

myapikey model list        # see the per-slot routing table
```

`--format` takes `openai`, `anthropic`, or `responses`. To use the **responses** slot, mark a source `supportsResponses` in the web UI (the CLI `provider add` doesn't expose that flag yet) — then `myapikey model enable <model> --format responses --via <source>`.

When installed, `myapikey` is the `bin` entry pointing at the CLI. From source, `npm start` runs `serve`, and `npm run dev` runs `serve` with watch reload.

### Wire up an agent

```bash
myapikey whoami     # prints base url + api key (+ login, + ready-to-paste env lines)
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

`/v1` takes the API key (`Authorization: Bearer` or `x-api-key`); `/admin` takes the account password (HTTP Basic). So whichever field a tool calls "API key", the **API key** goes there — not your login password.

Whichever endpoint you point a tool at, the gateway forwards in that tool's format and never translates — so make sure each model you call is backed by at least one source speaking that format on that slot (see [How routing works](#how-routing-works)).

## Web UI

Visit `http://localhost:7800`, sign in with your username/password. Five tabs:

- **Connect** — copy-paste base URL / API key / login, plus ready-to-use SDK env lines.
- **Models** — full CRUD: add sources, discover & enable models per slot, drag-order priority, toggle each slot, and run an end-to-end **test** call against any model+slot.
- **Logs** — live recent-calls timeline (latency, status, source, format), with circuit-breaker cooldown events shown alongside the failures that triggered them.
- **Stats** — aggregate call counts / success rate / latency (p50, p95) by model, source, format, and day, over a selectable range (24h / 7d / 30d / 90d / all).
- **Settings** — rotate the API key, change the account password, view/reset circuit-breaker state, and see where `data.json` + `logs.jsonl` live.

Same admin API the CLI uses.

## CLI reference

| Command | |
|---|---|
| `serve [--port 7800] [--data-dir <dir>] [--web-dir <path>]` | run the gateway |
| `whoami` | print connection info for agents (base url, api key, login, example env) |
| `provider add <name> --base-url-openai URL [--base-url-anthropic URL] --key KEY --formats openai,anthropic` | add a backend (mark `supportsResponses` in the web UI) |
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

Global flags: `-u/--url`, `--user`, `--pass`, `--api-key` (or `MYAPIKEY_URL` / `MYAPIKEY_USER` / `MYAPIKEY_PASS` / `MYAPIKEY_API_KEY` env vars).

## API surface

**Agent-facing (`/v1`, API key):**

- `POST /v1/chat/completions` — OpenAI-format proxy
- `POST /v1/responses` — OpenAI Responses API (only sources marked `supportsResponses`)
- `POST /v1/messages` — Anthropic-format proxy
- `GET /v1/models` — models enabled on the **openai** slot, OpenAI list shape (Anthropic-only models aren't listed here — call them via `/v1/messages`)
- `GET /health` — public liveness check

**Admin (`/admin`, account password):**

- `/admin/account` `GET` / `PUT` — read or change username/password (either field optional)
- `/admin/api-key` `GET`, `/admin/api-key/rotate` `POST` — the key agents use
- `/admin/connection` `GET` — detected LAN IP (for pointing other machines at the gateway)
- `/admin/providers`, `/admin/providers/:id` `POST`/`PUT`/`DELETE`, `/admin/providers/:id/discover` `POST` — backend CRUD + model discovery
- `/admin/models`, `/admin/models/:name/{providers,priority,disable,test}` — routing-table CRUD + end-to-end test
- `/admin/logs` `GET` — recent calls (tail of the on-disk log)
- `/admin/stats?range=24h|7d|30d|90d|all` `GET` — aggregate stats over retained history
- `/admin/storage` `GET` — where `data.json` + `logs.jsonl` live
- `/admin/circuit` `GET`, `/admin/circuit/:id/reset` `POST` — circuit-breaker snapshot + manual reset

## Storage

Everything lives in one data directory (default `~/.myapikey`):

| File | Contents |
|---|---|
| `data.json` | all config — providers, the per-model routing table, account, API key |
| `logs.jsonl` | call history, one JSON object per line (retained ~90 days / 1 M lines) |
| `credentials.txt` | human-readable web login + API key, regenerated on every startup |
| `client.json` | CLI client profile (base url + login + API key) |

Override the directory with `--data-dir <path>` or `MYAPIKEY_DATA_DIR`. Call logs are never held in memory: the Logs timeline tail-reads the newest ~200 entries, and stats stream over the full retained file on demand.

## Development

```bash
npm run dev          # gateway with watch reload (port 7800)
npm run dev:web      # vite dev server (proxies /v1 and /admin to :7800)
npm run typecheck    # tsc (core) + vue-tsc (web)
```

Testing the gateway by hand: spin up a mock upstream and run `serve` on a scratch port with `--data-dir /tmp/myapikey`.

## Notes / non-goals

- **No OpenAI↔Anthropic translation.** If a backend doesn't speak the format an agent used, that call fails (404). Addable later without changing the agent contract.
- **No database.** One `data.json` for config; `logs.jsonl` for retained call history.
- **No TLS.** Intended for LAN / home-server use behind your own network. Put it behind a reverse proxy with TLS if you expose it beyond.
- The account (login) password and the API key are **separate**. The API key is what agents use; rotate it (`POST /admin/api-key/rotate` or the web UI) if a tool's config leaks. Don't hand either to untrusted code paths.
