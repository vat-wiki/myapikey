<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { req, type StatsResult, type StatBucket } from "@/api";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import StatsBreakdown from "@/StatsBreakdown.vue";
import { BarChart3, RefreshCw, Loader2 } from "lucide-vue-next";

const { t } = useI18n();

const ranges = [
  { v: "24h", key: "h24" },
  { v: "7d", key: "d7" },
  { v: "30d", key: "d30" },
  { v: "90d", key: "d90" },
  { v: "all", key: "all" },
] as const;

const range = ref<string>((localStorage.getItem("myapikey.stats.range") as string) || "7d");
if (!ranges.some((r) => r.v === range.value)) range.value = "7d";
watch(range, (v) => {
  try {
    localStorage.setItem("myapikey.stats.range", v);
  } catch {
    /* storage unavailable — non-fatal */
  }
});

const stats = ref<StatsResult | null>(null);
const loading = ref(false);

async function load() {
  loading.value = true;
  try {
    stats.value = await req<StatsResult>("GET", `/admin/stats?range=${range.value}`);
  } catch {
    stats.value = null;
  } finally {
    loading.value = false;
  }
}

watch(range, load);
onMounted(load);

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
function fmtPct(x: number): string {
  if (!x) return "0%";
  const p = Math.round(x * 1000) / 10; // one decimal
  return (p % 1 === 0 ? p.toFixed(0) : p.toFixed(1)) + "%";
}
function fmtAxisDate(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const maxDayCalls = computed(() => stats.value?.byDay.reduce((m, d) => Math.max(m, d.calls), 0) ?? 0);
const CHART_H = 160;
function dayHeights(d: { calls: number; success: number; error: number }): { success: number; error: number } {
  const max = maxDayCalls.value || 1;
  const total = (d.calls / max) * CHART_H;
  const err = (d.error / max) * CHART_H;
  return { success: Math.max(0, Math.round(total - err)), error: Math.round(err) };
}
function maxCalls(buckets: StatBucket[]): number {
  return buckets.reduce((m, b) => Math.max(m, b.calls), 0) || 1;
}

const hasData = computed(() => !!stats.value && stats.value.totals.calls > 0);
</script>

<template>
  <Card>
    <CardHeader>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <CardTitle class="flex items-center gap-2 text-base">
          <BarChart3 class="h-4 w-4 text-primary" />
          {{ t("stats.title") }}
        </CardTitle>
        <div class="flex items-center gap-2">
          <div class="inline-flex rounded-md border bg-muted/30 p-0.5">
            <button
              v-for="r in ranges"
              :key="r.v"
              type="button"
              :class="[
                'rounded-sm px-2.5 py-1 text-xs transition-colors',
                range === r.v ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground',
              ]"
              @click="range = r.v"
            >
              {{ t(`stats.ranges.${r.key}`) }}
            </button>
          </div>
          <Button variant="outline" size="sm" :disabled="loading" @click="load">
            <Loader2 v-if="loading" class="h-3.5 w-3.5 animate-spin" />
            <RefreshCw v-else class="h-3.5 w-3.5" />
            <span class="sr-only">{{ t("stats.refresh") }}</span>
          </Button>
        </div>
      </div>
      <CardDescription>{{ t("stats.desc") }}</CardDescription>
    </CardHeader>
    <CardContent class="space-y-5">
      <div v-if="loading && !stats" class="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 class="h-4 w-4 animate-spin" /> {{ t("stats.loading") }}
      </div>
      <div v-else-if="!hasData" class="py-10 text-center text-sm text-muted-foreground">{{ t("stats.empty") }}</div>

      <template v-else-if="stats">
        <!-- totals -->
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <div class="rounded-lg border bg-muted/20 p-3">
            <div class="text-xs text-muted-foreground">{{ t("stats.totals.calls") }}</div>
            <div class="mt-1 font-mono text-xl tabular-nums">{{ stats.totals.calls }}</div>
          </div>
          <div class="rounded-lg border bg-muted/20 p-3">
            <div class="text-xs text-muted-foreground">{{ t("stats.totals.success") }}</div>
            <div class="mt-1 font-mono text-xl tabular-nums text-emerald-600 dark:text-emerald-400">{{ stats.totals.success }}</div>
          </div>
          <div class="rounded-lg border bg-muted/20 p-3">
            <div class="text-xs text-muted-foreground">{{ t("stats.totals.error") }}</div>
            <div class="mt-1 font-mono text-xl tabular-nums text-destructive">{{ stats.totals.error }}</div>
          </div>
          <div class="rounded-lg border bg-muted/20 p-3">
            <div class="text-xs text-muted-foreground">{{ t("stats.totals.errorRate") }}</div>
            <div class="mt-1 font-mono text-xl tabular-nums">{{ fmtPct(stats.totals.errorRate) }}</div>
          </div>
          <div class="rounded-lg border bg-muted/20 p-3">
            <div class="text-xs text-muted-foreground">{{ t("stats.totals.avgLatency") }}</div>
            <div class="mt-1 font-mono text-xl tabular-nums">{{ fmtMs(stats.totals.avgMs) }}</div>
          </div>
          <div class="rounded-lg border bg-muted/20 p-3">
            <div class="text-xs text-muted-foreground">{{ t("stats.totals.p95") }}</div>
            <div class="mt-1 font-mono text-xl tabular-nums">{{ fmtMs(stats.totals.p95Ms) }}</div>
          </div>
        </div>

        <!-- per-day time series -->
        <div>
          <div class="mb-2 flex items-center justify-between gap-2">
            <div class="text-sm font-medium">{{ t("stats.byDay") }}</div>
            <div v-if="maxDayCalls" class="text-[11px] text-muted-foreground">
              {{ t("stats.peak") }} <span class="font-mono tabular-nums text-foreground">{{ maxDayCalls }}</span>
            </div>
          </div>
          <div class="rounded-lg border p-3">
            <!-- pt-9 leaves a gutter so each bar's hover tooltip stays inside the box -->
            <div class="relative pt-9">
              <div class="flex h-40 gap-px">
                <div
                  v-for="d in stats.byDay"
                  :key="d.day"
                  class="group relative flex min-w-0 flex-1 cursor-default flex-col justify-end"
                >
                  <div
                    :style="{ height: dayHeights(d).success + 'px' }"
                    class="w-full rounded-t-sm bg-emerald-500/70 transition-colors group-hover:bg-emerald-500"
                  ></div>
                  <div
                    :style="{ height: dayHeights(d).error + 'px' }"
                    class="w-full transition-colors group-hover:bg-destructive"
                    :class="dayHeights(d).error ? 'bg-destructive/70' : ''"
                  ></div>
                  <!-- hover tooltip: shows immediately above this day's column -->
                  <div
                    class="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded-md border bg-background px-2 py-1 text-center text-xs shadow-md group-hover:block"
                  >
                    <div class="font-medium">{{ fmtAxisDate(d.day) }}</div>
                    <div class="font-mono tabular-nums">{{ d.calls }} {{ t("stats.callsAxis") }}</div>
                    <div class="text-[10px]">
                      <span class="text-emerald-600 dark:text-emerald-400">{{ d.success }}</span>
                      <span class="text-muted-foreground"> / </span>
                      <span class="text-destructive">{{ d.error }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div class="mt-1.5 flex justify-between text-[10px] text-muted-foreground">
              <span>{{ stats.byDay.length ? fmtAxisDate(stats.byDay[0].day) : "" }}</span>
              <span>{{ stats.byDay.length ? fmtAxisDate(stats.byDay[stats.byDay.length - 1].day) : "" }}</span>
            </div>
          </div>
        </div>

        <!-- breakdowns: model full width, provider + format split -->
        <div class="grid gap-4 lg:grid-cols-2">
          <div class="lg:col-span-2">
            <StatsBreakdown :title="t('stats.byModel')" :buckets="stats.byModel" :max="maxCalls(stats.byModel)" kind="model" />
          </div>
          <StatsBreakdown :title="t('stats.byProvider')" :buckets="stats.byProvider" :max="maxCalls(stats.byProvider)" kind="provider" />
          <StatsBreakdown :title="t('stats.byFormat')" :buckets="stats.byFormat" :max="maxCalls(stats.byFormat)" kind="format" />
        </div>
      </template>
    </CardContent>
  </Card>
</template>
