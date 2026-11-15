import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ArrowLeft, Download, Languages, Loader2, RotateCcw, Upload } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { removeLanguage } from '@/i18n'
import { applyLanguage } from '@/i18n/server'
import { api, localesQuery } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Page } from '@/components/layout/page'
import { EmptyState, ErrorState, LoadingRows } from '@/components/states'
import { UnsavedGuard } from '@/components/unsaved-guard'
import { KindBadge, type Kind, invalidateLocales } from './kind'
import {
  BUILTIN,
  MAX_BODY,
  NAMESPACES,
  type Namespace,
  SOURCE,
  type Strings,
  builtinStrings,
  completeness,
  effective,
  parseImport,
  toExport,
  toStored,
} from './model'
import { localeQuery } from './queries'

type Values = Record<Namespace, Strings>

export function Editor({ code }: { code: string }) {
  const { t } = useTranslation()
  const list = useQuery(localesQuery)
  const stored = useQuery(localeQuery(code))
  const known = !!BUILTIN[code] || list.data?.some((l) => l.code === code)

  const body =
    list.isPending || stored.isPending ? (
      <LoadingRows rows={8} />
    ) : list.isError || stored.isError ? (
      <ErrorState error={list.error ?? stored.error} onRetry={() => (list.refetch(), stored.refetch())} />
    ) : !known ? (
      <EmptyState icon={Languages} title={t('lang.unknown', { code })} />
    ) : (
      // Remount after a save so the form starts from what the relay now holds.
      <EditorForm key={JSON.stringify(stored.data)} code={code} stored={stored.data} />
    )
  return body
}

