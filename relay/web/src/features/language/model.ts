import enAdmin from '@locales/admin/en.json'
import zhAdmin from '@locales/admin/zh-TW.json'
import enPlugin from '@locales/plugin/en.json'
import zhPlugin from '@locales/plugin/zh-TW.json'

export type Strings = Record<string, string>
export type Namespace = 'admin' | 'plugin'
export const NAMESPACES: Namespace[] = ['admin', 'plugin']

// Same pattern as relay/src/admin.ts.
export const LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/
export const MAX_BODY = 512 * 1024

export const SOURCE: Record<Namespace, Strings> = { admin: enAdmin, plugin: enPlugin }
export const BUILTIN: Record<string, { name: string } & Record<Namespace, Strings>> = {
  en: { name: 'English', admin: enAdmin, plugin: enPlugin },
  'zh-TW': { name: '繁體中文', admin: zhAdmin, plugin: zhPlugin },
}

export const builtinStrings = (code: string, ns: Namespace): Strings =>
  BUILTIN[code]?.[ns] ?? {}

/** What the UI shows for each source key: the stored override, else the built-in string. */
export function effective(code: string, ns: Namespace, stored: Strings = {}): Strings {
  const b = builtinStrings(code, ns)
  const out: Strings = {}
  for (const k of Object.keys(SOURCE[ns])) out[k] = stored[k] ?? b[k] ?? ''
  return out
}

/** Translated source keys / all source keys. */
export function completeness(values: Strings, source: Strings) {
  const keys = Object.keys(source)
  return { done: keys.filter((k) => values[k]?.trim()).length, total: keys.length }
}

/**
 * What to store: only values that are non-empty and differ from the built-in
 * string. Stored keys unknown to the source (e.g. from a newer plugin) are kept.
 */
export function toStored(code: string, ns: Namespace, values: Strings, prevStored: Strings = {}): Strings {
  const b = builtinStrings(code, ns)
  const out: Strings = {}
  for (const [k, v] of Object.entries(prevStored)) if (!(k in SOURCE[ns])) out[k] = v
  for (const [k, v] of Object.entries(values)) if (v.trim() && v !== b[k]) out[k] = v
  return out
}

export type ImportResult =
  | { ok: true; values: Record<Namespace, Strings>; changed: number; ignored: number }
  | { ok: false; error: 'json' | 'shape' }

const isFlat = (m: unknown): m is Strings =>
  !!m && typeof m === 'object' && !Array.isArray(m) && Object.values(m).every((v) => typeof v === 'string')

/**
 * Parse an exported file ({name?, admin?, plugin?}) against the current values.
 * Empty strings in the file leave the current value alone; unknown keys are ignored.
 * `name` is accepted but not applied, so importing another language's file cannot rename this one.
 */
export function parseImport(text: string, current: Record<Namespace, Strings>): ImportResult {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, error: 'json' }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'shape' }
  const d = data as Record<string, unknown>
  if (d.name !== undefined && (typeof d.name !== 'string' || d.name.length > 64)) return { ok: false, error: 'shape' }
  if (!NAMESPACES.some((ns) => ns in d)) return { ok: false, error: 'shape' }
  let changed = 0
  let ignored = 0
  const values = { admin: { ...current.admin }, plugin: { ...current.plugin } }
  for (const ns of NAMESPACES) {
    if (d[ns] === undefined) continue
    if (!isFlat(d[ns])) return { ok: false, error: 'shape' }
    for (const [k, v] of Object.entries(d[ns] as Strings)) {
      if (!(k in SOURCE[ns])) ignored++
      else if (v.trim() && v !== values[ns][k]) {
        values[ns][k] = v
        changed++
      }
    }
  }
  return { ok: true, values, changed, ignored }
}

/** Export: every source key, "" where untranslated, so a translator sees what is missing. */
export const toExport = (name: string, values: Record<Namespace, Strings>) =>
  JSON.stringify({ name, admin: values.admin, plugin: values.plugin }, null, 2) + '\n'
