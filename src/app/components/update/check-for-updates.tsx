import { useQueryClient } from '@tanstack/react-query'
import { Loader2, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'react-toastify'
import { useAppUpdate } from '@/store/app.store'
import { getAppInfo } from '@/utils/appName'
import { type AvailableUpdate, getUpdateSource } from '@/utils/appUpdate'
import { queryKeys } from '@/utils/queryKeys'

/**
 * Checks for a newer version now. A newer one opens the update dialog
 * (update-observer.tsx); otherwise this says the app is up to date.
 */
export function CheckForUpdates() {
  const queryClient = useQueryClient()
  const { setRemindOnNextBoot, setOpenDialog } = useAppUpdate()
  const [checking, setChecking] = useState(false)

  const check = async () => {
    setChecking(true)
    // Asked for: show it even after "Remind me later".
    setRemindOnNextBoot(false)
    try {
      const update = await queryClient.fetchQuery<AvailableUpdate | null>({
        queryKey: [queryKeys.update.check],
        queryFn: async () => (await getUpdateSource()?.check()) ?? null,
        staleTime: 0,
      })
      if (update) {
        setOpenDialog(true)
      } else {
        toast.info(`You're on the latest version (${getAppInfo().version}).`)
      }
    } catch {
      toast.error("Couldn't check for updates. Try again later.")
    } finally {
      setChecking(false)
    }
  }

  return (
    <button
      type="button"
      onClick={check}
      disabled={checking}
      className="flex items-center gap-1.5 px-2 py-0.5 rounded-md border border-border text-xs text-foreground hover:bg-accent disabled:opacity-60"
    >
      {checking ? (
        <Loader2 className="size-3 animate-spin" />
      ) : (
        <RefreshCw className="size-3" />
      )}
      Check for updates
    </button>
  )
}
