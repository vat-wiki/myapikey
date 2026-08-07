import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockFetch, type FetchMock } from "../helpers/mock";

// CLIENT_PROFILE_PATH + DEFAULT_DATA_DIR are computed at module load from
// homedir() (which honors process.env.HOME on Linux), so each test re-imports
// the client module after pointing HOME at a throwaway dir. That keeps the
// "no creds" cases honest even when the dev machine has a real ~/.myapikey.
const ENV_KEYS = ["MYAPIKEY_URL", "MYAPIKEY_USER", "MYAPIKEY_PASS", "MYAPIKEY_API_KEY", "HOME"] as const;

describe("cli/client", () => {
  let tmpHome: string;
  let savedEnv: Record<string, string | undefined>;
  let client: typeof import("../../src/cli/client");
  let fetchMock: FetchMock | null = null;

  beforeEach(async () => {
    tmpHome = mkdtempSync(join(tmpdir(), "mk-cli-"));
    savedEnv = {};
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env.HOME = tmpHome;
    for (const k of ["MYAPIKEY_URL", "MYAPIKEY_USER", "MYAPIKEY_PASS", "MYAPIKEY_API_KEY"]) {
      delete process.env[k];
    }
    vi.resetModules();
    client = await import("../../src/cli/client");
  });

  afterEach(() => {
    fetchMock?.restore();
    fetchMock = null;
    rmSync(tmpHome, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  const b64 = (s: string): string => Buffer.from(s).toString("base64");

  describe("makeCtx", () => {
    it("strips trailing slashes from the url", () => {
      const ctx = client.makeCtx({ url: "http://x:7800//" });
      expect(ctx.url).toBe("http://x:7800");
    });

    it("builds a Basic auth header from user/pass", () => {
      const ctx = client.makeCtx({ user: "u", pass: "p" });
      expect(ctx.auth).toBe("Basic " + b64("u:p"));
    });

    it("sets auth to empty string when no account creds resolve", () => {
      const ctx = client.makeCtx({});
      expect(ctx.auth).toBe("");
    });

    it("populates apiKey from the flag", () => {
      const ctx = client.makeCtx({ apiKey: "sk-test" });
      expect(ctx.apiKey).toBe("sk-test");
    });

    it("flag url beats MYAPIKEY_URL env", () => {
      process.env.MYAPIKEY_URL = "http://env-host:7800";
      const ctx = client.makeCtx({ url: "http://flag-host:7800" });
      expect(ctx.url).toBe("http://flag-host:7800");
    });

    it("falls back to MYAPIKEY_URL env (and still strips trailing slashes)", () => {
      process.env.MYAPIKEY_URL = "http://env-host:7800/";
      const ctx = client.makeCtx({});
      expect(ctx.url).toBe("http://env-host:7800");
    });
  });

  describe("api — /admin (account Basic auth)", () => {
    it("sends the Basic header (not Bearer) and returns parsed JSON on 200", async () => {
      const ctx = client.makeCtx({ url: "http://g:7800", user: "u", pass: "p" });
      fetchMock = mockFetch([
        { match: "/admin/providers", response: { status: 200, body: { ok: true, providers: [] } } },
      ]);
      const out = await client.api(ctx, "GET", "/admin/providers");
      expect(out).toEqual({ ok: true, providers: [] });

      expect(fetchMock.calls).toHaveLength(1);
      const c = fetchMock.calls[0];
      expect(c.url).toBe("http://g:7800/admin/providers");
      expect(c.method).toBe("GET");
      expect(c.headers.authorization).toBe("Basic " + b64("u:p"));
      // /admin must NOT authenticate with a Bearer token.
      expect(c.headers.authorization).not.toMatch(/^Bearer /);
      // GET carries no body.
      expect(c.body).toBe("");
    });

    it("throws ApiError with status + upstream error.message on a JSON error body", async () => {
      const ctx = client.makeCtx({ url: "http://g:7800", user: "u", pass: "p" });
      fetchMock = mockFetch([
        { match: "/admin/providers", response: { status: 401, body: { error: { message: "boom" } } } },
      ]);
      let err: unknown;
      try {
        await client.api(ctx, "GET", "/admin/providers");
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(client.ApiError);
      expect((err as { status: number }).status).toBe(401);
      expect((err as Error).message).toBe("boom");
    });

    it("falls back to the raw text when the error body is not JSON", async () => {
      const ctx = client.makeCtx({ url: "http://g:7800", user: "u", pass: "p" });
      fetchMock = mockFetch([
        { match: "/admin/whoami", response: { status: 500, body: "server hosed" } },
      ]);
      await expect(client.api(ctx, "GET", "/admin/whoami")).rejects.toMatchObject({
        status: 500,
        message: "server hosed",
      });
    });

    it("throws before fetch when ctx.auth is empty (no account creds)", async () => {
      const ctx = client.makeCtx({ url: "http://g:7800" }); // no user/pass → auth ""
      expect(ctx.auth).toBe("");
      await expect(client.api(ctx, "GET", "/admin/providers")).rejects.toThrow(
        "No account credentials for /admin",
      );
    });
  });

  describe("api — /v1 (Bearer api key)", () => {
    it("sends Bearer <apiKey> and serializes the JSON body", async () => {
      const ctx = client.makeCtx({ url: "http://g:7800", apiKey: "sk-v1" });
      fetchMock = mockFetch([
        { match: "/v1/chat/completions", response: { status: 200, body: { id: "chatcmpl-1" } } },
      ]);
      const body = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] };
      const out = await client.api(ctx, "POST", "/v1/chat/completions", body);
      expect(out).toEqual({ id: "chatcmpl-1" });

      expect(fetchMock.calls).toHaveLength(1);
      const c = fetchMock.calls[0];
      expect(c.url).toBe("http://g:7800/v1/chat/completions");
      expect(c.method).toBe("POST");
      expect(c.headers.authorization).toBe("Bearer sk-v1");
      expect(c.headers["content-type"]).toBe("application/json");
      expect(JSON.parse(c.body)).toEqual(body);
    });

    it("throws synchronously (before fetch) when ctx.apiKey is missing", async () => {
      const ctx = client.makeCtx({ url: "http://g:7800", user: "u", pass: "p" }); // no apiKey
      expect(ctx.apiKey).toBeUndefined();
      await expect(client.api(ctx, "POST", "/v1/chat/completions", { x: 1 })).rejects.toThrow(
        "No API key for /v1",
      );
    });
  });
});
