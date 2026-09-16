<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { req, type ModelView, type ProviderPublic } from "@/api";
import type { Fmt } from "@/lib/format";
import { FMT_ACCENT, FMT_META, providerColor } from "@/lib/format";
import { providerModelList } from "@/lib/models";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import Combobox from "@/components/Combobox.vue";
import { Plus, Loader2, ServerCog, Brain, TriangleAlert, Info, ChevronDown, SlidersHorizontal, GripVertical, MoreHorizontal, Check, Trash2 } from "lucide-vue-next";

/** The three routing families, each with its own independently configured chain. */
const FORMATS: Fmt[] = ["openai", "anthropic", "responses"];

/** The sampling fields offered in the row menu — the wire-agnostic names, the
 *  same set the server whitelists. A filled field overrides the request's own
 *  value of that name; blank passes it through. */
const SAMPLING_FIELDS: { key: string; ph: string }[] = [
  { key: "temperature", ph: "temp" },
  { key: "top_p", ph: "top_p" },
  { key: "top_k", ph: "top_k" },
  { key: "presence_penalty", ph: "pres" },
  { key: "frequency_penalty", ph: "freq" },
  { key: "seed", ph: "seed" },
];
function blankSampling(): Record<string, string> {
  return Object.fromEntries(SAMPLING_FIELDS.map((f) => [f.key, ""]));
}
const samplingFilled = (s: DraftSlot): boolean => SAMPLING_FIELDS.some((f) => s.sampling[f.key].trim() !== "");
function clearSampling(slot: DraftSlot) {
  for (const f of SAMPLING_FIELDS) slot.sampling[f.key] = "";
}

/** One editable chain slot in the draft. Blank model = identity (send the
 *  public name upstream); thinking is the slot's default level (effort token
 *  on openai/responses, budget tokens on anthropic); sampling holds the slot's
 *  default sampling params as editable strings (blank = pass that field
 *  through) — both set from the row's "more actions" menu. uid keeps v-for
 *  keys stable across reorders. */
interface DraftSlot {
  uid: number;
  pid: string;
  model: string;
  thinking: string;
  sampling: Record<string, string>;
}
let uidSeq = 0;
function makeSlot(s: { id: string; model?: string; thinking?: string; sampling?: Record<string, unknown> }): DraftSlot {
  const sampling = blankSampling();
  for (const f of SAMPLING_FIELDS) {
    const v = s.sampling?.[f.key];
    if (v !== undefined && v !== null) sampling[f.key] = String(v);
  }
  return { uid: ++uidSeq, pid: s.id, model: s.model ?? "", thinking: s.thinking ?? "", sampling };
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

function init() {
  nameErr.value = "";
  rowErr.value = {};
  pace.value = "";
  showHelp.value = false;
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
    fmtSlots.value[f] = m[f].providers.map(makeSlot);
    fmtEnabled.value[f] = m[f].enabled;
  }
}

watch(open, (o) => {
  if (o) init();
});

// --- slot row operations ---------------------------------------------------

function addSlot(f: Fmt) {
  fmtSlots.value[f].push(makeSlot({ id: props.providers[0]?.id ?? "" }));
}
function removeSlot(f: Fmt, uid: number) {
  const i = fmtSlots.value[f].findIndex((s) => s.uid === uid);
  if (i === -1) return;
  fmtSlots.value[f].splice(i, 1);
  delete rowErr.value[f];
}
/** Changing the provider resets the upstream fields — the old upstream name,
 *  thinking and sampling belong to the previous backend. */
function onProviderChange(slot: DraftSlot) {
  slot.model = "";
  slot.thinking = "";
  slot.sampling = blankSampling();
}
/** Typing in a menu input must not trigger the menu's keyboard nav
 *  (arrows/space would jump between items) — but Escape must still reach the
 *  menu so it can close. */
function onMenuKeydown(e: KeyboardEvent) {
  if (e.key !== "Escape") e.stopPropagation();
}

/** Quick thinking presets offered in the row menu: effort words on the
 *  openai-family routes, token budgets on anthropic. A custom value can always
 *  be typed into the menu's input. */
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh"];
const BUDGET_PRESETS = ["1024", "4096", "8192", "16384"];
function thinkingPresets(f: Fmt): string[] {
  return f === "anthropic" ? BUDGET_PRESETS : EFFORT_LEVELS;
}

// --- drag & drop reorder (HTML5 DnD, armed by the row's handle) ------------

const dragArm = ref<string | null>(null); // `${fmt}:${i}` armed by handle mousedown
const drag = ref<{ fmt: Fmt; from: number; to: number } | null>(null);

