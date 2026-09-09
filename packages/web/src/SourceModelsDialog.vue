<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { req, type ProviderPublic } from "@/api";
import { providerModelList } from "@/lib/models";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Loader2, Plus, RefreshCw, X } from "lucide-vue-next";

/** The per-source model list, opened by clicking a source's discovery badge.
 *  Discovery results and manual supplements in one scrollable list: type in
 *  the search box to filter, and when the typed name isn't already listed an
 *  "Add" row appears (Enter works too) — that's the supplement flow for
 *  upstreams whose /models doesn't list everything. Supplements survive
 *  discovery refreshes; discovered rows carry no remove button, because a
 *  refresh would just bring them back (the upstream is their source of
 *  truth). Saves wholesale via PUT …/extra-models, then hands the updated
 *  provider to the parent so the row and this dialog stay in sync. */
const props = defineProps<{ open: boolean; provider: ProviderPublic | null }>();
const emit = defineEmits<{ "update:open": [boolean]; saved: [ProviderPublic] }>();
const { t } = useI18n();

const q = ref("");
/** Local copy of the supplement list — drives the optimistic rows while the
 *  PUT is in flight, re-synced from every saved response. */
const extra = ref<string[]>([]);
const busy = ref<"" | "add" | "remove" | "refresh">("");

// Opening resets everything; a patched provider (our own saves, or a refresh
// from the row) re-syncs only the supplement copy, keeping the typed filter.
watch(
  () => props.open,
  (o) => {
    if (o) {
      q.value = "";
      extra.value = [...(props.provider?.extraModels ?? [])];
    }
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
/** The exact typed name is already known (discovered or supplemented) — then
 *  Enter keeps filtering instead of adding a duplicate. */
const canAdd = computed(() => {
  const s = q.value.trim();
  return !!s && !rows.value.some((r) => r.name === s);
});

function applySaved(p: ProviderPublic) {
  extra.value = [...(p.extraModels ?? [])];
  emit("saved", p);
}

async function putExtra(models: string[]): Promise<ProviderPublic> {
  const r = await req<{ provider: ProviderPublic }>("PUT", `/admin/providers/${props.provider!.id}/extra-models`, { models });
  applySaved(r.provider);
  return r.provider;
}

/** Commit the typed text as supplements. Splits on whitespace/commas so a
 *  pasted list adds in one go; names already known are skipped. */
async function add() {
  if (!props.provider || busy.value || !canAdd.value) return;
  const tokens = [...new Set(q.value.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))].filter(
    (x) => !extra.value.includes(x),
  );
  if (!tokens.length) return;
  busy.value = "add";
  try {
    await putExtra([...extra.value, ...tokens]);
    q.value = "";
    toast(t("sources.modelAdded", { n: tokens.length }), "success");
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
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="max-w-lg">
      <DialogTitle class="text-base">{{ t("sources.modelsTitle") }}</DialogTitle>
      <DialogDescription>{{ t("sources.modelsDesc", { name: provider?.name ?? "" }) }}</DialogDescription>
      <div class="space-y-2">
        <div class="flex items-center gap-2">
          <Input
            v-model="q"
            :placeholder="t('sources.modelsSearchPh')"
            autocomplete="off"
            spellcheck="false"
            class="font-mono"
            @keydown.enter.prevent="add"
          />
          <Button
            variant="outline" size="icon" class="size-9 shrink-0"
            :disabled="busy !== ''" :title="t('sources.refreshModels')" :aria-label="t('sources.refreshModels')"
            @click="refresh"
          >
            <Loader2 v-if="busy === 'refresh'" class="h-4 w-4 animate-spin" />
            <RefreshCw v-else class="h-4 w-4" />
          </Button>
        </div>
        <div class="max-h-72 divide-y overflow-y-auto rounded-md border">
          <div v-if="!rows.length" class="flex flex-col items-center gap-1 px-4 py-8 text-center">
            <p class="text-sm">{{ t("sources.modelsEmpty") }}</p>
            <p class="text-xs text-muted-foreground">{{ t("sources.modelsEmptyHint") }}</p>
          </div>
          <template v-else>
            <button
              v-if="canAdd"
              type="button"
              class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground"
              :disabled="busy !== ''"
              @click="add"
            >
              <Plus class="h-3.5 w-3.5 shrink-0" />
              <span class="truncate font-mono">{{ t("sources.modelAddRow", { q: q.trim() }) }}</span>
            </button>
            <div v-if="!filtered.length" class="px-3 py-6 text-center text-xs text-muted-foreground">
              {{ t("sources.modelsNoMatch", { q: q.trim() }) }}
            </div>
            <div v-for="r in filtered" :key="r.name" class="flex items-center gap-2 px-3 py-1.5">
              <span class="min-w-0 flex-1 truncate font-mono text-sm" :title="r.name">{{ r.name }}</span>
              <Badge v-if="r.manual" variant="secondary" class="shrink-0">{{ t("sources.modelTagManual") }}</Badge>
              <Badge v-else variant="muted" class="shrink-0">{{ t("sources.modelTagDiscovered") }}</Badge>
              <button
                v-if="r.manual"
                type="button"
                class="shrink-0 rounded-sm text-muted-foreground transition-colors hover:text-destructive"
                :disabled="busy !== ''" :aria-label="t('sources.modelRemove')"
                @click="remove(r.name)"
              >
                <X class="h-3.5 w-3.5" />
              </button>
            </div>
          </template>
        </div>
        <p class="text-xs text-muted-foreground">{{ t("sources.modelsHint", { n: discovered.length, m: extra.length }) }}</p>
      </div>
    </DialogContent>
  </Dialog>
</template>
