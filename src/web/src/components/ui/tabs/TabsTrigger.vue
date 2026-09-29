<script setup lang="ts">
import { TabsTrigger } from "reka-ui";
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";
const props = defineProps<{ value: string; class?: HTMLAttributes["class"] }>();
</script>
<template>
  <TabsTrigger
    :value="props.value"
    :class="cn(
      'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow',
      props.class,
    )"
  >
    <slot />
  </TabsTrigger>
</template>
