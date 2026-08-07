import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tmpStore } from "../helpers/store";
import { json } from "../helpers/json";
import { seedStore } from "../helpers/fixtures";
import { createApp } from "../../src/server/app";
import type { Store } from "../../src/server/store";

describe("server/app", () => {
  let store: Store;
  let cleanup: () => void;
  // Known creds so each test can build the matching Authorization header.
  const basic = "Basic " + Buffer.from("admin:password123").toString("base64");
  const bearer = "Bearer sk-myapikey-test";

  beforeEach(() => {
    const t = tmpStore();
    store = t.store;
    cleanup = t.cleanup;
    return seedStore(store, {
      account: { username: "admin", password: "password123" },
      apiKey: "sk-myapikey-test",
    });
  });

  afterEach(() => cleanup());

  describe("/health", () => {
    it("reports ok", async () => {
      const res = await createApp(store).request("/health");
      expect(res.status).toBe(200);
      expect((await json<{ ok: boolean }>(res)).ok).toBe(true);
    });
  });

  describe("/v1 isolation (api-key only)", () => {
    it("rejects the account Basic creds", async () => {
      const res = await createApp(store).request("/v1/models", {
        headers: { authorization: basic },
      });
      expect(res.status).toBe(401);
    });

    it("accepts the api key as Bearer", async () => {
      const res = await createApp(store).request("/v1/models", {
        headers: { authorization: bearer },
      });
      expect(res.status).toBe(200);
    });
  });

  describe("/admin isolation (account only)", () => {
    it("rejects the api key as Bearer", async () => {
      const res = await createApp(store).request("/admin/account", {
        headers: { authorization: bearer },
      });
      expect(res.status).toBe(401);
    });

    it("accepts the account Basic creds", async () => {
      const res = await createApp(store).request("/admin/account", {
        headers: { authorization: basic },
      });
      expect(res.status).toBe(200);
    });
  });

  describe("web UI fallback", () => {
    it("returns a 404 banner when no webDir is configured", async () => {
      const res = await createApp(store).request("/");
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("Web UI not built");
    });

    it("serves the built index.html when webDir is set", async () => {
      const dir = mkdtempSync(join(tmpdir(), "myapikey-web-"));
      const html = "<!doctype html><html><body>gateway-ui</body></html>";
      writeFileSync(join(dir, "index.html"), html);
      try {
        const res = await createApp(store, { webDir: dir }).request("/");
        expect(res.status).toBe(200);
        expect(await res.text()).toBe(html);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
