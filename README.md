# MyAPIKey

[![npm version](https://img.shields.io/npm/v/myapikey?logo=npm)](https://www.npmjs.com/package/myapikey)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![node](https://img.shields.io/badge/node.js-%3E%3E18-339933?logo=node.js&logoColor=white)](#up-and-running-in-60-seconds)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](#development)

English | [简体中文](README.zh-CN.md)

**One address, one key, every AI tool you use.** A tiny self-hosted LLM gateway for your home server: keep your provider keys in one place, point every tool at the same URL with the same key, and fail over automatically when a backend breaks.

## Sound familiar?

- You use **Claude Code, a few OpenAI-compatible CLIs, editor plugins, scripts** — and each one needs its own base URL + API key pasted in.
- Your **real keys** (OpenAI, Anthropic, OpenRouter, a local Ollama…) are scattered across a dozen config files. Rotating one means remembering everywhere it's pasted.
- Your **main provider 429s or goes down** mid-task and the tool just dies. Switching to a backup means re-editing configs.
- You tried **one-api / new-api-style gateways**, which *translate* between formats — and drop fields, mangle streams, or hold new upstream parameters hostage until someone updates the gateway.

MyAPIKey is built to end exactly this.

## What you get

- **One address, one key.** Every tool points at `http://<your-server>:7800` with a single `sk-myapikey-…` key. Real provider keys live only inside the gateway — rotate one, swap a backend, and no tool config ever changes again.
- **Automatic failover + circuit breaker.** Give a model an ordered chain of backends. On `429` / `5xx` / timeout the next one takes over; a source that keeps failing cools down (30 s → 5 min) so later calls skip it. Your agent never notices.
- **Pure passthrough, zero translation.** OpenAI-format calls reach OpenAI-speaking backends, Anthropic-format calls reach Anthropic-speaking backends — bodies forwarded byte-for-byte, streaming straight through. New upstream fields and parameters work without the gateway "supporting" them first.
- **Rate limiting that queues instead of 429ing.** Cap each backend's rpm, or give a model an even per-minute pace; excess calls wait in the gateway instead of coming straight back as `429`.
- **Model name mapping.** Expose a friendly name to your tools (`claude-sonnet-4`); each backend maps it to its own real id (`claude-sonnet-4-20250514` here, something else there).
- **A default thinking level per slot.** Pin a reasoning effort / token budget on a route; it overrides whatever the request carried — handy for taming Claude Code.
- **See everything.** Web UI (English / 简体中文): live call log, success rate, p50/p95 latency, per-model / per-backend / per-day stats. The CLI can do all of it too.
- **Featherweight.** No database — one `data.json` plus a `logs.jsonl`. Runs with `npx`. Built for LAN / home-server use.

## Up and running in 60 seconds

Requires Node.js 18+.

```bash
npx myapikey serve          # → http://localhost:7800
```

First run prints your credentials and also saves them to `~/.myapikey/credentials.txt`:

1. Open `http://localhost:7800` and sign in with the printed **username / password** (web login).
2. **Models** tab → **Add backend**: paste the backend's base URL + its real API key, tick the formats it speaks (`openai` / `anthropic`), then **discover** → **enable** the models you want.
3. Point your tools at the gateway — every tool's "API key" field gets the **gateway key**, not your web password:

```bash
# Claude Code / anything Anthropic
export ANTHROPIC_BASE_URL=http://localhost:7800/anthropic
export ANTHROPIC_API_KEY=sk-myapikey-…

# OpenAI-compatible tools (Codex, CLIs, plugins)
export OPENAI_BASE_URL=http://localhost:7800/openai/v1
export OPENAI_API_KEY=sk-myapikey-…
```

> Why `…/openai/v1` but `…/anthropic`? Each SDK appends its own paths (OpenAI adds `/chat/completions`, Anthropic adds `/v1/messages`), so the gateway follows each ecosystem's own convention. Each surface also has its own `/models`, listing only models enabled for that format. `myapikey whoami` prints all of this ready to paste, anytime.

4. Smoke test without any tool:

```bash
myapikey call gpt-4o-mini "Say hello in one sentence."
```

Prefer the terminal? `provider add` → `provider models` → `model enable` does the same job — cheat sheet below.

## How routing works (the whole story)

- The gateway has two entrances: `/openai/v1/*` (chat completions, responses, models) and `/anthropic/v1/*` (messages, models). A request is forwarded in the entrance's format, **never translated**.
- Each model has an independent, ordered backend chain **per format**. Within a chain, `429` / `5xx` / timeouts fail over to the next backend; other `4xx` errors come back as-is (they're the caller's fault, not the backend's). No failover once streaming has started. If no backend serves that model on that format, you get a `404` — a clear failure beats a silent translation.
- Anything that speaks either format works: OpenAI, Anthropic, OpenRouter, Ollama / vLLM, Volcengine Ark, your company's internal gateway…

## Why no translation?

one-api / new-api convert OpenAI ↔ Anthropic shapes. Convenient, until a field gets dropped, a stream gets mangled, or a new upstream parameter needs a gateway update before you can send it. OpenRouter is hosted and takes a cut per call. MyAPIKey's answer is to not have a translation layer at all:

| | MyAPIKey | one-api / new-api | OpenRouter |
|---|---|---|---|
| Deploy | self-hosted, one `npx` | self-hosted, heavier | hosted service |
| Cost | free | free | markup per call |
| Formats | passthrough, byte-for-byte | translated | translated |
| New upstream params | work immediately | wait for gateway support | wait for platform support |
| Provider keys | on your machine | on your machine | on their platform |

The trade-off, stated plainly: an Anthropic-format backend cannot be called through the OpenAI entrance. If what you want is format conversion, this isn't your tool (yet).

## Managing it

**Web UI** — `http://localhost:7800`, English + 简体中文. Five tabs: **Connect** (copy-paste-ready env lines), **Models** (backends, discovery, per-format enable, drag-to-order chains, name mapping, test call), **Logs** (live timeline), **Stats** (counts, success rate, p50/p95 by model / backend / day), **Settings** (rotate API key, change password, circuit-breaker state, storage paths).

**CLI cheat sheet** (same admin API as the web UI — the two never drift apart):

| I want to… | Command |
|---|---|
| run the gateway | `myapikey serve [--port 7800] [--data-dir <dir>]` |
| print what to paste into tools | `myapikey whoami` |
| add a backend | `myapikey provider add <name> --base-url-openai https://api.openai.com/v1 --key sk-… --formats openai` |
| see a backend's models | `myapikey provider models <name>` |
| enable a model | `myapikey model enable <model> --format openai --via <backend>` |
| add a fallback + set order | `myapikey model add-provider <model> <backend> --format openai` · `myapikey model prioritize <model> <primary> <backup> --format openai` |
| see the routing table | `myapikey model list` |
| pace a model | `myapikey model pace <model> <rpm\|0>` |
| pin a slot's thinking level | `myapikey model thinking <model> <index> [value] --format <fmt>` |
| quick test | `myapikey call <model> "hi"` |

> OpenAI base URLs **include** the version segment (`/v1`, Ark's `/api/v3`); Anthropic base URLs **exclude** it (`https://api.anthropic.com`). The `responses` format only accepts backends you've marked `supportsResponses` (web UI toggle).
> CLI global flags: `-u/--url`, `--user`, `--pass`, `--api-key`, or env `MYAPIKEY_URL` / `MYAPIKEY_USER` / `MYAPIKEY_PASS` / `MYAPIKEY_API_KEY`.

## Where your data lives

One directory (default `~/.myapikey`, override with `--data-dir` or `MYAPIKEY_DATA_DIR`):

| File | What |
|---|---|
| `data.json` | all config: backends, routing table, account, API key |
| `logs.jsonl` | call history (kept ~90 days / 1 M lines) |
| `credentials.txt` | your login + API key in plain text, rewritten every start |
| `client.json` | the CLI's saved connection profile |

## Development

```bash
npm install
npm run build:web      # build the Vue UI into packages/web/dist
npm run dev            # gateway with watch reload
npm run dev:web        # vite dev server (proxies API calls to :7800)
npm test               # vitest unit + integration
npm run test:e2e       # playwright against a real gateway process
npm run typecheck      # tsc + vue-tsc
```

## Honest limits

- **No OpenAI↔Anthropic translation.** Wrong entrance for a model → `404`.
- **Single user, no TLS.** Meant for your own network; put a reverse proxy in front if you expose it.
- **Web password ≠ API key.** The password administers the UI/CLI; agents use the `sk-myapikey-…` key. If a tool config leaks, rotate the key (Settings, or `POST /admin/api-key/rotate`) and nothing else changes.
