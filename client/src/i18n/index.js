import { createI18n } from 'vue-i18n';
import ar from './locales/ar.json';
import en from './locales/en.json';

const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('locale') : null;

export const i18n = createI18n({
  legacy: false,
  locale: saved === 'en' ? 'en' : 'ar',
  fallbackLocale: 'ar',
  messages: { ar, en },
});

export function setDocumentDir(locale) {
  const root = document.documentElement;
  root.setAttribute('lang', locale);
  root.setAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
}
