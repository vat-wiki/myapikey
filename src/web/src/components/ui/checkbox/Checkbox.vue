<script setup lang="ts">
import { CheckboxRoot, CheckboxIndicator } from "reka-ui";
import { Check } from "lucide-vue-next";
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{ class?: HTMLAttributes["class"]; id?: string }>();
const model = defineModel<boolean>();
</script>

<template>
  <CheckboxRoot
    v-model="model"
    :id="props.id"
    :class="cn(
      'peer h-4 w-4 shrink-0 cursor-pointer rounded-[4px] border border-primary shadow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
      props.class,
    )"
  >
    <CheckboxIndicator class="flex h-full w-full items-center justify-center text-current">
      <Check class="h-3.5 w-3.5" />
    </CheckboxIndicator>
  </CheckboxRoot>
</template>
