<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { req, type ModelView, type ProviderPublic, type ProviderTestResult } from "@/api";
import type { Fmt } from "@/lib/format";
import { FMT_ACCENT } from "@/lib/format";
import { providerModelList } from "@/lib/models";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Plus, Trash2, Loader2, Pencil, RefreshCw, ServerCog, MoreHorizontal, Zap, LayoutGrid, Table2 } from "lucide-vue-next";
import Combobox from "@/components/Combobox.vue";
import ConfirmDialog from "@/ConfirmDialog.vue";
import SourceDialog from "@/SourceDialog.vue";
import SourceModelsDialog from "@/SourceModelsDialog.vue";

const { t } = useI18n();

const emit = defineEmits<{ goto: [string] }>();

const providers = ref<ProviderPublic[]>([]);
/** Whether at least one model exists — drives the "now create a model" nudge
 *  shown to someone who just finished the first-run source setup. */
const hasModels = ref(true);
const loading = ref(false);
const err = ref("");

// --- card / table view ---

type ViewMode = "cards" | "table";
const VIEW_KEY = "myapikey.view.sources";
const view = ref<ViewMode>(localStorage.getItem(VIEW_KEY) === "table" ? "table" : "cards");
function setView(v: ViewMode) {
  view.value = v;
  try {
    localStorage.setItem(VIEW_KEY, v);
  } catch {
    /* storage unavailable — keep the in-memory choice */
  }
}

// --- create / edit dialog ---

const dialogOpen = ref(false);
const editing = ref<ProviderPublic | null>(null);

function openCreate() {
  editing.value = null;
  dialogOpen.value = true;
}
function openEdit(p: ProviderPublic) {
  editing.value = p;
  dialogOpen.value = true;
}
/** Upsert from the dialog: replace the row on edit, append on create. */
function onSaved(p: ProviderPublic) {
  const exists = providers.value.some((x) => x.id === p.id);
  providers.value = exists
    ? providers.value.map((x) => (x.id === p.id ? p : x))
    : [...providers.value, p];
}

// --- discovery / delete ---

const refreshing = ref<Record<string, boolean>>({});

async function refresh(p: ProviderPublic) {
  refreshing.value[p.id] = true;
  try {
    const r = await req<{ models: string[] }>("POST", `/admin/providers/${p.id}/discover`);
    providers.value = providers.value.map((x) =>
      x.id === p.id ? { ...x, discoveredModels: r.models } : x,
    );
    toast(t("sources.refreshDone", { name: p.name }), r.models.length ? "success" : "default");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    refreshing.value[p.id] = false;
  }
}

const confirmTarget = ref<ProviderPublic | null>(null);
const confirmOpen = ref(false);
const removing = ref(false);

// --- source test: a direct per-protocol ping, no model routing involved ---

const testOpen = ref(false);
const testTarget = ref<ProviderPublic | null>(null);
const testModelName = ref("");
const testFormats = ref<Record<string, boolean>>({});
const testRunning = ref(false);
const testResults = ref<ProviderTestResult[] | null>(null);

/** Discovered + supplemented upstream ids for the dropdown — typing stays as
 *  the fallback for names in neither list. */
const testOptions = computed(() => (testTarget.value ? providerModelList(testTarget.value) : []));

/** Every protocol this source can serve (responses only when flagged). */
function testFormatList(p: ProviderPublic): string[] {
  return [...p.formats, ...(p.supportsResponses ? ["responses"] : [])];
}

function openTest(p: ProviderPublic) {
  testTarget.value = p;
  testModelName.value = providerModelList(p)[0] ?? "";
  testFormats.value = Object.fromEntries(testFormatList(p).map((f) => [f, true]));
  testResults.value = null;
  testOpen.value = true;
}

async function runTest() {
  const p = testTarget.value;
  const model = testModelName.value.trim();
  if (!p || !model || testRunning.value) return;
  const all = testFormatList(p);
  const fmts = all.filter((f) => testFormats.value[f]);
  if (!fmts.length) return;
  testRunning.value = true;
  testResults.value = null;
  try {
    // Narrowed protocol selection travels as repeatable ?format= params.
    const q = fmts.length < all.length ? fmts.map((f) => `&format=${f}`).join("") : "";
    const r = await req<{ results: ProviderTestResult[] }>(
      "POST",
      `/admin/providers/${p.id}/test?model=${encodeURIComponent(model)}${q}`,
    );
    testResults.value = r.results;
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    testRunning.value = false;
  }
}

function testChipClass(on: boolean, f: string): string {
  if (on && f in FMT_ACCENT) return `border-transparent ${FMT_ACCENT[f as Fmt].solid} text-white shadow-sm`;
  if (on) return "border-transparent bg-primary text-primary-foreground shadow-sm";
  return "border-input text-muted-foreground hover:bg-accent hover:text-accent-foreground";
}

