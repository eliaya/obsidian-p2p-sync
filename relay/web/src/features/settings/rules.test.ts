import { expect, test } from 'vitest'
import { type Form, toPatch, validate } from './rules'

const base: Form = {
  require_approval: true,
  max_peers_per_room: '8',
  mailbox_ttl_days: '30',
  audit_ttl_days: '90',
  quota: '1',
  quotaUnit: 'GB',
  turn_key_id: '',
  turn_api_token: undefined,
}

test('validate matches the relay ranges', () => {
  expect(validate(base)).toEqual({})
  expect(validate({ ...base, max_peers_per_room: '1' }).max_peers_per_room).toBe('range')
  expect(validate({ ...base, max_peers_per_room: '33' }).max_peers_per_room).toBe('range')
  expect(validate({ ...base, max_peers_per_room: '2.5' }).max_peers_per_room).toBe('integer')
  expect(validate({ ...base, mailbox_ttl_days: '366' }).mailbox_ttl_days).toBe('range')
  expect(validate({ ...base, audit_ttl_days: '3650' })).toEqual({})
  expect(validate({ ...base, audit_ttl_days: '' }).audit_ttl_days).toBe('integer')
  expect(validate({ ...base, quota: '10', quotaUnit: 'GB' })).toEqual({})
  expect(validate({ ...base, quota: '10.01', quotaUnit: 'GB' }).quota).toBe('range')
  expect(validate({ ...base, quota: '0.5', quotaUnit: 'MB' }).quota).toBe('range')
  expect(validate({ ...base, quota: '1', quotaUnit: 'MB' })).toEqual({})
  expect(validate({ ...base, quota: 'abc' }).quota).toBe('number')
  expect(validate({ ...base, turn_key_id: 'x'.repeat(257) }).turn_key_id).toBe('tooLong')
})

test('toPatch sends only changed keys, in bytes, and null to clear', () => {
  expect(toPatch(base, base)).toEqual({})
  // Same capacity in another unit is not a change.
  expect(toPatch({ ...base, quota: '1024', quotaUnit: 'MB' }, base)).toEqual({})
  expect(toPatch({ ...base, quota: '512', quotaUnit: 'MB', max_peers_per_room: '10' }, base)).toEqual({
    mailbox_quota_bytes: 536870912,
    max_peers_per_room: 10,
  })
  expect(toPatch({ ...base, turn_api_token: '' }, base)).toEqual({ turn_api_token: null })
  expect(toPatch({ ...base, turn_api_token: 'secret' }, base)).toEqual({ turn_api_token: 'secret' })
  expect(toPatch(base, { ...base, turn_key_id: 'k' })).toEqual({ turn_key_id: null })
  expect(toPatch({ ...base, require_approval: false }, base)).toEqual({ require_approval: false })
})
