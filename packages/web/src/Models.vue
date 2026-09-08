<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { req, type ModelView, type ProviderPublic } from "@/api";
import type { Fmt } from "@/lib/format";
import { FMT_ACCENT } from "@/lib/format";
import { toast } from "@/lib/toast";
import { copyText } from "@/lib/clipboard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Search, Plus, Loader2, Copy, Zap, Gauge, MoreHorizontal, Pencil, Trash2,
  Cpu, ServerCog, TriangleAlert,
} from "lucide-vue-next";
import ModelEditor from "@/ModelEditor.vue";
import ConfirmDialog from "@/ConfirmDialog.vue";

const emit = defineEmits<{ goto: [string] }>();
const { t } = useI18n();

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
function hasAnyRoute(m: ModelView): boolean {
  return FORMATS.some((f) => m[f].enabled || m[f].providers.length > 0);
}

/** One-line chain summary under the name: per enabled route, its slot list.
 *  When every enabled route shares the same chain, show it once. */
const chain = (c: { id: string; name: string; model?: string; thinking?: string }[]) =>
  c.length ? c.map((s) => (s.model ? `${s.name} → ${s.model}` : s.name)).join(" → ") : t("models.unrouted");
/** Chains to render under the name, tagged with their format (for the color
 *  dot). Collapsed to a single entry when every enabled route shares a chain —
 *  the row then reads as one plain flow instead of per-protocol repetition. */
const chainLines = (m: ModelView): { f: Fmt; text: string }[] => {
  const lines = enabledFormats(m).map((f) => ({ f, text: chain(m[f].providers) }));
  return lines.length > 1 && new Set(lines.map((l) => l.text)).size === 1 ? [lines[0]] : lines;
};

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

/** Quick route toggle straight from the list: a single-format PUT (the upsert
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

    <!-- model list -->
    <div v-else class="overflow-hidden rounded-lg border border-border/60 bg-card">
      <div class="divide-y divide-border">
        <div
          v-for="m in filtered"
          :key="m.name"
          role="button"
          tabindex="0"
          class="group flex cursor-pointer items-center gap-3 px-3 py-3 outline-none transition-colors hover:bg-muted/30 focus-visible:bg-muted/30"
          @click="openEditor(m)"
          @keydown.enter.prevent="openEditor(m)"
          @keydown.space.prevent="openEditor(m)"
        >
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              <span class="truncate font-mono text-sm font-medium">{{ m.name }}</span>
              <button
                type="button"
                :title="t('connect.copy')"
                :aria-label="t('connect.copy')"
                class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/50 opacity-0 transition-all hover:bg-accent hover:text-accent-foreground focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100"
                @click.stop="copyName(m.name)"
              >
                <Copy class="h-3 w-3" />
              </button>
              <Badge v-if="m.paceRpm" variant="outline" class="gap-1" :title="t('models.paceBadgeHint', { n: m.paceRpm, s: Math.max(1, Math.round(60 / m.paceRpm)) })">
                <Gauge class="h-3 w-3" />{{ t("models.paceBadge", { n: m.paceRpm }) }}
              </Badge>
              <Badge v-if="rowProbe(m)?.state === 'testing'" variant="muted" class="gap-1"><Loader2 class="h-3 w-3 animate-spin" />{{ t("models.probeTesting") }}</Badge>
              <Badge v-else-if="rowProbe(m)?.state === 'ok'" variant="success" :title="t('models.probeOkHint', { name: rowProbe(m)?.provider ?? '' })">{{ t("models.probeOk") }}</Badge>
              <Badge v-else-if="rowProbe(m)?.state === 'fail'" variant="destructive" :title="rowProbe(m)?.error || t('models.probeFailHint')">{{ t("models.probeFail") }} · {{ rowProbe(m)?.status || '?' }}</Badge>
              <Badge v-else-if="isStaleAny(m)" variant="secondary" class="gap-1" :title="t('models.delistedHint')">
                <TriangleAlert class="h-3 w-3" />{{ t("models.delisted") }}
              </Badge>
            </div>
            <div class="mt-0.5 flex items-center gap-2 truncate text-xs text-muted-foreground">
              <template v-if="chainLines(m).length">
                <template v-for="(l, i) in chainLines(m)" :key="l.f">
                  <span v-if="i > 0" class="text-border">·</span>
                  <span class="inline-flex min-w-0 items-center gap-1.5">
                    <span
                      v-if="chainLines(m).length > 1"
                      class="h-1.5 w-1.5 shrink-0 rounded-full"
                      :class="FMT_ACCENT[l.f].solid"
                      :title="t(FMT_META[l.f].label)"
                    />
                    <span class="truncate">{{ l.text }}</span>
                  </span>
                </template>
              </template>
              <span v-else>{{ t("models.unroutedHint") }}</span>
            </div>
          </div>

          <!-- per-format quick toggles (only the actionable ones) -->
          <div v-if="FORMATS.some((f) => chipState(m, f) !== 'none')" class="flex shrink-0 items-center gap-1.5" @click.stop>
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

          <div class="shrink-0" @click.stop>
            <DropdownMenu>
              <DropdownMenuTrigger>
                <Button variant="ghost" size="icon" class="h-8 w-8 text-muted-foreground" :aria-label="t('models.moreActions')">
                  <MoreHorizontal class="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem :disabled="!enabledFormats(m).length || !!rowProbe(m) && rowProbe(m)!.state === 'testing'" @select="testModel(m)">
                  <Zap />
                  {{ t("models.testModel") }}
                </DropdownMenuItem>
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
