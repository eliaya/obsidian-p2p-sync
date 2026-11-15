import { useTranslation } from 'react-i18next'
import { queryClient } from '@/lib/api'

export type Kind = 'builtin' | 'overridden' | 'custom'

export function KindBadge({ kind }: { kind: Kind }) {
  const { t } = useTranslation()
  const cls = {
    builtin: 'border-border text-muted-foreground',
    overridden: 'border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200',
    custom: 'border-violet-300 bg-violet-50 text-violet-900 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-200',
  }[kind]
  return (
    <span className={`inline-flex rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${cls}`}>
      {t(`lang.kind.${kind}`)}
    </span>
  )
}

export const invalidateLocales = () => queryClient.invalidateQueries({ queryKey: ['i18n'] })

