import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const DEFAULT_CACHE_LIMIT = 2 * 1024 ** 3

export type KeptKind = 'song' | 'album' | 'artist' | 'playlist'

/** Something the listener keeps cached. Its songs are kept apart (kept.ts). */
export interface KeptItem {
  kind: KeptKind
  id: string
  name: string
  coverArt?: string
  addedAt: number
  /** When its songs were last read from the server. */
  checkedAt: number
  songCount: number
}

/**
 * A song's state on this device: "kept" (all of it), "downloading",
 * "queued", "waiting" (for a network the settings allow), "failed",
 * "cached" (played, all of it) or "none".
 */
export type SongCacheState =
  | 'kept'
  | 'downloading'
  | 'queued'
  | 'waiting'
  | 'failed'
  | 'cached'
  | 'none'

interface ISongCacheState {
  /** Cache the songs that play. */
  cachePlayed: boolean
  /** Size of the played-songs cache, in bytes; 0 for no limit. */
  limit: number
  /** Android: kept songs download on Wi-Fi only. */
  wifiOnly: boolean
  /** What the listener keeps, by keptId. */
  kept: Record<string, KeptItem>
  /** Each song's state, by song ID (not saved; read from the platform). */
  states: Record<string, SongCacheState>
  setCachePlayed: (value: boolean) => void
  setLimit: (bytes: number) => void
  setWifiOnly: (value: boolean) => void
  putKept: (item: KeptItem) => void
  removeKept: (keptId: string) => void
  clearKept: () => void
  setStates: (states: Record<string, SongCacheState>) => void
}

export const keptId = (kind: KeptKind, id: string) => `${kind}:${id}`

export const useSongCache = create<ISongCacheState>()(
  persist(
    (set) => ({
      cachePlayed: true,
      limit: DEFAULT_CACHE_LIMIT,
      wifiOnly: false,
      kept: {},
      states: {},
      setCachePlayed: (cachePlayed) => set({ cachePlayed }),
      setLimit: (limit) => set({ limit: Math.max(0, Math.round(limit)) }),
      setWifiOnly: (wifiOnly) => set({ wifiOnly }),
      putKept: (item) =>
        set((state) => ({
          kept: { ...state.kept, [keptId(item.kind, item.id)]: item },
        })),
      removeKept: (id) =>
        set((state) => {
          const kept = { ...state.kept }
          delete kept[id]
          return { kept }
        }),
      clearKept: () => set({ kept: {} }),
      setStates: (states) =>
        set((state) => ({ states: { ...state.states, ...states } })),
    }),
    {
      name: 'song-cache',
      partialize: ({ cachePlayed, limit, wifiOnly, kept }) => ({
        cachePlayed,
        limit,
        wifiOnly,
        kept,
      }),
    },
  ),
)
