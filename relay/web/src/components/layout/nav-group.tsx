import { useQuery } from '@tanstack/react-query'
import { Link, useLocation } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { overviewQuery } from '@/lib/api'
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { type NavLink } from './types'

export function NavGroup({ items }: { items: NavLink[] }) {
  const { t } = useTranslation()
  const { setOpenMobile } = useSidebar()
  const pathname = useLocation({ select: (l) => l.pathname })
  const pending = useQuery(overviewQuery).data?.peers.pending ?? 0
  return (
    <SidebarGroup>
      <SidebarMenu>
        {items.map((item) => (
          <SidebarMenuItem key={item.url}>
            <SidebarMenuButton
              asChild
              isActive={pathname === item.url}
              tooltip={t(item.titleKey)}
            >
              <Link to={item.url} onClick={() => setOpenMobile(false)}>
                <item.icon />
                <span>{t(item.titleKey)}</span>
              </Link>
            </SidebarMenuButton>
            {item.url === '/peers' && pending > 0 && (
              <SidebarMenuBadge className='bg-amber-500 text-amber-950 peer-hover/menu-button:text-amber-950 peer-data-[active=true]/menu-button:text-amber-950'>
                <span aria-hidden>{pending}</span>
                <span className='sr-only'>{t('nav.pendingBadge', { count: pending })}</span>
              </SidebarMenuBadge>
            )}
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  )
}
