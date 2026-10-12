import {
  ChevronRight,
  CircleUserRound,
  EarthLock,
  FileText,
  Globe,
  Headphones,
  LaptopIcon,
  Paintbrush,
  PersonStanding,
} from 'lucide-react'
import { ComponentType } from 'react'
import { useTranslation } from 'react-i18next'
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/app/components/ui/sidebar'
import { useIsMobile } from '@/app/hooks/use-mobile'
import { useAppSettings } from '@/store/app.store'
import { isDesktop } from '@/utils/desktop'

export type SettingsOptions =
  | 'appearance'
  | 'language'
  | 'audio'
  | 'content'
  | 'accounts'
  | 'desktop'
  | 'privacy'
  | 'accessibility'

interface OptionsData {
  id: SettingsOptions
  icon: ComponentType
}

const accountsOption: OptionsData = { id: 'accounts', icon: CircleUserRound }
const desktopOption: OptionsData = { id: 'desktop', icon: LaptopIcon }

const options: OptionsData[] = [
  { id: 'appearance', icon: Paintbrush },
  { id: 'language', icon: Globe },
  { id: 'audio', icon: Headphones },
  { id: 'content', icon: FileText },
  ...(isDesktop() ? [accountsOption, desktopOption] : []),
  { id: 'accessibility', icon: PersonStanding },
  { id: 'privacy', icon: EarthLock },
]

interface SettingsOptionsProps {
  onCategorySelect?: () => void
}

export function SettingsOptions({ onCategorySelect }: SettingsOptionsProps) {
  const { t } = useTranslation()
  const { currentPage, setCurrentPage } = useAppSettings()
  const isMobile = useIsMobile()

  const handleClick = (id: SettingsOptions) => {
    setCurrentPage(id)
    onCategorySelect?.()
  }

  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          {options.map((item) => (
            <SidebarMenuItem key={item.id}>
              <SidebarMenuButton
                isActive={item.id === currentPage}
                onClick={() => handleClick(item.id)}
              >
                <item.icon />
                <span className="flex-1">
                  {t(`settings.options.${item.id}`)}
                </span>
                {isMobile && (
                  <ChevronRight className="ml-auto size-4 text-muted-foreground" />
                )}
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
