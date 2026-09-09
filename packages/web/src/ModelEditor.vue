<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { req, type ModelView, type ProviderPublic } from "@/api";
import type { Fmt } from "@/lib/format";
import { FMT_ACCENT, providerColor } from "@/lib/format";
import { providerModelList } from "@/lib/models";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import Combobox from "@/components/Combobox.vue";
import { Plus, Trash2, ArrowUp, ArrowDown, Loader2, ServerCog, ArrowRight, Brain, TriangleAlert, Info, ChevronDown, SlidersHorizontal } from "lucide-vue-next";

/** The three routing families. A unified chain fans a slot out to every one of
 *  these the slot's provider supports; per-format mode overrides each. */
const FORMATS: Fmt[] = ["openai", "anthropic", "responses"];

/** One editable chain slot in the draft. Blank model = identity (send the
 *  public name upstream); thinking is the slot's default level (effort token
 *  on openai/responses, budget tokens on anthropic). */
interface DraftSlot {
  pid: string;
  model: string;
  thinking: string;
}

const props = defineProps<{
  providers: ProviderPublic[];
  /** null = create. */
  model: ModelView | null;
  /** All current model names — create mode rejects duplicates locally. */
  existingNames: string[];
}>();
const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{ saved: [ModelView] }>();

const { t } = useI18n();

const name = ref("");
const perFmt = ref(false);
const unified = ref<DraftSlot[]>([]);
const fmtSlots = ref<Record<Fmt, DraftSlot[]>>({ openai: [], anthropic: [], responses: [] });
const fmtEnabled = ref<Record<Fmt, boolean>>({ openai: false, anthropic: false, responses: false });
const pace = ref("");
const saving = ref(false);
const nameErr = ref("");
const rowErr = ref<Record<string, string>>({});
const showHelp = ref(false);
const advancedOpen = ref(false);

const enc = encodeURIComponent;

function providerOf(pid: string): ProviderPublic | undefined {
  return props.providers.find((p) => p.id === pid);
}
/** Whether a provider can serve a routing family (responses needs the opt-in). */
function supports(pid: string, fmt: Fmt): boolean {
  const p = providerOf(pid);
  if (!p) return false;
  return fmt === "responses" ? !!p.supportsResponses : p.formats.includes(fmt);
}
/** Upstream suggestions = discovery results + manual supplements (the union
 *  is what this source can actually run). */
function discoveredFor(pid: string): string[] {
  return providerModelList(providerOf(pid));
}

// --- draft lifecycle -------------------------------------------------------

function toDraft(s: { id: string; model?: string; thinking?: string }): DraftSlot {
  return { pid: s.id, model: s.model ?? "", thinking: s.thinking ?? "" };
}
function slotKey(s: { id?: string; pid?: string; model?: string; thinking?: string }): string {
  return `${s.id ?? s.pid}|${s.model ?? ""}|${s.thinking ?? ""}`;
}
/** What a unified chain save would write for `slots`, per format. */
function fanout(slots: DraftSlot[]): Record<Fmt, { enabled: boolean; slots: string[] }> {
  const out = {} as Record<Fmt, { enabled: boolean; slots: string[] }>;
  for (const f of FORMATS) {
    const landed = slots.filter((s) => supports(s.pid, f));
    out[f] = { enabled: landed.length > 0, slots: landed.map(slotKey) };
  }
  return out;
}

function init() {
  nameErr.value = "";
  rowErr.value = {};
  pace.value = "";
  perFmt.value = false;
  showHelp.value = false;
  unified.value = [];
  fmtSlots.value = { openai: [], anthropic: [], responses: [] };
  fmtEnabled.value = { openai: false, anthropic: false, responses: false };
  const m = props.model;
  if (!m) {
    advancedOpen.value = false;
    return;
  }
  name.value = m.name;
  pace.value = m.paceRpm ? String(m.paceRpm) : "";
  advancedOpen.value = !!m.paceRpm;
  for (const f of FORMATS) {
    fmtSlots.value[f] = m[f].providers.map(toDraft);
    fmtEnabled.value[f] = m[f].enabled;
  }
  // Unified mode only when rendering the openai chain through the fan-out
  // reproduces every format's chain exactly (slots, order, mappings, enabled
  // flags). Any divergence — per-format providers, a disabled route, differing
  // thinking defaults — flips the editor into per-format mode.
  const src = [m.openai.providers, m.anthropic.providers, m.responses.providers].find((c) => c.length) ?? m.openai.providers;
  const candidate = src.map(toDraft);
  const projected = fanout(candidate);
  perFmt.value = FORMATS.some((f) => {
    const want = m[f];
    return projected[f].enabled !== want.enabled || projected[f].slots.join(">") !== want.providers.map(slotKey).join(">");
  });
  unified.value = candidate;
}

