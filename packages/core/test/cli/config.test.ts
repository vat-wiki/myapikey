import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// CLIENT_PROFILE_PATH (and DEFAULT_DATA_DIR it derives from) are pinned at
// module load from homedir(), which on Linux honors process.env.HOME. So each
// test resets the module registry and re-imports config AFTER pointing HOME at
// a throwaway dir — that re-resolves both paths inside the temp home.
const ENV_KEYS = ["MYAPIKEY_URL", "MYAPIKEY_USER", "MYAPIKEY_PASS", "MYAPIKEY_API_KEY", "HOME"] as const;

describe("cli/config", () => {
  let tmpHome: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "mk-cfg-"));
    savedEnv = {};
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env.HOME = tmpHome;
    for (const k of ["MYAPIKEY_URL", "MYAPIKEY_USER", "MYAPIKEY_PASS", "MYAPIKEY_API_KEY"]) {
      delete process.env[k];
    }
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  // Fresh import so module-level paths resolve against tmpHome.
  const fresh = () => import("../../src/cli/config");

  describe("loadProfile / saveProfile", () => {
    it("loadProfile returns null when no client.json exists", async () => {
      const { loadProfile } = await fresh();
      expect(loadProfile()).toBeNull();
    });

    it("saveProfile writes client.json and loadProfile reads it back", async () => {
      const { saveProfile, loadProfile } = await fresh();
      const p = { url: "http://h:7800", username: "u", password: "p", apiKey: "sk-1" };
      saveProfile(p);
      expect(loadProfile()).toEqual(p);
    });

    it("legacy ~/.config/myapikey/config.json is read when client.json is absent", async () => {
      const cfg = await fresh();
      // Write ONLY the legacy file (not the new client.json).
      const legacyDir = join(tmpHome, ".config", "myapikey");
      mkdirSync(legacyDir, { recursive: true });
      const legacy = { url: "http://legacy:7800", username: "lu", password: "lp", apiKey: "sk-legacy" };
      writeFileSync(join(legacyDir, "config.json"), JSON.stringify(legacy));
      expect(cfg.loadProfile()).toEqual(legacy);
    });
  });

  describe("resolveUrl (flag > env > profile > default)", () => {
    it("flag wins over both env and profile", async () => {
      process.env.MYAPIKEY_URL = "http://env:7800";
      const { resolveUrl, saveProfile } = await fresh();
      saveProfile({ url: "http://profile:7800", username: "u", password: "p", apiKey: "sk" });
      expect(resolveUrl("http://flag:7800")).toBe("http://flag:7800");
    });

    it("env wins over profile", async () => {
      process.env.MYAPIKEY_URL = "http://env:7800";
      const { resolveUrl, saveProfile } = await fresh();
      saveProfile({ url: "http://profile:7800", username: "u", password: "p", apiKey: "sk" });
      expect(resolveUrl()).toBe("http://env:7800");
    });

    it("falls back to profile.url when no flag/env", async () => {
      const { resolveUrl, saveProfile } = await fresh();
      saveProfile({ url: "http://profile:7800", username: "u", password: "p", apiKey: "sk" });
      expect(resolveUrl()).toBe("http://profile:7800");
    });

    it("defaults to http://localhost:7800 when nothing is set", async () => {
      const { resolveUrl } = await fresh();
      expect(resolveUrl()).toBe("http://localhost:7800");
    });
  });

  describe("resolveCreds (flags > env > profile)", () => {
    it("flags win over both env and profile", async () => {
      process.env.MYAPIKEY_USER = "envuser";
      process.env.MYAPIKEY_PASS = "envpass";
      const { resolveCreds, saveProfile } = await fresh();
      saveProfile({ url: "", username: "pu", password: "pp", apiKey: "sk" });
      expect(resolveCreds("fu", "fp")).toEqual({ username: "fu", password: "fp" });
    });

    it("env wins over profile", async () => {
      process.env.MYAPIKEY_USER = "envuser";
      process.env.MYAPIKEY_PASS = "envpass";
      const { resolveCreds, saveProfile } = await fresh();
      saveProfile({ url: "", username: "pu", password: "pp", apiKey: "sk" });
      expect(resolveCreds()).toEqual({ username: "envuser", password: "envpass" });
    });

    it("falls back to profile when no flags/env", async () => {
      const { resolveCreds, saveProfile } = await fresh();
      saveProfile({ url: "", username: "pu", password: "pp", apiKey: "sk" });
      expect(resolveCreds()).toEqual({ username: "pu", password: "pp" });
    });

    it("returns null when username is missing (password alone)", async () => {
      process.env.MYAPIKEY_PASS = "p";
      const { resolveCreds } = await fresh();
      expect(resolveCreds()).toBeNull();
    });

    it("returns null when password is missing (username alone)", async () => {
      process.env.MYAPIKEY_USER = "u";
      const { resolveCreds } = await fresh();
      expect(resolveCreds()).toBeNull();
    });

    it("returns null when neither is set", async () => {
      const { resolveCreds } = await fresh();
      expect(resolveCreds()).toBeNull();
    });
  });

  describe("resolveApiKey (flag > env > profile)", () => {
    it("flag wins over both env and profile", async () => {
      process.env.MYAPIKEY_API_KEY = "sk-env";
      const { resolveApiKey, saveProfile } = await fresh();
      saveProfile({ url: "", username: "u", password: "p", apiKey: "sk-profile" });
      expect(resolveApiKey("sk-flag")).toBe("sk-flag");
    });

    it("env wins over profile", async () => {
      process.env.MYAPIKEY_API_KEY = "sk-env";
      const { resolveApiKey, saveProfile } = await fresh();
      saveProfile({ url: "", username: "u", password: "p", apiKey: "sk-profile" });
      expect(resolveApiKey()).toBe("sk-env");
    });

    it("falls back to profile.apiKey", async () => {
      const { resolveApiKey, saveProfile } = await fresh();
      saveProfile({ url: "", username: "u", password: "p", apiKey: "sk-profile" });
      expect(resolveApiKey()).toBe("sk-profile");
    });

    it("returns undefined when nothing is set", async () => {
      const { resolveApiKey } = await fresh();
      expect(resolveApiKey()).toBeUndefined();
    });
  });
});
