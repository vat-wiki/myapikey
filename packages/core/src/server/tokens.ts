/** Token-usage capture for the proxy's stream bucket.
 *
 *  `observedBody()` in proxy.ts already wraps the upstream body in a
 *  `ReadableStream` that forwards every byte to the client VERBATIM while
 *  watching for clean termination. This module hangs a second tap off that same
 *  loop: as each decoded chunk flows past, a `UsageCollector` extracts token
 *  usage out of band. The bytes themselves are never held back or altered.
 *
 *  Strategy is HYBRID, by design (see shared/types.ts `Usage`):
 *  - UPSTREAM-REPORTED usage wins wherever the backend sends it — that's the
 *    exact billed count. Anthropic streams (message_start/message_delta), every
 *    non-streaming JSON body, and /responses (response.completed) all carry it.
 *  - OpenAI /chat/completions STREAMS usually omit usage (most agents don't set
 *    stream_options.include_usage). For THAT one wire we fall back to a local
 *    tokenizer estimate (gpt-tokenizer, o200k_base) of the request messages
 *    (prompt) + the accumulated completion text, flagged `estimated: true`. */
import { countTokens as bpeCountTokens } from "gpt-tokenizer";
import type { RouteKey, Usage } from "../shared/types";

/** Count tokens with gpt-tokenizer's default o200k_base encoding (gpt-4o /
 *  gpt-4.1 / o1 / …). Used ONLY for the OpenAI chat streaming fallback estimate;
 *  everywhere else the upstream's exact usage is used. o200k_base is a fair ≈
 *  for modern OpenAI-family models and rougher for non-OpenAI OpenAI-compatible
 *  backends (DeepSeek/Qwen/Ark) — which is why these rows are marked estimated.
 *  Never throws: a tokenizer hiccup must not break the passthrough. */
export function countTokens(text: string): number {
  if (!text) return 0;
  try {
    return bpeCountTokens(text);
  } catch {
    return 0;
  }
}

/** Rough local estimate of the PROMPT token count for an OpenAI chat request,
 *  used only on the streaming fallback path. Sums the token counts of every
 *  string `content` (and multi-part `text` blocks) across the messages array —
 *  non-text parts (images, tool I/O) are undercounted, acceptable for an
 *  estimate marked ≈. */
export function estimatePromptTokens(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;
  let n = 0;
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const content = (m as { content?: unknown }).content;
    if (typeof content === "string") {
      n += countTokens(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        const text = (part as { text?: unknown } | null)?.text;
        if (typeof text === "string") n += countTokens(text);
      }
    }
  }
  return n;
}

/** Coerce a JSON value to a finite non-negative integer, or undefined. */
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : undefined;
}

type UsageFields = Partial<Pick<Usage, "input" | "output" | "cacheRead" | "cacheCreation">>;

/** Pull whatever usage fields are present out of one parsed SSE `data:` payload
 *  (streaming) or the whole JSON body (non-streaming). The collector merges
 *  these across events per-field (last writer wins) — each protocol's terminal
 *  usage is authoritative:
 *  - anthropic: `message_start.message.usage` (input + cache) and the running
 *    `message_delta.usage.output_tokens` (output); a non-streaming Message
 *    carries `usage` directly (both).
 *  - openai chat: only the final chunk (with stream_options.include_usage) has
 *    `usage` (prompt/completion tokens); the non-streaming body has it too.
 *  - responses: `response.usage` on response.completed/in-progress, or top-level
 *    `usage` on a non-streaming Response. Accepts both the `*_tokens` and bare
 *    `input`/`output` spellings the API has used over time. */
function extractUsage(obj: any, key: RouteKey): UsageFields | null {
  if (!obj || typeof obj !== "object") return null;

  if (key === "anthropic") {
    const u = obj.message?.usage ?? obj.usage;
    if (u && (typeof u.input_tokens === "number" || typeof u.output_tokens === "number")) {
      return {
        input: num(u.input_tokens),
        output: num(u.output_tokens),
        cacheRead: num(u.cache_read_input_tokens),
        cacheCreation: num(u.cache_creation_input_tokens),
      };
    }
    return null;
  }
  if (key === "responses") {
    const u = obj.response?.usage ?? obj.usage;
    if (u) {
      const input = num(u.input_tokens) ?? num(u.input);
      const output = num(u.output_tokens) ?? num(u.output);
      if (typeof input === "number" || typeof output === "number") return { input, output };
    }
    return null;
  }
  // openai /chat/completions
  if (obj.usage) {
    return { input: num(obj.usage.prompt_tokens), output: num(obj.usage.completion_tokens) };
  }
  return null;
}

