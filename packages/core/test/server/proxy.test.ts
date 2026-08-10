import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createApp } from "../../src/server/app";
import { shortError, anthropicAuthHeaders } from "../../src/server/proxy";
import type { Store } from "../../src/server/store";
import { tmpStore } from "../helpers/store";
import { mockFetch, type FetchMock } from "../helpers/mock";
import { json } from "../helpers/json";
import { makeProvider, fe, makeModel, seedStore } from "../helpers/fixtures";

// Two providers shared across the dispatch tests. Default apiKey ("sk-up-test")
// is left in place; assertions reference A.apiKey/B.apiKey so they stay robust.

/** Body shape for a passthrough OpenAI chat completion (used by the json<T> helper). */
type ChatBody = { choices: Array<{ message: { content: string } }> };

const A = makeProvider({
  id: "prv_A",
  name: "A",
  baseUrlOpenai: "https://up.test/a/v1",
  baseUrlAnthropic: "https://up.test/a",
  formats: ["openai", "anthropic"],
  supportsResponses: true,
});
const B = makeProvider({
  id: "prv_B",
  name: "B",
  baseUrlOpenai: "https://up.test/b/v1",
  baseUrlAnthropic: "https://up.test/b",
  formats: ["openai", "anthropic"],
  supportsResponses: true,
});

