import { ActivityLink } from '@/app/components/activity/header-link'
import { NavigationButtons } from '@/app/components/header/navigation-buttons'
import { UserDropdown } from '@/app/components/header/user-dropdown'
import { WindowControlsSpacer } from '@/app/components/header/window-controls-spacer'
import { HeaderSongInfo } from '@/app/components/header-song'
import { SettingsButton } from '@/app/components/settings/header-button'
import { MainSidebarTrigger } from '@/app/components/ui/main-sidebar'
import { useAppWindow } from '@/app/hooks/use-app-window'
import { isLinux, isMacOS, isWindows } from '@/utils/desktop'

export function Header() {
  const { isFullscreen } = useAppWindow()

  return (
    <header className="w-full h-header fixed top-0 right-0 left-0 z-20 bg-background border-b electron-drag">
      {/* Desktop header layout */}
      <div className="hidden md:grid grid-cols-header h-full px-4">
        <div className="flex items-center">
          {isMacOS && !isFullscreen && <WindowControlsSpacer width={70} />}
          <NavigationButtons />
          <MainSidebarTrigger className="ml-2" />
        </div>
        <HeaderSongInfo />
        <div className="flex justify-end items-center gap-2">
          <ActivityLink />
          <SettingsButton />
          <UserDropdown />
          {isWindows && !isFullscreen && <WindowControlsSpacer width={122} />}
          {isLinux && !isFullscreen && <div className="w-[94px] shrink-0" />}
        </div>
      </div>

      {/* Mobile header layout */}
      <div className="flex md:hidden items-center gap-2 px-3 h-full">
        {/* Upright phones use the tab bar's Library panel instead. */}
        <MainSidebarTrigger className="tabbar:hidden" />
        <div className="flex-1 min-w-0">
          <HeaderSongInfo />
        </div>
        <ActivityLink />
        <SettingsButton />
        <UserDropdown />
      </div>
    </header>
  )
}