const armed = (f: Fmt, i: number) => dragArm.value === `${f}:${i}`;
const isDragRow = (f: Fmt, i: number) => drag.value?.fmt === f && drag.value.from === i;
function rowCls(f: Fmt, i: number): string {
  return isDragRow(f, i) ? "bg-background/60 opacity-40" : "bg-background/60";
}

/** Rows interleaved with the drop placeholder: the placeholder sits before row
 *  `to` (or after the last row when to = length). One element per key keeps
 *  TransitionGroup's FLIP move animation working. */
interface RenderItem {
  key: string | number;
  ph: boolean;
  slot: DraftSlot;
  i: number;
}
function renderList(f: Fmt): RenderItem[] {
  const arr = fmtSlots.value[f];
  const to = drag.value && drag.value.fmt === f ? drag.value.to : null;
  const out: RenderItem[] = [];
  const ph = (i: number): RenderItem => ({ key: "ph", ph: true, slot: arr[0], i });
  const row = (slot: DraftSlot, i: number): RenderItem => ({ key: slot.uid, ph: false, slot, i });
  for (let i = 0; i < arr.length; i++) {
    if (to === i) out.push(ph(i));
    out.push(row(arr[i], i));
  }
  if (to !== null && to >= arr.length) out.push(ph(arr.length));
  return out;
}

function armDrag(key: string) {
  dragArm.value = key;
}
function disarmDrag() {
  dragArm.value = null;
}
function onDragStart(f: Fmt, i: number, e: DragEvent) {
  if (dragArm.value !== `${f}:${i}`) {
    e.preventDefault(); // drags may only start from the handle
    return;
  }
  drag.value = { fmt: f, from: i, to: i };
  e.dataTransfer?.setData("text/plain", ""); // Firefox won't start a drag without data
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
}
function onDragOver(f: Fmt, i: number, e: DragEvent) {
  if (!drag.value || drag.value.fmt !== f) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  drag.value.to = e.clientY > r.top + r.height / 2 ? i + 1 : i;
}
/** The container's own empty space (below the last row) accepts drops too. */
function onDragOverList(f: Fmt, e: DragEvent) {
  if (!drag.value || drag.value.fmt !== f) return;
  if (e.target !== e.currentTarget) return;
  e.preventDefault();
  drag.value.to = fmtSlots.value[f].length;
}
function onDrop(f: Fmt) {
  const d = drag.value;
  drag.value = null;
  disarmDrag();
  if (!d || d.fmt !== f) return;
  if (d.to === d.from || d.to === d.from + 1) return; // landed where it started
  const arr = fmtSlots.value[f];
  const [slot] = arr.splice(d.from, 1);
  arr.splice(d.to > d.from ? d.to - 1 : d.to, 0, slot);
}
function onDragEnd() {
  drag.value = null;
  disarmDrag();
}

// --- validation + save -----------------------------------------------------

const canSave = computed(() => !saving.value && (!!props.model || !!name.value.trim()));

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
  // An anthropic slot's thinking IS a budget in tokens — an effort word can't
  // be sent there. One error per section.
  for (const s of fmtSlots.value.anthropic) {
    if (s.thinking.trim() && !/^\d+$/.test(s.thinking.trim())) {
      rowErr.value.anthropic = t("models.editor.errThinkingBudget");
      return false;
    }
  }
  // Sampling defaults must be numbers (seed an integer) — the same whitelist on
  // every route. One error per section, first offender wins.
  for (const f of FORMATS) {
    for (const s of fmtSlots.value[f]) {
      for (const { key } of SAMPLING_FIELDS) {
        const raw = s.sampling[key]?.trim();
        if (!raw) continue;
        const n = Number(raw);
        if (!Number.isFinite(n) || (key === "seed" && !Number.isInteger(n))) {
          rowErr.value[f] = t("models.editor.errSampling");
          return false;
        }
      }
    }
  }
  return true;
}

/** The sampling record the save body carries: filled fields as numbers,
 *  blanks dropped; undefined when nothing is set (the key is omitted). */
function samplingBody(m: Record<string, string>): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  for (const f of SAMPLING_FIELDS) {
    const raw = m[f.key]?.trim();
    if (raw) out[f.key] = Number(raw);
  }
  return Object.keys(out).length ? out : undefined;
}

function bodySlots(slots: DraftSlot[]) {
  return slots.map((s) => {
    const out: Record<string, unknown> = { id: s.pid };
    if (s.model.trim()) out.model = s.model.trim();
    if (s.thinking.trim()) out.thinking = s.thinking.trim();
    const sampling = samplingBody(s.sampling);
    if (sampling) out.sampling = sampling;
    return out;
  });
}

