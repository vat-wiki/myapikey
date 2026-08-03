# my-ai-gate

A personal LLM API gateway. Configure your backends (direct providers or aggregator/subscription platforms) once, then call **all your models through one address with one password**. Pure passthrough — no format translation. Designed to be friendly to agents and CLIs first, with a web UI as an equal citizen.

## What it does

- **One address, one password** — point any agent tool at `http://<host>:7800` and use the gateway password as the API key.
- **Dual-format passthrough** — exposes `/v1/chat/completions` (OpenAI) and `/v1/messages` (Anthropic), forwarding each verbatim. Works as long as your backends speak the matching format (aggregators usually speak both).
- **Model-name routing with failover** — call `model: "gpt-4o"`; the gateway routes to the highest-priority backend that serves it and falls over to the next on 429 / 5xx / timeout.
- **Discover + enable** — fetch each backend's model list, enable the ones you want, order their backends by priority.
- **SSE streaming** — streamed responses pass straight through.
- **Single JSON file** — all config in one `data.json`. No database.
- **CLI + Web are equal clients** of the same admin API. Configure either way.

## Quick start

```bash
npm install
npm run build:web        # build the Vue UI (one time, and after UI changes)
npm start                # runs the gateway on http://localhost:7800
```

On first run it prints a generated username/password and saves it to `~/.config/mygate/config.json` for the CLI.

### Configure via CLI

```bash
# add a backend (baseUrl MUST include /v1)
mygate provider add openrouter --base-url https://openrouter.ai/api/v1 --key sk-or-... --formats openai,anthropic

# see what models it offers
mygate provider models openrouter

# enable a model routed through it
mygate model enable gpt-4o-mini --via openrouter

# add a fallback backend for the same model, then set priority (left = primary)
mygate provider add backup --base-url https://api.example.com/v1 --key sk-... --formats openai
mygate model add-provider gpt-4o-mini backup
mygate model prioritize gpt-4o-mini openrouter backup

mygate model list        # see the routing table
```

`mygate` is `tsx packages/core/src/cli/index.ts`. For convenience: `npm start` runs `serve`, and `npm run dev` runs `serve` with watch reload.

### Wire up an agent

```bash
# Show the connection info (base url + password)
mygate whoami
```

Then set, for an OpenAI-compatible tool:

```bash
export OPENAI_BASE_URL=http://localhost:7800/v1
export OPENAI_API_KEY=<gateway password>
```

Or for Anthropic / Claude Code:

```bash
export ANTHROPIC_BASE_URL=http://localhost:7800
export ANTHROPIC_API_KEY=<gateway password>
```

The gateway accepts the password from `Authorization: Bearer`, `x-api-key`, or HTTP Basic — so whichever field a tool calls "API key", the password goes there.

## Web UI

Visit `http://localhost:7800`, sign in with your username/password. Full CRUD: manage backends, discover & enable models, drag-order priority (up/down), and watch recent calls. Same admin API the CLI uses.

## CLI reference

| Command | |
|---|---|
| `serve [--port 7800] [--data path] [--web-dir path]` | run the gateway |
| `whoami` | print connection info for agents |
| `provider add <name> --base-url URL --key KEY --formats openai,anthropic` | add a backend |
| `provider list` | list backends |
| `provider models <ref>` | discover models offered by a backend |
| `provider remove <ref>` | remove a backend (id or name) |
| `model enable <name> [--via <provider>]` | enable a model |
| `model disable <name>` | disable (keeps config) |
| `model list` | show the routing table |
| `model add-provider <name> <ref>` | add a fallback backend |
| `model remove-provider <name> <ref>` | remove a backend from a model |
| `model prioritize <name> <ref>...` | set provider priority order |
| `call <model> [prompt...]` | quick test through the gateway |

Global flags: `-u/--url`, `--user`, `--pass` (or `MYGATE_URL` / `MYGATE_USER` / `MYGATE_PASS` env vars).

## API surface

- `POST /v1/chat/completions` — OpenAI-format proxy (auth required)
- `POST /v1/messages` — Anthropic-format proxy (auth required)
- `GET /v1/models` — enabled models, OpenAI list shape
- `/admin/providers`, `/admin/models`, `/admin/logs`, `/admin/account` — config API (auth required)
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
- Auth is a single account/password shared across call + admin. Don't hand it to untrusted code paths.
