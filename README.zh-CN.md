# MyAPIKey

[![npm version](https://img.shields.io/npm/v/myapikey?logo=npm)](https://www.npmjs.com/package/myapikey)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![node](https://img.shields.io/badge/node.js-%3E%3D18-339933?logo=node.js&logoColor=white)](#quick-start)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](#development)

[English](README.md) | 简体中文

轻量自托管 LLM 网关。所有工具只填一个地址和一把网关 key;供应商 key、模型路由、故障转移和调用记录都保存在你自己的服务器上。

## Why use it

- **保护云端 key:** 真实的公网供应商 key 只保存在自己的网关里。客户端工具拿到的是本地网关 key,即使工具配置泄露,也不会直接暴露上游账号。
- **自定义模型接口:** 对工具暴露稳定的模型名。供应商、部署方式或价格变化时,只需要更新映射和路由,客户端配置不用改。
- **明确多协议:** 显式选择 OpenAI 或 Anthropic 格式并原样转发。你清楚每个工具和后端到底用什么协议,上游新字段也不需要等转换层适配。
- **轻到敢直接改:** 一个专注的 TypeScript 代码库,无数据库、文件存储。拿过去就能读懂和修改,不用先啃一个过于复杂、不适合个人使用的重型网关。

## Quick start

需要 Node.js 18+。

```bash
npx myapikey
```

打开 `http://localhost:7800`,首次使用时设置网页用户名和密码,然后登录。

1. 在 **Models** 中添加后端的真实 base URL 和 API key,选择格式(`openai` / `anthropic`),刷新模型并启用需要的模型。
2. 让工具指向网关,使用生成的 `sk-myapikey-…`,**不要**填网页登录密码:

```bash
# Claude Code / Anthropic SDK
export ANTHROPIC_BASE_URL=http://localhost:7800/anthropic
export ANTHROPIC_API_KEY=sk-myapikey-…

# OpenAI 兼容工具
export OPENAI_BASE_URL=http://localhost:7800/openai/v1
export OPENAI_API_KEY=sk-myapikey-…
```

OpenAI 的 base URL 含版本段(`/v1`、`/api/v3`);Anthropic 的 base URL 不含它。

## What it does

- **统一入口:** Claude Code、OpenAI 兼容 CLI、插件和脚本共用一个地址和网关 key。
- **纯透传:** OpenAI 请求发给 OpenAI 格式后端,Anthropic 请求发给 Anthropic 格式后端;请求体和流式响应不翻译,上游新参数无需等待网关适配。
- **可靠性:** 按模型和格式配置有序后端。`429`、`5xx`、超时自动切换;连续失败触发 30 秒到 5 分钟冷却。流式开始后不再重试。
- **限流控制:** 后端 RPM 或模型匀速节奏会让超限请求排队,而不是立即返回 `429`。
- **易记路由:** 对外暴露简洁模型名,并映射到每个后端的真实模型 ID;可按路由固定默认 thinking 档位。
- **运行可见:** 中英文 Web UI 提供实时日志、成功率,以及按模型、后端、日期统计的 p50/p95 延迟。
- **轻量存储:** 无数据库,只有 `data.json` 和 `logs.jsonl`。

请求通过 `/openai/v1/*` 或 `/anthropic/v1/*` 进入,并保持原格式转发。模型和格式不匹配返回 `404`;调用方自身的 `4xx` 错误原样返回。如果你需要 OpenAI ↔ Anthropic 格式互转,这个网关明确不提供该能力。

## Operations

数据默认在 `~/.myapikey`;可用 `--data-dir` 或 `MYAPIKEY_DATA_DIR` 覆盖。

| 文件 | 内容 |
|---|---|
| `data.json` | 后端、路由、账号和网关 API key |
| `logs.jsonl` | 调用历史(约 90 天 / 100 万行) |

Web UI 包含 Connect、Models、Logs、Stats 和 Settings。设置页可轮换网关 key、修改密码。工具为单用户设计且不内置 TLS;暴露到可信网络之外时请使用反向代理。

## Development

```bash
npm install
npm run build:web
npm run dev
npm run dev:web
npm test
npm run typecheck
```
