import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../../src/server/store";
import { CONFIG_VERSION } from "../../src/shared/config";
import { tmpStoreFromRaw, type TmpStore } from "../helpers/store";

/** Read what landed on disk after the constructor's load() ran migrations. */
function readDisk(ts: TmpStore): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ts.dir, "data.json"), "utf8"));
}

// Three reusable providers, referenced by stable id:
//  - prv_o: openai-only
//  - prv_a: anthropic-only
//  - prv_r: openai + supportsResponses (lands in BOTH the openai chain and the
//           responses chain — responses is split out, not moved)
const PRV_O = {
  id: "prv_o",
  name: "openai-src",
  baseUrlOpenai: "https://o.example/v1",
  baseUrlAnthropic: "https://o.example",
  apiKey: "sk-o",
  formats: ["openai"] as const,
  createdAt: 0,
};
const PRV_A = {
  id: "prv_a",
  name: "anthropic-src",
  baseUrlOpenai: "https://a.example/v1",
  baseUrlAnthropic: "https://a.example",
  apiKey: "sk-a",
  formats: ["anthropic"] as const,
  createdAt: 0,
};
const PRV_R = {
  id: "prv_r",
  name: "responses-src",
  baseUrlOpenai: "https://r.example/v1",
  baseUrlAnthropic: "https://r.example",
  apiKey: "sk-r",
  formats: ["openai"] as const,
  supportsResponses: true,
  createdAt: 0,
};

let ts: TmpStore | null = null;
afterEach(() => {
  ts?.cleanup();
  ts = null;
});

