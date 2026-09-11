<script setup lang="ts">
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";
import { Badge } from "@/components/ui/badge";
import { ChevronRight, Wrench } from "lucide-vue-next";

const props = defineProps<{ body: string | undefined; kind: "request" | "response" }>();
const { t } = useI18n();

const CLAMP = 2000;
const NOTE_MAX = 160;

type Block =
  | { t: "text"; text: string; think?: boolean }
  | { t: "note"; text: string }
  | { t: "img"; src: string; note?: string }
  | { t: "call"; name: string; args?: string };
type Card = { role: string; blocks: Block[] };
type Tool = { name: string; desc?: string; schema?: string };
type ReqView = { params: { k: string; v: string }[]; cards: Card[]; tools: Tool[] };
type RespView = { cards: Card[]; inp?: number; out?: number; finish?: string; chunks?: number };

const expanded = ref<Set<string>>(new Set());
const preview = ref<string | null>(null);
function toggle(key: string) {
  const s = new Set(expanded.value);
  if (s.has(key)) s.delete(key);
  else s.add(key);
  expanded.value = s;
}
function shown(text: string, key: string): string {
  return expanded.value.has(key) || text.length <= CLAMP ? text : text.slice(0, CLAMP);
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const clip = (s: string): string => (s.length > NOTE_MAX ? `${s.slice(0, NOTE_MAX)}…` : s);

function prettyJson(v: unknown): string {
  if (typeof v === "string") {
    try {
      return JSON.stringify(JSON.parse(v), null, 2);
    } catch {
      return v;
    }
  }
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return str(v);
  }
}

function jsonMaybe(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function textBlock(v: unknown, think = false): Block {
  return { t: "text", text: str(v), think: think || undefined };
}

function imgSrc(o: Record<string, unknown>): string {
  const u =
    typeof o.image_url === "string"
      ? o.image_url
      : ((o.image_url as Record<string, unknown> | undefined)?.url as string | undefined) ?? (o.url as string | undefined);
  if (u) return u;
  const src = o.source as Record<string, unknown> | undefined;
  if (src?.type === "base64" && typeof src.data === "string") return `data:${str(src.media_type) || "image/png"};base64,${src.data}`;
  if (src?.type === "url" && typeof src.url === "string") return src.url;
  return "";
}

/** Only data:image and http(s) go to <img>/preview — anything else (or missing)
 *  degrades to the plain [image] note it was before. */
function imgPart(o: Record<string, unknown>): Block {
  const u = imgSrc(o);
  if (!u || !/^data:image\//.test(u) && !/^https?:\/\//.test(u)) {
    const raw = u ? clip(u) : "";
    return { t: "note", text: raw ? `${t("models.debugImage")} · ${raw}` : t("models.debugImage") };
  }
  return {
    t: "img",
    src: u,
    note: u.startsWith("data:") ? `base64 ${(u.length / 1024).toFixed(1)}KB` : clip(u),
  };
}

function partBlocks(p: unknown): Block[] {
  if (typeof p === "string") return [textBlock(p)];
  if (!p || typeof p !== "object") return p == null ? [] : [textBlock(prettyJson(p))];
  const o = p as Record<string, unknown>;
  switch (o.type) {
    case "text":
    case "input_text":
    case "output_text":
    case "refusal":
      return [textBlock(o.text ?? o.refusal)];
    case "thinking":
      return [textBlock(o.thinking ?? o.text, true)];
    case "redacted_thinking":
      return [{ t: "note", text: t("models.debugThinking") }];
    case "image_url":
    case "input_image":
    case "image":
      return [imgPart(o)];
    case "tool_use":
    case "function_call":
      return [{ t: "call", name: str(o.name), args: prettyJson(o.type === "tool_use" ? o.input : o.arguments) }];
    case "tool_result": {
      const head = o.tool_use_id ? [{ t: "note", text: clip(str(o.tool_use_id)) } as Block] : [];
      return [...head, ...blocksOf(o.content)];
    }
    case "function_call_output": {
      const head = o.call_id ? [{ t: "note", text: clip(str(o.call_id)) } as Block] : [];
      return [...head, ...blocksOf(o.output)];
    }
    default:
      return [textBlock(prettyJson(o))];
  }
}

function blocksOf(content: unknown): Block[] {
  if (content == null) return [];
  if (Array.isArray(content)) return content.flatMap(partBlocks);
  if (typeof content === "object") return partBlocks(content);
  return [textBlock(content)];
}

function callBlocks(o: Record<string, unknown>): Block[] {
  if (!Array.isArray(o.tool_calls)) return [];
  return o.tool_calls.flatMap((c) => {
    const f = (c as Record<string, unknown> | null)?.function as Record<string, unknown> | undefined;
    if (!f) return [];
    return [{ t: "call", name: str(f.name), args: prettyJson(jsonMaybe(f.arguments)) } as Block];
  });
}

function cardOf(m: unknown): Card | null {
  if (typeof m === "string") return { role: "user", blocks: [textBlock(m)] };
  if (!m || typeof m !== "object") return null;
  const o = m as Record<string, unknown>;
  const blocks = [...blocksOf(o.content), ...callBlocks(o)];
  if (!blocks.length) return null;
  return { role: str(o.role) || "—", blocks };
}

function toolOf(x: unknown): Tool | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const f = (o.function as Record<string, unknown> | undefined) ?? o;
  const name = str(f.name);
  if (!name) return null;
  const desc = str(f.description);
  const schema = f.parameters ?? f.input_schema;
  return { name, desc: desc || undefined, schema: schema != null ? prettyJson(schema) : undefined };
}

