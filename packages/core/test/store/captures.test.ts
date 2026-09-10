import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpStore } from "../helpers/store";
import { seedStore, makeModel } from "../helpers/fixtures";
import { CAPTURE_MAX, CAPTURE_FAIL_MAX, CAPTURE_BODY_MAX, type Store } from "../../src/server/store";
import type { DebugCapture } from "../../src/shared/types";

describe("store/debug captures", () => {
  let store: Store;
  let cleanup: () => void;

  beforeEach(async () => {
    const t = tmpStore();
    store = t.store;
    cleanup = t.cleanup;
    await seedStore(store, {
      models: { m: makeModel({ debugCapture: true }), off: makeModel() },
    });
  });
  afterEach(() => cleanup());

  const cap = (over: Partial<DebugCapture> = {}): DebugCapture => ({
    ts: 1000,
    model: "m",
    provider: "p",
    providerId: "prv_1",
    format: "openai",
    status: 200,
    ms: 10,
    stream: false,
    request: "{}",
    ...over,
  });

  it("isDebug mirrors the model's persisted config flag", () => {
    expect(store.isDebug("m")).toBe(true);
    expect(store.isDebug("off")).toBe(false);
    expect(store.isDebug("nope")).toBe(false);
  });

  it("keeps only the newest CAPTURE_MAX entries (ring buffer)", () => {
    for (let i = 0; i < CAPTURE_MAX + 2; i++) {
      store.pushCapture("m", cap({ ts: i, request: `{"i":${i}}` }));
    }
    const caps = store.getCaptures("m");
    expect(caps).toHaveLength(CAPTURE_MAX);
    // Oldest two were dropped; the newest is first.
    expect(caps[0].ts).toBe(CAPTURE_MAX + 1);
    expect(caps[caps.length - 1].ts).toBe(2);
  });

  it("getCaptures returns a copy, newest first", () => {
    store.pushCapture("m", cap({ ts: 1 }));
    store.pushCapture("m", cap({ ts: 2 }));
    const caps = store.getCaptures("m");
    expect(caps.map((c) => c.ts)).toEqual([2, 1]);
    caps.push(cap({ ts: 3 }));
    expect(store.getCaptures("m")).toHaveLength(2);
  });

  it("pushCapture drops successful calls when the switch is off", () => {
    store.pushCapture("off", cap());
    expect(store.getCaptures("off")).toEqual([]);
    expect(store.getFailCaptures("off")).toEqual([]);
  });

  it("records failed attempts in the global net EVEN when the switch is off", () => {
    store.pushCapture("off", cap({ status: 500, request: '{"q":1}', response: '{"error":"x"}' }));
    expect(store.getCaptures("off")).toEqual([]); // switch buffer untouched
    const fails = store.getFailCaptures("off");
    expect(fails).toHaveLength(1);
    expect(fails[0]).toMatchObject({ status: 500, request: '{"q":1}', response: '{"error":"x"}' });
  });

  it("routes a network error (status 0) to the net as a failure", () => {
    store.pushCapture("off", cap({ status: 0, error: "network error" }));
    expect(store.getFailCaptures("off")).toHaveLength(1);
  });

  it("with the switch on, a failure lands in BOTH buffers; a success only in the model's", () => {
    store.pushCapture("m", cap({ status: 500 }));
    store.pushCapture("m", cap({ status: 200 }));
    expect(store.getCaptures("m").map((c) => c.status)).toEqual([200, 500]);
    expect(store.getFailCaptures("m").map((c) => c.status)).toEqual([500]);
  });

  it("the net is a GLOBAL ring capped at CAPTURE_FAIL_MAX across models", () => {
    for (let i = 0; i < CAPTURE_FAIL_MAX + 2; i++) {
      store.pushCapture(i % 2 ? "m" : "off", cap({ ts: i, status: 500 }));
    }
    expect(store.getFailCaptures("m").length + store.getFailCaptures("off").length).toBe(CAPTURE_FAIL_MAX);
    // Oldest dropped (ts 0/1 gone), newest first per model.
    expect(store.getFailCaptures("m")[0].ts).toBe(CAPTURE_FAIL_MAX + 1);
  });

  it("clearFailCaptures scrubs only that model's net entries", () => {
    store.pushCapture("m", cap({ status: 500 }));
    store.pushCapture("off", cap({ status: 502 }));
    store.clearFailCaptures("m");
    expect(store.getFailCaptures("m")).toEqual([]);
    expect(store.getFailCaptures("off")).toHaveLength(1);
  });

  it("clearCaptures (toggle-off) leaves the failure net intact", () => {
    store.pushCapture("m", cap({ status: 500 }));
    store.clearCaptures("m");
    expect(store.getCaptures("m")).toEqual([]);
    expect(store.getFailCaptures("m")).toHaveLength(1);
  });

  it("clearCaptures drops the buffer", () => {
    store.pushCapture("m", cap());
    store.clearCaptures("m");
    expect(store.getCaptures("m")).toEqual([]);
  });

  it("truncates oversized bodies at CAPTURE_BODY_MAX and flags it", () => {
    const big = "x".repeat(CAPTURE_BODY_MAX + 100);
    store.pushCapture("m", cap({ request: big, response: big }));
    const c = store.getCaptures("m")[0];
    expect(c.request).toHaveLength(CAPTURE_BODY_MAX);
    expect(c.response).toHaveLength(CAPTURE_BODY_MAX);
    expect(c.truncated).toBe(true);
  });

  it("does not flag truncation for small bodies", () => {
    store.pushCapture("m", cap());
    expect(store.getCaptures("m")[0].truncated).toBeUndefined();
  });
});
