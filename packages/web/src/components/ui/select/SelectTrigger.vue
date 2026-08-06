<script setup lang="ts">
import { computed } from "vue";
import { SelectIcon, SelectTrigger, type SelectTriggerProps } from "reka-ui";
import { ChevronDown } from "lucide-vue-next";
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<SelectTriggerProps & { class?: HTMLAttributes["class"] }>();
const delegatedProps = computed(() => {
  const { class: _, ...delegated } = props;
  return delegated;
});
</script>

<template>
  <SelectTrigger
    v-bind="delegatedProps"
    :class="cn(
      'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1',
      props.class,
    )"
  >
    <slot />
    <SelectIcon as-child>
      <ChevronDown class="h-4 w-4 opacity-50" />
    </SelectIcon>
  </SelectTrigger>
</template>
