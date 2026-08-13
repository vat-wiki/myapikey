<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { req, type ModelView, type ProviderPublic } from "@/api";
import { FMT_ACCENT, providerColor } from "@/lib/format";
import { toast } from "@/lib/toast";
import { copyText } from "@/lib/clipboard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import {
  ChevronRight,
  ChevronDown,
  MoveUp,
  MoveDown,
  Trash2,
  Cpu,
  Plus,
  Loader2,
  Search,
  RefreshCw,
  ServerCog,
  MoreHorizontal,
  Pencil,
  Zap,
  Gauge,
  Filter,
  Copy,
} from "lucide-vue-next";
import SourcesDialog from "@/SourcesDialog.vue";
import ConfirmDialog from "@/ConfirmDialog.vue";
import AddModelsDialog from "@/AddModelsDialog.vue";
import AddSourceDialog from "@/AddSourceDialog.vue";

const { t } = useI18n();

/** The three routing slots — one per forwarding endpoint. /chat/completions and
 *  /responses are separate OpenAI-family endpoints (different URLs) and route
 *  independently. */
type Fmt = "openai" | "anthropic" | "responses";
const FORMATS: Fmt[] = ["openai", "anthropic", "responses"];

const models = ref<ModelView[]>([]);
const providers = ref<ProviderPublic[]>([]);
const err = ref("");
const loading = ref(false);
const query = ref("");
const showAvailable = ref(true);
const expandedModels = ref<Set<string>>(new Set());
const refreshingAll = ref(false);
const enablingAll = ref(false);
const sourcesOpen = ref(false);
const addOpen = ref(false);

const removing = ref<Record<string, boolean>>({});
const enabling = ref<Record<string, boolean>>({});
const removingSrc = ref<Record<string, boolean>>({});
const testing = ref<Record<string, boolean>>({});
// Per-source "test this source" state, keyed `name:fmt:pid` (independent of the
// whole-chain `testing`/`probe` so a single-source probe never overwrites the
// chain-level badge).
const srcTesting = ref<Record<string, boolean>>({});
const srcProbe = ref<Record<string, ProbeResult>>({});
interface ProbeResult { ok: boolean; status: number; provider?: string; format: string; error?: string }
const probe = ref<Record<string, ProbeResult>>({});

// In-progress upstream-model edit on a single chain member, keyed `name:fmt:pid`.
// Seeded by enterEdit(); committed on blur/Enter (idempotent), reverted on Esc.
const mapDraft = ref<Record<string, string>>({});
const mapEditingKey = ref<string>("");

// Model-level "add source" dialog target (the row being added to).
const addSourceTarget = ref<Row | null>(null);
const addSourceOpen = ref(false);

// Focus the upstream-model <input> the instant it's inserted (edit-on-demand).
const vFocus = { mounted: (el: HTMLInputElement) => el.focus() };

const confirmTarget = ref<Row | null>(null);
const confirmOpen = ref(false);

const enc = encodeURIComponent;

async function load() {
  loading.value = true;
  err.value = "";
  try {
    const [m, p] = await Promise.all([
      req<{ models: ModelView[] }>("GET", "/admin/models"),
      req<{ providers: ProviderPublic[] }>("GET", "/admin/providers"),
    ]);
    models.value = m.models;
    providers.value = p.providers;
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

const providerById = computed(() => new Map(providers.value.map((p) => [p.id, p])));

/** modelName -> provider ids that discovered it (offered it). */
const offeringMap = computed(() => {
  const m = new Map<string, string[]>();
  for (const p of providers.value) {
    for (const name of p.discoveredModels ?? []) {
      const arr = m.get(name);
      if (arr) arr.push(p.id);
      else m.set(name, [p.id]);
    }
  }
  return m;
});

interface ChainSrc { id: string; name: string; model?: string }
interface FormatRow { enabled: boolean; chain: ChainSrc[]; }
interface Row {
  name: string;
  openai: FormatRow;
  anthropic: FormatRow;
  responses: FormatRow;
  offering: { id: string; name: string; formats: string[]; supportsResponses?: boolean }[];
}

const rows = computed<Row[]>(() => {
  const names = new Set<string>();
  for (const p of providers.value) for (const n of p.discoveredModels ?? []) names.add(n);
  for (const m of models.value) names.add(m.name);
  const toRow = (fe: { enabled: boolean; providers: { id: string; name: string; model?: string }[] } | undefined): FormatRow => ({
    enabled: fe?.enabled ?? false,
    chain: (fe?.providers ?? []).map((p) => ({ id: p.id, name: p.name, model: p.model })),
  });
  return [...names].map((name) => {
    const m = models.value.find((x) => x.name === name);
    const off = (offeringMap.value.get(name) ?? [])
      .map((id) => providerById.value.get(id))
      .filter((p): p is ProviderPublic => !!p)
      .map((p) => ({ id: p.id, name: p.name, formats: p.formats, supportsResponses: p.supportsResponses }));
    return {
      name,
      openai: toRow(m?.openai),
      anthropic: toRow(m?.anthropic),
      responses: toRow(m?.responses),
      offering: off,
    };
  });
});

/** Formats a model is currently enabled on — the slots whose chains we expose
 *  when the row is expanded. */
function enabledFormats(r: Row): Fmt[] {
  return FORMATS.filter((f) => r[f].enabled);
}
/** Formats a discovered model can be enabled on (offered by ≥1 source). */
function availFormats(r: Row): Fmt[] {
  return FORMATS.filter((f) => r.offering.some((o) => supportsFmt(o, f)));
}
/** Offered formats the model isn't yet enabled on. */
function enableableFormats(r: Row): Fmt[] {
  return availFormats(r).filter((f) => !r[f].enabled);
}
/** Status of a routing slot, drives the per-format chip: enabled (on),
 *  enableable (off but offered — click to turn on), or unsupported (no source). */
function fmtStatus(r: Row, f: Fmt): "enabled" | "enableable" | "unsupported" {
  if (r[f].enabled) return "enabled";
  return availFormats(r).includes(f) ? "enableable" : "unsupported";
}
/** Provider ids offering `r` on `fmt` — the chain to seed when enabling. */
function offeringIds(r: Row, fmt: Fmt): string[] {
  return r.offering.filter((o) => supportsFmt(o, fmt)).map((o) => o.id);
}

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  return rows.value.filter((r) => !q || r.name.toLowerCase().includes(q));
});
/** Models with ≥1 route on. Mutually exclusive with availableRows, so a model
 *  is never listed twice (the old per-format panels duplicated it). */
