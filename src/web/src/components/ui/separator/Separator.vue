<script setup lang="ts">
import { Separator } from "reka-ui";
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";
const props = defineProps<{ class?: HTMLAttributes["class"]; orientation?: "horizontal" | "vertical" }>();
</script>
<template>
  <Separator
    :orientation="props.orientation ?? 'horizontal'"
    :class="cn('shrink-0 bg-border', props.orientation === 'vertical' ? 'h-full w-px' : 'h-px w-full', props.class)"
  />
</template>
