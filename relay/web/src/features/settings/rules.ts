import { GB, MB, unitToBytes } from '@/lib/format'

// Mirrors RULES in relay/src/db.ts; the server still has the last word (400).
export const RANGES = {
  max_peers_per_room: [2, 32],
  mailbox_ttl_days: [1, 365],
  audit_ttl_days: [1, 3650],
  mailbox_quota_bytes: [MB, 10 * GB],
} as const

export type IntKey = Exclude<keyof typeof RANGES, 'mailbox_quota_bytes'>

/** The form values, as the user typed them. */
export type Form = {
  require_approval: boolean
  max_peers_per_room: string
  mailbox_ttl_days: string
  audit_ttl_days: string
  quota: string
  quotaUnit: 'MB' | 'GB'
  turn_key_id: string
  /** undefined = keep, '' = clear, other = replace */
  turn_api_token: string | undefined
}

export type FieldError = 'integer' | 'range' | 'number' | 'tooLong'
export type Errors = Partial<Record<keyof Form, FieldError>>

const isInt = (s: string) => /^\s*\d+\s*$/.test(s)

export function validate(f: Form): Errors {
  const e: Errors = {}
  for (const k of ['max_peers_per_room', 'mailbox_ttl_days', 'audit_ttl_days'] as IntKey[]) {
    const [min, max] = RANGES[k]
    if (!isInt(f[k])) e[k] = 'integer'
    else if (+f[k] < min || +f[k] > max) e[k] = 'range'
  }
  const q = Number(f.quota)
  const [qmin, qmax] = RANGES.mailbox_quota_bytes
  if (f.quota.trim() === '' || !Number.isFinite(q)) e.quota = 'number'
  else if (unitToBytes(q, f.quotaUnit) < qmin || unitToBytes(q, f.quotaUnit) > qmax) e.quota = 'range'
  if (f.turn_key_id.trim().length > 256) e.turn_key_id = 'tooLong'
  if ((f.turn_api_token?.length ?? 0) > 256) e.turn_api_token = 'tooLong'
  return e
}

/** PUT body with only the keys that differ from what the server returned. */
export function toPatch(f: Form, initial: Form): Record<string, unknown> {
  const p: Record<string, unknown> = {}
  if (f.require_approval !== initial.require_approval) p.require_approval = f.require_approval
  for (const k of ['max_peers_per_room', 'mailbox_ttl_days', 'audit_ttl_days'] as IntKey[])
    if (+f[k] !== +initial[k]) p[k] = +f[k]
  const q = unitToBytes(Number(f.quota), f.quotaUnit)
  if (q !== unitToBytes(Number(initial.quota), initial.quotaUnit)) p.mailbox_quota_bytes = q
  if (f.turn_key_id.trim() !== initial.turn_key_id) p.turn_key_id = f.turn_key_id.trim() || null
  if (f.turn_api_token !== undefined) p.turn_api_token = f.turn_api_token || null
  return p
}
