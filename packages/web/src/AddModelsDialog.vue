<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { req, type ProviderPublic } from "@/api";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import Combobox from "@/components/Combobox.vue";
import NewSourceForm from "@/NewSourceForm.vue";
import { Plus, Loader2 } from "lucide-vue-next";

const { t } = useI18n();

const props = defineProps<{ providers: ProviderPublic[] }>();
const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{ changed: [] }>();

/** Sentinel select value: create a brand-new source inline, then attach the
 *  pasted models to it — collapses the Sources→Models round-trip into one dialog. */
const NEW_SOURCE = "__new__";
/** Sentinel select value: register the model names with NO source. The model is
 *  created enabled-but-chain-empty; the user attaches a source from the model
 *  row's "Add source" action afterwards. Lets you park a custom name before you
 *  know which backend should serve it. */
const NO_SOURCE = "__none__";

const providerId = ref("");
const raw = ref("");
const submitting = ref(false);

// Inline "new source" form (shared component; also used by SourcesDialog and
// AddSourceDialog so the create flow reads the same everywhere).
const newForm = ref<InstanceType<typeof NewSourceForm> | null>(null);

// Discovered models the user has picked via the Combobox, independent of the
// textarea below; their results union with the typed names in effectiveNames.
// Cleared on open and whenever the selected source changes.
const picked = ref<string[]>([]);
// Discovery returned when a brand-new source is created inline. props.providers
// won't contain it until the parent reloads, so we carry the list locally to
// populate the picker for the just-created source immediately.
const createdDiscovered = ref<string[]>([]);

watch(open, (o) => {
  if (!o) return;
  providerId.value = props.providers.length ? props.providers[0].id : NEW_SOURCE;
  raw.value = "";
  picked.value = [];
  createdDiscovered.value = [];
  newForm.value?.reset();
});
// Clear picks when the chosen source changes — a model picked for one source
// shouldn't silently carry over to another.
watch(providerId, () => {
  picked.value = [];
});

const isNew = computed(() => providerId.value === NEW_SOURCE);
const isNone = computed(() => providerId.value === NO_SOURCE);

/** Routing slots a provider serves — its wire formats, plus /responses when the
 *  source opted into it. "全挂" enables a model on every one of these. */
function slotsFor(p: { formats: string[]; supportsResponses?: boolean }): string[] {
  const slots = [...p.formats];
  if (p.supportsResponses && !slots.includes("responses")) slots.push("responses");
  return slots;
}

/** Live preview of the slots the chosen source will enable, shown under the select. */
const selectedSlots = computed(() => {
  if (isNew.value || isNone.value)
    return slotsFor({ formats: newForm.value?.payload.formats ?? [], supportsResponses: newForm.value?.payload.supportsResponses });
  const p = props.providers.find((x) => x.id === providerId.value);
  return p ? slotsFor(p) : [];
});

/** Split pasted text into unique, non-empty model names (order preserved). */
const names = computed(() => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.value.split(/[\s,;]+/)) {
    const n = part.trim();
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
});

/** Effective model-name set = textarea names ∪ picked chips (deduped; typed
 *  names first, picked appended). The Combobox and the textarea are two
 * independent input modes whose results merge here. */
const effectiveNames = computed(() => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of [...names.value, ...picked.value]) {
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
});

/** Discovered models for the selected source — the pool the picker draws from.
 *  Found in props for an existing source; falls back to the captured list for a
 *  source created inline this session (props hasn't reloaded yet). */
const discoveredForSelected = computed<string[]>(() => {
  if (isNone.value) return [];
  const p = props.providers.find((x) => x.id === providerId.value);
  return p ? p.discoveredModels ?? [] : createdDiscovered.value;
});

const canSubmit = computed(() => !!providerId.value && effectiveNames.value.length > 0 && selectedSlots.value.length > 0 && !submitting.value);

/** Enable every pasted model on every format the chosen provider speaks — one
 *  POST per (name, slot). If "new source" is selected, create it first, then
 *  attach the models. Counts distinct names that landed on ≥1 slot. */
