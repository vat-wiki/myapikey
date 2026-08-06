<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";
import { type ButtonVariants, buttonVariants } from ".";

const props = defineProps<{
  variant?: ButtonVariants["variant"];
  size?: ButtonVariants["size"];
  class?: HTMLAttributes["class"];
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
}>();
</script>

<template>
  <button
    :type="props.type ?? 'button'"
    :disabled="props.disabled"
    :class="cn(buttonVariants({ variant: props.variant, size: props.size }), props.class)"
  >
    <slot />
  </button>
</template>
