/** Conversation grouping for the debug-capture list. Agent surfaces resend the
 *  whole history every turn, so one conversation shows up as many captured
 *  attempts and "later contains the earlier": request N+1's messages array is
 *  a prefix-superset of request N's. Grouping exploits exactly that — each
 *  request contributes a cumulative content hash per history message, and
 *  requests sharing ANY cumulative hash are unioned (their histories agree up
 *  to that point). metadata.user_id (Claude Code embeds the session id) is a
 *  secondary union signal for agents that rewrite early history (compaction).
 *
 *  Truncated bodies (cut at the capture size cap, JSON.parse fails) still
 *  participate: the raw text prefix of a truncated body is identical to the
 *  full body's, so an incremental scanner pulls the COMPLETE leading messages
 *  out of the raw JSON and hashes those — enough shared prefix to rejoin the
 *  conversation. Pure + client-side; the server stays out of it. */

export interface RequestShape {
  /** Cumulative content hash after each extractable history message. */
  hashes: string[];
  /** metadata.user_id when the body carries one ("" otherwise). */
  uid: string;
  /** Preview of the first user message ("" when none extractable). */
  title: string;
}

/** Two 32-bit rolls (different polynomials) — ~10k prefix hashes per view,
 *  a single 32-bit space would collide at birthday-paradox rates. */
function hash64(s: string): string {
  let a = 5381;
  let b = 2166136261 | 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = ((a << 5) + a + c) | 0;
    b = ((b ^ c) * 16777619) | 0;
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

/** Fields/shape-variants that legitimately differ between turns of ONE
 *  conversation, or between wires saying the same thing — canonicalized so
 *  they hash equal: a moving cache_control breakpoint, string content ≡
 *  text-parts, responses `input_text` ≡ `text`, the responses `message` type
 *  wrapper. Everything else (tool calls/results, ids, signatures) is resent
 *  byte-stable and kept. */
function deepCanon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(deepCanon);
  if (v && typeof v === "object") {
    const src = v as Record<string, unknown>;
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(src)) {
      if (k === "cache_control") continue;
      o[k] = deepCanon(val);
    }
    if (src.type === "input_text") o.type = "text";
    return o;
  }
  return v;
}

function canonicalMessage(m: unknown): unknown {
  if (!m || typeof m !== "object") return m;
  const o = deepCanon({ ...(m as Record<string, unknown>) }) as Record<string, unknown>;
  if (typeof o.content === "string") o.content = [{ type: "text", text: o.content }];
  if (o.type === "message") delete o.type;
  return o;
}

const TITLE_MAX = 80;

