import { createFileRoute } from '@tanstack/react-router'
import { SignIn } from '@/features/auth/sign-in'

export const Route = createFileRoute('/(auth)/sign-in')({
  validateSearch: (s: Record<string, unknown>): { redirect?: string } =>
    typeof s.redirect === 'string' ? { redirect: s.redirect } : {},
  component: SignIn,
})
