import { useBlocker } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '@/components/confirm-dialog'

/** Asks before leaving the page (in-app or closing the tab) while `dirty`. */
export function UnsavedGuard({ dirty }: { dirty: boolean }) {
  const { t } = useTranslation()
  const b = useBlocker({ shouldBlockFn: () => dirty, enableBeforeUnload: () => dirty, withResolver: true })
  return (
    <ConfirmDialog
      open={b.status === 'blocked'}
      onOpenChange={(o) => !o && b.reset?.()}
      destructive
      title={t('unsaved.title')}
      desc={t('unsaved.description')}
      cancelBtnText={t('unsaved.stay')}
      confirmText={t('unsaved.leave')}
      handleConfirm={() => b.proceed?.()}
    />
  )
}
