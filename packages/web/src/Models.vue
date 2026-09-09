<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { req, type ModelView, type ModelProvider, type ProviderPublic } from "@/api";
import type { Fmt } from "@/lib/format";
import { FMT_ACCENT, providerColor } from "@/lib/format";
import { toast } from "@/lib/toast";
import { copyText } from "@/lib/clipboard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import {
  Search, Plus, Loader2, Copy, Zap, Gauge, MoreHorizontal, Pencil, Trash2,
  Cpu, ServerCog, TriangleAlert, ArrowRight, Brain, Check, LayoutGrid, Table2, ChevronDown, ChevronUp,
} from "lucide-vue-next";
import ModelEditor from "@/ModelEditor.vue";
import ConfirmDialog from "@/ConfirmDialog.vue";

const emit = defineEmits<{ goto: [string] }>();
const { t } = useI18n();

// --- card / table view ---

type ViewMode = "cards" | "table";
const VIEW_KEY = "myapikey.view.models";
const view = ref<ViewMode>(localStorage.getItem(VIEW_KEY) === "table" ? "table" : "cards");
function setView(v: ViewMode) {
  view.value = v;
  try {
    localStorage.setItem(VIEW_KEY, v);
  } catch {
    /* storage unavailable — keep the in-memory choice */
  }
}

const FORMATS: Fmt[] = ["openai", "anthropic", "responses"];
const FMT_META: Record<Fmt, { label: string; endpoint: string }> = {
  openai: { label: "models.fmtOpenai", endpoint: "/chat/completions" },
  anthropic: { label: "models.fmtAnthropic", endpoint: "/messages" },
  responses: { label: "models.fmtResponses", endpoint: "/responses" },
};

const models = ref<ModelView[]>([]);
const providers = ref<ProviderPublic[]>([]);
const loading = ref(false);
const err = ref("");
const query = ref("");

// --- editor / rename / delete ---

const editorOpen = ref(false);
const editing = ref<ModelView | null>(null);
const creating = ref(false);

function openEditor(m: ModelView | null) {
  editing.value = m;
  creating.value = false;
  editorOpen.value = true;
}
function openCreate() {
  editing.value = null;
  creating.value = true;
  editorOpen.value = true;
}
function onEditorSaved() {
  load();
}

const renameOpen = ref(false);
const renameTarget = ref<ModelView | null>(null);
const renameValue = ref("");
const renaming = ref(false);

function askRename(m: ModelView) {
  renameTarget.value = m;
  renameValue.value = m.name;
  renameOpen.value = true;
}

async function doRename() {
  const m = renameTarget.value;
  const next = renameValue.value.trim();
  if (!m || !next || next === m.name) return;
  renaming.value = true;
  try {
    await req("POST", `/admin/models/${enc(m.name)}/rename`, { name: next });
    await load();
    toast(t("models.renamedToast", { from: m.name, to: next }), "success");
    renameOpen.value = false;
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    renaming.value = false;
  }
}

const enc = encodeURIComponent;

const confirmTarget = ref<ModelView | null>(null);
const confirmOpen = ref(false);
const removing = ref(false);

async function doRemove() {
  const m = confirmTarget.value;
  if (!m) return;
  removing.value = true;
  try {
    await req("DELETE", `/admin/models/${enc(m.name)}`);
    models.value = models.value.filter((x) => x.name !== m.name);
    toast(t("models.removedToast", { name: m.name }), "success");
    confirmOpen.value = false;
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    removing.value = false;
  }
}

// --- data ---

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

onMounted(load);

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  return models.value.filter((m) => !q || m.name.toLowerCase().includes(q));
});

function enabledFormats(m: ModelView): Fmt[] {
  return FORMATS.filter((f) => m[f].enabled);
}

/** Chain lines under the name: formats that have slots are grouped into one
 *  line per (enabled flag + identical chain) — a shared chain reads as one
 *  plain flow instead of per-protocol repetition, divergent chains get their
 *  own labeled line. `fs` lists every format the line stands for; per-slot
 *  probes fan out over them. */
