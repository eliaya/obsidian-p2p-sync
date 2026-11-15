import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@locales/admin/en.json'
import zhTW from '@locales/admin/zh-TW.json'

const STORAGE_KEY = 'pvs.lang'

// Display names of the languages that can be chosen; addLanguage() extends it.
const BUILTIN: Record<string, { name: string; strings: Record<string, string> }> = {
  en: { name: 'English', strings: en },
  'zh-TW': { name: '繁體中文', strings: zhTW },
}
const names: Record<string, string> = { en: 'English', 'zh-TW': '繁體中文' }

export const getLanguages = () =>
  Object.entries(names).map(([code, name]) => ({ code, name }))

const read = () => {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function detectLanguage(browserLang: string | undefined): string {
  return browserLang && /^zh-(tw|hk|hant)/i.test(browserLang) ? 'zh-TW' : 'en'
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, 'zh-TW': { translation: zhTW } },
  lng: read() ?? detectLanguage(globalThis.navigator?.language),
  fallbackLng: 'en',
  // Keys are flat strings that contain dots.
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
  // Re-render when addLanguage() / removeLanguage() change a bundle.
  react: { bindI18nStore: 'added removed' },
})

i18n.on('languageChanged', (l) => {
  if (typeof document !== 'undefined') document.documentElement.lang = l
})

export function setLanguage(code: string) {
  try {
    localStorage.setItem(STORAGE_KEY, code)
  } catch {
    // Storage unavailable: the choice only lasts for this page load.
  }
  return i18n.changeLanguage(code)
}

/** Add (or override) a language at runtime; it then shows up in the switcher. */
export function addLanguage(
  code: string,
  name: string,
  strings: Record<string, string>
) {
  names[code] = name
  i18n.addResourceBundle(code, 'translation', strings, true, true)
  // The saved choice may be a language that only exists on the server.
  if (read() === code) void i18n.changeLanguage(code)
}

// Back to the shipped strings (built-in) or no bundle at all.
function resetBundle(code: string) {
  i18n.removeResourceBundle(code, 'translation')
  const b = BUILTIN[code]
  if (b) {
    names[code] = b.name
    i18n.addResourceBundle(code, 'translation', b.strings)
  }
}

/** Like addLanguage(), but keys missing from `strings` lose any earlier override. */
export function replaceLanguage(code: string, name: string, strings: Record<string, string>) {
  resetBundle(code)
  addLanguage(code, name, strings)
}

/** Undo addLanguage(): a built-in language goes back to its shipped strings, any other disappears. */
export function removeLanguage(code: string) {
  resetBundle(code)
  if (!BUILTIN[code]) {
    delete names[code]
    if (i18n.language === code) void i18n.changeLanguage(detectLanguage(globalThis.navigator?.language))
    // Forget a saved choice that no longer exists, so the next visit auto-detects again.
    if (read() === code) {
      try {
        localStorage.removeItem(STORAGE_KEY)
      } catch {
        // Storage unavailable: nothing was saved.
      }
    }
  }
}

export default i18n
