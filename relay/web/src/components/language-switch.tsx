import { Check, Languages } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { getLanguages, setLanguage } from '@/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export function LanguageSwitch() {
  const { t, i18n } = useTranslation()
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant='ghost' size='icon' className='scale-95 rounded-full'>
          <Languages className='size-[1.2rem]' />
          <span className='sr-only'>{t('language.switch')}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end'>
        {getLanguages().map(({ code, name }) => (
          <DropdownMenuItem key={code} onClick={() => setLanguage(code)}>
            {name}
            <Check
              size={14}
              className={cn('ms-auto', i18n.language !== code && 'hidden')}
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
