<script setup lang="ts">
import { ref, computed, watch, nextTick, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { req, type ProviderPublic, type ProviderTestResult } from "@/api";
import { fmtLabel } from "@/lib/format";
import { providerModelList } from "@/lib/models";
import { toast } from "@/lib/toast";
import { copyText } from "@/lib/clipboard";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Loader2, Plus, RefreshCw, Search, X, Zap, PackageSearch } from "lucide-vue-next";

/** The per-source model list, opened by clicking a source's discovery badge.
 *  Two separate inputs: search filters the list; the supplement row adds
 *  model names the source serves but discovery can't see (no /models
 *  endpoint, unlisted) — comma-separated for batch. Clicking a row copies
 *  the name. Supplements survive discovery refreshes; untagged rows are
 *  discovered (not individually removable — a refresh would bring them
 *  back), rows tagged 手动 are removable. Saves wholesale via PUT
 *  …/extra-models, then hands the updated provider to the parent so the row
 *  and this dialog stay in sync. Deliberately lean: no explanatory copy. */
const props = defineProps<{ open: boolean; provider: ProviderPublic | null }>();
const emit = defineEmits<{ "update:open": [boolean]; saved: [ProviderPublic] }>();
const { t } = useI18n();

const q = ref("");
const draft = ref("");
/** Local copy of the supplement list — drives the optimistic rows while the
 *  PUT is in flight, re-synced from every saved response. */
const extra = ref<string[]>([]);
const busy = ref<"" | "add" | "remove" | "refresh">("");
const inputRef = ref<InstanceType<typeof Input> | null>(null);
const addRef = ref<InstanceType<typeof Input> | null>(null);
const listRef = ref<HTMLDivElement | null>(null);

/** Names just supplemented — flashed once (then un-set) so they're findable
 *  in the re-sorted list; the row scrolls into view while it flashes. */
const flash = ref<Set<string>>(new Set());
let flashTimer: ReturnType<typeof setTimeout> | undefined;
function markFlash(names: string[]) {
  flash.value = new Set(names);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => flash.value.clear(), 1600);
}
onBeforeUnmount(() => clearTimeout(flashTimer));

// Opening resets everything and focuses the search field; a patched provider
// (our own saves, or a refresh from the row) re-syncs only the supplement
// copy, keeping the typed filter.
watch(
  () => props.open,
  async (o) => {
    if (!o) return;
    q.value = "";
    draft.value = "";
    extra.value = [...(props.provider?.extraModels ?? [])];
    flash.value.clear();
    testing.value.clear();
    results.value = {};
    await nextTick();
    inputRef.value?.$el?.focus();
  },
);
watch(
  () => props.provider,
  (p) => {
    if (props.open && p) extra.value = [...(p.extraModels ?? [])];
  },
);

const discovered = computed(() => props.provider?.discoveredModels ?? []);
/** One row per known name; `manual` = present only because someone
 *  supplemented it (those are the removable ones). */
const rows = computed(() => {
  const names = providerModelList({ discoveredModels: discovered.value, extraModels: extra.value });
  return names.map((name) => ({ name, manual: extra.value.includes(name) && !discovered.value.includes(name) }));
});
const filtered = computed(() => {
  const s = q.value.trim().toLowerCase();
  return s ? rows.value.filter((r) => r.name.toLowerCase().includes(s)) : rows.value;
});
/** The typed name already exists (discovered or supplemented) — block the
 *  add and say so; the server dedupes anyway, this is just feedback. */
const exists = computed(() => {
  const s = draft.value.trim();
  return !!s && rows.value.some((r) => r.name === s);
});
const addReady = computed(() => !!draft.value.trim() && !exists.value);

function applySaved(p: ProviderPublic) {
  extra.value = [...(p.extraModels ?? [])];
  emit("saved", p);
}

async function putExtra(models: string[]): Promise<ProviderPublic> {
  const r = await req<{ provider: ProviderPublic }>("PUT", `/admin/providers/${props.provider!.id}/extra-models`, { models });
  applySaved(r.provider);
  return r.provider;
}

/** Commit the supplement input. Splits on whitespace/commas so a pasted list
 *  adds in one go; names already known are skipped. */
async function add() {
  if (!props.provider || busy.value || !addReady.value) return;
  const tokens = [...new Set(draft.value.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))].filter(
    (x) => !extra.value.includes(x),
  );
  if (!tokens.length) return;
  busy.value = "add";
  try {
    await putExtra([...extra.value, ...tokens]);
    draft.value = "";
    markFlash(tokens);
    toast(t("sources.modelAdded", { n: tokens.length }), "success");
    // The list re-sorted — bring the new names on screen instead of leaving
    // them wherever the alphabet put them.
    await nextTick();
    listRef.value?.querySelector(`[data-mname="${CSS.escape(tokens[0])}"]`)?.scrollIntoView({ block: "nearest" });
    addRef.value?.$el?.focus();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = "";
  }
}

async function remove(name: string) {
  if (busy.value) return;
  busy.value = "remove";
  try {
    await putExtra(extra.value.filter((x) => x !== name));
    toast(t("sources.modelRemoved", { name }), "success");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = "";
  }
}

/** Same discovery endpoint as the row's refresh button — right here so an
 *  empty dialog can be scanned without closing it first. */
async function refresh() {
  if (!props.provider || busy.value) return;
  busy.value = "refresh";
  try {
    const r = await req<{ models: string[] }>("POST", `/admin/providers/${props.provider.id}/discover`);
    applySaved({ ...props.provider, discoveredModels: r.models });
    toast(t("sources.refreshDone", { name: props.provider.name }), r.models.length ? "success" : "default");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    busy.value = "";
  }
}

