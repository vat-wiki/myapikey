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
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { Brain, Check, Loader2, Pin, SlidersHorizontal, TriangleAlert, Zap } from "lucide-vue-next";
import type { ModelView } from "@/api";
import type { LastFail } from "@/api";
import { FMT_ACCENT, FMT_META, providerColor } from "@/lib/format";
import { samplingSummary } from "@/lib/models";

/** One chain line rendered in FULL — every slot as ONE LIST ROW (number,
 *  source, upstream mapping, thinking, per-source probe), shown in a popover
 *  off the collapsed serving chip on both Models views. Probe state comes
 *  from the owner. `active` marks the slot that actually served most recently
 *  (ring); `fails` flags slots with a recent failed call — click the marker
 *  for the real error text. Each non-first row carries a pin: `useSlot`
 *  makes that source the serving one by moving it to the front of the chain
 *  (failover order for the rest is kept). */
const props = defineProps<{
  model: ModelView;
  line: ChainLine;
  active?: number;
  fails?: LastFail[];
  slotState: (m: ModelView, line: ChainLine, i: number) => { state: "testing" | "ok" | "fail"; status?: number; provider?: string; error?: string } | null;
  slotTitle: (m: ModelView, line: ChainLine, i: number) => string;
  slotClass: (m: ModelView, line: ChainLine, i: number) => string;
  probeSlot: (m: ModelView, line: ChainLine, i: number) => void;
  useSlot: (m: ModelView, line: ChainLine, si: number) => void;
}>();

const { t } = useI18n();

/** The most recent failure recorded against slot `si` (undefined = clean). */
function failFor(si: number): LastFail | undefined {
  const hits = (props.fails ?? []).filter((f) => f.providerId === props.line.slots[si].id);
  return hits.length ? hits.reduce((a, b) => (b.ts >= a.ts ? b : a)) : undefined;
}

/** Which slot's failure detail is expanded (one at a time). */
const errOpen = ref<number | null>(null);
function toggleErr(si: number) {
  errOpen.value = errOpen.value === si ? null : si;
}
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
    <!-- one row per slot, in priority order -->
    <div class="space-y-1" :class="{ 'opacity-60': !line.enabled }">
      <template v-for="(s, si) in line.slots" :key="si">
        <div
          class="flex items-center gap-2 rounded-md border px-2 py-1.5 transition-colors"
          :class="[slotClass(model, line, si), si === active ? 'ring-1 ring-primary/60' : '']"
          :title="slotState(model, line, si) ? slotTitle(model, line, si) : undefined"
        >
          <span class="w-3 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground/60">{{ si + 1 }}</span>
          <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="providerColor(s.id).solid" />
          <div class="min-w-0 flex-1 leading-tight">
            <div class="truncate text-xs font-medium">{{ s.name }}</div>
            <div v-if="s.model || s.thinking || samplingSummary(s.sampling)" class="flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
              <span v-if="s.model" class="min-w-0 truncate" :title="s.model">› {{ s.model }}</span>
              <span
                v-if="s.thinking"
                class="inline-flex shrink-0 items-center gap-0.5"
                :title="t('models.editor.thinkingLabel')"
              >
                <Brain class="h-2.5 w-2.5" />{{ s.thinking }}
              </span>
              <span
                v-if="samplingSummary(s.sampling)"
                class="inline-flex shrink-0 items-center gap-0.5"
                :title="t('models.editor.samplingLabel')"
              >
                <SlidersHorizontal class="h-2.5 w-2.5" />{{ samplingSummary(s.sampling) }}
              </span>
            </div>
          </div>
          <!-- set as serving source: moves this slot to the front of the
               chain — later calls try it first; failover order is kept -->
          <button
            v-if="si !== 0"
            type="button"
            class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/40 transition-colors hover:bg-accent hover:text-accent-foreground"
            :title="t('models.chainUseTip')"
            :aria-label="`${t('models.chainUseTip')} · ${s.name}`"
            @click.stop="useSlot(model, line, si)"
          >
            <Pin class="h-3 w-3" />
          </button>
          <template v-if="line.enabled">
            <Check v-if="slotState(model, line, si)?.state === 'ok'" class="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span
              v-else-if="slotState(model, line, si)?.state === 'fail'"
              class="shrink-0 font-mono text-[11px] font-semibold text-destructive"
            >{{ slotState(model, line, si)?.status || "✗" }}</span>
            <!-- recent real-traffic failure: click for the actual error text -->
            <button
              v-if="failFor(si)"
              type="button"
              class="inline-flex shrink-0 items-center gap-0.5 rounded px-0.5 font-mono text-[10px] font-semibold text-destructive transition-colors hover:bg-destructive/10"
              :title="t('models.chainFailHint')"
              :aria-label="t('models.chainFailHint')"
              @click.stop="toggleErr(si)"
            >
              <TriangleAlert class="h-3 w-3" />{{ failFor(si)!.status || "?" }}
            </button>
            <button
              v-if="slotState(model, line, si)?.state !== 'testing'"
              type="button"
              class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/40 transition-colors hover:bg-accent hover:text-accent-foreground"
              :title="t('models.testSourceHint')"
              :aria-label="`${t('models.testSource')} · ${s.name}`"
              @click.stop="probeSlot(model, line, si)"
            >
              <Zap class="h-3 w-3" />
            </button>
            <Loader2 v-else class="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
          </template>
        </div>
        <!-- failure detail right under its row: the real message the last failed call saw -->
        <div
          v-if="errOpen === si && failFor(si)"
          class="rounded-md bg-destructive/10 px-2 py-1.5 font-mono text-[11px] break-all whitespace-pre-wrap text-destructive"
        >
          <span class="opacity-70">HTTP {{ failFor(si)!.status }} · </span>{{ failFor(si)!.error || t("models.probeFail") }}
        </div>
      </template>
    </div>
  </div>
</template>
