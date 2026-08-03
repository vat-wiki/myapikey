#!/usr/bin/env tsx
import { Command } from "commander";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "../server/app";
import { Store } from "../server/store";
import { DEFAULT_PORT } from "../shared/config";
import { loadProfile, saveProfile } from "./config";
import { api, ApiError, makeCtx } from "./client";

interface Globals {
  url?: string;
  user?: string;
  pass?: string;
}

const program = new Command();
program
  .name("mygate")
  .description("my-ai-gate — personal LLM API gateway")
  .option("-u, --url <url>", "gateway base URL")
  .option("--user <user>", "account username")
  .option("--pass <pass>", "account password")
  .hook("preAction", () => undefined);

const ctx = (): ReturnType<typeof makeCtx> => makeCtx(program.opts<Globals>());

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------
program
  .command("serve")
  .description("run the gateway server")
  .option("-p, --port <n>", "port", String(DEFAULT_PORT))
  .option("--data <path>", "path to data.json", "data.json")
  .option("--web-dir <path>", "path to built web dist", resolve(import.meta.dirname, "../../../web/dist"))
  .action(async (opts: { port: string; data: string; webDir: string }) => {
    const dataPath = resolve(opts.data);
    const firstRun = !existsSync(dataPath);
    const store = new Store(dataPath);
    const webDir = existsSync(opts.webDir) ? opts.webDir : undefined;
    const app = createApp(store, { webDir });

    const port = Number(opts.port);
    serve({ fetch: app.fetch, port }, async (info) => {
      const url = `http://localhost:${info.port}`;
      console.log(`\n  my-ai-gate listening on ${url}`);
      if (webDir) console.log(`  web UI:  ${url}`);
      else console.log(`  web UI:  not built (run: npm run build:web)`);
      console.log(`  proxy:   ${url}/v1/chat/completions  (OpenAI)`);
      console.log(`           ${url}/v1/messages            (Anthropic)\n`);

      if (firstRun) {
        const { account } = store.get();
        console.log("  First run — here are your credentials (save them):");
        console.log(`    username: ${account.username}`);
        console.log(`    password: ${account.password}\n`);
        saveProfile({ url, username: account.username, password: account.password });
        console.log(`  Saved to ~/.config/mygate/config.json for CLI use.`);
        console.log(`  Next: mygate provider add <name> --base-url <url> --key <key> --formats openai,anthropic\n`);
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
      console.log("No saved profile. Run `mygate serve` first (or use --url/--user/--pass).");
      return;
    }
    console.log("Connection info for agents:");
    console.log(`  base url : ${profile.url}`);
    console.log(`  username : ${profile.username}`);
    console.log(`  password : ${profile.password}   (put this in the tool's "api key" field)\n`);
    console.log("Example (OpenAI SDK):");
    console.log(`  OPENAI_BASE_URL=${profile.url}/v1 OPENAI_API_KEY=${profile.password}`);
    console.log("\nExample (Claude Code / Anthropic):");
    console.log(`  ANTHROPIC_BASE_URL=${profile.url} ANTHROPIC_API_KEY=${profile.password}`);
  });

// ---------------------------------------------------------------------------
// provider
// ---------------------------------------------------------------------------
const provider = program.command("provider").description("manage backends");

provider
  .command("add <name>")
  .option("--base-url <url>", "backend base URL (incl. /v1)", "")
  .option("--key <key>", "api key for the backend", "")
  .option("--formats <list>", "comma list: openai,anthropic", "openai")
  .action(async (name: string, opts: { baseUrl: string; key: string; formats: string }) => {
    const formats = opts.formats.split(",").map((s) => s.trim()).filter(Boolean) as ("openai" | "anthropic")[];
    const r = await api(ctx(), "POST", "/admin/providers", {
      name,
      baseUrl: opts.baseUrl,
      apiKey: opts.key,
      formats,
    });
    console.log(`Added provider ${(r as any).provider.name} (${(r as any).provider.id})`);
  });

provider.command("list").action(async () => {
  const r = (await api(ctx(), "GET", "/admin/providers")) as { providers: any[] };
  if (!r.providers.length) return console.log("No providers yet. Add one: mygate provider add <name> ...");
  for (const p of r.providers) console.log(`${p.id}  ${p.name}  [${p.formats.join(",")}]  ${p.baseUrl}  key:${p.apiKey}`);
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

model.command("list").action(async () => {
  const r = (await api(ctx(), "GET", "/admin/models")) as { models: any[] };
  if (!r.models.length) return console.log("No models configured.");
  for (const m of r.models) {
    const provs = m.providers.map((p: any) => p.name).join(" → ") || "(none)";
    console.log(`${m.enabled ? "✓" : "·"} ${m.name}   [${provs}]`);
  }
});

model
  .command("enable <name>")
  .option("--via <provider>", "provider id or name to route through")
  .action(async (name: string, opts: { via?: string }) => {
    let providerId: string | undefined;
    if (opts.via) providerId = await resolveProviderId(opts.via);
    await api(ctx(), "POST", "/admin/models", { name, providerId });
    console.log(`Enabled ${name}${providerId ? ` via ${opts.via}` : ""}. Add fallbacks with: mygate model add-provider ${name} <provider>`);
  });

model.command("disable <name>").action(async (name: string) => {
  await api(ctx(), "POST", `/admin/models/${encodeURIComponent(name)}/disable`);
  console.log(`Disabled ${name}.`);
});

model.command("add-provider <name> <ref>").action(async (name: string, ref: string) => {
  const providerId = await resolveProviderId(ref);
  await api(ctx(), "POST", `/admin/models/${encodeURIComponent(name)}/providers`, { providerId });
  console.log(`Added ${ref} to ${name}.`);
});

model.command("remove-provider <name> <ref>").action(async (name: string, ref: string) => {
  const providerId = await resolveProviderId(ref);
  await api(ctx(), "DELETE", `/admin/models/${encodeURIComponent(name)}/providers/${providerId}`);
  console.log(`Removed ${ref} from ${name}.`);
});

model
  .command("prioritize <name> <refs...>")
  .description("set provider priority order (left = primary)")
  .action(async (name: string, refs: string[]) => {
    const ids: string[] = [];
    for (const ref of refs) ids.push(await resolveProviderId(ref));
    await api(ctx(), "PUT", `/admin/models/${encodeURIComponent(name)}/priority`, { providers: ids });
    console.log(`Priority for ${name}: ${refs.join(" → ")}`);
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
    if (!input) return console.log("Provide a prompt: mygate call <model> hello");
    const r = (await api(ctx(), "POST", "/v1/chat/completions", {
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