const enabledRows = computed(() => filtered.value.filter((r) => r.openai.enabled || r.anthropic.enabled || r.responses.enabled));
const availableRows = computed(() => filtered.value.filter((r) => !(r.openai.enabled || r.anthropic.enabled || r.responses.enabled) && availFormats(r).length > 0));

/** Discovery returns only model names — no capability metadata — so "is this a
 *  chat model" is a name heuristic. These are the families a chat-completions
 *  gateway won't route: embeddings, audio/voice, image/video gen, moderation,
 *  rerankers. Used to default-hide the noise that floods the Available list. */
const NON_CHAT_HINTS = ["embed", "whisper", "tts", "dall-e", "dall_e", "image", "moderation", "audio", "transcribe", "rerank", "realtime", "sora"];
function isNonChatModel(name: string): boolean {
  const n = name.toLowerCase();
  return NON_CHAT_HINTS.some((k) => n.includes(k));
}

/** Hide non-conversational models by default so the list stays focused on what
 *  you'd actually route. The toggle is only surfaced when there's noise to hide. */
const hideNonChat = ref(true);
const nonChatAvailableCount = computed(() => availableRows.value.filter((r) => isNonChatModel(r.name)).length);
const visibleAvailableRows = computed(() => (hideNonChat.value ? availableRows.value.filter((r) => !isNonChatModel(r.name)) : availableRows.value));

/** Group the (filtered) available models by the source that offers them, so a
 *  source that dumped 100 models reads as one collapsible bucket instead of a
 *  wall. A model offered by several sources appears under each: each source
 *  lists what IT discovered, so a shared model shows up under every source that
 *  carries it. */
const availableGrouped = computed(() => {
  const out: { source: ProviderPublic; rows: Row[] }[] = [];
  for (const p of providers.value) {
    const rows = visibleAvailableRows.value
      .filter((r) => r.offering.some((o) => o.id === p.id))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (rows.length) out.push({ source: p, rows });
  }
  return out;
});

/** Per-bucket collapse override. Small buckets stay open on their own; large
 *  ones (≥ threshold) collapse to just their count until opened. Searching
 *  forces every bucket open so matches are never hidden inside a header. */
const COLLAPSE_THRESHOLD = 8;
const sourceOpenOverride = ref<Record<string, boolean>>({});
function isSourceOpen(id: string, count: number): boolean {
  if (query.value.trim()) return true;
  if (id in sourceOpenOverride.value) return sourceOpenOverride.value[id];
  return count <= COLLAPSE_THRESHOLD;
}
function toggleSource(id: string, count: number): void {
  if (query.value.trim()) return;
  sourceOpenOverride.value = { ...sourceOpenOverride.value, [id]: !isSourceOpen(id, count) };
}

/** Every source that can attach to ≥1 enabled route of this model — candidates
 *  for the model-level "add source" dialog. A source already attached is STILL a
 *  candidate: adding it again creates a second slot (to map a different upstream
 *  model), which is the whole point of per-route failover across one backend. */
function addableFor(r: Row): ProviderPublic[] {
  const enabled = enabledFormats(r);
  return providers.value.filter((p) => enabled.some((f) => supportsFmt(p, f)));
}
/** Snapshot of each routing slot's current chain (provider ids), passed to the
 *  add-source dialog so it can compute which routes a candidate would join. */
function chainByFormat(r: Row): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const f of FORMATS) out[f] = r[f].chain.map((c) => c.id);
  return out;
}
function supportsFmt(o: { formats: string[]; supportsResponses?: boolean }, fmt: Fmt): boolean {
  return fmt === "responses" ? !!o.supportsResponses : o.formats.includes(fmt);
}

/** Short label + endpoint for each routing slot. */
const FMT_META: Record<Fmt, { key: string; chip: string; endpoint: string }> = {
  openai: { key: "models.fmtOpenai", chip: "models.fmtOpenaiShort", endpoint: "/chat/completions" },
  anthropic: { key: "models.fmtAnthropic", chip: "models.fmtAnthropicShort", endpoint: "/messages" },
  responses: { key: "models.fmtResponses", chip: "models.fmtResponsesShort", endpoint: "/responses" },
};

function isExpanded(name: string) {
  return expandedModels.value.has(name);
}
function toggleExpand(name: string) {
  const s = new Set(expandedModels.value);
  if (s.has(name)) s.delete(name);
  else s.add(name);
  expandedModels.value = s;
}
/** Copy a model name to the clipboard. Reuses the connect.* copy labels — they're
 *  the codebase's generic copy strings (Settings.vue uses them for the password). */
async function copyName(name: string) {
  const ok = await copyText(name);
  toast(ok ? t("connect.copied") : t("connect.copyFailed"), ok ? "success" : "error");
}
/** Keyboard activate for the summary row, which is a div(role=button) so it can
 *  nest a real copy <button>. Only fires when the row itself has focus — the
 *  inner copy button owns its own keystrokes (e.target !== currentTarget). */
function onRowKeydown(e: KeyboardEvent, name: string) {
  if (e.target !== e.currentTarget) return;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    toggleExpand(name);
  }
}
function joinChain(chain: ChainSrc[]): string {
  return chain.length ? chain.map((p) => p.name).join(" → ") : t("models.noSourcesShort");
}
/** One-line chain summary across every enabled route, shown under the name. */
function summaryChain(r: Row): string {
  return enabledFormats(r).map((f) => `${t(FMT_META[f].chip)}: ${joinChain(r[f].chain)}`).join("  ·  ");
}
function isStale(r: Row, fmt: Fmt): boolean {
  const chain = r[fmt].chain;
  if (!chain.length) return false;
  const list = (id: string) => providerById.value.get(id)?.discoveredModels ?? [];
  // Compare against the source's UPSTREAM name when mapped: a mapped model's
  // public name won't appear in discovery (the provider lists the upstream id),
  // so using r.name would falsely flag every mapped source as delisted.
  return !chain.some((c) => list(c.id).includes(c.model ?? r.name)) && chain.some((c) => list(c.id).length > 0);
}
/** Delisted on any enabled route — surfaced as a summary badge. */
function isStaleAny(r: Row): boolean {
  return enabledFormats(r).some((f) => isStale(r, f));
}

