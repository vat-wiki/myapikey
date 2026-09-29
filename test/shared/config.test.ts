import { describe, it, expect } from "vitest";
import { CONFIG_VERSION, defaultConfig, newApiKey, newProviderId, trimBase } from "../../src/shared/config";

describe("shared/config", () => {
  describe("trimBase", () => {
    it("strips trailing slashes", () => {
      expect(trimBase("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1");
      expect(trimBase("https://x/")).toBe("https://x");
    });
    it("strips multiple trailing slashes", () => {
      expect(trimBase("https://api.openai.com/v1///")).toBe("https://api.openai.com/v1");
    });
    it("leaves a slashless URL untouched", () => {
      expect(trimBase("https://api.openai.com/v1")).toBe("https://api.openai.com/v1");
    });
    it("does not strip interior slashes", () => {
      expect(trimBase("https://a/b/c")).toBe("https://a/b/c");
    });
  });

  describe("newApiKey", () => {
    it("has the sk-myapikey- prefix", () => {
      expect(newApiKey()).toMatch(/^sk-myapikey-/);
    });
    it("is reasonably long (32+ bytes of entropy encoded)", () => {
      expect(newApiKey().length).toBeGreaterThan("sk-myapikey-".length + 16);
    });
    it("produces distinct keys", () => {
      const a = newApiKey();
      const b = newApiKey();
      expect(a).not.toBe(b);
    });
  });

  describe("newProviderId", () => {
    it("has the prv_ prefix", () => {
      expect(newProviderId()).toMatch(/^prv_/);
    });
    it("produces distinct ids", () => {
      expect(newProviderId()).not.toBe(newProviderId());
    });
  });

  describe("defaultConfig", () => {
    it("returns the current config version", () => {
      expect(defaultConfig().version).toBe(CONFIG_VERSION);
    });
    it("starts with an admin account and a distinct /v1 api key", () => {
      const c = defaultConfig();
      expect(c.account.username).toBe("admin");
      expect(c.account.password.length).toBeGreaterThan(0);
      expect(c.apiKey).toMatch(/^sk-myapikey-/);
      // The two secrets are independent (a core design decision).
      expect(c.apiKey).not.toBe(c.account.password);
    });
    it("starts empty — no providers, no models", () => {
      const c = defaultConfig();
      expect(c.providers).toEqual([]);
      expect(c.models).toEqual({});
    });
    it("generates a fresh password + key each call", () => {
      const a = defaultConfig();
      const b = defaultConfig();
      expect(a.account.password).not.toBe(b.account.password);
      expect(a.apiKey).not.toBe(b.apiKey);
    });
  });
});
