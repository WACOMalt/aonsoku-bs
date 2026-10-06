import { registerPlugin } from '@capacitor/core'
import { getSongStreamUrl } from '@/api/httpClient'
import { SongCacheState } from '@/store/song-cache.store'
import { ISong } from '@/types/responses/song'
import { ensureSupportForAlac } from '@/utils/alac'
import { getNativePlatform } from '@/utils/platform'

export interface SongCacheSettings {
  cachePlayed: boolean
  /** Bytes; 0 for no limit. */
  limit: number
  wifiOnly: boolean
}

export interface SongCacheUsage {
  /** Bytes used by played songs. */
  played: number
  /** Bytes used by kept songs. */
  kept: number
  /** Kept songs on the device. */
  keptSongs: number
  /** Kept songs still to download. */
  keptPending: number
  /** Free space on the device, when known. */
  free?: number
}

/** Where a platform keeps songs (Android, desktop, web). */
export interface SongCacheBackend {
  configure(settings: SongCacheSettings): Promise<void>
  /** Makes the kept songs exactly these: downloads the missing, removes the rest. */
  syncKept(songs: ISong[]): Promise<void>
  usage(): Promise<SongCacheUsage>
  /** Each song's state, by song ID. */
  status(songs: ISong[]): Promise<Record<string, SongCacheState>>
  clearPlayed(): Promise<void>
  clearKept(): Promise<void>
  /** Calls back when kept songs change (a download ends, fails). */
  onChange(listener: () => void): () => void
}

/** The address a song streams from, the same the player uses. */
export function streamUrlFor(song: ISong) {
  return getSongStreamUrl(song.id, undefined, ensureSupportForAlac(song.suffix))
}

/** The fields that make a song's key (see songCacheKey), and its title. */
function slim(song: ISong) {
  return { id: song.id, size: song.size, suffix: song.suffix }
}

interface SongCachePlugin {
  configure(options: SongCacheSettings): Promise<void>
  syncKept(options: {
    songs: { song: ReturnType<typeof slim>; url: string; title: string }[]
  }): Promise<void>
  usage(): Promise<SongCacheUsage>
  status(options: {
    songs: ReturnType<typeof slim>[]
  }): Promise<{ states: Record<string, SongCacheState> }>
  clearPlayed(): Promise<void>
  clearKept(): Promise<void>
  saveFile(options: { url: string; fileName: string }): Promise<void>
  addListener(
    event: 'keptChanged',
    listener: () => void,
  ): Promise<{ remove: () => Promise<void> }>
}

let androidPlugin: SongCachePlugin | undefined
const android = () => {
  androidPlugin ??= registerPlugin<SongCachePlugin>('SongCache')
  return androidPlugin
}

/** Android: saves a file to Downloads/Aonsoku ("Save file"). */
export function saveFileOnAndroid(url: string, fileName: string) {
  return android().saveFile({ url, fileName })
}

/** Android: the native player's cache (MediaCache.java). */
function androidBackend(): SongCacheBackend {
  const plugin = android()
  return {
    configure: (settings) => plugin.configure(settings),
    syncKept: (songs) =>
      plugin.syncKept({
        songs: songs.map((song) => ({
          song: slim(song),
          url: streamUrlFor(song),
          title: [song.artist, song.title].filter(Boolean).join(' – '),
        })),
      }),
    usage: () => plugin.usage(),
    status: async (songs) =>
      (await plugin.status({ songs: songs.map(slim) })).states,
    clearPlayed: () => plugin.clearPlayed(),
    clearKept: () => plugin.clearKept(),
    onChange: (listener) => {
      const handle = plugin.addListener('keptChanged', listener)
      return () => {
        handle.then((h) => h.remove())
      }
    },
  }
}

let backend: SongCacheBackend | null | undefined

/** This platform's song cache, or null where there is none. */
export function getSongCacheBackend(): SongCacheBackend | null {
  if (backend !== undefined) return backend
  if (getNativePlatform() === 'android') backend = androidBackend()
  else backend = null
  return backend
}
