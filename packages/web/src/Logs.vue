<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { req, type CircuitProvider } from "@/api";
import { FMT_ACCENT, type Fmt } from "@/lib/format";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Activity, RefreshCw, Pause, Play, Loader2, Search, ChevronRight, ChevronDown, Filter, X, Timer, Gauge } from "lucide-vue-next";

const { t } = useI18n();

interface LogEntry {
  ts: number;
  model: string;
  provider: string;
  format: string;
  status: number;
  ms: number;
  stream: boolean;
  error?: string;
  /** Row kind. Absent on legacy lines → a normal call. "cooldown" marks a
   *  circuit-breaker event (a source just entered cooldown), shown distinctly
   *  in the timeline next to the failures that triggered it. */
  kind?: "call" | "cooldown";
  cooldownMs?: number;
  fails?: number;
}

const logs = ref<LogEntry[]>([]);
const live = ref(true);
const refreshing = ref(false);
/** Sources currently in circuit-breaker cooldown (drives the "cooling" strip).
 *  Polled alongside /admin/logs; empty = all healthy (strip hidden). */
const cooling = ref<CircuitProvider[]>([]);
/** Sources currently at their RPM cap (drives the "pacing" strip). Distinct from
 *  cooling — pacing is intentional throttling, not a failure timeout. */
const throttled = ref<CircuitProvider[]>([]);

const filterModel = ref("all");
const filterProvider = ref("all");
const filterStatus = ref<string>("all");
const query = ref("");
const expanded = ref<Set<string>>(new Set());

const filterOpen = ref(false);

/** Persist the filter view across tab switches / reloads (the Logs tab unmounts
 *  when inactive, so component-local state would otherwise be lost). */
const FILTERS_KEY = "myapikey.logs.filters";
try {
  const saved = JSON.parse(localStorage.getItem(FILTERS_KEY) || "null") as {
    model?: string; provider?: string; status?: string; query?: string;
  } | null;
  if (saved) {
    if (typeof saved.model === "string") filterModel.value = saved.model;
    if (typeof saved.provider === "string") filterProvider.value = saved.provider;
    if (saved.status === "success" || saved.status === "error") filterStatus.value = saved.status;
    if (typeof saved.query === "string") query.value = saved.query;
  }
} catch {
  /* corrupt entry — ignore and start clean */
}
watch(
  [filterModel, filterProvider, filterStatus, query],
  () => {
    try {
      localStorage.setItem(
        FILTERS_KEY,
        JSON.stringify({
          model: filterModel.value,
          provider: filterProvider.value,
          status: filterStatus.value,
          query: query.value,
        }),
      );
    } catch {
      /* storage unavailable / full — non-fatal */
    }
  },
);

let timer: number | undefined;

async function load() {
  refreshing.value = true;
  try {
    // Fetch logs and circuit state in parallel, but independently — a circuit
    // endpoint hiccup must not break the log poll (and vice versa).
    const [logsRes, circuitRes] = await Promise.all([
      req<{ logs: LogEntry[] }>("GET", "/admin/logs").catch(() => null),
      req<{ providers: CircuitProvider[] }>("GET", "/admin/circuit").catch(() => null),
    ]);
    if (logsRes) logs.value = logsRes.logs;
    if (circuitRes) {
      cooling.value = circuitRes.providers.filter((p) => p.state === "cooling");
      // A source can be both cooling AND over its cap; show it under cooling (the
      // more urgent, actionable state) so it isn't listed twice.
      throttled.value = circuitRes.providers.filter((p) => p.rpm > 0 && p.rpmUsed >= p.rpm && p.state !== "cooling");
    }
  } finally {
    refreshing.value = false;
  }
}

/** Force-clear a source's cooldown via the strip's "reset" button, then
 *  immediately re-poll so the strip updates (state → open). */
async function resetCircuit(id: string) {
  await req("POST", `/admin/circuit/${id}/reset`).catch(() => {});
  await load();
}

