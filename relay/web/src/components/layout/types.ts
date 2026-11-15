import { type LinkProps } from '@tanstack/react-router'

type NavLink = {
  /** Key in locales/admin/*.json */
  titleKey: string
  url: LinkProps['to']
  icon: React.ElementType
}

export type { NavLink }
