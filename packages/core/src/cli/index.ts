#!/usr/bin/env tsx
import { Command, Option } from "commander";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "../server/app";
import { Store } from "../server/store";
import { DEFAULT_PORT, DEFAULT_DATA_DIR } from "../shared/config";
import { loadProfile, saveProfile, resolveApiKey, CLIENT_PROFILE_PATH } from "./config";
import { api, ApiError, makeCtx } from "./client";

interface Globals {
  url?: string;
  user?: string;
  pass?: string;
  apiKey?: string;
}

const program = new Command();
program
  .name("myapikey")
  .description("MyAPIKey — personal LLM API gateway")
  .option("-u, --url <url>", "gateway base URL")
  .option("--user <user>", "account username")
  .option("--pass <pass>", "account password")
  .option("--api-key <key>", "api key for /openai/v1 + /anthropic/v1 (agent calls)")
  .hook("preAction", () => undefined);

const ctx = (): ReturnType<typeof makeCtx> => makeCtx(program.opts<Globals>());

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------
program
  .command("serve")
  .description("run the gateway server")
  .option("-p, --port <n>", "port", String(DEFAULT_PORT))
  .option("--data-dir <dir>", "directory for data.json + logs.jsonl")
  .option("--web-dir <path>", "path to built web dist", resolve(import.meta.dirname, "../../../web/dist"))
  .action(async (opts: { port: string; dataDir?: string; webDir: string }) => {
    const dataDir = resolve(opts.dataDir ?? process.env.MYAPIKEY_DATA_DIR ?? DEFAULT_DATA_DIR);
    const firstRun = !existsSync(join(dataDir, "data.json"));
    const store = new Store(dataDir);
    const credentialsFile = store.writeCredentialsFile();
    const webDir = existsSync(opts.webDir) ? opts.webDir : undefined;
    const app = createApp(store, { webDir });

    const port = Number(opts.port);
    serve({ fetch: app.fetch, port }, async (info) => {
      const url = `http://localhost:${info.port}`;
      console.log(`\n  MyAPIKey listening on ${url}`);
      if (webDir) console.log(`  web UI:  ${url}`);
      else console.log(`  web UI:  not built (run: npm run build:web)`);
      console.log(`  proxy:   ${url}/openai/v1/chat/completions   (OpenAI)`);
      console.log(`           ${url}/openai/v1/responses           (OpenAI Responses)`);
      console.log(`           ${url}/anthropic/v1/messages         (Anthropic)`);
      console.log(`  data:    ${dataDir}  (override with --data-dir or MYAPIKEY_DATA_DIR)`);
      console.log(`  log:     ${store.getPaths().serverLogFile}  (errors + failover/cooldown events; level via MYAPIKEY_LOG_LEVEL)\n`);
      store.getLogger().info(`gateway started on port ${info.port}, data=${dataDir}`);

      if (firstRun) {
        const { account, apiKey } = store.get();
        console.log("  First run — here are your credentials (save them):");
        console.log(`    username : ${account.username}   (web login)`);
        console.log(`    password : ${account.password}   (web login)`);
        console.log(`    api key  : ${apiKey}   (put this in the tool's "api key" field)`);
        console.log(`  ↳ also written to ${credentialsFile}  (cat it anytime if you forget)\n`);
        saveProfile({ url, username: account.username, password: account.password, apiKey });
        console.log(`  Saved to ${CLIENT_PROFILE_PATH} for CLI use.`);
        console.log(`  Next: myapikey provider add <name> --base-url-openai <url> --key <key> --formats openai,anthropic\n`);
      }
    });
  });

// ---------------------------------------------------------------------------
// whoami
// ---------------------------------------------------------------------------
program
  .command("whoami")
  .description("print connection info for wiring up agents")
  .action(() => {
    const profile = loadProfile();
    if (!profile) {
      console.log("No saved profile. Run `myapikey serve` first (or use --url/--api-key).");
      return;
    }
    const apiKey = resolveApiKey() ?? profile.apiKey;
    console.log("Connection info:");
    console.log(`  base url : ${profile.url}`);
    if (apiKey) {
      console.log(`  api key  : ${apiKey}   ← put this in the tool's "api key" field`);
    } else {
      console.log(`  api key  : (not saved — run \`myapikey serve\` on your gateway, or set MYAPIKEY_API_KEY)`);
    }
    console.log(`  login    : ${profile.username} / ${profile.password}   ← only for the web UI\n`);
    if (apiKey) {
      console.log("Example (OpenAI SDK):");
      console.log(`  OPENAI_BASE_URL=${profile.url}/openai/v1 OPENAI_API_KEY=${apiKey}`);
      console.log("\nExample (Claude Code / Anthropic):");
      console.log(`  ANTHROPIC_BASE_URL=${profile.url}/anthropic ANTHROPIC_API_KEY=${apiKey}`);
    }
  });