interface ChainLine { fs: Fmt[]; enabled: boolean; slots: ModelProvider[]; key: string }
const chainLines = (m: ModelView): ChainLine[] => {
  const key = (slots: ModelProvider[]) => slots.map((s) => `${s.id}|${s.model ?? ""}|${s.thinking ?? ""}`).join(">");
  const merged: ChainLine[] = [];
  for (const f of FORMATS) {
    if (!m[f].providers.length) continue;
    const k = `${m[f].enabled}|${key(m[f].providers)}`;
    const prev = merged.find((l) => l.key === k);
    if (prev) prev.fs.push(f);
    else merged.push({ fs: [f], enabled: m[f].enabled, slots: m[f].providers, key: k });
  }
  return merged;
};

// --- chain collapse: at-a-glance shows the first slot, the rest expand on demand ---
const chainExpanded = ref<Record<string, boolean>>({});

/** Slots to render — all when expanded, otherwise just the highest-priority one. */
function visibleSlots(m: ModelView, line: ChainLine): { s: ModelProvider; i: number }[] {
  return line.slots
    .map((s, i) => ({ s, i }))
    .filter((x) => chainExpanded.value[m.name] || x.i === 0);
}
function hiddenCount(m: ModelView, line: ChainLine): number {
  return chainExpanded.value[m.name] ? 0 : line.slots.length - 1;
}

/** Chip state: on (route enabled), off (chain exists but route disabled),
 *  none (no chain to enable — must be configured in the editor). */
type ChipState = "on" | "off" | "none";
function chipState(m: ModelView, f: Fmt): ChipState {
  if (m[f].enabled) return "on";
  return m[f].providers.length ? "off" : "none";
}
function chipClass(m: ModelView, f: Fmt): string {
  const s = chipState(m, f);
  if (s === "on") return `border-transparent ${FMT_ACCENT[f].solid} text-white shadow-sm`;
  if (s === "off") return "border-dashed border-input text-muted-foreground hover:bg-accent hover:text-accent-foreground";
  return "border-transparent text-muted-foreground/40";
}
function chipTitle(m: ModelView, f: Fmt): string {
  const s = chipState(m, f);
  if (s === "on") return `${t(FMT_META[f].label)} · ${t("models.chipOn")}`;
  if (s === "off") return `${t(FMT_META[f].label)} · ${t("models.chipOff")}`;
  return `${t(FMT_META[f].label)} · ${t("models.chipNa")}`;
}

/** Quick route toggle straight from the card: a single-format PUT (the upsert
 *  only replaces the format keys present in the body, so the other routes,
 *  mappings and pace are untouched). */
