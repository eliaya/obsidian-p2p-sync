import { createFileRoute, redirect } from '@tanstack/react-router'
import { ApiError, overviewQuery, queryClient } from '@/lib/api'
import { AuthenticatedLayout } from '@/components/layout/authenticated-layout'

export const Route = createFileRoute('/_authenticated')({
  // The session cookie is HttpOnly, so ask the relay. Other errors fall through to the page's own error state.
  beforeLoad: async ({ location }) => {
    try {
      await queryClient.ensureQueryData(overviewQuery)
    } catch (e) {
      if (e instanceof ApiError && e.status === 401)
        throw redirect({ to: '/sign-in', search: { redirect: location.href } })
    }
  },
  component: AuthenticatedLayout,
})