function preview(txt: string): string {
  const flat = txt.replace(/\s+/g, " ").trim();
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX)}…` : flat;
}

/** Text of a message content — a plain string, or a parts array where only the
 *  text parts matter (images/tool blocks contribute nothing). */
function* textChunks(v: unknown): Generator<string> {
  if (typeof v === "string") {
    if (v.trim()) yield v;
    return;
  }
  if (Array.isArray(v)) {
    for (const p of v) yield* textChunks(p);
    return;
  }
  if (v && typeof v === "object") {
    const t = (v as Record<string, unknown>).text;
    if (typeof t === "string" && t.trim()) yield t;
  }
}

/** Title text: first USER-message text chunk with any leading injected
 *  wrapper blocks removed — agents prepend XML-tagged context (`<system-reminder>`,
 *  `<ide_selection>`, `<local-command-stdout>`, …) either as separate parts or
 *  inline before the real prompt. A balanced `<tag>…</tag>` prefix is stripped
 *  repeatedly; whatever remains (if anything) is the title. */
function stripLeadingWrappers(s: string): string {
  let t = s;
  for (;;) {
    const m = /^\s*<([a-z][a-z0-9_-]*)((\s[^>]*)?)>/.exec(t);
    if (!m) return t;
    const close = t.indexOf(`</${m[1]}>`, m[0].length);
    if (close === -1) return t; // unbalanced → not a wrapper, keep
    t = t.slice(close + m[1].length + 3);
  }
}

function titleText(msgs: unknown[]): string {
  const from = (roles: string[]): string[] => {
    const out: string[] = [];
    for (const m of msgs) {
      if (!m || typeof m !== "object") continue;
      const o = m as Record<string, unknown>;
      if (roles.includes(o.role as string)) out.push(...textChunks(o.content));
    }
    return out;
  };
  const chunks = [...from(["user"]), ...from(["assistant", "system"])];
  for (const c of chunks) {
    const stripped = stripLeadingWrappers(c).trim();
    if (stripped) return preview(stripped);
  }
  return "";
}

/** Pull the COMPLETE leading elements out of a raw `"<key>": [ ... ` JSON array
 *  that may be cut mid-element (truncated capture). Walks with string/escape
 *  awareness; an unterminated tail element is dropped. String contents can't
 *  produce false `"key":[` hits — quotes inside strings are escaped. */
function extractArrayElements(raw: string, key: string): string[] {
  const m = new RegExp(`"${key}"\\s*:\\s*\\[`).exec(raw);
  if (!m) return [];
  let i = m.index + m[0].length;
  const n = raw.length;
  const items: string[] = [];
  for (;;) {
    while (i < n && /\s/.test(raw[i])) i++;
    if (i >= n || raw[i] === "]") break;
    const start = i;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let done = false;
    while (i < n) {
      const ch = raw[i++];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth <= 0) {
          done = true;
          break;
        }
      }
    }
    if (!done || depth !== 0) break; // truncated tail
    items.push(raw.slice(start, i));
    while (i < n && /\s/.test(raw[i])) i++;
    if (raw[i] === ",") {
      i++;
      continue;
    }
    break;
  }
  return items;
}

function uidRegexFallback(raw: string): string {
  const m = /"user_id"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  if (!m) return "";
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return "";
  }
}

/** Everything grouping needs from one captured request body. Never throws —
 *  a body that yields nothing just gets no hashes/uid/title. */
export function analyzeRequest(request: string): RequestShape {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(request);
  } catch {
    parsed = null; // truncated at the capture cap — fall through to the scanner
  }
  let msgs: unknown[] = [];
  let uid = "";
  if (parsed && typeof parsed === "object") {
    const b = parsed as Record<string, any>;
    if (typeof b.metadata?.user_id === "string") uid = b.metadata.user_id;
    if (Array.isArray(b.messages)) msgs = b.messages;
    else if (Array.isArray(b.input)) msgs = b.input;
    else if (typeof b.input === "string" && b.input) msgs = [{ role: "user", content: b.input }];
  } else {
    const key = /"messages"\s*:\s*\[/.test(request) ? "messages" : "input";
    msgs = extractArrayElements(request, key)
      .map((s) => {
        try {
          return JSON.parse(s) as unknown;
        } catch {
          return null;
        }
      })
      .filter((m): m is unknown => m !== null);
    uid = uidRegexFallback(request);
  }
  const hashes: string[] = [];
  let acc = "";
  for (const m of msgs) {
    acc = hash64(`${acc}|${hash64(JSON.stringify(canonicalMessage(m)))}`);
    hashes.push(acc);
  }
  return { hashes, uid, title: preview(titleText(msgs)) };
}

/** Group index per input (union-find). Requests union when they share a
 *  cumulative history hash (containment) or the same metadata.user_id;
 *  unidentifiable requests stay solo. */
export function assignConversationGroups(shapes: RequestShape[]): number[] {
  const n = shapes.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const next = parent[x];
      parent[x] = r;
      x = next;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const byHash = new Map<string, number>();
  const byUid = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const s = shapes[i];
    if (s.uid) {
      const j = byUid.get(s.uid);
      if (j !== undefined) union(i, j);
      else byUid.set(s.uid, i);
    }
    for (const h of s.hashes) {
      const j = byHash.get(h);
      if (j !== undefined) union(i, j);
      else byHash.set(h, i);
    }
  }
  return shapes.map((_, i) => find(i));
}

/** One-call convenience for the dialog: group ids + per-request shapes (the
 *  titles feed the conversation rows). */
export function conversationGroupsOf(requests: string[]): { ids: number[]; shapes: RequestShape[] } {
  const shapes = requests.map(analyzeRequest);
  return { ids: assignConversationGroups(shapes), shapes };
}
