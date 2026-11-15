import { createFileRoute } from '@tanstack/react-router'
import { Language } from '@/features/language'

export const Route = createFileRoute('/_authenticated/language')({
  validateSearch: (s: Record<string, unknown>): { edit?: string } =>
    typeof s.edit === 'string' ? { edit: s.edit } : {},
  component: Language,
})