watch(open, (o) => {
  if (o) init();
});

// --- slot row operations ---------------------------------------------------

function addSlot(target: "unified" | Fmt) {
  const first = props.providers[0]?.id ?? "";
  if (target === "unified") unified.value.push({ pid: first, model: "", thinking: "" });
  else fmtSlots.value[target].push({ pid: first, model: "", thinking: "" });
}
function removeSlot(target: "unified" | Fmt, i: number) {
  if (target === "unified") unified.value.splice(i, 1);
  else fmtSlots.value[target].splice(i, 1);
  delete rowErr.value[target];
}
function moveSlot(target: "unified" | Fmt, i: number, dir: -1 | 1) {
  const arr = target === "unified" ? unified.value : fmtSlots.value[target];
  const j = i + dir;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
}
/** Changing the provider resets the upstream fields — the old upstream name and
 *  thinking belong to the previous backend. */
function onProviderChange(slot: DraftSlot) {
  slot.model = "";
  slot.thinking = "";
}

/** Routes a unified slot would land on — shown as chips under the row, but only
 *  when the picture is not the default "all three" (progressive disclosure). */
function landsOn(s: DraftSlot): Fmt[] {
  return FORMATS.filter((f) => supports(s.pid, f));
}
/** Render the slot's footnote row: partial protocol support or a row error. */
function slotNoteworthy(s: DraftSlot): boolean {
  return landsOn(s).length < FORMATS.length || !!rowErr.value.unified;
}
/** Protocols the unified chain would actually serve — the union of every
 *  slot's landing set. Surfaced as a "fans out to N independent chains"
 *  line so the one-list UI still teaches the per-protocol model. */
const chainUnion = computed<Fmt[]>(() => {
  const set = new Set<Fmt>();
  for (const s of unified.value) for (const f of landsOn(s)) set.add(f);
  return FORMATS.filter((f) => set.has(f));
});

// --- validation + save -----------------------------------------------------

const canSave = computed(() => {
  if (saving.value) return false;
  if (!props.model && !name.value.trim()) return false;
  return true;
});

function validate(): boolean {
  nameErr.value = "";
  rowErr.value = {};
  const n = name.value.trim();
  if (!n) {
    nameErr.value = t("models.editor.errNameRequired");
    return false;
  }
  if (n.includes("/")) {
    nameErr.value = t("models.editor.errNameSlash");
    return false;
  }
  if (!props.model && props.existingNames.includes(n)) {
    nameErr.value = t("models.editor.errNameExists", { name: n });
    return false;
  }
  let ok = true;
  // In unified mode a slot's thinking reaches the anthropic chain too, where the
  // value must be a budget in tokens — an effort word can't be shared. Per-format
  // mode checks the anthropic section's own rows. One error per section.
  const checkAnthropicBudget = (target: "unified" | "anthropic", slots: DraftSlot[]) => {
    for (const s of slots) {
      if (s.thinking.trim() && !/^\d+$/.test(s.thinking.trim())) {
        rowErr.value[target] = t("models.editor.errThinkingBudget");
        ok = false;
        return;
      }
    }
  };
  if (!perFmt.value) {
    const landsAnthropic = unified.value.filter((s) => landsOn(s).includes("anthropic"));
    checkAnthropicBudget("unified", landsAnthropic);
  } else {
    checkAnthropicBudget("anthropic", fmtSlots.value.anthropic);
  }
  return ok;
}

function bodySlots(slots: DraftSlot[]) {
  return slots.map((s) => {
    const out: Record<string, string> = { id: s.pid };
    if (s.model.trim()) out.model = s.model.trim();
    if (s.thinking.trim()) out.thinking = s.thinking.trim();
    return out;
  });
}

