import { OptionsButtons } from '@/app/components/options/buttons'
import { getSongCacheBackend } from '@/service/song-cache/backend'
import { keep, keepSongs, release } from '@/service/song-cache/kept'
import { KeptKind, keptId, useSongCache } from '@/store/song-cache.store'
import { ISong } from '@/types/responses/song'

interface KeepCachedOptionProps {
  kind: KeptKind
  id: string
  /** The song itself, for a song: no need to ask the server for it. */
  song?: ISong
  variant?: 'dropdown' | 'context'
}

/** "Keep cached" / "Remove from cache" in an item's menu. */
export function KeepCachedOption({
  kind,
  id,
  song,
  variant = 'dropdown',
}: KeepCachedOptionProps) {
  const kept = useSongCache((state) => !!state.kept[keptId(kind, id)])
  if (!getSongCacheBackend()) return null

  return (
    <OptionsButtons.KeepCached
      variant={variant}
      kept={kept}
      onClick={(e) => {
        e.stopPropagation()
        if (kept) release(kind, id)
        else if (song) keepSongs([song])
        else keep(kind, id)
      }}
    />
  )
}
