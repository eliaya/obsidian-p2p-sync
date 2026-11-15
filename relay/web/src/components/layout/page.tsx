import { useTranslation } from 'react-i18next'
import { LanguageSwitch } from '@/components/language-switch'
import { ThemeSwitch } from '@/components/theme-switch'
import { Header } from './header'
import { Main } from './main'

/** Standard page shell: top bar plus a titled content area. */
export function Page({
  titleKey,
  description,
  actions,
  children,
}: {
  titleKey: string
  description?: React.ReactNode
  actions?: React.ReactNode
  children?: React.ReactNode
}) {
  const { t } = useTranslation()
  return (
    <>
      <Header>
        <div className='ms-auto flex items-center gap-2'>
          <LanguageSwitch />
          <ThemeSwitch />
        </div>
      </Header>
      <Main>
        <div className='mb-6 flex flex-wrap items-end justify-between gap-3'>
          <div className='space-y-1'>
            <h1 className='text-2xl font-bold tracking-tight'>{t(titleKey)}</h1>
            {description && (
              <p className='text-sm text-muted-foreground'>{description}</p>
            )}
          </div>
          {actions && <div className='flex flex-wrap gap-2'>{actions}</div>}
        </div>
        {children}
      </Main>
    </>
  )
}
