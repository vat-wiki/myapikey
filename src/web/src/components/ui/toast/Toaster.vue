<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { useToasts, dismissToast } from "@/lib/toast";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-vue-next";

const { t } = useI18n();
const toasts = useToasts();

const iconFor = {
  success: CheckCircle2,
  error: AlertCircle,
  default: Info,
};
</script>

<template>
  <Teleport to="body">
    <div
      class="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-end"
    >
      <TransitionGroup
        enter-active-class="transition duration-200 ease-out"
        enter-from-class="translate-y-2 opacity-0 sm:translate-y-0 sm:translate-x-2"
        leave-active-class="transition duration-150 ease-in absolute"
        leave-to-class="opacity-0 translate-y-2 sm:translate-y-0 sm:translate-x-2"
      >
        <div
          v-for="item in toasts"
          :key="item.id"
          :class="[
            'pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-lg border p-3 shadow-lg backdrop-blur',
            item.variant === 'error'
              ? 'border-destructive/40 bg-destructive/10 text-destructive'
              : item.variant === 'success'
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : 'border-border bg-popover/95 text-popover-foreground',
          ]"
          role="status"
          aria-live="polite"
        >
          <component :is="iconFor[item.variant]" class="mt-0.5 h-4 w-4 shrink-0" />
          <p class="flex-1 text-sm">{{ item.message }}</p>
          <button
            class="shrink-0 rounded-sm opacity-60 transition-opacity hover:opacity-100"
            :aria-label="t('common.dismiss')"
            @click="dismissToast(item.id)"
          >
            <X class="h-4 w-4" />
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>
