import { expect, test } from 'vitest'
import i18n, { addLanguage, detectLanguage, getLanguages, removeLanguage, replaceLanguage } from './index'

test('detectLanguage maps Traditional Chinese variants, else en', () => {
  for (const l of ['zh-TW', 'zh-Hant', 'zh-Hant-TW', 'zh-HK'])
    expect(detectLanguage(l)).toBe('zh-TW')
  for (const l of ['zh-CN', 'zh', 'ja', 'en-US', undefined])
    expect(detectLanguage(l)).toBe('en')
})

test('addLanguage registers a language, falls back to en for missing keys', async () => {
  addLanguage('xx', 'Test', { 'nav.peers': 'PEERS' })
  expect(getLanguages().some((l) => l.code === 'xx' && l.name === 'Test')).toBe(true)
  await i18n.changeLanguage('xx')
  expect(i18n.t('nav.peers')).toBe('PEERS')
  expect(i18n.t('nav.settings')).toBe('Settings')
})

test('replaceLanguage drops old overrides; removeLanguage restores built-in or removes', async () => {
  await i18n.changeLanguage('zh-TW')
  const shipped = i18n.t('nav.settings')
  replaceLanguage('zh-TW', '繁中', { 'nav.settings': 'OVR', 'nav.audit': 'A' })
  expect(i18n.t('nav.settings')).toBe('OVR')
  replaceLanguage('zh-TW', '繁中', { 'nav.audit': 'A' })
  expect(i18n.t('nav.settings')).toBe(shipped)
  removeLanguage('zh-TW')
  expect(i18n.t('nav.audit')).not.toBe('A')
  expect(getLanguages().find((l) => l.code === 'zh-TW')?.name).toBe('繁體中文')

  addLanguage('yy', 'Y', { 'nav.peers': 'P' })
  await i18n.changeLanguage('yy')
  removeLanguage('yy')
  expect(getLanguages().some((l) => l.code === 'yy')).toBe(false)
  expect(i18n.language).not.toBe('yy')
})
