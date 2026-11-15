import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { Logo } from '@/assets/logo'

export function AppTitle() {
  const { t } = useTranslation()
  const { setOpenMobile } = useSidebar()
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton size='lg' asChild>
          <Link to='/' onClick={() => setOpenMobile(false)}>
            <Logo className='size-6 shrink-0' />
            <div className='grid flex-1 text-start text-sm leading-tight'>
              <span className='truncate font-bold'>{t('app.name')}</span>
              <span className='truncate text-xs'>{t('app.subtitle')}</span>
            </div>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