async function doRemove() {
  const p = confirmTarget.value;
  if (!p || removing.value) return;
  removing.value = true;
  try {
    await req("DELETE", `/admin/providers/${p.id}`);
    providers.value = providers.value.filter((x) => x.id !== p.id);
    toast(t("sources.removed", { name: p.name }), "success");
    confirmOpen.value = false;
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    removing.value = false;
  }
}

// --- discovery badge / source-models dialog ---

function discCount(p: ProviderPublic): number {
  return providerModelList(p).length;
}
function discState(p: ProviderPublic): "never" | "empty" | "found" {
  if (discCount(p) > 0) return "found";
  return p.discoveredAt ? "empty" : "never";
}
function discLabel(p: ProviderPublic): string {
  const s = discState(p);
  if (s === "found") return t("sources.discoveredCount", { n: discCount(p) });
  if (s === "empty") return t("sources.noModelsFound");
  return t("sources.notScanned");
}
function discTitle(p: ProviderPublic): string {
  const s = discState(p);
  if (s === "empty") return t("sources.noModelsHint");
  if (s === "never") return t("sources.notScannedHint");
  return t("sources.modelsOpenHint");
}

// The badge is the entry point: click to see (and supplement) what this
// source can run, without opening the edit form.
const modelsOpen = ref(false);
const modelsTarget = ref<ProviderPublic | null>(null);
function openModels(p: ProviderPublic) {
  modelsTarget.value = p;
  modelsOpen.value = true;
}

function fmtBadgeClass(f: string): string {
  return f in FMT_ACCENT ? FMT_ACCENT[f as Fmt].badge : "";
}

