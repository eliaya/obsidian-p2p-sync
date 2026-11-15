import { useState } from 'react'
import { Ban, Check, CircleCheck, Clock, Copy } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { type PeerStatus } from '@/lib/api'
import { fingerprintGroups } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

const STATUS: Record<PeerStatus, { icon: React.ElementType; className: string }> = {
  pending: {
    icon: Clock,
    className:
      'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200',
  },
  active: {
    icon: CircleCheck,
    className:
      'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  },
  revoked: {
    icon: Ban,
    className:
      'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200',
  },
}

/** Icon + word + colour, so the state never depends on colour alone. */
export function StatusBadge({ status }: { status: PeerStatus }) {
  const { t } = useTranslation()
  const { icon: Icon, className } = STATUS[status]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        className
      )}
    >
      <Icon className='size-3.5' aria-hidden />
      {t(`peer.status.${status}`)}
    </span>
  )
}

export function OnlineBadge({ online }: { online: boolean }) {
  const { t } = useTranslation()
  return (
    <span className='inline-flex items-center gap-1.5 text-sm whitespace-nowrap'>
      <span
        aria-hidden
        className={cn(
          'size-2 rounded-full',
          online ? 'bg-emerald-500 ring-2 ring-emerald-500/25' : 'border border-muted-foreground/60'
        )}
      />
      <span className={cn(!online && 'text-muted-foreground')}>
        {t(online ? 'peer.online' : 'peer.offline')}
      </span>
    </span>
  )
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const { t } = useTranslation()
  const [done, setDone] = useState(false)
  return (
    <Button
      variant='ghost'
      size='icon'
      className='size-7 shrink-0'
      aria-label={label}
      title={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        } catch {
          // Clipboard blocked (e.g. insecure context): the text is still selectable.
        }
      }}
    >
      {done ? <Check className='text-emerald-600' /> : <Copy />}
      <span className='sr-only' aria-live='polite'>
        {done ? t('common.copied') : ''}
      </span>
    </Button>
  )
}

/** Fingerprint in groups of four; `large` lays it out as a grid for side-by-side comparison. */
export function Fingerprint({ id, large }: { id: string; large?: boolean }) {
  const groups = fingerprintGroups(id)
  if (large)
    return (
      <div
        className='grid grid-cols-4 gap-1.5 font-mono text-lg font-semibold tracking-wider sm:text-xl'
        translate='no'
      >
        {groups.map((g, i) => (
          <span
            key={i}
            className={cn(
              'rounded-md px-1 py-1.5 text-center',
              i % 2 ? 'bg-muted' : 'bg-muted/40 ring-1 ring-border'
            )}
          >
            {g}
          </span>
        ))}
      </div>
    )
  // Two rows of four keeps the table narrow; the copy button copies the plain id.
  return (
    <span className='grid w-max grid-cols-4 gap-x-1.5 font-mono text-xs leading-5' translate='no'>
      {groups.map((g, i) => (
        <span key={i}>{g}</span>
      ))}
    </span>
  )
}
