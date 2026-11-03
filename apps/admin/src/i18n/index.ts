import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import fi from './fi.json';
import en from './en.json';

const stored = (() => {
  try {
    return localStorage.getItem('vs.lang');
  } catch {
    return null;
  }
})();

void i18n.use(initReactI18next).init({
  resources: { fi: { translation: fi }, en: { translation: en } },
  lng: stored ?? (navigator.language.startsWith('fi') ? 'fi' : 'en'),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

export function setLanguage(lng: 'fi' | 'en') {
  void i18n.changeLanguage(lng);
  document.documentElement.lang = lng;
  try {
    localStorage.setItem('vs.lang', lng);
  } catch {
    /* ignore */
  }
}

export default i18n;
