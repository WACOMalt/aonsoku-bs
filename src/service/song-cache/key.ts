import { getSongStreamUrl } from '@/api/httpClient'
import { ISong } from '@/types/responses/song'
import { ensureSupportForAlac } from '@/utils/alac'

/**
 * Where a song is kept: its ID, size and format. When the file changes on
 * the server (a better copy, new tags), its size changes, so the old copy
 * is no longer used and a new one is cached. Same as MediaCache.keyFor
 * (Android).
 */
export function songCacheKey(song: Pick<ISong, 'id' | 'size' | 'suffix'>) {
  return `${song.id}.${song.size ?? 0}.${ensureSupportForAlac(song.suffix) ?? ''}`
}

/** The address a song streams from, the same the player uses. */
export function streamUrlFor(song: ISong, cacheBust?: string) {
  return getSongStreamUrl(
    song.id,
    undefined,
    ensureSupportForAlac(song.suffix),
    cacheBust,
  )
}
