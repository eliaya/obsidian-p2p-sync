import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { Loader2, ScrollText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { api, type AuditEntry, peersQuery } from '@/lib/api'
import { formatBytes, formatDateTime, formatRelative } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Page } from '@/components/layout/page'
import { EmptyState, ErrorState, LoadingRows } from '@/components/states'

const route = getRouteApi('/_authenticated/audit')

// docs/protocol.md "Audit events", plus i18n_change from the i18n section.
export const EVENTS = [
  'join',
  'leave',
  'mailbox_put',
  'mailbox_ack',
  'turn',
  'admin_login',
  'peer_approve',
  'peer_revoke',
  'peer_delete',
  'setting_change',
  'i18n_change',
]
const ALL = '__all'
const PAGE = 50

export function Audit() {
  const { t, i18n } = useTranslation()
  const { event, peer } = route.useSearch()
  const navigate = useNavigate()
  const peers = useQuery(peersQuery)
  const byHash = new Map(peers.data?.map((p) => [p.id, p]) ?? [])
  // Known peers by their fingerprint (as on the Peers page); deleted ones only by their row hash.
  const short = (hash: string) => {
    const p = byHash.get(hash)
    return p ? `${p.peerId.slice(0, 4)} ${p.peerId.slice(4, 8)}` : hash.slice(0, 8)
  }

  const q = useInfiniteQuery({
    queryKey: ['audit', event ?? null, peer ?? null],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => {
      const s = new URLSearchParams({ limit: String(PAGE) })
      if (pageParam !== null) s.set('before', String(pageParam))
      if (event) s.set('event', event)
      if (peer) s.set('peer', peer)
      return api<{ entries: AuditEntry[]; next: number | null }>(`/api/admin/audit?${s}`)
    },
    getNextPageParam: (last) => last.next,
  })
  const rows = q.data?.pages.flatMap((p) => p.entries) ?? []

  const setFilter = (k: 'event' | 'peer', v: string) =>
    navigate({ to: '/audit', search: (s) => ({ ...s, [k]: v === ALL ? undefined : v }) })

  const eventLabel = (e: string) => (i18n.exists(`audit.event.${e}`) ? t(`audit.event.${e}`) : e)
  const detail = (r: AuditEntry) =>
    r.detail === null
      ? null
      : r.event === 'setting_change' && i18n.exists(`settings.${r.detail}.label`)
        ? t(`settings.${r.detail}.label`)
        : r.detail

  return (
    <Page titleKey='nav.audit' description={t('audit.description')}>
      <div className='mb-4 flex flex-wrap gap-4'>
        <div className='grid gap-1.5'>
          <Label htmlFor='audit-event'>{t('audit.filter.event')}</Label>
          <Select value={event ?? ALL} onValueChange={(v) => setFilter('event', v)}>
            <SelectTrigger id='audit-event' className='w-52'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t('audit.filter.allEvents')}</SelectItem>
              {EVENTS.map((e) => (
                <SelectItem key={e} value={e}>
                  {eventLabel(e)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className='grid gap-1.5'>
          <Label htmlFor='audit-peer'>{t('audit.filter.peer')}</Label>
          <Select value={peer ?? ALL} onValueChange={(v) => setFilter('peer', v)}>
            <SelectTrigger id='audit-peer' className='w-64 max-w-[calc(100vw-2rem)]'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t('audit.filter.allPeers')}</SelectItem>
              {/* A filtered peer that was deleted is still selectable by its short code. */}
              {peer && !byHash.has(peer) && (
                <SelectItem value={peer}>
                  <span className='font-mono'>{peer.slice(0, 8)}</span>
                </SelectItem>
              )}
              {peers.data?.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  <span className='font-mono'>{short(p.id)}</span>
                  {p.label && <span className='truncate'>{p.label}</span>}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {(event || peer) && (
          <Button
            variant='ghost'
            className='self-end'
            onClick={() => navigate({ to: '/audit', search: {} })}
          >
            {t('table.reset')}
          </Button>
        )}
      </div>

      {q.isPending ? (
        <LoadingRows rows={8} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState icon={ScrollText} title={t(event || peer ? 'audit.emptyFiltered' : 'audit.empty')} />
      ) : (
        <div className='space-y-4'>
          <div className='overflow-hidden rounded-md border'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('audit.col.time')}</TableHead>
                  <TableHead>{t('audit.col.event')}</TableHead>
                  <TableHead className='hidden md:table-cell'>{t('audit.col.room')}</TableHead>
                  <TableHead>{t('audit.col.peer')}</TableHead>
                  <TableHead className='hidden text-end md:table-cell'>{t('audit.col.bytes')}</TableHead>
                  <TableHead>{t('audit.col.detail')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const label = r.peer ? byHash.get(r.peer)?.label : null
                  const d = detail(r)
                  return (
                    <TableRow key={r.id}>
                      <TableCell className='whitespace-normal tabular-nums'>
                        <time dateTime={new Date(r.ts).toISOString()} title={formatRelative(r.ts)}>
                          {formatDateTime(r.ts, 'short')}
                        </time>
                      </TableCell>
                      <TableCell title={r.event} className='min-w-28 whitespace-normal'>{eventLabel(r.event)}</TableCell>
                      <TableCell className='hidden font-mono text-xs md:table-cell'>{r.room ?? '—'}</TableCell>
                      <TableCell>
                        {r.peer ? (
                          <span className='flex items-center gap-2'>
                            <span className='font-mono text-xs'>{short(r.peer)}</span>
                            {label && (
                              <span className='max-w-40 truncate' title={label}>
                                {label}
                              </span>
                            )}
                          </span>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell className='hidden text-end tabular-nums md:table-cell'>
                        {r.bytes === null ? '—' : formatBytes(r.bytes)}
                      </TableCell>
                      <TableCell>
                        {d === null ? (
                          '—'
                        ) : (
                          <span title={r.detail ?? undefined} className={d === r.detail ? 'font-mono text-xs' : undefined}>
                            {d}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
          <div className='flex flex-col items-center gap-2'>
            <p className='text-sm text-muted-foreground' role='status'>
              {t('audit.shown', { count: rows.length })}
            </p>
            {q.hasNextPage && (
              <Button variant='outline' onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
                {q.isFetchingNextPage && <Loader2 className='animate-spin' />}
                {t('audit.more')}
              </Button>
            )}
            {q.isFetchNextPageError && <p className='text-sm text-destructive'>{t('state.loadFailed')}</p>}
          </div>
        </div>
      )}
    </Page>
  )
}
