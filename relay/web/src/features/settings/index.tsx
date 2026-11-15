import { useEffect, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { AlertTriangle, KeyRound, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ApiError, api, errorMessage, queryClient, type Settings as S } from '@/lib/api'
import { bytesToUnit, formatBytes } from '@/lib/format'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Page } from '@/components/layout/page'
import { ErrorState, LoadingRows } from '@/components/states'
import { UnsavedGuard } from '@/components/unsaved-guard'
import { type Errors, type Form, type IntKey, RANGES, toPatch, validate } from './rules'

const settingsQuery = {
  queryKey: ['settings'],
  queryFn: () => api<S>('/api/admin/settings'),
}

const toForm = (s: S): Form => {
  const q = bytesToUnit(s.mailbox_quota_bytes)
  return {
    require_approval: s.require_approval,
    max_peers_per_room: String(s.max_peers_per_room),
    mailbox_ttl_days: String(s.mailbox_ttl_days),
    audit_ttl_days: String(s.audit_ttl_days),
    quota: String(q.value),
    quotaUnit: q.unit,
    turn_key_id: s.turn_key_id ?? '',
    turn_api_token: undefined,
  }
}

export function Settings() {
  const { t } = useTranslation()
  const q = useQuery(settingsQuery)
  return (
    <Page titleKey='nav.settings' description={t('settings.description')}>
      {q.isPending ? (
        <LoadingRows rows={6} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <SettingsForm settings={q.data} />
      )}
    </Page>
  )
}

