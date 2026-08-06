import { createI18n } from "vue-i18n";
import en from "./en";
import zh from "./zh";

export type Locale = "en" | "zh";

const STORAGE_KEY = "myapikey.locale";

function detectDefault(): Locale {
  const stored = localStorage.getItem(STORAGE_KEY) as Locale | null;
  if (stored === "en" || stored === "zh") return stored;
  const browser = typeof navigator !== "undefined" ? navigator.language : "en";
  return browser.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export const i18n = createI18n({
  legacy: false,
  locale: detectDefault(),
  fallbackLocale: "en",
  messages: { en, zh },
});

export function setLocale(locale: Locale): void {
  i18n.global.locale.value = locale;
  localStorage.setItem(STORAGE_KEY, locale);
}

export function getLocale(): Locale {
  return i18n.global.locale.value as Locale;
}
