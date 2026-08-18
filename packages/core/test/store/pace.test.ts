import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpStore } from "../helpers/store";
import type { Store } from "../../src/server/store";

describe("store even pacing (paceClaim)", () => {
  let store: Store;
  let cleanup: () => void;

  beforeEach(() => {
    const t = tmpStore();
    store = t.store;
    cleanup = t.cleanup;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("first claim is immediate, later claims space by 60/rpm", () => {
    expect(store.paceClaim("m", 10)).toBe(0); // 6s interval
    expect(store.paceClaim("m", 10)).toBe(6000);
    expect(store.paceClaim("m", 10)).toBe(12000);
  });

  it("rejects past the 60s wait horizon without consuming a slot", () => {
    // rpm=10 -> 6s slots. 11 claims cover 0..60s (the horizon is inclusive);
    // the 12th slot would be 66s out.
    for (let i = 0; i < 11; i++) store.paceClaim("m", 10);
    expect(store.paceClaim("m", 10)).toBe(-1);
    // The rejection must not push the queue back: advance 65s and the next
    // claim lands on the pre-reserved 66s slot (1s out), not later.
    vi.setSystemTime(Date.now() + 65_000);
    expect(store.paceClaim("m", 10)).toBe(1000);
  });

  it("an idle period resets the queue (stale slot clamps to now)", () => {
    expect(store.paceClaim("m", 10)).toBe(0);
    vi.setSystemTime(Date.now() + 120_000); // far past the +6s slot
    expect(store.paceClaim("m", 10)).toBe(0);
  });

  it("queues are independent per model", () => {
    expect(store.paceClaim("a", 10)).toBe(0);
    expect(store.paceClaim("b", 10)).toBe(0); // other model, no interference
    expect(store.paceClaim("a", 10)).toBe(6000);
  });
});
