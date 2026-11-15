import { expect, test } from 'vitest'
import { LOCALE_RE, SOURCE, completeness, effective, parseImport, toStored } from './model'

const keys = Object.keys(SOURCE.admin)
const [k1, k2] = keys

test('locale code pattern', () => {
  for (const ok of ['ja', 'fil', 'pt-BR', 'zh-Hant-TW', 'sr-Latn']) expect(LOCALE_RE.test(ok)).toBe(true)
  for (const bad of ['', 'J', 'JA', 'ja_JP', 'ja-', 'abcd', 'ja-x', '../x']) expect(LOCALE_RE.test(bad)).toBe(false)
})

test('completeness counts non-empty source keys only', () => {
  expect(completeness({}, SOURCE.admin)).toEqual({ done: 0, total: keys.length })
  expect(completeness({ [k1]: 'x', [k2]: '  ', extra: 'y' }, SOURCE.admin)).toEqual({ done: 1, total: keys.length })
  expect(completeness(effective('en', 'admin'), SOURCE.admin)).toEqual({ done: keys.length, total: keys.length })
  // Empty namespace (plugin today) is 0/0, not an error.
  expect(completeness({}, {})).toEqual({ done: 0, total: 0 })
})

test('effective merges stored overrides over built-in strings', () => {
  const zh = effective('zh-TW', 'admin', { [k1]: 'OVR' })
  expect(zh[k1]).toBe('OVR')
  expect(zh[k2]).not.toBe('')
  expect(effective('ja', 'admin')[k1]).toBe('')
})

test('toStored keeps only real overrides and unknown stored keys', () => {
  const en = effective('en', 'admin')
  expect(toStored('en', 'admin', en)).toEqual({})
  expect(toStored('en', 'admin', { ...en, [k1]: 'Changed' })).toEqual({ [k1]: 'Changed' })
  expect(toStored('ja', 'admin', { [k1]: 'ア', [k2]: '' }, { 'future.key': 'f' })).toEqual({ [k1]: 'ア', 'future.key': 'f' })
})

test('parseImport validates shape and counts changes', () => {
  const cur = { admin: { [k1]: 'a' }, plugin: {} }
  expect(parseImport('not json', cur)).toEqual({ ok: false, error: 'json' })
  expect(parseImport('[]', cur)).toEqual({ ok: false, error: 'shape' })
  expect(parseImport('{"name":"x"}', cur)).toEqual({ ok: false, error: 'shape' })
  expect(parseImport(JSON.stringify({ admin: { [k1]: 1 } }), cur)).toEqual({ ok: false, error: 'shape' })
  const r = parseImport(JSON.stringify({ name: 'Japanese', admin: { [k1]: 'a', [k2]: 'b', nope: 'z' }, plugin: {} }), cur)
  expect(r).toMatchObject({ ok: true, changed: 1, ignored: 1 })
  if (r.ok) expect(r.values.admin[k2]).toBe('b')
  // Blank values never wipe a translation.
  expect(parseImport(JSON.stringify({ admin: { [k1]: '' } }), cur)).toMatchObject({ ok: true, changed: 0 })
})
