<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Input } from "@/components/ui/input";
import type { Fmt } from "@/lib/format";

/** Per-slot default thinking level — the sibling of SamplingPanel with the
 *  same interaction shape: preset chips + a free-form input + one help line.
 *  The value is written in the wire's own dialect: an effort token on the
 *  openai-family routes, a token budget on anthropic. Setting it OVERRIDES the
 *  request's own thinking parameters (compat switches included); clearing it
 *  restores passthrough. */
const value = defineModel<string>({ required: true });

const props = defineProps<{ format: Fmt }>();

const { t } = useI18n();

/** Quick presets, in the wire's own dialect: effort words on the openai-family
 *  routes, token budgets on anthropic. A custom value can always be typed. */
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh"];
const BUDGET_PRESETS = ["1024", "4096", "8192", "16384"];
const presets = props.format === "anthropic" ? BUDGET_PRESETS : EFFORT_LEVELS;
</script>

<template>
  <div class="flex flex-wrap gap-1">
    <button
      v-for="v in presets"
      :key="v"
      type="button"
      class="rounded border px-1.5 py-0.5 font-mono text-[11px] transition-colors"
      :class="value === v ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'"
      :aria-pressed="value === v"
      @click="value = value === v ? '' : v"
    >
      {{ v }}
    </button>
  </div>
  <Input
    :model-value="value"
    class="h-7 w-48 font-mono text-xs"
    spellcheck="false"
    :placeholder="props.format === 'anthropic' ? t('models.editor.thinkingPhBudget') : t('models.editor.thinkingPh')"
    :list="props.format === 'anthropic' ? 'thinking-budgets' : 'thinking-words'"
    :aria-label="t('models.editor.thinkingLabel')"
    @update:model-value="(v) => (value = String(v ?? ''))"
  />
  <p class="pt-1.5 text-[11px] leading-relaxed text-muted-foreground">{{ t("models.editor.thinkingTipBase") }}</p>
</template>
