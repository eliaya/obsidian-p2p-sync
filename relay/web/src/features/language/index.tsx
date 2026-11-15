import { useState } from 'react'
import { useMutation, useQueries, useQuery } from '@tanstack/react-query'
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { applyLanguage } from '@/i18n/server'
import { removeLanguage } from '@/i18n'
import { api, localesQuery, type LocaleData } from '@/lib/api'
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
import { Page } from '@/components/layout/page'
import { ErrorState, LoadingRows } from '@/components/states'
import { Editor } from './editor'
import { KindBadge, type Kind, invalidateLocales } from './kind'
import { BUILTIN, NAMESPACES, LOCALE_RE, SOURCE, completeness, effective } from './model'
import { localeQuery } from './queries'

const route = getRouteApi('/_authenticated/language')

export function Language() {
  const { edit } = route.useSearch()
  return edit ? <Editor code={edit} /> : <LanguageList />
}

function LanguageList() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const list = useQuery(localesQuery)
  const stored = list.data ?? []
  const codes = [...new Set([...Object.keys(BUILTIN), ...stored.map((l) => l.code)])]
  const data = useQueries({ queries: stored.map((l) => localeQuery(l.code)) })
  const byCode = Object.fromEntries(stored.map((l, i) => [l.code, { meta: l, data: data[i]?.data }]))
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<{ code: string; name: string; kind: Kind } | null>(null)

  const del = useMutation({
    mutationFn: (code: string) => api(`/api/admin/i18n/${encodeURIComponent(code)}`, { method: 'DELETE', body: {} }),
    onSuccess: async (_, code) => {
      removeLanguage(code)
      toast.success(t(removing?.kind === 'custom' ? 'lang.deleted' : 'lang.reverted', { name: removing?.name }))
      setRemoving(null)
      await invalidateLocales()
    },
  })

  const edit = (code: string) => navigate({ to: '/language', search: { edit: code } })

  return (
    <Page
      titleKey='nav.language'
      description={t('lang.description')}
      actions={
        <Button onClick={() => setAdding(true)}>
          <Plus />
          {t('lang.add')}
        </Button>
      }
    >
      {list.isPending ? (
        <LoadingRows rows={3} />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <ul className='grid gap-3 md:grid-cols-2'>
          {codes.map((code) => {
            const s = byCode[code]
            const kind: Kind = !BUILTIN[code] ? 'custom' : s ? 'overridden' : 'builtin'
            const name = s?.meta.name ?? BUILTIN[code].name
            return (
              <li key={code} className='flex flex-col gap-3 rounded-lg border bg-card p-4'>
                <div className='flex flex-wrap items-start justify-between gap-2'>
                  <div className='min-w-0'>
                    <h2 className='truncate font-semibold' lang={code}>
                      {name}
                    </h2>
                    <p className='font-mono text-xs text-muted-foreground'>{code}</p>
                  </div>
                  <KindBadge kind={kind} />
                </div>
                <div className='grid gap-2'>
                  {NAMESPACES.map((ns) => (
                    <Progress
                      key={ns}
                      label={t(`lang.ns.${ns}`)}
                      loading={!!s && s.data === undefined}
                      {...completeness(effective(code, ns, s?.data?.[ns]), SOURCE[ns])}
                    />
                  ))}
                </div>
                {s && (
                  <p className='text-xs text-muted-foreground'>
                    {t('lang.updatedAt', { when: formatDateTime(s.meta.updatedAt) })}
                  </p>
                )}
                <div className='mt-auto flex flex-wrap gap-2'>
                  <Button variant='outline' size='sm' onClick={() => edit(code)}>
                    <Pencil />
                    {t(kind === 'custom' ? 'lang.edit' : 'lang.editOverride')}
                  </Button>
                  {kind !== 'builtin' && (
                    <Button
                      variant='ghost'
                      size='sm'
                      className='text-destructive hover:text-destructive'
                      onClick={() => setRemoving({ code, name, kind })}
                    >
                      {kind === 'custom' ? <Trash2 /> : <RotateCcw />}
                      {t(kind === 'custom' ? 'lang.delete' : 'lang.revert')}
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      <AddDialog open={adding} onOpenChange={setAdding} taken={codes} onCreated={edit} />
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && !del.isPending && setRemoving(null)}
        destructive
        title={t(removing?.kind === 'custom' ? 'lang.deleteTitle' : 'lang.revertTitle', { name: removing?.name })}
        desc={t(removing?.kind === 'custom' ? 'lang.deleteBody' : 'lang.revertBody')}
        confirmText={t(removing?.kind === 'custom' ? 'lang.delete' : 'lang.revert')}
        isLoading={del.isPending}
        handleConfirm={() => removing && del.mutate(removing.code)}
      />
    </Page>
  )
}

function Progress({ label, done, total, loading }: { label: string; done: number; total: number; loading?: boolean }) {
  const { t } = useTranslation()
  const pct = total ? Math.round((done / total) * 100) : 0
  return (
    <div className='grid grid-cols-[5rem_1fr_auto] items-center gap-3 text-sm'>
      <span className='text-muted-foreground'>{label}</span>
      {total === 0 ? (
        <span className='col-span-2 text-xs text-muted-foreground'>{t('lang.noStrings')}</span>
      ) : (
        <>
          <div
            role='progressbar'
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done}
            aria-valuetext={t('lang.progress', { done, total })}
            className='h-2 overflow-hidden rounded-full bg-muted'
          >
            <div className='h-full rounded-full bg-primary transition-[width]' style={{ width: `${pct}%` }} />
          </div>
          <span className='text-xs tabular-nums'>{loading ? '…' : t('lang.progress', { done, total })}</span>
        </>
      )}
    </div>
  )
}

function AddDialog({
  open,
  onOpenChange,
  taken,
  onCreated,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  taken: string[]
  onCreated: (code: string) => void
}) {
  const { t } = useTranslation()
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [touched, setTouched] = useState(false)
  const codeError = !LOCALE_RE.test(code)
    ? 'lang.codeInvalid'
    : taken.includes(code)
      ? 'lang.codeTaken'
      : null
  const nameError = name.trim().length < 1 || name.trim().length > 64 ? 'lang.nameInvalid' : null

  const create = useMutation({
    mutationFn: (body: LocaleData) =>
      api(`/api/admin/i18n/${encodeURIComponent(code)}`, { method: 'PUT', body }),
    onSuccess: async (_, body) => {
      applyLanguage(code, body)
      toast.success(t('lang.created', { name: body.name }))
      await invalidateLocales()
      onOpenChange(false)
      onCreated(code)
      setCode('')
      setName('')
      setTouched(false)
    },
  })

  return (
    <Dialog open={open} onOpenChange={(o) => !create.isPending && onOpenChange(o)}>
      <DialogContent>
        <form
          className='grid gap-4'
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            setTouched(true)
            if (!codeError && !nameError) create.mutate({ name: name.trim(), admin: {}, plugin: {} })
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('lang.add')}</DialogTitle>
            <DialogDescription>{t('lang.addHint')}</DialogDescription>
          </DialogHeader>
          <div className='grid gap-2'>
            <Label htmlFor='lang-code'>{t('lang.code')}</Label>
            <Input
              id='lang-code'
              value={code}
              autoFocus
              spellCheck={false}
              autoCapitalize='none'
              className='font-mono'
              placeholder={t('lang.codePlaceholder')}
              aria-invalid={touched && !!codeError}
              aria-describedby='lang-code-help'
              onChange={(e) => setCode(e.target.value.trim())}
            />
            <p
              id='lang-code-help'
              className={touched && codeError ? 'text-sm font-medium text-destructive' : 'text-sm text-muted-foreground'}
            >
              {t(touched && codeError ? codeError : 'lang.codeHint')}
            </p>
          </div>
          <div className='grid gap-2'>
            <Label htmlFor='lang-name'>{t('lang.name')}</Label>
            <Input
              id='lang-name'
              value={name}
              maxLength={64}
              placeholder={t('lang.namePlaceholder')}
              aria-invalid={touched && !!nameError}
              aria-describedby='lang-name-help'
              onChange={(e) => setName(e.target.value)}
            />
            <p
              id='lang-name-help'
              className={touched && nameError ? 'text-sm font-medium text-destructive' : 'text-sm text-muted-foreground'}
            >
              {t(touched && nameError ? nameError : 'lang.nameHint')}
            </p>
          </div>
          <DialogFooter>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)} disabled={create.isPending}>
              {t('common.cancel')}
            </Button>
            <Button type='submit' disabled={create.isPending}>
              {t('lang.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
