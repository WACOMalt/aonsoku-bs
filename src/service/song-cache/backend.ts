import { registerPlugin } from '@capacitor/core'
import { SongCacheState } from '@/store/song-cache.store'
import { ISong } from '@/types/responses/song'
import { isDesktop } from '@/utils/desktop'
import { getNativePlatform } from '@/utils/platform'
import { songCacheKey, streamUrlFor } from './key'
import {
  setWebPlaybackLoading,
  songUrl,
  webBackend,
  webCacheReady,
} from './web'

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

export { streamUrlFor } from './key'

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

/** Desktop: files in the app's data folder (electron/main/core/songCache.ts). */
function desktopBackend(): SongCacheBackend {
  const call = <T>(method: string, args?: unknown) =>
    window.api.songCache(method, args) as Promise<T>
  return {
    configure: ({ cachePlayed, limit }) =>
      call('configure', { cachePlayed, limit }),
    syncKept: (songs) =>
      call(
        'syncKept',
        songs.map((song) => ({
          key: songCacheKey(song),
          url: streamUrlFor(song),
          title: [song.artist, song.title].filter(Boolean).join(' – '),
        })),
      ),
    usage: () => call('usage'),
    status: async (songs) => {
      const byKey = await call<Record<string, SongCacheState>>(
        'status',
        songs.map(songCacheKey),
      )
      return Object.fromEntries(
        songs.map((song) => [song.id, byKey[songCacheKey(song)] ?? 'none']),
      )
    },
    clearPlayed: () => call('clearPlayed'),
    clearKept: () => call('clearKept'),
    onChange: (listener) => window.api.onSongCacheChange(listener),
  }
}

let backend: SongCacheBackend | null | undefined

/** This platform's song cache, or null where there is none. */
export function getSongCacheBackend(): SongCacheBackend | null {
  if (backend) return backend
  if (getNativePlatform() === 'android') backend = androidBackend()
  else if (isDesktop()) backend = desktopBackend()
  // The web app's, once its service worker controls the page (not on the
  // very first visit, and not in development).
  else if (webCacheReady()) backend = webBackend()
  return backend ?? null
}

/**
 * Where the player reads a song from: through this platform's cache, which
 * serves it from the device when it's there. Android's player has its own
 * (MediaCache.java), so it gets the server's address.
 */
export function playableUrl(song: ISong, cacheBust?: string) {
  const src = streamUrlFor(song, cacheBust)
  const key = encodeURIComponent(songCacheKey(song))
  if (isDesktop()) {
    return `aonsoku-song://song/${key}?src=${encodeURIComponent(src)}`
  }
  if (getNativePlatform() === null && webCacheReady()) {
    return `${songUrl(songCacheKey(song))}?src=${encodeURIComponent(src)}`
  }
  return src
}

/** Tells the cache a song from the server is still loading (kept downloads wait). */
export function setPlaybackLoading(loading: boolean) {
  if (isDesktop()) window.api.songCache('setPlaybackLoading', loading)
  else setWebPlaybackLoading(loading)
}

const warmed = new Set<string>()

/**
 * Downloads a whole song through the cache, so it's kept as a played song,
 * when the player won't (the gapless player downloads the songs it plays).
 */
export function cacheInBackground(song: ISong) {
  if (!isDesktop() && !(getNativePlatform() === null && webCacheReady())) return
  const key = songCacheKey(song)
  if (warmed.has(key)) return
  warmed.add(key)
  fetch(playableUrl(song))
    .then(async (response) => {
      // Read to the end without holding it: the cache keeps it.
      const reader = response.body?.getReader()
      while (reader && !(await reader.read()).done) {}
    })
    .catch(() => warmed.delete(key))
}