// ---------------------------------------------------------------------------
// provider
// ---------------------------------------------------------------------------
const provider = program.command("provider").description("manage backends");

provider
  .command("add <name>")
  .option("--base-url-openai <url>", "OpenAI base URL incl. version, e.g. https://api.openai.com/v1", "")
  .option("--base-url-anthropic <url>", "Anthropic base URL excl. /v1, e.g. https://api.anthropic.com", "")
  .option("--key <key>", "api key for the backend", "")
  .option("--formats <list>", "comma list: openai,anthropic", "openai")
  .option("--rpm <n>", "optional request-per-minute cap (pace a free/limited key)", "")
  .action(async (name: string, opts: { baseUrlOpenai: string; baseUrlAnthropic: string; key: string; formats: string; rpm: string }) => {
    const formats = opts.formats.split(",").map((s) => s.trim()).filter(Boolean) as ("openai" | "anthropic")[];
    const rpm = Number(opts.rpm);
    const body: Record<string, unknown> = {
      name,
      baseUrlOpenai: opts.baseUrlOpenai,
      baseUrlAnthropic: opts.baseUrlAnthropic,
      apiKey: opts.key,
      formats,
    };
    if (Number.isFinite(rpm) && rpm > 0) body.rpm = Math.floor(rpm);
    const r = await api(ctx(), "POST", "/admin/providers", body);
    console.log(`Added provider ${(r as any).provider.name} (${(r as any).provider.id})`);
  });

provider.command("list").action(async () => {
  const r = (await api(ctx(), "GET", "/admin/providers")) as { providers: any[] };
  if (!r.providers.length) return console.log("No providers yet. Add one: myapikey provider add <name> ...");
  for (const p of r.providers)
    console.log(`${p.id}  ${p.name}  [${p.formats.join(",")}]  openai:${p.baseUrlOpenai || "-"}  anthropic:${p.baseUrlAnthropic || "-"}  key:${p.apiKey}`);
});

async function resolveProviderId(ref: string): Promise<string> {
  const r = (await api(ctx(), "GET", "/admin/providers")) as { providers: any[] };
  const byId = r.providers.find((p) => p.id === ref);
  if (byId) return byId.id;
  const byName = r.providers.filter((p) => p.name === ref);
  if (byName.length === 1) return byName[0].id;
  if (byName.length > 1) throw new Error(`Multiple providers named '${ref}'; use the id.`);
  throw new Error(`No provider matching '${ref}'.`);
}

provider.command("remove <ref>").description("remove by id or name").action(async (ref: string) => {
  const id = await resolveProviderId(ref);
  await api(ctx(), "DELETE", `/admin/providers/${id}`);
  console.log(`Removed provider ${id}.`);
});

provider
  .command("models <ref>")
  .description("discover available models from a backend")
  .action(async (ref: string) => {
    const id = await resolveProviderId(ref);
    const r = (await api(ctx(), "POST", `/admin/providers/${id}/discover`)) as { models: string[] };
    if (!r.models.length) return console.log("No models discovered (check base url / key / formats).");
    for (const m of r.models) console.log(m);
  });

// ---------------------------------------------------------------------------
// model
// ---------------------------------------------------------------------------
const model = program.command("model").description("manage the routing table");

/** Shared --format flag: every model mutation acts on one routing slot. */
function fmtOption() {
  return new Option("-f, --format <fmt>", "routing slot to act on")
    .choices(["openai", "anthropic", "responses"])
    .makeOptionMandatory();
}

model.command("list").action(async () => {
  const r = (await api(ctx(), "GET", "/admin/models")) as { models: any[] };
  if (!r.models.length) return console.log("No models configured.");
  const fmts = ["openai", "anthropic", "responses"] as const;
  for (const m of r.models) {
    console.log(m.name);
    for (const f of fmts) {
      const fe = m[f];
      const chain = fe.providers.map((p: any) => (p.model ? `${p.name}→${p.model}` : p.name)).join(" → ") || "(none)";
      console.log(`  ${f.padEnd(9)} ${fe.enabled ? "✓" : "·"} ${chain}`);
    }
    if (m.paceRpm) console.log(`  pace      ${m.paceRpm}/min (one every ${Math.round(60 / m.paceRpm)}s)`);
  }
});

model
  .command("enable <name>")
  .addOption(fmtOption())
  .option("--via <provider>", "provider id or name to route through")
  .action(async (name: string, opts: { format: "openai" | "anthropic"; via?: string }) => {
    let providerId: string | undefined;
    if (opts.via) providerId = await resolveProviderId(opts.via);
    await api(ctx(), "POST", "/admin/models", { name, format: opts.format, providers: providerId ? [providerId] : [] });
    console.log(
      `Enabled ${name} [${opts.format}]${providerId ? ` via ${opts.via}` : ""}. Add fallbacks: myapikey model add-provider ${name} <provider> --format ${opts.format}`,
    );
  });

