import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { LogOut } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { api, queryClient } from '@/lib/api'
import { useLayout } from '@/context/layout-provider'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { AppTitle } from './app-title'
import { navItems } from './data/sidebar-data'
import { NavGroup } from './nav-group'

export function AppSidebar() {
  const { collapsible, variant } = useLayout()
  return (
    <Sidebar collapsible={collapsible} variant={variant}>
      <SidebarHeader>
        <AppTitle />
      </SidebarHeader>
      <SidebarContent>
        <NavGroup items={navItems} />
      </SidebarContent>
      <SidebarFooter>
        <SignOut />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

function SignOut() {
  const { t } = useTranslation()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const logout = useMutation({
    mutationFn: () => api('/api/admin/logout', { method: 'POST', body: {} }),
    onSuccess: () => {
      queryClient.clear()
      void router.navigate({ to: '/sign-in' })
    },
  })
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton tooltip={t('logout.button')} onClick={() => setOpen(true)}>
          <LogOut />
          <span>{t('logout.button')}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t('logout.title')}
        desc={t('logout.description')}
        confirmText={t('logout.confirm')}
        isLoading={logout.isPending}
        handleConfirm={() => logout.mutate()}
      />
    </SidebarMenu>
  )
}
