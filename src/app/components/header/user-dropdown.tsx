import { Info, Keyboard, LogOut, User, Users } from 'lucide-react'
import { useState } from 'react'
import { Fragment } from 'react/jsx-runtime'
import { useHotkeys } from 'react-hotkeys-hook'
import { useTranslation } from 'react-i18next'

import { AboutDialog } from '@/app/components/about/dialog'
import { ShortcutsDialog } from '@/app/components/shortcuts/dialog'
import { Avatar, AvatarFallback } from '@/app/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/app/components/ui/dropdown-menu'
import { LogoutObserver } from '@/app/observers/logout-observer'
import { logoutKeys, shortcutDialogKeys, stringifyShortcut } from '@/shortcuts'
import { useAppData, useAppStore } from '@/store/app.store'
import { useFriendInviteCount, useFriendsStore } from '@/store/friends.store'
import { isMacOS } from '@/utils/desktop'

export function UserDropdown() {
  const { username, url, lockUser } = useAppData()
  const setLogoutDialogState = useAppStore(
    (state) => state.actions.setLogoutDialogState,
  )
  const { t } = useTranslation()
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const inviteCount = useFriendInviteCount()
  const openFriends = useFriendsStore((state) => state.actions.setPanelOpen)

  useHotkeys('shift+ctrl+q', () => setLogoutDialogState(true))
  useHotkeys('mod+/', () => setShortcutsOpen((prev) => !prev))

  const alignPosition = isMacOS ? 'end' : 'center'

  return (
    <Fragment>
      <LogoutObserver />

      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />

      <DropdownMenu>
        <DropdownMenuTrigger
          className="user-dropdown-trigger relative"
          aria-label={
            inviteCount > 0
              ? `Account, ${inviteCount} friend invite${inviteCount === 1 ? '' : 's'}`
              : 'Account'
          }
        >
          <Avatar className="w-8 h-8 rounded-full cursor-pointer">
            <AvatarFallback className="text-sm bg-transparent hover:bg-accent">
              <User className="w-4 h-4" />
            </AvatarFallback>
          </Avatar>
          {inviteCount > 0 && <InviteBadge count={inviteCount} corner />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align={alignPosition} className="min-w-64">
          <DropdownMenuLabel className="font-normal">
            <div className="flex flex-col space-y-2">
              <p className="text-sm font-medium leading-none">{username}</p>
              <p className="text-xs leading-none text-muted-foreground">
                {url}
              </p>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => openFriends(true)}>
            <Users className="mr-2 h-4 w-4" />
            <span>Friends</span>
            {inviteCount > 0 && <InviteBadge count={inviteCount} />}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setShortcutsOpen(true)}>
            <Keyboard className="mr-2 h-4 w-4" />
            <span>{t('shortcuts.modal.title')}</span>
            <DropdownMenuShortcut>
              {stringifyShortcut(shortcutDialogKeys)}
            </DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setAboutOpen(true)}>
            <Info className="mr-2 h-4 w-4" />
            <span>{t('menu.about')}</span>
          </DropdownMenuItem>
          {!lockUser && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setLogoutDialogState(true)}>
                <LogOut className="mr-2 h-4 w-4" />
                <span>{t('menu.serverLogout')}</span>
                <DropdownMenuShortcut>
                  {stringifyShortcut(logoutKeys)}
                </DropdownMenuShortcut>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </Fragment>
  )
}

/** The number of friend invites waiting, as a small badge. */
function InviteBadge({ count, corner }: { count: number; corner?: boolean }) {
  return (
    <span
      className={
        corner
          ? 'absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-semibold leading-4 text-center pointer-events-none'
          : 'ml-auto min-w-5 h-5 px-1.5 rounded-full bg-primary text-primary-foreground text-xs font-semibold leading-5 text-center'
      }
    >
      {count > 9 ? '9+' : count}
    </span>
  )
}
