<script setup lang="ts">
import { ref, computed } from "vue";
import { Input } from "@/components/ui/input";
import { Check } from "lucide-vue-next";

/** A searchable single-value picker for model lists that don't fit a plain
 *  <Select>: type to filter, click to pick. Free-text is kept — the value is
 *  whatever's in the field, so a name not in `options` (a custom / mapped
 *  upstream id) still works. The list is capped at `limit` rows with a
 *  "+N more, refine your search" hint, so a source carrying hundreds of models
 *  stays snappy. Built on the existing Input + a plain dropdown — no new deps. */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    options: string[];
    placeholder?: string;
    limit?: number;
  }>(),
  { limit: 300 },
);
const emit = defineEmits<{ "update:modelValue": [string] }>();

const rootRef = ref<HTMLDivElement | null>(null);
const open = ref(false);

const matched = computed(() => {
  const s = props.modelValue.trim().toLowerCase();
  return s ? props.options.filter((o) => o.toLowerCase().includes(s)) : props.options;
});
const filtered = computed(() => matched.value.slice(0, props.limit));
const cappedCount = computed(() => matched.value.length - filtered.value.length);

function onInput(v: string | number) {
  emit("update:modelValue", String(v));
  open.value = true;
}
function pick(o: string) {
  emit("update:modelValue", o);
  open.value = false;
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
      :model-value="modelValue"
      :placeholder="placeholder"
      autocomplete="off"
      spellcheck="false"
      @update:model-value="onInput"
    />
    <ul
      v-if="open && filtered.length"
      class="absolute z-50 mt-1 max-h-56 w-full overflow-auto rounded-md border bg-popover p-1 text-sm shadow-md"
    >
      <li v-for="o in filtered" :key="o">
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left font-mono hover:bg-accent hover:text-accent-foreground"
          :class="o === modelValue ? 'text-primary' : ''"
          @mousedown.prevent="pick(o)"
        >
          <Check v-if="o === modelValue" class="h-3.5 w-3.5 shrink-0" />
          <span v-else class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span class="flex-1 truncate">{{ o }}</span>
        </button>
      </li>
      <li v-if="cappedCount > 0" class="px-2 py-1 text-xs text-muted-foreground">
        +{{ cappedCount }} more — refine your search
      </li>
    </ul>
  </div>
</template>
