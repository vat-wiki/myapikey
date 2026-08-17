import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createApp } from "../../src/server/app";
import { shortError, anthropicAuthHeaders } from "../../src/server/proxy";
import type { Store } from "../../src/server/store";
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
      const res = await post("/openai/v1/chat/completions", { messages: [] });
      expect(res.status).toBe(400);
      expect((await json<{ error: { type: string } }>(res)).error.type).toBe("invalid_request_error");
    });

    it("400 on non-JSON body", async () => {
      const res = await post("/openai/v1/chat/completions", "not json{");
      expect(res.status).toBe(400);
      expect((await json<{ error: { type: string } }>(res)).error.type).toBe("invalid_request_error");
    });

    it("404 model_not_found for an unknown model", async () => {
      const res = await post("/openai/v1/chat/completions", { model: "nope", messages: [] });
      expect(res.status).toBe(404);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe("model_not_found");
    });

    it("passes a 200 upstream body through, logs the call, and hides the provider", async () => {
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "hi" } }] } } },
      ]);
      const res = await post("/openai/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi" }] });
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
      await post("/openai/v1/chat/completions", { model: "m", messages: [] });
      expect(mock.calls[0].url).toBe("https://up.test/a/v1/chat/completions");
    });

    it("maps the responses URL onto the OpenAI base", async () => {
      mock = mockFetch([{ match: "/a/v1/responses", response: { body: { ok: true } } }]);
      await post("/openai/v1/responses", { model: "m", input: "x" });
      expect(mock.calls[0].url).toBe("https://up.test/a/v1/responses");
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
      const res = await post("/openai/v1/chat/completions", { model: "m", messages: [] });
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
      const res = await post("/openai/v1/chat/completions", { model: "m", messages: [] });
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
        const res = await post("/openai/v1/chat/completions", { model: "m", messages: [] });
        expect(res.status).toBe(200);
        expect(mock.calls.filter((c) => c.url.includes("/b/")).length).toBe(1);
      }
    });

    it("fails over when fetch throws (network error path)", async () => {
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: () => { throw new Error("net"); } },
        { match: "/b/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "B" } }] } } },
      ]);
      const res = await post("/openai/v1/chat/completions", { model: "m", messages: [] });
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
      const res = await post("/openai/v1/chat/completions", { model: "m", messages: [] });
      expect(res.status).toBe(400);
      expect((await json<{ error: { message: string } }>(res)).error.message).toBe("bad");
      expect(mock.calls.filter((c) => c.url.includes("/b/")).length).toBe(0);
    });

    it("returns 502 with an 'all providers … last status' message when every provider fails", async () => {
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 500, body: { error: { message: "boom" } } } },
        { match: "/b/v1/chat/completions", response: { status: 500, body: { error: { message: "boom" } } } },
      ]);
      const res = await post("/openai/v1/chat/completions", { model: "m", messages: [] });
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
      const res = await post("/openai/v1/chat/completions", { model: "m", messages: [] });
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
      const res = await post("/openai/v1/chat/completions", { model: "m", messages: [] });
      expect(res.status).toBe(200);
      expect(mock.calls.filter((c) => c.url.includes("/a/")).length).toBe(1);
    });

    it("falls back to trying anyway when EVERY source is over its cap", async () => {
      await seedStore(store, {
        providers: [{ ...A, rpm: 1 }, { ...B, rpm: 1 }],
        models: { m: makeModel({ openai: fe(["prv_A", "prv_B"]) }) },
      });
      // Both at their cap → heuristic would skip both, but the gateway falls back
      // to the full chain rather than returning a guaranteed 502.
      store.recordDispatch("prv_A");
      store.recordDispatch("prv_B");
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { status: 200, body: { choices: [{ message: { content: "from-A" } }] } } },
      ]);
      const res = await post("/openai/v1/chat/completions", { model: "m", messages: [] });
      expect(res.status).toBe(200);
      expect(mock.calls.filter((c) => c.url.includes("/a/")).length).toBe(1);
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
      const res = await post("/openai/v1/chat/completions", { model: "m", messages: [] }, { "x-myapikey-probe-slot": "0" });
      expect(res.status).toBe(200);
      expect(mock.calls.filter((c) => c.url.includes("/a/")).length).toBe(1);
      // A pinned probe takes no pacing side-effects: the window is unchanged.
      expect(store.rpmUsed("prv_A")).toBe(1);
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
      const res = await post("/openai/v1/chat/completions", { model: "m", messages: [] });
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
      const res = await post("/openai/v1/chat/completions", { model: "m", messages: [] });
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
      const res = await post("/openai/v1/chat/completions", { model: "m", messages: [] });
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
      const res = await post("/openai/v1/chat/completions", { model: "m", messages: [] });
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
      const res = await post("/openai/v1/chat/completions", { model: "m", messages: [] });
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
      const res = await post("/openai/v1/chat/completions", { model: "m", messages: [] });
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
      const res = await post("/openai/v1/chat/completions", { model: "m", messages: [] });
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
      const res = await post("/openai/v1/chat/completions", { model: "m", messages: [], stream: true });
      await res.text();
      const call = store.getLogs().find((e) => e.model === "m" && !e.kind);
      expect(call?.status).toBe(200);
    });

    it("truncated openai /chat/completions stream: logs 502 + trips circuit, injects a data:{error} frame", async () => {
      const sse = sseBody(['data: {"choices":[{"delta":{"content":"hi"}}]}', ""]); // no [DONE]
      mock = mockFetch([{ match: "/a/v1/chat/completions", response: { status: 200, bodyStream: sse, headers: sseHeaders } }]);
      const res = await post("/openai/v1/chat/completions", { model: "m", messages: [], stream: true });
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
      const res = await post("/openai/v1/responses", { model: "m", input: "x", stream: true });
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
      await (await post("/openai/v1/responses", { model: "m", input: "x", stream: true })).text();
      const call = store.getLogs().find((e) => e.model === "m" && !e.kind);
      expect(call?.status).toBe(200);
    });

    it("a /responses stream ending in response.failed is NOT truncation (upstream reported failure cleanly)", async () => {
      const sse = sseBody([
        "event: response.created", 'data: {"type":"response.created"}', "",
        "event: response.failed", 'data: {"type":"response.failed","response":{"status":"failed","error":{"message":"boom"}}}', "",
      ]);
      mock = mockFetch([{ match: "/a/v1/responses", response: { status: 200, bodyStream: sse, headers: sseHeaders } }]);
      const text = await (await post("/openai/v1/responses", { model: "m", input: "x", stream: true })).text();
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

  describe("usage capture", () => {
    const sseH = { "content-type": "text/event-stream" };
    const find = () => store.getLogs().find((e) => e.model === "m" && !e.kind);

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
        await post("/openai/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hi there" }], stream: true })
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
      await (await post("/openai/v1/chat/completions", { model: "m", messages: [], stream: true })).text();
      const u = find()?.usage;
      expect(u?.estimated).toBeUndefined();
      expect(u).toEqual({ input: 5, output: 3 });
    });

    it("non-streaming openai body: records exact usage", async () => {
      mock = mockFetch([
        {
          match: "/a/v1/chat/completions",
          response: { status: 200, body: { choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 11, completion_tokens: 9 } } },
        },
      ]);
      await (await post("/openai/v1/chat/completions", { model: "m", messages: [] })).text();
      expect(find()?.usage).toEqual({ input: 11, output: 9 });
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
      await (await post("/openai/v1/responses", { model: "m", input: "x", stream: true })).text();
      expect(find()?.usage).toEqual({ input: 8, output: 4 });
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
      await (await post("/anthropic/v1/messages", { model: "m", messages: [], stream: true })).text();
      expect(find()?.usage).toBeUndefined();
    });
  });

  describe("GET /openai/v1/models", () => {
    it("lists only openai-enabled models, owned by each model's first provider", async () => {
      const res = await createApp(store).request("/openai/v1/models", {
        headers: { authorization: "Bearer " + store.get().apiKey },
      });
      expect(res.status).toBe(200);
      const j = await json<{ object: string; data: { id: string; owned_by: string }[] }>(res);
      expect(j.object).toBe("list");
      const ids = j.data.map((d: { id: string }) => d.id).sort();
      expect(ids).toEqual(["m", "onlyA"]);
      for (const d of j.data) expect(d.owned_by).toBe("A");
    });

    it("is public — no api key required", async () => {
      const res = await createApp(store).request("/openai/v1/models");
      expect(res.status).toBe(200);
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

    it("is public — no api key required", async () => {
      const res = await createApp(store).request("/anthropic/v1/models");
      expect(res.status).toBe(200);
    });
  });

  describe("probe header", () => {
    it("tags the response with x-myapikey-provider when probe=1", async () => {
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { body: { choices: [{ message: { content: "hi" } }] } } },
      ]);
      const res = await post("/openai/v1/chat/completions", { model: "m", messages: [] }, { "x-myapikey-probe": "1" });
      expect(res.headers.get("x-myapikey-provider")).toBe("A");
    });

    it("omits the header for a normal (non-probe) client", async () => {
      mock = mockFetch([
        { match: "/a/v1/chat/completions", response: { body: { choices: [{ message: { content: "hi" } }] } } },
      ]);
      const res = await post("/openai/v1/chat/completions", { model: "m", messages: [] });
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
      const res = await post("/openai/v1/chat/completions", { model: "m", messages: [] }, {
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
      const res = await post("/openai/v1/chat/completions", { model: "m", messages: [] }, {
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
      const res = await post("/openai/v1/chat/completions", { model: "onlyA", messages: [] }, {
        "x-myapikey-probe": "1",
        "x-myapikey-probe-slot": "1",
      });
      expect(res.status).toBe(404);
      expect(mock.calls.length).toBe(0);
    });
  });
});
