<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { req, type ModelView, type ProviderPublic } from "@/api";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import {
  ChevronUp,
  ChevronDown,
  X,
  Trash2,
  Cpu,
  Plus,
  Loader2,
  Search,
  RefreshCw,
  ServerCog,
  MoreHorizontal,
  Zap,
} from "lucide-vue-next";
import SourcesDialog from "@/SourcesDialog.vue";
import ConfirmDialog from "@/ConfirmDialog.vue";
import AddModelsDialog from "@/AddModelsDialog.vue";

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
const sourcesOpen = ref(false);
const addOpen = ref(false);

const removing = ref<Record<string, boolean>>({});
const enabling = ref<Record<string, boolean>>({});
const addingSrc = ref<Record<string, boolean>>({});
const removingSrc = ref<Record<string, boolean>>({});
const testing = ref<Record<string, boolean>>({});
interface ProbeResult { ok: boolean; status: number; provider?: string; format: string; error?: string }
const probe = ref<Record<string, ProbeResult>>({});

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

interface ChainSrc { id: string; name: string; }
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
  const toRow = (fe: { enabled: boolean; providers: { id: string; name: string }[] } | undefined): FormatRow => ({
    enabled: fe?.enabled ?? false,
    chain: (fe?.providers ?? []).map((p) => ({ id: p.id, name: p.name })),
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

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  return rows.value.filter((r) => !q || r.name.toLowerCase().includes(q));
});
const enabledRows = computed(() => filtered.value.filter((r) => r.openai.enabled || r.anthropic.enabled || r.responses.enabled));
const availableRows = computed(() => filtered.value.filter((r) => !r.openai.enabled && !r.anthropic.enabled && !r.responses.enabled));

interface Section {
  key: string;
  fmt: Fmt;
  rows: Row[];
  chain: (r: Row) => ChainSrc[];
  enabled: (r: Row) => boolean;
}
/** One editable section per routing slot (endpoint). A model appears under every
 *  slot it's enabled on; each has its own toggle and chain editor. */
const sections = computed<Section[]>(() => {
  const list: Section[] = [];
  for (const key of FORMATS) {
    const rs = enabledRows.value.filter((r) => r[key].enabled);
    if (rs.length) list.push({ key, fmt: key, rows: rs, chain: (r) => r[key].chain, enabled: (r) => r[key].enabled });
  }
  return list;
});

/** Every existing source that speaks this format and isn't yet in the chain —
 *  the contents of the single "add source" menu. Discovered sources sort first
 *  (they're known to offer the model); the rest are manual force-add candidates
 *  (e.g. backends with no /models endpoint). */
function addableSources(r: Row, fmt: Fmt): ProviderPublic[] {
  const inChain = new Set(r[fmt].chain.map((c) => c.id));
  const isOffering = new Set(r.offering.map((o) => o.id));
  return providers.value
    .filter((p) => supportsFmt(p, fmt) && !inChain.has(p.id))
    .sort((a, b) => {
      const ao = isOffering.has(a.id) ? 0 : 1;
      const bo = isOffering.has(b.id) ? 0 : 1;
      return ao - bo;
    });
}
function supportsFmt(o: { formats: string[]; supportsResponses?: boolean }, fmt: Fmt): boolean {
  return fmt === "responses" ? !!o.supportsResponses : o.formats.includes(fmt);
}

/** Short label + endpoint for each routing slot, shown in the enable dropdown. */
const FMT_META: Record<Fmt, { key: string; endpoint: string }> = {
  openai: { key: "models.fmtOpenai", endpoint: "/chat/completions" },
  anthropic: { key: "models.fmtAnthropic", endpoint: "/messages" },
  responses: { key: "models.fmtResponses", endpoint: "/responses" },
};

/** Formats a discovered model can be enabled on (offered by ≥1 source). */
function availFormats(r: Row): Fmt[] {
  return FORMATS.filter((f) => r.offering.some((o) => supportsFmt(o, f)));
}

