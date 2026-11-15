import { useTranslation } from 'react-i18next'
import { LanguageSwitch } from '@/components/language-switch'
import { ThemeSwitch } from '@/components/theme-switch'
import { Logo } from '@/assets/logo'

type AuthLayoutProps = {
  children: React.ReactNode
}

export function AuthLayout({ children }: AuthLayoutProps) {
  const { t } = useTranslation()
  return (
    <div className='container grid h-svh max-w-none items-center justify-center'>
      <div className='absolute top-4 inset-e-4 flex gap-2'>
        <LanguageSwitch />
        <ThemeSwitch />
      </div>
      <div className='mx-auto flex w-full flex-col justify-center space-y-2 py-8 sm:p-8'>
        <div className='mb-4 flex items-center justify-center'>
          <Logo className='me-2' />
          <h1 className='text-xl font-medium'>{t('app.name')}</h1>
        </div>
        {children}
      </div>
    </div>
  )
}
