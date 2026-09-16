<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Input } from "@/components/ui/input";
import { CircleHelp } from "lucide-vue-next";

/** Per-slot default sampling parameters, one LABELED row per field — name +
 *  a help icon (hover for the explanation) + the value box. A filled field
 *  overrides the request's own value of that name; blank passes it through. */
const props = defineProps<{ modelValue: Record<string, string> }>();

const { t } = useI18n();

/** One row per parameter, in the order the server whitelists them. `helpKey`
 *  points at the i18n tooltip text; `ph` shows the field's API-legal range. */
const FIELDS: { key: string; helpKey: string; ph: string }[] = [
  { key: "temperature", helpKey: "models.editor.samplingTipTemp", ph: "0.0 – 2.0" },
  { key: "top_p", helpKey: "models.editor.samplingTipTopP", ph: "0.0 – 1.0" },
  { key: "top_k", helpKey: "models.editor.samplingTipTopK", ph: "0 = off" },
  { key: "presence_penalty", helpKey: "models.editor.samplingTipPres", ph: "-2 – 2" },
  { key: "frequency_penalty", helpKey: "models.editor.samplingTipFreq", ph: "-2 – 2" },
  { key: "seed", helpKey: "models.editor.samplingTipSeed", ph: "integer" },
];

function set(key: string, v: unknown) {
  props.modelValue[key] = String(v ?? "");
}
</script>

<template>
  <div class="grid gap-y-1.5">
    <div v-for="f in FIELDS" :key="f.key" class="flex items-center gap-1.5">
      <span class="inline-flex shrink-0 items-center gap-0.5 font-mono text-xs text-foreground/80">
        {{ f.key }}
        <CircleHelp
          class="h-3 w-3 opacity-60"
          :aria-label="`${f.key}: ${t(f.helpKey)}`"
          :title="t(f.helpKey)"
        />
      </span>
      <Input
        :model-value="props.modelValue[f.key]"
        type="number"
        step="any"
        class="ml-auto h-6 w-20 bg-background px-2 text-right font-mono text-xs"
        :placeholder="f.ph"
        spellcheck="false"
        :aria-label="f.key"
        @update:model-value="(v) => set(f.key, v)"
      />
    </div>
  </div>
  <p class="pt-1.5 text-xs leading-relaxed text-muted-foreground">{{ t("models.editor.samplingTipBase") }}</p>
</template>
