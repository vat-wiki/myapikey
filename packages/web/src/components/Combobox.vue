<script setup lang="ts">
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";
import { Input } from "@/components/ui/input";
import { Check, X } from "lucide-vue-next";

/** A searchable picker for model lists that don't fit a plain <Select>: type to
 *  filter, click to pick. The ONE control both Models dialogs use for a source's
 *  discovered models, so the interaction reads the same everywhere:
 *  - single (default): the field holds the value; free-text is kept, so a name
 *    not in `options` (a custom / mapped upstream id) still works.
 *  - multi: the field is a search box; picks accumulate as removable chips
 *    below it and the dropdown toggles membership.
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
const open = ref(false);
// multi-mode search query (single mode filters by the value itself)
const q = ref("");

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

function onFocusOut(e: FocusEvent) {
  // Focus moving to the dropdown (mousedown.prevent keeps it in the field, but
  // guard anyway) shouldn't close it; only a real blur to outside should.
  const rt = e.relatedTarget as Node | null;
  if (rt && rootRef.value?.contains(rt)) return;
  open.value = false;
}
</script>

<template>
  <div ref="rootRef" class="relative" @focusin="open = true" @focusout="onFocusOut">
    <Input
      :model-value="multi ? q : (modelValue as string)"
      :placeholder="placeholder"
      autocomplete="off"
      spellcheck="false"
      @update:model-value="onInput"
    />
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
    <ul
      v-if="open && (filtered.length || (multi && q.trim()))"
      class="absolute z-50 mt-1 max-h-56 w-full overflow-auto rounded-md border bg-popover p-1 text-sm shadow-md"
    >
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
      <li v-if="!filtered.length" class="px-2 py-1 text-xs text-muted-foreground">{{ t("combobox.noMatch") }}</li>
      <li v-else-if="cappedCount > 0" class="px-2 py-1 text-xs text-muted-foreground">
        {{ t("combobox.more", { n: cappedCount }) }}
      </li>
    </ul>
  </div>
</template>
