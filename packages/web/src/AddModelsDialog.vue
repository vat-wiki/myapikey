<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { req, type ProviderPublic } from "@/api";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
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

// --- inline "new source" form (mirrors SourcesDialog's add form) ---
const newName = ref("");
const newBaseUrlOpenai = ref("");
const newBaseUrlAnthropic = ref("");
const newKey = ref("");
const fmtOpenai = ref(true);
const fmtAnthropic = ref(false);
const newResponses = ref(false);
const formErr = ref("");

// Discovered models the user has ticked on (click-to-add chips), independent of
// the textarea below; their results union with the typed names in effectiveNames.
// Cleared on open and whenever the selected source changes.
const picked = ref<Set<string>>(new Set());
// Discovery returned when a brand-new source is created inline. props.providers
// won't contain it until the parent reloads, so we carry the list locally to
// populate the picker for the just-created source immediately.
const createdDiscovered = ref<string[]>([]);
// Search filter over the discovered-model chip wall — a source can carry many
// models (商汤, opencode, …), so this narrows the wall to matches instead of
// scanning a wall of dozens.
const discQuery = ref("");

watch(open, (o) => {
  if (!o) return;
  providerId.value = props.providers.length ? props.providers[0].id : NEW_SOURCE;
  raw.value = "";
  picked.value = new Set();
  createdDiscovered.value = [];
  discQuery.value = "";
  // reset the new-source form each time the dialog opens
  newName.value = newKey.value = "";
  newBaseUrlOpenai.value = newBaseUrlAnthropic.value = "";
  fmtOpenai.value = true;
  fmtAnthropic.value = false;
  newResponses.value = false;
  formErr.value = "";
});
// Clear chip selections when the chosen source changes — a model picked for one
// source shouldn't silently carry over to another.
watch(providerId, () => {
  picked.value = new Set();
  discQuery.value = "";
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
    return slotsFor({ formats: pickedFormats(), supportsResponses: fmtOpenai.value && newResponses.value });
  const p = props.providers.find((x) => x.id === providerId.value);
  return p ? slotsFor(p) : [];
});

/** Toggle a format checkbox, but never let both be turned off. */
function toggleFmt(which: "openai" | "anthropic") {
  if (which === "openai") {
    if (fmtOpenai.value && !fmtAnthropic.value) return;
    fmtOpenai.value = !fmtOpenai.value;
  } else {
    if (fmtAnthropic.value && !fmtOpenai.value) return;
    fmtAnthropic.value = !fmtAnthropic.value;
  }
}

function pickedFormats(): string[] {
  const out: string[] = [];
  if (fmtOpenai.value) out.push("openai");
  if (fmtAnthropic.value) out.push("anthropic");
  return out;
}

/** Localized error string for the new-source form, or "" when valid. */
function validateNewSource(): string {
  if (!newName.value.trim() || !newKey.value) return t("sources.errRequired");
  if (!pickedFormats().length) return t("sources.errFormat");
  if ((fmtOpenai.value && !newBaseUrlOpenai.value.trim()) || (fmtAnthropic.value && !newBaseUrlAnthropic.value.trim()))
    return t("sources.errBaseUrl");
  return "";
}

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
 *  names first, picked appended). Chips and the textarea are two independent
 *  input modes whose results merge here. */
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

/** Discovered models for the selected source — the pool the chips draw from.
 *  Found in props for an existing source; falls back to the captured list for a
 *  source created inline this session (props hasn't reloaded yet). */
const discoveredForSelected = computed<string[]>(() => {
  if (isNone.value) return [];
  const p = props.providers.find((x) => x.id === providerId.value);
  return p ? p.discoveredModels ?? [] : createdDiscovered.value;
});

/** Discovered models for the chip wall, narrowed by the search box. Empty query
 *  shows the full list. */
const filteredDiscovered = computed(() => {
  const q = discQuery.value.trim().toLowerCase();
  if (!q) return discoveredForSelected.value;
  return discoveredForSelected.value.filter((n) => n.toLowerCase().includes(q));
});

