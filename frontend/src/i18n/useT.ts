// React hook + provider for the i18n dictionary. Locale persists in
// localStorage so it survives reloads. Default = browser language if
// startsWith("zh"), else en.

import { createContext, createElement, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { tr, LOCALES, LOCALE_LABEL } from "./dict";
import type { DictKey, Locale } from "./dict";

const STORAGE_KEY = "chiyigo.locale";

function detectInitial(): Locale {
  if (typeof localStorage !== "undefined") {
    const saved = localStorage.getItem(STORAGE_KEY) as Locale | null;
    if (saved && LOCALES.includes(saved)) return saved;
  }
  if (typeof navigator !== "undefined" && navigator.language?.startsWith("zh")) return "zh-TW";
  return "en";
}

interface Ctx {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: DictKey, vars?: Record<string, string | number>) => string;
}

const I18nCtx = createContext<Ctx | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectInitial);

  useEffect(() => {
    if (typeof document !== "undefined") document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, l);
  }, []);

  const t = useCallback(
    (key: DictKey, vars?: Record<string, string | number>) => tr(locale, key, vars),
    [locale],
  );

  return createElement(I18nCtx.Provider, { value: { locale, setLocale, t } }, children);
}

export function useT(): Ctx {
  const ctx = useContext(I18nCtx);
  if (!ctx) throw new Error("useT must be used inside <I18nProvider>");
  return ctx;
}

export { LOCALES, LOCALE_LABEL };
