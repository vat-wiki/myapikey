<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { req, type ProviderPublic } from "@/api";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import Combobox from "@/components/Combobox.vue";
import NewSourceForm from "@/NewSourceForm.vue";
import { Plus, Loader2 } from "lucide-vue-next";

const { t } = useI18n();

const props = defineProps<{
  modelName: string;
  providers: ProviderPublic[];
  /** Routing slots this model is enabled on (the routes a source could join). */
  enabledFormats: string[];
  /** Current chain provider ids per routing slot — read-only here, used only to
   *  hint when the selected source is already attached (re-adding is intentional,
   *  not an accident: it adds a second slot for a different upstream model). */
  chainByFormat: Record<string, string[]>;
}>();
const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{ added: [] }>();

const enc = encodeURIComponent;

/** Sentinel select value: create a brand-new source inline, then attach it to
 *  this model — same flow as the Add-models dialog, so there's no round-trip
 *  through Sources when the source you want doesn't exist yet. */
const NEW_SOURCE = "__new__";

const selectedId = ref("");
const upstream = ref("");
const submitting = ref(false);

// Inline "new source" form (shared component; also used by SourcesDialog and
// AddModelsDialog so the create flow reads the same everywhere).
const newForm = ref<InstanceType<typeof NewSourceForm> | null>(null);
// The provider created inline this session. props.providers won't contain it
// until the parent reloads, so we carry it locally to compute attach targets
// and feed the upstream picker's discovery immediately.
const createdProvider = ref<ProviderPublic | null>(null);

function supportsFmt(o: { formats: string[]; supportsResponses?: boolean }, f: string): boolean {
  return f === "responses" ? !!o.supportsResponses : o.formats.includes(f);
}

/** The source selection as a shape supportsFmt understands — either a real
 *  provider, the one created inline (props hasn't reloaded yet), or the
 *  new-source form's picked formats. */
const selectedShape = computed<{ formats: string[]; supportsResponses?: boolean } | null>(() => {
  if (isNew.value) return newForm.value?.payload ?? null;
  return (
    props.providers.find((x) => x.id === selectedId.value) ??
    (createdProvider.value?.id === selectedId.value ? createdProvider.value : null)
  );
});

/** Routes the selected source would be added to: every ENABLED route it speaks.
 *  No exclusion for routes it's already on — re-adding the same source is the
 *  whole point (a second slot mapping a different upstream model). */
function addTargets(pid: string): string[] {
  const p = props.providers.find((x) => x.id === pid);
  if (!p) return [];
  return props.enabledFormats.filter((f) => supportsFmt(p, f));
}

/** Enabled routes the selected source is ALREADY on (for the "already attached"
 *  hint only — does not block re-adding). */
function alreadyAttachedFormats(pid: string): string[] {
  return props.enabledFormats.filter((f) => (props.chainByFormat[f] ?? []).includes(pid));
}

/** Sources that can attach to ≥1 enabled route of this model. Every source that
 *  speaks an enabled route is a candidate — including ones already attached
 *  (attach again = a second slot for a different upstream model). */
const candidates = computed(() =>
  props.providers
    .filter((p) => props.enabledFormats.some((f) => supportsFmt(p, f)))
    .sort((a, b) => a.name.localeCompare(b.name)),
);

const isNew = computed(() => selectedId.value === NEW_SOURCE);

/** Discovered model names for the selected source — the pool the upstream-model
 *  picker offers. Lets you map this slot to a real upstream id by search
 *  instead of typing it blind (a source like 商汤 carries many models). */
const discoveredOptions = computed<string[]>(() => {
  if (isNew.value) return createdProvider.value?.discoveredModels ?? [];
  return props.providers.find((p) => p.id === selectedId.value)?.discoveredModels ?? [];
});

const SHORT: Record<string, string> = {
  openai: "models.fmtOpenaiShort",
  anthropic: "models.fmtAnthropicShort",
  responses: "models.fmtResponsesShort",
};
/** Human labels for the routes the selected source will join, shown under the select. */
const targetsPreview = computed(() => {
  if (!selectedId.value) return [];
  if (isNew.value) {
    const s = selectedShape.value;
    return s ? props.enabledFormats.filter((f) => supportsFmt(s, f)).map((f) => t(SHORT[f] ?? f)) : [];
  }
  return addTargets(selectedId.value).map((f) => t(SHORT[f] ?? f));
});
/** The selected source already occupies a slot on ≥1 route → show the re-add hint. */
const showDupHint = computed(() => !!selectedId.value && !isNew.value && alreadyAttachedFormats(selectedId.value).length > 0);

const canSubmit = computed(() => !!selectedId.value && !submitting.value);

