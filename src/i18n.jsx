import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import en from '../locales/en.json';
import vi from '../locales/vi.json';

// Ngôn ngữ giao diện. Mặc định tiếng Anh; máy để tiếng Việt thì mặc định tiếng Việt.
// Lựa chọn của người dùng được nhớ cho lần sau.
export const LANGUAGES = [
  { code: 'en', short: 'EN', name: 'English' },
  { code: 'vi', short: 'VI', name: 'Tiếng Việt' },
];
const DICTIONARIES = { en, vi };
const STORAGE_KEY = 'image-studio:language';

export function detectLanguage() {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (DICTIONARIES[stored]) return stored;
  } catch {
    // Không đọc được thì dùng ngôn ngữ của máy.
  }
  // Chỉ xét ngôn ngữ hiển thị chính của Windows: máy dùng tiếng Anh nhưng có cài thêm
  // tiếng Việt (bàn phím, ngôn ngữ phụ) vẫn mở bằng tiếng Anh.
  const primary = navigator.languages?.[0] || navigator.language || '';
  return /^vi\b/i.test(primary) ? 'vi' : 'en';
}

export function translate(language, key, vars) {
  const text = DICTIONARIES[language]?.[key] ?? DICTIONARIES.en[key] ?? key;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match));
}

const I18nContext = createContext({ language: 'en', setLanguage: () => {}, t: (key, vars) => translate('en', key, vars) });

export function I18nProvider({ children }) {
  const [language, setLanguageState] = useState(detectLanguage);

  useEffect(() => {
    document.documentElement.lang = language;
    try {
      window.localStorage.setItem(STORAGE_KEY, language);
    } catch {
      // Không lưu được thì lần sau dùng lại mặc định.
    }
    window.imageBridge?.setLanguage?.(language);
  }, [language]);

  const setLanguage = useCallback((next) => {
    if (DICTIONARIES[next]) setLanguageState(next);
  }, []);
  const t = useCallback((key, vars) => translate(language, key, vars), [language]);
  const value = useMemo(() => ({ language, setLanguage, t }), [language, setLanguage, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}
