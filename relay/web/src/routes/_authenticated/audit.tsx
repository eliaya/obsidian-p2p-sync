import { createFileRoute } from '@tanstack/react-router'
import { Audit } from '@/features/audit'

export const Route = createFileRoute('/_authenticated/audit')({
  validateSearch: (s: Record<string, unknown>): { event?: string; peer?: string } => ({
    ...(typeof s.event === 'string' && { event: s.event }),
    ...(typeof s.peer === 'string' && /^[0-9a-f]{64}$/.test(s.peer) && { peer: s.peer }),
  }),
  component: Audit,
})
