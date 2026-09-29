<script setup lang="ts">
import { TabsContent } from "reka-ui";
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";
const props = defineProps<{ value: string; class?: HTMLAttributes["class"] }>();
</script>
<template>
  <TabsContent
    :value="props.value"
    tabindex="-1"
    :class="cn('mt-4 ring-offset-background focus-visible:outline-none', props.class)"
  >
    <slot />
  </TabsContent>
</template>