async function copy(name: string) {
  const ok = await copyText(name);
  toast(ok ? t("connect.copied") : t("connect.copyFailed"), ok ? "success" : "error");
}

/** Per-row quick test: pings the source directly with this model name across
 *  every protocol it supports (same endpoint as the row-level test button,
 *  no routing/logs/circuit side-effects). Results stay on the row until
 *  re-run or reopen; the chip's tooltip carries status/ms/error. */
const testing = ref<Set<string>>(new Set());
const results = ref<Record<string, ProviderTestResult[]>>({});

async function test(name: string) {
  if (!props.provider || testing.value.has(name)) return;
  testing.value.add(name);
  try {
    const r = await req<{ results: ProviderTestResult[] }>(
      "POST",
      `/admin/providers/${props.provider.id}/test?model=${encodeURIComponent(name)}`,
    );
    results.value = { ...results.value, [name]: r.results };
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    testing.value.delete(name);
  }
}

/** Esc clears the filter first; only with an empty filter does it close the
 *  dialog (.stop keeps reka's document-level Esc handler out of the way). */
function onEsc(e: KeyboardEvent) {
  if (!q.value) return;
  e.stopPropagation();
  e.preventDefault();
  q.value = "";
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="max-w-lg">
      <DialogTitle class="text-base">{{ t("sources.modelsTitle") }}</DialogTitle>
      <DialogDescription class="sr-only">{{ t("sources.modelsDesc", { name: provider?.name ?? "" }) }}</DialogDescription>
      <div class="space-y-2.5">
        <div class="flex items-center gap-2">
          <div class="relative min-w-0 flex-1">
            <Search class="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref="inputRef"
              v-model="q"
              :placeholder="t('sources.modelsSearchPh')"
              autocomplete="off"
              spellcheck="false"
              class="pl-8 font-mono"
              @keydown.esc="onEsc"
            />
          </div>
          <Button
            variant="outline" size="icon" class="size-9 shrink-0"
            :disabled="busy !== ''" :title="t('sources.refreshModels')" :aria-label="t('sources.refreshModels')"
            @click="refresh"
          >
            <Loader2 v-if="busy === 'refresh'" class="h-4 w-4 animate-spin" />
            <RefreshCw v-else class="h-4 w-4" />
          </Button>
        </div>
        <div class="flex items-center gap-2">
          <div class="relative min-w-0 flex-1">
            <Plus class="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref="addRef"
              v-model="draft"
              :placeholder="t('sources.modelsAddPh')"
              autocomplete="off"
              spellcheck="false"
              class="pl-8 font-mono"
              @keydown.enter.prevent="add"
            />
          </div>
          <Button variant="outline" class="shrink-0" :disabled="!addReady || busy !== ''" @click="add">
            <Loader2 v-if="busy === 'add'" class="h-4 w-4 animate-spin" />
            <Plus v-else class="h-4 w-4" />{{ t("sources.modelsAddBtn") }}
          </Button>
        </div>
        <p v-if="exists" class="text-xs text-muted-foreground">{{ t("sources.modelsAddExists", { q: draft.trim() }) }}</p>
        <div ref="listRef" class="max-h-80 divide-y overflow-y-auto rounded-md border">
          <div v-if="!rows.length" class="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <span class="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <PackageSearch class="size-4" />
            </span>
            <p class="text-sm text-muted-foreground">{{ t("sources.modelsEmpty") }}</p>
          </div>
          <template v-else>
            <div v-if="!filtered.length" class="px-3 py-6 text-center text-xs text-muted-foreground">
              {{ t("sources.modelsNoMatch") }}
            </div>
            <div
              v-for="r in filtered"
              :key="r.name"
              :data-mname="r.name"
              class="flex cursor-pointer items-center gap-2 px-3 py-1.5 transition-colors hover:bg-muted/50"
              :class="flash.has(r.name) ? 'row-flash' : ''"
              :title="`${r.name} · ${t('sources.modelCopyTip')}`"
              @click="copy(r.name)"
            >
              <span class="min-w-0 flex-1 truncate font-mono text-sm">{{ r.name }}</span>
              <template v-if="results[r.name]">
                <Badge
                  v-for="tr in results[r.name]"
                  :key="tr.format"
                  :variant="tr.ok ? 'success' : 'destructive'"
                  class="shrink-0 font-mono"
                  :title="`${fmtLabel(tr.format)} · ${tr.status || '?'} · ${tr.ms} ms${tr.error ? ' · ' + tr.error : ''}`"
                >{{ tr.ok ? "✓" : "✗" }} {{ fmtLabel(tr.format) }} {{ tr.ok ? `${tr.ms}ms` : tr.status || "–" }}</Badge>
              </template>
              <Badge v-if="r.manual" variant="secondary" class="shrink-0">{{ t("sources.modelTagManual") }}</Badge>
              <button
                v-if="r.manual"
                type="button"
                class="-mr-1 flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
                :disabled="busy !== ''" :aria-label="t('sources.modelRemove')"
                @click.stop="remove(r.name)"
              >
                <X class="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                class="-mr-1 flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                :disabled="testing.has(r.name)"
                :title="t('sources.testBtn')" :aria-label="`${t('sources.testBtn')} ${r.name}`"
                @click.stop="test(r.name)"
              >
                <Loader2 v-if="testing.has(r.name)" class="h-3.5 w-3.5 animate-spin" />
                <Zap v-else class="h-3.5 w-3.5" />
              </button>
            </div>
          </template>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
@keyframes row-flash {
  0% {
    background-color: color-mix(in oklab, var(--primary) 16%, transparent);
  }
  100% {
    background-color: transparent;
  }
}
.row-flash {
  animation: row-flash 1.4s ease-out;
}
</style>