const REQ_SKIP = new Set(["messages", "tools", "input", "system", "instructions", "tool_choice"]);

function reqOf(o: Record<string, unknown>): ReqView {
  const params: { k: string; v: string }[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (REQ_SKIP.has(k) || v == null) continue;
    params.push({ k, v: clip(typeof v === "object" ? JSON.stringify(v) : String(v)) });
  }
  const cards: Card[] = [];
  const sys = o.system ?? o.instructions;
  if (sys != null) cards.push({ role: "system", blocks: blocksOf(sys) });
  const msgs = typeof o.input === "string" ? [o.input] : (o.messages ?? o.input);
  if (Array.isArray(msgs)) for (const m of msgs) {
    const c = cardOf(m);
    if (c) cards.push(c);
  }
  const tools = Array.isArray(o.tools) ? o.tools.map(toolOf).filter((x): x is Tool => x !== null) : [];
  return { params, cards, tools };
}

function looksSse(b: string): boolean {
  return /^\s*(event|data|id|retry):/m.test(b);
}

function parseSse(b: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of b.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("data:")) continue;
    const payload = s.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      out.push(JSON.parse(payload) as Record<string, unknown>);
    } catch {}
  }
  return out;
}

function respFromSse(events: Record<string, unknown>[]): RespView {
  let text = "";
  let think = "";
  const calls = new Map<number, { name: string; args: string }>();
  let inp: number | undefined;
  let out: number | undefined;
  let finish: string | undefined;
  const claim = (i: number) => {
    let c = calls.get(i);
    if (!c) {
      c = { name: "", args: "" };
      calls.set(i, c);
    }
    return c;
  };
  const usageOf = (u: unknown) => {
    if (!u || typeof u !== "object") return;
    const o = u as Record<string, unknown>;
    inp = num(o.prompt_tokens) ?? num(o.input_tokens) ?? inp;
    out = num(o.completion_tokens) ?? num(o.output_tokens) ?? out;
  };
  for (const ev of events) {
    if (Array.isArray(ev.choices)) {
      const ch = ev.choices[0] as Record<string, unknown> | undefined;
      const d = ch?.delta as Record<string, unknown> | undefined;
      if (d) {
        if (typeof d.content === "string") text += d.content;
        if (typeof d.reasoning_content === "string") think += d.reasoning_content;
        if (Array.isArray(d.tool_calls)) {
          for (const tc of d.tool_calls as Record<string, unknown>[]) {
            const cur = claim(typeof tc.index === "number" ? tc.index : 0);
            const f = tc.function as Record<string, unknown> | undefined;
            if (typeof f?.name === "string") cur.name += f.name;
            if (typeof f?.arguments === "string") cur.args += f.arguments;
          }
        }
      }
      if (typeof ch?.finish_reason === "string" && ch.finish_reason) finish = ch.finish_reason;
    }
    usageOf(ev.usage);
    const type = str(ev.type);
    if (type === "message_start") usageOf((ev.message as Record<string, unknown> | undefined)?.usage);
    if (type === "content_block_delta") {
      const d = ev.delta as Record<string, unknown> | undefined;
      if (typeof d?.text === "string") text += d.text;
      if (typeof d?.thinking === "string") think += d.thinking;
      if (typeof d?.partial_json === "string") claim(typeof ev.index === "number" ? ev.index : 0).args += d.partial_json;
    }
    if (type === "content_block_start") {
      const cb = ev.content_block as Record<string, unknown> | undefined;
      if (cb?.type === "tool_use") claim(typeof ev.index === "number" ? ev.index : 0).name = str(cb.name);
    }
    if (type === "message_delta") {
      const d = ev.delta as Record<string, unknown> | undefined;
      if (typeof d?.stop_reason === "string" && d.stop_reason) finish = d.stop_reason;
      usageOf(ev.usage);
    }
    if (type === "response.output_text.delta" && typeof ev.delta === "string") text += ev.delta;
    if (type === "response.completed") usageOf((ev.response as Record<string, unknown> | undefined)?.usage);
  }
  const cards: Card[] = [];
  if (think) cards.push({ role: "assistant", blocks: [textBlock(think, true)] });
  const callList = [...calls.values()]
    .filter((c) => c.name || c.args)
    .map((c) => ({ t: "call", name: c.name, args: c.args ? prettyJson(c.args) : undefined }) as Block);
  if (text || callList.length) cards.push({ role: "assistant", blocks: [...(text ? [textBlock(text)] : []), ...callList] });
  return { cards, inp, out, finish, chunks: events.length };
}

