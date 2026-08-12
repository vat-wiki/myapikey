<script setup lang="ts">
import { useI18n } from "vue-i18n";
import type { StatBucket } from "@/api";
import { FMT_ACCENT, providerColor, type Fmt } from "@/lib/format";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";

const { t } = useI18n();

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
/** Compact token count: 0 / 999 / 1.2k / 12k / 1.2M. */
function fmtTokens(n: number): string {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "") + "k";
  return (n / 1_000_000).toFixed(1) + "M";
}
/** 0–1 fraction → "62%" / "62.5%" / "0%". Mirrors Stats.vue's fmtPct. */
function fmtPct(x: number): string {
  if (!x) return "0%";
  const p = Math.round(x * 1000) / 10; // one decimal
  return (p % 1 === 0 ? p.toFixed(0) : p.toFixed(1)) + "%";
}
const props = defineProps<{
  title: string;
  buckets: StatBucket[];
  /** Largest calls value in this group — bars are scaled to it (100%). */
  max: number;
  kind: "model" | "provider" | "format";
}>();
/** Whether any bucket carries token data — hides the Tokens column entirely on
 *  ranges with only legacy (pre-usage-tracking) log rows. */
const anyTokens = (): boolean => props.buckets.some((b) => b.inputTokens || b.outputTokens);
/** Whether any bucket carries cache data (Anthropic/Ark prompt caching) — hides
 *  the Cache column on ranges with no caching (e.g. a pure-OpenAI setup). */
const anyCache = (): boolean => props.buckets.some((b) => b.cacheRead || b.cacheCreation);
function share(calls: number, max: number): number {
  return max ? Math.round((calls / max) * 100) : 0;
}
function fmtDot(format: string): string | undefined {
  return FMT_ACCENT[format as Fmt]?.solid;
}
</script>

<template>
  <Card>
    <CardHeader class="pb-2">
      <CardTitle class="text-sm">{{ title }}</CardTitle>
    </CardHeader>
    <CardContent>
      <p v-if="!buckets.length" class="py-4 text-center text-xs text-muted-foreground">{{ t("stats.empty") }}</p>
      <Table v-else>
        <TableHeader>
          <TableRow>
            <TableHead>{{ t("stats.col.name") }}</TableHead>
            <TableHead class="w-1/3">{{ t("stats.col.calls") }}</TableHead>
            <TableHead class="text-right">{{ t("stats.col.success") }}</TableHead>
            <TableHead class="text-right">{{ t("stats.col.error") }}</TableHead>
            <TableHead class="text-right">{{ t("stats.col.avgLatency") }}</TableHead>
            <TableHead v-if="anyTokens()" class="text-right">{{ t("stats.col.tokens") }}</TableHead>
            <TableHead v-if="anyCache()" class="text-right">{{ t("stats.col.cacheHit") }}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="b in buckets" :key="b.key">
            <TableCell class="py-1.5">
              <div class="flex items-center gap-1.5">
                <span v-if="kind === 'format' && fmtDot(b.key)" class="h-2 w-2 shrink-0 rounded-full" :class="fmtDot(b.key)"></span>
                <span v-else-if="kind === 'provider' && b.id" class="h-2 w-2 shrink-0 rounded-full" :class="providerColor(b.id).solid"></span>
                <span class="truncate font-mono text-xs">{{ b.key }}</span>
              </div>
            </TableCell>
            <TableCell class="py-1.5">
              <div class="flex items-center gap-2">
                <div class="h-1.5 w-full max-w-[120px] overflow-hidden rounded-full bg-muted">
                  <div class="h-full rounded-full bg-primary/50" :style="{ width: share(b.calls, max) + '%' }"></div>
                </div>
                <span class="font-mono text-xs tabular-nums">{{ b.calls }}</span>
              </div>
            </TableCell>
            <TableCell class="py-1.5 text-right font-mono text-xs text-emerald-600 dark:text-emerald-400">{{ b.success }}</TableCell>
            <TableCell class="py-1.5 text-right font-mono text-xs" :class="b.error ? 'text-destructive' : 'text-muted-foreground'">{{ b.error }}</TableCell>
            <TableCell class="py-1.5 text-right font-mono text-xs text-muted-foreground">{{ fmtMs(b.avgMs) }}</TableCell>
            <TableCell v-if="anyTokens()" class="py-1.5 text-right font-mono text-xs tabular-nums">
              <span v-if="b.inputTokens || b.outputTokens">
                <span class="text-foreground/80">{{ fmtTokens(b.inputTokens) }}</span>
                <span class="text-muted-foreground/50"> / </span>
                <span class="text-foreground/80">{{ fmtTokens(b.outputTokens) }}</span>
              </span>
              <span v-else class="text-muted-foreground/40">—</span>
            </TableCell>
            <TableCell v-if="anyCache()" class="py-1.5 text-right font-mono text-xs tabular-nums">
              <span v-if="b.cacheRead || b.cacheCreation" class="inline-flex flex-col items-end leading-tight">
                <span class="text-amber-600 dark:text-amber-400">{{ fmtPct(b.cacheHitRate) }}</span>
                <span class="text-[10px] text-muted-foreground/60">↑{{ fmtTokens(b.cacheRead) }}</span>
              </span>
              <span v-else class="text-muted-foreground/40">—</span>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </CardContent>
  </Card>
</template>
