import { HardDrive } from 'lucide-react'
import { SimpleTooltip } from '@/app/components/ui/simple-tooltip'
import { KeptKind, keptId, useSongCache } from '@/store/song-cache.store'

/** "Kept" next to a kept album's, artist's or playlist's buttons. */
export function KeptBadge({ kind, id }: { kind: KeptKind; id: string }) {
  const kept = useSongCache((state) => !!state.kept[keptId(kind, id)])
  if (!kept) return null

  return (
    <SimpleTooltip text="Kept on this device. Remove it in its menu or in Settings.">
      <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
        <HardDrive className="h-3.5 w-3.5" />
        Kept
      </span>
    </SimpleTooltip>
  )
}

/** A small icon on a song kept on this device. */
export function KeptSongIcon({ songId }: { songId: string }) {
  const kept = useSongCache((state) => state.keptSongIds.has(songId))
  if (!kept) return null

  return (
    <SimpleTooltip text="Kept on this device">
      <HardDrive
        className="h-3 w-3 shrink-0 text-muted-foreground"
        aria-label="Kept on this device"
      />
    </SimpleTooltip>
  )
}
