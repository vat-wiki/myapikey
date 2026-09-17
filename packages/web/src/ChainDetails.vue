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
import { Brain, Check, Loader2, SlidersHorizontal, TriangleAlert, Zap } from "lucide-vue-next";
import type { ModelView } from "@/api";
import type { LastFail, ProviderPublic } from "@/api";
import { FMT_ACCENT, FMT_META, providerColor } from "@/lib/format";
import { samplingSummary } from "@/lib/models";

/** One chain line rendered in FULL — every slot as ONE LIST ROW (number,
 *  source, upstream mapping, thinking, per-source probe), shown in a popover
 *  off the collapsed serving chip on both Models views. Probe state comes
 *  from the owner. `active` marks the slot that actually served most recently
 *  (ring); `fails` flags slots with a recent failed call — click the marker
 *  for the real error text. The row's source name is clickable: an INLINE
 *  expansion (no second floating layer) lists the compatible sources to swap
 *  the slot's provider on the spot; saving goes through the owner's
 *  `setProvider` (same semantics as the editor's provider change — upstream
 *  fields belong to the old backend and are reset). */
const props = defineProps<{
  model: ModelView;
  line: ChainLine;
  providers: ProviderPublic[];
  active?: number;
  fails?: LastFail[];
  slotState: (m: ModelView, line: ChainLine, i: number) => { state: "testing" | "ok" | "fail"; status?: number; provider?: string; error?: string } | null;
  slotTitle: (m: ModelView, line: ChainLine, i: number) => string;
  slotClass: (m: ModelView, line: ChainLine, i: number) => string;
  probeSlot: (m: ModelView, line: ChainLine, i: number) => void;
  setProvider: (m: ModelView, line: ChainLine, si: number, providerId: string) => void;
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

// --- source swap (inline, one open at a time) ---

/** Whether a provider can serve a routing family (responses needs the opt-in) —
 *  same rule as the editor's provider dropdown. */
function supports(p: ProviderPublic, fmt: Fmt): boolean {
  return fmt === "responses" ? !!p.supportsResponses : p.formats.includes(fmt);
}

/** Swap candidates for slot `si`: sources serving EVERY format this line
 *  stands for, plus the slot's current source (so an orphaned chain stays
 *  visible and a swap can be undone without leaving the list). */
function srcOptions(si: number): ProviderPublic[] {
  const cur = props.line.slots[si];
  const compatible = props.providers.filter((p) => props.line.fs.every((f) => supports(p, f)));
  if (compatible.some((p) => p.id === cur.id)) return compatible;
  const orphan = props.providers.find((p) => p.id === cur.id);
  return orphan ? [orphan, ...compatible] : compatible;
}

/** Which slot's source list is expanded (one at a time). */
const srcOpen = ref<number | null>(null);
function toggleSrc(si: number) {
  srcOpen.value = srcOpen.value === si ? null : si;
}

function commitSrc(si: number, p: ProviderPublic) {
  srcOpen.value = null;
  if (p.id === props.line.slots[si].id) return;
  props.setProvider(props.model, props.line, si, p.id);
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
            <div class="min-w-0 truncate text-xs font-medium">
              <!-- source name: click to swap this slot's provider in place -->
              <button
                type="button"
                class="-mx-0.5 inline-flex max-w-full items-center rounded px-0.5 transition-colors hover:bg-accent hover:text-accent-foreground"
                :class="srcOpen === si ? 'bg-accent text-accent-foreground' : ''"
                :title="t('models.chainSourceTip')"
                :aria-label="`${t('models.chainSourceTip')} · ${s.name}`"
                @click.stop="toggleSrc(si)"
              >{{ s.name }}</button>
            </div>
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
        <!-- source swap: compatible sources only (same rule as the editor's
             provider dropdown); the current one stays listed and marked -->
        <div v-if="srcOpen === si" class="max-h-44 space-y-0.5 overflow-y-auto rounded-md border bg-muted/30 p-1">
          <button
            v-for="p in srcOptions(si)"
            :key="p.id"
            type="button"
            class="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs transition-colors hover:bg-accent"
            @click="commitSrc(si, p)"
          >
            <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="providerColor(p.id).solid" />
            <span class="min-w-0 truncate" :class="p.id === s.id ? 'text-primary' : ''">{{ p.name }}</span>
            <Check v-if="p.id === s.id" class="ml-auto h-3 w-3 shrink-0 text-primary" />
          </button>
        </div>
      </template>
    </div>
  </div>
</template>
