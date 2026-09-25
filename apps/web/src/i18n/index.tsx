import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { en, zh, type TranslationKey } from './strings/index.js';

export type { TranslationKey } from './strings/index.js';

/**
 * Minimal, dependency-free i18n (Signal-era web UI). Two locales — `en`
 * (source of truth) and `zh` (Simplified Chinese) — live side by side in
 * `strings/*.ts`, where each leaf types its `zh` object as `typeof en`, so a
 * missing key is a compile error, not a runtime surprise. Keys are resolved by
 * dot path at runtime; `t()` falls back to English, then to the key itself.
 *
 * The choice persists in localStorage; first visit follows the browser
 * language. `<html lang>` is kept in sync for a11y and font selection.
 */

export type Lang = 'en' | 'zh';

const LANG_KEY = 'hnx.lang';

type Params = Record<string, string | number>;

const DICTS: Record<Lang, typeof en> = { en, zh };

/** BCP-47 locale for date/number formatting that follows the UI language. */
export function dateLocale(lang: Lang): string {
  return lang === 'zh' ? 'zh-CN' : 'en-US';
}

function initialLang(): Lang {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored === 'en' || stored === 'zh') return stored;
  } catch {
    /* storage unavailable (private mode) — fall through to detection */
  }
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('zh')
    ? 'zh'
    : 'en';
}

function lookup(dict: unknown, key: string): string | undefined {
  let cur: unknown = dict;
  for (const part of key.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'string' ? cur : undefined;
}

/** `{name}` interpolation; unknown placeholders pass through untouched. */
function format(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

interface I18n {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: TFunc;
}

/** The translate function, so non-component helpers can accept `t` as a param. */
type TFunc = (key: TranslationKey, params?: Params) => string;

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      localStorage.setItem(LANG_KEY, next);
    } catch {
      /* non-fatal — the in-memory choice still applies for this session */
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  }, [lang]);

  const value = useMemo<I18n>(
    () => ({
      lang,
      setLang,
      t: (key, params) => {
        const template = lookup(DICTS[lang], key) ?? lookup(DICTS.en, key) ?? key;
        return format(template, params);
      },
    }),
    [lang, setLang],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within <I18nProvider>');
  return ctx;
}
