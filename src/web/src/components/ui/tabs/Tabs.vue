<script setup lang="ts">
import { TabsRoot } from "reka-ui";
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{
  class?: HTMLAttributes["class"];
  defaultValue?: string;
  modelValue?: string;
}>();
const emits = defineEmits<{ "update:modelValue": [string] }>();
</script>

<template>
  <TabsRoot
    :default-value="props.defaultValue"
    :model-value="props.modelValue"
    @update:model-value="(v: string) => emits('update:modelValue', v)"
    :class="cn(props.class)"
  >
    <slot />
  </TabsRoot>
</template>
