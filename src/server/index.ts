#!/usr/bin/env tsx
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { Store } from "./store";
import { DEFAULT_DATA_DIR, DEFAULT_PORT } from "../shared/config";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: String(DEFAULT_PORT) },
    "data-dir": { type: "string" },
    "web-dir": { type: "string" },
  },
});

const dataDir = resolve(values["data-dir"] ?? process.env.MYAPIKEY_DATA_DIR ?? DEFAULT_DATA_DIR);
const firstRun = !existsSync(join(dataDir, "data.json"));
const store = new Store(dataDir);
const defaultWebDir = fileURLToPath(new URL("../../dist", import.meta.url));
const webDir = existsSync(values["web-dir"] ?? defaultWebDir)
  ? resolve(values["web-dir"] ?? defaultWebDir)
  : undefined;
const app = createApp(store, { webDir });
const port = Number(values.port);

serve({ fetch: app.fetch, port }, async (info) => {
  const url = `http://localhost:${info.port}`;
  console.log(`\n  MyAPIKey listening on ${url}`);
  console.log(`  web UI:  ${webDir ? url : "not built (run: npm run build:web)"}`);
  console.log(`  proxy:   ${url}/openai-chat/v1/chat/completions   (OpenAI chat)`);
  console.log(`           ${url}/openai-responses/v1/responses     (OpenAI Responses)`);
  console.log(`           ${url}/anthropic/v1/messages             (Anthropic)`);
  console.log(`  data:    ${dataDir}  (override with --data-dir or MYAPIKEY_DATA_DIR)`);
  console.log(`  log:     ${store.getPaths().serverLogFile}  (errors + failover/cooldown events; level via MYAPIKEY_LOG_LEVEL)\n`);
  store.getLogger().info(`gateway started on port ${info.port}, data=${dataDir}`);

  if (firstRun) {
    console.log("  First run — set your web password at the URL above, then copy the");
    console.log("  API key from the Connect tab.\n");
  }
});
