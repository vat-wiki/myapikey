# MyAPIKey

[![npm version](https://img.shields.io/npm/v/myapikey?logo=npm)](https://www.npmjs.com/package/myapikey)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![node](https://img.shields.io/badge/node.js-%3E%3D18-339933?logo=node.js&logoColor=white)](#快速开始)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](#开发指南)

[English](README.md) | 简体中文

**一个地址、一把密钥,接入你所有的模型——且绝不翻译。**

MyAPIKey 是一个个人 LLM 网关。把你用到的每个 AI 工具(Claude Code、兼容 OpenAI 的命令行、编辑器、脚本)都指向同一个本地地址、用同一把 API Key。每一次调用都会**原样转发**给一个说相同线材格式(wire format)的后端,并在某个后端掉线时自动故障转移。OpenAI 与 Anthropic 格式之间不做任何转换——你发出去什么,后端就收到什么。

> 面向家用服务器 / 局域网设计。默认无数据库、无 TLS、不做格式转换——只是一个你能完全掌控的、轻量透明的转发层。

---

## 目录

- [这是什么,适合谁用?](#这是什么适合谁用)
- [快速开始](#快速开始)
- [添加第一个后端](#添加第一个后端)
- [连接你的工具](#连接你的工具)
- [路由是怎么工作的](#路由是怎么工作的)
- [模型名映射](#模型名映射)
- [网页界面](#网页界面)
- [命令行参考](#命令行参考)
- [接口一览](#接口一览)
- [存储说明](#存储说明)
- [开发指南](#开发指南)
- [说明与非目标](#说明与非目标)

---

## 这是什么,适合谁用?

如果下面几条说到你心坎里,那 MyAPIKey 就适合你:

- 你在 OpenAI、Anthropic、OpenRouter、本地模型之间来回切换**好几把 API Key**,受够了每个工具都要粘一份不同的密钥。
- 你想让 agent 始终指向**同一个稳定地址**,哪怕背后的供应商变了。
- 你想要**自动故障转移**——主后端被限流或掉线时,下一个顶上。
- 你想**在不改动任何工具配置**的前提下,重命名或替换某个模型。
- 你想要**每一次调用的记录**(延迟、状态、由哪个后端服务)。

MyAPIKey 一次性给你这些。你把真实的供应商密钥留在网关内部;你的工具只认识 `http://<主机>:7800` 和一把 `sk-myapikey-…` 密钥。

**先知道一件事:网关按你工具的原生格式转发,绝不翻译。** 调用 OpenAI 端点的请求只会到达支持 OpenAI 格式的后端;调用 Anthropic 端点的请求只会到达支持 Anthropic 格式的后端。这保证了请求与响应零损耗。(配好之后,可看 [路由是怎么工作的](#路由是怎么工作的)。)

---

## 快速开始

需要 **Node.js 18+**。无需安装,直接用 npm 跑:

```bash
npx myapikey serve          # → http://localhost:7800
```

或全局安装:

```bash
npm install -g myapikey
myapikey serve
```

首次运行会打印生成的凭据,**并同时写入文件**,这样你就不会弄丢:

```
  First run — here are your credentials (save them):
    username : <随机>        (网页登录用)
    password : <随机>        (网页登录用)
    api key  : sk-myapikey-…   (填进工具的 "api key" 字段)
  ↳ also written to ~/.myapikey/credentials.txt
```

在浏览器打开 `http://localhost:7800`,用**用户名 / 密码**登录进入网页界面。**API Key** 是分开的另一把——那是你的 AI 工具稍后用的。

> 忘了凭据?`cat ~/.myapikey/credentials.txt`(每次启动都会重新生成)。用 `--data-dir <路径>` 或环境变量 `MYAPIKEY_DATA_DIR` 可改数据存放位置。

网关已经跑起来了。下一步,给它一个可以转发的后端。

---

## 添加第一个后端

一个**后端**(provider / 来源)就是一个上游 API:OpenAI、Anthropic、OpenRouter、本地 Ollama、火山引擎 Ark 之类的厂商等。你只需用它的真实密钥加一次,然后通过它启用模型。

### 最简单:网页界面

1. 打开**模型**标签 → **添加模型来源**。
2. 填名称、后端的 Base URL、它的 API Key。
3. 勾选它支持的线材格式:`openai`、`anthropic`(或两者都勾)。
4. 保存,然后点**刷新模型**拉取它的模型列表。
5. 在对应的格式槽位上**启用**你想要的模型。

### 或者:命令行

```bash
# 一个 OpenAI 兼容后端。OpenAI 的 Base URL 含版本段
# (例如 /v1,或厂商自己的,如火山 Ark 的 /api/v3)。
myapikey provider add openai-direct \
  --base-url-openai https://api.openai.com/v1 \
  --key sk-... \
  --formats openai

# 一个 Anthropic 后端。Anthropic 的 Base URL 不含 /v1
# (https://api.anthropic.com,或火山 Ark 的 /api/plan)。
myapikey provider add anthropic-direct \
  --base-url-anthropic https://api.anthropic.com \
  --key sk-ant-... \
  --formats anthropic

# 看看各自提供哪些模型,然后在某个槽位上启用一个:
myapikey provider models openai-direct
myapikey model enable gpt-4o-mini --format openai --via openai-direct
```

这个模型现在就能通过网关访问了。要为同一个模型加**备用来源**(在第一个失败时顶上),再加一个后端并把它串进链里:

```bash
myapikey provider add backup --base-url-openai https://api.openrouter.ai/api/v1 --key sk-or-... --formats openai
myapikey model add-provider gpt-4o-mini backup --format openai
myapikey model prioritize gpt-4o-mini openai-direct backup --format openai   # 左边 = 主
myapikey model list        # 查看路由表
```

> `--format` 选择路由**槽位**:`openai`(对应 `/openai/v1/chat/completions`)、`anthropic`(对应 `/anthropic/v1/messages`)、或 `responses`(对应 `/openai/v1/responses`)。`responses` 槽位只接受你标记了 **supportsResponses** 的后端——在网页界面里勾选那个开关(CLI 暂未暴露它)。

---

## 连接你的工具

一旦启用某个模型,就可以把任意 agent 指向网关。先取出连接信息:

```bash
myapikey whoami      # 打印 base url + api key + 可直接粘贴的环境变量
```

**兼容 OpenAI** 的工具(覆盖 `/chat/completions` *和* `/responses`):

```bash
export OPENAI_BASE_URL=http://localhost:7800/openai/v1
export OPENAI_API_KEY=<网关 API Key>
```

**Anthropic / Claude Code**:

```bash
export ANTHROPIC_BASE_URL=http://localhost:7800/anthropic
export ANTHROPIC_API_KEY=<网关 API Key>
```

> 不管某个工具把它叫什么 "API key" 字段,都填**网关 API Key**——*不是*你的网页登录密码。登录密码只用于网页界面和 CLI 管理命令。

不用任何工具,也能快速冒烟测试:

```bash
myapikey call gpt-4o-mini "用一句话打个招呼。"
```

**为什么有两个 Base URL?** 网关暴露了两个互相独立的 agent 面——`/openai/v1` 和 `/anthropic/v1`,各自带自己的 `GET /models`(OpenAI 客户端只发现 openai 槽位启用的模型,Anthropic 客户端只发现 anthropic 槽位启用的模型)。两套生态的 SDK 各自拼接自己的路径:OpenAI SDK 指向 `…/openai/v1`(它自己补 `/chat/completions`、`/responses`、`/models`),Anthropic SDK / Claude Code 指向 `…/anthropic`(它自己补 `/v1/messages`、`/v1/models`)。

**直接用 HTTP**(不走 SDK)——带上网关 API Key(`Bearer`)直接打这两个面之一:

```bash
# OpenAI 系
curl http://localhost:7800/openai/v1/chat/completions \
  -H "Authorization: Bearer <网关 API Key>" -H "Content-Type: application/json" \
  -d '{"model":"<模型名>","messages":[{"role":"user","content":"hi"}]}'

# Anthropic 系
curl http://localhost:7800/anthropic/v1/messages \
  -H "Authorization: Bearer <网关 API Key>" -H "Content-Type: application/json" \
  -d '{"model":"<模型名>","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}'
```

不管你把工具指向哪个端点,网关都按那个格式转发、绝不翻译——所以确保你调用的每个模型,在对应的槽位上至少有一个来源在服务它([见下文](#路由是怎么工作的))。

---

## 路由是怎么工作的

网关是一个**定向转发器,而非翻译器**。四条规则解释一切:

1. **端点决定槽位。** `/openai/v1/chat/completions` → **openai** 槽位;`/openai/v1/responses` → **responses** 槽位;`/anthropic/v1/messages` → **anthropic** 槽位。每种都是独立的线材格式,请求体原样转发,不做任何转换。

2. **每个模型有三个互相独立的槽位。** 对同一个模型,你可以分别启用 `openai`、`responses`、`anthropic`,每个槽位都有自己的、按优先级排序的来源链。只在它的后端真正支持的槽位上启用即可。

3. **来源按槽位资质匹配。** `openai` 和 `anthropic` 槽位接受携带对应线材格式的来源;`responses` 槽位只接受你标记了 `supportsResponses` 的来源(大多数 OpenAI 兼容后端并没有实现 Responses API)。一个 `supportsResponses` 来源可以**同时**位于 **openai** 链 *和* **responses** 链中。

4. **槽位内按优先级 + 故障转移。** 候选来源按你的优先级顺序依次尝试。遇到 `429` / `5xx` / 超时,网关就试下一个——并且触发失败的来源会进入短暂的**熔断冷却**(指数退避,30 秒 → 5 分钟),让后续调用先跳过它、等它恢复;成功一次就闭合熔断。其他 `4xx` 错误原样返回(那是调用方的错,不是后端的)。一旦开始流式输出,就不再故障转移。

**由此带来的取舍:** 如果某个端点没有任何来源能为该模型服务,你会收到 `404`——而不是被悄悄翻译。这是零损耗透传的代价。(将来可以在不改变 agent 端接口的前提下叠加翻译层。)

这也是它与 OpenRouter、one-api 等聚合器的根本区别——后者会在 OpenAI 与 Anthropic 的请求/响应结构之间互相转换。

---

## 模型名映射

有时候,工具请求的模型名并不是后端期望的名字。MyAPIKey 可以**按来源改写模型名**,在转发过程中替换——依然是纯透传,不做格式翻译。

在网页界面(**模型**标签)设置:添加来源时有一个**上游模型**字段;也可以在链中任意成员上就地编辑。(CLI 暂未暴露。)

它的用途:

- **把友好名别名到带版本的 id**——对工具暴露 `claude-sonnet-4`,而网关向上游发送 `claude-sonnet-4-20250514`。
- **让同一个公开名在不同来源指向不同真实模型**——例如你的 `gpt-4` 槽位,主来源发 `gpt-4o`,备用来源发 `gpt-4-turbo`。
- **桥接两个后端的命名差异**——同一个模型在不同后端用不同 id。

若某来源未设映射,则原样发送公开模型名。

---

## 网页界面

浏览器打开 `http://localhost:7800`,用用户名 / 密码登录。内置**中英文**,顶栏可切换。五个标签:

- **使用方式** — 可直接复制粘贴的 Base URL / API Key / 登录信息,以及现成的 SDK 环境变量。
- **模型** — 完整增删改查:添加来源、按槽位发现并启用模型、拖拽排序优先级、切换每个槽位、设置[模型名映射](#模型名映射),还能对任意「模型 + 槽位」跑一次端到端**测试**。
- **最近调用** — 实时的近期调用时间线(延迟、状态、来源、格式),熔断冷却事件会和触发它的失败记录并排显示。
- **统计** — 按模型 / 来源 / 格式 / 日期汇总调用次数、成功率、延迟(p50、p95),可选时间范围(24 小时 / 7 天 / 30 天 / 90 天 / 全部)。
- **设置** — 轮换 API Key、修改账号密码、查看 / 重置熔断状态、查看 `data.json` 和 `logs.jsonl` 的位置。

它和 CLI 用的是同一套 admin API——想用哪种配置都行。

---

## 命令行参考

| 命令 | |
|---|---|
| `serve [--port 7800] [--data-dir <目录>] [--web-dir <路径>]` | 运行网关 |
| `whoami` | 打印给 agent 用的连接信息(base url、api key、登录信息、示例环境变量) |
| `provider add <名称> --base-url-openai URL [--base-url-anthropic URL] --key KEY --formats openai,anthropic` | 添加后端(`supportsResponses` 在网页界面设置) |
| `provider list` | 列出后端 |
| `provider models <引用>` | 发现某个后端提供的模型 |
| `provider remove <引用>` | 移除后端(用 id 或名称) |
| `model enable <名称> --format <格式> [--via <引用>]` | 在某个槽位启用模型(openai / anthropic / responses) |
| `model disable <名称> --format <格式>` | 禁用某个槽位(保留配置) |
| `model list` | 查看按槽位的路由表 |
| `model add-provider <名称> <引用> --format <格式>` | 为某个槽位添加备用来源 |
| `model remove-provider <名称> <引用> --format <格式>` | 从某个槽位移除来源 |
| `model prioritize <名称> <引用>... --format <格式>` | 设置某个槽位的来源顺序(左 = 主) |
| `model remove <名称>` | 完全移除一个模型(所有槽位) |
| `call <模型> [提示词...]` | 通过网关快速测试(走 OpenAI 路径) |

`<引用>` 是来源的 id 或名称。全局参数:`-u/--url`、`--user`、`--pass`、`--api-key`(或 `MYAPIKEY_URL` / `MYAPIKEY_USER` / `MYAPIKEY_PASS` / `MYAPIKEY_API_KEY` 环境变量)。

---

## 接口一览

**面向 agent(两个面,共用一把 API Key —— `Authorization: Bearer` 或 `x-api-key`):**

- `POST /openai/v1/chat/completions` — OpenAI 格式代理
- `POST /openai/v1/responses` — OpenAI Responses API(仅限标记了 `supportsResponses` 的来源)
- `GET /openai/v1/models` — 启用在 **openai** 槽位的模型,OpenAI 列表格式(公开——无需 Key)
- `POST /anthropic/v1/messages` — Anthropic 格式代理
- `GET /anthropic/v1/models` — 启用在 **anthropic** 槽位的模型,OpenAI 列表格式(公开——无需 Key)
- `GET /health` — 公开存活检查

**管理(`/admin`,账号密码 —— HTTP Basic):**

- `/admin/account` `GET` / `PUT` — 读取或修改用户名 / 密码(任一字段可选)
- `/admin/api-key` `GET`、`/admin/api-key/rotate` `POST` — agent 用的那把密钥
- `/admin/connection` `GET` — 探测到的局域网 IP(用于把其他机器指向网关)
- `/admin/providers`、`/admin/providers/:id` `POST`/`PUT`/`DELETE`、`/admin/providers/:id/discover` `POST` — 后端增删改查 + 模型发现
- `/admin/models`、`/admin/models/:name/{providers,priority,map,disable,test}` — 路由表增删改查、[按来源的模型名映射](#模型名映射)、端到端测试
- `/admin/logs` `GET` — 近期调用(落盘日志的尾部)
- `/admin/stats?range=24h|7d|30d|90d|all` `GET` — 基于保留历史的聚合统计
- `/admin/storage` `GET` — 查看 `data.json` 和 `logs.jsonl` 的位置
- `/admin/circuit` `GET`、`/admin/circuit/:id/reset` `POST` — 熔断快照 + 手动重置

---

## 存储说明

所有东西都放在一个数据目录里(默认 `~/.myapikey`):

| 文件 | 内容 |
|---|---|
| `data.json` | 全部配置 —— 后端、按模型的路由表、账号、API Key |
| `logs.jsonl` | 调用历史,每行一个 JSON 对象(保留约 90 天 / 100 万行) |
| `credentials.txt` | 人可读的网页登录信息 + API Key,每次启动重新生成 |
| `client.json` | CLI 客户端配置(base url + 登录信息 + API Key) |

用 `--data-dir <路径>` 或 `MYAPIKEY_DATA_DIR` 覆盖该目录。调用日志从不放进内存:「最近调用」时间线是尾部读取最新的约 200 条,统计则是按需流式扫描整个保留文件。

---

## 开发指南

```bash
npm install
npm run build:web      # 把 Vue 界面构建到 packages/web/dist(首次,以及每次改完界面后)
npm start              # tsx ... serve(网关在 :7800)
npm run dev            # 网关,带 watch 热重载
npm run dev:web        # vite 开发服务器(把 /openai、/anthropic、/admin 代理到 :7800)
npm run typecheck      # tsc(core)+ vue-tsc(web)
```

手动测试网关:起一个 mock 上游,然后在临时端口上用 `serve --data-dir /tmp/myapikey` 跑。

---

## 说明与非目标

- **不做 OpenAI ↔ Anthropic 翻译。** 如果某个后端不会说 agent 使用的格式,那次调用就会失败(`404`)。将来可以在不改变 agent 端接口的前提下叠加。
- **没有数据库。** 配置放一个 `data.json`,保留的调用历史放 `logs.jsonl`。
- **没有 TLS。** 面向局域网 / 家用服务器,在你自己的网络里用。若要暴露到外网,请放到带 TLS 的反向代理后面。
- **登录密码和 API Key 是分开的两把。** API Key 是 agent 用的;若某个工具的配置泄露了,就轮换它(`POST /admin/api-key/rotate` 或网页界面)。两把都不要交给不可信的代码路径。
