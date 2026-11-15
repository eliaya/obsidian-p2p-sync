import { useNavigate, useRouter } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'

export function GeneralError() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { history } = useRouter()
  return (
    <div className='h-svh w-full'>
      <div className='m-auto flex h-full w-full flex-col items-center justify-center gap-2'>
        <h1 className='text-[7rem] leading-tight font-bold'>500</h1>
        <span className='font-medium'>{t('error.general.title')}</span>
        <p className='text-center text-muted-foreground'>
          {t('error.general.description')}
        </p>
        <div className='mt-6 flex gap-4'>
          <Button variant='outline' onClick={() => history.go(-1)}>
            {t('error.goBack')}
          </Button>
          <Button onClick={() => navigate({ to: '/' })}>
            {t('error.goHome')}
          </Button>
        </div>
      </div>
    </div>
  )
}
