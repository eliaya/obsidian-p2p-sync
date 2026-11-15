import i18n from '@/i18n'

export const MB = 1024 * 1024
export const GB = 1024 * MB

// A stored language code may be valid for us but not for Intl; fall back to en.
function locale(): string {
  try {
    return Intl.getCanonicalLocales(i18n.language)[0] ?? 'en'
  } catch {
    return 'en'
  }
}

export const formatNumber = (n: number) => new Intl.NumberFormat(locale()).format(n)

/** Binary units (1 MB = 1024² bytes, as the relay counts them). */
export function formatBytes(n: number, lng = locale()): string {
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return new Intl.NumberFormat(lng, {
    style: 'unit',
    unit: units[i],
    unitDisplay: i === 0 ? 'long' : 'short',
    maximumFractionDigits: i === 0 ? 0 : 1,
  }).format(v)
}

export const formatDateTime = (ms: number, style: 'medium' | 'short' = 'medium') =>
  new Intl.DateTimeFormat(locale(), { dateStyle: style, timeStyle: 'short' }).format(ms)

export const formatDate = (ms: number) => new Intl.DateTimeFormat(locale(), { dateStyle: 'medium' }).format(ms)

export function formatRelative(ms: number, now = Date.now()): string {
  const s = Math.round((ms - now) / 1000)
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 30],
    ['month', 12],
    ['year', Infinity],
  ]
  let v = s
  for (const [unit, size] of steps) {
    if (Math.abs(v) < size)
      return new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' }).format(Math.round(v), unit)
    v /= size
  }
  return ''
}

/** "a1b2c3d4…" -> ["a1b2", "c3d4", …] so two screens can be compared group by group. */
export const fingerprintGroups = (id: string) => id.match(/.{1,4}/g) ?? []

/** Split a byte count into the largest unit (MB or GB) that shows it exactly enough for a form. */
export function bytesToUnit(bytes: number): { value: number; unit: 'MB' | 'GB' } {
  return bytes >= GB && (bytes * 10) % GB === 0
    ? { value: bytes / GB, unit: 'GB' }
    : { value: Math.round((bytes / MB) * 100) / 100, unit: 'MB' }
}

export const unitToBytes = (value: number, unit: 'MB' | 'GB') =>
  Math.round(value * (unit === 'GB' ? GB : MB))