function toggleDiscovered(name: string): void {
  const next = new Set(picked.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  picked.value = next; // immutable replace so dependent computeds re-evaluate
}

const canSubmit = computed(() => !!providerId.value && effectiveNames.value.length > 0 && selectedSlots.value.length > 0 && !submitting.value);

/** Enable every pasted model on every format the chosen provider speaks — one
 *  POST per (name, slot). If "new source" is selected, create it first, then
 *  attach the models. Counts distinct names that landed on ≥1 slot. */
async function submit() {
  if (!canSubmit.value) return;
  if (isNew.value) {
    const err = validateNewSource();
    if (err) {
      formErr.value = err;
      return;
    }
  }
  submitting.value = true;
  try {
    let pid = providerId.value;
    let slots: string[] = [];
    let createdSource = false;
    if (isNew.value) {
      const r = await req<{ provider: ProviderPublic; discovered: string[] }>("POST", "/admin/providers", {
        name: newName.value.trim(),
        baseUrlOpenai: newBaseUrlOpenai.value,
        baseUrlAnthropic: newBaseUrlAnthropic.value,
        apiKey: newKey.value,
        formats: pickedFormats(),
        supportsResponses: fmtOpenai.value && newResponses.value,
      });
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
      slots = slotsFor({ formats: pickedFormats(), supportsResponses: fmtOpenai.value && newResponses.value });
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
    if (fail) toast(t("models.addModelsFailed", { n: fail }), "error");
    if (createdSource || okNames.size) emit("changed");
    if (okNames.size) open.value = false;
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
          <DialogTitle class="text-base">{{ t("models.addModels") }}</DialogTitle>
          <DialogDescription>{{ t("models.addModelsDesc") }}</DialogDescription>
        </div>
      </div>

      <div class="space-y-3">
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
          <div v-if="isNew" class="space-y-1.5">
            <label class="text-xs font-medium text-muted-foreground">{{ t("sources.nameLabel") }}</label>
            <Input v-model="newName" :placeholder="t('sources.namePh')" autocomplete="off" aria-label="name" />
          </div>
          <div class="space-y-1.5">
            <label class="text-xs font-medium text-muted-foreground">{{ t("sources.formats") }}</label>
            <div class="space-y-2 rounded-md border bg-background/50 p-3">
              <div class="space-y-2">
                <div class="flex items-center gap-2.5">
                  <Checkbox
                    :model-value="fmtOpenai"
                    :disabled="fmtOpenai && !fmtAnthropic"
                    aria-label="openai"
                    @update:model-value="toggleFmt('openai')"
                  />
                  <span class="text-sm font-medium leading-none">openai</span>
                  <span class="text-xs text-muted-foreground">/chat/completions</span>
                </div>
                <div class="flex items-center gap-2.5 pl-7">
                  <Checkbox v-model="newResponses" :disabled="!fmtOpenai" :aria-label="t('sources.responses')" />
                  <span class="text-sm leading-none" :class="fmtOpenai ? '' : 'text-muted-foreground'">{{ t("sources.responses") }}</span>
                  <span class="text-xs text-muted-foreground">/responses</span>
                </div>
              </div>
              <Separator />
              <div class="flex items-center gap-2.5">
                <Checkbox
                  :model-value="fmtAnthropic"
                  :disabled="fmtAnthropic && !fmtOpenai"
                  aria-label="anthropic"
                  @update:model-value="toggleFmt('anthropic')"
                />
                <span class="text-sm font-medium leading-none">anthropic</span>
                <span class="text-xs text-muted-foreground">/messages</span>
              </div>
            </div>
          </div>
          <div v-if="isNew && fmtOpenai" class="space-y-1.5">
            <label class="text-xs font-medium text-muted-foreground">{{ t("sources.urlLabelOpenai") }}</label>
            <Input v-model="newBaseUrlOpenai" :placeholder="t('sources.urlPhOpenai')" autocomplete="off" aria-label="openai base url" />
            <p class="text-xs text-muted-foreground">{{ t("sources.urlHintOpenai") }}</p>
          </div>
          <div v-if="isNew && fmtAnthropic" class="space-y-1.5">
            <label class="text-xs font-medium text-muted-foreground">{{ t("sources.urlLabelAnthropic") }}</label>
            <Input v-model="newBaseUrlAnthropic" :placeholder="t('sources.urlPhAnthropic')" autocomplete="off" aria-label="anthropic base url" />
            <p class="text-xs text-muted-foreground">{{ t("sources.urlHintAnthropic") }}</p>
          </div>
          <div v-if="isNew" class="space-y-1.5">
            <label class="text-xs font-medium text-muted-foreground">{{ t("sources.keyLabel") }}</label>
            <Input v-model="newKey" type="password" :placeholder="t('sources.keyPh')" autocomplete="new-password" aria-label="api key" />
          </div>
          <p v-if="isNew && formErr" class="text-sm text-destructive">{{ formErr }}</p>
        </div>

        <!-- Existing source (or one just created inline): offer its discovered
             models as click-to-add chips, so adding more of a source's models
             is one click each instead of typing or re-creating the source. The
             search box narrows the wall — a source can carry many models. -->
        <div v-if="!isNew && !isNone" class="space-y-1.5">
          <div class="flex items-center justify-between gap-2">
            <label class="text-xs font-medium text-muted-foreground">{{ t("models.addModelsDiscoveredLabel") }}</label>
            <span v-if="discoveredForSelected.length" class="text-xs text-muted-foreground">{{ t("models.addModelsDiscoveredHint") }}</span>
          </div>
          <p v-if="!discoveredForSelected.length" class="text-xs text-muted-foreground">{{ t("models.addModelsDiscoveredEmpty") }}</p>
          <template v-else>
            <Input v-model="discQuery" :placeholder="t('models.searchPh')" autocomplete="off" />
            <p v-if="!filteredDiscovered.length" class="text-xs text-muted-foreground">{{ t("models.addModelsDiscoveredNoMatch") }}</p>
            <div v-else class="flex max-h-40 flex-wrap gap-1 overflow-y-auto rounded-md border bg-background/50 p-2">
              <button
                v-for="name in filteredDiscovered"
                :key="name"
                type="button"
                :aria-pressed="picked.has(name)"
                class="inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-xs transition-colors"
                :class="picked.has(name)
                  ? 'border-transparent bg-primary text-primary-foreground shadow-sm'
                  : 'border-input text-muted-foreground hover:bg-accent hover:text-accent-foreground'"
                @click="toggleDiscovered(name)"
              >
                {{ name }}
              </button>
            </div>
          </template>
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

        <div class="flex justify-end gap-2">
          <Button variant="outline" :disabled="submitting" @click="open = false">
            {{ t("common.cancel") }}
          </Button>
          <Button :disabled="!canSubmit" @click="submit">
            <Loader2 v-if="submitting" class="h-4 w-4 animate-spin" />
            <Plus v-else class="h-4 w-4" />
            {{ t("models.addModelsBtn") }}
          </Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