/** Aggregate probe result across enabled routes, for the summary badge. */
function rowProbe(r: Row): { state: "testing" | "ok" | "fail"; status?: number; provider?: string; error?: string } | null {
  let testingAny = false;
  let ok: ProbeResult | null = null;
  let fail: ProbeResult | null = null;
  for (const f of enabledFormats(r)) {
    const key = `${r.name}:${f}`;
    if (testing.value[key]) testingAny = true;
    const pr = probe.value[key];
    if (pr?.ok && !ok) ok = pr;
    else if (pr && !pr.ok && !fail) fail = pr;
  }
  if (testingAny) return { state: "testing" };
  if (ok) return { state: "ok", provider: ok.provider };
  if (fail) return { state: "fail", status: fail.status, error: fail.error };
  return null;
}

/** Chip styling per slot state: solid pill when on, dashed when available,
 *  faint when no source offers it. */
function chipClass(r: Row, f: Fmt): string {
  const s = fmtStatus(r, f);
  if (s === "enabled") return `border-transparent ${FMT_ACCENT[f].solid} text-white shadow-sm`;
  if (s === "enableable") return "border-dashed border-input text-muted-foreground hover:bg-accent hover:text-accent-foreground";
  return "border-transparent text-muted-foreground/40";
}
function chipTitle(r: Row, f: Fmt): string {
  const s = fmtStatus(r, f);
  if (s === "enabled") return `${t(FMT_META[f].key)} · ${t("models.chipOn")}`;
  if (s === "enableable") return `${t(FMT_META[f].key)} · ${t("models.chipOff")}`;
  return `${t(FMT_META[f].key)} · ${t("models.chipNa")}`;
}

async function toggle(r: Row, fmt: Fmt) {
  if (r[fmt].enabled) await disable(r, fmt);
  else await enable(r, fmt);
}

async function enable(r: Row, fmt: Fmt) {
  const key = `${r.name}:${fmt}`;
  enabling.value[key] = true;
  const sources = r.offering.filter((o) => supportsFmt(o, fmt));
  const srcObjs = sources.map((s) => ({ id: s.id, name: s.name }));
  const m = models.value.find((x) => x.name === r.name);
  if (m) {
    m[fmt].enabled = true;
    for (const s of srcObjs) if (!m[fmt].providers.find((p) => p.id === s.id)) m[fmt].providers.push(s);
  } else {
    models.value.push({
      name: r.name,
      openai: { enabled: fmt === "openai", providers: fmt === "openai" ? srcObjs : [] },
      anthropic: { enabled: fmt === "anthropic", providers: fmt === "anthropic" ? srcObjs : [] },
      responses: { enabled: fmt === "responses", providers: fmt === "responses" ? srcObjs : [] },
    });
  }
  try {
    await req("POST", "/admin/models", { name: r.name, format: fmt, providers: sources.map((s) => s.id) });
    toast(t("models.enabledToast", { name: `${r.name} [${fmt}]` }), "success");
  } catch (e) {
    await load();
    toast((e as Error).message, "error");
  } finally {
    enabling.value[key] = false;
  }
}

/** Enable every model still in the Available list, on every format it can run
 *  (all of its enableable slots). Each (model, format) is an independent POST,
 *  fired in parallel; we don't call enable() per pair because its optimistic
 *  push would race when two slots target the same model. Reconcile via load(). */
async function enableAll() {
  if (enablingAll.value) return;
  enablingAll.value = true;
  const tasks: { name: string; fmt: Fmt; providers: string[] }[] = [];
  for (const r of visibleAvailableRows.value) {
    for (const f of enableableFormats(r)) tasks.push({ name: r.name, fmt: f, providers: offeringIds(r, f) });
  }
  for (const tk of tasks) enabling.value[`${tk.name}:${tk.fmt}`] = true;
  const results = await Promise.allSettled(
    tasks.map((tk) => req("POST", "/admin/models", { name: tk.name, format: tk.fmt, providers: tk.providers })),
  );
  for (const tk of tasks) enabling.value[`${tk.name}:${tk.fmt}`] = false;
  await load();
  enablingAll.value = false;
  if (!tasks.length) return;
  const failed = results.filter((r) => r.status === "rejected").length;
  if (!failed) toast(t("models.enableAllDone"), "success");
  else if (failed === tasks.length) toast(t("models.enableAllFailed"), "error");
  else toast(t("models.enableAllPartial", { failed }), "error");
}

async function disable(r: Row, fmt: Fmt) {
  const m = models.value.find((x) => x.name === r.name);
  if (m) m[fmt].enabled = false;
  try {
    await req("POST", `/admin/models/${enc(r.name)}/disable`, { format: fmt });
    toast(t("models.disabledToast", { name: `${r.name} [${fmt}]` }), "success");
  } catch (e) {
    await load();
    toast((e as Error).message, "error");
  }
}

function askRemoveModel(r: Row) {
  confirmTarget.value = r;
  confirmOpen.value = true;
}

async function testModel(r: Row, fmt: Fmt) {
  const key = `${r.name}:${fmt}`;
  if (testing.value[key]) return;
  testing.value[key] = true;
  try {
    const res = await req<{ result: ProbeResult }>("POST", `/admin/models/${enc(r.name)}/test?format=${fmt}`);
    probe.value[key] = res.result;
  } catch (e) {
    probe.value[key] = { ok: false, status: 0, format: fmt, error: (e as Error).message };
  } finally {
    testing.value[key] = false;
  }
}

/** Test every enabled route of a model in parallel (the row's "Test" action). */
async function testRow(r: Row) {
  const fmts = enabledFormats(r);
  if (!fmts.length) return;
  await Promise.all(fmts.map((f) => testModel(r, f)));
}

