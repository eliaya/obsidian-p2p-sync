import { createRootRoute, Outlet } from '@tanstack/react-router'
import { Toaster } from '@/components/ui/sonner'
import { GeneralError } from '@/features/errors/general-error'
import { NotFoundError } from '@/features/errors/not-found-error'

export const Route = createRootRoute({
  component: () => (
    <>
      <Outlet />
      <Toaster position='top-center' richColors closeButton />
    </>
  ),
  notFoundComponent: NotFoundError,
  errorComponent: GeneralError,
})