model
  .command("disable <name>")
  .addOption(fmtOption())
  .action(async (name: string, opts: { format: "openai" | "anthropic" }) => {
    await api(ctx(), "POST", `/admin/models/${encodeURIComponent(name)}/disable`, { format: opts.format });
    console.log(`Disabled ${name} [${opts.format}].`);
  });

model
  .command("add-provider <name> <ref>")
  .addOption(fmtOption())
  .action(async (name: string, ref: string, opts: { format: "openai" | "anthropic" }) => {
    const providerId = await resolveProviderId(ref);
    await api(ctx(), "POST", `/admin/models/${encodeURIComponent(name)}/providers`, { format: opts.format, providerId });
    console.log(`Added ${ref} to ${name} [${opts.format}].`);
  });

model
  .command("remove-provider <name> <ref>")
  .addOption(fmtOption())
  .action(async (name: string, ref: string, opts: { format: "openai" | "anthropic" }) => {
    const providerId = await resolveProviderId(ref);
    await api(ctx(), "DELETE", `/admin/models/${encodeURIComponent(name)}/providers/${providerId}?format=${opts.format}`);
    console.log(`Removed ${ref} from ${name} [${opts.format}].`);
  });

model
  .command("prioritize <name> <refs...>")
  .description("reorder sources on a route (left = primary); list every source on the route, in order")
  .addOption(fmtOption())
  .action(async (name: string, refs: string[], opts: { format: "openai" | "anthropic" }) => {
    // The server reorders EXISTING slots (a duplicate id can occupy several), so
    // each ref maps onto the chain left-to-right — a second ref with the same id
    // consumes the next slot for that id. The refs must cover the whole route
    // (the resulting indices are a permutation of [0..n-1]).
    const wanted: string[] = [];
    for (const ref of refs) wanted.push(await resolveProviderId(ref));
    const r = (await api(ctx(), "GET", "/admin/models")) as { models: any[] };
    const entry = (r.models as any[]).find((m) => m.name === name);
    if (!entry) throw new Error(`No model '${name}'.`);
    const chain: { id: string }[] = entry[opts.format]?.providers ?? [];
    const used = new Set<number>();
    const order: number[] = [];
    for (const id of wanted) {
      const idx = chain.findIndex((s, i) => s.id === id && !used.has(i));
      if (idx === -1)
        throw new Error(`'${name}' [${opts.format}] has no remaining slot for that source — list every source on the route exactly once.`);
      used.add(idx);
      order.push(idx);
    }
    await api(ctx(), "PUT", `/admin/models/${encodeURIComponent(name)}/priority`, { format: opts.format, order });
    console.log(`Priority for ${name} [${opts.format}]: ${refs.join(" → ")}`);
  });

model
  .command("pace <name> [rpm]")
  .description("set/clear the per-model even-pacing limit (requests/min, spread one every 60/rpm s; 0 = unlimited)")
  .action(async (name: string, rpmRaw: string) => {
    const rpm = Math.floor(Number(rpmRaw ?? 0)) || 0;
    const r = (await api(ctx(), "PUT", `/admin/models/${encodeURIComponent(name)}/pace`, { rpm })) as { paceRpm: number };
    console.log(r.paceRpm ? `Pacing ${name} at ${r.paceRpm}/min (one every ${Math.round(60 / r.paceRpm)}s).` : `Pacing cleared for ${name} (unlimited).`);
  });

model.command("remove <name>").description("remove a model entirely (both formats)").action(async (name: string) => {
  await api(ctx(), "DELETE", `/admin/models/${encodeURIComponent(name)}`);
  console.log(`Removed ${name}.`);
});

// ---------------------------------------------------------------------------
// call
// ---------------------------------------------------------------------------
program
  .command("call <model> [prompt...]")
  .description("quick test a model through the gateway")
  .action(async (modelName: string, promptParts: string[]) => {
    const prompt = promptParts.join(" ").trim();
    const input = prompt || (await readStdin());
    if (!input) return console.log("Provide a prompt: myapikey call <model> hello");
    const r = (await api(ctx(), "POST", "/openai/v1/chat/completions", {
      model: modelName,
      messages: [{ role: "user", content: input }],
    })) as any;
    const content = r?.choices?.[0]?.message?.content;
    console.log(typeof content === "string" ? content : JSON.stringify(content ?? r));
  });

function readStdin(): Promise<string> {
  return new Promise((res) => {
    let data = "";
    if (process.stdin.isTTY) return res("");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => res(data));
  });
}

// ---------------------------------------------------------------------------
program.parseAsync().catch((e) => {
  if (e instanceof ApiError) console.error(`Error ${e.status}: ${e.message}`);
  else console.error(e?.message ?? String(e));
  process.exit(1);
});