function isExpanded(key: string) {
  return expandedModels.value.has(key);
}
function toggleExpand(key: string) {
  const s = new Set(expandedModels.value);
  if (s.has(key)) s.delete(key);
  else s.add(key);
  expandedModels.value = s;
}
function joinChain(chain: ChainSrc[]): string {
  return chain.length ? chain.map((p) => p.name).join(" → ") : t("models.noSourcesShort");
}
function srcFormats(id: string): string[] {
  return providerById.value.get(id)?.formats ?? [];
}
function isStale(r: Row, fmt: Fmt): boolean {
  const chain = r[fmt].chain;
  if (!chain.length) return false;
  const list = (id: string) => providerById.value.get(id)?.discoveredModels ?? [];
  return !chain.some((c) => list(c.id).includes(r.name)) && chain.some((c) => list(c.id).length > 0);
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

async function addSource(r: Row, pid: string, fmt: Fmt) {
  const key = `${r.name}:${pid}:${fmt}`;
  if (addingSrc.value[key]) return;
  addingSrc.value[key] = true;
  const m = models.value.find((x) => x.name === r.name);
  const p = providerById.value.get(pid);
  if (m && p && !m[fmt].providers.find((x) => x.id === pid)) m[fmt].providers.push({ id: p.id, name: p.name });
  try {
    await req("POST", `/admin/models/${enc(r.name)}/providers`, { format: fmt, providerId: pid });
    toast(t("models.sourceAdded"), "success");
  } catch (e) {
    await load();
    toast((e as Error).message, "error");
  } finally {
    addingSrc.value[key] = false;
  }
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
            <Cpu class="h-4 w-4 text-muted-foreground" />
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

          <p v-if="loading" class="py-6 text-center text-sm text-muted-foreground">{{ t("common.loading") }}</p>
          <p v-else-if="err" class="py-6 text-center text-sm text-destructive">{{ err }}</p>

          <template v-else>
            <!-- One editable section per routing slot (endpoint). -->
            <section v-for="s in sections" :key="s.key" class="space-y-1">
              <div class="flex items-center gap-2 pt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {{ t(`models.${s.key}Section`) }}
                <span class="text-muted-foreground/70">· {{ s.rows.length }}</span>
              </div>
              <div class="divide-y divide-border">
                <div v-for="r in s.rows" :key="r.name" class="py-2.5">
                  <!-- summary row -->
                  <div class="flex items-center gap-3">
                    <Switch :model-value="s.enabled(r)" @update:model-value="() => toggle(r, s.fmt)" />
                    <button
                      type="button"
                      class="flex min-w-0 flex-1 flex-col items-start text-left"
                      :aria-expanded="isExpanded(`${s.key}:${r.name}`)"
                      @click="toggleExpand(`${s.key}:${r.name}`)"
                    >
                      <span class="flex w-full items-center gap-2">
                        <span class="truncate font-mono text-sm font-medium">{{ r.name }}</span>
                        <Badge v-if="testing[`${r.name}:${s.fmt}`]" variant="muted" class="gap-1"><Loader2 class="h-3 w-3 animate-spin" />{{ t("models.probeTesting") }}</Badge>
                        <Badge v-else-if="probe[`${r.name}:${s.fmt}`]?.ok" variant="success" :title="t('models.probeOkHint', { name: probe[`${r.name}:${s.fmt}`]?.provider ?? '' })">{{ t("models.probeOk") }}</Badge>
                        <Badge v-else-if="probe[`${r.name}:${s.fmt}`]" variant="destructive" :title="probe[`${r.name}:${s.fmt}`]?.error || t('models.probeFailHint')">{{ t("models.probeFail") }} · {{ probe[`${r.name}:${s.fmt}`]?.status || '?' }}</Badge>
                        <Badge v-else-if="isStale(r, s.fmt)" variant="secondary" :title="t('models.delistedHint')">{{ t("models.delisted") }}</Badge>
                      </span>
                      <span class="w-full truncate text-xs text-muted-foreground">{{ joinChain(s.chain(r)) }}</span>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      class="h-8 w-8 shrink-0 text-muted-foreground"
                      :aria-label="isExpanded(`${s.key}:${r.name}`) ? t('models.collapseAria') : t('models.expandAria')"
                      @click="toggleExpand(`${s.key}:${r.name}`)"
                    >
                      <ChevronDown class="h-4 w-4 transition-transform" :class="{ 'rotate-180': isExpanded(`${s.key}:${r.name}`) }" />
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger>
                        <Button variant="ghost" size="icon" class="h-8 w-8 shrink-0 text-muted-foreground" :aria-label="t('models.moreActions')">
                          <MoreHorizontal class="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem :disabled="testing[`${r.name}:${s.fmt}`]" @select="testModel(r, s.fmt)">
                          <Loader2 v-if="testing[`${r.name}:${s.fmt}`]" class="animate-spin" />
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

                  <!-- expanded: chain editor for this slot -->
                  <div v-if="isExpanded(`${s.key}:${r.name}`)" class="mt-2 space-y-1 rounded-md border bg-muted/30 p-2">
                    <div v-if="isStale(r, s.fmt) && !probe[`${r.name}:${s.fmt}`]" class="flex items-start gap-2 rounded bg-muted px-2 py-1.5 text-xs text-muted-foreground">
                      <span class="shrink-0 font-medium">{{ t("models.delisted") }}</span>
                      <span>{{ t("models.delistedHint") }}</span>
                    </div>
                    <div v-if="!s.chain(r).length" class="px-1 py-1 text-xs text-muted-foreground">
                      {{ t("models.noSources") }}
                    </div>
                    <div v-for="(p, i) in s.chain(r)" :key="p.id" class="flex items-center gap-2 rounded px-1 py-1">
                      <span class="w-4 text-right text-xs text-muted-foreground">{{ i + 1 }}.</span>
                      <span class="text-sm">{{ p.name }}</span>
                      <Badge v-for="f in srcFormats(p.id)" :key="f" variant="secondary">{{ f }}</Badge>
                      <Badge v-if="providerById.get(p.id)?.supportsResponses" variant="muted">{{ t("sources.responses") }}</Badge>
                      <Badge v-if="i === 0" variant="default">{{ t("models.primary") }}</Badge>
                      <Badge v-else variant="muted">{{ t("models.fallback") }}</Badge>
                      <div class="ml-auto flex items-center gap-0.5">
                        <Button variant="ghost" size="icon" class="h-7 w-7" :disabled="i === 0" :aria-label="t('models.moveUpAria')" @click="moveUp(r, i, s.fmt)">
                          <ChevronUp class="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" class="h-7 w-7" :disabled="i === s.chain(r).length - 1" :aria-label="t('models.moveDownAria')" @click="moveDown(r, i, s.fmt)">
                          <ChevronDown class="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" class="h-7 w-7 text-muted-foreground hover:text-destructive" :aria-label="t('models.removeSourceAria', { name: p.name })" @click="removeSource(r, p.id, s.fmt)">
                          <X class="h-4 w-4" />
                        </Button>
                      </div>
                    </div>

                    <!-- add a source to this slot's chain. A dashed full-width
                         add-zone (append-to-list affordance); the dropdown lists
                         every candidate (discovered first, then force-adds). -->
                    <div v-if="addableSources(r, s.fmt).length" class="pt-1">
                      <DropdownMenu>
                        <DropdownMenuTrigger>
                          <Button variant="outline" class="w-full justify-center gap-1.5 border-dashed font-normal text-muted-foreground hover:text-foreground">
                            <Plus class="h-3.5 w-3.5" />{{ t("models.addSourceToChain") }}
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                          <DropdownMenuItem
                            v-for="o in addableSources(r, s.fmt)"
                            :key="o.id"
                            :disabled="addingSrc[`${r.name}:${o.id}:${s.fmt}`]"
                            @select="addSource(r, o.id, s.fmt)"
                          >
                            <Loader2 v-if="addingSrc[`${r.name}:${o.id}:${s.fmt}`]" class="h-3.5 w-3.5 animate-spin" />
                            <Plus v-else class="h-3.5 w-3.5" />
                            {{ o.name }}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <!-- Available -->
            <section>
              <button
                type="button"
                class="mb-1 flex w-full items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
                @click="showAvailable = !showAvailable"
              >
                <ChevronDown class="h-4 w-4 transition-transform" :class="{ '-rotate-90': !showAvailable }" />
                {{ t("models.availableSection") }}
                <span class="text-muted-foreground/70">· {{ availableRows.length }}</span>
              </button>
              <div v-if="showAvailable" class="divide-y divide-border">
                <p v-if="!availableRows.length" class="py-3 text-center text-xs text-muted-foreground">
                  {{ t("models.availableDesc") }}
                </p>
                <div v-for="r in availableRows" :key="r.name" class="flex items-center justify-between gap-2 py-2">
                  <div class="flex min-w-0 items-center gap-2">
                    <span class="truncate font-mono text-sm">{{ r.name }}</span>
                    <div class="hidden gap-1 sm:flex">
                      <Badge v-for="o in r.offering" :key="o.id" variant="secondary">{{ o.name }}</Badge>
                    </div>
                  </div>
                  <div class="flex items-center gap-1">
                    <!-- one supported format: one-tap enable -->
                    <Button
                      v-if="availFormats(r).length === 1"
                      size="sm"
                      variant="secondary"
                      :disabled="enabling[`${r.name}:${availFormats(r)[0]}`]"
                      @click="enable(r, availFormats(r)[0])"
                    >
                      <Loader2 v-if="enabling[`${r.name}:${availFormats(r)[0]}`]" class="h-3.5 w-3.5 animate-spin" />
                      <Plus v-else class="h-3.5 w-3.5" />
                      {{ t("models.enable") }}
                    </Button>
                    <!-- several formats: pick which to enable -->
                    <DropdownMenu v-else>
                      <DropdownMenuTrigger>
                        <Button size="sm" variant="secondary">
                          <Plus class="h-3.5 w-3.5" />
                          {{ t("models.enable") }}
                          <ChevronDown class="h-3.5 w-3.5 opacity-60" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          v-for="f in availFormats(r)"
                          :key="f"
                          :disabled="enabling[`${r.name}:${f}`]"
                          @select="enable(r, f)"
                        >
                          <Loader2 v-if="enabling[`${r.name}:${f}`]" class="animate-spin" />
                          <Plus v-else />
                          <span>{{ t(FMT_META[f].key) }}</span>
                          <span class="ml-auto pl-3 font-mono text-xs text-muted-foreground">{{ FMT_META[f].endpoint }}</span>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
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
