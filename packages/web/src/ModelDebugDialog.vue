<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { req, type ModelView, type DebugCapture } from "@/api";
import { fmtLabel, providerColor } from "@/lib/format";
import { toast } from "@/lib/toast";
import { copyText } from "@/lib/clipboard";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ArrowLeft, Brain, Copy, Loader2, RefreshCw, Bug, X } from "lucide-vue-next";

/** Per-model debug capture (GET/PUT/DELETE /admin/models/:name/debug*).
 *  Two tiers, one timeline: failed upstream attempts are ALWAYS recorded (a
 *  global in-memory net, so an error can be inspected after the fact without
 *  pre-arming anything — rows tagged 自动); successful attempts are recorded
 *  only while the switch is on (last 50). Everything lives only in gateway
 *  memory — the switch-off clears the switch buffer, the net ages out and can
 *  be scrubbed per model. Deliberately lean. */
const props = defineProps<{ open: boolean; model: ModelView | null }>();
const emit = defineEmits<{ "update:open": [boolean]; changed: [] }>();
const { t } = useI18n();

const enabled = ref(false);
const captures = ref<DebugCapture[]>([]);
const failures = ref<DebugCapture[]>([]);
const loading = ref(false);
const saving = ref(false);
const detail = ref<DebugCapture | null>(null);

