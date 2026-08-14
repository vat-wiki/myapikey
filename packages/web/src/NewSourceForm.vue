<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";

/** The inline "create a source" fields, shared by SourcesDialog's add form and
 *  the two Models dialogs' "new source" modes so the flow reads the same
 *  everywhere. Owns its field state; parents drive it through the exposed
 *  reset() / validate() / payload. With `formatsOnly`, just the wire-format
 *  picker — for flows that need slot selection without creating a source. */
const props = defineProps<{ formatsOnly?: boolean }>();
const { t } = useI18n();

const name = ref("");
const baseUrlOpenai = ref("");
const baseUrlAnthropic = ref("");
const apiKey = ref("");
const fmtOpenai = ref(true);
const fmtAnthropic = ref(false);
const responses = ref(false);
const err = ref("");

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

const formats = computed(() => {
  const out: string[] = [];
  if (fmtOpenai.value) out.push("openai");
  if (fmtAnthropic.value) out.push("anthropic");
  return out;
});

/** The POST /admin/providers body, ready to send. */
const payload = computed(() => ({
  name: name.value.trim(),
  baseUrlOpenai: baseUrlOpenai.value,
  baseUrlAnthropic: baseUrlAnthropic.value,
  apiKey: apiKey.value,
  formats: formats.value,
  supportsResponses: fmtOpenai.value && responses.value,
}));

function reset() {
  name.value = apiKey.value = "";
  baseUrlOpenai.value = baseUrlAnthropic.value = "";
  fmtOpenai.value = true;
  fmtAnthropic.value = false;
  responses.value = false;
  err.value = "";
}

/** Validate locally; sets the inline error and returns false when invalid.
 *  formatsOnly skips the name/URL/key checks — no source is being created. */
function validate(): boolean {
  if (!formats.value.length) err.value = t("sources.errFormat");
  else if (props.formatsOnly) {
    err.value = "";
    return true;
  } else if (!name.value.trim() || !apiKey.value) err.value = t("sources.errRequired");
  else if ((fmtOpenai.value && !baseUrlOpenai.value.trim()) || (fmtAnthropic.value && !baseUrlAnthropic.value.trim()))
    err.value = t("sources.errBaseUrl");
  else {
    err.value = "";
    return true;
  }
  return false;
}

defineExpose({ reset, validate, payload });
</script>

<template>
  <div class="space-y-3">
    <div v-if="!formatsOnly" class="space-y-1.5">
      <label class="text-xs font-medium text-muted-foreground">{{ t("sources.nameLabel") }}</label>
      <Input v-model="name" :placeholder="t('sources.namePh')" autocomplete="off" aria-label="name" />
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
            <Checkbox v-model="responses" :disabled="!fmtOpenai" :aria-label="t('sources.responses')" />
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
      <p class="text-xs text-muted-foreground">{{ t("sources.addHint") }}</p>
    </div>
    <div v-if="!formatsOnly && fmtOpenai" class="space-y-1.5">
      <label class="text-xs font-medium text-muted-foreground">{{ t("sources.urlLabelOpenai") }}</label>
      <Input v-model="baseUrlOpenai" :placeholder="t('sources.urlPhOpenai')" autocomplete="off" aria-label="openai base url" />
      <p class="text-xs text-muted-foreground">{{ t("sources.urlHintOpenai") }}</p>
    </div>
    <div v-if="!formatsOnly && fmtAnthropic" class="space-y-1.5">
      <label class="text-xs font-medium text-muted-foreground">{{ t("sources.urlLabelAnthropic") }}</label>
      <Input v-model="baseUrlAnthropic" :placeholder="t('sources.urlPhAnthropic')" autocomplete="off" aria-label="anthropic base url" />
      <p class="text-xs text-muted-foreground">{{ t("sources.urlHintAnthropic") }}</p>
    </div>
    <div v-if="!formatsOnly" class="space-y-1.5">
      <label class="text-xs font-medium text-muted-foreground">{{ t("sources.keyLabel") }}</label>
      <Input v-model="apiKey" type="password" :placeholder="t('sources.keyPh')" autocomplete="new-password" aria-label="api key" />
    </div>
    <p v-if="err" class="text-sm text-destructive">{{ err }}</p>
  </div>
</template>
