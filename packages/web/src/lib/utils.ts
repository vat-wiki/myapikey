import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind classes with conditional logic (shadcn-vue standard util). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
