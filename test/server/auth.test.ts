import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { authMiddleware, apiKeyMiddleware, extractSecret } from "../../src/server/auth";
import { json } from "../helpers/json";

/** Build a minimal Hono request context stub: extractSecret only touches
 *  c.req.header(name), so a { req: { header } } object is all we need. Header
 *  lookup is case-insensitive (Hono lowercases internally). */
function ctx(headers: Record<string, string>): any {
  const lower: Record<string, string> = {};
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k];
  return { req: { header: (n: string) => lower[n.toLowerCase()] } };
}

const b64 = (s: string): string => Buffer.from(s).toString("base64");
const basic = (user: string, pass: string): string => `Basic ${b64(`${user}:${pass}`)}`;

describe("server/auth", () => {
  describe("extractSecret", () => {
    it("prefers x-api-key", () => {
      expect(extractSecret(ctx({ "x-api-key": "abc" }))).toEqual({ password: "abc" });
    });

    it("parses a Bearer token", () => {
      expect(extractSecret(ctx({ authorization: "Bearer tok" }))).toEqual({ password: "tok" });
    });

    it("trims surrounding whitespace off the Bearer token", () => {
      expect(extractSecret(ctx({ authorization: "Bearer  tok  " }))).toEqual({ password: "tok" });
    });

    it("treats the scheme case-insensitively", () => {
      expect(extractSecret(ctx({ authorization: "bearer tok" }))).toEqual({ password: "tok" });
    });

    it("decodes HTTP Basic into username + password", () => {
      expect(extractSecret(ctx({ authorization: basic("user", "pass") }))).toEqual({
        username: "user",
        password: "pass",
      });
    });

    it("returns null when the Basic payload has no colon", () => {
      // base64 of "nocolon" — decodes fine but lacks the user:pass separator.
      expect(extractSecret(ctx({ authorization: `Basic ${b64("nocolon")}` }))).toBeNull();
    });

    it("returns null when no auth header is present", () => {
      expect(extractSecret(ctx({}))).toBeNull();
    });
  });

  describe("authMiddleware (account password)", () => {
    // account creds are fixed for these tests.
    const getUser = () => "admin";
    const getPass = () => "secret";
    const app = new Hono()
      .use("*", authMiddleware(getUser, getPass))
      .get("/x", (c) => c.text("ok"));

    it("accepts matching HTTP Basic", async () => {
      const res = await app.request("/x", { headers: { authorization: basic("admin", "secret") } });
      expect(res.status).toBe(200);
    });

    it("accepts Bearer = account password", async () => {
      const res = await app.request("/x", { headers: { authorization: "Bearer secret" } });
      expect(res.status).toBe(200);
    });

    it("accepts x-api-key = account password", async () => {
      const res = await app.request("/x", { headers: { "x-api-key": "secret" } });
      expect(res.status).toBe(200);
    });

    it("rejects a wrong password with an authentication_error body", async () => {
      const res = await app.request("/x", { headers: { authorization: basic("admin", "wrong") } });
      expect(res.status).toBe(401);
      const body = await json<{ error: { type: string } }>(res);
      expect(body.error.type).toBe("authentication_error");
    });

    it("rejects a wrong username even with the right password", async () => {
      const res = await app.request("/x", { headers: { authorization: basic("other", "secret") } });
      expect(res.status).toBe(401);
    });
  });

  describe("apiKeyMiddleware (/v1 api key)", () => {
    const getKey = () => "sk-key";
    const app = new Hono()
      .use("*", apiKeyMiddleware(getKey))
      .get("/x", (c) => c.text("ok"));

    it("accepts Bearer = api key", async () => {
      const res = await app.request("/x", { headers: { authorization: "Bearer sk-key" } });
      expect(res.status).toBe(200);
    });

    it("accepts x-api-key = api key", async () => {
      const res = await app.request("/x", { headers: { "x-api-key": "sk-key" } });
      expect(res.status).toBe(200);
    });

    it("REJECTS HTTP Basic even when its password equals the api key (cross-secret isolation)", async () => {
      // Basic sets username; apiKeyMiddleware forbids any cred with a username,
      // so the account password can never authenticate /v1 even if it happened
      // to equal the key.
      const res = await app.request("/x", { headers: { authorization: basic("admin", "sk-key") } });
      expect(res.status).toBe(401);
    });

    it("rejects a wrong key", async () => {
      const res = await app.request("/x", { headers: { authorization: "Bearer wrong" } });
      expect(res.status).toBe(401);
    });
  });
});
