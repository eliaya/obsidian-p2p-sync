import { expect, test } from 'vitest'
import { GB, MB, bytesToUnit, fingerprintGroups, formatBytes, unitToBytes } from './format'

test('capacity converts between bytes and MB/GB both ways', () => {
  expect(bytesToUnit(1073741824)).toEqual({ value: 1, unit: 'GB' })
  expect(bytesToUnit(1.5 * GB)).toEqual({ value: 1.5, unit: 'GB' })
  expect(bytesToUnit(512 * MB)).toEqual({ value: 512, unit: 'MB' })
  expect(bytesToUnit(MB)).toEqual({ value: 1, unit: 'MB' })
  // Not a round GB: stay in MB so the value survives a round trip.
  expect(bytesToUnit(GB + MB)).toEqual({ value: 1025, unit: 'MB' })
  expect(unitToBytes(1, 'GB')).toBe(1073741824)
  expect(unitToBytes(10, 'GB')).toBe(10 * GB)
  expect(unitToBytes(1.5, 'MB')).toBe(1572864)
  for (const b of [MB, 300 * MB, GB, 2.5 * GB, 10 * GB]) {
    const { value, unit } = bytesToUnit(b)
    expect(unitToBytes(value, unit)).toBe(b)
  }
})

test('formatBytes picks a binary unit per locale', () => {
  expect(formatBytes(0, 'en')).toBe('0 bytes')
  expect(formatBytes(1536, 'en')).toBe('1.5 kB')
  expect(formatBytes(GB, 'en')).toBe('1 GB')
})

test('fingerprintGroups splits into groups of four', () => {
  expect(fingerprintGroups('0123456789abcdef')).toEqual(['0123', '4567', '89ab', 'cdef'])
})
