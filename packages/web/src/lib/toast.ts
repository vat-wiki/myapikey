import { ref } from "vue";

export type ToastVariant = "default" | "success" | "error";

export interface Toast {
  id: number;
  message: string;
  variant: ToastVariant;
}

// Module-level singleton — one toast queue for the whole app.
const toasts = ref<Toast[]>([]);
let nextId = 1;

export function useToasts() {
  return toasts;
}

export function dismissToast(id: number) {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}

/** Show a transient toast. Auto-dismisses after `timeout` ms. */
export function toast(message: string, variant: ToastVariant = "default", timeout = 3500) {
  const id = nextId++;
  toasts.value = [...toasts.value, { id, message, variant }];
  if (timeout > 0) window.setTimeout(() => dismissToast(id), timeout);
}
