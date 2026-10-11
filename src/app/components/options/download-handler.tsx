import { ReactNode } from 'react'
import { ContextMenuSeparator } from '@/app/components/ui/context-menu'
import {
  DropdownMenuGroup,
  DropdownMenuSeparator,
} from '@/app/components/ui/dropdown-menu'
import { getNativePlatform } from '@/utils/platform'

interface DownloadHandlerProps {
  children: ReactNode
  context?: boolean
  group?: boolean
}

export function DownloadOptionHandler({
  children,
  context = false,
  group = true,
}: DownloadHandlerProps) {
  const { DISABLE_DOWNLOADS } = window

  // The iOS app's web view can't save files.
  if (DISABLE_DOWNLOADS || getNativePlatform() === 'ios') {
    return null
  }

  if (context) {
    return (
      <>
        <ContextMenuSeparator />
        {children}
      </>
    )
  }

  return (
    <>
      <DropdownMenuSeparator />
      {group ? <DropdownMenuGroup>{children}</DropdownMenuGroup> : children}
    </>
  )
}
