import { useState } from 'react'
import { getRouteApi, useRouter } from '@tanstack/react-router'
import { AlertCircle, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ApiError, api, errorMessage, queryClient } from '@/lib/api'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AuthLayout } from '../auth-layout'

const route = getRouteApi('/(auth)/sign-in')

// Only same-origin paths: `redirect` comes from the URL.
const safePath = (p?: string) => (p?.startsWith('/') && !p.startsWith('//') ? p : '/')

export function SignIn() {
  const { t } = useTranslation()
  const router = useRouter()
  const { redirect } = route.useSearch()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    // Read from the form, never kept in state or storage beyond this call.
    const token = new FormData(e.currentTarget).get('token')
    setBusy(true)
    setError(null)
    try {
      await api('/api/admin/login', { method: 'POST', body: { token } })
      queryClient.clear()
      router.history.push(safePath(redirect))
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? t('login.wrongToken')
          : errorMessage(err, t)
      )
      setBusy(false)
    }
  }

  return (
    <AuthLayout>
      <Card className='w-full max-w-sm gap-4 self-center'>
        <CardHeader>
          <CardTitle className='text-lg tracking-tight'>
            {t('login.title')}
          </CardTitle>
          <CardDescription>{t('login.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form className='grid gap-4' onSubmit={onSubmit}>
            <div className='grid gap-2'>
              <Label htmlFor='token'>{t('login.token')}</Label>
              <Input
                id='token'
                name='token'
                type='password'
                autoComplete='off'
                autoFocus
                required
                aria-invalid={!!error}
                aria-describedby={error ? 'token-error' : 'token-hint'}
              />
              <p id='token-hint' className='text-xs text-muted-foreground'>
                {t('login.hint')}
              </p>
            </div>
            {error && (
              <Alert variant='destructive' id='token-error'>
                <AlertCircle />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button type='submit' disabled={busy}>
              {busy && <Loader2 className='animate-spin' />}
              {t('login.submit')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </AuthLayout>
  )
}