describe("proxy", () => {
  let store: Store;
  let cleanup: () => void;
  let mock: FetchMock | undefined;

  beforeEach(async () => {
    const t = tmpStore();
    store = t.store;
    cleanup = t.cleanup;
    await seedStore(store, {
      account: { username: "admin", password: "password123" },
      apiKey: "sk-test",
      providers: [A, B],
      models: {
        m: makeModel({
          openai: fe(["prv_A", "prv_B"]),
          anthropic: fe(["prv_A"]),
          responses: fe(["prv_A"]),
        }),
        onlyA: makeModel({ openai: fe(["prv_A"]) }),
      },
    });
  });

  afterEach(() => {
    mock?.restore();
    mock = undefined;
    cleanup();
  });

  /** POST to /v1 as a Bearer-authed agent. Body may be a string (sent raw) or
   *  a plain object (JSON-stringified). Extra headers win over the defaults. */
  async function post(path: string, body: unknown, extra: Record<string, string> = {}) {
    return createApp(store).request(path, {
      method: "POST",
      headers: {
        authorization: "Bearer " + store.get().apiKey,
        "content-type": "application/json",
        ...extra,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  // --- pure exported helpers ---

  describe("shortError", () => {
    it("extracts error.message from JSON", () => {
      expect(shortError(JSON.stringify({ error: { message: "x" } }))).toBe("x");
    });
    it("extracts a top-level message when there is no error wrapper", () => {
      expect(shortError(JSON.stringify({ message: "y" }))).toBe("y");
    });
    it("returns the raw text when the body is not JSON", () => {
      expect(shortError("plain text")).toBe("plain text");
    });
    it("truncates long non-JSON text to 200 chars", () => {
      expect(shortError("a".repeat(500))).toHaveLength(200);
    });
    it("truncates a long JSON error message to 200 chars", () => {
      const long = "e".repeat(500);
      expect(shortError(JSON.stringify({ error: { message: long } }))).toHaveLength(200);
    });
  });

  describe("anthropicAuthHeaders", () => {
    it("sends x-api-key, Bearer auth, and the anthropic-version", () => {
      expect(anthropicAuthHeaders("k", "2023-06-01")).toEqual({
        "x-api-key": "k",
        authorization: "Bearer k",
        "anthropic-version": "2023-06-01",
      });
    });
  });

  // --- integration via createApp + mockFetch ---

  describe("dispatch routing", () => {
    it("400 invalid_request_error when body has no model", async () => {
      const res = await post("/v1/chat/completions", { messages: [] });
      expect(res.status).toBe(400);
      expect((await json<{ error: { type: string } }>(res)).error.type).toBe("invalid_request_error");
    });

    it("400 on non-JSON body", async () => {
      const res = await post("/v1/chat/completions", "not json{");
      expect(res.status).toBe(400);
      expect((await json<{ error: { type: string } }>(res)).error.type).toBe("invalid_request_error");
    });

    it("404 model_not_found for an unknown model", async () => {
      const res = await post("/v1/chat/completions", { model: "nope", messages: [] });
      expect(res.status).toBe(404);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe("model_not_found");
    });

    it("passes a 200 upstream body through, logs the call, and hides the provider", async () => {
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "hi" } }] } } },
      ]);
      const res = await post("/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }] });
      expect(res.status).toBe(200);
      expect((await json<ChatBody>(res)).choices[0].message.content).toBe("hi");
      // No provider leak to a normal client.
      expect(res.headers.get("x-myapikey-provider")).toBeNull();
      // Logged as a success.
      expect(store.getLogs().some((e) => e.model === "m" && e.status === 200)).toBe(true);
      // Primary answered; B was not consulted.
      expect(mock.calls.filter((c) => c.url.includes("/b/")).length).toBe(0);
    });

    it("maps the openai chat URL onto the OpenAI base", async () => {
      mock = mockFetch([{ match: "/a/v1/chat/completions", response: { body: { ok: true } } }]);
      await post("/v1/chat/completions", { model: "m", messages: [] });
      expect(mock.calls[0].url).toBe("https://up.test/a/v1/chat/completions");
    });

    it("maps the responses URL onto the OpenAI base", async () => {
      mock = mockFetch([{ match: "/a/v1/responses", response: { body: { ok: true } } }]);
      await post("/v1/responses", { model: "m", input: "x" });
      expect(mock.calls[0].url).toBe("https://up.test/a/v1/responses");
    });

    it("maps the anthropic messages URL with the /v1 segment appended", async () => {
      mock = mockFetch([{ match: "/a/v1/messages", response: { body: { content: [] } } }]);
      await post("/v1/messages", { model: "m", messages: [] });
      expect(mock.calls[0].url).toBe("https://up.test/a/v1/messages");
    });

    it("sends x-api-key + Bearer + forwarded anthropic-version on /v1/messages", async () => {
      mock = mockFetch([{ match: "/a/v1/messages", response: { body: { content: [] } } }]);
      await post("/v1/messages", { model: "m", messages: [] }, { "anthropic-version": "2023-08-01" });
      const h = mock.calls[0].headers;
      expect(h["x-api-key"]).toBe(A.apiKey);
      expect(h["authorization"]).toBe("Bearer " + A.apiKey);
      expect(h["anthropic-version"]).toBe("2023-08-01");
    });
  });

  describe("dispatch failover", () => {
    it("fails over on 503 to the next provider", async () => {
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 503, body: { error: { message: "down" } } } },
        { match: "/b/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "from-B" } }] } } },
      ]);
      const res = await post("/v1/chat/completions", { model: "m", messages: [] });
      expect(res.status).toBe(200);
      expect((await json<ChatBody>(res)).choices[0].message.content).toBe("from-B");
      expect(mock.calls.filter((c) => c.url.includes("/a/")).length).toBe(1);
      expect(mock.calls.filter((c) => c.url.includes("/b/")).length).toBe(1);
    });

    it("fails over on 429 too", async () => {
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 429, body: { error: { message: "slow down" } } } },
        { match: "/b/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "B" } }] } } },
      ]);
      const res = await post("/v1/chat/completions", { model: "m", messages: [] });
      expect(res.status).toBe(200);
      expect(mock.calls.filter((c) => c.url.includes("/a/")).length).toBe(1);
      expect(mock.calls.filter((c) => c.url.includes("/b/")).length).toBe(1);
    });

    it("fails over when fetch throws (network error path)", async () => {
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: () => { throw new Error("net"); } },
        { match: "/b/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "B" } }] } } },
      ]);
      const res = await post("/v1/chat/completions", { model: "m", messages: [] });
      expect(res.status).toBe(200);
      expect((await json<ChatBody>(res)).choices[0].message.content).toBe("B");
      expect(mock.calls.filter((c) => c.url.includes("/b/")).length).toBe(1);
    });

    it("returns a non-retryable 4xx as-is and does not fail over", async () => {
      // m routes A→B; A 400s (non-retryable) even though B would 200.
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 400, body: { error: { message: "bad" } } } },
        { match: "/b/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "B" } }] } } },
      ]);
      const res = await post("/v1/chat/completions", { model: "m", messages: [] });
      expect(res.status).toBe(400);
      expect((await json<{ error: { message: string } }>(res)).error.message).toBe("bad");
      expect(mock.calls.filter((c) => c.url.includes("/b/")).length).toBe(0);
    });

    it("returns 502 with an 'all providers … last status' message when every provider fails", async () => {
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 500, body: { error: { message: "boom" } } } },
        { match: "/b/v1/chat/completions", response: { status: 500, body: { error: { message: "boom" } } } },
      ]);
      const res = await post("/v1/chat/completions", { model: "m", messages: [] });
      expect(res.status).toBe(502);
      const msg = (await json<{ error: { message: string } }>(res)).error.message;
      expect(msg).toContain("all providers");
      expect(msg).toContain("last status 500");
      // The proxy logs `lastStatus` (the last UPSTREAM status) on total failure,
      // not the 502 it returns to the client — so the call row here reads 500.
      const call = store.getLogs().find((e) => e.model === "m" && !e.kind);
      expect(call?.status).toBe(500);
    });
  });

  describe("dispatch model mapping", () => {
    it("rewrites model per provider and recomputes from the original on failover", async () => {
      // Reseed m so only B has an upstream name mapped.
      await seedStore(store, {
        models: {
          m: makeModel({ openai: fe(["prv_A", "prv_B"], { modelMap: { prv_B: "gpt-4o-2024" } }) }),
          onlyA: makeModel({ openai: fe(["prv_A"]) }),
        },
      });
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 503, body: { error: { message: "down" } } } },
        { match: "/b/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "ok" } }] } } },
      ]);
      const res = await post("/v1/chat/completions", { model: "m", messages: [] });
      expect(res.status).toBe(200);
      const aCall = mock.calls.find((c) => c.url.includes("/a/"));
      const bCall = mock.calls.find((c) => c.url.includes("/b/"));
      // No map for A → public name sent verbatim.
      expect(JSON.parse(aCall!.body).model).toBe("m");
      // B's entry rewrites the model to its configured upstream name.
      expect(JSON.parse(bCall!.body).model).toBe("gpt-4o-2024");
    });
  });

  describe("dispatch circuit breaker", () => {
    it("skips a provider that is in cooldown", async () => {
      // Put A into cooling (a single recorded failure opens a 30s window).
      store.recordCircuitFailure("prv_A", 500, "x");
      expect(store.isCooling("prv_A")).toBe(true);
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "A" } }] } } },
        { match: "/b/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "B" } }] } } },
      ]);
      const res = await post("/v1/chat/completions", { model: "m", messages: [] });
      expect(res.status).toBe(200);
      expect((await json<ChatBody>(res)).choices[0].message.content).toBe("B");
      // A was skipped entirely; B answered once.
      expect(mock.calls.filter((c) => c.url.includes("/a/")).length).toBe(0);
      expect(mock.calls.filter((c) => c.url.includes("/b/")).length).toBe(1);
    });
  });

  describe("GET /v1/models", () => {
    it("lists only openai-enabled models, owned by each model's first provider", async () => {
      const res = await createApp(store).request("/v1/models", {
        headers: { authorization: "Bearer " + store.get().apiKey },
      });
      expect(res.status).toBe(200);
      const j = await json<{ object: string; data: { id: string; owned_by: string }[] }>(res);
      expect(j.object).toBe("list");
      const ids = j.data.map((d: { id: string }) => d.id).sort();
      expect(ids).toEqual(["m", "onlyA"]);
      for (const d of j.data) expect(d.owned_by).toBe("A");
    });
  });

  describe("probe header", () => {
    it("tags the response with x-myapikey-provider when probe=1", async () => {
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { body: { choices: [{ message: { content: "hi" } }] } } },
      ]);
      const res = await post("/v1/chat/completions", { model: "m", messages: [] }, { "x-myapikey-probe": "1" });
      expect(res.headers.get("x-myapikey-provider")).toBe("A");
    });

    it("omits the header for a normal (non-probe) client", async () => {
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { body: { choices: [{ message: { content: "hi" } }] } } },
      ]);
      const res = await post("/v1/chat/completions", { model: "m", messages: [] });
      expect(res.headers.get("x-myapikey-provider")).toBeNull();
    });
  });

  describe("pinned probe (per-source test)", () => {
    it("hits only the pinned provider even when it isn't first in the chain", async () => {
      // m routes A→B; pinning B must not touch A.
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "A" } }] } } },
        { match: "/b/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "B" } }] } } },
      ]);
      const res = await post("/v1/chat/completions", { model: "m", messages: [] }, {
        "x-myapikey-probe": "1",
        "x-myapikey-probe-provider": "prv_B",
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-myapikey-provider")).toBe("B");
      expect(mock.calls.some((c) => c.url.includes("/b/"))).toBe(true);
      expect(mock.calls.some((c) => c.url.includes("/a/"))).toBe(false);
    });

    it("fails fast on 429 (no failover) with no circuit impact, surfacing the real status", async () => {
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 200, body: {} } },
        { match: "/b/v1/chat/completions", response: { status: 429, body: { error: { message: "slow" } } } },
      ]);
      const res = await post("/v1/chat/completions", { model: "m", messages: [] }, {
        "x-myapikey-probe": "1",
        "x-myapikey-probe-provider": "prv_B",
      });
      // The real upstream status (429), not a collapsed 502.
      expect(res.status).toBe(429);
      expect(res.headers.get("x-myapikey-provider")).toBe("B");
      // No failover to A, no breaker trip.
      expect(mock.calls.some((c) => c.url.includes("/a/"))).toBe(false);
      expect(store.isCooling("prv_B")).toBe(false);
      expect(store.circuitState().find((x) => x.id === "prv_B")?.fails).toBe(0);
    });

    it("404s when the pinned provider isn't on the route (no upstream hit)", async () => {
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 200, body: {} } },
      ]);
      // onlyA routes solely to A; pinning B yields model_not_found with no fetch.
      const res = await post("/v1/chat/completions", { model: "onlyA", messages: [] }, {
        "x-myapikey-probe": "1",
        "x-myapikey-probe-provider": "prv_B",
      });
      expect(res.status).toBe(404);
      expect(mock.calls.length).toBe(0);
    });
  });
});
