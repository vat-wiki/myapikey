<script setup lang="ts">
import { computed } from "vue";
import {
  SelectContent,
  SelectPortal,
  SelectViewport,
  useForwardPropsEmits,
  type SelectContentEmits,
  type SelectContentProps,
} from "reka-ui";
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = withDefaults(
  defineProps<SelectContentProps & { class?: HTMLAttributes["class"] }>(),
  { position: "popper" },
);
const emits = defineEmits<SelectContentEmits>();
const delegatedProps = computed(() => {
  const { class: _, ...delegated } = props;
  return delegated;
});
const forwarded = useForwardPropsEmits(delegatedProps, emits);
</script>

<template>
  <SelectPortal>
    <SelectContent
      v-bind="forwarded"
      :class="cn(
        'relative z-50 max-h-96 min-w-[8rem] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md',
        props.position === 'popper' &&
          'data-[side=bottom]:translate-y-1 data-[side=left]:translate-x-1 data-[side=right]:-translate-x-1 data-[side=top]:-translate-y-1',
        props.class,
      )"
    >
      <SelectViewport
        :class="cn(
          'p-1',
          props.position === 'popper' && 'w-full min-w-[var(--reka-select-trigger-width)]',
        )"
      >
        <slot />
      </SelectViewport>
    </SelectContent>
  </SelectPortal>
</template>
