import { memo } from 'react'
import CommandMenu from '@/app/components/command/command-menu'
import { MainDrawerPage } from '@/app/components/drawer/page'
import { FriendsDialog } from '@/app/components/friends/friends-dialog'
import { FullscreenMode } from '@/app/components/fullscreen/page'
import { MobileBottomNav } from '@/app/components/mobile/bottom-nav'
import { JamEndPrompt } from '@/app/components/player/jam-end-prompt'
import { JamJoinPrompt } from '@/app/components/player/jam-join-prompt'
import { OnlineChoicePrompt } from '@/app/components/player/online-choice-prompt'
import { Player } from '@/app/components/player/player'
import { CreatePlaylistDialog } from '@/app/components/playlist/form-dialog'
import { RemovePlaylistDialog } from '@/app/components/playlist/remove-dialog'
import { AppSidebar } from '@/app/components/sidebar/app-sidebar'
import { SongInfoDialog } from '@/app/components/song/info-dialog'
import {
  MainSidebarInset,
  MainSidebarProvider,
} from '@/app/components/ui/main-sidebar'
import { useConnect } from '@/app/hooks/use-connect'
import { useJamRejoin } from '@/app/hooks/use-jam-rejoin'
import { useSharedLinkOpener } from '@/app/hooks/use-shared-link'
import { Header } from '@/app/layout/header'
import { MainRoutes } from './main'

const MemoHeader = memo(Header)
const MemoPlayer = memo(Player)
const MemoSongInfoDialog = memo(SongInfoDialog)
const MemoRemovePlaylistDialog = memo(RemovePlaylistDialog)
const MemoMainDrawerPage = memo(MainDrawerPage)
const MemoFullscreenMode = memo(FullscreenMode)
const MemoMobileBottomNav = memo(MobileBottomNav)

export default function BaseLayout() {
  useConnect()
  useJamRejoin()
  useSharedLinkOpener()

  return (
    <div className="h-screen w-screen overflow-hidden">
      <MainSidebarProvider>
        <MemoHeader />
        <AppSidebar />
        <MainSidebarInset>
          <MainRoutes />
        </MainSidebarInset>
        <MemoPlayer />
        <MemoMobileBottomNav />
      </MainSidebarProvider>
      <MemoSongInfoDialog />
      <MemoRemovePlaylistDialog />
      <MemoMainDrawerPage />
      <CreatePlaylistDialog />
      <MemoFullscreenMode />
      <JamJoinPrompt />
      <JamEndPrompt />
      <OnlineChoicePrompt />
      <FriendsDialog />
      {/* Search: one dialog, opened from the sidebar, tab bar or shortcut. */}
      <CommandMenu />
    </div>
  )
}
