import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpStore } from "../helpers/store";
import { seedStore, makeModel } from "../helpers/fixtures";
import { CAPTURE_MAX, CAPTURE_BODY_MAX, type Store } from "../../src/server/store";
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

  it("pushCapture is a silent no-op when the switch is off", () => {
    store.pushCapture("off", cap());
    expect(store.getCaptures("off")).toEqual([]);
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
