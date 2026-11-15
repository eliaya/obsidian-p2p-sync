import {
  Languages,
  LayoutDashboard,
  ScrollText,
  Settings,
  Users,
} from 'lucide-react'
import { type NavLink } from '../types'

export const navItems: NavLink[] = [
  { titleKey: 'nav.overview', url: '/', icon: LayoutDashboard },
  { titleKey: 'nav.peers', url: '/peers', icon: Users },
  { titleKey: 'nav.settings', url: '/settings', icon: Settings },
  { titleKey: 'nav.language', url: '/language', icon: Languages },
  { titleKey: 'nav.audit', url: '/audit', icon: ScrollText },
]
