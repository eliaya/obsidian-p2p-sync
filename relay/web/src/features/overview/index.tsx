import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowRight, Ban, CircleCheck, Clock, DoorOpen, Inbox, Radio } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { overviewQuery } from '@/lib/api'
import { formatBytes, formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Page } from '@/components/layout/page'
import { ErrorState } from '@/components/states'

export function Overview() {
  const { t } = useTranslation()
  const q = useQuery(overviewQuery)

  return (
    <Page titleKey='nav.overview' description={t('overview.description')}>
      {q.isPending ? (
        <div className='space-y-4' role='status'>
          <span className='sr-only'>{t('state.loading')}</span>
          <Skeleton className='h-24 w-full' />
          <div className='grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3'>
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className='h-24' />
            ))}
          </div>
        </div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className='space-y-6'>
          {q.data.peers.pending > 0 ? (
            <section
              aria-live='polite'
              className='flex flex-col gap-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950 sm:flex-row sm:items-center sm:justify-between dark:border-amber-700 dark:bg-amber-950/60 dark:text-amber-100'
            >
              <div className='flex items-start gap-3'>
                <Clock className='mt-0.5 size-6 shrink-0' aria-hidden />
                <div>
                  <h2 className='text-lg font-semibold'>
                    {t('overview.pending.title', { count: q.data.peers.pending })}
                  </h2>
                  <p className='text-sm'>{t('overview.pending.body')}</p>
                </div>
              </div>
              <Button asChild className='bg-amber-900 text-amber-50 hover:bg-amber-900/90 dark:bg-amber-200 dark:text-amber-950 dark:hover:bg-amber-200/90'>
                <Link to='/peers' search={{ status: 'pending' }}>
                  {t('overview.pending.action')}
                  <ArrowRight />
                </Link>
              </Button>
            </section>
          ) : (
            <section
              aria-live='polite'
              className='flex items-center gap-3 rounded-lg border bg-card p-4'
            >
              <CircleCheck className='size-6 shrink-0 text-emerald-600 dark:text-emerald-400' aria-hidden />
              <div>
                <h2 className='font-semibold'>{t('overview.clear.title')}</h2>
                <p className='text-sm text-muted-foreground'>{t('overview.clear.body')}</p>
              </div>
            </section>
          )}

          <dl className='grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3'>
            <Stat icon={CircleCheck} label={t('overview.active')} value={formatNumber(q.data.peers.active)} />
            <Stat icon={Radio} label={t('overview.online')} value={formatNumber(q.data.peers.online)} />
            <Stat
              icon={Clock}
              label={t('overview.pending.label')}
              value={formatNumber(q.data.peers.pending)}
              highlight={q.data.peers.pending > 0}
            />
            <Stat icon={Ban} label={t('overview.revoked')} value={formatNumber(q.data.peers.revoked)} />
            <Stat icon={DoorOpen} label={t('overview.rooms')} value={formatNumber(q.data.rooms)} hint={t('overview.roomsHint')} />
            <Stat
              icon={Inbox}
              label={t('overview.mailbox')}
              value={formatBytes(q.data.mailbox.bytes)}
              hint={t('overview.mailboxHint', { count: q.data.mailbox.bundles, n: formatNumber(q.data.mailbox.bundles) })}
            />
          </dl>
        </div>
      )}
    </Page>
  )
}

function Stat({
  icon: Icon,
  label,
  value,
  hint,
  highlight,
}: {
  icon: React.ElementType
  label: string
  value: string
  hint?: string
  highlight?: boolean
}) {
  return (
    <div
      className={cn(
        'rounded-lg border bg-card p-4',
        highlight && 'border-amber-400 dark:border-amber-600'
      )}
    >
      <dt className='flex items-center gap-2 text-sm text-muted-foreground'>
        <Icon className='size-4' aria-hidden />
        {label}
      </dt>
      <dd className='mt-1 text-2xl font-semibold tabular-nums'>{value}</dd>
      {hint && <dd className='text-xs text-muted-foreground'>{hint}</dd>}
    </div>
  )
}
