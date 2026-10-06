import { useEffect } from 'react'
import { getSongCacheBackend } from '@/service/song-cache/backend'
import { refreshKept, syncNow } from '@/service/song-cache/kept'
import { useAppStore } from '@/store/app.store'
import { useSongCache } from '@/store/song-cache.store'
import { logger } from '@/utils/logger'

// While the app runs, kept items are read from the server again this often
// (each one only when it's due, see refreshKept).
const CHECK_EVERY_MS = 60 * 60 * 1000

/**
 * Starts the song cache: hands the platform the settings (again on each
 * change), the songs to keep, and checks the kept items against the server.
 */
export function SongCacheObserver() {
  const signedIn = useAppStore((state) => state.data.isServerConfigured)

  useEffect(() => {
    const backend = getSongCacheBackend()
    if (!backend) return
    const apply = () => {
      const { cachePlayed, limit, wifiOnly } = useSongCache.getState()
      backend
        .configure({ cachePlayed, limit, wifiOnly })
        .catch((error) =>
          logger.error('[SongCache] Could not apply settings', error),
        )
    }
    apply()
    return useSongCache.subscribe((state, before) => {
      if (
        state.cachePlayed !== before.cachePlayed ||
        state.limit !== before.limit ||
        state.wifiOnly !== before.wifiOnly
      ) {
        apply()
      }
    })
  }, [])

  useEffect(() => {
    if (!signedIn || !getSongCacheBackend()) return
    syncNow().then(() => refreshKept())
    const timer = setInterval(() => refreshKept(), CHECK_EVERY_MS)
    return () => clearInterval(timer)
  }, [signedIn])

  return null
}