function EditorForm({ code, stored }: { code: string; stored: { name: string } & Values | null }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const builtin = BUILTIN[code]
  const kind: Kind = !builtin ? 'custom' : stored ? 'overridden' : 'builtin'
  const initial = useMemo<Values>(
    () => ({ admin: effective(code, 'admin', stored?.admin), plugin: effective(code, 'plugin', stored?.plugin) }),
    [code, stored]
  )
  const initialName = stored?.name ?? builtin?.name ?? code
  const [values, setValues] = useState(initial)
  const [name, setName] = useState(initialName)
  const [pendingImport, setPendingImport] = useState<{ values: Values; changed: number; ignored: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const changed = NAMESPACES.reduce(
    (n, ns) => n + Object.keys(SOURCE[ns]).filter((k) => values[ns][k] !== initial[ns][k]).length,
    0
  )
  const dirty = changed > 0 || name.trim() !== initialName

  const onChange = useCallback(
    (ns: Namespace, k: string, v: string) => setValues((prev) => ({ ...prev, [ns]: { ...prev[ns], [k]: v } })),
    []
  )

  const save = useMutation({
    mutationFn: async () => {
      const admin = toStored(code, 'admin', values.admin, stored?.admin)
      const plugin = toStored(code, 'plugin', values.plugin, stored?.plugin)
      const n = name.trim()
      if (n.length < 1 || n.length > 64) throw new Error('name')
      // A built-in language with nothing changed needs no stored copy.
      if (builtin && !Object.keys(admin).length && !Object.keys(plugin).length && n === builtin.name) {
        if (stored) await api(`/api/admin/i18n/${encodeURIComponent(code)}`, { method: 'DELETE', body: {} })
        return null
      }
      const body = { name: n, admin, plugin }
      if (new TextEncoder().encode(JSON.stringify(body)).length > MAX_BODY) throw new Error('size')
      await api(`/api/admin/i18n/${encodeURIComponent(code)}`, { method: 'PUT', body })
      return body
    },
    onSuccess: async (body) => {
      if (body) applyLanguage(code, body)
      else removeLanguage(code)
      toast.success(t('lang.saved', { name: name.trim() }))
      await invalidateLocales()
    },
    onError: (e) => {
      if (e instanceof Error && (e.message === 'size' || e.message === 'name')) toast.error(t(`lang.error.${e.message}`))
    },
  })

  const onImportFile = async (file: File) => {
    const r = parseImport(await file.text(), values)
    if (!r.ok) toast.error(t(`lang.import.${r.error}`))
    else if (r.changed === 0) toast.info(t('lang.import.nothing', { ignored: r.ignored }))
    else setPendingImport(r)
  }

  const exportFile = () => {
    const url = URL.createObjectURL(new Blob([toExport(name.trim(), values)], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${code}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Page
      titleKey='lang.editorTitle'
      description={t('lang.editorHint')}
      actions={
        <>
          <Button variant='outline' onClick={() => navigate({ to: '/language', search: {} })}>
            <ArrowLeft />
            {t('lang.back')}
          </Button>
          <Button variant='outline' onClick={exportFile}>
            <Download />
            {t('lang.export')}
          </Button>
          <Button variant='outline' onClick={() => fileRef.current?.click()}>
            <Upload />
            {t('lang.importButton')}
          </Button>
          <input
            ref={fileRef}
            type='file'
            accept='application/json,.json'
            className='hidden'
            aria-hidden
            tabIndex={-1}
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) void onImportFile(f)
            }}
          />
        </>
      }
    >
      <div className='space-y-6 pb-24'>
        <div className='flex flex-wrap items-end gap-4 rounded-lg border bg-card p-4'>
          <div className='grid gap-2'>
            <Label htmlFor='lang-display-name'>{t('lang.name')}</Label>
            <Input
              id='lang-display-name'
              className='w-64 max-w-full'
              value={name}
              maxLength={64}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={!name.trim()}
            />
          </div>
          <div className='grid gap-1 text-sm'>
            <span className='text-muted-foreground'>{t('lang.code')}</span>
            <span className='font-mono'>{code}</span>
          </div>
          <KindBadge kind={kind} />
        </div>

        {builtin && (
          <Alert>
            <AlertDescription>{t('lang.overrideHint')}</AlertDescription>
          </Alert>
        )}

        <Tabs defaultValue='admin'>
          <TabsList>
            {NAMESPACES.map((ns) => {
              const c = completeness(values[ns], SOURCE[ns])
              return (
                <TabsTrigger key={ns} value={ns}>
                  {t(`lang.ns.${ns}`)}
                  <span className='text-xs text-muted-foreground tabular-nums'>
                    {t('lang.progress', c)}
                  </span>
                </TabsTrigger>
              )
            })}
          </TabsList>
          {NAMESPACES.map((ns) => (
            <TabsContent key={ns} value={ns} className='mt-4'>
              <Entries
                ns={ns}
                code={code}
                values={values[ns]}
                initial={initial[ns]}
                onChange={onChange}
              />
            </TabsContent>
          ))}
        </Tabs>
      </div>

      {dirty && (
        <div className='sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-background/95 p-3 shadow-lg backdrop-blur'>
          <p className='text-sm font-medium' role='status'>
            {t('lang.unsaved', { count: changed })}
          </p>
          <div className='flex gap-2'>
            <Button
              variant='outline'
              disabled={save.isPending}
              onClick={() => {
                setValues(initial)
                setName(initialName)
              }}
            >
              {t('common.discard')}
            </Button>
            <Button disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending && <Loader2 className='animate-spin' />}
              {t('common.save')}
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!pendingImport}
        onOpenChange={(o) => !o && setPendingImport(null)}
        title={t('lang.import.title')}
        desc={
          <div className='space-y-2'>
            <p>{t('lang.import.changes', { count: pendingImport?.changed ?? 0 })}</p>
            {!!pendingImport?.ignored && <p>{t('lang.import.ignored', { count: pendingImport.ignored })}</p>}
            <p>{t('lang.import.notSaved')}</p>
          </div>
        }
        confirmText={t('lang.import.apply')}
        handleConfirm={() => {
          if (pendingImport) setValues(pendingImport.values)
          setPendingImport(null)
        }}
      />
      <UnsavedGuard dirty={dirty && !save.isPending} />
    </Page>
  )
}

