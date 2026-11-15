import { api, type LocaleData, type StoredLocale } from '@/lib/api'
import { replaceLanguage } from './index'

/** Replace whatever was loaded for `code` with the stored strings. */
export function applyLanguage(code: string, data: Pick<LocaleData, 'name' | 'admin'>) {
  replaceLanguage(code, data.name, data.admin)
}

/** At start: offer the languages stored on the relay next to the built-in ones. */
export async function loadServerLanguages() {
  try {
    const { locales } = await api<{ locales: StoredLocale[] }>('/api/i18n')
    await Promise.all(
      locales.map(async (l) => applyLanguage(l.code, await api<LocaleData>(`/api/i18n/${encodeURIComponent(l.code)}`)))
    )
  } catch {
    // Relay unreachable: the built-in languages still work.
  }
}
