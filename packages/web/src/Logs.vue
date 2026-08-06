<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { req } from "@/api";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Activity, RefreshCw, Pause, Play, Loader2, Search, ChevronRight, ChevronDown } from "lucide-vue-next";

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
}

const logs = ref<LogEntry[]>([]);
const live = ref(true);
const refreshing = ref(false);

const filterModel = ref("all");
const filterProvider = ref("all");
const filterStatus = ref<string>("all");
const query = ref("");
const expanded = ref<Set<string>>(new Set());

let timer: number | undefined;

async function load() {
  refreshing.value = true;
  try {
    const r = await req<{ logs: LogEntry[] }>("GET", "/admin/logs");
    logs.value = r.logs;
  } catch {
    /* ignore — best-effort polling */
  } finally {
    refreshing.value = false;
  }
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

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}
function fmtFull(ts: number): string {
  return new Date(ts).toLocaleString();
}
function rowKey(l: LogEntry): string {
  return `${l.ts}-${l.model}-${l.status}`;
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
  const all = filtered.value;
  const total = all.length;
  const success = all.filter((l) => l.status >= 200 && l.status < 300).length;
  const fail = all.filter((l) => l.status >= 400).length;
  const avgMs = total ? Math.round(all.reduce((s, l) => s + l.ms, 0) / total) : 0;
  return { total, success, fail, avgMs };
});

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
          <Activity class="h-4 w-4 text-muted-foreground" />
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
      <!-- filter / search toolbar -->
      <div class="flex flex-wrap items-center gap-2">
        <Select v-model="filterModel">
          <SelectTrigger class="h-8 w-36">
            <SelectValue :placeholder="t('logs.filter.model')" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{{ t("logs.filter.all") }}</SelectItem>
            <SelectItem v-for="m in modelOptions" :key="m" :value="m">{{ m }}</SelectItem>
          </SelectContent>
        </Select>
        <Select v-model="filterProvider">
          <SelectTrigger class="h-8 w-36">
            <SelectValue :placeholder="t('logs.filter.provider')" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{{ t("logs.filter.all") }}</SelectItem>
            <SelectItem v-for="p in providerOptions" :key="p" :value="p">{{ p }}</SelectItem>
          </SelectContent>
        </Select>
        <Select v-model="filterStatus">
          <SelectTrigger class="h-8 w-28">
            <SelectValue :placeholder="t('logs.filter.status')" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{{ t("logs.filter.all") }}</SelectItem>
            <SelectItem value="success">{{ t("logs.filter.success") }}</SelectItem>
            <SelectItem value="error">{{ t("logs.filter.error") }}</SelectItem>
          </SelectContent>
        </Select>
        <div class="relative ml-auto">
          <Search class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input v-model="query" :placeholder="t('logs.searchPh')" class="h-8 w-56 pl-8" />
        </div>
      </div>

      <!-- light summary over the filtered view -->
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>{{ t("logs.summary.total", { n: summary.total }) }}</span>
        <span class="text-emerald-600 dark:text-emerald-500">{{ t("logs.summary.success", { n: summary.success }) }}</span>
        <span class="text-destructive">{{ t("logs.summary.fail", { n: summary.fail }) }}</span>
        <span>{{ t("logs.summary.avgLatency", { ms: summary.avgMs }) }}</span>
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
                    <Badge variant="outline">{{ l.format }}</Badge>
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
          </TableBody>
        </Table>
      </div>
    </CardContent>
  </Card>
</template>