function Entries({
  ns,
  code,
  values,
  initial,
  onChange,
}: {
  ns: Namespace
  code: string
  values: Strings
  initial: Strings
  onChange: (ns: Namespace, k: string, v: string) => void
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [onlyMissing, setOnlyMissing] = useState(false)
  const keys = useMemo(() => Object.keys(SOURCE[ns]), [ns])
  const builtin = builtinStrings(code, ns)
  // Frozen when the filter is set, so a row does not vanish while it is being typed into.
  const [missing, setMissing] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (onlyMissing) setMissing(new Set(keys.filter((k) => !values[k]?.trim())))
  }, [onlyMissing]) // not on `values`: only when the filter is switched on

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return keys.filter(
      (k) =>
        (!onlyMissing || missing.has(k)) &&
        (!q ||
          k.toLowerCase().includes(q) ||
          SOURCE[ns][k].toLowerCase().includes(q) ||
          values[k]?.toLowerCase().includes(q))
    )
  }, [keys, query, onlyMissing, missing, ns, values])

  if (keys.length === 0)
    return (
      <EmptyState icon={Languages} title={t('lang.emptyNs.title')}>
        {t('lang.emptyNs.body')}
      </EmptyState>
    )

  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap items-center gap-x-4 gap-y-2'>
        <Input
          type='search'
          className='h-9 w-full sm:w-72'
          placeholder={t('lang.search')}
          aria-label={t('lang.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className='flex items-center gap-2'>
          <Checkbox id={`missing-${ns}`} checked={onlyMissing} onCheckedChange={(v) => setOnlyMissing(v === true)} />
          <Label htmlFor={`missing-${ns}`}>{t('lang.onlyMissing')}</Label>
        </div>
        <span className='text-sm text-muted-foreground' role='status'>
          {t('lang.shown', { shown: shown.length, total: keys.length })}
        </span>
      </div>
      <ul className='divide-y rounded-lg border'>
        {shown.map((k) => (
          <Row
            key={k}
            ns={ns}
            k={k}
            source={SOURCE[ns][k]}
            builtin={builtin[k]}
            value={values[k] ?? ''}
            edited={values[k] !== initial[k]}
            onChange={onChange}
          />
        ))}
        {shown.length === 0 && <li className='p-6 text-center text-sm text-muted-foreground'>{t('lang.noMatch')}</li>}
      </ul>
    </div>
  )
}

// Memoised: typing in one row re-renders only that row.
const Row = memo(function Row({
  ns,
  k,
  source,
  builtin,
  value,
  edited,
  onChange,
}: {
  ns: Namespace
  k: string
  source: string
  builtin?: string
  value: string
  edited: boolean
  onChange: (ns: Namespace, k: string, v: string) => void
}) {
  const { t } = useTranslation()
  const id = `tr-${ns}-${k}`
  const overridden = builtin !== undefined && value.trim() !== '' && value !== builtin
  return (
    <li className='grid gap-2 p-3 [contain-intrinsic-size:auto_7rem] [content-visibility:auto] md:grid-cols-2 md:gap-4'>
      <div className='min-w-0 space-y-1'>
        <div className='flex flex-wrap items-center gap-2'>
          <code className='text-xs break-all text-muted-foreground'>{k}</code>
          {edited && <span className='rounded bg-primary/10 px-1.5 text-xs font-medium text-primary'>{t('lang.mark.edited')}</span>}
          {overridden && <span className='rounded bg-sky-100 px-1.5 text-xs font-medium text-sky-900 dark:bg-sky-950 dark:text-sky-200'>{t('lang.mark.overridden')}</span>}
          {!value.trim() && <span className='rounded bg-amber-100 px-1.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200'>{t('lang.mark.missing')}</span>}
        </div>
        <p className='text-sm break-words' lang='en' id={`${id}-src`}>
          {source}
        </p>
      </div>
      <div className='flex items-start gap-1'>
        <Label htmlFor={id} className='sr-only'>
          {t('lang.translationOf', { key: k })}
        </Label>
        <Textarea
          id={id}
          rows={1}
          className={cn('min-h-9 resize-none', edited && 'border-primary/60')}
          aria-describedby={`${id}-src`}
          placeholder={builtin ?? t('lang.fallbackPlaceholder')}
          value={value}
          onChange={(e) => onChange(ns, k, e.target.value)}
        />
        {overridden && (
          <Button
            variant='ghost'
            size='icon'
            className='size-9 shrink-0'
            aria-label={t('lang.resetRow')}
            title={t('lang.resetRow')}
            onClick={() => onChange(ns, k, builtin)}
          >
            <RotateCcw />
          </Button>
        )}
      </div>
    </li>
  )
})