async function toggleFmt(m: ModelView, f: Fmt) {
  if (chipState(m, f) === "none") return;
  const slots = m[f].providers.map((s) => ({
    id: s.id,
    ...(s.model ? { model: s.model } : {}),
    ...(s.thinking ? { thinking: s.thinking } : {}),
  }));
  try {
    await req("PUT", `/admin/models/${enc(m.name)}`, { [f]: { enabled: !m[f].enabled, slots } });
    m[f].enabled = !m[f].enabled;
    toast(t(m[f].enabled ? "models.enabledToast" : "models.disabledToast", { name: `${m.name} [${f}]` }), "success");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

/** A slot's effective upstream (its mapping, or the public name sent verbatim)
 *  is what discovery can confirm — a custom public name is expected to be
 *  absent from the source's list, so staleness is judged on this. */
function isStale(m: ModelView, f: Fmt): boolean {
  const c = m[f].providers;
  if (!c.length) return false;
  const list = (id: string) => providers.value.find((p) => p.id === id)?.discoveredModels ?? [];
  return !c.some((s) => list(s.id).includes(s.model ?? m.name)) && c.some((s) => list(s.id).length > 0);
}
function isStaleAny(m: ModelView): boolean {
  return enabledFormats(m).some((f) => isStale(m, f));
}

// --- probe ---

interface ProbeResult { ok: boolean; status: number; provider?: string; format: string; error?: string }
const testing = ref<Record<string, boolean>>({});
const probe = ref<Record<string, ProbeResult>>({});

/** Test every enabled route; the badge aggregates (ok if any route passed). */
async function testModel(m: ModelView) {
  const fmts = enabledFormats(m);
  if (!fmts.length) return;
  for (const f of fmts) testing.value[`${m.name}:${f}`] = true;
  await Promise.all(fmts.map(async (f) => {
    const key = `${m.name}:${f}`;
    try {
      const r = await req<{ result: ProbeResult }>("POST", `/admin/models/${enc(m.name)}/test?format=${f}`);
      probe.value[key] = r.result;
    } catch (e) {
      probe.value[key] = { ok: false, status: 0, format: f, error: (e as Error).message };
    } finally {
      testing.value[key] = false;
    }
  }));
}
function rowProbe(m: ModelView): { state: "testing" | "ok" | "fail"; status?: number; provider?: string; error?: string } | null {
  let testingAny = false;
  let ok: ProbeResult | null = null;
  let fail: ProbeResult | null = null;
  for (const f of enabledFormats(m)) {
    const key = `${m.name}:${f}`;
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

// --- per-slot probe ---
// The old per-source "测试该来源" entry, restored: `POST /models/:name/providers/test`
// pins the loopback call to ONE chain slot (no failover, no circuit impact), so it
// answers "does the model work on THIS source under THIS protocol?". A collapsed
// line stands for several formats — the probe fans out over all of them and the
// badge aggregates (same rule as the whole-model badge: ok if any route passed);
// the tooltip keeps the per-protocol truth.

const slotTesting = ref<Record<string, boolean>>({});
const slotProbe = ref<Record<string, ProbeResult>>({});

async function testSlot(m: ModelView, line: ChainLine, i: number) {
  const fmts = line.fs.filter((f) => !slotTesting.value[`${m.name}:${f}:${i}`]);
  if (!fmts.length) return;
  for (const f of fmts) slotTesting.value[`${m.name}:${f}:${i}`] = true;
  await Promise.all(fmts.map(async (f) => {
    const key = `${m.name}:${f}:${i}`;
    try {
      const r = await req<{ result: ProbeResult }>("POST", `/admin/models/${enc(m.name)}/providers/test?format=${f}&index=${i}`);
      slotProbe.value[key] = r.result;
    } catch (e) {
      slotProbe.value[key] = { ok: false, status: 0, format: f, error: (e as Error).message };
    } finally {
      slotTesting.value[key] = false;
    }
  }));
}

function slotProbeState(m: ModelView, line: ChainLine, i: number): { state: "testing" | "ok" | "fail"; status?: number; provider?: string; error?: string } | null {
  let testingAny = false;
  let ok: ProbeResult | null = null;
  let fail: ProbeResult | null = null;
  for (const f of line.fs) {
    const key = `${m.name}:${f}:${i}`;
    if (slotTesting.value[key]) testingAny = true;
    const pr = slotProbe.value[key];
    if (pr?.ok && !ok) ok = pr;
    else if (pr && !pr.ok && !fail) fail = pr;
  }
  if (testingAny) return { state: "testing" };
  if (ok) return { state: "ok", provider: ok.provider };
  if (fail) return { state: "fail", status: fail.status, error: fail.error };
  return null;
}

/** Slot capsule look: neutral until a probe lands, then it tints. */
function slotChipClass(m: ModelView, line: ChainLine, si: number): string {
  const st = slotProbeState(m, line, si);
  if (st?.state === "ok") return "border-emerald-500/40 bg-emerald-500/10";
  if (st?.state === "fail") return "border-destructive/40 bg-destructive/10";
  return "border-transparent bg-muted/60";
}

/** Tooltip: one line per probed format, e.g. "OpenAI ✓ 可用 (ark)" / "Anthropic ✗ 401 …". */
function slotProbeTitle(m: ModelView, line: ChainLine, i: number): string {
  return line.fs.map((f) => {
    const pr = slotProbe.value[`${m.name}:${f}:${i}`];
    const label = t(FMT_META[f].label);
    if (!pr) return label;
    if (pr.ok) return `${label} ✓ ${t("models.probeOk")}${pr.provider ? ` (${pr.provider})` : ""}`;
    return `${label} ✗ ${pr.status || "?"}${pr.error ? ` ${pr.error}` : ""}`;
  }).join("\n");
}

async function copyName(name: string) {
  const ok = await copyText(name);
  toast(ok ? t("connect.copied") : t("connect.copyFailed"), ok ? "success" : "error");
}
</script>

<template>
  <div class="space-y-4">
  <!-- toolbar -->
  <div class="flex flex-wrap items-center gap-2">
    <div class="relative min-w-[180px] flex-1">
      <Search class="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input v-model="query" :placeholder="t('models.searchPh')" class="pl-8" />
    </div>
    <div class="flex items-center rounded-md border p-0.5">
      <Button
        variant="ghost" size="icon" class="h-6 w-6"
        :class="view === 'cards' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'"
        :title="t('common.viewCards')" :aria-label="t('common.viewCards')"
        @click="setView('cards')"
      ><LayoutGrid class="h-3.5 w-3.5" /></Button>
      <Button
        variant="ghost" size="icon" class="h-6 w-6"
        :class="view === 'table' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'"
        :title="t('common.viewTable')" :aria-label="t('common.viewTable')"
        @click="setView('table')"
      ><Table2 class="h-3.5 w-3.5" /></Button>
    </div>
    <Button @click="openCreate()">
      <Plus class="h-4 w-4" />{{ t("models.newModel") }}
    </Button>
  </div>

    <p v-if="loading" class="py-8 text-center text-sm text-muted-foreground">{{ t("common.loading") }}</p>
    <p v-else-if="err" class="py-8 text-center text-sm text-destructive">{{ err }}</p>

    <!-- empty: no sources at all -->
    <Card v-else-if="!providers.length && !models.length">
      <CardContent class="flex flex-col items-center gap-3 py-12 text-center">
        <span class="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/15 text-primary">
          <ServerCog class="h-5 w-5" />
        </span>
        <div class="space-y-1">
          <div class="font-medium">{{ t("models.emptyNoSources") }}</div>
          <p class="max-w-sm text-sm text-muted-foreground">{{ t("models.emptyNoSourcesHint") }}</p>
        </div>
        <Button @click="emit('goto', 'sources')">
          <Plus class="h-4 w-4" />{{ t("sources.add") }}
        </Button>
      </CardContent>
    </Card>

    <!-- empty: sources exist, no models -->
    <Card v-else-if="!filtered.length && !query">
      <CardContent class="flex flex-col items-center gap-3 py-12 text-center">
        <span class="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/15 text-primary">
          <Cpu class="h-5 w-5" />
        </span>
        <div class="space-y-1">
          <div class="font-medium">{{ t("models.emptyNoModels") }}</div>
          <p class="max-w-sm text-sm text-muted-foreground">{{ t("models.emptyNoModelsHint") }}</p>
        </div>
        <Button @click="openCreate()">
          <Plus class="h-4 w-4" />{{ t("models.newModel") }}
        </Button>
      </CardContent>
    </Card>

    <p v-else-if="!filtered.length" class="py-8 text-center text-sm text-muted-foreground">{{ t("models.noMatch") }}</p>

    <!-- model cards -->
    <div v-else-if="view === 'cards'" class="grid items-stretch gap-3 md:grid-cols-2">
      <Card
        v-for="m in filtered"
        :key="m.name"
        class="group cursor-pointer gap-0 py-0 transition-colors hover:bg-muted/30"
        @click="openEditor(m)"
      >
        <div class="flex h-full flex-col gap-3 p-4">
          <!-- name + status -->
          <div class="flex min-w-0 items-center gap-1.5">
            <span class="truncate font-mono text-sm font-semibold">{{ m.name }}</span>
            <button
              type="button"
              :title="t('connect.copy')"
              :aria-label="t('connect.copy')"
              class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/50 opacity-0 transition-all hover:bg-accent hover:text-accent-foreground focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100"
              @click.stop="copyName(m.name)"
            >
              <Copy class="h-3 w-3" />
            </button>
            <Badge v-if="m.paceRpm" variant="outline" class="shrink-0 gap-1" :title="t('models.paceBadgeHint', { n: m.paceRpm, s: Math.max(1, Math.round(60 / m.paceRpm)) })">
              <Gauge class="h-3 w-3" />{{ t("models.paceBadge", { n: m.paceRpm }) }}
            </Badge>
            <Badge v-if="rowProbe(m)?.state === 'testing'" variant="muted" class="shrink-0 gap-1"><Loader2 class="h-3 w-3 animate-spin" />{{ t("models.probeTesting") }}</Badge>
            <Badge v-else-if="rowProbe(m)?.state === 'ok'" variant="success" class="shrink-0" :title="t('models.probeOkHint', { name: rowProbe(m)?.provider ?? '' })">{{ t("models.probeOk") }}</Badge>
            <Badge v-else-if="rowProbe(m)?.state === 'fail'" variant="destructive" class="shrink-0" :title="rowProbe(m)?.error || t('models.probeFailHint')">{{ t("models.probeFail") }} · {{ rowProbe(m)?.status || '?' }}</Badge>
            <Badge v-else-if="isStaleAny(m)" variant="secondary" class="shrink-0 gap-1" :title="t('models.delistedHint')">
              <TriangleAlert class="h-3 w-3" />{{ t("models.delisted") }}
            </Badge>
            <!-- actions: hover-revealed in the name row so cards carry no footer -->
            <div class="ml-auto flex shrink-0 items-center gap-0.5" @click.stop>
              <Button
                variant="ghost" size="icon"
                class="h-7 w-7 text-muted-foreground opacity-0 transition-all focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100"
                :disabled="!enabledFormats(m).length || (!!rowProbe(m) && rowProbe(m)!.state === 'testing')"
                :title="t('models.testModel')" :aria-label="t('models.testModel')"
                @click="testModel(m)"
              >
                <Loader2 v-if="rowProbe(m)?.state === 'testing'" class="h-4 w-4 animate-spin" />
                <Zap v-else class="h-4 w-4" />
              </Button>
              <Button
                variant="ghost" size="icon"
                class="h-7 w-7 text-muted-foreground opacity-0 transition-all focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100"
                :title="t('models.edit')" :aria-label="t('models.edit')"
                @click="openEditor(m)"
              >
                <Pencil class="h-4 w-4" />
              </Button>
              <div class="opacity-0 transition-all focus-within:opacity-100 group-hover:opacity-100">
                <DropdownMenu>
                  <DropdownMenuTrigger>
                    <Button variant="ghost" size="icon" class="h-7 w-7 text-muted-foreground" :aria-label="t('models.moreActions')">
                      <MoreHorizontal class="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem @select="askRename(m)">
                      <Pencil />
                      {{ t("models.renameModel") }}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem class="text-destructive focus:bg-destructive/10 focus:text-destructive" @select="confirmTarget = m; confirmOpen = true">
                      <Trash2 />
                      {{ t("models.removeModel") }}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </div>

          <!-- routing chain: per line, format toggles + first slot capsule;
               the remaining failover slots stay behind the "+N" chip -->
          <div class="min-w-0 flex-1 space-y-1.5" @click.stop>
            <template v-if="chainLines(m).length">
              <div
                v-for="(line, li) in chainLines(m)"
                :key="line.key"
                class="flex flex-wrap items-center gap-x-1.5 gap-y-1"
                :class="{ 'opacity-60': !line.enabled }"
              >
                <button
                  v-for="f in line.fs"
                  :key="f"
                  type="button"
                  :title="chipTitle(m, f)"
                  :aria-label="chipTitle(m, f)"
                  class="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium transition-colors"
                  :class="chipClass(m, f)"
                  @click="toggleFmt(m, f)"
                >
                  {{ t(FMT_META[f].label) }}
                </button>
                <span class="h-4 w-px shrink-0 bg-border" aria-hidden="true" />
                <template v-for="x in visibleSlots(m, line)" :key="x.i">
                  <ArrowRight v-if="x.i" class="h-3 w-3 shrink-0 text-muted-foreground/40" />
                  <span
                    class="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs transition-colors"
                    :class="slotChipClass(m, line, x.i)"
                    :title="slotProbeState(m, line, x.i) ? slotProbeTitle(m, line, x.i) : undefined"
                  >
                    <span class="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">{{ x.i + 1 }}</span>
                    <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="providerColor(x.s.id).solid" />
                    <span class="shrink-0 font-medium">{{ x.s.name }}</span>
                    <span v-if="x.s.model" class="min-w-0 truncate font-mono text-muted-foreground" :title="x.s.model">› {{ x.s.model }}</span>
                    <span
                      v-if="x.s.thinking"
                      class="inline-flex shrink-0 items-center gap-0.5 font-mono text-[10px] text-muted-foreground"
                      :title="t('models.editor.thinkingLabel')"
                    >
                      <Brain class="h-2.5 w-2.5" />{{ x.s.thinking }}
                    </span>
                    <template v-if="line.enabled">
                      <Check v-if="slotProbeState(m, line, x.i)?.state === 'ok'" class="h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
                      <span
                        v-else-if="slotProbeState(m, line, x.i)?.state === 'fail'"
                        class="shrink-0 font-mono text-[10px] font-semibold text-destructive"
                      >{{ slotProbeState(m, line, x.i)?.status || "✗" }}</span>
                      <button
                        v-if="slotProbeState(m, line, x.i)?.state !== 'testing'"
                        type="button"
                        class="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground/40 opacity-0 transition-all hover:bg-accent hover:text-accent-foreground focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100"
                        :title="t('models.testSourceHint')"
                        :aria-label="`${t('models.testSource')} · ${x.s.name}`"
                        @click.stop="testSlot(m, line, x.i)"
                      >
                        <Zap class="h-3 w-3" />
                      </button>
                      <Loader2 v-else class="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
                    </template>
                  </span>
                </template>
                <button
                  v-if="hiddenCount(m, line) > 0"
                  type="button"
                  class="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-dashed px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                  :title="t('models.chainMoreHint', { n: hiddenCount(m, line) })"
                  :aria-label="t('models.chainMoreHint', { n: hiddenCount(m, line) })"
                  @click="chainExpanded[m.name] = true"
                >
                  +{{ hiddenCount(m, line) }}<ChevronDown class="h-3 w-3" />
                </button>
                <button
                  v-else-if="chainExpanded[m.name] && line.slots.length > 1 && li === 0"
                  type="button"
                  class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                  :title="t('models.chainCollapse')"
                  :aria-label="t('models.chainCollapse')"
                  @click="chainExpanded[m.name] = false"
                >
                  <ChevronUp class="h-3.5 w-3.5" />
                </button>
                <span v-if="!line.enabled" class="text-xs text-muted-foreground">· {{ t("models.routeDisabled") }}</span>
              </div>
            </template>
            <div v-else class="rounded-md border border-dashed px-2.5 py-2 text-xs text-muted-foreground">
              {{ t("models.unroutedHint") }}
            </div>
          </div>
        </div>
      </Card>
    </div>

    <!-- model table -->
    <div v-else class="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow class="hover:bg-transparent">
            <TableHead>{{ t("models.colName") }}</TableHead>
            <TableHead>{{ t("models.colFormats") }}</TableHead>
            <TableHead>{{ t("models.colChain") }}</TableHead>
            <TableHead>{{ t("models.colPace") }}</TableHead>
            <TableHead class="w-[128px] text-right">{{ t("models.colActions") }}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="m in filtered" :key="m.name" class="group cursor-pointer" @click="openEditor(m)">
            <TableCell>
              <div class="space-y-1">
                <span class="font-mono text-sm font-medium">{{ m.name }}</span>
                <div v-if="m.paceRpm || rowProbe(m) || isStaleAny(m)" class="flex flex-wrap items-center gap-1">
                  <Badge v-if="m.paceRpm" variant="outline" class="gap-1" :title="t('models.paceBadgeHint', { n: m.paceRpm, s: Math.max(1, Math.round(60 / m.paceRpm)) })">
                    <Gauge class="h-3 w-3" />{{ t("models.paceBadge", { n: m.paceRpm }) }}
                  </Badge>
                  <Badge v-if="rowProbe(m)?.state === 'ok'" variant="success" :title="t('models.probeOkHint', { name: rowProbe(m)?.provider ?? '' })">{{ t("models.probeOk") }}</Badge>
                  <Badge v-else-if="rowProbe(m)?.state === 'fail'" variant="destructive" :title="rowProbe(m)?.error || t('models.probeFailHint')">{{ t("models.probeFail") }} · {{ rowProbe(m)?.status || '?' }}</Badge>
                  <Badge v-else-if="isStaleAny(m)" variant="secondary" class="gap-1" :title="t('models.delistedHint')">
                    <TriangleAlert class="h-3 w-3" />{{ t("models.delisted") }}
                  </Badge>
                </div>
              </div>
            </TableCell>
            <TableCell @click.stop>
              <div class="flex flex-wrap items-center gap-1.5">
                <template v-for="f in FORMATS" :key="f">
                  <button
                    v-if="chipState(m, f) !== 'none'"
                    type="button"
                    :title="chipTitle(m, f)"
                    :aria-label="chipTitle(m, f)"
                    class="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium transition-colors"
                    :class="chipClass(m, f)"
                    @click="toggleFmt(m, f)"
                  >
                    {{ t(FMT_META[f].label) }}
                  </button>
                </template>
              </div>
            </TableCell>
            <TableCell>
              <div v-if="chainLines(m).length" class="min-w-0 space-y-1">
                <div
                  v-for="(line, li) in chainLines(m)"
                  :key="line.key"
                  class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1"
                  :class="{ 'opacity-60': !line.enabled }"
                >
                  <template v-if="chainLines(m).length > 1">
                    <span
                      v-for="f in line.fs"
                      :key="f"
                      class="h-1.5 w-1.5 shrink-0 rounded-full"
                      :class="FMT_ACCENT[f].solid"
                      :title="t(FMT_META[f].label)"
                    />
                  </template>
                  <template v-for="x in visibleSlots(m, line)" :key="x.i">
                    <ArrowRight v-if="x.i" class="h-3 w-3 shrink-0 text-muted-foreground/40" />
                    <span
                      class="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs transition-colors"
                      :class="slotChipClass(m, line, x.i)"
                      :title="slotProbeState(m, line, x.i) ? slotProbeTitle(m, line, x.i) : undefined"
                    >
                      <span class="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">{{ x.i + 1 }}</span>
                      <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="providerColor(x.s.id).solid" />
                      <span class="shrink-0 font-medium">{{ x.s.name }}</span>
                      <span v-if="x.s.model" class="min-w-0 truncate font-mono text-muted-foreground" :title="x.s.model">› {{ x.s.model }}</span>
                      <span
                        v-if="x.s.thinking"
                        class="inline-flex shrink-0 items-center gap-0.5 font-mono text-[10px] text-muted-foreground"
                        :title="t('models.editor.thinkingLabel')"
                      >
                        <Brain class="h-2.5 w-2.5" />{{ x.s.thinking }}
                      </span>
                      <template v-if="line.enabled">
                        <Check v-if="slotProbeState(m, line, x.i)?.state === 'ok'" class="h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
                        <span
                          v-else-if="slotProbeState(m, line, x.i)?.state === 'fail'"
                          class="shrink-0 font-mono text-[10px] font-semibold text-destructive"
                        >{{ slotProbeState(m, line, x.i)?.status || "✗" }}</span>
                        <button
                          v-if="slotProbeState(m, line, x.i)?.state !== 'testing'"
                          type="button"
                          class="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground/40 opacity-0 transition-all hover:bg-accent hover:text-accent-foreground focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100"
                          :title="t('models.testSourceHint')"
                          :aria-label="`${t('models.testSource')} · ${x.s.name}`"
                          @click.stop="testSlot(m, line, x.i)"
                        >
                          <Zap class="h-3 w-3" />
                        </button>
                        <Loader2 v-else class="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
                      </template>
                    </span>
                  </template>
                  <button
                    v-if="hiddenCount(m, line) > 0"
                    type="button"
                    class="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-dashed px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                    :title="t('models.chainMoreHint', { n: hiddenCount(m, line) })"
                    :aria-label="t('models.chainMoreHint', { n: hiddenCount(m, line) })"
                    @click.stop="chainExpanded[m.name] = true"
                  >
                    +{{ hiddenCount(m, line) }}<ChevronDown class="h-3 w-3" />
                  </button>
                  <button
                    v-else-if="chainExpanded[m.name] && line.slots.length > 1 && li === 0"
                    type="button"
                    class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                    :title="t('models.chainCollapse')"
                    :aria-label="t('models.chainCollapse')"
                    @click.stop="chainExpanded[m.name] = false"
                  >
                    <ChevronUp class="h-3.5 w-3.5" />
                  </button>
                  <span v-if="!line.enabled" class="text-xs text-muted-foreground">· {{ t("models.routeDisabled") }}</span>
                </div>
              </div>
              <span v-else class="text-xs text-muted-foreground">{{ t("models.unroutedHint") }}</span>
            </TableCell>
            <TableCell class="whitespace-nowrap">
              <Badge v-if="m.paceRpm" variant="outline" class="gap-1" :title="t('models.paceBadgeHint', { n: m.paceRpm, s: Math.max(1, Math.round(60 / m.paceRpm)) })">
                <Gauge class="h-3 w-3" />{{ t("models.paceBadge", { n: m.paceRpm }) }}
              </Badge>
              <span v-else class="text-xs text-muted-foreground">—</span>
            </TableCell>
            <TableCell @click.stop>
              <div class="flex items-center justify-end gap-0.5">
                <Button
                  variant="ghost" size="icon"
                  class="h-7 w-7 text-muted-foreground"
                  :disabled="!enabledFormats(m).length || !!rowProbe(m) && rowProbe(m)!.state === 'testing'"
                  :title="t('models.testModel')" :aria-label="t('models.testModel')"
                  @click="testModel(m)"
                >
                  <Loader2 v-if="rowProbe(m)?.state === 'testing'" class="h-3.5 w-3.5 animate-spin" />
                  <Zap v-else class="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="icon" class="h-7 w-7 text-muted-foreground" :title="t('models.edit')" :aria-label="t('models.edit')" @click="openEditor(m)">
                  <Pencil class="h-3.5 w-3.5" />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger>
                    <Button variant="ghost" size="icon" class="h-7 w-7 text-muted-foreground" :aria-label="t('models.moreActions')">
                      <MoreHorizontal class="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem @select="askRename(m)">
                      <Pencil />
                      {{ t("models.renameModel") }}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem class="text-destructive focus:bg-destructive/10 focus:text-destructive" @select="confirmTarget = m; confirmOpen = true">
                      <Trash2 />
                      {{ t("models.removeModel") }}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>

    <ModelEditor
      v-model:open="editorOpen"
      :model="creating ? null : editing"
      :providers="providers"
      :existing-names="models.map((x) => x.name)"
      @saved="onEditorSaved"
    />

    <Dialog v-model:open="renameOpen">
      <DialogContent class="max-w-sm">
        <DialogTitle class="text-base">{{ t("models.renameModel") }}</DialogTitle>
        <DialogDescription>{{ t("models.renameDesc") }}</DialogDescription>
        <div class="space-y-1.5">
          <Label for="rename-input">{{ t("models.editor.nameLabel") }}</Label>
          <Input id="rename-input" v-model="renameValue" class="font-mono" spellcheck="false" autocomplete="off" @keydown.enter="doRename" />
          <p class="text-xs text-muted-foreground">{{ t("models.renameHint") }}</p>
        </div>
        <div class="flex justify-end gap-2">
          <Button variant="outline" :disabled="renaming" @click="renameOpen = false">{{ t("common.cancel") }}</Button>
          <Button :disabled="renaming || !renameValue.trim()" @click="doRename">
            <Loader2 v-if="renaming" class="h-4 w-4 animate-spin" />{{ t("settings.save") }}
          </Button>
        </div>
      </DialogContent>
    </Dialog>

    <ConfirmDialog
      v-model:open="confirmOpen"
      variant="destructive"
      :title="t('models.removeModel')"
      :description="confirmTarget ? t('models.confirmRemove', { name: confirmTarget.name }) : ''"
      :confirm-text="t('models.removeModel')"
      :loading="removing"
      @confirm="doRemove"
    />
  </div>
</template>
