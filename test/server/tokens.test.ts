import { describe, it, expect } from "vitest";
import { UsageCollector, countTokens } from "../../src/server/tokens";
import type { Usage } from "../../src/shared/types";

describe("tokens/UsageCollector", () => {
  it("reassembles a usage payload split across two chunks", () => {
    const c = new UsageCollector();
    c.feed('event: message_start\ndata: {"type":"messag', { stream: true, key: "anthropic" });
    c.feed('e_start","message":{"usage":{"input_tokens":9}}}\n\n', { stream: true, key: "anthropic" });
    c.feed('event: message_stop\ndata: {"type":"message_stop"}\n\n', { stream: true, key: "anthropic" });
    expect(c.finalize({ stream: true, key: "anthropic" })).toEqual({ input: 9, output: 0 });
  });

  it("openai chat stream without usage → local estimate flagged estimated", () => {
    const c = new UsageCollector();
    c.feed('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n', { stream: true, key: "openai" });
    c.feed("data: [DONE]\n\n", { stream: true, key: "openai" });
    const u = c.finalize({ stream: true, key: "openai", requestMessages: [{ role: "user", content: "ping" }] }) as Usage;
    expect(u.estimated).toBe(true);
    expect(u.output).toBeGreaterThan(0);
    expect(u.input).toBeGreaterThan(0);
  });

  it("openai chat stream with usage → exact, not estimated", () => {
    const c = new UsageCollector();
    c.feed('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', { stream: true, key: "openai" });
    c.feed('data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\n', { stream: true, key: "openai" });
    c.feed("data: [DONE]\n\n", { stream: true, key: "openai" });
    expect(c.finalize({ stream: true, key: "openai" })).toEqual({ input: 4, output: 2 });
  });

  it("non-streaming body is parsed once at finalize", () => {
    const c = new UsageCollector();
    c.feed('{"choices":[],"u', { stream: false, key: "openai" });
    c.feed('sage":{"prompt_tokens":3,"completion_tokens":1}}', { stream: false, key: "openai" });
    expect(c.finalize({ stream: false, key: "openai" })).toEqual({ input: 3, output: 1 });
  });

  it("responses usage accepts the bare input/output spelling too", () => {
    const c = new UsageCollector();
    c.feed(
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input":8,"output":4}}}\n\n',
      { stream: true, key: "responses" },
    );
    expect(c.finalize({ stream: true, key: "responses" })).toEqual({ input: 8, output: 4 });
  });

  it("returns undefined when no usage and not the openai-chat fallback", () => {
    const c = new UsageCollector();
    c.feed('event: message_start\ndata: {"type":"message_start"}\n\n', { stream: true, key: "anthropic" });
    c.feed('event: message_stop\ndata: {"type":"message_stop"}\n\n', { stream: true, key: "anthropic" });
    expect(c.finalize({ stream: true, key: "anthropic" })).toBeUndefined();
  });
});

describe("tokens/countTokens", () => {
  it("counts a non-empty string as ≥1 token and 0 for empty", () => {
    expect(countTokens("")).toBe(0);
    expect(countTokens("hello world")).toBeGreaterThan(0);
  });
});
