import { useCallback, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, getRouteApi } from '@tanstack/react-router'
import {
  type ColumnDef,
  type ColumnFiltersState,
  type VisibilityState,
  type FilterFn,
  type HeaderContext,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { Ban, CircleCheck, Clock, Laptop, MoreHorizontal, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { type Peer, peersQuery } from '@/lib/api'
import { formatBytes, formatDate, formatDateTime, formatRelative } from '@/lib/format'
import { useIsMobile } from '@/hooks/use-mobile'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { DataTableColumnHeader, DataTablePagination, DataTableToolbar } from '@/components/data-table'
import { Page } from '@/components/layout/page'
import { EmptyState, ErrorState, LoadingRows } from '@/components/states'
import { type DialogState, type PeerAction, PeerDialogs, peerName, usePeerMutation } from './dialogs'
import { CopyButton, Fingerprint, OnlineBadge, StatusBadge } from './parts'

const route = getRouteApi('/_authenticated/peers')

// Label or fingerprint; spaces ignored so a grouped fingerprint can be pasted.
const search: FilterFn<Peer> = (row, _id, value: string) => {
  const q = value.toLowerCase().replace(/\s+/g, '')
  const p = row.original
  return p.peerId.includes(q) || (p.label ?? '').toLowerCase().replace(/\s+/g, '').includes(q)
}

export function Peers() {
  const { t } = useTranslation()
  const q = useQuery(peersQuery)
  const [dialog, setDialog] = useState<DialogState>(null)
  const act = useCallback((action: PeerAction, peer: Peer) => setDialog({ action, peer }), [])
  const pending = q.data?.filter((p) => p.status === 'pending') ?? []

  return (
    <Page titleKey='nav.peers' description={t('peers.description')}>
      {q.isPending ? (
        <LoadingRows />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyState icon={Laptop} title={t('peers.empty.title')}>
          {t('peers.empty.body', { url: location.origin })}
        </EmptyState>
      ) : (
        <div className='space-y-8'>
          {pending.length > 0 && <PendingList peers={pending} onAction={act} />}
          <PeerTable peers={q.data} onAction={act} />
        </div>
      )}
      <PeerDialogs state={dialog} onClose={() => setDialog(null)} />
    </Page>
  )
}

function PendingList({ peers, onAction }: { peers: Peer[]; onAction: (a: PeerAction, p: Peer) => void }) {
  const { t } = useTranslation()
  return (
    <section aria-labelledby='pending-heading' className='space-y-3'>
      <div>
        <h2 id='pending-heading' className='flex items-center gap-2 text-lg font-semibold'>
          <Clock className='size-5 text-amber-600 dark:text-amber-400' aria-hidden />
          {t('peers.pending.title', { count: peers.length })}
        </h2>
        <p className='text-sm text-muted-foreground'>{t('peers.pending.hint')}</p>
      </div>
      <ul className='grid gap-3 lg:grid-cols-2'>
        {peers.map((p) => (
          <li
            key={p.id}
            className='space-y-3 rounded-lg border border-s-4 border-s-amber-500 bg-card p-4 shadow-xs'
          >
            <div className='flex flex-wrap items-center justify-between gap-2 text-sm'>
              <span className='font-medium'>{p.label || t('peer.unnamed')}</span>
              <span className='text-muted-foreground'>
                {t('peers.pending.meta', { room: p.room, when: formatRelative(p.firstSeen) })}
              </span>
            </div>
            <div className='flex items-start gap-1'>
              <div className='flex-1'>
                <Fingerprint id={p.peerId} large />
              </div>
              <CopyButton value={p.peerId} label={t('peer.copyFingerprint')} />
            </div>
            <div className='flex flex-wrap gap-2'>
              <Button className='flex-1 sm:flex-none' onClick={() => onAction('approve', p)}>
                <ShieldCheck />
                {t('peer.action.approve')}
              </Button>
              <Button variant='outline' className='flex-1 sm:flex-none' onClick={() => onAction('revoke', p)}>
                <Ban />
                {t('peer.action.revoke')}
              </Button>
              <Button variant='ghost' className='text-destructive hover:text-destructive' onClick={() => onAction('delete', p)}>
                {t('peer.action.delete')}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

function RowActions({ peer, onAction: open }: { peer: Peer; onAction: (a: PeerAction, p: Peer) => void }) {
  const { t } = useTranslation()
  const m = usePeerMutation()
  // Dialogs open only once the menu has closed and returned focus to its trigger;
  // otherwise the menu's focus return steals focus from the dialog.
  const next = useRef<PeerAction | null>(null)
  const onAction = (a: PeerAction) => (next.current = a)
  return (
    <div className='flex items-center justify-end gap-1'>
      {peer.status === 'pending' && (
        // Phones approve from the cards above; keep the table narrow there.
        <Button size='sm' className='hidden sm:inline-flex' onClick={() => open('approve', peer)}>
          {t('peer.action.approve')}
        </Button>
      )}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant='ghost' size='icon' className='size-8' aria-label={t('peer.actionsFor', { name: peerName(peer) })}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align='end'
          onCloseAutoFocus={() => {
            if (next.current) open(next.current, peer)
            next.current = null
          }}
        >
          {peer.status === 'pending' && (
            <DropdownMenuItem onClick={() => onAction('approve')}>{t('peer.action.approve')}</DropdownMenuItem>
          )}
          {peer.status === 'revoked' && (
            <DropdownMenuItem
              disabled={m.isPending}
              onClick={() => m.mutate({ peer, action: 'reactivate' })}
            >
              {t('peer.action.reactivate')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => onAction('label')}>{t('peer.action.label')}</DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to='/audit' search={{ peer: peer.id }}>
              {t('peer.action.audit')}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {peer.status !== 'revoked' && (
            <DropdownMenuItem variant='destructive' onClick={() => onAction('revoke')}>
              {t('peer.action.revoke')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem variant='destructive' onClick={() => onAction('delete')}>
            {t('peer.action.delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function PeerTable({ peers, onAction }: { peers: Peer[]; onAction: (a: PeerAction, p: Peer) => void }) {
  const { t, i18n } = useTranslation()
  const { status } = route.useSearch()
  const isMobile = useIsMobile()
  const [sorting, setSorting] = useState<SortingState>([])
  const [globalFilter, setGlobalFilter] = useState('')
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>(status ? [{ id: 'status', value: [status] }] : [])

  const columns = useMemo<ColumnDef<Peer>[]>(() => {
    const head = (key: string) => ({ column }: HeaderContext<Peer, unknown>) => (
      <DataTableColumnHeader column={column} title={t(key)} />
    )
    return [
      {
        accessorKey: 'peerId',
        meta: { label: t('peer.col.peerId') },
        header: head('peer.col.peerId'),
        enableHiding: false,
        cell: ({ row }) => (
          <div className='flex items-center gap-1'>
            <Fingerprint id={row.original.peerId} />
            <CopyButton value={row.original.peerId} label={t('peer.copyFingerprint')} />
          </div>
        ),
      },
      {
        accessorKey: 'label',
        meta: { label: t('peer.col.label') },
        header: head('peer.col.label'),
        sortingFn: (a, b) => (a.original.label ?? '').localeCompare(b.original.label ?? ''),
        cell: ({ row }) =>
          row.original.label ? (
            <span className='block max-w-48 truncate' title={row.original.label}>
              {row.original.label}
            </span>
          ) : (
            <span className='text-muted-foreground'>{t('peer.unnamed')}</span>
          ),
      },
      {
        accessorKey: 'room',
        meta: { label: t('peer.col.room') },
        header: head('peer.col.room'),
        cell: ({ row }) => <span className='font-mono text-xs'>{row.original.room}</span>,
      },
      {
        accessorKey: 'status',
        meta: { label: t('peer.col.status') },
        header: head('peer.col.status'),
        filterFn: 'arrIncludesSome',
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        accessorKey: 'online',
        meta: { label: t('peer.col.online') },
        header: head('peer.col.online'),
        cell: ({ row }) => <OnlineBadge online={row.original.online} />,
      },
      {
        accessorKey: 'firstSeen',
        meta: { label: t('peer.col.firstSeen') },
        header: head('peer.col.firstSeen'),
        cell: ({ row }) => (
          <time dateTime={new Date(row.original.firstSeen).toISOString()} title={formatDateTime(row.original.firstSeen)}>
            {formatDate(row.original.firstSeen)}
          </time>
        ),
      },
      {
        accessorKey: 'lastSeen',
        meta: { label: t('peer.col.lastSeen') },
        header: head('peer.col.lastSeen'),
        cell: ({ row }) => (
          <time dateTime={new Date(row.original.lastSeen).toISOString()} title={formatDateTime(row.original.lastSeen)}>
            {formatRelative(row.original.lastSeen)}
          </time>
        ),
      },
      {
        accessorKey: 'mailboxPendingBytes',
        meta: { label: t('peer.col.mailbox'), className: 'text-end' },
        header: head('peer.col.mailbox'),
        cell: ({ row }) => <span className='tabular-nums'>{formatBytes(row.original.mailboxPendingBytes)}</span>,
      },
      {
        id: 'actions',
        enableHiding: false,
        // Pinned to the end so actions stay reachable while the table scrolls sideways.
        meta: { className: 'sticky end-0 bg-background shadow-[-6px_0_6px_-6px_rgb(0_0_0/0.25)]' },
        header: () => <span className='sr-only'>{t('peer.col.actions')}</span>,
        cell: ({ row }) => <RowActions peer={row.original} onAction={onAction} />,
      },
    ]
    // i18n.language: dates and sizes are formatted per language.
  }, [t, i18n.language, onAction])

  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(() =>
    isMobile ? { room: false, online: false, firstSeen: false, lastSeen: false, mailboxPendingBytes: false } : ({} as VisibilityState)
  )

  const table = useReactTable({
    data: peers,
    columns,
    state: { sorting, globalFilter, columnFilters, columnVisibility },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    globalFilterFn: search,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    initialState: { pagination: { pageSize: 20 } },
    autoResetPageIndex: false,
  })

  return (
    <section aria-labelledby='all-heading' className='space-y-3'>
      <h2 id='all-heading' className='text-lg font-semibold'>
        {t('peers.all.title', { count: peers.length })}
      </h2>
      <DataTableToolbar
        table={table}
        searchPlaceholder={t('peers.search')}
        filters={[
          {
            columnId: 'status',
            title: t('peer.col.status'),
            options: [
              { value: 'pending', label: t('peer.status.pending'), icon: Clock },
              { value: 'active', label: t('peer.status.active'), icon: CircleCheck },
              { value: 'revoked', label: t('peer.status.revoked'), icon: Ban },
            ],
          },
        ]}
      />
      <div className='overflow-hidden rounded-md border'>
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id}>
                {hg.headers.map((h) => (
                  <TableHead key={h.id} className={h.column.columnDef.meta?.className}>
                    {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className={cell.column.columnDef.meta?.className}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className='h-24 text-center text-muted-foreground'>
                  {t('peers.noMatch')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {table.getPageCount() > 1 && <DataTablePagination table={table} />}
    </section>
  )
}