/** Accumulates usage out of the bytes flowing through the stream bucket. Feed it
 *  every decoded chunk as it passes; call `finalize` once at stream end. Bounded
 *  memory: streaming holds only the partial line currently being assembled plus
 *  (openai-chat only) the accumulated completion text — which is the assistant
 *  message itself, no larger than what the client already receives. */
export class UsageCollector {
  private partial = ""; // streaming: the in-progress line without a trailing \n
  private buf = ""; // non-streaming: the whole body, parsed once at finalize
  private input?: number;
  private output?: number;
  private cacheRead?: number;
  private cacheCreation?: number;
  /** True once ANY upstream-reported usage has been seen — selects the exact
   *  path in finalize() over the local-estimate fallback. */
  private upstream = false;
  /** openai-chat-stream only: concatenated `choices[].delta.content`, for the
   *  local completion-token estimate when the upstream omits usage. */
  private completionText = "";

  feed(text: string, opts: { stream: boolean; key: RouteKey }): void {
    if (!opts.stream) {
      this.buf += text;
      return;
    }
    // Streaming SSE: parse complete lines now, keep the tail partial.
    this.partial += text;
    let nl: number;
    while ((nl = this.partial.indexOf("\n")) >= 0) {
      const line = this.partial.slice(0, nl);
      this.partial = this.partial.slice(nl + 1);
      this.parseLine(line, opts.key);
    }
  }

  private parseLine(line: string, key: RouteKey): void {
    const colon = line.indexOf(":");
    if (colon < 0) return;
    if (line.slice(0, colon).trim() !== "data") return; // only `data:` lines carry JSON
    const payload = line.slice(colon + 1).trimStart();
    if (!payload || payload === "[DONE]") return;
    let obj: any;
    try {
      obj = JSON.parse(payload);
    } catch {
      return; // a non-JSON data line (e.g. a backend's bespoke marker) — ignore
    }
    const u = extractUsage(obj, key);
    if (u) {
      this.upstream = true;
      if (typeof u.input === "number") this.input = u.input;
      if (typeof u.output === "number") this.output = u.output;
      if (typeof u.cacheRead === "number") this.cacheRead = u.cacheRead;
      if (typeof u.cacheCreation === "number") this.cacheCreation = u.cacheCreation;
    }
    // Accumulate completion text for the openai-chat-stream estimate fallback.
    // Stop once the upstream reported usage (the terminal chunk) — there's
    // nothing after it and no estimate will be needed.
    if (key === "openai" && !this.upstream && Array.isArray(obj.choices)) {
      for (const ch of obj.choices) {
        const c = ch?.delta?.content;
        if (typeof c === "string") this.completionText += c;
      }
    }
  }

  /** Resolve the final usage (or undefined if none could be determined). Call
   *  once, at stream end. `requestMessages` is the original chat request's
   *  `messages` — used only to estimate prompt tokens on the openai-chat-stream
   *  fallback path. */
  finalize(opts: { stream: boolean; key: RouteKey; requestMessages?: unknown }): Usage | undefined {
    if (!opts.stream) {
      // Non-streaming: parse the whole JSON body once.
      let obj: any;
      try {
        obj = JSON.parse(this.buf);
      } catch {
        return undefined;
      }
      const u = extractUsage(obj, opts.key);
      if (!u) return undefined;
      return { input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead, cacheCreation: u.cacheCreation };
    }
    // Flush any trailing line that had no trailing newline.
    if (this.partial.trim()) this.parseLine(this.partial, opts.key);
    if (this.upstream) {
      return {
        input: this.input ?? 0,
        output: this.output ?? 0,
        cacheRead: this.cacheRead,
        cacheCreation: this.cacheCreation,
      };
    }
    // Fallback: local estimate, ONLY for the openai chat streaming path (the one
    // wire whose streams routinely omit usage). Anthropic / /responses streams
    // always report usage, so they never reach here.
    if (opts.key === "openai") {
      const out = countTokens(this.completionText);
      const inp = estimatePromptTokens(opts.requestMessages);
      if (out || inp) return { input: inp, output: out, estimated: true };
    }
    return undefined;
  }
}
