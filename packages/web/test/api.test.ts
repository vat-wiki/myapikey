// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getCreds, setCreds, clearCreds, req } from "../src/api";
import { mockFetch, type FetchMock } from "../../core/test/helpers/mock";

describe("web/api", () => {
  let mock: FetchMock | undefined;

  beforeEach(() => {
    localStorage.clear();
    mock = undefined;
  });

  afterEach(() => {
    mock?.restore();
  });

  describe("credentials (localStorage key 'myapikey.creds')", () => {
    it("returns null when nothing is stored", () => {
      expect(getCreds()).toBeNull();
    });

    it("round-trips user/pass through setCreds/getCreds", () => {
      setCreds("u", "p");
      expect(getCreds()).toEqual({ user: "u", pass: "p" });
    });

    it("clearCreds wipes the stored entry", () => {
      setCreds("u", "p");
      expect(getCreds()).not.toBeNull();
      clearCreds();
      expect(getCreds()).toBeNull();
    });
  });

  describe("req()", () => {
    it("throws 'Not authenticated' when no creds are set", async () => {
      await expect(req("GET", "/admin/providers")).rejects.toThrow("Not authenticated");
    });

    it("sends Basic auth header and parses a 200 JSON response", async () => {
      mock = mockFetch([
        { match: "/admin/providers", response: { status: 200, body: { ok: true, n: 7 } } },
      ]);
      setCreds("u", "p");

      const out = await req<{ ok: boolean; n: number }>("GET", "/admin/providers");

      expect(out).toEqual({ ok: true, n: 7 });
      // Authorization is Basic btoa("u:p").
      expect(mock.calls[0].headers.authorization).toBe("Basic " + btoa("u:p"));
      expect(mock.calls[0].method).toBe("GET");
    });

    it("extracts error.message from a non-ok JSON body", async () => {
      mock = mockFetch([
        {
          match: "/admin/providers",
          response: { status: 500, body: { error: { message: "nope" } } },
        },
      ]);
      setCreds("u", "p");

      await expect(req("GET", "/admin/providers")).rejects.toThrow("nope");
    });

    it("falls back to raw response text when non-ok body is not JSON", async () => {
      mock = mockFetch([
        { match: "/admin/x", response: { status: 502, body: "bad gateway text" } },
      ]);
      setCreds("u", "p");

      await expect(req("GET", "/admin/x")).rejects.toThrow("bad gateway text");
    });

    it("POST sends content-type application/json and a JSON-stringified body", async () => {
      mock = mockFetch([
        { match: "/admin/providers", response: { status: 200, body: { created: true } } },
      ]);
      setCreds("u", "p");

      const out = await req<{ created: boolean }>("POST", "/admin/providers", {
        name: "openai",
        apiKey: "sk-x",
      });

      expect(out).toEqual({ created: true });
      const call = mock.calls[0];
      expect(call.method).toBe("POST");
      expect(call.headers["content-type"]).toBe("application/json");
      expect(call.body).toBe(JSON.stringify({ name: "openai", apiKey: "sk-x" }));
    });

    it("GET (no body) does not set a content-type header", async () => {
      mock = mockFetch([
        { match: "/admin/providers", response: { status: 200, body: { ok: true } } },
      ]);
      setCreds("u", "p");

      await req("GET", "/admin/providers");

      expect(mock.calls[0].headers["content-type"]).toBeUndefined();
      expect(mock.calls[0].body).toBe("");
    });
  });
});