async function load() {
  loading.value = true;
  err.value = "";
  try {
    const [pr, mr] = await Promise.all([
      req<{ providers: ProviderPublic[] }>("GET", "/admin/providers"),
      req<{ models: ModelView[] }>("GET", "/admin/models").catch(() => null),
    ]);
    providers.value = pr.providers;
    hasModels.value = !!mr?.models.length;
  } catch (e) {
    err.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="space-y-4">
    <!-- page header -->
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <ServerCog class="h-4 w-4 text-primary" />
        <span class="text-base font-semibold">{{ t("sources.pageTitle") }}</span>
        <span class="text-sm text-muted-foreground">{{ t("sources.pageDesc") }}</span>
      </div>
      <div v-if="providers.length" class="flex items-center gap-2">
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
        <Button size="sm" @click="openCreate">
          <Plus class="h-4 w-4" />{{ t("sources.add") }}
        </Button>
      </div>
    </div>

    <p v-if="loading" class="py-8 text-center text-sm text-muted-foreground">{{ t("common.loading") }}</p>
    <p v-else-if="err" class="py-8 text-center text-sm text-destructive">{{ err }}</p>

    <!-- empty: add the first source -->
    <Card v-else-if="!providers.length">
      <CardContent class="flex flex-col items-center gap-3 py-12 text-center">
        <span class="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/15 text-primary">
          <ServerCog class="h-5 w-5" />
        </span>
        <div class="space-y-1">
          <div class="font-medium">{{ t("sources.emptyTitle") }}</div>
          <p class="max-w-sm text-sm text-muted-foreground">{{ t("sources.emptyHint") }}</p>
        </div>
        <Button @click="openCreate">
          <Plus class="h-4 w-4" />{{ t("sources.add") }}
        </Button>
      </CardContent>
    </Card>

    <template v-else>
      <!-- first-run nudge: a source alone isn't callable — point at the next step -->
      <div v-if="!hasModels" class="flex flex-wrap items-center gap-3 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2.5">
        <p class="min-w-0 flex-1 text-sm">{{ t("sources.nextHint") }}</p>
        <Button size="sm" @click="emit('goto', 'models')">{{ t("sources.nextCta") }}</Button>
      </div>

      <!-- source cards -->
      <div v-if="view === 'cards'" class="grid items-stretch gap-3 md:grid-cols-2">
        <Card
          v-for="p in providers"
          :key="p.id"
          class="group cursor-pointer gap-0 py-0 transition-colors hover:bg-muted/30"
          @click="openEdit(p)"
        >
          <div class="flex h-full flex-col gap-3 p-4">
            <!-- name + badges -->
            <div class="flex min-w-0 flex-wrap items-center gap-1.5">
              <span class="truncate text-sm font-semibold">{{ p.name }}</span>
              <Badge
                v-for="f in p.formats"
                :key="f"
                variant="outline"
                class="shrink-0"
                :class="fmtBadgeClass(f)"
              >{{ f }}</Badge>
              <Badge v-if="p.supportsResponses" variant="outline" class="shrink-0" :class="FMT_ACCENT.responses.badge">responses</Badge>
              <Badge v-if="p.rpm" variant="outline" class="shrink-0" :title="t('sources.rpmBadgeHint')">{{ t("sources.rpmBadge", { n: p.rpm }) }}</Badge>
              <button
                type="button"
                class="shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
                :title="discTitle(p)" :aria-label="t('sources.modelsTitle')"
                @click.stop="openModels(p)"
              >
                <Badge variant="muted" class="cursor-pointer transition-colors hover:bg-accent hover:text-accent-foreground">{{ discLabel(p) }}</Badge>
              </button>
            </div>

            <!-- base URLs, one line per enabled format -->
            <div class="min-w-0 flex-1 space-y-1">
              <div v-if="p.formats.includes('openai')" class="truncate font-mono text-xs text-muted-foreground">
                <span class="opacity-60">openai ·</span> {{ p.baseUrlOpenai }}
              </div>
              <div v-if="p.formats.includes('anthropic')" class="truncate font-mono text-xs text-muted-foreground">
                <span class="opacity-60">anthropic ·</span> {{ p.baseUrlAnthropic }}
              </div>
            </div>

            <!-- actions -->
            <div class="flex items-center gap-1 border-t pt-3" @click.stop>
              <Button variant="ghost" size="sm" class="h-7 gap-1.5 px-2 text-xs" @click="openTest(p)">
                <Zap class="h-3.5 w-3.5" />{{ t("sources.testBtn") }}
              </Button>
              <Button variant="ghost" size="sm" class="h-7 gap-1.5 px-2 text-xs" :disabled="refreshing[p.id]" @click="refresh(p)">
                <Loader2 v-if="refreshing[p.id]" class="h-3.5 w-3.5 animate-spin" />
                <RefreshCw v-else class="h-3.5 w-3.5" />{{ t("sources.refreshModels") }}
              </Button>
              <Button variant="ghost" size="sm" class="h-7 gap-1.5 px-2 text-xs" @click="openEdit(p)">
                <Pencil class="h-3.5 w-3.5" />{{ t("sources.editLabel") }}
              </Button>
              <div class="ml-auto">
                <DropdownMenu>
                  <DropdownMenuTrigger>
                    <Button variant="ghost" size="icon" class="h-7 w-7 text-muted-foreground" :aria-label="t('sources.moreActions')">
                      <MoreHorizontal class="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem class="text-destructive focus:bg-destructive/10 focus:text-destructive" @select="confirmTarget = p; confirmOpen = true">
                      <Trash2 />
                      {{ t("sources.deleteLabel") }}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </div>
        </Card>
      </div>

      <!-- source table -->
      <div v-else class="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow class="hover:bg-transparent">
              <TableHead>{{ t("sources.colName") }}</TableHead>
              <TableHead>{{ t("sources.colFormats") }}</TableHead>
              <TableHead>{{ t("sources.colBaseUrl") }}</TableHead>
              <TableHead>{{ t("sources.colRpm") }}</TableHead>
              <TableHead>{{ t("sources.colDiscovered") }}</TableHead>
              <TableHead class="w-[168px] text-right">{{ t("sources.colActions") }}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="p in providers" :key="p.id" class="cursor-pointer" @click="openEdit(p)">
              <TableCell class="max-w-[160px] truncate font-medium" :title="p.name">{{ p.name }}</TableCell>
              <TableCell>
                <div class="flex flex-wrap gap-1">
                  <Badge v-for="f in p.formats" :key="f" variant="outline" :class="fmtBadgeClass(f)">{{ f }}</Badge>
                  <Badge v-if="p.supportsResponses" variant="outline" :class="FMT_ACCENT.responses.badge">responses</Badge>
                </div>
              </TableCell>
              <TableCell>
                <div class="max-w-[300px] space-y-0.5 font-mono text-xs text-muted-foreground">
                  <div v-if="p.formats.includes('openai')" class="truncate" :title="p.baseUrlOpenai">
                    <span class="opacity-60">openai · </span>{{ p.baseUrlOpenai }}
                  </div>
                  <div v-if="p.formats.includes('anthropic')" class="truncate" :title="p.baseUrlAnthropic">
                    <span class="opacity-60">anthropic · </span>{{ p.baseUrlAnthropic }}
                  </div>
                </div>
              </TableCell>
              <TableCell class="whitespace-nowrap text-xs text-muted-foreground">
                <span v-if="p.rpm" :title="t('sources.rpmBadgeHint')" class="font-mono">{{ t("sources.rpmBadge", { n: p.rpm }) }}</span>
                <span v-else>—</span>
              </TableCell>
              <TableCell>
                <button
                  type="button"
                  class="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  :title="discTitle(p)" :aria-label="t('sources.modelsTitle')"
                  @click.stop="openModels(p)"
                >
                  <Badge variant="muted" class="cursor-pointer transition-colors hover:bg-accent hover:text-accent-foreground">{{ discLabel(p) }}</Badge>
                </button>
              </TableCell>
              <TableCell @click.stop>
                <div class="flex items-center justify-end gap-0.5">
                  <Button variant="ghost" size="icon" class="h-7 w-7 text-muted-foreground" :title="t('sources.testBtn')" :aria-label="t('sources.testBtn')" @click="openTest(p)">
                    <Zap class="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" class="h-7 w-7 text-muted-foreground" :disabled="refreshing[p.id]" :title="t('sources.refreshModels')" :aria-label="t('sources.refreshModels')" @click="refresh(p)">
                    <Loader2 v-if="refreshing[p.id]" class="h-3.5 w-3.5 animate-spin" />
                    <RefreshCw v-else class="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" class="h-7 w-7 text-muted-foreground" :title="t('sources.editLabel')" :aria-label="t('sources.editLabel')" @click="openEdit(p)">
                    <Pencil class="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" class="h-7 w-7 text-destructive hover:text-destructive" :title="t('sources.deleteLabel')" :aria-label="t('sources.deleteLabel')" @click="confirmTarget = p; confirmOpen = true">
                    <Trash2 class="h-3.5 w-3.5" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </template>

    <SourceDialog v-model:open="dialogOpen" :provider="editing" @saved="onSaved" />

    <!-- per-source model list: discovery results + manual supplements -->
    <SourceModelsDialog v-model:open="modelsOpen" :provider="modelsTarget" @saved="onSaved" />

    <!-- source test: model name + per-protocol toggles, results inline -->
    <Dialog v-model:open="testOpen">
      <DialogContent class="max-w-md">
        <DialogTitle class="text-base">{{ t("sources.testTitle") }}</DialogTitle>
        <DialogDescription>{{ t("sources.testDesc") }}</DialogDescription>
        <div class="space-y-3">
          <div class="space-y-1.5" @keydown.enter="runTest">
            <Label>{{ t("sources.testModelLabel") }}</Label>
            <Combobox
              v-model="testModelName"
              :options="testOptions"
              :placeholder="t('sources.testModelPh')"
            />
            <p class="text-xs text-muted-foreground">{{ t("sources.testModelHint") }}</p>
          </div>
          <div v-if="testTarget" class="space-y-1.5">
            <Label>{{ t("sources.formats") }}</Label>
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="f in testFormatList(testTarget)"
                :key="f"
                type="button"
                class="inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-xs font-medium transition-colors"
                :class="testChipClass(!!testFormats[f], f)"
                @click="testFormats[f] = !testFormats[f]"
              >{{ f }}</button>
            </div>
          </div>
          <div v-if="testResults" class="space-y-1.5 rounded-md border bg-muted/30 p-2.5">
            <div v-for="r in testResults" :key="r.format" class="flex min-w-0 items-center gap-2 text-xs">
              <Badge variant="outline" :class="fmtBadgeClass(r.format)">{{ r.format }}</Badge>
              <Badge v-if="r.ok" variant="success" class="shrink-0">{{ t("models.probeOk") }}</Badge>
              <Badge v-else variant="destructive" class="shrink-0">{{ t("models.probeFail") }} · {{ r.status || "?" }}</Badge>
              <span class="shrink-0 tabular-nums text-muted-foreground">{{ r.ms }} ms</span>
              <span v-if="r.error" class="min-w-0 truncate text-destructive" :title="r.error">{{ r.error }}</span>
            </div>
          </div>
        </div>
        <div class="flex justify-end gap-2">
          <Button variant="outline" :disabled="testRunning" @click="testOpen = false">{{ t("common.cancel") }}</Button>
          <Button :disabled="testRunning || !testModelName.trim()" @click="runTest">
            <Loader2 v-if="testRunning" class="h-4 w-4 animate-spin" />
            <Zap v-else class="h-4 w-4" />{{ t("sources.testRun") }}
          </Button>
        </div>
      </DialogContent>
    </Dialog>

    <ConfirmDialog
      v-model:open="confirmOpen"
      variant="destructive"
      :title="t('sources.remove')"
      :description="confirmTarget ? t('sources.confirmRemove', { name: confirmTarget.name }) : ''"
      :confirm-text="t('sources.remove')"
      :loading="removing"
      @confirm="doRemove"
    />
  </div>
</template>
