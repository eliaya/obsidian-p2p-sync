import { useEffect, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api, queryClient, type Peer } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Fingerprint } from './parts'

export type PeerAction = 'approve' | 'revoke' | 'reactivate' | 'delete' | 'label'
export type DialogState = { action: PeerAction; peer: Peer } | null

/** How a peer is named in messages: its label, else the first fingerprint groups. */
export const peerName = (p: Pick<Peer, 'label' | 'peerId'>) =>
  p.label || `${p.peerId.slice(0, 4)} ${p.peerId.slice(4, 8)}…`

const refresh = () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: ['peers'] }),
    queryClient.invalidateQueries({ queryKey: ['overview'] }),
  ])

export function usePeerMutation() {
  const { t } = useTranslation()
  return useMutation({
    mutationFn: ({ peer, action, label }: { peer: Peer; action: PeerAction; label?: string }) =>
      action === 'delete'
        ? api(`/api/admin/peers/${peer.id}`, { method: 'DELETE', body: {} })
        : api(`/api/admin/peers/${peer.id}`, {
            method: 'PATCH',
            body:
              action === 'label'
                ? { label }
                : { status: action === 'revoke' ? 'revoked' : 'active' },
          }),
    onSuccess: (_, { peer, action, label }) => {
      toast.success(
        t(`peer.done.${action}`, {
          name: action === 'label' ? peerName({ ...peer, label: label ?? null }) : peerName(peer),
        })
      )
      return refresh()
    },
  })
}

export function PeerDialogs({ state, onClose }: { state: DialogState; onClose: () => void }) {
  const { t } = useTranslation()
  const m = usePeerMutation()
  const run = (label?: string) =>
    state && m.mutate({ peer: state.peer, action: state.action, label }, { onSuccess: onClose })
  const open = (a: PeerAction) => state?.action === a
  const close = (o: boolean) => !o && !m.isPending && onClose()
  const peer = state?.peer
  const name = peer ? peerName(peer) : ''

  return (
    <>
      <Dialog open={open('approve')} onOpenChange={close}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('peer.approve.title')}</DialogTitle>
            <DialogDescription>{t('peer.approve.description')}</DialogDescription>
          </DialogHeader>
          {peer && (
            <div className='space-y-3'>
              <Fingerprint id={peer.peerId} large />
              <dl className='grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm'>
                <dt className='text-muted-foreground'>{t('peer.col.label')}</dt>
                <dd>{peer.label || <span className='text-muted-foreground'>{t('peer.unnamed')}</span>}</dd>
                <dt className='text-muted-foreground'>{t('peer.col.room')}</dt>
                <dd className='font-mono'>{peer.room}</dd>
                <dt className='text-muted-foreground'>{t('peer.col.firstSeen')}</dt>
                <dd>{formatDateTime(peer.firstSeen)}</dd>
              </dl>
            </div>
          )}
          <DialogFooter>
            <Button variant='outline' onClick={onClose} disabled={m.isPending}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => run()} disabled={m.isPending}>
              {t('peer.approve.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={open('revoke')}
        onOpenChange={close}
        destructive
        title={t('peer.revoke.title', { name })}
        desc={
          <div className='space-y-2'>
            <p>{t('peer.revoke.effect')}</p>
            <p className='font-medium text-foreground'>{t('peer.revoke.keyWarning')}</p>
          </div>
        }
        confirmText={t('peer.revoke.confirm')}
        isLoading={m.isPending}
        handleConfirm={() => run()}
      />

      <ConfirmDialog
        open={open('delete')}
        onOpenChange={close}
        destructive
        title={t('peer.delete.title', { name })}
        desc={
          <div className='space-y-2'>
            <p>{t('peer.delete.effect')}</p>
            <p className='font-medium text-foreground'>{t('peer.delete.reappear')}</p>
          </div>
        }
        confirmText={t('peer.delete.confirm')}
        isLoading={m.isPending}
        handleConfirm={() => run()}
      />

      <LabelDialog
        peer={open('label') ? peer : undefined}
        busy={m.isPending}
        onClose={() => close(false)}
        onSave={(l) => run(l)}
      />
    </>
  )
}

function LabelDialog({
  peer,
  busy,
  onClose,
  onSave,
}: {
  peer?: Peer
  busy: boolean
  onClose: () => void
  onSave: (label: string) => void
}) {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  useEffect(() => setValue(peer?.label ?? ''), [peer])
  return (
    <Dialog open={!!peer} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          className='grid gap-4'
          onSubmit={(e) => {
            e.preventDefault()
            onSave(value.trim())
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('peer.label.title')}</DialogTitle>
            <DialogDescription>{t('peer.label.description')}</DialogDescription>
          </DialogHeader>
          {peer && <Fingerprint id={peer.peerId} />}
          <div className='grid gap-2'>
            <Label htmlFor='peer-label'>{t('peer.col.label')}</Label>
            <Input
              id='peer-label'
              value={value}
              maxLength={64}
              autoFocus
              placeholder={t('peer.label.placeholder')}
              aria-describedby='peer-label-count'
              onChange={(e) => setValue(e.target.value)}
            />
            <p id='peer-label-count' className='text-end text-xs text-muted-foreground'>
              {t('common.charCount', { count: value.length, max: 64 })}
            </p>
          </div>
          <DialogFooter>
            <Button type='button' variant='outline' onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type='submit' disabled={busy}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
