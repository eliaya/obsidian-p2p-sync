import { AlertTriangle, RotateCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

/** A failed load, with a retry. */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useTranslation()
  return (
    <Alert variant='destructive'>
      <AlertTriangle />
      <AlertTitle>{t('state.loadFailed')}</AlertTitle>
      <AlertDescription>
        <p>{errorMessage(error, t)}</p>
        <Button variant='outline' size='sm' className='mt-2' onClick={onRetry}>
          <RotateCw />
          {t('common.retry')}
        </Button>
      </AlertDescription>
    </Alert>
  )
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  className,
}: {
  icon: React.ElementType
  title: string
  children?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-12 text-center',
        className
      )}
    >
      <Icon className='size-8 text-muted-foreground' aria-hidden />
      <p className='font-medium'>{title}</p>
      {children && <div className='max-w-md text-sm text-muted-foreground'>{children}</div>}
    </div>
  )
}

export function LoadingRows({ rows = 5 }: { rows?: number }) {
  const { t } = useTranslation()
  return (
    <div className='space-y-2' role='status' aria-live='polite'>
      <span className='sr-only'>{t('state.loading')}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className='h-10 w-full' />
      ))}
    </div>
  )
}