async function load() {
  if (!props.model) return;
  loading.value = true;
  try {
    const r = await req<{ enabled: boolean; captures: DebugCapture[]; failures: DebugCapture[] }>(
      "GET",
      `/admin/models/${encodeURIComponent(props.model.name)}/debug`,
    );
    enabled.value = r.enabled;
    captures.value = r.captures;
    failures.value = r.failures;
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.open,
  (o) => {
    if (o) {
      detail.value = null;
      void load();
    }
  },
);

async function toggle(v: boolean | undefined) {
  if (!props.model || saving.value) return;
  saving.value = true;
  try {
    const r = await req<{ enabled: boolean }>(
      "PUT",
      `/admin/models/${encodeURIComponent(props.model.name)}/debug`,
      { enabled: v === true },
    );
    enabled.value = r.enabled;
    if (!r.enabled) captures.value = [];
    emit("changed");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    saving.value = false;
  }
}

async function clearFails() {
  if (!props.model || loading.value) return;
  loading.value = true;
  try {
    await req("DELETE", `/admin/models/${encodeURIComponent(props.model.name)}/debug/fails`);
    failures.value = [];
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    loading.value = false;
  }
}

const isFail = (c: DebugCapture) => c.status >= 400 || c.status === 0;
/** One newest-first timeline. A failure made while the switch was on sits in
 *  BOTH server buffers — show it once, from the net, tagged 自动. */
const rows = computed(() => {
  const switchOnly = captures.value.filter((c) => !isFail(c));
  return [
    ...failures.value.map((c) => ({ c, auto: true })),
    ...switchOnly.map((c) => ({ c, auto: false })),
  ].sort((a, b) => b.c.ts - a.c.ts);
});

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

function size(s: string | undefined): string {
  if (!s) return "0B";
  const n = new TextEncoder().encode(s).length;
  return n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`;
}

const full = ref(false);
watch(detail, () => (full.value = false));

const STR_MAX = 300;

function collapse(v: unknown, hit: { cut: boolean }): unknown {
  if (typeof v === "string") {
    if (v.length <= STR_MAX) return v;
    hit.cut = true;
    return `${v.slice(0, STR_MAX)}…${t("models.debugOmitted", { n: v.length - STR_MAX })}`;
  }
  if (Array.isArray(v)) return v.map((x) => collapse(x, hit));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = collapse(val, hit);
    return o;
  }
  return v;
}

function view(s: string | undefined): { text: string; cut: boolean } {
  if (!s) return { text: "", cut: false };
  try {
    const obj = JSON.parse(s) as unknown;
    const hit = { cut: false };
    const shown = collapse(obj, hit);
    return { text: JSON.stringify(full.value ? obj : shown, null, 2), cut: hit.cut };
  } catch {
    return { text: s, cut: false };
  }
}

const reqView = computed(() => view(detail.value?.request));
const respView = computed(() => view(detail.value?.response));

async function copy(s: string | undefined) {
  if (!s) return;
  const ok = await copyText(s);
  toast(ok ? t("connect.copied") : t("connect.copyFailed"), ok ? "success" : "error");
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="max-w-3xl">
      <DialogTitle class="text-base">{{ t("models.debugTitle", { name: model?.name ?? "" }) }}</DialogTitle>
      <DialogDescription class="sr-only">{{ t("models.debugDesc") }}</DialogDescription>

      <!-- detail: one captured attempt -->
      <template v-if="detail">
        <div class="flex flex-wrap items-center gap-1.5">
          <Button variant="ghost" size="sm" class="h-7 px-2 text-muted-foreground" @click="detail = null">
            <ArrowLeft class="h-3.5 w-3.5" />{{ t("models.debugBack") }}
          </Button>
          <span class="h-4 w-px bg-border" aria-hidden="true" />
          <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="providerColor(detail.providerId).solid" />
          <span class="font-medium">{{ detail.provider }}</span>
          <span v-if="detail.upstreamModel" class="font-mono text-xs text-muted-foreground">› {{ detail.upstreamModel }}</span>
          <Badge variant="outline" class="shrink-0">{{ fmtLabel(detail.format) }}</Badge>
          <Badge v-if="detail.stream" variant="secondary" class="shrink-0">SSE</Badge>
          <Badge v-if="detail.status === 0" variant="secondary" class="shrink-0">{{ t("models.debugNetwork") }}</Badge>
          <Badge v-else-if="detail.status < 300" variant="success" class="shrink-0">{{ detail.status }}</Badge>
          <Badge v-else variant="destructive" class="shrink-0">{{ detail.status }}</Badge>
          <Badge v-if="detail.truncated" variant="secondary" class="shrink-0">{{ t("models.debugTruncated") }}</Badge>
          <span class="ml-auto font-mono text-xs text-muted-foreground">{{ time(detail.ts) }} · {{ detail.ms }}ms</span>
        </div>
        <p v-if="detail.error" class="text-xs text-destructive">{{ detail.error }}</p>

        <div class="space-y-1">
          <div class="flex items-center justify-between">
            <span class="text-xs font-medium text-muted-foreground">{{ t("models.debugReq") }} · {{ size(detail.request) }}</span>
            <div class="flex items-center">
              <Button v-if="reqView.cut" variant="ghost" size="sm" class="h-6 px-2 text-[11px] text-muted-foreground" @click="full = !full">
                {{ full ? t("models.debugCollapse") : t("models.debugExpand") }}
              </Button>
              <Button variant="ghost" size="icon" class="size-6 text-muted-foreground" :title="t('connect.copy')" :aria-label="t('connect.copy')" @click="copy(detail.request)">
                <Copy class="h-3 w-3" />
              </Button>
            </div>
          </div>
          <pre class="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 p-3 font-mono text-xs">{{ reqView.text }}</pre>
        </div>

        <div v-if="detail.response !== undefined" class="space-y-1">
          <div class="flex items-center justify-between">
            <span class="text-xs font-medium text-muted-foreground">{{ t("models.debugResp") }} · {{ size(detail.response) }}</span>
            <div class="flex items-center">
              <Button v-if="respView.cut" variant="ghost" size="sm" class="h-6 px-2 text-[11px] text-muted-foreground" @click="full = !full">
                {{ full ? t("models.debugCollapse") : t("models.debugExpand") }}
              </Button>
              <Button variant="ghost" size="icon" class="size-6 text-muted-foreground" :title="t('connect.copy')" :aria-label="t('connect.copy')" @click="copy(detail.response)">
                <Copy class="h-3 w-3" />
              </Button>
            </div>
          </div>
          <pre class="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 p-3 font-mono text-xs">{{ respView.text }}</pre>
        </div>
      </template>

      <!-- list: the captured attempts -->
      <template v-else>
        <div class="flex items-center gap-2">
          <Switch :model-value="enabled" :disabled="saving || loading" :aria-label="t('models.debugSwitch')" @update:model-value="toggle" />
          <span class="min-w-0 flex-1 text-sm">{{ t("models.debugSwitch") }}</span>
          <Button
            variant="outline" size="icon" class="size-8 shrink-0"
            :disabled="loading" :title="t('models.debugRefresh')" :aria-label="t('models.debugRefresh')"
            @click="load"
          >
            <Loader2 v-if="loading" class="h-3.5 w-3.5 animate-spin" />
            <RefreshCw v-else class="h-3.5 w-3.5" />
          </Button>
        </div>
        <p class="text-xs text-muted-foreground">{{ t("models.debugHint") }}</p>

        <div v-if="rows.length" class="space-y-1">
          <div class="flex items-center justify-between">
            <span class="text-xs font-medium text-muted-foreground">
              {{ t("models.debugFailsTitle", { n: failures.length }) }}
            </span>
            <Button
              v-if="failures.length"
              variant="ghost" size="icon" class="size-6 text-muted-foreground"
              :disabled="loading" :title="t('models.debugClearFails')" :aria-label="t('models.debugClearFails')"
              @click="clearFails"
            >
              <X class="h-3 w-3" />
            </Button>
          </div>
          <div class="max-h-80 divide-y overflow-y-auto rounded-md border">
            <button
              v-for="(r, i) in rows"
              :key="`${r.c.ts}-${i}`"
              type="button"
              class="flex w-full cursor-pointer flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-1.5 text-left transition-colors hover:bg-muted/50"
              @click="detail = r.c"
            >
              <span class="w-12 shrink-0 font-mono text-xs text-muted-foreground">{{ time(r.c.ts) }}</span>
              <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="providerColor(r.c.providerId).solid" />
              <span class="min-w-0 max-w-40 truncate font-medium">{{ r.c.provider }}</span>
              <span v-if="r.c.upstreamModel" class="min-w-0 max-w-40 truncate font-mono text-xs text-muted-foreground" :title="r.c.upstreamModel">› {{ r.c.upstreamModel }}</span>
              <Badge v-if="r.c.status === 0" variant="secondary" class="shrink-0">{{ t("models.debugNetwork") }}</Badge>
              <Badge v-else-if="r.c.status < 300" variant="success" class="shrink-0 font-mono">{{ r.c.status }}</Badge>
              <Badge v-else variant="destructive" class="shrink-0 font-mono">{{ r.c.status }}</Badge>
              <span
                v-if="r.c.thinking"
                class="inline-flex shrink-0 items-center gap-0.5 font-mono text-[10px] text-muted-foreground"
                :title="t('models.editor.thinkingLabel')"
              >
                <Brain class="h-2.5 w-2.5" />{{ r.c.thinking.value }}
              </span>
              <Badge v-if="r.auto" variant="secondary" class="shrink-0 text-[10px]">{{ t("models.debugAutoTag") }}</Badge>
              <span class="ml-auto shrink-0 font-mono text-xs text-muted-foreground">{{ r.c.ms }}ms · {{ size(r.c.request) }}/{{ size(r.c.response) }}</span>
            </button>
          </div>
        </div>
        <div v-else-if="enabled" class="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <span class="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Bug class="size-4" />
          </span>
          <p class="text-sm text-muted-foreground">{{ t("models.debugEmpty") }}</p>
        </div>
        <div v-else class="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
          {{ t("models.debugEmptyOff") }}
        </div>
      </template>
    </DialogContent>
  </Dialog>
</template>
