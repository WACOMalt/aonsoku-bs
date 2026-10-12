import { useEffect } from 'react'
import { tagger } from '@/service/tagger'
import { useAppStore } from '@/store/app.store'
import { useJamStore } from '@/store/jam.store'
import { useTaggerStore } from '@/store/tagger.store'

// The plugin may connect (or go away) while the app runs.
const RECHECK_MS = 5 * 60 * 1000

/** Finds out whether the tag editor is available to this user. */
export function TaggerObserver() {
  const username = useAppStore((state) => state.data.username)
  const syncServerUrl = useJamStore((state) => state.syncServerUrl)

  // biome-ignore lint/correctness/useExhaustiveDependencies: checked again for another user or server
  useEffect(() => {
    let cancelled = false
    const check = async () => {
      const capabilities = await tagger.capabilities()
      // Only asked when there is an editor to show.
      const isAdmin = capabilities.features.write
        ? await tagger.isAdmin()
        : false
      if (!cancelled) {
        useTaggerStore.getState().actions.setAccess(capabilities, isAdmin)
      }
    }
    check()
    const timer = setInterval(check, RECHECK_MS)
    window.addEventListener('focus', check)
    return () => {
      cancelled = true
      clearInterval(timer)
      window.removeEventListener('focus', check)
    }
  }, [username, syncServerUrl])

  return null
}
