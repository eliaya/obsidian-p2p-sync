import { ApiError, api, type LocaleData } from '@/lib/api'

/** Stored strings for one language; null when nothing is stored (404). */
export const localeQuery = (code: string) => ({
  queryKey: ['i18n', code],
  queryFn: () =>
    api<LocaleData>(`/api/i18n/${encodeURIComponent(code)}`).catch((e) => {
      if (e instanceof ApiError && e.status === 404) return null
      throw e
    }),
})
