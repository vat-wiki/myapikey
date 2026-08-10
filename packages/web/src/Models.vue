<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { req, type ModelView, type ProviderPublic } from "@/api";
import { FMT_ACCENT, providerColor } from "@/lib/format";
import { toast } from "@/lib/toast";
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

/** Every source that can still attach to ≥1 enabled route of this model —
 *  candidates for the model-level "add source" dialog. */
function addableFor(r: Row): ProviderPublic[] {
  const enabled = enabledFormats(r);
  return providers.value.filter((p) => enabled.some((f) => supportsFmt(p, f) && !r[f].chain.some((c) => c.id === p.id)));
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
function joinChain(chain: ChainSrc[]): string {
  return chain.length ? chain.map((p) => p.name).join(" → ") : t("models.noSourcesShort");
}
/** One-line chain summary across every enabled route, shown under the name. */
function summaryChain(r: Row): string {
  return enabledFormats(r).map((f) => `${t(FMT_META[f].chip)}: ${joinChain(r[f].chain)}`).join("  ·  ");
}
/** Capability tags for a chain source: its wire formats plus /responses when
 *  supported — all rendered as colored family badges. */
function srcTags(id: string): Fmt[] {
  const p = providerById.value.get(id);
  if (!p) return [];
  const tags = p.formats.filter((f): f is Fmt => f === "openai" || f === "anthropic");
  if (p.supportsResponses) tags.push("responses");
  return tags;
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
  for (const r of availableRows.value) {
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

/** Test ONE source on a route — pinned probe, no failover, no circuit impact.
 *  Independent state from testModel so the source-row badge never clobbers the
 *  chain-level badge. */
async function testSource(r: Row, f: Fmt, p: ChainSrc) {
  const key = `${r.name}:${f}:${p.id}`;
  if (srcTesting.value[key]) return;
  srcTesting.value[key] = true;
  try {
    const res = await req<{ result: ProbeResult }>("POST", `/admin/models/${enc(r.name)}/providers/${enc(p.id)}/test?format=${f}`);
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

async function setPriority(r: Row, ids: string[], fmt: Fmt) {
  const m = models.value.find((x) => x.name === r.name);
  if (!m) return;
  const prev = m[fmt].providers.slice();
  m[fmt].providers = ids.map((id) => prev.find((p) => p.id === id)!).filter(Boolean);
  try {
    await req("PUT", `/admin/models/${enc(r.name)}/priority`, { format: fmt, providers: ids });
  } catch (e) {
    m[fmt].providers = prev;
    toast((e as Error).message, "error");
  }
}
function moveUp(r: Row, i: number, fmt: Fmt) {
  if (i === 0) return;
  const ids = r[fmt].chain.map((p) => p.id);
  [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
  setPriority(r, ids, fmt);
}
function moveDown(r: Row, i: number, fmt: Fmt) {
  const ids = r[fmt].chain.map((p) => p.id);
  if (i >= ids.length - 1) return;
  [ids[i + 1], ids[i]] = [ids[i], ids[i + 1]];
  setPriority(r, ids, fmt);
}

/** Open the model-level "add source" dialog for this row. */
function openAddSource(r: Row) {
  addSourceTarget.value = r;
  addSourceOpen.value = true;
}

// --- per-source upstream-model editing (on-demand, one row at a time) ---

function draftKey(r: Row, f: Fmt, p: ChainSrc): string {
  return `${r.name}:${f}:${p.id}`;
}
/** The single chain row whose upstream field is an <input> right now (entered via
 *  the ⋯ "edit" action or by clicking the mapped label; exited on blur). */
function isEditing(r: Row, f: Fmt, p: ChainSrc): boolean {
  return mapEditingKey.value === draftKey(r, f, p);
}
function enterEdit(r: Row, f: Fmt, p: ChainSrc): void {
  const k = draftKey(r, f, p);
  mapDraft.value[k] = p.model ?? "";
  mapEditingKey.value = k;
}
/** Draft value bound to the input while editing. */
function mapVal(r: Row, f: Fmt, p: ChainSrc): string {
  return mapDraft.value[draftKey(r, f, p)] ?? "";
}
function onMapInput(r: Row, f: Fmt, p: ChainSrc, v: string): void {
  mapDraft.value[draftKey(r, f, p)] = v;
}
/** Commit the upstream field on blur/Enter. Idempotent: a no-op when the draft
 *  matches the committed value, so Enter→blur and Esc→blur don't double-write. */
async function commitMap(r: Row, f: Fmt, p: ChainSrc): Promise<void> {
  const k = draftKey(r, f, p);
  mapEditingKey.value = "";
  const draft = (mapDraft.value[k] ?? "").trim();
  const cur = (p.model ?? "").trim();
  if (draft === cur) return;
  const m = models.value.find((x) => x.name === r.name);
  if (m) {
    const idx = m[f].providers.findIndex((x) => x.id === p.id);
    if (idx >= 0) m[f].providers[idx].model = draft || undefined;
  }
  mapDraft.value[k] = draft; // keep in sync so a follow-up blur is a no-op
  try {
    await req("PUT", `/admin/models/${enc(r.name)}/map`, { format: f, providerId: p.id, model: draft });
    toast(t("models.mapSaved"), "success");
  } catch (e) {
    await load();
    toast((e as Error).message, "error");
  }
}
/** Esc: reset the draft to the committed value, then blur (→ commit is a no-op). */
function revertMap(r: Row, f: Fmt, p: ChainSrc, el: HTMLInputElement): void {
  mapDraft.value[draftKey(r, f, p)] = p.model ?? "";
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

async function removeSource(r: Row, pid: string, fmt: Fmt) {
  const key = `${r.name}:${pid}:${fmt}`;
  if (removingSrc.value[key]) return;
  removingSrc.value[key] = true;
  const m = models.value.find((x) => x.name === r.name);
  if (m) m[fmt].providers = m[fmt].providers.filter((p) => p.id !== pid);
  try {
    await req("DELETE", `/admin/models/${enc(r.name)}/providers/${pid}?format=${fmt}`);
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
            <Button variant="outline" size="sm" :disabled="refreshingAll" @click="refreshAll">
              <Loader2 v-if="refreshingAll" class="h-4 w-4 animate-spin" />
              <RefreshCw v-else class="h-4 w-4" />{{ t("sources.refreshAll") }}
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
                    <button
                      type="button"
                      class="flex min-w-0 flex-1 items-center gap-2 text-left"
                      :aria-expanded="isExpanded(r.name)"
                      :aria-label="isExpanded(r.name) ? t('models.collapseAria') : t('models.expandAria')"
                      @click="toggleExpand(r.name)"
                    >
                      <ChevronRight class="h-4 w-4 shrink-0 text-muted-foreground transition-transform" :class="{ 'rotate-90': isExpanded(r.name) }" />
                      <span class="flex min-w-0 flex-1 flex-col items-start">
                        <span class="flex w-full items-center gap-2">
                          <span class="truncate font-mono text-sm font-medium">{{ r.name }}</span>
                          <Badge v-if="rowProbe(r)?.state === 'testing'" variant="muted" class="gap-1"><Loader2 class="h-3 w-3 animate-spin" />{{ t("models.probeTesting") }}</Badge>
                          <Badge v-else-if="rowProbe(r)?.state === 'ok'" variant="success" :title="t('models.probeOkHint', { name: rowProbe(r)?.provider ?? '' })">{{ t("models.probeOk") }}</Badge>
                          <Badge v-else-if="rowProbe(r)?.state === 'fail'" variant="destructive" :title="rowProbe(r)?.error || t('models.probeFailHint')">{{ t("models.probeFail") }} · {{ rowProbe(r)?.status || '?' }}</Badge>
                          <Badge v-else-if="isStaleAny(r)" variant="secondary" :title="t('models.delistedHint')">{{ t("models.delisted") }}</Badge>
                        </span>
                        <span class="w-full truncate text-xs text-muted-foreground">{{ summaryChain(r) }}</span>
                      </span>
                    </button>
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
                      <!-- route sub-header + per-route test -->
                      <div class="flex items-center gap-2 px-1">
                        <span class="h-2 w-2 rounded-full" :class="FMT_ACCENT[f].solid" />
                        <span class="text-xs font-semibold">{{ t(FMT_META[f].key) }}</span>
                        <span class="font-mono text-[11px] text-muted-foreground">{{ FMT_META[f].endpoint }}</span>
                        <div class="ml-auto flex items-center gap-1.5">
                          <Badge v-if="probe[`${r.name}:${f}`]?.ok" variant="success" :title="t('models.probeOkHint', { name: probe[`${r.name}:${f}`]?.provider ?? '' })">{{ t("models.probeOk") }}</Badge>
                          <Badge v-else-if="probe[`${r.name}:${f}`]" variant="destructive" :title="probe[`${r.name}:${f}`]?.error || t('models.probeFailHint')">{{ t("models.probeFail") }} · {{ probe[`${r.name}:${f}`]?.status || '?' }}</Badge>
                          <Button variant="ghost" size="sm" class="h-6 gap-1 px-2 text-xs" :disabled="testing[`${r.name}:${f}`]" @click="testModel(r, f)">
                            <Loader2 v-if="testing[`${r.name}:${f}`]" class="h-3 w-3 animate-spin" />
                            <Zap v-else class="h-3 w-3" />
                            {{ t("models.testModel") }}
                          </Button>
                        </div>
                      </div>
                      <div v-if="isStale(r, f) && !probe[`${r.name}:${f}`]" class="flex items-start gap-2 rounded bg-muted px-2 py-1.5 text-xs text-muted-foreground">
                        <span class="shrink-0 font-medium">{{ t("models.delisted") }}</span>
                        <span>{{ t("models.delistedHint") }}</span>
                      </div>
                      <div v-if="!r[f].chain.length" class="px-1 py-1 text-xs text-muted-foreground">
                        {{ t("models.noSources") }}
                      </div>
                      <div
                        v-for="(p, i) in r[f].chain"
                        :key="p.id"
                        class="group flex items-center gap-2 rounded px-1 py-1 hover:bg-muted/40"
                      >
                        <span class="w-4 shrink-0 text-right text-xs text-muted-foreground">{{ i + 1 }}.</span>
                        <span class="flex items-center gap-1.5 text-sm">
                          <span class="h-1.5 w-1.5 rounded-full" :class="providerColor(p.id).solid" />
                          {{ p.name }}
                        </span>
                        <Badge v-for="tag in srcTags(p.id)" :key="tag" variant="secondary" :class="FMT_ACCENT[tag].badge">{{ t(FMT_META[tag].chip) }}</Badge>
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
                        <!-- per-source probe result (only for sources that have been tested) -->
                        <Badge v-if="srcTesting[`${r.name}:${f}:${p.id}`]" variant="muted" class="gap-1"><Loader2 class="h-3 w-3 animate-spin" />{{ t("models.probeTesting") }}</Badge>
                        <Badge v-else-if="srcProbe[`${r.name}:${f}:${p.id}`]?.ok" variant="success" :title="t('models.probeOkHint', { name: p.name })">{{ t("models.probeOk") }}</Badge>
                        <Badge v-else-if="srcProbe[`${r.name}:${f}:${p.id}`]" variant="destructive" :title="srcProbe[`${r.name}:${f}:${p.id}`]?.error || t('models.probeFailHint')">{{ t("models.probeFail") }} · {{ srcProbe[`${r.name}:${f}:${p.id}`]?.status || '?' }}</Badge>

                        <!-- upstream model sent to THIS source: an always-visible label
                             when set (it's state), turned into an input only while editing. -->
                        <div v-if="isEditing(r, f, p)" class="flex items-center gap-1">
                          <span class="text-xs text-muted-foreground">→</span>
                          <input
                            v-focus
                            type="text"
                            :value="mapVal(r, f, p)"
                            :placeholder="t('models.upstreamPh')"
                            :aria-label="t('models.upstreamLabel')"
                            :title="t('models.upstreamHint')"
                            spellcheck="false"
                            class="h-6 w-40 rounded-md border border-input bg-background px-2 font-mono text-xs shadow-sm transition-colors placeholder:font-sans placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                            @input="onMapInput(r, f, p, ($event.target as HTMLInputElement).value)"
                            @keyup.enter="($event.target as HTMLInputElement).blur()"
                            @keyup.esc="revertMap(r, f, p, $event.target as HTMLInputElement)"
                            @blur="commitMap(r, f, p)"
                          />
                        </div>
                        <button
                          v-else-if="p.model"
                          type="button"
                          :title="t('models.upstreamHint')"
                          class="inline-flex items-center gap-1 rounded border border-transparent px-1.5 py-0.5 font-mono text-xs text-muted-foreground transition-colors hover:border-border hover:bg-background hover:text-foreground"
                          @click="enterEdit(r, f, p)"
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
                              <DropdownMenuItem :disabled="srcTesting[`${r.name}:${f}:${p.id}`]" @select="testSource(r, f, p)">
                                <Loader2 v-if="srcTesting[`${r.name}:${f}:${p.id}`]" class="animate-spin" />
                                <Zap v-else />
                                {{ t("models.testSource") }}
                              </DropdownMenuItem>
                              <DropdownMenuItem @select="enterEdit(r, f, p)">
                                <Pencil class="h-4 w-4" />
                                {{ t("models.editUpstream") }}
                              </DropdownMenuItem>
                              <DropdownMenuItem @select="enterRpmEdit(p)">
                                <Gauge class="h-4 w-4" />
                                {{ t("sources.rpmLabel") }}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem class="text-destructive focus:bg-destructive/10 focus:text-destructive" @select="removeSource(r, p.id, f)">
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
                  <span class="ml-auto inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">{{ availableRows.length }}</span>
                </button>
                <Button v-if="availableRows.length" size="sm" variant="secondary" class="h-7 gap-1.5 px-2.5" :disabled="enablingAll" @click="enableAll">
                  <Loader2 v-if="enablingAll" class="h-3.5 w-3.5 animate-spin" />
                  <Zap v-else class="h-3.5 w-3.5" />
                  {{ t("models.enableAll") }}
                </Button>
              </div>
              <div v-if="showAvailable" class="divide-y divide-border">
                <p v-if="!availableRows.length" class="py-3 text-center text-xs text-muted-foreground">
                  {{ t("models.availableDesc") }}
                </p>
                <div v-for="r in availableRows" :key="r.name" class="flex items-center justify-between gap-2 px-3 py-2">
                  <div class="flex min-w-0 items-center gap-2">
                    <span class="truncate font-mono text-sm">{{ r.name }}</span>
                    <div class="hidden gap-1 sm:flex">
                      <Badge v-for="o in r.offering" :key="o.id" variant="secondary" :class="providerColor(o.id).badge">{{ o.name }}</Badge>
                    </div>
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