async function save() {
  if (!canSave.value || !validate()) return;
  saving.value = true;
  try {
    const body: Record<string, unknown> = {};
    if (perFmt.value) {
      for (const f of FORMATS)
        body[f] = { enabled: fmtEnabled.value[f], slots: bodySlots(fmtSlots.value[f]) };
    } else {
      for (const f of FORMATS) {
        const landed = unified.value.filter((s) => supports(s.pid, f));
        body[f] = { enabled: landed.length > 0, slots: bodySlots(landed) };
      }
    }
    body.paceRpm = Number(pace.value) || 0;
    const r = await req<{ model: ModelView }>("PUT", `/admin/models/${enc(name.value.trim())}`, body);
    toast(t("models.editor.savedToast", { name: r.model.name }), "success");
    open.value = false;
    emit("saved", r.model);
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    saving.value = false;
  }
}

const hasProviders = computed(() => props.providers.length > 0);
const FMT_META: Record<Fmt, { label: string; endpoint: string }> = {
  openai: { label: "models.fmtOpenai", endpoint: "/chat/completions" },
  anthropic: { label: "models.fmtAnthropic", endpoint: "/messages" },
  responses: { label: "models.fmtResponses", endpoint: "/responses" },
};
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-w-3xl">
      <datalist id="thinking-words">
        <option value="low"></option>
        <option value="medium"></option>
        <option value="high"></option>
        <option value="xhigh"></option>
      </datalist>
      <div class="flex shrink-0 items-center gap-2 pr-8">
        <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
          <ServerCog class="h-4 w-4" />
        </span>
        <div class="min-w-0">
          <DialogTitle class="text-base">{{ model ? t("models.editor.editTitle") : t("models.editor.createTitle") }}</DialogTitle>
          <DialogDescription>{{ t("models.editor.desc") }}</DialogDescription>
        </div>
      </div>

      <div class="min-h-0 flex-1 space-y-4 overflow-y-auto px-1 py-1.5">
        <!-- name -->
        <div class="space-y-1.5">
          <Label for="m-name">{{ t("models.editor.nameLabel") }}</Label>
          <Input
            id="m-name"
            v-model="name"
            :disabled="!!model"
            :placeholder="t('models.editor.namePh')"
            class="font-mono"
            spellcheck="false"
            autocomplete="off"
          />
          <p v-if="nameErr" class="text-xs text-destructive">{{ nameErr }}</p>
          <p v-else-if="model" class="text-xs text-muted-foreground">{{ t("models.editor.nameEditHint") }}</p>
          <p v-else class="text-xs text-muted-foreground">{{ t("models.editor.nameHint") }}</p>
        </div>

        <!-- no sources yet -->
        <div v-if="!hasProviders" class="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
          {{ t("models.editor.noProviders") }}
        </div>

        <template v-else>
          <!-- unified chain -->
          <div v-if="!perFmt" class="space-y-2">
            <div class="flex items-center justify-between">
              <Label>{{ t("models.editor.chainTitle") }}</Label>
              <span class="text-xs text-muted-foreground">{{ t("models.editor.chainPriority") }}</span>
            </div>
            <!-- fan-out summary: the one list above expands into one
                 independent chain per protocol — say so, with the actual set -->
            <div v-if="chainUnion.length" class="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              <span>{{ t("models.editor.fanoutLine", { n: chainUnion.length }) }}</span>
              <span
                v-for="f in chainUnion"
                :key="f"
                class="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium"
                :class="FMT_ACCENT[f].chip"
              >{{ t(FMT_META[f].label) }}</span>
            </div>
            <div class="space-y-1.5">
              <div v-for="(s, i) in unified" :key="i" class="space-y-1 rounded-md border bg-muted/30 p-2">
                <div class="flex items-center gap-1.5">
                  <span class="w-4 shrink-0 text-right text-xs text-muted-foreground">{{ i + 1 }}</span>
                  <Select v-model="s.pid" @update:model-value="onProviderChange(s)">
                    <SelectTrigger class="h-8 w-36 shrink-0" size="sm">
                      <SelectValue :placeholder="t('models.editor.providerPh')" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="p in providers" :key="p.id" :value="p.id">
                        <span class="flex items-center gap-1.5">
                          <span class="h-1.5 w-1.5 rounded-full" :class="providerColor(p.id).solid" />
                          {{ p.name }}
                        </span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <ArrowRight class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <div class="min-w-0 flex-1">
                    <Combobox
                      v-model="s.model"
                      :options="discoveredFor(s.pid)"
                      :placeholder="t('models.editor.upstreamPh')"
                    />
                  </div>
                  <div class="relative w-28 shrink-0">
                    <Brain class="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/70" />
                    <Input
                      v-model="s.thinking"
                      :placeholder="t('models.editor.thinkingPh')"
                      class="h-8 pl-7 font-mono text-xs"
                      spellcheck="false"
                      list="thinking-words"
                      :aria-label="t('models.editor.thinkingLabel')"
                    />
                  </div>
                  <div class="flex shrink-0 items-center">
                    <Button variant="ghost" size="icon" class="h-7 w-7" :disabled="i === 0" :aria-label="t('models.moveUpAria')" @click="moveSlot('unified', i, -1)">
                      <ArrowUp class="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" class="h-7 w-7" :disabled="i === unified.length - 1" :aria-label="t('models.moveDownAria')" @click="moveSlot('unified', i, 1)">
                      <ArrowDown class="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" class="h-7 w-7 text-muted-foreground hover:text-destructive" :aria-label="t('models.editor.removeSlot')" @click="removeSlot('unified', i)">
                      <Trash2 class="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                <!-- where this slot lands: only shown when it deviates from
                     "lands on every protocol" or carries an error -->
                <div v-if="slotNoteworthy(s)" class="flex items-center gap-2 pl-6">
                  <span class="text-[11px] text-muted-foreground">{{ t("models.editor.landsOn") }}</span>
                  <span
                    v-for="f in landsOn(s)"
                    :key="f"
                    class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium"
                    :class="FMT_ACCENT[f].chip"
                  >{{ t(FMT_META[f].label) }}</span>
                  <span v-if="!landsOn(s).length" class="text-[11px] text-destructive">{{ t("models.editor.landsNone") }}</span>
                  <span v-if="rowErr.unified" class="inline-flex items-center gap-1 text-[11px] text-destructive">
                    <TriangleAlert class="h-3 w-3" />{{ rowErr.unified }}
                  </span>
                </div>
              </div>
            </div>
            <Button variant="outline" size="sm" class="w-full border-dashed" @click="addSlot('unified')">
              <Plus class="h-4 w-4" />{{ t("models.editor.addSlot") }}
            </Button>
          </div>

          <!-- per-format chains -->
          <div v-else class="space-y-3">
            <div v-for="f in FORMATS" :key="f" class="space-y-1.5 rounded-md border bg-muted/30 p-2.5">
              <div class="flex items-center gap-2">
                <span class="h-2 w-2 rounded-full" :class="FMT_ACCENT[f].solid" />
                <span class="text-xs font-semibold">{{ t(FMT_META[f].label) }}</span>
                <span class="font-mono text-[11px] text-muted-foreground">{{ FMT_META[f].endpoint }}</span>
                <Switch v-model="fmtEnabled[f]" class="ml-auto" :aria-label="t('models.editor.enabledLabel')" />
              </div>
              <div v-if="!fmtSlots[f].length" class="px-1 py-1 text-xs text-muted-foreground">{{ t("models.editor.emptyChain") }}</div>
              <div v-for="(s, i) in fmtSlots[f]" :key="i" class="flex items-center gap-1.5 rounded bg-background/60 p-1.5">
                <span class="w-4 shrink-0 text-right text-xs text-muted-foreground">{{ i + 1 }}</span>
                <Select v-model="s.pid" @update:model-value="onProviderChange(s)">
                  <SelectTrigger class="h-8 w-36 shrink-0" size="sm">
                    <SelectValue :placeholder="t('models.editor.providerPh')" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="p in providers.filter((x) => supports(x.id, f))" :key="p.id" :value="p.id">
                      <span class="flex items-center gap-1.5">
                        <span class="h-1.5 w-1.5 rounded-full" :class="providerColor(p.id).solid" />
                        {{ p.name }}
                      </span>
                    </SelectItem>
                  </SelectContent>
                </Select>
                <ArrowRight class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div class="min-w-0 flex-1">
                  <Combobox v-model="s.model" :options="discoveredFor(s.pid)" :placeholder="t('models.editor.upstreamPh')" />
                </div>
                <div class="relative w-28 shrink-0">
                  <Brain class="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/70" />
                  <Input
                    v-model="s.thinking"
                    :placeholder="f === 'anthropic' ? t('models.editor.thinkingPhBudget') : t('models.editor.thinkingPh')"
                    class="h-8 pl-7 font-mono text-xs"
                    spellcheck="false"
                    :list="f === 'anthropic' ? undefined : 'thinking-words'"
                  />
                </div>
                <div class="flex shrink-0 items-center">
                  <Button variant="ghost" size="icon" class="h-7 w-7" :disabled="i === 0" :aria-label="t('models.moveUpAria')" @click="moveSlot(f, i, -1)">
                    <ArrowUp class="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" class="h-7 w-7" :disabled="i === fmtSlots[f].length - 1" :aria-label="t('models.moveDownAria')" @click="moveSlot(f, i, 1)">
                    <ArrowDown class="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" class="h-7 w-7 text-muted-foreground hover:text-destructive" :aria-label="t('models.editor.removeSlot')" @click="removeSlot(f, i)">
                    <Trash2 class="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <span v-if="rowErr.anthropic && f === 'anthropic'" class="inline-flex items-center gap-1 px-1 text-[11px] text-destructive">
                <TriangleAlert class="h-3 w-3" />{{ rowErr.anthropic }}
              </span>
              <Button variant="outline" size="sm" class="w-full border-dashed" :disabled="!providers.some((x) => supports(x.id, f))" @click="addSlot(f)">
                <Plus class="h-4 w-4" />{{ t("models.editor.addSlot") }}
              </Button>
            </div>
          </div>

          <!-- quiet controls: explanation left, chain-mode link right -->
          <div class="flex items-center justify-between gap-2">
            <button
              type="button"
              class="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              :aria-expanded="showHelp"
              @click="showHelp = !showHelp"
            >
              <Info class="h-3.5 w-3.5" />
              {{ t("models.editor.helpToggle") }}
            </button>
            <button
              type="button"
              class="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              @click="perFmt = !perFmt"
            >
              <SlidersHorizontal class="h-3.5 w-3.5" />
              {{ perFmt ? t("models.editor.perFmtOff") : t("models.editor.perFmtOn") }}
            </button>
          </div>
          <div v-if="showHelp" class="space-y-1 rounded-md border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
            <p>{{ t("models.editor.helpFanout") }}</p>
            <p>{{ t("models.editor.helpUpstream") }}</p>
            <p>{{ t("models.editor.helpThinking") }}</p>
            <p>{{ t("models.editor.helpPerFmt") }}</p>
          </div>

          <!-- advanced -->
          <div class="space-y-1.5">
            <button
              type="button"
              class="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              :aria-expanded="advancedOpen"
              @click="advancedOpen = !advancedOpen"
            >
              <SlidersHorizontal class="h-3.5 w-3.5" />
              {{ t("models.editor.advancedToggle") }}
              <ChevronDown class="h-3.5 w-3.5 transition-transform" :class="{ 'rotate-180': advancedOpen }" />
            </button>
            <div v-if="advancedOpen" class="space-y-1.5 rounded-md border bg-muted/30 p-3">
              <Label for="m-pace">{{ t("models.editor.paceLabel") }}</Label>
              <Input id="m-pace" v-model="pace" type="number" min="0" inputmode="numeric" :placeholder="t('models.editor.pacePh')" class="w-32" />
              <p class="text-xs text-muted-foreground">{{ t("models.editor.paceHint") }}</p>
            </div>
          </div>
        </template>
      </div>

      <div class="flex shrink-0 justify-end gap-2">
        <Button variant="outline" :disabled="saving" @click="open = false">{{ t("common.cancel") }}</Button>
        <Button :disabled="!canSave" @click="save">
          <Loader2 v-if="saving" class="h-4 w-4 animate-spin" />
          {{ t("models.editor.save") }}
        </Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
