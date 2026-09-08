# MyAPIKey

[![npm version](https://img.shields.io/npm/v/myapikey?logo=npm)](https://www.npmjs.com/package/myapikey)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![node](https://img.shields.io/badge/node.js-%3E%3E18-339933?logo=node.js&logoColor=white)](#60-秒跑起来)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](#开发)

[English](README.md) | 简体中文

**一个地址、一把 key,接上你所有的 AI 工具。** 一个跑在自己家用服务器上的轻量 LLM 网关:供应商的 key 收进网关统一保管,所有工具只认同一个地址 + 同一把 key,后端挂了自动切换。

## 是不是在说你

- 你用着 **Claude Code、好几个 OpenAI 兼容 CLI、编辑器插件、脚本**——每个都得单独填一遍 base URL + API key。
- 你的**真实 key**(OpenAI、Anthropic、OpenRouter、本地 Ollama……)散落在十几个配置文件里。想换一把 key?先想清楚它粘在了哪儿。
- **主力供应商一限流或宕机**,活儿干到一半就断。切备用?又得改一轮配置。
- 你试过 **one-api / new-api 这类网关**,它们在格式之间做*翻译*——然后你遇到丢字段、流式错乱、新参数要等网关适配才能用。

MyAPIKey 就是为治这些而生的。

## 你能得到什么

- **一个地址 + 一把 key。** 所有工具都指向 `http://你的机器:7800`,只用一把 `sk-myapikey-…`。真实供应商 key 只存在网关里——轮换、换后端,都不用再碰任何工具的配置。
- **自动故障转移 + 熔断。** 给同一个模型配一条有序的后端链:429 / 5xx / 超时自动切下一条;连续失败的后端进入冷却(30 秒 → 5 分钟),后续请求先跳过它。你的 agent 毫无感知。
- **纯透传,零翻译。** OpenAI 格式的调用只发给说 OpenAI 格式的后端,Anthropic 同理——请求/响应逐字节转发,流式直通。上游新出的字段、新参数,不需要网关"适配"就能用。
- **限流靠排队,不甩 429。** 给每个后端设 rpm 上限,或给模型设匀速节奏;超出的调用先在网关排队,而不是直接把 429 甩回工具。
- **模型名映射。** 对工具暴露一个好记的名字(`claude-sonnet-4`);每个后端各自映射到真实 id(这里发 `claude-sonnet-4-20250514`,那边发别的)。
- **每个槽位可固定默认 thinking 档位。** 在路由上钉死一个推理档位 / 预算,覆盖请求里带的设置——想管住 Claude Code 的思考行为,网关说了算。
- **全程看得见。** Web 界面(中/英):实时调用日志、成功率、p50/p95 延迟,按模型 / 来源 / 日期的统计;CLI 功能完全对等。
- **轻得没负担。** 无数据库——一个 `data.json` 加一个 `logs.jsonl`;`npx` 一行起跑;为局域网 / 家用服务器设计。

## 60 秒跑起来

需要 Node.js 18+。

```bash
npx myapikey serve          # → http://localhost:7800
```

首次启动会打印凭据,并同时存到 `~/.myapikey/credentials.txt`:

1. 浏览器打开 `http://localhost:7800`,用打印出来的**用户名 / 密码**登录(网页管理用)。
2. **模型**页 → **添加后端**:填后端的 base URL + 它的真实 key,勾选它说的格式(`openai` / `anthropic`),然后**刷新模型** → 在对应格式上**启用**你想要的。
3. 把工具指过来——所有工具里的 "API key" 字段都填**网关 key**,不是网页登录密码:

```bash
# Claude Code / Anthropic 系
export ANTHROPIC_BASE_URL=http://localhost:7800/anthropic
export ANTHROPIC_API_KEY=sk-myapikey-…

# OpenAI 兼容工具(Codex、各种 CLI / 插件)
export OPENAI_BASE_URL=http://localhost:7800/openai/v1
export OPENAI_API_KEY=sk-myapikey-…
```

> 为什么一个是 `…/openai/v1` 一个是 `…/anthropic`?各生态 SDK 自己补路径(OpenAI 补 `/chat/completions`,Anthropic 补 `/v1/messages`),网关按各自的约定来。两边各有独立的 `/models`,只列出各自格式启用的模型。`myapikey whoami` 随时打印这些可直接粘贴的配置。

4. 不开工具也能冒烟测试:

```bash
myapikey call gpt-4o-mini "用一句话介绍你自己"
```

喜欢全程命令行?`provider add` → `provider models` → `model enable` 干的是同一件事,速查表在下面。

## 路由是怎么回事(就这么多)

- 网关开两个入口:`/openai/v1/*`(chat completions、responses、models)和 `/anthropic/v1/*`(messages、models)。请求从哪个口进,就按哪个口的格式转发,**绝不翻译**。
- 每个模型在每个格式上有一条独立、有序的后端链。链内按序故障转移:429 / 5xx / 超时切下一条;其他 4xx 原样返回(那是调用方的错);开始流式后不再切换。该格式下没有任何后端能服务这个模型,就返回 `404`——宁可失败得明明白白,也不悄悄翻译。
- 只要"会说"这两种格式的都能接:OpenAI、Anthropic、OpenRouter、Ollama / vLLM、火山 Ark、公司内部网关……

## 为什么不做翻译?

one-api / new-api 在 OpenAI ↔ Anthropic 之间做格式转换,方便是方便,但字段会丢、流式会乱,上游出新参数还得等网关更新;OpenRouter 是托管服务,每次调用抽成。MyAPIKey 的答案是干脆没有翻译层:

| | MyAPIKey | one-api / new-api | OpenRouter |
|---|---|---|---|
| 部署 | 自托管,`npx` 一行 | 自托管,较重 | 托管服务 |
| 费用 | 免费 | 免费 | 按次加价 |
| 格式 | 逐字节透传 | 翻译 | 翻译 |
| 上游新参数 | 立即可用 | 等网关适配 | 等平台适配 |
| 供应商 key | 在你自己机器上 | 在你自己机器上 | 在平台手里 |

代价也直说:Anthropic 格式的后端没法从 OpenAI 入口调。如果你要的就是格式互转,这个工具暂时不适合你。

## 怎么管

**Web 界面** — `http://localhost:7800`,中英双语。五个页:**使用方式**(可直接粘贴的连接配置)、**模型**(后端、发现、按格式启用、拖拽排序、名称映射、测试调用)、**最近调用**(实时时间线)、**统计**(调用数 / 成功率 / p50 / p95,按模型 / 来源 / 日期)、**设置**(轮换 key、改密码、熔断状态、存储位置)。

**CLI 速查**(和网页同一套 admin API,两边永远一致):

| 我想…… | 命令 |
|---|---|
| 起网关 | `myapikey serve [--port 7800] [--data-dir <目录>]` |
| 打印要粘给工具的配置 | `myapikey whoami` |
| 加后端 | `myapikey provider add <名> --base-url-openai https://api.openai.com/v1 --key sk-… --formats openai` |
| 看后端有哪些模型 | `myapikey provider models <名>` |
| 启用模型 | `myapikey model enable <模型> --format openai --via <后端>` |
| 加备用 + 排序 | `myapikey model add-provider <模型> <后端> --format openai` · `myapikey model prioritize <模型> <主> <备> --format openai` |
| 看路由表 | `myapikey model list` |
| 给模型设匀速限速 | `myapikey model pace <模型> <rpm\|0>` |
| 钉死槽位 thinking 档位 | `myapikey model thinking <模型> <链上位次> [档位] --format <格式>` |
| 快速试一把 | `myapikey call <模型> "你好"` |

> OpenAI 的 base URL **含**版本段(`/v1`、火山 Ark 的 `/api/v3`);Anthropic 的 base URL **不含**(`https://api.anthropic.com`)。`responses` 格式只接受你标记了 `supportsResponses` 的后端(网页里勾选)。
> CLI 全局参数:`-u/--url`、`--user`、`--pass`、`--api-key`,或环境变量 `MYAPIKEY_URL` / `MYAPIKEY_USER` / `MYAPIKEY_PASS` / `MYAPIKEY_API_KEY`。

## 数据都在哪

一个目录(默认 `~/.myapikey`,可用 `--data-dir` 或 `MYAPIKEY_DATA_DIR` 改):

| 文件 | 内容 |
|---|---|
| `data.json` | 全部配置:后端、路由表、账号、API key |
| `logs.jsonl` | 调用历史(保留约 90 天 / 100 万行) |
| `credentials.txt` | 明文的登录信息 + API key,每次启动重写 |
| `client.json` | CLI 自己存的连接配置 |

## 开发

```bash
npm install
npm run build:web      # 把 Vue 界面构建到 packages/web/dist
npm run dev            # 网关,带 watch 热重载
npm run dev:web        # vite 开发服务器(API 代理到 :7800)
npm test               # vitest 单测 + 集成
npm run test:e2e       # playwright 打真实网关进程
npm run typecheck      # tsc + vue-tsc
```

## 丑话说在前面

- **不做 OpenAI ↔ Anthropic 翻译。** 入口和模型格式对不上 → `404`。
- **单用户、无 TLS。** 给你自己的内网用的;要暴露到外网请自己套反代。
- **网页密码 ≠ API key。** 密码只管 UI/CLI,agent 只认 `sk-myapikey-…`。工具配置泄露了,去设置页轮换 key,其他什么都不用动。
