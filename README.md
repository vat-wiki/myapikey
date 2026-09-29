# MyAPIKey

[![npm version](https://img.shields.io/npm/v/myapikey?logo=npm)](https://www.npmjs.com/package/myapikey)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![node](https://img.shields.io/badge/node.js-%3E%3D18-339933?logo=node.js&logoColor=white)](#quick-start)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](#development)

English | [简体中文](README.zh-CN.md)

A lightweight self-hosted LLM gateway. Tools point at one URL with one gateway key; provider keys, model routing, failover, and logging live on your own server.

## Why use it

- **Keep provider keys private:** real public-cloud keys stay only on your gateway. Client tools receive a local gateway key, so a leaked tool config does not expose the upstream account.
- **Own the model interface:** expose stable model names to tools. If a provider, deployment, or pricing changes, update the mapping and routing—client configurations stay unchanged.
- **Stay protocol-aware:** choose OpenAI or Anthropic format explicitly and forward it without translation. You know which protocol each tool and backend is using, and upstream fields do not depend on a converter catching up.
- **Light enough to modify:** one focused TypeScript codebase with no database and a file-based store. It is easy to run, inspect, and adapt to your own ideas—without first learning a heavyweight gateway.

## Quick start

Requires Node.js 18+.

```bash
npx myapikey
```

Open `http://localhost:7800` and sign in with the credentials printed on first startup (also saved to `~/.myapikey/credentials.txt`).

1. In **Models**, add each backend with its real base URL and API key, select its format (`openai` / `anthropic`), discover models, and enable the ones you need.
2. Point tools at the gateway and use the generated `sk-myapikey-…` key, **not** your web login password:

```bash
# Claude Code / Anthropic SDKs
export ANTHROPIC_BASE_URL=http://localhost:7800/anthropic
export ANTHROPIC_API_KEY=sk-myapikey-…

# OpenAI-compatible tools
export OPENAI_BASE_URL=http://localhost:7800/openai/v1
export OPENAI_API_KEY=sk-myapikey-…
```

OpenAI base URLs include the version segment (`/v1`, `/api/v3`); Anthropic base URLs exclude it.

## What it does

- **Unified access:** one endpoint and gateway key for Claude Code, OpenAI-compatible CLIs, plugins, and scripts.
- **Pure passthrough:** OpenAI calls reach OpenAI-format backends; Anthropic calls reach Anthropic-format backends. Bodies and streams are not translated, so new upstream parameters work without gateway support.
- **Reliability:** configure ordered backends per model and format. `429`, `5xx`, and timeouts fail over; repeated failures trigger a 30-second-to-5-minute cooldown. Streaming is not retried after it starts.
- **Rate control:** backend RPM or model pacing queues excess requests instead of immediately returning `429`.
- **Friendly routing:** expose a simple model name and map it to each backend’s real model ID; optionally pin a default thinking level per route.
- **Visibility:** bilingual web UI with live logs, success rates, and p50/p95 latency by model, backend, and day.
- **Light storage:** no database—only `data.json` and `logs.jsonl`.

Requests enter through `/openai/v1/*` or `/anthropic/v1/*` and stay in that format. Unsupported model/format combinations return `404`; other caller-side `4xx` errors return unchanged. If you need OpenAI ↔ Anthropic translation, this gateway is intentionally not that tool.

## Operations

Data defaults to `~/.myapikey`; override it with `--data-dir` or `MYAPIKEY_DATA_DIR`.

| File | Contents |
|---|---|
| `data.json` | backends, routing, account, and gateway API key |
| `logs.jsonl` | call history (~90 days / 1M lines) |
| `credentials.txt` | web credentials and gateway key, rewritten at startup |

The web UI includes Connect, Models, Logs, Stats, and Settings. Settings can rotate the gateway key or change the password. This tool is single-user and has no TLS; place it behind a reverse proxy before exposing it beyond a trusted network.

## Development

```bash
npm install
npm run build:web
npm run dev
npm run dev:web
npm test
npm run typecheck
```
