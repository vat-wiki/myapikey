import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp } from "../../src/server/app";
import { shortError, anthropicAuthHeaders } from "../../src/server/proxy";
import { CAPTURE_BODY_MAX, type Store } from "../../src/server/store";
import { tmpStore } from "../helpers/store";
import { mockFetch, sseBody, chunkedBody, sequence, type FetchMock } from "../helpers/mock";
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
  baseUrlResponses: "https://up.test/a/v1",
  baseUrlSystemone: "https://up.test/a/v1",
  formats: ["openai", "anthropic", "responses", "systemone"],
});
const B = makeProvider({
  id: "prv_B",
  name: "B",
  baseUrlOpenai: "https://up.test/b/v1",
  baseUrlAnthropic: "https://up.test/b",
  baseUrlResponses: "https://up.test/b/v1",
  baseUrlSystemone: "https://up.test/b/v1",
  formats: ["openai", "anthropic", "responses", "systemone"],
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
          systemone: fe(["prv_A", "prv_B"]),
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
      const res = await post("/openai-chat/v1/chat/completions", { messages: [] });
      expect(res.status).toBe(400);
      expect((await json<{ error: { type: string } }>(res)).error.type).toBe("invalid_request_error");
    });

    it("400 on non-JSON body", async () => {
      const res = await post("/openai-chat/v1/chat/completions", "not json{");
      expect(res.status).toBe(400);
      expect((await json<{ error: { type: string } }>(res)).error.type).toBe("invalid_request_error");
    });

    it("404 model_not_found for an unknown model", async () => {
      const res = await post("/openai-chat/v1/chat/completions", { model: "nope", messages: [] });
      expect(res.status).toBe(404);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe("model_not_found");
    });

    it("passes a 200 upstream body through, logs the call, and hides the provider", async () => {
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "hi" } }] } } },
      ]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }] });
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
      await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] });
      expect(mock.calls[0].url).toBe("https://up.test/a/v1/chat/completions");
    });

    it("maps the responses URL onto the OpenAI base", async () => {
      mock = mockFetch([{ match: "/a/v1/responses", response: { body: { ok: true } } }]);
      await (await post("/openai-responses/v1/responses", { model: "m", input: "x" })).text();
      expect(mock.calls[0].url).toBe("https://up.test/a/v1/responses");
      expect(store.getLogs().find((e) => e.model === "m")?.format).toBe("responses");
    });

    it("maps the anthropic messages URL with the /v1 segment appended", async () => {
      mock = mockFetch([{ match: "/a/v1/messages", response: { body: { content: [] } } }]);
      await post("/anthropic/v1/messages", { model: "m", messages: [] });
      expect(mock.calls[0].url).toBe("https://up.test/a/v1/messages");
    });

    it("sends x-api-key + Bearer + forwarded anthropic-version on /v1/messages", async () => {
      mock = mockFetch([{ match: "/a/v1/messages", response: { body: { content: [] } } }]);
      await post("/anthropic/v1/messages", { model: "m", messages: [] }, { "anthropic-version": "2023-08-01" });
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
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] });
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
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] });
      expect(res.status).toBe(200);
      expect(mock.calls.filter((c) => c.url.includes("/a/")).length).toBe(1);
      expect(mock.calls.filter((c) => c.url.includes("/b/")).length).toBe(1);
    });

    it("fails over on 403 (banned credential) and 401 (invalid key)", async () => {
      for (const status of [401, 403]) {
        mock?.restore();
        mock = mockFetch([
          { match: "/a/v1/chat/completions", response: { status, body: { error: { message: "User has been banned" } } } },
          { match: "/b/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "B" } }] } } },
        ]);
        const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] });
        expect(res.status).toBe(200);
        expect(mock.calls.filter((c) => c.url.includes("/b/")).length).toBe(1);
      }
    });

    it("fails over when fetch throws (network error path)", async () => {
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: () => { throw new Error("net"); } },
        { match: "/b/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "B" } }] } } },
      ]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] });
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
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] });
      expect(res.status).toBe(400);
      expect((await json<{ error: { message: string } }>(res)).error.message).toBe("bad");
      expect(mock.calls.filter((c) => c.url.includes("/b/")).length).toBe(0);
    });

    it("fails over on an account-level error smuggled as a 400 (expired subscription)", async () => {
      // Volcengine Ark reports an expired coding-plan subscription as a 400 —
      // dead for THIS source only, so it must behave like a 401/403.
      mock = mockFetch([
        {
          match: "/a/v1/chat/completions",
          response: {
            status: 400,
            body: { error: { message: "Your account (2106150631) does not have a valid AgentPlan subscription, or your subscription has expired." } },
          },
        },
        { match: "/b/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "B" } }] } } },
      ]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] });
      expect(res.status).toBe(200);
      expect(mock.calls.filter((c) => c.url.includes("/a/")).length).toBe(1);
      expect(mock.calls.filter((c) => c.url.includes("/b/")).length).toBe(1);
    });

    it("fails over on a Chinese account-level 400 (余额不足) and on 402", async () => {
      for (const [status, message] of [
        [400, "该令牌余额不足，请充值后重试"],
        [402, "Insufficient Balance"],
      ] as const) {
        mock?.restore();
        mock = mockFetch([
          { match: "/a/v1/chat/completions", response: { status, body: { error: { message } } } },
          { match: "/b/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "B" } }] } } },
        ]);
        const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] });
        expect(res.status).toBe(200);
        expect(mock.calls.filter((c) => c.url.includes("/b/")).length).toBe(1);
      }
    });

    it("returns 502 with an 'all providers … last status' message when every provider fails", async () => {
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 500, body: { error: { message: "boom" } } } },
        { match: "/b/v1/chat/completions", response: { status: 500, body: { error: { message: "boom" } } } },
      ]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] });
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

  describe("dispatch rpm pacing", () => {
    it("skips a source at its rpm cap and fails over without hitting it", async () => {
      await seedStore(store, {
        providers: [{ ...A, rpm: 1 }, B],
        models: { m: makeModel({ openai: fe(["prv_A", "prv_B"]) }) },
      });
      // Pre-fill A's window to its cap of 1.
      store.recordDispatch("prv_A");
      expect(store.rpmUsed("prv_A")).toBe(1);
      mock = mockFetch([
        { match: "/b/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "from-B" } }] } } },
      ]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] });
      expect(res.status).toBe(200);
      expect((await json<ChatBody>(res)).choices[0].message.content).toBe("from-B");
      // A was skipped entirely — the upstream was never hit.
      expect(mock.calls.filter((c) => c.url.includes("/a/")).length).toBe(0);
      expect(mock.calls.filter((c) => c.url.includes("/b/")).length).toBe(1);
    });

    it("does not pace a source still under its cap", async () => {
      await seedStore(store, {
        providers: [{ ...A, rpm: 5 }],
        models: { m: makeModel({ openai: fe(["prv_A", "prv_B"]) }) },
      });
      store.recordDispatch("prv_A"); // 1 < 5 — still under
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "from-A" } }] } } },
      ]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] });
      expect(res.status).toBe(200);
      expect(mock.calls.filter((c) => c.url.includes("/a/")).length).toBe(1);
    });

    it("queues when EVERY source is over its cap, dispatching once a slot frees", async () => {
      vi.useFakeTimers();
      try {
        await seedStore(store, {
          providers: [{ ...A, rpm: 1 }, { ...B, rpm: 1 }],
          models: { m: makeModel({ openai: fe(["prv_A", "prv_B"]) }) },
        });
        // Both at their cap: nothing live, nothing cooling -> the request queues
        // in the gateway instead of being sent over the limit (or erroring).
        // The client just waits - here until the 60s windows slide.
        store.recordDispatch("prv_A");
        store.recordDispatch("prv_B");
        mock = mockFetch([
          { match: "/a/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "from-A" } }] } } },
        ]);
        const resPromise = post("/openai-chat/v1/chat/completions", { model: "m", messages: [] });
        await vi.advanceTimersByTimeAsync(60_001); // windows slide, queue releases
        const res = await resPromise;
        expect(res.status).toBe(200);
        expect((await json<ChatBody>(res)).choices[0].message.content).toBe("from-A");
        expect(mock.calls.filter((c) => c.url.includes("/a/")).length).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("queues for a capped source after the free sources all fail, instead of 502", async () => {
      vi.useFakeTimers();
      try {
        await seedStore(store, {
          providers: [{ ...A, rpm: 1 }, B],
          models: { m: makeModel({ openai: fe(["prv_A", "prv_B"]) }) },
        });
        store.recordDispatch("prv_A"); // A capped; B free but failing
        mock = mockFetch([
          { match: "/b/v1/chat/completions", response: { status: 500, body: { error: { message: "boom" } } } },
          { match: "/a/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "from-A" } }] } } },
        ]);
        const resPromise = post("/openai-chat/v1/chat/completions", { model: "m", messages: [] });
        // B fails (retryable) immediately; A is capped -> the request queues.
        await vi.advanceTimersByTimeAsync(60_001);
        const res = await resPromise;
        expect(res.status).toBe(200);
        expect((await json<ChatBody>(res)).choices[0].message.content).toBe("from-A");
        expect(mock.calls.filter((c) => c.url.includes("/a/")).length).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("drops a queued request when the client disconnects - no upstream call, one 499 row", async () => {
      vi.useFakeTimers();
      try {
        await seedStore(store, {
          providers: [{ ...A, rpm: 1 }],
          models: { m: makeModel({ openai: fe(["prv_A"]) }) },
        });
        store.recordDispatch("prv_A"); // at cap
        mock = mockFetch([
          { match: "/a/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "ok" } }] } } },
        ]);
        const ctrl = new AbortController();
        const req = new Request("http://gw.test/openai-chat/v1/chat/completions", {
          method: "POST",
          headers: { authorization: "Bearer " + store.get().apiKey, "content-type": "application/json" },
          body: JSON.stringify({ model: "m", messages: [] }),
          signal: ctrl.signal,
        });
        const resPromise = createApp(store).fetch(req);
        // Let the request settle into the queue, then hang up.
        await vi.advanceTimersByTimeAsync(0);
        ctrl.abort();
        await vi.advanceTimersByTimeAsync(60_001);
        const res = await resPromise;
        expect(res.status).toBe(499);
        expect(mock.calls.filter((c) => c.url.includes("/a/")).length).toBe(0);
        // The abort leaves a TRACE now: a 499 row names what happened (the call
        // used to vanish from history entirely).
        const row = store.getLogs().find((e) => e.model === "m");
        expect(row?.status).toBe(499);
        expect(row?.error).toContain("client aborted");
      } finally {
        vi.useRealTimers();
      }
    });

    it("a pinned per-source probe ignores the rpm cap and records nothing", async () => {
      await seedStore(store, {
        providers: [{ ...A, rpm: 1 }],
        models: { m: makeModel({ openai: fe(["prv_A"]) }) },
      });
      store.recordDispatch("prv_A"); // at cap
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "ok" } }] } } },
      ]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] }, { "x-myapikey-probe-slot": "0" });
      expect(res.status).toBe(200);
      expect(mock.calls.filter((c) => c.url.includes("/a/")).length).toBe(1);
      // A pinned probe takes no pacing side-effects: the window is unchanged.
      expect(store.rpmUsed("prv_A")).toBe(1);
    });
  });

  describe("dispatch even pacing (per-model leaky bucket)", () => {
    it("spreads concurrent calls one interval apart on one model", async () => {
      await seedStore(store, {
        providers: [A],
        // rpm=600 -> one release every 100ms.
        models: { m: makeModel({ paceRpm: 600, openai: fe(["prv_A"]) }) },
      });
      const times: number[] = [];
      mock = mockFetch([
        {
          match: "/a/v1/chat/completions",
          response: () => {
            times.push(Date.now());
            return { status: 200, body: { choices: [{ message: { content: "ok" } }] } };
          },
        },
      ]);
      const [r1, r2] = await Promise.all([
        post("/openai-chat/v1/chat/completions", { model: "m", messages: [] }),
        post("/openai-chat/v1/chat/completions", { model: "m", messages: [] }),
      ]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(times).toHaveLength(2);
      // Second release waits a full interval (allow scheduling slack).
      expect(times[1] - times[0]).toBeGreaterThanOrEqual(90);
    });

    it("does not delay a model without paceRpm", async () => {
      await seedStore(store, {
        providers: [A],
        models: { m: makeModel({ openai: fe(["prv_A"]) }) },
      });
      const times: number[] = [];
      mock = mockFetch([
        {
          match: "/a/v1/chat/completions",
          response: () => {
            times.push(Date.now());
            return { status: 200, body: { choices: [{ message: { content: "ok" } }] } };
          },
        },
      ]);
      await Promise.all([
        post("/openai-chat/v1/chat/completions", { model: "m", messages: [] }),
        post("/openai-chat/v1/chat/completions", { model: "m", messages: [] }),
      ]);
      expect(times).toHaveLength(2);
      expect(times[1] - times[0]).toBeLessThan(90);
    });

    it("429s with Retry-After when the queue is past the 60s horizon, and logs it", async () => {
      await seedStore(store, {
        providers: [A],
        models: { m: makeModel({ paceRpm: 10, openai: fe(["prv_A"]) }) },
      });
      // Pre-fill the queue: 11 claims (immediate + 6s..60s) - the next slot is
      // 66s out, past the 60s horizon.
      for (let i = 0; i < 11; i++) store.paceClaim("m", 10);
      mock = mockFetch([]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] });
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("6");
      expect((await json<{ error: { type: string; code: string } }>(res)).error.type).toBe("rate_limit_error");
      // Never touched the upstream; the rejection is visible in the timeline.
      expect(mock.calls).toHaveLength(0);
      expect(store.getLogs().some((l) => l.status === 429 && l.model === "m")).toBe(true);
    });

    it("429s in the anthropic error shape on the anthropic surface", async () => {
      await seedStore(store, {
        providers: [A],
        models: { m: makeModel({ paceRpm: 10, anthropic: fe(["prv_A"]) }) },
      });
      for (let i = 0; i < 11; i++) store.paceClaim("m", 10);
      mock = mockFetch([]);
      const res = await post("/anthropic/v1/messages", { model: "m", messages: [] });
      expect(res.status).toBe(429);
      const body = await json<{ type: string; error: { type: string } }>(res);
      expect(body.type).toBe("error");
      expect(body.error.type).toBe("rate_limit_error");
    });
  });

  describe("dispatch model mapping", () => {
    it("rewrites model per provider and recomputes from the original on failover", async () => {
      // Reseed m so only B has an upstream name mapped.
      await seedStore(store, {
        models: {
          m: makeModel({ openai: fe([{ id: "prv_A" }, { id: "prv_B", model: "gpt-4o-2024" }]) }),
          onlyA: makeModel({ openai: fe(["prv_A"]) }),
        },
      });
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 503, body: { error: { message: "down" } } } },
        { match: "/b/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "ok" } }] } } },
      ]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] });
      expect(res.status).toBe(200);
      const aCall = mock.calls.find((c) => c.url.includes("/a/"));
      const bCall = mock.calls.find((c) => c.url.includes("/b/"));
      // No map for A → public name sent verbatim.
      expect(JSON.parse(aCall!.body).model).toBe("m");
      // B's entry rewrites the model to its configured upstream name.
      expect(JSON.parse(bCall!.body).model).toBe("gpt-4o-2024");
      // The success log row records the actual upstream model that answered (B's
      // mapped name), so history shows which real model a routed call landed on.
      await res.text(); // drain so the success row's onSettle fires + logs
      const log = store.getLogs().find((e) => e.model === "m" && !e.kind);
      expect(log?.upstreamModel).toBe("gpt-4o-2024");
    });
  });

  describe("dispatch thinking default", () => {
    it("injects the slot's default when the request carries no thinking parameter, and logs it as the default", async () => {
      await seedStore(store, {
        models: { m: makeModel({ openai: fe([{ id: "prv_A", thinking: "high" }]) }) },
      });
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "ok" } }] } } },
      ]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] });
      expect(res.status).toBe(200);
      expect(JSON.parse(mock.calls[0].body).reasoning_effort).toBe("high");
      await res.text(); // drain so the success row's onSettle fires + logs
      const log = store.getLogs().find((e) => e.model === "m" && !e.kind);
      expect(log?.thinking).toEqual({ value: "high", from: "default" });
    });

    it("OVERRIDES the request's own thinking setting with the slot default (the gateway's level wins)", async () => {
      await seedStore(store, {
        models: { m: makeModel({ openai: fe([{ id: "prv_A", thinking: "high" }]) }) },
      });
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "ok" } }] } } },
      ]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [], reasoning_effort: "low" });
      await res.text();
      expect(JSON.parse(mock.calls[0].body).reasoning_effort).toBe("high");
      expect(store.getLogs().find((e) => e.model === "m")?.thinking).toEqual({ value: "high", from: "default" });
    });

    it("an override replaces a compat thinking switch too (enable_thinking is cleared)", async () => {
      await seedStore(store, {
        models: { m: makeModel({ openai: fe([{ id: "prv_A", thinking: "high" }]) }) },
      });
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "ok" } }] } } },
      ]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [], enable_thinking: true });
      await res.text();
      const up = JSON.parse(mock.calls[0].body);
      expect(up.reasoning_effort).toBe("high");
      expect(up.enable_thinking).toBeUndefined();
      expect(store.getLogs().find((e) => e.model === "m")?.thinking).toEqual({ value: "high", from: "default" });
    });

    it("without a default the request's own switch passes through and is logged as client-set", async () => {
      await seedStore(store, {
        models: { m: makeModel({ openai: fe([{ id: "prv_A" }]) }) },
      });
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "ok" } }] } } },
      ]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [], enable_thinking: true });
      await res.text();
      const up = JSON.parse(mock.calls[0].body);
      expect(up.enable_thinking).toBe(true);
      expect(up.reasoning_effort).toBeUndefined();
      expect(store.getLogs().find((e) => e.model === "m")?.thinking).toEqual({ value: "true", from: "client" });
    });

    it("anthropic slot: injects thinking {type,budget_tokens} and lifts max_tokens above the budget", async () => {
      await seedStore(store, {
        models: { m: makeModel({ anthropic: fe([{ id: "prv_A", thinking: "2048" }]) }) },
      });
      mock = mockFetch([
        { match: "/a/v1/messages", response: { status: 200, body: { content: [{ type: "text", text: "ok" }] } } },
      ]);
      // max_tokens: 1 is exactly what the admin test probe sends — the lift is
      // what keeps a configured slot's own probe from 400ing.
      const res = await post("/anthropic/v1/messages", { model: "m", messages: [], max_tokens: 1 });
      expect(res.status).toBe(200);
      const up = JSON.parse(mock.calls[0].body);
      expect(up.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
      expect(up.max_tokens).toBe(2049);
      await res.text();
      expect(store.getLogs().find((e) => e.model === "m")?.thinking).toEqual({ value: "2048", from: "default" });
    });

    it("anthropic: the slot default replaces the request's thinking object and lifts its max_tokens", async () => {
      await seedStore(store, {
        models: { m: makeModel({ anthropic: fe([{ id: "prv_A", thinking: "2048" }]) }) },
      });
      mock = mockFetch([
        { match: "/a/v1/messages", response: { status: 200, body: { content: [{ type: "text", text: "ok" }] } } },
      ]);
      const res = await post("/anthropic/v1/messages", {
        model: "m",
        messages: [],
        max_tokens: 512,
        thinking: { type: "enabled", budget_tokens: 256 },
      });
      await res.text();
      const up = JSON.parse(mock.calls[0].body);
      expect(up.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
      // 512 ≤ the forced budget → lifted, else the upstream would 400.
      expect(up.max_tokens).toBe(2049);
      expect(store.getLogs().find((e) => e.model === "m")?.thinking).toEqual({ value: "2048", from: "default" });
    });

    it("responses slot: injects reasoning.effort", async () => {
      await seedStore(store, {
        models: { m: makeModel({ responses: fe([{ id: "prv_A", thinking: "medium" }]) }) },
      });
      mock = mockFetch([
        { match: "/a/v1/responses", response: { status: 200, body: { output: [] } } },
      ]);
      const res = await post("/openai-responses/v1/responses", { model: "m", input: "x" });
      await res.text();
      expect(JSON.parse(mock.calls[0].body).reasoning).toEqual({ effort: "medium" });
      expect(store.getLogs().find((e) => e.model === "m")?.thinking).toEqual({ value: "medium", from: "default" });
    });

    it("failover to a no-default slot restores the request's own thinking setting", async () => {
      await seedStore(store, {
        models: { m: makeModel({ openai: fe([{ id: "prv_A", thinking: "high" }, { id: "prv_B" }]) }) },
      });
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 503, body: { error: { message: "down" } } } },
        { match: "/b/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "ok" } }] } } },
      ]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [], reasoning_effort: "low" });
      await res.text();
      // Slot A was attempted WITH the forced default; B (which answered) ran the
      // request's own setting, restored after A's override.
      expect(JSON.parse(mock.calls.find((c) => c.url.includes("/a/"))!.body).reasoning_effort).toBe("high");
      expect(JSON.parse(mock.calls.find((c) => c.url.includes("/b/"))!.body).reasoning_effort).toBe("low");
      // Each row reflects the slot it belongs to.
      expect(store.getLogs().find((e) => e.model === "m" && e.status === 200)?.thinking).toEqual({ value: "low", from: "client" });
      expect(store.getLogs().find((e) => e.kind === "cooldown")?.thinking).toEqual({ value: "high", from: "default" });
    });

    it("anthropic failover: a no-default slot restores the request's thinking object AND max_tokens", async () => {
      await seedStore(store, {
        models: { m: makeModel({ anthropic: fe([{ id: "prv_A", thinking: "4096" }, { id: "prv_B" }]) }) },
      });
      mock = mockFetch([
        { match: "/a/v1/messages", response: { status: 503, body: { error: { message: "down" } } } },
        { match: "/b/v1/messages", response: { status: 200, body: { content: [{ type: "text", text: "ok" }] } } },
      ]);
      const own = { type: "enabled", budget_tokens: 200 };
      const res = await post("/anthropic/v1/messages", { model: "m", messages: [], max_tokens: 300, thinking: own });
      await res.text();
      // A: forced budget + lifted cap. B: the request's original pair, restored.
      const a = JSON.parse(mock.calls.find((c) => c.url.includes("/a/"))!.body);
      const b = JSON.parse(mock.calls.find((c) => c.url.includes("/b/"))!.body);
      expect(a.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
      expect(a.max_tokens).toBe(4097);
      expect(b.thinking).toEqual(own);
      expect(b.max_tokens).toBe(300);
      expect(store.getLogs().find((e) => e.model === "m" && e.status === 200)?.thinking).toEqual({ value: "200", from: "client" });
    });
  });

  describe("dispatch sampling default", () => {
    it("injects the slot's configured sampling fields when the request carries none, and logs them", async () => {
      await seedStore(store, {
        models: { m: makeModel({ openai: fe([{ id: "prv_A", sampling: { temperature: 0.2, top_p: 0.9 } }]) }) },
      });
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "ok" } }] } } },
      ]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] });
      expect(res.status).toBe(200);
      const up = JSON.parse(mock.calls[0].body);
      expect(up.temperature).toBe(0.2);
      expect(up.top_p).toBe(0.9);
      await res.text(); // drain so the success row's onSettle fires + logs
      const log = store.getLogs().find((e) => e.model === "m" && !e.kind);
      expect(log?.sampling).toEqual({ temperature: 0.2, top_p: 0.9 });
    });

    it("overrides ONLY the configured fields; unconfigured ones pass through untouched", async () => {
      await seedStore(store, {
        models: { m: makeModel({ openai: fe([{ id: "prv_A", sampling: { temperature: 0.2 } }]) }) },
      });
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "ok" } }] } } },
      ]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [], temperature: 1, top_p: 0.5 });
      await res.text();
      const up = JSON.parse(mock.calls[0].body);
      expect(up.temperature).toBe(0.2);
      expect(up.top_p).toBe(0.5);
      expect(store.getLogs().find((e) => e.model === "m")?.sampling).toEqual({ temperature: 0.2 });
    });

    it("without a default the request's sampling parameters pass through and are NOT logged", async () => {
      await seedStore(store, {
        models: { m: makeModel({ openai: fe([{ id: "prv_A" }]) }) },
      });
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "ok" } }] } } },
      ]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [], temperature: 0.7 });
      await res.text();
      expect(JSON.parse(mock.calls[0].body).temperature).toBe(0.7);
      expect(store.getLogs().find((e) => e.model === "m")?.sampling).toBeUndefined();
    });

    it("failover to a no-default slot restores the request's own sampling values", async () => {
      await seedStore(store, {
        models: { m: makeModel({ openai: fe([{ id: "prv_A", sampling: { temperature: 0.2 } }, { id: "prv_B" }]) }) },
      });
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 503, body: { error: { message: "down" } } } },
        { match: "/b/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "ok" } }] } } },
      ]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [], temperature: 1 });
      await res.text();
      // Slot A was attempted WITH the forced default; B (which answered) ran the
      // request's own value, restored after A's override.
      expect(JSON.parse(mock.calls.find((c) => c.url.includes("/a/"))!.body).temperature).toBe(0.2);
      expect(JSON.parse(mock.calls.find((c) => c.url.includes("/b/"))!.body).temperature).toBe(1);
      // Each row reflects the slot it belongs to: B injected nothing, A's
      // cooldown row did.
      expect(store.getLogs().find((e) => e.model === "m" && e.status === 200)?.sampling).toBeUndefined();
      expect(store.getLogs().find((e) => e.kind === "cooldown")?.sampling).toEqual({ temperature: 0.2 });
    });

    it("anthropic slot: injects the same wire-agnostic field names", async () => {
      await seedStore(store, {
        models: { m: makeModel({ anthropic: fe([{ id: "prv_A", sampling: { temperature: 0.5, top_k: 40 } }]) }) },
      });
      mock = mockFetch([
        { match: "/a/v1/messages", response: { status: 200, body: { content: [{ type: "text", text: "ok" }] } } },
      ]);
      const res = await post("/anthropic/v1/messages", { model: "m", messages: [], max_tokens: 100 });
      expect(res.status).toBe(200);
      const up = JSON.parse(mock.calls[0].body);
      expect(up.temperature).toBe(0.5);
      expect(up.top_k).toBe(40);
      await res.text();
      expect(store.getLogs().find((e) => e.model === "m")?.sampling).toEqual({ temperature: 0.5, top_k: 40 });
    });
  });

  describe("dispatch duplicate slots (one source, several upstream models)", () => {
    it("fails over to a second slot under the SAME source, each sending its own upstream model", async () => {
      // coding → Ark:doubao-pro (slot 0) primary, Ark:doubao-lite (slot 1) fallback.
      // Same provider id twice; circuit + rpm state are shared by id, but failover
      // still proceeds to slot 1 — the skipped-list is computed once, before the loop.
      await seedStore(store, {
        models: {
          m: makeModel({
            openai: fe([
              { id: "prv_A", model: "doubao-pro" },
              { id: "prv_A", model: "doubao-lite" },
            ]),
          }),
        },
      });
      mock = mockFetch([
        {
          match: "/a/v1/chat/completions",
          response: sequence([
            { status: 503, body: { error: { message: "down" } } }, // slot 0 (doubao-pro)
            { status: 200, body: { choices: [{ message: { content: "ok" } }] } }, // slot 1 (doubao-lite)
          ]),
        },
      ]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] });
      // Drain the body: recordCircuitSuccess only fires from observedBody's
      // onSettle, which runs once the streamed response is fully consumed.
      await res.text();
      expect(res.status).toBe(200);
      // Both attempts went to A's upstream — it's the only backend in the chain.
      const aCalls = mock.calls.filter((c) => c.url.includes("/a/"));
      expect(aCalls.length).toBe(2);
      // Slot 0 sent its mapped upstream name; slot 1 sent ITS (different) mapped name.
      expect(JSON.parse(aCalls[0].body).model).toBe("doubao-pro");
      expect(JSON.parse(aCalls[1].body).model).toBe("doubao-lite");
      // The shared-by-id circuit recorded A's failure, but the call still succeeded
      // via slot 1 — and that success (same id) reset the breaker for A.
      expect(store.isCooling("prv_A")).toBe(false);
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
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] });
      expect(res.status).toBe(200);
      expect((await json<ChatBody>(res)).choices[0].message.content).toBe("B");
      // A was skipped entirely; B answered once.
      expect(mock.calls.filter((c) => c.url.includes("/a/")).length).toBe(0);
      expect(mock.calls.filter((c) => c.url.includes("/b/")).length).toBe(1);
    });

    it("honors an upstream Retry-After on 429 (cools exactly that long, not 30s)", async () => {
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 429, body: { error: { message: "slow" } }, headers: { "retry-after": "5" } } },
        { match: "/b/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "B" } }] } } },
      ]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] });
      expect(res.status).toBe(200); // failed over to B
      expect(store.isCooling("prv_A")).toBe(true);
      const cd = store.getLogs().find((e) => e.providerId === "prv_A" && e.kind === "cooldown");
      expect(cd?.cooldownMs).toBe(5_000);
      expect(cd?.fails).toBe(1);
    });

    it("falls back to the escalating 30s cooldown when a 429 has no Retry-After", async () => {
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 429, body: { error: { message: "slow" } } } },
        { match: "/b/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "B" } }] } } },
      ]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] });
      expect(res.status).toBe(200);
      expect(store.isCooling("prv_A")).toBe(true);
      const cd = store.getLogs().find((e) => e.providerId === "prv_A" && e.kind === "cooldown");
      expect(cd?.cooldownMs).toBe(30_000);
    });

    it("parses the reset time out of an Ark-style 429 body when there is no Retry-After", async () => {
      // Volcengine Ark 1308: reset time embedded in the error message, no header.
      // Build the datetime ~20min out as Beijing wall-clock (UTC+8), which is how
      // parseResetFromBody reads a bare datetime regardless of the gateway's TZ.
      const reset = new Date(Date.now() + 20 * 60_000);
      const u = new Date(reset.getTime() + 8 * 3600_000);
      const p = (n: number) => String(n).padStart(2, "0");
      const ts = `${u.getUTCFullYear()}-${p(u.getUTCMonth() + 1)}-${p(u.getUTCDate())} ${p(u.getUTCHours())}:${p(u.getUTCMinutes())}:${p(u.getUTCSeconds())}`;
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 429, body: { error: { code: "1308", message: `[1308][已达到 5 小时的使用上限。您的限额将在 ${ts} 重置。][2026081118012623401256bc9b4019]` } } } },
        { match: "/b/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "B" } }] } } },
      ]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] });
      expect(res.status).toBe(200); // failed over to B
      expect(store.isCooling("prv_A")).toBe(true);
      const cd = store.getLogs().find((e) => e.providerId === "prv_A" && e.kind === "cooldown");
      // Honored the parsed reset window (~20min) — past the 5min CB_CAP ceiling the
      // escalating/backoff path clamps to, and NOT the escalating 30s first rung.
      expect(cd?.cooldownMs!).toBeGreaterThan(300_000);
      expect(cd?.cooldownMs!).toBeGreaterThan(19 * 60_000);
      expect(cd?.cooldownMs!).toBeLessThanOrEqual(20 * 60_000);
    });

    it("ignores a reset datetime in the past (falls back to the escalating guess)", async () => {
      const past = new Date(Date.now() - 60_000);
      const u = new Date(past.getTime() + 8 * 3600_000);
      const p = (n: number) => String(n).padStart(2, "0");
      const ts = `${u.getUTCFullYear()}-${p(u.getUTCMonth() + 1)}-${p(u.getUTCDate())} ${p(u.getUTCHours())}:${p(u.getUTCMinutes())}:${p(u.getUTCSeconds())}`;
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 429, body: { error: { message: `限额将在 ${ts} 重置` } } } },
        { match: "/b/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "B" } }] } } },
      ]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] });
      expect(res.status).toBe(200);
      const cd = store.getLogs().find((e) => e.providerId === "prv_A" && e.kind === "cooldown");
      expect(cd?.cooldownMs).toBe(30_000); // escalating first rung, not a parsed hint
    });
  });

  describe("stream truncation monitoring", () => {
    // A healthy anthropic stream carries its terminal `message_stop` event.
    const anthropicOk = () =>
      sseBody([
        "event: message_start", 'data: {"type":"message_start"}', "",
        'event: content_block_delta', 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}', "",
        "event: message_stop", 'data: {"type":"message_stop"}', "",
      ]);
    // Same start but the stream ENDS before message_stop — the silent-EOF mode
    // some incompatible backends produce (200 headers, then a truncated body).
    const anthropicTrunc = () =>
      sseBody([
        "event: message_start", 'data: {"type":"message_start"}', "",
        'event: content_block_delta', 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}', "",
      ]);
    const sseHeaders = { "content-type": "text/event-stream" };

    it("logs a healthy anthropic stream as 200 and forwards the body intact", async () => {
      mock = mockFetch([{ match: "/a/v1/messages", response: { status: 200, bodyStream: anthropicOk(), headers: sseHeaders } }]);
      const res = await post("/anthropic/v1/messages", { model: "m", messages: [], stream: true });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("message_stop");
      const call = store.getLogs().find((e) => e.model === "m" && !e.kind);
      expect(call?.status).toBe(200);
      expect(call?.error).toBeUndefined();
      expect(store.isCooling("prv_A")).toBe(false);
    });

    it("detects a truncated anthropic stream: logs 502, trips the circuit, injects an SSE error", async () => {
      mock = mockFetch([{ match: "/a/v1/messages", response: { status: 200, bodyStream: anthropicTrunc(), headers: sseHeaders } }]);
      const res = await post("/anthropic/v1/messages", { model: "m", messages: [], stream: true });
      expect(res.status).toBe(200); // HTTP status was already committed at the headers
      const text = await res.text();
      expect(text).toContain("text_delta"); // partial bytes still forwarded verbatim
      expect(text).toContain("event: error"); // synthetic error appended
      expect(text).toContain("api_error");
      const call = store.getLogs().find((e) => e.model === "m" && !e.kind);
      expect(call?.status).toBe(502);
      expect(call?.error).toContain("truncated");
      expect(store.isCooling("prv_A")).toBe(true); // → next call fails over
    });

    it("detects a truncated non-streaming body (incomplete JSON): logs 502, trips the circuit, forwards the broken body verbatim", async () => {
      // A non-streaming body cut off mid-write ends as a normal read-done —
      // the only tell is that the JSON never completes. Used to settle 200
      // (the malformed bytes were "left untouched" and logged as success).
      const enc = new TextEncoder();
      const partial = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode('{"id":"x","choices":[{"message":{"content":"he'));
          c.close(); // …then a clean EOF
        },
      });
      mock = mockFetch([{ match: "/a/v1/chat/completions", response: { status: 200, bodyStream: partial } }]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] });
      expect(res.status).toBe(200); // HTTP status was already committed at the headers
      expect(await res.text()).toContain('"content":"he'); // broken bytes still forwarded verbatim
      const call = store.getLogs().find((e) => e.model === "m" && !e.kind);
      expect(call?.status).toBe(502); // the row no longer lies about success
      expect(call?.error).toContain("incomplete JSON");
      expect(store.isCooling("prv_A")).toBe(true); // → next call fails over
    });

    it("detects an upstream stream that errors mid-flight (reader rejects)", async () => {
      const sse = sseBody(["event: message_start", 'data: {"type":"message_start"}', ""], "error", new TypeError("terminated"));
      mock = mockFetch([{ match: "/a/v1/messages", response: { status: 200, bodyStream: sse, headers: sseHeaders } }]);
      const res = await post("/anthropic/v1/messages", { model: "m", messages: [], stream: true });
      const text = await res.text();
      expect(text).toContain("event: error");
      const call = store.getLogs().find((e) => e.model === "m" && !e.kind);
      expect(call?.status).toBe(502);
      expect(call?.error).toContain("terminated");
      expect(store.isCooling("prv_A")).toBe(true);
    });

    it("logs a healthy openai stream ([DONE]) as 200", async () => {
      const sse = sseBody(['data: {"choices":[{"delta":{"content":"hi"}}]}', "", "data: [DONE]", ""]);
      mock = mockFetch([{ match: "/a/v1/chat/completions", response: { status: 200, bodyStream: sse, headers: sseHeaders } }]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [], stream: true });
      await res.text();
      const call = store.getLogs().find((e) => e.model === "m" && !e.kind);
      expect(call?.status).toBe(200);
    });

    it("truncated openai /chat/completions stream: logs 502 + trips circuit, injects a data:{error} frame", async () => {
      const sse = sseBody(['data: {"choices":[{"delta":{"content":"hi"}}]}', ""]); // no [DONE]
      mock = mockFetch([{ match: "/a/v1/chat/completions", response: { status: 200, bodyStream: sse, headers: sseHeaders } }]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [], stream: true });
      const text = await res.text();
      expect(text).toContain('"error"'); // de-facto data:{error} shape; no event: line on this wire
      expect(text).toContain("server_error");
      expect(text).not.toContain("event: error");
      const call = store.getLogs().find((e) => e.model === "m" && !e.kind);
      expect(call?.status).toBe(502);
      expect(store.isCooling("prv_A")).toBe(true);
    });

    it("truncated /responses stream: logs 502, trips circuit, injects an event:error", async () => {
      const sse = sseBody([
        "event: response.created", 'data: {"type":"response.created"}', "",
        'event: response.output_text.delta', 'data: {"type":"response.output_text.delta","delta":"hi"}', "",
        // no response.completed — truncated
      ]);
      mock = mockFetch([{ match: "/a/v1/responses", response: { status: 200, bodyStream: sse, headers: sseHeaders } }]);
      const res = await post("/openai-responses/v1/responses", { model: "m", input: "x", stream: true });
      const text = await res.text();
      expect(text).toContain("event: error");
      expect(text).toContain('"type":"error"');
      const call = store.getLogs().find((e) => e.model === "m" && !e.kind);
      expect(call?.status).toBe(502);
      expect(store.isCooling("prv_A")).toBe(true);
    });

    it("a /responses stream ending in response.completed is healthy (200)", async () => {
      const sse = sseBody([
        "event: response.created", 'data: {"type":"response.created"}', "",
        "event: response.completed", 'data: {"type":"response.completed"}', "",
      ]);
      mock = mockFetch([{ match: "/a/v1/responses", response: { status: 200, bodyStream: sse, headers: sseHeaders } }]);
      await (await post("/openai-responses/v1/responses", { model: "m", input: "x", stream: true })).text();
      const call = store.getLogs().find((e) => e.model === "m" && !e.kind);
      expect(call?.status).toBe(200);
    });

    it("a /responses stream ending in response.failed is NOT truncation (upstream reported failure cleanly)", async () => {
      const sse = sseBody([
        "event: response.created", 'data: {"type":"response.created"}', "",
        "event: response.failed", 'data: {"type":"response.failed","response":{"status":"failed","error":{"message":"boom"}}}', "",
      ]);
      mock = mockFetch([{ match: "/a/v1/responses", response: { status: 200, bodyStream: sse, headers: sseHeaders } }]);
      const text = await (await post("/openai-responses/v1/responses", { model: "m", input: "x", stream: true })).text();
      expect(text).not.toContain("event: error"); // upstream's own failure event passed through; no synthetic inject
      const call = store.getLogs().find((e) => e.model === "m" && !e.kind);
      expect(call?.status).toBe(200); // clean terminal → not truncated → don't cool
      expect(store.isCooling("prv_A")).toBe(false);
    });

    it("a pinned per-source probe with a truncated stream logs 502 but does NOT trip the circuit", async () => {
      mock = mockFetch([{ match: "/a/v1/messages", response: { status: 200, bodyStream: anthropicTrunc(), headers: sseHeaders } }]);
      const res = await post("/anthropic/v1/messages", { model: "m", messages: [], stream: true }, { "x-myapikey-probe-slot": "0" });
      await res.text();
      const call = store.getLogs().find((e) => e.model === "m" && !e.kind);
      expect(call?.status).toBe(502);
      expect(store.isCooling("prv_A")).toBe(false);
      expect(store.circuitState().find((x) => x.id === "prv_A")?.fails).toBe(0);
    });

    it("a source that truncated enters cooling, so the NEXT call fails over to the next source", async () => {
      // m's anthropic slot defaults to A only — reseed A→B so failover exists.
      await seedStore(store, {
        providers: [A, B],
        models: { m: makeModel({ anthropic: fe(["prv_A", "prv_B"]) }) },
      });
      mock = mockFetch([
        { match: "/a/v1/messages", response: { status: 200, bodyStream: anthropicTrunc(), headers: sseHeaders } },
        { match: "/b/v1/messages", response: { status: 200, bodyStream: anthropicOk(), headers: sseHeaders } },
      ]);
      // 1st call: A truncates → settles 502, A enters cooling.
      await (await post("/anthropic/v1/messages", { model: "m", messages: [], stream: true })).text();
      expect(store.isCooling("prv_A")).toBe(true);
      // 2nd call: A is cooling → skipped, B streams cleanly to completion.
      const r2 = await post("/anthropic/v1/messages", { model: "m", messages: [], stream: true });
      expect((await r2.text()).includes("message_stop")).toBe(true);
      expect(mock.calls.filter((c) => c.url.includes("/a/")).length).toBe(1);
      expect(mock.calls.filter((c) => c.url.includes("/b/")).length).toBe(1);
    });

    it("detects a terminal marker split across two byte chunks", async () => {
      const enc = new TextEncoder();
      // "message_stop" straddles the boundary between the two chunks.
      const split = chunkedBody([
        enc.encode('event: message_sto'),
        enc.encode('p\ndata: {"type":"message_stop"}\n\n'),
      ]);
      mock = mockFetch([{ match: "/a/v1/messages", response: { status: 200, bodyStream: split, headers: sseHeaders } }]);
      await (await post("/anthropic/v1/messages", { model: "m", messages: [], stream: true })).text();
      const call = store.getLogs().find((e) => e.model === "m" && !e.kind);
      expect(call?.status).toBe(200); // marker seen despite the split → healthy
    });
  });

  describe("upstream hangs and client aborts", () => {
    // An upstream that emits ONE chunk then never sends another byte and never
    // closes — the stall mode neither EOF nor a reader error ever surfaces.
    const stallingStream = (): ReadableStream<Uint8Array> => {
      const enc = new TextEncoder();
      let sent = false;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) return new Promise(() => {}); // hang forever
          sent = true;
          controller.enqueue(enc.encode('event: message_start\ndata: {"type":"message_start"}\n\n'));
        },
      });
    };
    // An upstream whose body NEVER emits a byte — the first-byte gate's mode.
    const silentStream = (): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
    const sseHeaders = { "content-type": "text/event-stream" };

    it("logs a 499 row (and does not fail over or trip the circuit) when the client hangs up before headers arrive", async () => {
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { hang: true } },
        { match: "/b/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "B" } }] } } },
      ]);
      const ctrl = new AbortController();
      const req = new Request("http://gw.test/openai-chat/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + store.get().apiKey, "content-type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [] }),
        signal: ctrl.signal,
      });
      const resPromise = createApp(store).fetch(req);
      await new Promise((r) => setImmediate(r)); // let dispatch reach the fetch
      ctrl.abort();
      const res = await resPromise;
      expect(res.status).toBe(499);
      // Attempted once on A; no failover to B (the client is gone).
      expect(mock.calls.filter((c) => c.url.includes("/a/")).length).toBe(1);
      expect(mock.calls.filter((c) => c.url.includes("/b/")).length).toBe(0);
      // No circuit impact — the provider did nothing wrong — but the call left
      // a TRACE instead of vanishing from history.
      expect(store.isCooling("prv_A")).toBe(false);
      const row = store.getLogs().find((e) => e.model === "m");
      expect(row?.status).toBe(499);
      expect(row?.error).toContain("client aborted");
      expect(row?.providerId).toBe("prv_A");
    });

    it("aborts an upstream that never sends headers (TTFB timeout), fails over, and cools the hung source", async () => {
      vi.useFakeTimers();
      try {
        await seedStore(store, {
          providers: [A, B],
          models: { m: makeModel({ openai: fe(["prv_A", "prv_B"]) }) },
        });
        mock = mockFetch([
          { match: "/a/v1/chat/completions", response: { hang: true } },
          { match: "/b/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "from-B" } }] } } },
        ]);
        const resPromise = post("/openai-chat/v1/chat/completions", { model: "m", messages: [] });
        await vi.advanceTimersByTimeAsync(120_001); // past the 120s TTFB guard
        const res = await resPromise;
        // The hung source was abandoned and the client still got an answer.
        expect(res.status).toBe(200);
        expect((await json<ChatBody>(res)).choices[0].message.content).toBe("from-B");
        expect(mock.calls.filter((c) => c.url.includes("/a/")).length).toBe(1);
        expect(mock.calls.filter((c) => c.url.includes("/b/")).length).toBe(1);
        // The hang is a provider failure: cooled, with a 504 cooldown row.
        expect(store.isCooling("prv_A")).toBe(true);
        const cd = store.getLogs().find((e) => e.providerId === "prv_A" && e.kind === "cooldown");
        expect(cd?.status).toBe(504);
        expect(cd?.error).toContain("no response headers");
      } finally {
        vi.useRealTimers();
      }
    });

    it("errors a stream that stalls mid-body (idle timeout): injects an error frame, settles 504, trips the circuit", async () => {
      vi.useFakeTimers();
      try {
        mock = mockFetch([
          { match: "/a/v1/messages", response: { status: 200, bodyStream: stallingStream(), headers: sseHeaders } },
        ]);
        const textPromise = post("/anthropic/v1/messages", { model: "m", messages: [], stream: true }).then((r) => r.text());
        await vi.advanceTimersByTimeAsync(300_001); // past the 300s idle guard
        const text = await textPromise;
        expect(text).toContain("event: error"); // the client learns the stream died
        expect(text).toContain("stalled");
        const call = store.getLogs().find((e) => e.model === "m" && !e.kind);
        expect(call?.status).toBe(504);
        expect(call?.error).toContain("no bytes for 300s");
        expect(store.isCooling("prv_A")).toBe(true); // next call fails over
      } finally {
        vi.useRealTimers();
      }
    });

    it("fails over (first-byte gate) when a 200 never emits a single body byte", async () => {
      vi.useFakeTimers();
      try {
        mock = mockFetch([
          { match: "/a/v1/chat/completions", response: { status: 200, bodyStream: silentStream(), headers: sseHeaders } },
          {
            match: "/b/v1/chat/completions",
            response: {
              status: 200,
              bodyStream: sseBody([
                'data: {"choices":[{"delta":{"content":"hi"}}]}',
                "",
                "data: [DONE]",
                "",
              ]),
              headers: sseHeaders,
            },
          },
        ]);
        const textPromise = post("/openai-chat/v1/chat/completions", { model: "m", messages: [], stream: true }).then((r) => r.text());
        await vi.advanceTimersByTimeAsync(300_001); // gate fires on A: no body byte within the idle window
        const text = await textPromise;
        // Nothing was committed to the client before the retry, so B answered cleanly.
        expect(text).toContain("[DONE]");
        expect(mock.calls.filter((c) => c.url.includes("/a/")).length).toBe(1);
        expect(mock.calls.filter((c) => c.url.includes("/b/")).length).toBe(1);
        expect(store.isCooling("prv_A")).toBe(true); // the silent source trips the breaker
      } finally {
        vi.useRealTimers();
      }
    });

    it("answers a clean 504 after exhausting the first-byte stall retries", async () => {
      vi.useFakeTimers();
      try {
        mock = mockFetch([
          // A fresh silent stream per attempt — a ReadableStream can be locked
          // only once, and this route IS re-attempted by the retry loop.
          { match: "/a/v1/chat/completions", response: () => ({ status: 200, bodyStream: silentStream(), headers: sseHeaders }) },
        ]);
        // `onlyA` chains just one source, so every retry re-attempts A itself.
        const resPromise = post("/openai-chat/v1/chat/completions", { model: "onlyA", messages: [], stream: true });
        await vi.advanceTimersByTimeAsync(300_001); // attempt 1 → stall retry 1
        await vi.advanceTimersByTimeAsync(300_001); // attempt 2 → stall retry 2
        await vi.advanceTimersByTimeAsync(300_001); // attempt 3 → retries exhausted
        const res = await resPromise;
        expect(res.status).toBe(504);
        const j = (await res.json()) as { error: { message: string } };
        expect(j.error.message).toContain("stalled");
        expect(j.error.message).toContain("retries exhausted");
        expect(mock.calls.filter((c) => c.url.includes("/a/")).length).toBe(3); // 1 + 2 retries, no more
      } finally {
        vi.useRealTimers();
      }
    });

    it("logs a 499 row without circuit impact when the client cancels mid-stream", async () => {
      mock = mockFetch([
        { match: "/a/v1/messages", response: { status: 200, bodyStream: stallingStream(), headers: sseHeaders } },
      ]);
      const res = await post("/anthropic/v1/messages", { model: "m", messages: [], stream: true });
      expect(res.status).toBe(200);
      // What the server runtime does when the client hangs up mid-response.
      await res.body!.cancel();
      const call = store.getLogs().find((e) => e.model === "m" && !e.kind);
      expect(call?.status).toBe(499);
      expect(call?.error).toContain("client aborted");
      // Not the provider's fault: no cooling, no failure-net capture.
      expect(store.isCooling("prv_A")).toBe(false);
      expect(store.circuitState().find((x) => x.id === "prv_A")?.fails).toBe(0);
      expect(store.getFailCaptures("m")).toEqual([]);
    });
  });

  describe("usage capture", () => {
    const sseH = { "content-type": "text/event-stream" };
    const find = () => store.getLogs().find((e) => e.model === "m" && !e.kind);

    it("asks OpenAI chat streams to include upstream usage", async () => {
      const sse = sseBody([
        'data: {"choices":[{"delta":{"content":"hi"}}]}',
        "",
        'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3}}',
        "",
        "data: [DONE]",
        "",
      ]);
      mock = mockFetch([{ match: "/a/v1/chat/completions", response: { status: 200, bodyStream: sse, headers: sseH } }]);
      await (
        await post("/openai-chat/v1/chat/completions", {
          model: "m",
          messages: [],
          stream: true,
          stream_options: { include_usage: false },
        })
      ).text();
      const forwarded = JSON.parse(mock.calls[0].body as string) as { stream_options?: { include_usage?: boolean } };
      expect(forwarded.stream_options).toEqual({ include_usage: true });
    });

    it("anthropic stream: merges message_start input/cache + message_delta output (exact)", async () => {
      const sse = sseBody([
        "event: message_start",
        'data: {"type":"message_start","message":{"usage":{"input_tokens":42,"cache_read_input_tokens":10,"cache_creation_input_tokens":2}}}',
        "",
        'event: content_block_delta',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}',
        "",
        "event: message_delta",
        'data: {"type":"message_delta","usage":{"output_tokens":7}}',
        "",
        "event: message_stop",
        'data: {"type":"message_stop"}',
        "",
      ]);
      mock = mockFetch([{ match: "/a/v1/messages", response: { status: 200, bodyStream: sse, headers: sseH } }]);
      await (await post("/anthropic/v1/messages", { model: "m", messages: [], stream: true })).text();
      expect(find()?.usage).toEqual({ input: 42, output: 7, cacheRead: 10, cacheCreation: 2 });
    });

    it("openai chat stream WITHOUT usage: falls back to a local estimate (estimated:true)", async () => {
      const sse = sseBody([
        'data: {"choices":[{"delta":{"content":"hello world"}}]}',
        "",
        "data: [DONE]",
        "",
      ]);
      mock = mockFetch([{ match: "/a/v1/chat/completions", response: { status: 200, bodyStream: sse, headers: sseH } }]);
      await (
        await post("/openai-chat/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi there" }], stream: true })
      ).text();
      const u = find()?.usage;
      expect(u?.estimated).toBe(true);
      expect(u?.output).toBeGreaterThan(0); // tokens for "hello world"
      expect(u?.input).toBeGreaterThan(0); // tokens for the request message
    });

    it("openai chat stream WITH usage (include_usage): records exact upstream usage", async () => {
      const sse = sseBody([
        'data: {"choices":[{"delta":{"content":"hi"}}]}',
        "",
        'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3}}',
        "",
        "data: [DONE]",
        "",
      ]);
      mock = mockFetch([{ match: "/a/v1/chat/completions", response: { status: 200, bodyStream: sse, headers: sseH } }]);
      await (await post("/openai-chat/v1/chat/completions", { model: "m", messages: [], stream: true })).text();
      const u = find()?.usage;
      expect(u?.estimated).toBeUndefined();
      expect(u).toEqual({ input: 5, output: 3 });
    });

    it("openai chat stream with cached_tokens: cache hit is captured and subtracted from input", async () => {
      const sse = sseBody([
        'data: {"choices":[{"delta":{"content":"hi"}}]}',
        "",
        'data: {"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":30}}}',
        "",
        "data: [DONE]",
        "",
      ]);
      mock = mockFetch([{ match: "/a/v1/chat/completions", response: { status: 200, bodyStream: sse, headers: sseH } }]);
      await (await post("/openai-chat/v1/chat/completions", { model: "m", messages: [], stream: true })).text();
      // prompt_tokens INCLUDES the cached subset on this wire → input is the uncached remainder.
      expect(find()?.usage).toEqual({ input: 20, output: 3, cacheRead: 30 });
    });

    it("openai chat stream always exposes normalized usage before [DONE]", async () => {
      const sse = sseBody([
        'data: {"choices":[{"delta":{"content":"hi"}}]}',
        "",
        'data: {"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":3,"prompt_tokens_details":null}}',
        "",
        "data: [DONE]",
        "",
      ]);
      mock = mockFetch([{ match: "/a/v1/chat/completions", response: { status: 200, bodyStream: sse, headers: sseH } }]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [], stream: true });
      const body = await res.text();
      const usageFrames = body
        .split("\n")
        .filter((line) => line.startsWith("data: ") && line.includes('"usage"'))
        .map((line) => JSON.parse(line.slice(6)) as { usage: { prompt_tokens_details?: { cached_tokens?: number } } });
      expect(usageFrames.at(-1)?.usage).toEqual({
        prompt_tokens: 50,
        completion_tokens: 3,
        total_tokens: 53,
        prompt_tokens_details: { cached_tokens: 0 },
      });
      expect(body.indexOf("usage")).toBeLessThan(body.indexOf("[DONE]"));
    });

    it("non-streaming openai body: records exact usage", async () => {
      mock = mockFetch([
        {
          match: "/a/v1/chat/completions",
          response: { status: 200, body: { choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 11, completion_tokens: 9 } } },
        },
      ]);
      await (await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] })).text();
      expect(find()?.usage).toEqual({ input: 11, output: 9 });
    });

    it("non-streaming openai body with cached_tokens: cache hit captured, input = prompt - cached", async () => {
      mock = mockFetch([
        {
          match: "/a/v1/chat/completions",
          response: {
            status: 200,
            body: {
              choices: [{ message: { content: "hi" } }],
              usage: { prompt_tokens: 100, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 60 } },
            },
          },
        },
      ]);
      await (await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] })).text();
      expect(find()?.usage).toEqual({ input: 40, output: 9, cacheRead: 60 });
    });

    it("non-streaming openai body: DeepSeek's prompt_cache_hit_tokens spelling is captured the same way", async () => {
      mock = mockFetch([
        {
          match: "/a/v1/chat/completions",
          response: {
            status: 200,
            body: {
              choices: [{ message: { content: "hi" } }],
              usage: { prompt_tokens: 100, completion_tokens: 4, prompt_cache_hit_tokens: 60 },
            },
          },
        },
      ]);
      await (await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] })).text();
      expect(find()?.usage).toEqual({ input: 40, output: 4, cacheRead: 60 });
    });

    it("non-streaming openai null usage details are normalized to cached_tokens", async () => {
      mock = mockFetch([
        {
          match: "/a/v1/chat/completions",
          response: {
            status: 200,
            body: {
              choices: [{ message: { content: "hi" } }],
              usage: { prompt_tokens: 997, completion_tokens: 30, prompt_tokens_details: null },
            },
          },
        },
      ]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] });
      expect(await json<ChatBody>(res)).toMatchObject({
        choices: [{ message: { content: "hi" } }],
        usage: {
          prompt_tokens: 997,
          completion_tokens: 30,
          total_tokens: 1027,
          prompt_tokens_details: { cached_tokens: 0 },
        },
      });
    });

    it("non-streaming anthropic body: records exact usage incl. cache", async () => {
      mock = mockFetch([
        {
          match: "/a/v1/messages",
          response: {
            status: 200,
            body: { type: "message", usage: { input_tokens: 6, output_tokens: 2, cache_read_input_tokens: 1 } },
          },
        },
      ]);
      await (await post("/anthropic/v1/messages", { model: "m", messages: [] })).text();
      expect(find()?.usage).toEqual({ input: 6, output: 2, cacheRead: 1 });
    });

    it("non-streaming bodies always expose usage even when upstream omits it", async () => {
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "hi" } }] } } },
        { match: "/a/v1/responses", response: { status: 200, body: { id: "resp" } } },
        { match: "/a/v1/messages", response: { status: 200, body: { type: "message" } } },
      ]);
      const openai = await json<{ usage: Record<string, unknown> }>(
        await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] }),
      );
      const responses = await json<{ usage: Record<string, unknown> }>(
        await post("/openai-responses/v1/responses", { model: "m", input: "x" }),
      );
      const anthropic = await json<{ usage: Record<string, unknown> }>(
        await post("/anthropic/v1/messages", { model: "m", messages: [] }),
      );
      expect(openai.usage).toEqual({
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        prompt_tokens_details: { cached_tokens: 0 },
      });
      expect(responses.usage).toEqual({
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        input_tokens_details: { cached_tokens: 0 },
      });
      expect(anthropic.usage).toEqual({
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      });
    });

    it("responses stream: records usage from response.completed (exact)", async () => {
      const sse = sseBody([
        "event: response.created",
        'data: {"type":"response.created"}',
        "",
        "event: response.completed",
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":8,"output_tokens":4}}}',
        "",
      ]);
      mock = mockFetch([{ match: "/a/v1/responses", response: { status: 200, bodyStream: sse, headers: sseH } }]);
      await (await post("/openai-responses/v1/responses", { model: "m", input: "x", stream: true })).text();
      expect(find()?.usage).toEqual({ input: 8, output: 4 });
    });

    it("responses stream exposes a gateway usage event", async () => {
      const sse = sseBody([
        "event: response.completed",
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":8,"output_tokens":4}}}',
        "",
      ]);
      mock = mockFetch([{ match: "/a/v1/responses", response: { status: 200, bodyStream: sse, headers: sseH } }]);
      const res = await post("/openai-responses/v1/responses", { model: "m", input: "x", stream: true });
      const body = await res.text();
      expect(body).toContain('event: myapikey.usage');
      expect(body).toContain('"input_tokens_details":{"cached_tokens":0}');
      expect(body.indexOf("myapikey.usage")).toBeLessThan(body.indexOf("response.completed"));
    });

    it("anthropic stream exposes a gateway usage event", async () => {
      const sse = sseBody([
        "event: message_start",
        'data: {"type":"message_start","message":{"usage":{"input_tokens":6,"cache_read_input_tokens":2}}}',
        "",
        "event: message_delta",
        'data: {"type":"message_delta","usage":{"output_tokens":4}}',
        "",
        "event: message_stop",
        'data: {"type":"message_stop"}',
        "",
      ]);
      mock = mockFetch([{ match: "/a/v1/messages", response: { status: 200, bodyStream: sse, headers: sseH } }]);
      const res = await post("/anthropic/v1/messages", { model: "m", messages: [], stream: true });
      const body = await res.text();
      expect(body).toContain('event: myapikey.usage');
      expect(body).toContain('"cache_read_input_tokens":2');
      expect(body.indexOf("myapikey.usage")).toBeLessThan(body.indexOf("message_stop"));
    });

    it("responses stream with input_tokens_details.cached_tokens: cache hit captured, input = input - cached", async () => {
      const sse = sseBody([
        "event: response.completed",
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":80,"output_tokens":4,"input_tokens_details":{"cached_tokens":50}}}}',
        "",
      ]);
      mock = mockFetch([{ match: "/a/v1/responses", response: { status: 200, bodyStream: sse, headers: sseH } }]);
      await (await post("/openai-responses/v1/responses", { model: "m", input: "x", stream: true })).text();
      expect(find()?.usage).toEqual({ input: 30, output: 4, cacheRead: 50 });
    });

    it("anthropic stream with NO usage events records nothing (no estimate for this wire)", async () => {
      const sse = sseBody([
        "event: message_start",
        'data: {"type":"message_start"}',
        "",
        "event: message_stop",
        'data: {"type":"message_stop"}',
        "",
      ]);
      mock = mockFetch([{ match: "/a/v1/messages", response: { status: 200, bodyStream: sse, headers: sseH } }]);
      const res = await post("/anthropic/v1/messages", { model: "m", messages: [], stream: true });
      const body = await res.text();
      expect(find()?.usage).toBeUndefined();
      expect(body).toContain('event: myapikey.usage');
      expect(body).toContain('"input_tokens":0');
    });
  });

  describe("dispatch debug capture", () => {
    it("captures the exact forwarded body + the upstream response on success", async () => {
      await seedStore(store, { models: { m: makeModel({ openai: fe(["prv_A"]), debugCapture: true }) } });
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "hi" } }] } } },
      ]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }], max_tokens: 5 });
      expect(res.status).toBe(200);
      await json<ChatBody>(res); // consume → the body's settle callback runs → the capture lands
      const caps = store.getCaptures("m");
      expect(caps).toHaveLength(1);
      const c = caps[0];
      expect(c.provider).toBe("A");
      expect(c.providerId).toBe("prv_A");
      expect(c.status).toBe(200);
      expect(c.format).toBe("openai");
      expect(c.stream).toBe(false);
      expect(c.ms).toBeGreaterThanOrEqual(0);
      expect(JSON.parse(c.request)).toMatchObject({ model: "m", max_tokens: 5 });
      expect(JSON.parse(c.response!)).toEqual({ choices: [{ message: { content: "hi" } }] });
      expect(c.truncated).toBeUndefined();
      expect(c.error).toBeUndefined();
    });

    it("records one entry per failover attempt, each with its own upstream body", async () => {
      await seedStore(store, {
        models: { m: makeModel({ openai: fe([{ id: "prv_A", model: "up-a", thinking: "high" }, "prv_B"]), debugCapture: true }) },
      });
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 500, body: { error: { message: "down" } } } },
        { match: "/b/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "ok" } }] } } },
      ]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] });
      expect(res.status).toBe(200);
      await json<ChatBody>(res);
      const caps = store.getCaptures("m"); // newest first
      expect(caps).toHaveLength(2);
      // Newest = the successful B attempt (public name, no thinking override).
      expect(caps[0]).toMatchObject({ provider: "B", status: 200 });
      expect(JSON.parse(caps[0].request).model).toBe("m");
      expect(caps[0].upstreamModel).toBeUndefined();
      // Oldest = the failed A attempt: rewritten model + injected thinking + the error body.
      expect(caps[1]).toMatchObject({ provider: "A", status: 500, upstreamModel: "up-a", thinking: { value: "high", from: "default" }, error: "down" });
      const reqA = JSON.parse(caps[1].request);
      expect(reqA.model).toBe("up-a");
      expect(reqA.reasoning_effort).toBe("high");
      expect(JSON.parse(caps[1].response!)).toEqual({ error: { message: "down" } });
    });

    it("captures a streaming response as the SSE text it actually flowed", async () => {
      await seedStore(store, { models: { m: makeModel({ openai: fe(["prv_A"]), debugCapture: true }) } });
      mock = mockFetch([
        {
          match: "/a/v1/chat/completions",
          response: {
            status: 200,
            headers: { "content-type": "text/event-stream" },
            bodyStream: sseBody(["data: {\"choices\":[{\"delta\":{\"content\":\"hel\"}}]}", "", "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}", "", "data: [DONE]", ""]),
          },
        },
      ]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [], stream: true });
      expect(res.status).toBe(200);
      await res.text();
      const c = store.getCaptures("m")[0];
      expect(c.stream).toBe(true);
      expect(c.status).toBe(200);
      expect(c.response).toContain("\"content\":\"hel\"");
      expect(c.response).toContain("[DONE]");
    });

    it("records a network error as status 0 with no response body", async () => {
      await seedStore(store, { models: { m: makeModel({ openai: fe(["prv_A"]), debugCapture: true }) } });
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: () => { throw new Error("dns broke"); } },
      ]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] });
      // No other slot in the chain → the client sees the usual 502, while the
      // capture still records what this attempt actually did (status 0). The
      // underlying error message is kept — "network error" alone is how an
      // upstream cut became indistinguishable from any other failure.
      expect(res.status).toBe(502);
      const c = store.getCaptures("m")[0];
      expect(c.provider).toBe("A");
      expect(c.status).toBe(0);
      expect(c.error).toContain("network error");
      expect(c.error).toContain("dns broke");
      expect(c.response).toBeUndefined();
    });

    it("keeps undici's real cause (e.cause) in the network-error message", async () => {
      await seedStore(store, { models: { m: makeModel({ openai: fe(["prv_A"]), debugCapture: true }) } });
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: () => { throw new Error("fetch failed", { cause: new Error("ECONNRESET") }); } },
      ]);
      await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] });
      const c = store.getCaptures("m")[0];
      // undici wraps every socket-level failure as "fetch failed" and buries
      // the reason in cause — surface it, or an upstream reset is unjudgable.
      expect(c.error).toContain("fetch failed");
      expect(c.error).toContain("ECONNRESET");
    });

    it("flags truncation when a response exceeds the capture cap", async () => {
      await seedStore(store, { models: { m: makeModel({ openai: fe(["prv_A"]), debugCapture: true }) } });
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 200, body: "x".repeat(CAPTURE_BODY_MAX + 1000) } },
      ]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] });
      await res.text();
      const c = store.getCaptures("m")[0];
      expect(c.truncated).toBe(true);
      expect(c.response).toHaveLength(CAPTURE_BODY_MAX);
    });

    it("captures nothing when the model's switch is off (successful calls)", async () => {
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "hi" } }] } } },
      ]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] });
      expect(res.status).toBe(200);
      await json<ChatBody>(res);
      expect(store.getCaptures("m")).toEqual([]);
      expect(store.getFailCaptures("m")).toEqual([]);
    });

    it("captures nothing for UI probes (not real conversations)", async () => {
      await seedStore(store, { models: { m: makeModel({ openai: fe(["prv_A"]), debugCapture: true }) } });
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "hi" } }] } } },
      ]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] }, { "x-myapikey-probe": "1" });
      expect(res.status).toBe(200);
      await json<ChatBody>(res);
      expect(store.getCaptures("m")).toEqual([]);
    });

    it("captures a FAILED attempt even when the switch was never on (the safety net)", async () => {
      // The whole point of the net: the error happens first, the user opens the
      // dialog after — and the bodies are still there.
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 500, body: { error: { message: "boom" } } } },
        { match: "/b/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "ok" } }] } } },
      ]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "later" }] });
      expect(res.status).toBe(200);
      await json<ChatBody>(res);
      expect(store.getCaptures("m")).toEqual([]); // switch off → no switch buffer
      const fails = store.getFailCaptures("m");
      expect(fails).toHaveLength(1);
      expect(fails[0]).toMatchObject({ provider: "A", status: 500, error: "boom" });
      expect(JSON.parse(fails[0].request)).toMatchObject({ model: "m", messages: [{ role: "user", content: "later" }] });
      expect(JSON.parse(fails[0].response!)).toEqual({ error: { message: "boom" } });
      // The succeeding attempt on B was a success → net untouched by it.
      expect(fails[0].providerId).toBe("prv_A");
    });

    it("a failure made with the switch on lands in the net only once per attempt", async () => {
      await seedStore(store, { models: { m: makeModel({ openai: fe(["prv_A"]), debugCapture: true }) } });
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 429, body: { error: { message: "slow down" } } } },
      ]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] });
      // 429 is retryable and A is the only slot → the client gets the usual
      // collapsed 502; the capture row records the real upstream status.
      expect(res.status).toBe(502);
      await res.text();
      expect(store.getFailCaptures("m")).toHaveLength(1);
      expect(store.getFailCaptures("m")[0]).toMatchObject({ provider: "A", status: 429, error: "slow down" });
      expect(store.getCaptures("m")).toHaveLength(1);
    });
  });

  describe("GET /openai-chat/v1/models", () => {
    it("lists only openai-enabled models, owned by each model's first provider", async () => {
      const res = await createApp(store).request("/openai-chat/v1/models", {
        headers: { authorization: "Bearer " + store.get().apiKey },
      });
      expect(res.status).toBe(200);
      const j = await json<{ object: string; data: { id: string; owned_by: string }[] }>(res);
      expect(j.object).toBe("list");
      const ids = j.data.map((d: { id: string }) => d.id).sort();
      expect(ids).toEqual(["m", "onlyA"]);
      for (const d of j.data) expect(d.owned_by).toBe("A");
    });

    it("requires an api key", async () => {
      const res = await createApp(store).request("/openai-chat/v1/models");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /openai-responses/v1/models", () => {
    // The responses surface narrows to models routable ON it: onlyA has openai
    // slots but no responses chain, so it's absent here even though it shows on
    // /openai-chat/v1/models.
    it("lists only models with a responses chain on a supportsResponses source", async () => {
      const res = await createApp(store).request("/openai-responses/v1/models", {
        headers: { authorization: "Bearer " + store.get().apiKey },
      });
      expect(res.status).toBe(200);
      const j = await json<{ object: string; data: { id: string; owned_by: string }[] }>(res);
      expect(j.object).toBe("list");
      expect(j.data.map((d: { id: string }) => d.id)).toEqual(["m"]);
      expect(j.data[0].owned_by).toBe("A");
    });

    it("requires an api key", async () => {
      const res = await createApp(store).request("/openai-responses/v1/models");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /anthropic/v1/models", () => {
    // The whole point of the dual surface: an Anthropic client discovers its
    // own models, which the old shared /v1/models couldn't list. onlyA has no
    // anthropic slot, so it's absent here. And the list answers in ANTHROPIC's
    // own shape (data[].{id,display_name,type} + first_id/last_id/has_more),
    // not OpenAI's {object:"list"}.
    it("lists only anthropic-enabled models, in the anthropic list shape", async () => {
      const res = await createApp(store).request("/anthropic/v1/models", {
        headers: { authorization: "Bearer " + store.get().apiKey },
      });
      expect(res.status).toBe(200);
      const j = await json<{ data: { id: string; display_name: string; type: string }[]; first_id: string | null; last_id: string | null; has_more: boolean }>(res);
      expect(j.data.map((d: { id: string }) => d.id)).toEqual(["m"]);
      expect(j.data[0]).toMatchObject({ id: "m", display_name: "m", type: "model" });
      expect(j.first_id).toBe("m");
      expect(j.last_id).toBe("m");
      expect(j.has_more).toBe(false);
    });

    it("requires an api key", async () => {
      const res = await createApp(store).request("/anthropic/v1/models");
      expect(res.status).toBe(401);
    });
  });

  describe("probe header", () => {
    it("tags the response with x-myapikey-provider when probe=1", async () => {
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { body: { choices: [{ message: { content: "hi" } }] } } },
      ]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] }, { "x-myapikey-probe": "1" });
      expect(res.headers.get("x-myapikey-provider")).toBe("A");
    });

    it("omits the header for a normal (non-probe) client", async () => {
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { body: { choices: [{ message: { content: "hi" } }] } } },
      ]);
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] });
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
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] }, {
        "x-myapikey-probe": "1",
        "x-myapikey-probe-slot": "1",
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
      const res = await post("/openai-chat/v1/chat/completions", { model: "m", messages: [] }, {
        "x-myapikey-probe": "1",
        "x-myapikey-probe-slot": "1",
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
      // onlyA routes solely to A (one slot, index 0); pinning index 1 is out of
      // range → empty list → 404 model_not_found with no fetch.
      const res = await post("/openai-chat/v1/chat/completions", { model: "onlyA", messages: [] }, {
        "x-myapikey-probe": "1",
        "x-myapikey-probe-slot": "1",
      });
      expect(res.status).toBe(404);
      expect(mock.calls.length).toBe(0);
    });
  });

  // --- System One surface (/v1/systemone) -------------------------------------
  // The TypeSafe System One protocol: a verbatim-body POST of {model, state,
  // questions}, answered by a one-shot structured JSON body. No streaming, no
  // thinking/sampling switches — but full failover/circuit/logging via dispatch.
  describe("systemone surface", () => {
    const SYSONE_UPSTREAM = {
      model: "jev-1.13.0",
      answers: { is_urgent: { type: "noul", noul: 1 } },
      usage: { input_tokens: 392, output_tokens: 65 },
    };
    const sysBody = {
      model: "m",
      state: "ping",
      questions: { ok: { type: "noul", instructions: "The state is a health-check ping" } },
    };

    it("forwards the body verbatim to the source's /systemone endpoint and returns the answer as-is", async () => {
      mock = mockFetch([
        { match: "/a/v1/systemone", response: { body: SYSONE_UPSTREAM } },
      ]);
      const res = await post("/v1/systemone", sysBody);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(SYSONE_UPSTREAM);
      const call = mock.calls[0];
      expect(call.url).toBe("https://up.test/a/v1/systemone");
      expect(call.headers.authorization).toBe("Bearer sk-up-test");
      expect(call.headers["content-type"]).toBe("application/json");
      // The System One body passes through untouched (no chat fields added).
      expect(JSON.parse(call.body)).toEqual(sysBody);
      // Usage is captured on the log row (exact upstream-reported counts).
      const log = store.getLogs().at(-1);
      expect(log?.status).toBe(200);
      expect(log?.format).toBe("systemone");
      expect(log?.usage).toEqual({ input: 392, output: 65 });
    });

    it("observes a stream:true request as one non-streaming JSON body", async () => {
      mock = mockFetch([
        { match: "/a/v1/systemone", response: { body: SYSONE_UPSTREAM } },
      ]);
      const res = await post("/v1/systemone", { ...sysBody, stream: true });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(SYSONE_UPSTREAM);
      const log = store.getLogs().at(-1);
      expect(log?.stream).toBe(false);
    });

    it("does not inject thinking/sampling switches into a systemone body", async () => {
      await seedStore(store, {
        providers: [A, B],
        models: { m: makeModel({ systemone: fe([{ id: "prv_A", thinking: "high", sampling: { temperature: 0.2 } }]) }) },
      });
      mock = mockFetch([
        { match: "/a/v1/systemone", response: { body: SYSONE_UPSTREAM } },
      ]);
      const res = await post("/v1/systemone", sysBody);
      expect(res.status).toBe(200);
      // The forwarded body carries none of the chat-family switches the slot's
      // defaults would inject on the other wires.
      expect(JSON.parse(mock.calls[0].body)).toEqual(sysBody);
    });

    it("fails over to the next slot on a retryable upstream status", async () => {
      mock = mockFetch([
        { match: "/a/v1/systemone", response: { status: 500, body: { error: { message: "boom" } } } },
        { match: "/b/v1/systemone", response: { body: SYSONE_UPSTREAM } },
      ]);
      const res = await post("/v1/systemone", sysBody);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(SYSONE_UPSTREAM);
      expect(mock.calls.map((c) => c.url)).toEqual([
        "https://up.test/a/v1/systemone",
        "https://up.test/b/v1/systemone",
      ]);
    });

    it("404s for a model not enabled on the systemone route (no upstream hit)", async () => {
      mock = mockFetch([]);
      const res = await post("/v1/systemone", { ...sysBody, model: "onlyA" });
      expect(res.status).toBe(404);
      expect(mock.calls.length).toBe(0);
    });

    it("lists only systemone-enabled models, behind the gateway key", async () => {
      const app = createApp(store);
      const unauthed = await app.request("/v1/systemone/models");
      expect(unauthed.status).toBe(401);
      const res = await app.request("/v1/systemone/models", {
        headers: { authorization: "Bearer " + store.get().apiKey },
      });
      expect(res.status).toBe(200);
      const j = (await res.json()) as { object: string; data: { id: string }[] };
      expect(j.object).toBe("list");
      expect(j.data.map((m) => m.id).sort()).toEqual(["m"]);
    });
  });
});