function startPolling() {
  stopPolling();
  timer = window.setInterval(load, 4000);
}
function stopPolling() {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}
function toggleLive() {
  live.value = !live.value;
  if (live.value) {
    load();
    startPolling();
  } else {
    stopPolling();
  }
}

function statusVariant(s: number): "success" | "destructive" | "muted" {
  if (s >= 200 && s < 300) return "success";
  if (s >= 400) return "destructive";
  return "muted";
}

/** Family-colored class for the format tag (openai/anthropic/responses); empty
 *  for anything else so it falls back to the plain outline badge. */
function fmtBadge(format: string): string {
  return FMT_ACCENT[format as Fmt]?.badge ?? "";
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
/** Error rate as a tidy percentage string (0 / 0.5 / 10 — no trailing .0, ≤1
 *  decimal). Shown as a pulse on the Logs summary so the reader sees the
 *  proportion of failures, not a raw count stripped of its denominator. */
function fmtRate(frac: number): string {
  if (frac <= 0) return "0";
  const v = Math.round(frac * 1000) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}
function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}
function fmtFull(ts: number): string {
  return new Date(ts).toLocaleString();
}
function rowKey(l: LogEntry): string {
  return `${l.ts}-${l.model}-${l.provider}-${l.status}-${l.kind ?? "call"}`;
}
function isExpanded(l: LogEntry): boolean {
  return expanded.value.has(rowKey(l));
}
function toggleRow(l: LogEntry) {
  const next = new Set(expanded.value);
  const k = rowKey(l);
  if (next.has(k)) next.delete(k);
  else next.add(k);
  expanded.value = next;
}

const modelOptions = computed(() => [...new Set(logs.value.map((l) => l.model))].sort());
const providerOptions = computed(() => [...new Set(logs.value.map((l) => l.provider))].sort());

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  return logs.value.filter((l) => {
    if (filterModel.value !== "all" && l.model !== filterModel.value) return false;
    if (filterProvider.value !== "all" && l.provider !== filterProvider.value) return false;
    if (filterStatus.value === "success" && !(l.status >= 200 && l.status < 300)) return false;
    if (filterStatus.value === "error" && l.status < 400) return false;
    if (q && !(l.model.toLowerCase().includes(q) || l.provider.toLowerCase().includes(q))) return false;
    return true;
  });
});

const summary = computed(() => {
  // Circuit events are timeline annotations, not calls — keep them out of the
  // call stats so a degraded source doesn't inflate total/error-rate/avg-latency.
  const all = filtered.value.filter((l) => l.kind !== "cooldown");
  const total = all.length;
  const fail = all.filter((l) => l.status >= 400).length;
  const avgMs = total ? Math.round(all.reduce((s, l) => s + l.ms, 0) / total) : 0;
  return { total, fail, avgMs, errorRateStr: fmtRate(total ? fail / total : 0) };
});

/** How many structured filters are currently active (badge on the filter button). */
const activeFilters = computed(
  () =>
    (filterModel.value !== "all" ? 1 : 0) +
    (filterProvider.value !== "all" ? 1 : 0) +
    (filterStatus.value !== "all" ? 1 : 0),
);

/** Active filters rendered as removable chips so the current view state is
 *  always visible at a glance. */
const activeChips = computed(() => {
  const chips: { key: string; label: string; value: string; clear: () => void }[] = [];
  if (filterModel.value !== "all") {
    chips.push({ key: "model", label: t("logs.filter.model"), value: filterModel.value, clear: () => (filterModel.value = "all") });
  }
  if (filterProvider.value !== "all") {
    chips.push({ key: "provider", label: t("logs.filter.provider"), value: filterProvider.value, clear: () => (filterProvider.value = "all") });
  }
  if (filterStatus.value !== "all") {
    chips.push({
      key: "status",
      label: t("logs.filter.status"),
      value: filterStatus.value === "success" ? t("logs.filter.success") : t("logs.filter.error"),
      clear: () => (filterStatus.value = "all"),
    });
  }
  return chips;
});

function clearFilters() {
  filterModel.value = "all";
  filterProvider.value = "all";
  filterStatus.value = "all";
}

