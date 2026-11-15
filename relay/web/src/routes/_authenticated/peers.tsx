import { createFileRoute } from '@tanstack/react-router'
import { type PeerStatus } from '@/lib/api'
import { Peers } from '@/features/peers'

const STATUSES = ['pending', 'active', 'revoked']

export const Route = createFileRoute('/_authenticated/peers')({
  validateSearch: (s: Record<string, unknown>): { status?: PeerStatus } =>
    typeof s.status === 'string' && STATUSES.includes(s.status) ? { status: s.status as PeerStatus } : {},
  component: Peers,
})