watch(open, (o) => {
  if (!o) return;
  selectedId.value = candidates.value[0]?.id ?? NEW_SOURCE;
  upstream.value = "";
  createdProvider.value = null;
  newForm.value?.reset();
});

/** Attach the source to every enabled route it speaks — one POST per route,
 *  carrying the optional upstream model so add + map happen in a single call.
 *  Re-adding a route the source is already on appends a second slot (the
 *  per-route failover-across-models case). With "new source" selected, create
 *  it first, then attach. */
async function submit() {
  if (!canSubmit.value) return;
  if (isNew.value && !newForm.value?.validate()) return;
  submitting.value = true;
  try {
    let pid = selectedId.value;
    let created = false;
    if (isNew.value) {
      const r = await req<{ provider: ProviderPublic; discovered: string[] }>("POST", "/admin/providers", newForm.value!.payload);
      pid = r.provider.id;
      // Pin the select to the just-created source: a retry (some routes failed)
      // then re-attaches instead of creating a duplicate source.
      selectedId.value = pid;
      createdProvider.value = { ...r.provider, discoveredModels: r.discovered ?? r.provider.discoveredModels ?? [] };
      created = true;
      toast(t("sources.added"), "success");
    }
    const src = createdProvider.value && createdProvider.value.id === pid
      ? createdProvider.value
      : props.providers.find((x) => x.id === pid);
    const addTgts = src ? props.enabledFormats.filter((f) => supportsFmt(src, f)) : [];
    const up = upstream.value.trim();
    const results = await Promise.allSettled(
      addTgts.map((f) => req("POST", `/admin/models/${enc(props.modelName)}/providers`, { format: f, providerId: pid, model: up || undefined })),
    );
    const fail = results.filter((r) => r.status === "rejected").length;
    if (!fail) {
      toast(t("models.sourceAdded"), "success");
      emit("added");
      open.value = false;
    } else {
      // Partial failure: keep the dialog open (pinned to the created source if
      // one was just made) so a retry is one click, not a re-create.
      toast(t("models.addSourcePartial"), "error");
      if (created) emit("added"); // refresh the parent's provider list
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent :class="isNew ? 'max-w-lg' : 'max-w-md'">
      <div class="flex items-center gap-2 pr-8">
        <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
          <Plus class="h-4 w-4" />
        </span>
        <div class="min-w-0">
          <DialogTitle class="text-base">{{ t("models.addSourceTitle") }}</DialogTitle>
          <DialogDescription>{{ t("models.addSourceDesc") }}</DialogDescription>
        </div>
      </div>

      <div class="space-y-3">
        <div class="space-y-1.5">
          <label class="text-xs font-medium text-muted-foreground">{{ t("models.providerLabel") }}</label>
          <Select v-model="selectedId">
            <SelectTrigger>
              <SelectValue :placeholder="t('models.providerPh')" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem :value="NEW_SOURCE">{{ t("models.newSourceOpt") }}</SelectItem>
              <SelectItem v-for="p in candidates" :key="p.id" :value="p.id">{{ p.name }}</SelectItem>
            </SelectContent>
          </Select>
          <p v-if="!candidates.length" class="text-xs text-muted-foreground">{{ t("models.addSourceNone") }}</p>
          <p v-if="targetsPreview.length" class="text-xs text-muted-foreground">
            {{ t("models.addSourceTargetsHint") }} <span class="font-medium text-foreground">{{ targetsPreview.join(" / ") }}</span>
          </p>
          <p v-if="showDupHint" class="text-xs text-amber-600 dark:text-amber-500">{{ t("models.addSourceDupHint") }}</p>
        </div>

        <!-- New source: create it inline, then attach. Same form as everywhere
             else a source can be created. -->
        <div v-if="isNew" class="space-y-3 rounded-lg border bg-muted/30 p-4">
          <p class="text-xs text-muted-foreground">{{ t("models.addSourceNewHint") }}</p>
          <NewSourceForm ref="newForm" />
        </div>

        <div class="space-y-1.5">
          <label class="text-xs font-medium text-muted-foreground">{{ t("models.upstreamLabel") }}</label>
          <Combobox v-model="upstream" :options="discoveredOptions" :placeholder="t('models.upstreamPh')" />
          <p class="text-xs text-muted-foreground">{{ t("models.upstreamHint") }}</p>
        </div>

        <div class="flex justify-end gap-2">
          <Button variant="outline" :disabled="submitting" @click="open = false">
            {{ t("common.cancel") }}
          </Button>
          <Button :disabled="!canSubmit" @click="submit">
            <Loader2 v-if="submitting" class="h-4 w-4 animate-spin" />
            <Plus v-else class="h-4 w-4" />
            {{ t("models.addToChain") }}
          </Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