/** Test ONE slot on a route — pinned probe, no failover, no circuit impact.
 *  Independent state from testModel so the slot badge never clobbers the
 *  chain-level badge. Slot-indexed (not id) because a source may occupy several
 *  slots; the badge tracks the exact slot tested. */
async function testSource(r: Row, f: Fmt, i: number) {
  const key = `${r.name}:${f}:${i}`;
  if (srcTesting.value[key]) return;
  srcTesting.value[key] = true;
  try {
    const res = await req<{ result: ProbeResult }>("POST", `/admin/models/${enc(r.name)}/providers/test?format=${f}&index=${i}`);
    srcProbe.value[key] = res.result;
  } catch (e) {
    srcProbe.value[key] = { ok: false, status: 0, format: f, error: (e as Error).message };
  } finally {
    srcTesting.value[key] = false;
  }
}

async function doRemoveModel() {
  const r = confirmTarget.value;
  if (!r) return;
  removing.value[r.name] = true;
  try {
    await req("DELETE", `/admin/models/${enc(r.name)}`);
    models.value = models.value.filter((x) => x.name !== r.name);
    toast(t("models.removedToast", { name: r.name }), "success");
    confirmOpen.value = false;
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    removing.value[r.name] = false;
  }
}

/** Reorder the slots on a route. `order` is a permutation of the current chain
 *  indices (0..n-1); the server validates it. Optimistically applies the same
 *  permutation to the local chain and reverts on error. */
async function setPriority(r: Row, order: number[], fmt: Fmt) {
  const m = models.value.find((x) => x.name === r.name);
  if (!m) return;
  const prev = m[fmt].providers.slice();
  m[fmt].providers = order.map((i) => prev[i]);
  try {
    await req("PUT", `/admin/models/${enc(r.name)}/priority`, { format: fmt, order });
  } catch (e) {
    m[fmt].providers = prev;
    toast((e as Error).message, "error");
  }
}
function moveUp(r: Row, i: number, fmt: Fmt) {
  if (i === 0) return;
  const order = r[fmt].chain.map((_, k) => k);
  [order[i - 1], order[i]] = [order[i], order[i - 1]];
  setPriority(r, order, fmt);
}
function moveDown(r: Row, i: number, fmt: Fmt) {
  if (i >= r[fmt].chain.length - 1) return;
  const order = r[fmt].chain.map((_, k) => k);
  [order[i + 1], order[i]] = [order[i], order[i + 1]];
  setPriority(r, order, fmt);
}

/** Open the model-level "add source" dialog for this row. */
function openAddSource(r: Row) {
  addSourceTarget.value = r;
  addSourceOpen.value = true;
}

// --- per-slot upstream-model editing (on-demand, one slot at a time) ---
// Identity is the SLOT INDEX (not the provider id): a source may occupy several
// slots, each with its own upstream name, so editing/testing/mapping must target
// the exact slot. The ChainSrc's id is still used for display + source-global
// lookups (color, RPM, discovery) — just not for slot identity.

function draftKey(r: Row, f: Fmt, i: number): string {
  return `${r.name}:${f}:${i}`;
}
/** The single chain row whose upstream field is an <input> right now (entered via
 *  the ⋯ "edit" action or by clicking the mapped label; exited on blur). */
function isEditing(r: Row, f: Fmt, i: number): boolean {
  return mapEditingKey.value === draftKey(r, f, i);
}
function enterEdit(r: Row, f: Fmt, p: ChainSrc, i: number): void {
  const k = draftKey(r, f, i);
  mapDraft.value[k] = p.model ?? "";
  mapEditingKey.value = k;
}
/** Draft value bound to the input while editing. */
function mapVal(r: Row, f: Fmt, i: number): string {
  return mapDraft.value[draftKey(r, f, i)] ?? "";
}
function onMapInput(r: Row, f: Fmt, i: number, v: string): void {
  mapDraft.value[draftKey(r, f, i)] = v;
}
/** Commit the upstream field on blur/Enter. Idempotent: a no-op when the draft
 *  matches the committed value, so Enter→blur and Esc→blur don't double-write.
 *  Writes to the exact slot index (NOT a find-by-id, which would hit the first
 *  duplicate and mis-map a second slot under the same source). */
async function commitMap(r: Row, f: Fmt, p: ChainSrc, i: number): Promise<void> {
  const k = draftKey(r, f, i);
  mapEditingKey.value = "";
  const draft = (mapDraft.value[k] ?? "").trim();
  const cur = (p.model ?? "").trim();
  if (draft === cur) return;
  const m = models.value.find((x) => x.name === r.name);
  if (m) m[f].providers[i].model = draft || undefined;
  mapDraft.value[k] = draft; // keep in sync so a follow-up blur is a no-op
  try {
    await req("PUT", `/admin/models/${enc(r.name)}/map`, { format: f, index: i, model: draft });
    toast(t("models.mapSaved"), "success");
  } catch (e) {
    await load();
    toast((e as Error).message, "error");
  }
}
/** Esc: reset the draft to the committed value, then blur (→ commit is a no-op). */
function revertMap(r: Row, f: Fmt, p: ChainSrc, i: number, el: HTMLInputElement): void {
  mapDraft.value[draftKey(r, f, i)] = p.model ?? "";
  el.blur();
}

// --- per-source RPM cap editing (on-demand, one source at a time) ---
// rpm is a SOURCE property — the key's per-minute limit, shared across every
// model routed through this source (NOT per-model like the upstream name). So
// editing it from a model row updates the source globally; every row using that
// source reflects the new cap once providers reload.

/** The single source whose rpm field is an <input> right now (entered via the ⋯
 *  "rate limit" action or by clicking the rpm badge). */
const rpmEditingId = ref<string>("");
const rpmDraft = ref<string>("");
/** This source's configured RPM cap (0 = unlimited), read off the live provider. */
function srcRpm(pid: string): number {
  return providerById.value.get(pid)?.rpm ?? 0;
}
function isRpmEditing(p: ChainSrc): boolean {
  return rpmEditingId.value === p.id;
}
function enterRpmEdit(p: ChainSrc): void {
  rpmEditingId.value = p.id;
  rpmDraft.value = srcRpm(p.id) ? String(srcRpm(p.id)) : "";
}
function onRpmInput(v: string): void {
  rpmDraft.value = v;
}
/** Send a full provider PUT (the endpoint is a whole-resource update, not a
 *  patch) carrying the current fields plus the rpm override. apiKey omitted →
 *  server keeps the existing key; base URLs/formats unchanged → no rediscovery.
 *  Blank/0 clears the cap (back to unlimited). */