async function save() {
  if (!canSave.value || !validate()) return;
  saving.value = true;
  try {
    const body: Record<string, unknown> = {};
    for (const f of FORMATS) body[f] = { enabled: fmtEnabled.value[f], slots: bodySlots(fmtSlots.value[f]) };
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
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-w-lg">
      <datalist id="thinking-words">
        <option value="low"></option>
        <option value="medium"></option>
        <option value="high"></option>
        <option value="xhigh"></option>
      </datalist>
      <datalist id="thinking-budgets">
        <option value="1024"></option>
        <option value="4096"></option>
        <option value="8192"></option>
        <option value="16384"></option>
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

      <div class="min-h-0 flex-1 space-y-3 overflow-y-auto px-1 py-1.5">
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
          <!-- one independent chain per protocol -->
          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <Label>{{ t("models.editor.chainTitle") }}</Label>
              <span class="text-xs text-muted-foreground">{{ t("models.editor.chainPriority") }}</span>
            </div>
            <div v-for="f in FORMATS" :key="f" class="space-y-1 rounded-md border bg-muted/30 p-2">
              <div class="flex items-center gap-1.5">
                <span class="h-2 w-2 rounded-full" :class="FMT_ACCENT[f].solid" />
                <span class="text-xs font-semibold">{{ t(FMT_META[f].label) }}</span>
                <span class="font-mono text-[11px] text-muted-foreground">{{ FMT_META[f].endpoint }}</span>
                <Switch v-model="fmtEnabled[f]" class="ml-auto" :aria-label="t('models.editor.enabledLabel')" />
              </div>
              <div v-if="!fmtSlots[f].length" class="px-1 py-0.5 text-xs text-muted-foreground">{{ t("models.editor.emptyChain") }}</div>
              <TransitionGroup
                v-else
                tag="div"
                name="slots"
                class="space-y-1"
                @dragover="onDragOverList(f, $event)"
                @drop.prevent="onDrop(f)"
              >
                <div
                  v-for="item in renderList(f)"
                  :key="item.key"
                  class="flex items-center gap-1 rounded px-1 py-0.5"
                  :class="item.ph ? 'ph h-8 shrink-0 border border-dashed border-primary/50 bg-primary/10' : rowCls(f, item.i)"
                  :draggable="!item.ph && armed(f, item.i)"
                  @dragstart="onDragStart(f, item.i, $event)"
                  @dragover="onDragOver(f, item.i, $event)"
                  @drop.prevent="onDrop(f)"
                  @dragend="onDragEnd"
                  @mouseup="disarmDrag"
                >
                  <template v-if="!item.ph">
                    <button
                      type="button"
                      class="shrink-0 cursor-grab rounded p-0.5 text-muted-foreground/60 hover:text-foreground active:cursor-grabbing"
                      :aria-label="t('models.editor.dragAria')"
                      :title="t('models.editor.dragAria')"
                      @mousedown="armDrag(`${f}:${item.i}`)"
                    >
                      <GripVertical class="h-3.5 w-3.5" />
                    </button>
                    <span class="w-3.5 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{{ item.i + 1 }}</span>
                    <Select v-model="item.slot.pid" @update:model-value="onProviderChange(item.slot)">
                      <SelectTrigger class="h-7 w-28 shrink-0 px-2 text-xs">
                        <SelectValue :placeholder="t('models.editor.providerPh')" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem v-for="p in providers.filter((x) => supports(x.id, f))" :key="p.id" :value="p.id" class="text-xs">
                          <span class="flex items-center gap-1.5">
                            <span class="h-1.5 w-1.5 rounded-full" :class="providerColor(p.id).solid" />
                            {{ p.name }}
                          </span>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <div class="w-44 shrink-0 [&_input]:h-7 [&_input]:text-xs">
                      <Combobox v-model="item.slot.model" :options="discoveredFor(item.slot.pid)" :placeholder="t('models.editor.upstreamPh')" />
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger as-child>
                        <Button
                          variant="ghost"
                          size="icon"
                          class="ml-auto h-7 w-7 shrink-0"
                          :class="item.slot.thinking.trim() || samplingFilled(item.slot) ? 'text-primary' : 'text-muted-foreground/70 hover:text-foreground'"
                          :aria-label="t('models.editor.moreActions')"
                          :title="t('models.editor.moreActions')"
                        >
                          <Brain v-if="item.slot.thinking.trim()" class="h-3.5 w-3.5" />
                          <SlidersHorizontal v-else-if="samplingFilled(item.slot)" class="h-3.5 w-3.5" />
                          <MoreHorizontal v-else class="h-3.5 w-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" class="w-56">
                        <div class="px-2 py-1 text-[11px] font-medium text-muted-foreground">{{ t("models.editor.thinkingLabel") }}</div>
                        <DropdownMenuItem @select="item.slot.thinking = ''">
                          <Check v-if="!item.slot.thinking.trim()" />
                          <span v-else class="size-4 shrink-0" aria-hidden="true" />
                          {{ t("models.editor.thinkingClear") }}
                        </DropdownMenuItem>
                        <DropdownMenuItem v-for="v in thinkingPresets(f)" :key="v" @select="item.slot.thinking = v">
                          <Check v-if="item.slot.thinking.trim() === v" />
                          <span v-else class="size-4 shrink-0" aria-hidden="true" />
                          <span class="font-mono text-xs">{{ v }}</span>
                        </DropdownMenuItem>
                        <div class="px-2 pb-1.5 pt-0.5" @click.stop @keydown="onMenuKeydown">
                          <Input
                            v-model="item.slot.thinking"
                            class="h-7 font-mono text-xs"
                            spellcheck="false"
                            :placeholder="f === 'anthropic' ? t('models.editor.thinkingPhBudget') : t('models.editor.thinkingPh')"
                            :list="f === 'anthropic' ? 'thinking-budgets' : 'thinking-words'"
                            :aria-label="t('models.editor.thinkingLabel')"
                          />
                        </div>
                        <DropdownMenuSeparator />
                        <div class="px-2 py-1 text-[11px] font-medium text-muted-foreground">{{ t("models.editor.samplingLabel") }}</div>
                        <DropdownMenuItem @select="clearSampling(item.slot)">
                          <Check v-if="!samplingFilled(item.slot)" />
                          <span v-else class="size-4 shrink-0" aria-hidden="true" />
                          {{ t("models.editor.samplingClear") }}
                        </DropdownMenuItem>
                        <div class="grid grid-cols-3 gap-1 px-2 pb-1.5 pt-0.5" @click.stop @keydown="onMenuKeydown">
                          <Input
                            v-for="sf in SAMPLING_FIELDS"
                            :key="sf.key"
                            v-model="item.slot.sampling[sf.key]"
                            type="number"
                            step="any"
                            class="h-7 px-1.5 font-mono text-xs"
                            :placeholder="sf.ph"
                            :aria-label="`${t('models.editor.samplingLabel')} · ${sf.key}`"
                            :title="sf.key"
                          />
                        </div>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem class="text-destructive focus:bg-destructive/10 focus:text-destructive" @select="removeSlot(f, item.slot.uid)">
                          <Trash2 />
                          {{ t("models.editor.removeSlot") }}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </template>
                </div>
              </TransitionGroup>
              <span v-if="rowErr[f]" class="inline-flex items-center gap-1 px-1 text-[11px] text-destructive">
                <TriangleAlert class="h-3 w-3" />{{ rowErr[f] }}
              </span>
              <Button
                variant="outline"
                size="sm"
                class="h-7 w-full border-dashed text-xs"
                :disabled="!providers.some((x) => supports(x.id, f))"
                @click="addSlot(f)"
              >
                <Plus class="h-3.5 w-3.5" />{{ t("models.editor.addSlot") }}
              </Button>
            </div>
          </div>

          <!-- quiet controls: explanation toggle -->
          <div class="flex items-center">
            <button
              type="button"
              class="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              :aria-expanded="showHelp"
              @click="showHelp = !showHelp"
            >
              <Info class="h-3.5 w-3.5" />
              {{ t("models.editor.helpToggle") }}
            </button>
          </div>
          <div v-if="showHelp" class="space-y-1 rounded-md border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
            <p>{{ t("models.editor.helpUpstream") }}</p>
            <p>{{ t("models.editor.helpThinking") }}</p>
            <p>{{ t("models.editor.helpSampling") }}</p>
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

<style scoped>
/* drag placeholder: expands + fades in, and re-plays each time it hops to a
   new position (re-inserting a node restarts CSS animations) */
.ph {
  animation: ph-in 160ms ease-out;
}
@keyframes ph-in {
  from {
    opacity: 0;
    transform: scaleY(0.4);
  }
  to {
    opacity: 1;
    transform: scaleY(1);
  }
}
/* FLIP: while dragging, rows (and the placeholder) slide to their new spots */
.slots-move {
  transition: transform 160ms ease;
}
</style>
