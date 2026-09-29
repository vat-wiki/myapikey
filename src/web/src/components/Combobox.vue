<script setup lang="ts">
import { ref, computed, watch, nextTick, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { Input } from "@/components/ui/input";
import { Check, ChevronDown, Plus, X } from "lucide-vue-next";

/** A searchable picker for model lists that don't fit a plain <Select>: type to
 *  filter, click to pick. The ONE control both Models dialogs use for a source's
 *  discovered models, so the interaction reads the same everywhere:
 *  - single (default): the field holds the value; free-text is kept, so a name
 *    not in `options` (a custom / mapped upstream id) still works.
 *  - multi: the field is a tags-input - pick from the dropdown or type any
 *    name and press Enter (the "add" row commits it too); picks and typed
 *    names accumulate as removable chips. Typed values need not be in
 *    `options` (custom / undiscovered names are legal).
 *  The list is capped at `limit` rows with a "+N more, refine your search"
 *  hint, so a source carrying hundreds of models stays snappy. Built on the
 *  existing Input + a plain dropdown — no new deps. */
const props = withDefaults(
  defineProps<{
    modelValue: string | string[];
    options: string[];
    placeholder?: string;
    limit?: number;
    multi?: boolean;
  }>(),
  { limit: 300 },
);
const emit = defineEmits<{ "update:modelValue": [string | string[]] }>();
const { t } = useI18n();

const rootRef = ref<HTMLDivElement | null>(null);
const inputRef = ref<InstanceType<typeof Input> | null>(null);
const open = ref(false);
// multi-mode search query (single mode filters by the value itself)
const q = ref("");

/** Chevron toggle: the field is BOTH a free-text input and a dropdown - the
 *  chevron makes the dropdown half discoverable (same affordance as Select).
 *  mousedown.prevent keeps focus in the field so a close-toggle isn't undone
 *  by the root focusin handler. */
function toggle() {
  open.value = !open.value;
  if (open.value) inputRef.value?.$el?.focus();
}

/** Esc closes just the dropdown - .stop keeps it from the dialog's own Esc
 *  handler, which would close the whole dialog. */
function onEsc(e: KeyboardEvent) {
  if (!open.value) return;
  e.stopPropagation();
  e.preventDefault();
  open.value = false;
}

/** multi: the selected names, as a plain array. */
const selected = computed(() => (Array.isArray(props.modelValue) ? props.modelValue : []));

const matched = computed(() => {
  const s = (props.multi ? q.value : String(props.modelValue ?? "")).trim().toLowerCase();
  return s ? props.options.filter((o) => o.toLowerCase().includes(s)) : props.options;
});
const filtered = computed(() => matched.value.slice(0, props.limit));
const cappedCount = computed(() => matched.value.length - filtered.value.length);

function onInput(v: string | number) {
  if (props.multi) {
    q.value = String(v);
    open.value = true;
  } else {
    emit("update:modelValue", String(v));
    open.value = true;
  }
}

function pick(o: string) {
  if (props.multi) {
    const next = selected.value.includes(o) ? selected.value.filter((x) => x !== o) : [...selected.value, o];
    emit("update:modelValue", next); // new array so parents' computeds re-evaluate
  } else {
    emit("update:modelValue", o);
    open.value = false;
  }
}

function removeChip(o: string) {
  emit("update:modelValue", selected.value.filter((x) => x !== o));
}

/** multi: commit a raw string as chips - typed input isn't limited to
 *  `options` (custom / undiscovered names are legal values). Tokens split on
 *  whitespace/commas/semicolons so a pasted list adds in one go, matching the
 *  separators the old bulk textarea accepted. */
function commitTokens(s: string) {
  const tokens = s.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
  if (!tokens.length) return;
  const next = [...selected.value];
  for (const tok of tokens) if (!next.includes(tok)) next.push(tok);
  emit("update:modelValue", next);
  q.value = "";
}

/** Enter commits what's typed - predictable tags-input rule: you get exactly
 *  the name you typed, not the first dropdown match. */
function onEnter() {
  if (props.multi) commitTokens(q.value);
}

/** Pasting a multi-token list into a single-line input would lose the
 *  separators (the browser strips newlines), so intercept it and add the
 *  tokens directly. A single clean token pastes normally. */
function onPaste(e: ClipboardEvent) {
  if (!props.multi) return;
  const text = e.clipboardData?.getData("text") ?? "";
  if (!text.trim() || !/[\s,;]/.test(text)) return;
  e.preventDefault();
  commitTokens(text);
}

function onFocusOut(e: FocusEvent) {
  // Focus moving to the dropdown (mousedown.prevent keeps it in the field, but
  // guard anyway) shouldn't close it; only a real blur to outside should.
  const rt = e.relatedTarget as Node | null;
  if (rt && rootRef.value?.contains(rt)) return;
  open.value = false;
}

/** Dropdown geometry, teleported to <body> as position:fixed. Rendering it
 *  inside the field (absolute) clips it against the dialog's overflow-hidden /
 *  overflow-y-auto ancestors and inflates the dialog's scrollable height —
 *  the same reason the ui-kit Select portals its content. */
const menu = ref<{ top: number; left: number; width: number } | null>(null);

/** Estimated open height of the dropdown (max-h-56 = 224px), used to decide
 *  whether it fits below the field or must flip up. */
const menuH = computed(() => Math.min(Math.max(filtered.value.length * 34 + 8, 48), 224));

function syncMenu() {
  const r = rootRef.value?.getBoundingClientRect();
  if (!r) return;
  const below = r.bottom + 6 + menuH.value <= window.innerHeight;
  menu.value = {
    top: below ? r.bottom + 6 : Math.max(r.top - 6 - menuH.value, 8),
    left: Math.max(Math.min(r.left, window.innerWidth - r.width - 8), 8),
    width: r.width,
  };
}

function onReposition() {
  if (open.value) syncMenu();
}

watch(open, async (o) => {
  if (o) {
    await nextTick();
    syncMenu();
    window.addEventListener("scroll", onReposition, true); // capture: also catches dialog-inner scrolls
    window.addEventListener("resize", onReposition);
  } else {
    window.removeEventListener("scroll", onReposition, true);
    window.removeEventListener("resize", onReposition);
  }
});
// Refiltering changes the estimated height — re-evaluate the flip decision.
watch(menuH, () => open.value && syncMenu());
onBeforeUnmount(() => {
  window.removeEventListener("scroll", onReposition, true);
  window.removeEventListener("resize", onReposition);
});
</script>

<template>
  <div ref="rootRef" @focusin="open = true" @focusout="onFocusOut">
    <div class="relative">
      <Input
        ref="inputRef"
        :model-value="multi ? q : (modelValue as string)"
        :placeholder="placeholder"
        autocomplete="off"
        spellcheck="false"
        class="pr-8"
        @update:model-value="onInput"
        @keydown.esc="onEsc"
        @keydown.enter.prevent="onEnter"
        @paste="onPaste"
      />
      <button
        type="button"
        tabindex="-1"
        class="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm text-muted-foreground/70 transition-colors hover:text-foreground"
        :aria-label="t('combobox.toggle')"
        @mousedown.prevent="toggle"
      >
        <ChevronDown class="h-4 w-4 transition-transform" :class="open ? 'rotate-180' : ''" />
      </button>
    </div>
    <!-- multi: the current selection as removable chips -->
    <div v-if="multi && selected.length" class="mt-1.5 flex flex-wrap gap-1">
      <span
        v-for="s in selected"
        :key="s"
        class="inline-flex items-center gap-1 rounded-md border-transparent bg-primary text-primary-foreground shadow-sm px-2 py-0.5 font-mono text-xs"
      >
        {{ s }}
        <button type="button" class="opacity-70 hover:opacity-100" :aria-label="t('common.dismiss')" @click="removeChip(s)">
          <X class="h-3 w-3" />
        </button>
      </span>
    </div>
    <Teleport to="body">
      <!-- pointer-events-auto + @pointerdown.stop are load-bearing: a modal
           Dialog sets `body { pointer-events: none }` and only restores it for
           its own layer tree, so a plain body-teleported dropdown would be
           unclickable (and hover-dead), and its pointerdown would bubble to
           the dialog's outside-dismiss handler and close the whole dialog.
           reka's own portals get this via DismissableLayer, which isn't
           publicly exported - so replicate the two effects by hand. -->
      <ul
        v-if="open && (filtered.length || (multi && q.trim()))"
        class="pointer-events-auto fixed z-[60] max-h-56 overflow-auto rounded-md border bg-popover p-1 text-sm shadow-md"
        :style="menu ? { top: `${menu.top}px`, left: `${menu.left}px`, width: `${menu.width}px` } : undefined"
        @pointerdown.stop
      >
        <!-- multi with typed text: the escape hatch the whole merge rests on -
             committing the raw typed name as a chip, clickable as well as
             Enter-able. Shown above the matches, including when nothing
             matches (that's its point). -->
        <li v-if="multi && q.trim()">
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground"
            @mousedown.prevent="commitTokens(q)"
          >
            <Plus class="h-3.5 w-3.5 shrink-0" />
            <span class="flex-1 truncate font-mono">{{ t("combobox.add", { q: q.trim() }) }}</span>
          </button>
        </li>
        <li v-for="o in filtered" :key="o">
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left font-mono hover:bg-accent hover:text-accent-foreground"
            :class="o === modelValue || selected.includes(o) ? 'text-primary' : ''"
            @mousedown.prevent="pick(o)"
          >
            <Check v-if="o === modelValue || selected.includes(o)" class="h-3.5 w-3.5 shrink-0" />
            <span v-else class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span class="flex-1 truncate">{{ o }}</span>
          </button>
        </li>
        <li v-if="!filtered.length && !(multi && q.trim())" class="px-2 py-1 text-xs text-muted-foreground">{{ t("combobox.noMatch") }}</li>
        <li v-else-if="cappedCount > 0" class="px-2 py-1 text-xs text-muted-foreground">
          {{ t("combobox.more", { n: cappedCount }) }}
        </li>
      </ul>
    </Teleport>
  </div>
</template>
