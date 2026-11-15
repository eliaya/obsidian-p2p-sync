import { QueryCache, MutationCache, QueryClient } from '@tanstack/react-query'
import type { TFunction } from 'i18next'

export class ApiError extends Error {
  constructor(
    public status: number, // 0 = network failure
    public code: string
  ) {
    super(code)
  }
}

/** JSON fetch against the relay. Throws ApiError; 204 resolves to undefined. */
export async function api<T = void>(
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method: init.method ?? 'GET',
      // /api/i18n is publicly cached for 5 min; the admin must see its own writes.
      cache: 'no-store',
      headers:
        init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
  } catch {
    throw new ApiError(0, 'network')
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(res.status, body?.error ?? 'http')
  }
  return (res.status === 204 ? undefined : await res.json()) as T
}

// Set by main.tsx: where a 401 from any admin call sends the user.
export const onUnauthorized = { current: () => {} }
const is401 = (e: unknown) => e instanceof ApiError && e.status === 401
// Set by main.tsx so mutation failures get a toast without each caller repeating it.
export const onMutationError = { current: (_e: unknown) => {} }

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (e) => is401(e) && onUnauthorized.current(),
  }),
  mutationCache: new MutationCache({
    // A mutation with its own onError reports its own failures.
    onError: (e, _v, _c, m) =>
      is401(e) ? onUnauthorized.current() : !m.options.onError && onMutationError.current(e),
  }),
  defaultOptions: {
    queries: {
      retry: (n, e) => e instanceof ApiError && e.status === 0 && n < 2,
      refetchOnWindowFocus: true,
    },
  },
})

// ---- API shapes (docs/protocol.md "Admin API") ----

export type PeerStatus = 'pending' | 'active' | 'revoked'

export type Overview = {
  rooms: number
  peers: { active: number; pending: number; revoked: number; online: number }
  mailbox: { bundles: number; bytes: number }
}

export type Peer = {
  id: string
  peerId: string
  room: string
  label: string | null
  status: PeerStatus
  online: boolean
  firstSeen: number
  lastSeen: number
  mailboxPendingBytes: number
}

export type Settings = {
  require_approval: boolean
  max_peers_per_room: number
  mailbox_ttl_days: number
  mailbox_quota_bytes: number
  audit_ttl_days: number
  turn_key_id?: string
  turn_api_token_set: boolean
}

export type AuditEntry = {
  id: number
  ts: number
  room: string | null
  peer: string | null
  event: string
  bytes: number | null
  detail: string | null
}

export type StoredLocale = { code: string; name: string; updatedAt: number }
export type LocaleData = {
  name: string
  admin: Record<string, string>
  plugin: Record<string, string>
}

export const overviewQuery = {
  queryKey: ['overview'],
  queryFn: () => api<Overview>('/api/admin/overview'),
  refetchInterval: 15_000,
}

export const peersQuery = {
  queryKey: ['peers'],
  queryFn: () => api<{ peers: Peer[] }>('/api/admin/peers').then((r) => r.peers),
  refetchInterval: 15_000,
}

export const localesQuery = {
  queryKey: ['i18n'],
  queryFn: () =>
    api<{ locales: StoredLocale[] }>('/api/i18n').then((r) => r.locales),
}

/** One line for the user describing a failed call. */
export function errorMessage(e: unknown, t: TFunction): string {
  if (!(e instanceof ApiError)) return t('error.unknown')
  // 502–504: a proxy in front of the relay could not reach it.
  if (e.status === 0 || (e.status >= 502 && e.status <= 504)) return t('error.network')
  if (e.status === 401) return t('error.session')
  if (e.status === 400) return t('error.badRequest')
  if (e.status === 404) return t('error.missing')
  return t('error.server', { status: e.status })
}