async function submit() {
  if (!canSubmit.value) return;
  if (isNew.value && !newForm.value?.validate()) return;
  submitting.value = true;
  try {
    let pid = providerId.value;
    let slots: string[] = [];
    let createdSource = false;
    if (isNew.value) {
      const r = await req<{ provider: ProviderPublic; discovered: string[] }>("POST", "/admin/providers", newForm.value!.payload);
      pid = r.provider.id;
      // Pin the select to the just-created source: a retry (some models failed)
      // then re-enables instead of creating a duplicate source.
      providerId.value = pid;
      // Carry the create response's discovery so the picker can offer the
      // just-created source's models before the parent list reloads.
      createdDiscovered.value = r.discovered ?? r.provider.discoveredModels ?? [];
      slots = slotsFor(r.provider);
      createdSource = true;
      toast(t("sources.added"), "success");
    } else if (isNone.value) {
      // No source: enable the picked slots with an empty provider chain. The
      // models show up enabled-but-sourceless; the user attaches a source later.
      slots = slotsFor({ formats: newForm.value?.payload.formats ?? [], supportsResponses: newForm.value?.payload.supportsResponses });
    } else {
      const p = props.providers.find((x) => x.id === pid);
      slots = p ? slotsFor(p) : [];
    }
    const tasks: { name: string; slot: string }[] = [];
    for (const name of effectiveNames.value) for (const slot of slots) tasks.push({ name, slot });
    const results = await Promise.allSettled(
      tasks.map((task) => req("POST", "/admin/models", { name: task.name, format: task.slot, providers: isNone.value ? [] : [pid] })),
    );
    const okNames = new Set<string>();
    let fail = 0;
    results.forEach((r, i) => {
      if (r.status === "fulfilled") okNames.add(tasks[i].name);
      else fail++;
    });
    if (okNames.size) toast(t("models.addedToast", { n: okNames.size }), "success");
    if (createdSource || okNames.size) emit("changed");
    if (fail) {
      // Partial failure: keep the dialog open with just the failed names, so a
      // retry doesn't re-type them (succeeded names and picks are dropped).
      const failedNames = effectiveNames.value.filter((n) => !okNames.has(n));
      toast(t("models.addModelsFailed", { n: failedNames.length }), "error");
      raw.value = failedNames.join("\n");
      picked.value = [];
    } else {
      open.value = false;
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent :class="isNew ? 'max-w-lg' : 'max-w-md'">
      <div class="flex shrink-0 items-center gap-2 pr-8">
        <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
          <Plus class="h-4 w-4" />
        </span>
        <div class="min-w-0">
          <DialogTitle class="text-base">{{ t("models.addModels") }}</DialogTitle>
          <DialogDescription>{{ t("models.addModelsDesc") }}</DialogDescription>
        </div>
      </div>

      <div class="min-h-0 flex-1 space-y-3 overflow-y-auto">
        <div class="space-y-1.5">
          <label class="text-xs font-medium text-muted-foreground">{{ t("models.providerLabel") }}</label>
          <Select v-model="providerId">
            <SelectTrigger>
              <SelectValue :placeholder="t('models.providerPh')" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem :value="NEW_SOURCE">{{ t("models.newSourceOpt") }}</SelectItem>
              <SelectItem :value="NO_SOURCE">{{ t("models.noneSourceOpt") }}</SelectItem>
              <SelectItem v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</SelectItem>
            </SelectContent>
          </Select>
          <p class="text-xs text-muted-foreground">
            {{ t("models.addModelsSlotsHint") }} <span class="font-medium text-foreground">{{ selectedSlots.join(" / ") || "—" }}</span>
          </p>
        </div>

        <!-- Shared picker for the two "no existing source" modes: the format
             checkboxes drive which endpoints the names land on. "New source"
             additionally fills in name/base URLs/key to create that source first. -->
        <div v-if="isNew || isNone" class="space-y-3 rounded-lg border bg-muted/30 p-4">
          <p class="text-xs text-muted-foreground">{{ isNew ? t("models.addModelsNewHint") : t("models.addModelsNoneHint") }}</p>
          <NewSourceForm ref="newForm" :formats-only="isNone" />
        </div>

        <!-- Existing source (or one just created inline): offer its discovered
             models via the shared searchable picker, so adding more of a
             source's models is one click each instead of typing or re-creating
             the source. -->
        <div v-if="!isNew && !isNone" class="space-y-1.5">
          <div class="flex items-center justify-between gap-2">
            <label class="text-xs font-medium text-muted-foreground">{{ t("models.addModelsDiscoveredLabel") }}</label>
            <span v-if="discoveredForSelected.length" class="text-xs text-muted-foreground">{{ t("models.addModelsDiscoveredHint") }}</span>
          </div>
          <p v-if="!discoveredForSelected.length" class="text-xs text-muted-foreground">{{ t("models.addModelsDiscoveredEmpty") }}</p>
          <Combobox v-else v-model="picked" multi :options="discoveredForSelected" :placeholder="t('models.searchPh')" />
        </div>

        <div class="space-y-1.5">
          <label class="text-xs font-medium text-muted-foreground">{{ t("models.namesLabel") }}</label>
          <textarea
            v-model="raw"
            :placeholder="t('models.addModelsNamesPh')"
            rows="6"
            spellcheck="false"
            class="flex w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
          />
          <p v-if="effectiveNames.length" class="text-xs text-muted-foreground">
            {{ t("models.addModelsCount", { n: effectiveNames.length }) }}
          </p>
        </div>
      </div>

      <div class="flex shrink-0 justify-end gap-2">
        <Button variant="outline" :disabled="submitting" @click="open = false">
          {{ t("common.cancel") }}
        </Button>
        <Button :disabled="!canSubmit" @click="submit">
          <Loader2 v-if="submitting" class="h-4 w-4 animate-spin" />
          <Plus v-else class="h-4 w-4" />
          {{ t("models.addModelsBtn") }}
        </Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
