import { StrictMode } from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { toast } from 'sonner'
import { ThemeProvider } from './context/theme-provider'
import i18n from './i18n'
import { loadServerLanguages } from './i18n/server'
import { errorMessage, onMutationError, onUnauthorized, queryClient } from './lib/api'
// Generated Routes
import { routeTree } from './routeTree.gen'
// Styles
import './styles/index.css'

const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
})

// Any admin call answering 401 (expired, or logged out in another tab): back to sign-in, then here.
onUnauthorized.current = () => {
  const { pathname, href } = router.state.location
  if (pathname === '/sign-in') return
  queryClient.clear()
  void router.navigate({ to: '/sign-in', search: { redirect: href } })
}
onMutationError.current = (e) => toast.error(errorMessage(e, i18n.t))

void loadServerLanguages()

// Register the router instance for type safety
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <RouterProvider router={router} />
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>
)