describe("Store migration (constructor load())", () => {
  describe("v1 model entries → v3 three-slot", () => {
    it("splits by format and adds a responses slot from supportsResponses sources", () => {
      ts = tmpStoreFromRaw({
        version: 1,
        account: { username: "admin", password: "p" },
        apiKey: "sk-myapikey-x",
        providers: [PRV_O, PRV_A, PRV_R],
        // prv_dangling is intentionally NOT defined in providers[].
        models: {
          "gpt-4o": { enabled: true, providers: ["prv_o", "prv_a", "prv_r", "prv_dangling"] },
        },
      });
      const m = ts.store.get().models["gpt-4o"] as unknown as {
        openai: { enabled: boolean; providers: { id: string; model?: string }[] };
        anthropic: { enabled: boolean; providers: { id: string; model?: string }[] };
        responses: { enabled: boolean; providers: { id: string; model?: string }[] };
      };
      // prv_r is openai+supportsResponses, so it stays in openai AND splits into responses.
      // (v5 migration folds the legacy string[] chains into {id} pairs on the same boot.)
      expect(m.openai).toEqual({ enabled: true, providers: [{ id: "prv_o" }, { id: "prv_r" }] });
      expect(m.anthropic).toEqual({ enabled: true, providers: [{ id: "prv_a" }] });
      expect(m.responses).toEqual({ enabled: true, providers: [{ id: "prv_r" }] });
      // Dangling id dropped from every chain.
      const all = [...m.openai.providers, ...m.anthropic.providers, ...m.responses.providers].map((s) => s.id);
      expect(all).not.toContain("prv_dangling");
      // Persisted to disk in the (v5) pair shape.
      expect((readDisk(ts).models as Record<string, unknown>)["gpt-4o"]).toEqual(m);
    });

    it("disables all three slots when the v1 entry was disabled", () => {
      ts = tmpStoreFromRaw({
        version: 1,
        account: { username: "admin", password: "p" },
        apiKey: "sk-myapikey-x",
        providers: [PRV_O, PRV_A, PRV_R],
        models: { "gpt-4o": { enabled: false, providers: ["prv_o", "prv_a", "prv_r"] } },
      });
      const m = ts.store.get().models["gpt-4o"] as unknown as {
        openai: { enabled: boolean; providers: { id: string; model?: string }[] };
        anthropic: { enabled: boolean; providers: { id: string; model?: string }[] };
        responses: { enabled: boolean; providers: { id: string; model?: string }[] };
      };
      expect(m.openai.enabled).toBe(false);
      expect(m.anthropic.enabled).toBe(false);
      expect(m.responses.enabled).toBe(false);
      // Chains still populated from the legacy list (enabled flags the only difference).
      expect(m.openai.providers).toEqual([{ id: "prv_o" }, { id: "prv_r" }]);
      expect(m.anthropic.providers).toEqual([{ id: "prv_a" }]);
      expect(m.responses.providers).toEqual([{ id: "prv_r" }]);
    });
  });

  describe("v2 model entries → v3 three-slot", () => {
    it("splits responses out of the openai chain (keeping it in openai too)", () => {
      ts = tmpStoreFromRaw({
        version: 2,
        account: { username: "admin", password: "p" },
        apiKey: "sk-myapikey-x",
        providers: [PRV_O, PRV_A, PRV_R],
        models: {
          "gpt-4o": {
            openai: { enabled: true, providers: ["prv_o", "prv_r"] },
            anthropic: { enabled: false, providers: [] },
          },
        },
      });
      const m = ts.store.get().models["gpt-4o"] as unknown as {
        openai: { enabled: boolean; providers: { id: string; model?: string }[] };
        anthropic: { enabled: boolean; providers: { id: string; model?: string }[] };
        responses: { enabled: boolean; providers: { id: string; model?: string }[] };
      };
      // Openai chain unchanged: prv_r stays (split, not moved), enabled stays true.
      expect(m.openai).toEqual({ enabled: true, providers: [{ id: "prv_o" }, { id: "prv_r" }] });
      expect(m.anthropic).toEqual({ enabled: false, providers: [] });
      // Responses slot added from the openai chain's supportsResponses sources.
      expect(m.responses).toEqual({ enabled: true, providers: [{ id: "prv_r" }] });
    });
  });

  describe("already-current entries (idempotent)", () => {
    it("leaves a model already in the {id,model?} pair shape unchanged", () => {
      const before = {
        openai: { enabled: true, providers: [{ id: "prv_o" }, { id: "prv_r" }] },
        anthropic: { enabled: false, providers: [] },
        responses: { enabled: false, providers: [] },
      };
      ts = tmpStoreFromRaw({
        version: 3,
        account: { username: "admin", password: "p" },
        apiKey: "sk-myapikey-x",
        providers: [PRV_O, PRV_A, PRV_R],
        models: { "gpt-4o": before },
      });
      const m = ts.store.get().models["gpt-4o"] as unknown as typeof before;
      expect(m).toEqual(before);
      // Same shape after re-reading disk (only version field is bumped, not the entry).
      expect((readDisk(ts).models as Record<string, unknown>)["gpt-4o"]).toEqual(before);
    });
  });

  describe("provider v3 → v4 (split baseUrl)", () => {
    it("splits a string baseUrl into baseUrlOpenai (kept) and baseUrlAnthropic (trailing /vN stripped)", () => {
      ts = tmpStoreFromRaw({
        version: 3,
        account: { username: "admin", password: "p" },
        apiKey: "sk-myapikey-x",
        providers: [
          {
            id: "p1",
            name: "old",
            baseUrl: "https://api.x.com/v1",
            apiKey: "sk-x",
            formats: ["openai"],
            createdAt: 0,
          },
        ],
        models: {},
      });
      const p = ts.store.get().providers[0] as unknown as Record<string, unknown>;
      expect(p.baseUrlOpenai).toBe("https://api.x.com/v1");
      expect(p.baseUrlAnthropic).toBe("https://api.x.com");
      expect(p.baseUrl).toBeUndefined();
      // The legacy baseUrl field is gone from the persisted JSON too.
      const onDisk = (readDisk(ts).providers as Record<string, unknown>[])[0];
      expect(onDisk).not.toHaveProperty("baseUrl");
      expect(onDisk.baseUrlOpenai).toBe("https://api.x.com/v1");
      expect(onDisk.baseUrlAnthropic).toBe("https://api.x.com");
    });

    it("leaves a v4 provider (already without baseUrl) untouched", () => {
      const before = {
        id: "p1",
        name: "modern",
        baseUrlOpenai: "https://api.x.com/v1",
        baseUrlAnthropic: "https://api.x.com",
        apiKey: "sk-x",
        formats: ["openai"],
        createdAt: 0,
      };
      ts = tmpStoreFromRaw({
        version: 4,
        account: { username: "admin", password: "p" },
        apiKey: "sk-myapikey-x",
        providers: [before],
        models: {},
      });
      expect(ts.store.get().providers[0]).toEqual(before);
    });

    it("treats a baseUrl without a trailing version as a no-op strip", () => {
      ts = tmpStoreFromRaw({
        version: 3,
        account: { username: "admin", password: "p" },
        apiKey: "sk-myapikey-x",
        providers: [
          {
            id: "p1",
            name: "noversion",
            baseUrl: "https://api.x.com",
            apiKey: "sk-x",
            formats: ["openai"],
            createdAt: 0,
          },
        ],
        models: {},
      });
      const p = ts.store.get().providers[0] as unknown as Record<string, unknown>;
      expect(p.baseUrlOpenai).toBe("https://api.x.com");
      expect(p.baseUrlAnthropic).toBe("https://api.x.com");
    });
  });

  describe("FormatEntry v4 → v5 (inline upstream model)", () => {
    it("folds a string[] chain + modelMap into {id,model?} pairs", () => {
      ts = tmpStoreFromRaw({
        version: 4,
        account: { username: "admin", password: "p" },
        apiKey: "sk-myapikey-x",
        providers: [PRV_O, PRV_A],
        models: {
          "gpt-4o": {
            openai: { enabled: true, providers: ["prv_o", "prv_a"], modelMap: { prv_a: "up-a" } },
            anthropic: { enabled: false, providers: [] },
            responses: { enabled: false, providers: [] },
          },
        },
      });
      const m = ts.store.get().models["gpt-4o"] as unknown as {
        openai: { enabled: boolean; providers: { id: string; model?: string }[]; modelMap?: unknown };
      };
      // prv_o had no map entry → bare {id}; prv_a carried "up-a" → {id, model}.
      expect(m.openai).toEqual({ enabled: true, providers: [{ id: "prv_o" }, { id: "prv_a", model: "up-a" }] });
      // modelMap is gone entirely.
      expect(m.openai.modelMap).toBeUndefined();
      expect(ts.store.get().version).toBe(CONFIG_VERSION);
      // Persisted to disk in the pair shape with no modelMap.
      const disk = (readDisk(ts).models as Record<string, unknown>)["gpt-4o"] as Record<string, unknown>;
      expect(disk.openai).toEqual({ enabled: true, providers: [{ id: "prv_o" }, { id: "prv_a", model: "up-a" }] });
    });

    it("leaves already-pair chains untouched (idempotent)", () => {
      const before = {
        openai: { enabled: true, providers: [{ id: "prv_o" }, { id: "prv_a", model: "up-a" }] },
        anthropic: { enabled: false, providers: [] },
        responses: { enabled: false, providers: [] },
      };
      ts = tmpStoreFromRaw({
        version: 4,
        account: { username: "admin", password: "p" },
        apiKey: "sk-myapikey-x",
        providers: [PRV_O, PRV_A],
        models: { "gpt-4o": before },
      });
      const m = ts.store.get().models["gpt-4o"] as unknown as typeof before;
      expect(m).toEqual(before);
      expect(readDisk(ts).version).toBe(CONFIG_VERSION);
    });
  });

  describe("apiKey migration", () => {
    it("generates and persists an sk-myapikey- key when missing", () => {
      ts = tmpStoreFromRaw({
        version: 4, // isolate the apiKey branch (no model/provider migration needed)
        account: { username: "admin", password: "p" },
        providers: [],
        models: {},
        // apiKey intentionally absent
      });
      const got = ts.store.get().apiKey;
      expect(got).toMatch(/^sk-myapikey-/);
      // Persisted to disk (stable across restarts, not regenerated each boot).
      expect(readDisk(ts).apiKey).toBe(got);
    });
  });

  describe("broken / partial configs", () => {
    it("falls back to defaultConfig() when account is missing", () => {
      ts = tmpStoreFromRaw({ version: 1, providers: [], models: {} });
      const cfg = ts.store.get();
      expect(cfg.account.username).toBe("admin");
      expect(cfg.providers).toEqual([]);
      expect(cfg.models).toEqual({});
      expect(cfg.apiKey).toMatch(/^sk-myapikey-/);
      expect(cfg.version).toBe(CONFIG_VERSION);
    });

    it("defaults missing providers/models fields to [] / {}", () => {
      ts = tmpStoreFromRaw({
        version: 1,
        account: { username: "admin", password: "p" },
        apiKey: "sk-myapikey-x",
        // providers and models intentionally absent
      });
      const cfg = ts.store.get();
      expect(cfg.providers).toEqual([]);
      expect(cfg.models).toEqual({});
    });
  });

  describe("version bump", () => {
    it("bumps version to CONFIG_VERSION (5) and persists after a migration", () => {
      ts = tmpStoreFromRaw({
        version: 1,
        account: { username: "admin", password: "p" },
        apiKey: "sk-myapikey-x",
        providers: [PRV_O],
        models: { "gpt-4o": { enabled: true, providers: ["prv_o"] } },
      });
      expect(ts.store.get().version).toBe(CONFIG_VERSION);
      expect(readDisk(ts).version).toBe(CONFIG_VERSION);
    });

    it("loads a config newer than CONFIG_VERSION best-effort (warns, does not throw, not downgraded)", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      ts = tmpStoreFromRaw({
        version: 99,
        account: { username: "admin", password: "p" },
        apiKey: "sk-myapikey-x",
        providers: [],
        models: {},
      });
      expect(ts.store.get().version).toBe(99); // not downgraded
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });
});