function respFromJson(o: Record<string, unknown>): RespView | null {
  if (Array.isArray(o.choices)) {
    const cards: Card[] = [];
    let finish: string | undefined;
    for (const c of o.choices as Record<string, unknown>[]) {
      const m = c.message as Record<string, unknown> | undefined;
      if (!m) continue;
      const blocks = [
        ...(typeof m.reasoning_content === "string" && m.reasoning_content ? [textBlock(m.reasoning_content, true)] : []),
        ...blocksOf(m.content),
        ...callBlocks(m),
      ];
      if (blocks.length) cards.push({ role: str(m.role) || "assistant", blocks });
      if (typeof c.finish_reason === "string" && c.finish_reason) finish = c.finish_reason;
    }
    const u = o.usage as Record<string, unknown> | undefined;
    if (!cards.length && !u) return null;
    return { cards, inp: num(u?.prompt_tokens), out: num(u?.completion_tokens), finish };
  }
  if (Array.isArray(o.content)) {
    const blocks = blocksOf(o.content);
    const u = o.usage as Record<string, unknown> | undefined;
    if (!blocks.length && !u) return null;
    return {
      cards: blocks.length ? [{ role: "assistant", blocks }] : [],
      inp: num(u?.input_tokens),
      out: num(u?.output_tokens),
      finish: typeof o.stop_reason === "string" && o.stop_reason ? o.stop_reason : undefined,
    };
  }
  if (Array.isArray(o.output)) {
    const cards: Card[] = [];
    for (const it of o.output as Record<string, unknown>[]) {
      if (it.type === "function_call") {
        cards.push({ role: "assistant", blocks: [{ t: "call", name: str(it.name), args: prettyJson(jsonMaybe(it.arguments)) }] });
      } else if (it.type === "message") {
        const blocks = blocksOf(it.content);
        if (blocks.length) cards.push({ role: str(it.role) || "assistant", blocks });
      }
    }
    const u = o.usage as Record<string, unknown> | undefined;
    if (!cards.length && !u) return null;
    return { cards, inp: num(u?.input_tokens), out: num(u?.output_tokens), finish: str(o.status) || undefined };
  }
  return null;
}

const reqView = computed<ReqView | null>(() => {
  if (props.kind !== "request" || !props.body) return null;
  try {
    return reqOf(JSON.parse(props.body) as Record<string, unknown>);
  } catch {
    return null;
  }
});

const respView = computed<RespView | null>(() => {
  if (props.kind !== "response" || !props.body) return null;
  try {
    const r = respFromJson(JSON.parse(props.body) as Record<string, unknown>);
    if (r) return r;
  } catch {
    if (looksSse(props.body)) {
      const events = parseSse(props.body);
      if (events.length) return respFromSse(events);
    }
  }
  return null;
});

const cards = computed<Card[]>(() => reqView.value?.cards ?? respView.value?.cards ?? []);

const prettyBody = computed(() => {
  if (!props.body) return "";
  try {
    return JSON.stringify(JSON.parse(props.body), null, 2);
  } catch {
    return props.body;
  }
});
</script>

