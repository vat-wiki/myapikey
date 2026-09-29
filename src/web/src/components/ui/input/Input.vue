<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{
  modelValue?: string | number;
  class?: HTMLAttributes["class"];
  type?: string;
  placeholder?: string;
  autocomplete?: string;
  disabled?: boolean;
}>();

const emits = defineEmits<{ "update:modelValue": [string | number] }>();
</script>

<template>
  <input
    :type="props.type ?? 'text'"
    :value="props.modelValue"
    :placeholder="props.placeholder"
    :autocomplete="props.autocomplete"
    :disabled="props.disabled"
    @input="emits('update:modelValue', ($event.target as HTMLInputElement).value)"
    :class="cn(
      'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50',
      props.class,
    )"
  />
</template>