onMounted(() => {
  load();
  startPolling();
});
onUnmounted(stopPolling);
</script>

<template>
  <Card>
    <CardHeader>
      <div class="flex items-center justify-between gap-2">
        <CardTitle class="flex items-center gap-2 text-base">
          <Activity class="h-4 w-4 text-primary" />
          {{ t("logs.title") }}
          <Badge v-if="live" variant="success" class="gap-1.5">
            <span class="relative flex h-1.5 w-1.5">
              <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-75" />
              <span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
            </span>
            {{ t("logs.live") }}
          </Badge>
        </CardTitle>
        <div class="flex gap-1">
          <Button variant="outline" size="sm" :disabled="refreshing" @click="load">
            <Loader2 v-if="refreshing" class="h-3.5 w-3.5 animate-spin" />
            <RefreshCw v-else class="h-3.5 w-3.5" />
            <span class="sr-only">{{ t("logs.refresh") }}</span>
          </Button>
          <Button variant="outline" size="sm" :aria-pressed="live" @click="toggleLive">
            <Pause v-if="live" class="h-3.5 w-3.5" />
            <Play v-else class="h-3.5 w-3.5" />
            {{ live ? t("logs.pause") : t("logs.resume") }}
          </Button>
        </div>
      </div>
      <CardDescription>{{ t("logs.desc") }}</CardDescription>
    </CardHeader>
    <CardContent class="space-y-3">
      <!-- plain search + a separate filter button (popover trigger) -->
      <div class="flex flex-wrap items-center gap-2">
        <div class="relative flex-1 sm:max-w-sm">
          <Search class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input v-model="query" :placeholder="t('logs.searchPh')" class="h-8 pl-8" />
        </div>
        <Popover v-model:open="filterOpen">
          <PopoverTrigger as-child>
            <Button variant="outline" size="sm" class="h-8 gap-1.5">
              <Filter class="h-3.5 w-3.5" />
              {{ t("logs.filter.title") }}
              <span
                v-if="activeFilters"
                class="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground"
              >{{ activeFilters }}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" class="w-72 p-3">
            <div class="space-y-2.5">
              <div class="flex items-center justify-between">
                <span class="text-xs font-medium">{{ t("logs.filter.title") }}</span>
                <button
                  v-if="activeFilters"
                  type="button"
                  class="text-xs text-primary hover:underline"
                  @click="clearFilters"
                >
                  {{ t("logs.filter.clear") }}
                </button>
              </div>
              <div class="space-y-2">
                <div class="grid grid-cols-[3.5rem_1fr] items-center gap-2">
                  <span class="text-xs text-muted-foreground">{{ t("logs.filter.model") }}</span>
                  <Select v-model="filterModel">
                    <SelectTrigger class="h-8 w-full">
                      <SelectValue :placeholder="t('logs.filter.model')" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{{ t("logs.filter.all") }}</SelectItem>
                      <SelectItem v-for="m in modelOptions" :key="m" :value="m">{{ m }}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div class="grid grid-cols-[3.5rem_1fr] items-center gap-2">
                  <span class="text-xs text-muted-foreground">{{ t("logs.filter.provider") }}</span>
                  <Select v-model="filterProvider">
                    <SelectTrigger class="h-8 w-full">
                      <SelectValue :placeholder="t('logs.filter.provider')" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{{ t("logs.filter.all") }}</SelectItem>
                      <SelectItem v-for="p in providerOptions" :key="p" :value="p">{{ p }}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div class="grid grid-cols-[3.5rem_1fr] items-center gap-2">
                  <span class="text-xs text-muted-foreground">{{ t("logs.filter.status") }}</span>
                  <Select v-model="filterStatus">
                    <SelectTrigger class="h-8 w-full">
                      <SelectValue :placeholder="t('logs.filter.status')" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{{ t("logs.filter.all") }}</SelectItem>
                      <SelectItem value="success">{{ t("logs.filter.success") }}</SelectItem>
                      <SelectItem value="error">{{ t("logs.filter.error") }}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <!-- active filters as removable chips so the current view is always visible -->
      <div v-if="activeChips.length" class="flex flex-wrap items-center gap-1.5">
        <span
          v-for="c in activeChips"
          :key="c.key"
          class="inline-flex items-center gap-1 rounded-full border border-input bg-muted/40 py-0.5 pl-2.5 pr-1 text-xs"
        >
          <span class="text-muted-foreground">{{ c.label }}:</span>
          <span class="font-medium">{{ c.value }}</span>
          <button
            type="button"
            class="rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            :aria-label="t('logs.filter.remove', { label: c.label })"
            @click="c.clear"
          >
            <X class="h-3 w-3" />
          </button>
        </span>
        <button type="button" class="text-xs text-muted-foreground hover:text-foreground" @click="clearFilters">
          {{ t("logs.filter.clear") }}
        </button>
      </div>

      <!-- light summary over the filtered view: window count + error rate (the
           actionable pulse) + recent-mean latency. Lead with "近 N 次调用" so the
           count reads as the recent window rather than a lifetime total, and show
           failures as a rate so 1-in-200 isn't confused with 1-in-10. -->
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>{{ t("logs.summary.window", { n: summary.total }) }}</span>
        <span :class="{ 'text-destructive': summary.fail > 0 }">{{ t("logs.summary.errorRate", { pct: summary.errorRateStr }) }}</span>
        <span>{{ t("logs.summary.avgLatency", { ms: fmtMs(summary.avgMs) }) }}</span>
      </div>

      <!-- live "currently cooling" strip — only rendered when ≥1 source is in
           circuit-breaker cooldown, so a healthy gateway shows no clutter. -->
      <div v-if="cooling.length" class="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
        <div class="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
          <Timer class="h-4 w-4" />
          {{ t("logs.circuit.stripTitle") }}
        </div>
        <ul class="space-y-1.5">
          <li v-for="p in cooling" :key="p.id" class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span class="font-medium">{{ p.name }}</span>
            <Badge variant="warning" class="gap-1 whitespace-nowrap">
              <Timer class="h-3 w-3" />
              {{ t("logs.circuit.remaining", { s: p.secondsLeft }) }}
            </Badge>
            <span class="break-all text-muted-foreground">{{ p.lastReason || t("logs.circuit.reasonUnknown") }}</span>
            <Button variant="outline" size="sm" class="ml-auto h-6 gap-1" @click="resetCircuit(p.id)">
              <RefreshCw class="h-3 w-3" />
              {{ t("logs.circuit.reset") }}
            </Button>
          </li>
        </ul>
      </div>

      <!-- live "at its RPM cap right now" strip — pacing is intentional throttling
           (a free/limited source being used gently), not a failure, so it gets its
           own tone. Hidden unless ≥1 configured source is at its cap; self-clears
           as the 60s window slides, so there's no reset button. -->
      <div v-if="throttled.length" class="space-y-2 rounded-lg border border-orange-500/30 bg-orange-500/5 p-3">
        <div class="flex items-center gap-1.5 text-xs font-medium text-orange-700 dark:text-orange-400">
          <Gauge class="h-4 w-4" />
          {{ t("logs.pacing.stripTitle") }}
        </div>
        <ul class="space-y-1.5">
          <li v-for="p in throttled" :key="p.id" class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span class="font-medium">{{ p.name }}</span>
            <Badge variant="outline" class="gap-1 whitespace-nowrap">
              <Gauge class="h-3 w-3" />
              {{ t("logs.pacing.at", { used: p.rpmUsed, cap: p.rpm }) }}
            </Badge>
            <span class="text-muted-foreground">{{ t("logs.pacing.reason") }}</span>
          </li>
        </ul>
      </div>

      <p v-if="!logs.length" class="py-6 text-center text-sm text-muted-foreground">{{ t("logs.empty") }}</p>
      <p v-else-if="!filtered.length" class="py-6 text-center text-sm text-muted-foreground">{{ t("logs.noMatch") }}</p>
      <div v-else class="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead class="w-8"></TableHead>
              <TableHead>{{ t("logs.col.time") }}</TableHead>
              <TableHead>{{ t("logs.col.model") }}</TableHead>
              <TableHead>{{ t("logs.col.provider") }}</TableHead>
              <TableHead>{{ t("logs.col.format") }}</TableHead>
              <TableHead class="text-right">{{ t("logs.col.latency") }}</TableHead>
              <TableHead class="text-right">{{ t("logs.col.status") }}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <template v-for="l in filtered" :key="rowKey(l)">
              <!-- circuit-breaker event: a source just entered cooldown. Shown
                   in-line in the timeline so it sits next to the failed calls
                   that caused it, explaining why failover happened. -->
              <TableRow v-if="l.kind === 'cooldown'" class="bg-amber-500/5 hover:bg-amber-500/10">
                <TableCell colspan="7" class="py-2">
                  <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    <span class="font-mono text-muted-foreground">{{ fmtTime(l.ts) }}</span>
                    <Badge variant="warning" class="gap-1 whitespace-nowrap">
                      <Timer class="h-3 w-3" />
                      {{ t("logs.circuit.badge") }}
                    </Badge>
                    <span class="font-medium">{{ l.provider }}</span>
                    <span class="text-muted-foreground">{{ t("logs.circuit.failures", { n: l.fails }) }}</span>
                    <span class="text-muted-foreground">{{ t("logs.circuit.cooldown", { s: Math.round((l.cooldownMs ?? 0) / 1000) }) }}</span>
                    <span class="break-all text-muted-foreground">{{ l.error || t("logs.circuit.reasonUnknown") }}</span>
                  </div>
                </TableCell>
              </TableRow>
              <template v-else>
              <TableRow class="cursor-pointer hover:bg-muted/50" @click="toggleRow(l)">
                <TableCell class="w-8 text-muted-foreground">
                  <component :is="isExpanded(l) ? ChevronDown : ChevronRight" class="h-3.5 w-3.5" />
                </TableCell>
                <TableCell class="font-mono text-xs text-muted-foreground" :title="fmtFull(l.ts)">
                  {{ fmtTime(l.ts) }}
                </TableCell>
                <TableCell class="font-mono text-xs">{{ l.model }}</TableCell>
                <TableCell class="text-sm">{{ l.provider }}</TableCell>
                <TableCell>
                  <span class="inline-flex items-center gap-1.5">
                    <Badge variant="outline" :class="fmtBadge(l.format)">{{ l.format }}</Badge>
                    <Badge v-if="l.stream" variant="muted" class="text-[10px]">{{ t("logs.stream") }}</Badge>
                  </span>
                </TableCell>
                <TableCell class="text-right font-mono text-xs text-muted-foreground">{{ fmtMs(l.ms) }}</TableCell>
                <TableCell class="text-right">
                  <Badge :variant="statusVariant(l.status)" class="font-mono">{{ l.status }}</Badge>
                </TableCell>
              </TableRow>
              <TableRow v-if="isExpanded(l)" class="hover:bg-transparent">
                <TableCell colspan="7" class="bg-muted/30">
                  <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 px-2 py-2 text-xs sm:grid-cols-[auto_1fr_auto_1fr]">
                    <dt class="text-muted-foreground">{{ t("logs.detail.time") }}</dt>
                    <dd class="font-mono">{{ fmtFull(l.ts) }}</dd>
                    <dt class="text-muted-foreground">{{ t("logs.detail.latency") }}</dt>
                    <dd class="font-mono">{{ fmtMs(l.ms) }}</dd>
                    <dt class="text-muted-foreground">{{ t("logs.detail.stream") }}</dt>
                    <dd>{{ l.stream ? t("logs.detail.streamYes") : t("logs.detail.streamNo") }}</dd>
                    <dt class="text-muted-foreground">{{ t("logs.detail.error") }}</dt>
                    <dd class="break-all font-mono">{{ l.error || t("logs.detail.errorNone") }}</dd>
                  </dl>
                </TableCell>
              </TableRow>
              </template>
            </template>
          </TableBody>
        </Table>
      </div>
    </CardContent>
  </Card>
</template>
