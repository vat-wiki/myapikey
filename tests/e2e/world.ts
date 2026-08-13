import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Server } from "node:http";
import { createServer, get } from "node:http";
import type { GateConfig } from "../../packages/core/src/shared/types";

/**
 * E2E topology, owned by the spec. startWorld() boots:
 *   1. a scripted MOCK UPSTREAM on port GATEWAY_PORT+1 — the thing the gateway
 *      forwards to. Tests program it per-case (set(matcher, response)).
 *   2. the REAL gateway, as a real `tsx … serve` child process on GATEWAY_PORT,
 *      pointed at a throwaway data dir pre-seeded with known credentials and a
 *      model that routes to the mock upstream.
 * Spawning the actual CLI (not in-process createApp) means the E2E tier also
 * exercises the commander wiring + `serve` bootstrap + real process boundaries.
 */

export const GATEWAY_PORT = Number(process.env.E2E_GATEWAY_PORT ?? 7807);
export const MOCK_PORT = GATEWAY_PORT + 1;
export const GATEWAY_URL = `http://127.0.0.1:${GATEWAY_PORT}`;
export const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}`;
const ACCOUNT = { username: "admin", password: "password123" };
const API_KEY = "sk-myapikey-e2e";

/** A request the mock upstream received. */
export interface MockRequest {
  method: string;
  url: string;
  body: string;
}
export interface MockResponse {
  status?: number;
  headers?: Record<string, string>;
  /** string body verbatim, or object/array → JSON.stringified. */
  body?: unknown;
}
export interface MockUpstream {
  url: string;
  requests: MockRequest[];
  /** Program a response for URLs matching `matcher` (substring or RegExp).
   *  Later `set` calls take precedence over earlier ones (last match wins). */
  set: (matcher: string | RegExp, response: MockResponse | MockResponder) => void;
  /** Forget all programmed routes + recorded requests. */
  reset: () => void;
  close: () => Promise<void>;
}
type MockResponder = (req: MockRequest) => MockResponse;

function startMockUpstream(): Promise<MockUpstream> {
  const routes: { matcher: string | RegExp; respond: MockResponder }[] = [];
  const requests: MockRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const r: MockRequest = { method: req.method ?? "GET", url: req.url ?? "/", body: Buffer.concat(chunks).toString("utf8") };
      requests.push(r);
      // Last route that matches wins — tests can override per-case after reset.
      let hit: MockResponse = { status: 404, body: { error: { message: "no mock route" } } };
      for (const route of routes) {
        const m = typeof route.matcher === "string" ? r.url.includes(route.matcher) : route.matcher.test(r.url);
        if (m) hit = route.respond(r);
      }
      const status = hit.status ?? 200;
      const body = hit.body === undefined ? "" : typeof hit.body === "string" ? hit.body : JSON.stringify(hit.body);
      res.writeHead(status, { "content-type": "application/json", ...(hit.headers ?? {}) });
      res.end(body);
    });
  });
  return new Promise((resolveWorld) => {
    server.listen(MOCK_PORT, "127.0.0.1", () => {
      resolveWorld({
        url: MOCK_URL,
        requests,
        set: (matcher, response) => {
          const respond: MockResponder = typeof response === "function" ? (response as MockResponder) : () => response as MockResponse;
          routes.unshift({ matcher, respond }); // unshift → last set() wins (first in iteration)
        },
        reset: () => { routes.length = 0; requests.length = 0; },
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

/** The seeded config: two providers (primary/fallback) pointing at the mock
 *  upstream on distinct base paths, plus a `ping` model (primary only) and a
 *  `ha` model (primary→fallback chain) to exercise failover. */
function seedConfig(): GateConfig {
  const base = (host: string) => ({
    baseUrlOpenai: `${MOCK_URL}/${host}/v1`,
    baseUrlAnthropic: `${MOCK_URL}/${host}`,
  });
  return {
    version: 5,
    account: ACCOUNT,
    apiKey: API_KEY,
    providers: [
      { id: "prv_primary", name: "primary", apiKey: "sk-up", formats: ["openai", "anthropic"], supportsResponses: true, createdAt: 1000, ...base("primary") },
      { id: "prv_fallback", name: "fallback", apiKey: "sk-up", formats: ["openai", "anthropic"], supportsResponses: true, createdAt: 1000, ...base("fallback") },
    ],
    models: {
      ping: {
        openai: { enabled: true, providers: [{ id: "prv_primary" }] },
        anthropic: { enabled: true, providers: [{ id: "prv_primary" }] },
        responses: { enabled: true, providers: [{ id: "prv_primary" }] },
      },
      ha: {
        openai: { enabled: true, providers: [{ id: "prv_primary" }, { id: "prv_fallback" }] },
        anthropic: { enabled: false, providers: [] },
        responses: { enabled: false, providers: [] },
      },
    },
  };
}

export interface World {
  gatewayUrl: string;
  account: { username: string; password: string };
  apiKey: string;
  mock: MockUpstream;
  stop: () => Promise<void>;
}

function waitForHealth(url: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((res, rej) => {
    const tick = () => {
      get(`${url}/health`, (r) => {
        r.resume();
        if (r.statusCode === 200) return res();
        if (Date.now() > deadline) return rej(new Error("gateway never became healthy"));
        setTimeout(tick, 100);
      }).on("error", () => {
        if (Date.now() > deadline) return rej(new Error("gateway never became healthy"));
        setTimeout(tick, 100);
      });
    };
    tick();
  });
}

export async function startWorld(): Promise<World> {
  const mock = await startMockUpstream();
  const dataDir = mkdtempSync(join(tmpdir(), "myapikey-e2e-"));
  writeFileSync(join(dataDir, "data.json"), JSON.stringify(seedConfig(), null, 2));

  const cli = resolve(process.cwd(), "packages/core/src/cli/index.ts");
  // --web-dir points at a missing path so `serve` uses the plain-text banner
  // fallback (the SPA isn't needed for API-level E2E and shouldn't be built).
  const child = spawn(
    process.execPath,
    ["--import", "tsx", cli, "serve", "--port", String(GATEWAY_PORT), "--data-dir", dataDir, "--web-dir", "/nonexistent-e2e"],
    // detached → own process group, so teardown's kill(-pid) reaps the tsx-forked
    // node child too (kill on just the tsx parent leaves the server orphaned).
    { stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  child.stdout?.on("data", () => { /* swallow banner */ });
  child.stderr?.on("data", () => { /* swallow */ });

  try {
    await waitForHealth(GATEWAY_URL);
  } catch (e) {
    child.kill("SIGKILL");
    await mock.close();
    rmSync(dataDir, { recursive: true, force: true });
    throw e;
  }

  return {
    gatewayUrl: GATEWAY_URL,
    account: ACCOUNT,
    apiKey: API_KEY,
    mock,
    stop: async () => {
      // tsx forks a child node process: kill the whole group to avoid orphans.
      try { process.kill(-child.pid!); } catch { child.kill("SIGKILL"); }
      await mock.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// Keep `Server` import meaningful for type clarity in editors even if unused.
export type { Server };
