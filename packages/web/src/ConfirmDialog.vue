<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, AlertTriangle } from "lucide-vue-next";

const { t } = useI18n();

const open = defineModel<boolean>("open", { default: false });

withDefaults(
  defineProps<{
    title: string;
    description?: string;
    confirmText?: string;
    cancelText?: string;
    variant?: "default" | "destructive";
    loading?: boolean;
  }>(),
  { variant: "default", loading: false, confirmText: "", cancelText: "" },
);

const emit = defineEmits<{ confirm: [] }>();
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-w-sm">
      <div class="flex gap-3 pr-8">
        <span
          v-if="variant === 'destructive'"
          class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-destructive"
        >
          <AlertTriangle class="h-4 w-4" />
        </span>
        <div class="min-w-0 flex-1 space-y-1.5">
          <DialogTitle class="text-base leading-tight">{{ title }}</DialogTitle>
          <DialogDescription v-if="description">{{ description }}</DialogDescription>
        </div>
      </div>
      <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" :disabled="loading" @click="open = false">
          {{ cancelText || t("common.cancel") }}
        </Button>
        <Button :variant="variant" :disabled="loading" @click="emit('confirm')">
          <Loader2 v-if="loading" class="h-4 w-4 animate-spin" />
          {{ confirmText || t("common.confirm") }}
        </Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