function SettingsForm({ settings }: { settings: S }) {
  const { t } = useTranslation()
  const initial = toForm(settings)
  const [form, setForm] = useState(initial)
  const [showErrors, setShowErrors] = useState(false)
  // Server data changed (saved, or refetched): start from it again.
  useEffect(() => setForm(toForm(settings)), [settings])

  const errors = validate(form)
  const patch = toPatch(form, initial)
  const dirty = Object.keys(patch).length > 0
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }))

  const save = useMutation({
    mutationFn: () => api('/api/admin/settings', { method: 'PUT', body: patch }),
    onSuccess: async () => {
      toast.success(t('settings.saved'))
      setShowErrors(false)
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (e) =>
      toast.error(e instanceof ApiError && e.status === 400 ? t('settings.rejected') : errorMessage(e, t)),
  })

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setShowErrors(true)
    if (Object.keys(errors).length) {
      document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
      return
    }
    if (dirty) save.mutate()
  }

  const err = (k: keyof Errors, range?: readonly [number, number] | [string, string]) =>
    showErrors && errors[k]
      ? t(`settings.error.${errors[k]}`, { min: range?.[0], max: range?.[1] })
      : undefined

  const intField = (k: IntKey) => (
    <Field
      id={k}
      label={t(`settings.${k}.label`)}
      help={t(`settings.${k}.help`, { min: RANGES[k][0], max: RANGES[k][1] })}
      error={err(k, RANGES[k])}
    >
      {(p) => (
        <Input
          {...p}
          inputMode='numeric'
          className='w-32'
          value={form[k]}
          onChange={(e) => set(k, e.target.value)}
        />
      )}
    </Field>
  )

  return (
    <form onSubmit={submit} noValidate className='space-y-6 pb-24'>
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.group.access')}</CardTitle>
          <CardDescription>{t('settings.group.accessHint')}</CardDescription>
        </CardHeader>
        <CardContent className='space-y-6'>
          <div className='flex items-start justify-between gap-4'>
            <div className='space-y-1'>
              <Label htmlFor='require_approval'>{t('settings.require_approval.label')}</Label>
              <p id='require_approval-help' className='text-sm text-muted-foreground'>
                {t('settings.require_approval.help')}
              </p>
            </div>
            <Switch
              id='require_approval'
              aria-describedby='require_approval-help'
              checked={form.require_approval}
              onCheckedChange={(v) => set('require_approval', v)}
            />
          </div>
          {!form.require_approval && (
            <Alert variant='destructive'>
              <AlertTriangle />
              <AlertTitle>{t('settings.require_approval.offTitle')}</AlertTitle>
              <AlertDescription>{t('settings.require_approval.offBody')}</AlertDescription>
            </Alert>
          )}
          {intField('max_peers_per_room')}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.group.mailbox')}</CardTitle>
          <CardDescription>{t('settings.group.mailboxHint')}</CardDescription>
        </CardHeader>
        <CardContent className='space-y-6'>
          {intField('mailbox_ttl_days')}
          <Field
            id='quota'
            label={t('settings.mailbox_quota_bytes.label')}
            help={t('settings.mailbox_quota_bytes.help', {
              min: formatBytes(RANGES.mailbox_quota_bytes[0]),
              max: formatBytes(RANGES.mailbox_quota_bytes[1]),
            })}
            error={err('quota', [formatBytes(RANGES.mailbox_quota_bytes[0]), formatBytes(RANGES.mailbox_quota_bytes[1])])}
          >
            {(p) => (
              <div className='flex gap-2'>
                <Input
                  {...p}
                  inputMode='decimal'
                  className='w-32'
                  value={form.quota}
                  onChange={(e) => set('quota', e.target.value)}
                />
                <Select value={form.quotaUnit} onValueChange={(v) => set('quotaUnit', v as Form['quotaUnit'])}>
                  <SelectTrigger className='w-24' aria-label={t('settings.unit')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='MB'>MB</SelectItem>
                    <SelectItem value='GB'>GB</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.group.audit')}</CardTitle>
        </CardHeader>
        <CardContent>{intField('audit_ttl_days')}</CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.group.turn')}</CardTitle>
          <CardDescription>{t('settings.group.turnHint')}</CardDescription>
        </CardHeader>
        <CardContent className='space-y-6'>
          <Field
            id='turn_key_id'
            label={t('settings.turn_key_id.label')}
            help={t('settings.turn_key_id.help')}
            error={err('turn_key_id')}
          >
            {(p) => (
              <Input
                {...p}
                autoComplete='off'
                spellCheck={false}
                className='font-mono'
                value={form.turn_key_id}
                onChange={(e) => set('turn_key_id', e.target.value)}
              />
            )}
          </Field>
          <TokenField
            isSet={settings.turn_api_token_set}
            value={form.turn_api_token}
            error={err('turn_api_token')}
            onChange={(v) => set('turn_api_token', v)}
          />
        </CardContent>
      </Card>

      {dirty && (
        <div className='sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-background/95 p-3 shadow-lg backdrop-blur'>
          <p className='text-sm font-medium' role='status'>
            {t('settings.unsaved', { count: Object.keys(patch).length })}
          </p>
          <div className='flex gap-2'>
            <Button
              type='button'
              variant='outline'
              disabled={save.isPending}
              onClick={() => {
                setForm(initial)
                setShowErrors(false)
              }}
            >
              {t('common.discard')}
            </Button>
            <Button type='submit' disabled={save.isPending}>
              {save.isPending && <Loader2 className='animate-spin' />}
              {t('common.save')}
            </Button>
          </div>
        </div>
      )}
      <UnsavedGuard dirty={dirty && !save.isPending} />
    </form>
  )
}

type FieldProps = { id: string; 'aria-describedby': string; 'aria-invalid': boolean }

function Field({
  id,
  label,
  help,
  error,
  children,
}: {
  id: string
  label: string
  help: string
  error?: string
  children: (p: FieldProps) => React.ReactNode
}) {
  return (
    <div className='grid gap-2'>
      <Label htmlFor={id}>{label}</Label>
      {children({ id, 'aria-describedby': `${id}-help${error ? ` ${id}-error` : ''}`, 'aria-invalid': !!error })}
      <p id={`${id}-help`} className='text-sm text-muted-foreground'>
        {help}
      </p>
      {error && (
        <p id={`${id}-error`} className='flex items-center gap-1 text-sm font-medium text-destructive'>
          <AlertTriangle className='size-4' aria-hidden />
          {error}
        </p>
      )}
    </div>
  )
}

/** Write-only secret: shows whether one is stored, never its value. */
function TokenField({
  isSet,
  value,
  error,
  onChange,
}: {
  isSet: boolean
  value: string | undefined
  error?: string
  onChange: (v: string | undefined) => void
}) {
  const { t } = useTranslation()
  const state = value === undefined ? (isSet ? 'set' : 'unset') : value === '' ? 'clearing' : 'replacing'
  return (
    <div className='grid gap-2'>
      <div className='flex flex-wrap items-center gap-2'>
        <Label htmlFor='turn_api_token'>{t('settings.turn_api_token.label')}</Label>
        <span
          className='inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium'
          aria-live='polite'
        >
          <KeyRound className='size-3.5' aria-hidden />
          {t(`settings.turn_api_token.${state}`)}
        </span>
      </div>
      <div className='flex flex-wrap gap-2'>
        <Input
          id='turn_api_token'
          type='password'
          autoComplete='new-password'
          spellCheck={false}
          className='max-w-sm flex-1 font-mono'
          placeholder={t(isSet ? 'settings.turn_api_token.placeholderReplace' : 'settings.turn_api_token.placeholderNew')}
          aria-describedby='turn_api_token-help'
          aria-invalid={!!error}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value || undefined)}
        />
        {isSet && value !== '' && (
          <Button type='button' variant='outline' onClick={() => onChange('')}>
            {t('settings.turn_api_token.clear')}
          </Button>
        )}
        {value !== undefined && (
          <Button type='button' variant='ghost' onClick={() => onChange(undefined)}>
            {t('common.undo')}
          </Button>
        )}
      </div>
      <p id='turn_api_token-help' className='text-sm text-muted-foreground'>
        {t('settings.turn_api_token.help')}
      </p>
      {error && <p className='text-sm font-medium text-destructive'>{t('settings.error.tooLong')}</p>}
    </div>
  )
}
