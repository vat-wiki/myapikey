<script lang="ts">
import type { ModelProvider } from "@/api";
import type { Fmt } from "@/lib/format";

/** One merged chain line: the formats it serves + its ordered slots. */
export interface ChainLine {
  fs: Fmt[];
  enabled: boolean;
  slots: ModelProvider[];
  key: string;
}
</script>

<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { ArrowRight, Brain, Check, Loader2, Zap } from "lucide-vue-next";
import type { ModelView } from "@/api";
import { FMT_ACCENT, FMT_META, providerColor } from "@/lib/format";

/** One chain line rendered in FULL — every slot as a numbered capsule with
 *  per-slot probe affordances. The popover content behind the collapsed
 *  "in-use" chip on both Models views; probe state comes from the owner.
 *  `active` marks the slot that actually served most recently (ring). */
defineProps<{
  model: ModelView;
  line: ChainLine;
  active?: number;
  slotState: (m: ModelView, line: ChainLine, i: number) => { state: "testing" | "ok" | "fail"; status?: number; provider?: string; error?: string } | null;
  slotTitle: (m: ModelView, line: ChainLine, i: number) => string;
  slotClass: (m: ModelView, line: ChainLine, i: number) => string;
  probeSlot: (m: ModelView, line: ChainLine, i: number) => void;
}>();

const { t } = useI18n();
</script>

<template>
  <div class="space-y-2">
    <!-- which protocols this chain serves -->
    <div class="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
      <template v-for="f in line.fs" :key="f">
        <span class="h-1.5 w-1.5 rounded-full" :class="FMT_ACCENT[f].solid" />
        {{ t(FMT_META[f].label) }}
      </template>
      <span v-if="!line.enabled" class="font-normal">· {{ t("models.routeDisabled") }}</span>
      <span v-if="active !== undefined" class="font-normal">· {{ t("models.chainActiveHint") }}</span>
    </div>
    <div class="flex flex-wrap items-center gap-x-1.5 gap-y-1" :class="{ 'opacity-60': !line.enabled }">
      <template v-for="(s, si) in line.slots" :key="si">
        <ArrowRight v-if="si" class="h-3 w-3 shrink-0 text-muted-foreground/40" />
        <span
          class="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs transition-colors"
          :class="[slotClass(model, line, si), si === active ? 'ring-1 ring-primary/60' : '']"
          :title="slotState(model, line, si) ? slotTitle(model, line, si) : undefined"
        >
          <span class="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">{{ si + 1 }}</span>
          <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="providerColor(s.id).solid" />
          <span class="shrink-0 font-medium">{{ s.name }}</span>
          <span v-if="s.model" class="min-w-0 truncate font-mono text-muted-foreground" :title="s.model">› {{ s.model }}</span>
          <span
            v-if="s.thinking"
            class="inline-flex shrink-0 items-center gap-0.5 font-mono text-[10px] text-muted-foreground"
            :title="t('models.editor.thinkingLabel')"
          >
            <Brain class="h-2.5 w-2.5" />{{ s.thinking }}
          </span>
          <template v-if="line.enabled">
            <Check v-if="slotState(model, line, si)?.state === 'ok'" class="h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span
              v-else-if="slotState(model, line, si)?.state === 'fail'"
              class="shrink-0 font-mono text-[10px] font-semibold text-destructive"
            >{{ slotState(model, line, si)?.status || "✗" }}</span>
            <button
              v-if="slotState(model, line, si)?.state !== 'testing'"
              type="button"
              class="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground/40 transition-colors hover:bg-accent hover:text-accent-foreground"
              :title="t('models.testSourceHint')"
              :aria-label="`${t('models.testSource')} · ${s.name}`"
              @click="probeSlot(model, line, si)"
            >
              <Zap class="h-3 w-3" />
            </button>
            <Loader2 v-else class="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
          </template>
        </span>
      </template>
    </div>
  </div>
</template>