<template>
  <div v-if="reqView || respView" class="space-y-2">
    <div v-if="reqView && reqView.params.length" class="flex flex-wrap gap-x-3 gap-y-0.5 rounded-md border bg-muted/30 px-2.5 py-1.5">
      <span v-for="p in reqView.params" :key="p.k" class="font-mono text-[11px] text-muted-foreground">
        <span class="text-foreground">{{ p.k }}</span>={{ p.v }}
      </span>
    </div>

    <div v-for="(c, i) in cards" :key="i" class="overflow-hidden rounded-md border">
      <div class="border-b bg-muted/30 px-2.5 py-1">
        <Badge variant="secondary" class="font-mono text-[10px]">{{ c.role }}</Badge>
      </div>
      <div class="space-y-1.5 px-2.5 py-1.5">
        <template v-for="(b, j) in c.blocks" :key="j">
          <p v-if="b.t === 'note'" class="break-all font-mono text-[11px] text-muted-foreground">{{ b.text }}</p>
          <div v-else-if="b.t === 'img'" class="space-y-1">
            <img
              :src="b.src"
              :alt="t('models.debugImage')"
              loading="lazy"
              class="max-h-28 max-w-full cursor-zoom-in rounded border bg-muted/30 object-contain"
              @click="preview = b.src"
            />
            <p class="flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-muted-foreground">
              <span class="break-all">{{ b.note }}</span>
              <a
                v-if="!b.src.startsWith('data:')"
                :href="b.src"
                target="_blank"
                rel="noreferrer"
                class="text-primary hover:underline"
                @click.stop
              >{{ t("models.debugOpen") }}</a>
            </p>
          </div>
          <div v-else-if="b.t === 'call'" class="rounded bg-muted/50 px-2 py-1">
            <p class="flex items-center gap-1 font-mono text-[11px] font-medium">
              <Wrench class="h-3 w-3 shrink-0 text-muted-foreground" />{{ b.name }}
            </p>
            <template v-if="b.args">
              <pre class="mt-0.5 whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">{{ shown(b.args, `${i}-${j}`) }}</pre>
              <button
                v-if="b.args.length > CLAMP"
                type="button"
                class="text-[11px] text-primary hover:underline"
                @click="toggle(`${i}-${j}`)"
              >
                {{ expanded.has(`${i}-${j}`) ? t("models.debugLess") : t("models.debugMore", { n: b.args.length - CLAMP }) }}
              </button>
            </template>
          </div>
          <div v-else>
            <p v-if="b.think" class="mb-0.5 text-[11px] font-medium text-muted-foreground">{{ t("models.debugThinking") }}</p>
            <p class="whitespace-pre-wrap break-words text-xs leading-relaxed" :class="b.think ? 'italic text-muted-foreground' : ''">{{ shown(b.text, `${i}-${j}`) }}</p>
            <button
              v-if="b.text.length > CLAMP"
              type="button"
              class="mt-0.5 text-[11px] text-primary hover:underline"
              @click="toggle(`${i}-${j}`)"
            >
              {{ expanded.has(`${i}-${j}`) ? t("models.debugLess") : t("models.debugMore", { n: b.text.length - CLAMP }) }}
            </button>
          </div>
        </template>
      </div>
    </div>

    <div v-if="reqView && reqView.tools.length" class="overflow-hidden rounded-md border">
      <div class="border-b bg-muted/30 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">{{ t("models.debugTools") }} ({{ reqView.tools.length }})</div>
      <div v-for="(tool, i) in reqView.tools" :key="i" class="border-b last:border-b-0">
        <button type="button" class="flex w-full items-center gap-1.5 px-2.5 py-1 text-left hover:bg-muted/50" @click="toggle(`tool-${i}`)">
          <ChevronRight class="h-3 w-3 shrink-0 text-muted-foreground transition-transform" :class="expanded.has(`tool-${i}`) ? 'rotate-90' : ''" />
          <Wrench class="h-3 w-3 shrink-0 text-muted-foreground" />
          <span class="font-mono text-[11px] font-medium">{{ tool.name }}</span>
          <span v-if="tool.desc" class="min-w-0 truncate text-[11px] text-muted-foreground">{{ tool.desc }}</span>
        </button>
        <div v-if="expanded.has(`tool-${i}`)" class="space-y-1 px-2.5 pb-1.5">
          <p v-if="tool.desc" class="whitespace-pre-wrap break-words text-xs text-muted-foreground">{{ tool.desc }}</p>
          <pre v-if="tool.schema" class="whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">{{ tool.schema }}</pre>
        </div>
      </div>
    </div>

    <div
      v-if="respView && (respView.inp != null || respView.out != null || respView.finish || respView.chunks)"
      class="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground"
    >
      <span v-if="respView.inp != null">{{ t("models.debugTokIn") }} {{ respView.inp }}</span>
      <span v-if="respView.out != null">{{ t("models.debugTokOut") }} {{ respView.out }}</span>
      <span v-if="respView.finish">{{ t("models.debugFinish") }}: {{ respView.finish }}</span>
      <span v-if="respView.chunks">{{ t("models.debugChunks", { n: respView.chunks }) }}</span>
    </div>
  </div>

  <pre v-else class="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 p-3 font-mono text-xs">{{ prettyBody }}</pre>

  <Teleport to="body">
    <div
      v-if="preview"
      class="fixed inset-0 z-[60] flex cursor-zoom-out items-center justify-center bg-black/80 p-8"
      @click="preview = null"
    >
      <img :src="preview" :alt="t('models.debugImage')" class="max-h-full max-w-full rounded object-contain shadow-lg" />
    </div>
  </Teleport>
</template>