async function patchProviderRpm(id: string, rpm: number): Promise<void> {
  const cur = providerById.value.get(id);
  if (!cur) return;
  await req("PUT", `/admin/providers/${id}`, {
    name: cur.name,
    baseUrlOpenai: cur.baseUrlOpenai,
    baseUrlAnthropic: cur.baseUrlAnthropic,
    formats: cur.formats,
    supportsResponses: cur.supportsResponses ?? false,
    rpm,
  });
}
/** Commit on blur/Enter. No-op when the draft matches the current cap, so
 *  Enter→blur and Esc→blur don't double-write or clobber on revert. */
async function commitRpm(p: ChainSrc): Promise<void> {
  const id = p.id;
  rpmEditingId.value = "";
  const n = Number(rpmDraft.value);
  const rpm = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  if (rpm === srcRpm(id)) return;
  try {
    await patchProviderRpm(id, rpm);
    providers.value = providers.value.map((x) => (x.id === id ? { ...x, rpm } : x));
    toast(rpm ? t("sources.rpmSaved", { n: rpm }) : t("sources.rpmCleared"), rpm ? "success" : "default");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}
/** Esc: reset the draft to the current cap, then blur (→ commit is a no-op). */
function revertRpm(p: ChainSrc, el: HTMLInputElement): void {
  rpmDraft.value = srcRpm(p.id) ? String(srcRpm(p.id)) : "";
  el.blur();
}

/** Remove a single slot by index (NOT all slots for the source — a source may
 *  occupy several slots, and the per-row trash button removes just the one). */
async function removeSource(r: Row, fmt: Fmt, i: number) {
  const key = `${r.name}:${fmt}:${i}`;
  if (removingSrc.value[key]) return;
  removingSrc.value[key] = true;
  const m = models.value.find((x) => x.name === r.name);
  if (m) m[fmt].providers.splice(i, 1);
  try {
    await req("DELETE", `/admin/models/${enc(r.name)}/providers?format=${fmt}&index=${i}`);
    toast(t("models.sourceRemoved"), "success");
  } catch (e) {
    await load();
    toast((e as Error).message, "error");
  } finally {
    removingSrc.value[key] = false;
  }
}

async function refreshAll() {
  if (refreshingAll.value || !providers.value.length) return;
  refreshingAll.value = true;
  // Snapshot before load() reassigns providers; one bad source must not abort the rest.
  const list = providers.value;
  const results = await Promise.allSettled(
    list.map((p) => req("POST", `/admin/providers/${p.id}/discover`)),
  );
  await load();
  const failed = results
    .map((r, i) => (r.status === "rejected" ? list[i].name : null))
    .filter((x): x is string => !!x);
  if (!failed.length) {
    toast(t("sources.refreshAllDone"), "success");
  } else if (failed.length === list.length) {
    toast(t("sources.refreshAllFailed"), "error");
  } else {
    toast(t("sources.refreshAllPartial", { failed: failed.join("、") }), "error");
  }
  refreshingAll.value = false;
}

onMounted(load);
</script>

<template>
  <div class="space-y-4">
    <!-- Empty state: no sources yet -->
    <Card v-if="!loading && !providers.length">
      <CardContent class="flex flex-col items-center gap-3 py-12 text-center">
        <span class="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/15 text-primary">
          <ServerCog class="h-5 w-5" />
        </span>
        <div class="space-y-1">
          <div class="font-medium">{{ t("models.empty") }}</div>
          <p class="max-w-sm text-sm text-muted-foreground">{{ t("models.emptyHint") }}</p>
        </div>
        <Button @click="sourcesOpen = true">
          <Plus class="h-4 w-4" />{{ t("models.addSource") }}
        </Button>
      </CardContent>
    </Card>

    <template v-else>
      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-2 text-base">
            <Cpu class="h-4 w-4 text-primary" />
            {{ t("models.title") }}
          </CardTitle>
          <CardDescription>{{ t("models.desc") }}</CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <!-- toolbar -->
          <div class="flex flex-wrap items-center gap-2">
            <div class="relative min-w-[180px] flex-1">
              <Search class="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input v-model="query" :placeholder="t('models.searchPh')" class="pl-8" />
            </div>
            <Button size="sm" @click="addOpen = true">
              <Plus class="h-4 w-4" />{{ t("models.addModels") }}
            </Button>
            <Button variant="outline" size="sm" @click="sourcesOpen = true">
              <ServerCog class="h-4 w-4" />{{ t("models.manageSources") }}
            </Button>
          </div>

          <!-- legend: what the per-format chips mean -->
          <p class="text-xs text-muted-foreground">{{ t("models.chipLegend") }}</p>

          <p v-if="loading" class="py-6 text-center text-sm text-muted-foreground">{{ t("common.loading") }}</p>
          <p v-else-if="err" class="py-6 text-center text-sm text-destructive">{{ err }}</p>

          <template v-else>
            <!-- Enabled: one row per model with ≥1 route on. -->
            <section v-if="enabledRows.length" class="relative overflow-hidden rounded-lg border border-border/60 bg-card">
              <div class="pointer-events-none absolute inset-y-0 left-0 w-1 bg-primary" aria-hidden="true" />
              <div class="flex items-center gap-2.5 border-b border-border/60 bg-muted/30 px-3 py-2">
                <span class="h-2 w-2 shrink-0 rounded-full bg-primary" />
                <span class="text-sm font-semibold">{{ t("models.enabledSection") }}</span>
                <span class="ml-auto inline-flex items-center rounded-md bg-primary/15 px-1.5 py-0.5 text-xs font-medium tabular-nums text-primary">{{ enabledRows.length }}</span>
              </div>
              <div class="divide-y divide-border">
                <div v-for="r in enabledRows" :key="r.name" class="px-3 py-2.5">
                  <!-- summary row: the caret + name + chain summary are one
                       click target that expands the route editors. The caret
                       sits at the LEFT (tree-style disclosure) so it can't be
                       confused with the per-source Move up/down on the right. -->
                  <div class="flex items-center gap-3">
                    <!-- The summary row is a div(role=button) rather than a <button>
                         so it can nest the per-name copy <button> without invalid
                         markup (a <button> can't contain interactive descendants).
                         Enter/Space on the row toggles; the copy button stops click
                         propagation and owns its own keystrokes. -->
                    <div
                      role="button"
                      tabindex="0"
                      class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                      :aria-expanded="isExpanded(r.name)"
                      :aria-label="isExpanded(r.name) ? t('models.collapseAria') : t('models.expandAria')"
                      @click="toggleExpand(r.name)"
                      @keydown="onRowKeydown($event, r.name)"
                    >
                      <ChevronRight class="h-4 w-4 shrink-0 text-muted-foreground transition-transform" :class="{ 'rotate-90': isExpanded(r.name) }" />
                      <span class="flex min-w-0 flex-1 flex-col items-start">
                        <span class="flex w-full items-center gap-1.5">
                          <span class="truncate font-mono text-sm font-medium">{{ r.name }}</span>
                          <button
                            type="button"
                            :title="t('connect.copy')"
                            :aria-label="t('connect.copy')"
                            class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/50 transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            @click.stop="copyName(r.name)"
                          >
                            <Copy class="h-3 w-3" />
                          </button>
                          <Badge v-if="rowProbe(r)?.state === 'testing'" variant="muted" class="gap-1"><Loader2 class="h-3 w-3 animate-spin" />{{ t("models.probeTesting") }}</Badge>
                          <Badge v-else-if="rowProbe(r)?.state === 'ok'" variant="success" :title="t('models.probeOkHint', { name: rowProbe(r)?.provider ?? '' })">{{ t("models.probeOk") }}</Badge>
                          <Badge v-else-if="rowProbe(r)?.state === 'fail'" variant="destructive" :title="rowProbe(r)?.error || t('models.probeFailHint')">{{ t("models.probeFail") }} · {{ rowProbe(r)?.status || '?' }}</Badge>
                          <Badge v-else-if="isStaleAny(r)" variant="secondary" :title="t('models.delistedHint')">{{ t("models.delisted") }}</Badge>
                        </span>
                        <span class="w-full truncate text-xs text-muted-foreground">{{ summaryChain(r) }}</span>
                      </span>
                    </div>
                    <!-- per-format toggle chips -->
                    <div class="flex shrink-0 items-center gap-1.5">
                      <button
                        v-for="f in FORMATS"
                        :key="f"
                        type="button"
                        :disabled="fmtStatus(r, f) === 'unsupported' || enabling[`${r.name}:${f}`]"
                        :title="chipTitle(r, f)"
                        :aria-label="chipTitle(r, f)"
                        class="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium transition-colors disabled:cursor-not-allowed"
                        :class="chipClass(r, f)"
                        @click="toggle(r, f)"
                      >
                        <Loader2 v-if="enabling[`${r.name}:${f}`]" class="h-3 w-3 animate-spin" />
                        <span
                          v-else
                          class="rounded-full"
                          :class="fmtStatus(r, f) === 'enabled' ? 'h-1.5 w-1.5 bg-current' : fmtStatus(r, f) === 'enableable' ? 'h-1.5 w-1.5 border border-current' : 'h-1.5 w-1.5'"
                        />
                        {{ t(FMT_META[f].chip) }}
                      </button>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger>
                        <Button variant="ghost" size="icon" class="h-8 w-8 shrink-0 text-muted-foreground" :aria-label="t('models.moreActions')">
                          <MoreHorizontal class="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem :disabled="rowProbe(r)?.state === 'testing' || !enabledFormats(r).length" @select="testRow(r)">
                          <Loader2 v-if="rowProbe(r)?.state === 'testing'" class="animate-spin" />
                          <Zap v-else />
                          {{ t("models.testModel") }}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem class="text-destructive focus:bg-destructive/10 focus:text-destructive" @select="askRemoveModel(r)">
                          <Trash2 />
                          {{ t("models.removeModel") }}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  <!-- expanded: one chain editor per enabled route -->
                  <div v-if="isExpanded(r.name)" class="mt-2 space-y-3 rounded-md border bg-muted/30 p-2">
                    <div v-for="f in enabledFormats(r)" :key="f" class="space-y-1">
                      <!-- route sub-header: the per-format Test button + badge were
                           removed to cut button clutter — test the whole model from
                           the row's ⋯ menu (aggregate badge) or a single source from
                           the slot's ⋯ menu. testModel still runs per-format under
                           the hood via testRow; its result rolls up into rowProbe. -->
                      <div class="flex items-center gap-2 px-1">
                        <span class="h-2 w-2 rounded-full" :class="FMT_ACCENT[f].solid" />
                        <span class="text-xs font-semibold">{{ t(FMT_META[f].key) }}</span>
                        <span class="font-mono text-[11px] text-muted-foreground">{{ FMT_META[f].endpoint }}</span>
                      </div>
                      <div v-if="isStale(r, f)" class="flex items-start gap-2 rounded bg-muted px-2 py-1.5 text-xs text-muted-foreground">
                        <span class="shrink-0 font-medium">{{ t("models.delisted") }}</span>
                        <span>{{ t("models.delistedHint") }}</span>
                      </div>
                      <div v-if="!r[f].chain.length" class="px-1 py-1 text-xs text-muted-foreground">
                        {{ t("models.noSources") }}
                      </div>
                      <div
                        v-for="(p, i) in r[f].chain"
                        :key="i"
                        class="group flex items-center gap-2 rounded px-1 py-1 hover:bg-muted/40"
                      >
                        <span class="w-4 shrink-0 text-right text-xs text-muted-foreground">{{ i + 1 }}.</span>
                        <span class="flex items-center gap-1.5 text-sm">
                          <span class="h-1.5 w-1.5 rounded-full" :class="providerColor(p.id).solid" />
                          {{ p.name }}
                        </span>
                        <Badge v-if="i === 0" variant="default">{{ t("models.primary") }}</Badge>
                        <Badge v-else variant="muted">{{ t("models.fallback") }}</Badge>
                        <!-- RPM cap (source-global): an input while editing, otherwise a
                             clickable pill shown only when a cap is set. Uncapped sources
                             expose it via the ⋯ menu instead. -->
                        <span v-if="isRpmEditing(p)" class="flex items-center gap-1">
                          <Gauge class="h-3 w-3 text-muted-foreground" />
                          <input
                            v-focus
                            type="number"
                            min="0"
                            inputmode="numeric"
                            :value="rpmDraft"
                            :placeholder="t('sources.rpmPh')"
                            :aria-label="t('sources.rpmLabel')"
                            :title="t('sources.rpmHint')"
                            class="h-6 w-16 rounded-md border border-input bg-background px-2 font-mono text-xs shadow-sm transition-colors placeholder:font-sans placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                            @input="onRpmInput(($event.target as HTMLInputElement).value)"
                            @keyup.enter="($event.target as HTMLInputElement).blur()"
                            @keyup.esc="revertRpm(p, $event.target as HTMLInputElement)"
                            @blur="commitRpm(p)"
                          />
                        </span>
                        <button
                          v-else-if="srcRpm(p.id) > 0"
                          type="button"
                          :title="t('sources.rpmBadgeHint')"
                          class="inline-flex items-center gap-1 rounded-full border border-input bg-background px-2 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                          @click="enterRpmEdit(p)"
                        >
                          <Gauge class="h-3 w-3" />
                          {{ t("sources.rpmBadge", { n: srcRpm(p.id) }) }}
                        </button>
                        <!-- per-slot probe result (only for slots that have been tested) -->
                        <Badge v-if="srcTesting[`${r.name}:${f}:${i}`]" variant="muted" class="gap-1"><Loader2 class="h-3 w-3 animate-spin" />{{ t("models.probeTesting") }}</Badge>
                        <Badge v-else-if="srcProbe[`${r.name}:${f}:${i}`]?.ok" variant="success" :title="t('models.probeOkHint', { name: p.name })">{{ t("models.probeOk") }}</Badge>
                        <Badge v-else-if="srcProbe[`${r.name}:${f}:${i}`]" variant="destructive" :title="srcProbe[`${r.name}:${f}:${i}`]?.error || t('models.probeFailHint')">{{ t("models.probeFail") }} · {{ srcProbe[`${r.name}:${f}:${i}`]?.status || '?' }}</Badge>

                        <!-- upstream model sent to THIS slot: an always-visible label
                             when set (it's state), turned into an input only while editing. -->
                        <div v-if="isEditing(r, f, i)" class="flex items-center gap-1">
                          <span class="text-xs text-muted-foreground">→</span>
                          <input
                            v-focus
                            type="text"
                            :value="mapVal(r, f, i)"
                            :placeholder="t('models.upstreamPh')"
                            :aria-label="t('models.upstreamLabel')"
                            :title="t('models.upstreamHint')"
                            spellcheck="false"
                            class="h-6 w-40 rounded-md border border-input bg-background px-2 font-mono text-xs shadow-sm transition-colors placeholder:font-sans placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                            @input="onMapInput(r, f, i, ($event.target as HTMLInputElement).value)"
                            @keyup.enter="($event.target as HTMLInputElement).blur()"
                            @keyup.esc="revertMap(r, f, p, i, $event.target as HTMLInputElement)"
                            @blur="commitMap(r, f, p, i)"
                          />
                        </div>
                        <button
                          v-else-if="p.model"
                          type="button"
                          :title="t('models.upstreamHint')"
                          class="inline-flex items-center gap-1 rounded border border-transparent px-1.5 py-0.5 font-mono text-xs text-muted-foreground transition-colors hover:border-border hover:bg-background hover:text-foreground"
                          @click="enterEdit(r, f, p, i)"
                        >
                          <span>→</span>{{ p.model }}
                        </button>

                        <!-- row actions surface on hover, or while the row is focused. -->
                        <div class="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                          <Button variant="ghost" size="icon" class="h-7 w-7" :disabled="i === 0" :aria-label="t('models.moveUpAria')" @click="moveUp(r, i, f)">
                            <MoveUp class="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="icon" class="h-7 w-7" :disabled="i === r[f].chain.length - 1" :aria-label="t('models.moveDownAria')" @click="moveDown(r, i, f)">
                            <MoveDown class="h-4 w-4" />
                          </Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger>
                              <Button variant="ghost" size="icon" class="h-7 w-7 text-muted-foreground" :aria-label="t('models.moreActions')">
                                <MoreHorizontal class="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem :disabled="srcTesting[`${r.name}:${f}:${i}`]" @select="testSource(r, f, i)">
                                <Loader2 v-if="srcTesting[`${r.name}:${f}:${i}`]" class="animate-spin" />
                                <Zap v-else />
                                {{ t("models.testSource") }}
                              </DropdownMenuItem>
                              <DropdownMenuItem @select="enterEdit(r, f, p, i)">
                                <Pencil class="h-4 w-4" />
                                {{ t("models.editUpstream") }}
                              </DropdownMenuItem>
                              <DropdownMenuItem @select="enterRpmEdit(p)">
                                <Gauge class="h-4 w-4" />
                                {{ t("sources.rpmLabel") }}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem class="text-destructive focus:bg-destructive/10 focus:text-destructive" @select="removeSource(r, f, i)">
                                <Trash2 class="h-4 w-4" />
                                {{ t("models.removeSource") }}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>
                    </div>

                    <!-- model-level add: one source (optional upstream) → every route it speaks -->
                    <div v-if="addableFor(r).length" class="flex justify-center pt-1">
                      <Button variant="outline" size="sm" class="h-7 gap-1 border-dashed text-muted-foreground" @click="openAddSource(r)">
                        <Plus class="h-3.5 w-3.5" />
                        {{ t("models.addSourceToChain") }}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <!-- Available: discovered, not yet enabled anywhere. Same chips, all ○. -->
            <section class="relative overflow-hidden rounded-lg border border-border/60 bg-card">
              <div class="pointer-events-none absolute inset-y-0 left-0 w-1 bg-muted-foreground/40" aria-hidden="true" />
              <div class="flex items-center gap-2.5 border-b border-border/60 bg-muted/30 px-3 py-2">
                <button
                  type="button"
                  class="flex min-w-0 flex-1 items-center gap-2.5 rounded px-1 py-0.5 text-left hover:bg-muted/50"
                  @click="showAvailable = !showAvailable"
                >
                  <ChevronDown class="h-4 w-4 shrink-0 text-muted-foreground transition-transform" :class="{ '-rotate-90': !showAvailable }" />
                  <span class="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/40" />
                  <span class="text-sm font-semibold">{{ t("models.availableSection") }}</span>
                  <span class="ml-auto inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">{{ visibleAvailableRows.length }}</span>
                </button>
                <!-- chat-only filter: hides embeddings/audio/image/etc. so the
                     list isn't dominated by models this gateway won't route.
                     Surfaced only when there's non-chat noise to hide. -->
                <Button
                  v-if="nonChatAvailableCount > 0"
                  variant="ghost"
                  size="sm"
                  class="h-7 gap-1.5 px-2.5"
                  :class="hideNonChat ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'"
                  :title="hideNonChat ? t('models.filterChatHint', { n: nonChatAvailableCount }) : t('models.filterAllHint')"
                  @click="hideNonChat = !hideNonChat"
                >
                  <Filter class="h-3.5 w-3.5" />
                  {{ hideNonChat ? t("models.filterChatOnly") : t("models.filterInclude") }}
                </Button>
                <!-- refresh discovery for every source; repopulates this list
                     (surfaces newly-released upstream models). Lives here next to
                     enableAll because its whole job is to feed this list. -->
                <Button variant="ghost" size="sm" class="h-7 gap-1.5 px-2.5" :disabled="refreshingAll" :title="t('sources.refreshAll')" @click="refreshAll">
                  <Loader2 v-if="refreshingAll" class="h-3.5 w-3.5 animate-spin" />
                  <RefreshCw v-else class="h-3.5 w-3.5" />
                  {{ t("sources.refreshAll") }}
                </Button>
                <Button v-if="visibleAvailableRows.length" size="sm" variant="secondary" class="h-7 gap-1.5 px-2.5" :disabled="enablingAll" @click="enableAll">
                  <Loader2 v-if="enablingAll" class="h-3.5 w-3.5 animate-spin" />
                  <Zap v-else class="h-3.5 w-3.5" />
                  {{ t("models.enableAll") }}
                </Button>
              </div>
              <div v-if="showAvailable">
                <p v-if="!visibleAvailableRows.length" class="py-3 text-center text-xs text-muted-foreground">
                  {{ hideNonChat && availableRows.length ? t("models.availableAllFiltered", { n: nonChatAvailableCount }) : t("models.availableDesc") }}
                </p>
                <div v-else class="divide-y divide-border">
                  <div v-for="g in availableGrouped" :key="g.source.id">
                    <!-- source bucket header: dot + name + count, click to expand.
                         Large buckets collapse to just their count by default. -->
                    <button
                      type="button"
                      class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/40"
                      :aria-expanded="isSourceOpen(g.source.id, g.rows.length)"
                      :aria-label="g.source.name"
                      @click="toggleSource(g.source.id, g.rows.length)"
                    >
                      <ChevronRight class="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform" :class="{ 'rotate-90': isSourceOpen(g.source.id, g.rows.length) }" />
                      <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="providerColor(g.source.id).solid" />
                      <span class="text-sm font-medium">{{ g.source.name }}</span>
                      <span class="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">{{ g.rows.length }}</span>
                    </button>
                    <div v-if="isSourceOpen(g.source.id, g.rows.length)" class="divide-y divide-border/50 bg-muted/10">
                      <div
                        v-for="r in g.rows"
                        :key="r.name"
                        class="flex items-center justify-between gap-2 px-3 py-2 pl-9"
                      >
                        <div class="flex min-w-0 items-center gap-1.5">
                          <span class="truncate font-mono text-sm">{{ r.name }}</span>
                          <button
                            type="button"
                            :title="t('connect.copy')"
                            :aria-label="t('connect.copy')"
                            class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/50 transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            @click="copyName(r.name)"
                          >
                            <Copy class="h-3 w-3" />
                          </button>
                        </div>
                        <!-- per-format toggle chips: every offered route is ○ (click to enable) -->
                        <div class="flex shrink-0 items-center gap-1.5">
                          <button
                            v-for="f in FORMATS"
                            :key="f"
                            type="button"
                            :disabled="fmtStatus(r, f) === 'unsupported' || enabling[`${r.name}:${f}`]"
                            :title="chipTitle(r, f)"
                            :aria-label="chipTitle(r, f)"
                            class="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium transition-colors disabled:cursor-not-allowed"
                            :class="chipClass(r, f)"
                            @click="toggle(r, f)"
                          >
                            <Loader2 v-if="enabling[`${r.name}:${f}`]" class="h-3 w-3 animate-spin" />
                            <span
                              v-else
                              class="rounded-full"
                              :class="fmtStatus(r, f) === 'enabled' ? 'h-1.5 w-1.5 bg-current' : fmtStatus(r, f) === 'enableable' ? 'h-1.5 w-1.5 border border-current' : 'h-1.5 w-1.5'"
                            />
                            {{ t(FMT_META[f].chip) }}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </template>
        </CardContent>
      </Card>
    </template>

    <SourcesDialog v-model:open="sourcesOpen" @changed="load" />

    <AddModelsDialog v-model:open="addOpen" :providers="providers" @changed="load" />

    <AddSourceDialog
      v-model:open="addSourceOpen"
      :model-name="addSourceTarget?.name ?? ''"
      :providers="providers"
      :enabled-formats="addSourceTarget ? enabledFormats(addSourceTarget) : []"
      :chain-by-format="addSourceTarget ? chainByFormat(addSourceTarget) : {}"
      @added="load"
    />

    <ConfirmDialog
      v-model:open="confirmOpen"
      variant="destructive"
      :title="t('models.removeModel')"
      :description="confirmTarget ? t('models.confirmRemove', { name: confirmTarget.name }) : ''"
      :confirm-text="t('models.removeModel')"
      :loading="confirmTarget ? !!removing[confirmTarget.name] : false"
      @confirm="doRemoveModel"
    />
  </div>
</template>
