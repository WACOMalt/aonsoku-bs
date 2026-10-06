import { SongCacheState } from '@/store/song-cache.store'
import { ISong } from '@/types/responses/song'
import type { SongCacheBackend, SongCacheSettings } from './backend'
import { songCacheKey, streamUrlFor } from './key'

/**
 * The web app's song cache, the page's side: settings, kept songs, usage
 * and states. The service worker (public/song-cache-sw.js) answers the
 * player from the same storage. Both use the names below.
 */

const KEPT = 'aonsoku-songs-kept'
const PLAYED = 'aonsoku-songs-played'
const META = 'aonsoku-songs-meta'
// Kept songs download this many at a time, to spare the server.
const PARALLEL_DOWNLOADS = 2
const RETRY_MS = 5 * 60 * 1000

type Meta = {
  key: string
  store: 'played' | 'kept'
  size: number
  lastUsed: number
}
type Wanted = { key: string; url: string }

const appUrl = (path: string) => new URL(path, document.baseURI).href
export const songUrl = (key: string) =>
  appUrl(`__song/${encodeURIComponent(key)}`)
const metaUrl = (key: string) =>
  appUrl(`__song-meta/${encodeURIComponent(key)}`)

/** The service worker controls this page, so it can answer the player. */
export function webCacheReady() {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.serviceWorker?.controller &&
    typeof caches !== 'undefined'
  )
}

async function readMeta() {
  const meta = await caches.open(META)
  const entries: Meta[] = []
  for (const request of await meta.keys()) {
    if (!request.url.includes('/__song-meta/')) continue
    const response = await meta.match(request)
    if (response) entries.push(await response.json())
  }
  return entries
}

async function writeMeta(entry: Meta) {
  const meta = await caches.open(META)
  await meta.put(metaUrl(entry.key), new Response(JSON.stringify(entry)))
}

async function removeSong(entry: Meta) {
  await (await caches.open(entry.store === 'kept' ? KEPT : PLAYED)).delete(
    songUrl(entry.key),
  )
  await (await caches.open(META)).delete(metaUrl(entry.key))
}

let settings: SongCacheSettings = {
  cachePlayed: true,
  limit: 2 * 1024 ** 3,
  wifiOnly: false,
}
let wanted = new Map<string, Wanted>()
const active = new Map<string, AbortController>()
const failed = new Map<string, number>()
let keptKeys = new Set<string>()
let playbackLoading = false
const listeners = new Set<() => void>()

function changed() {
  for (const listener of listeners) listener()
}

async function shrinkPlayed() {
  if (settings.limit <= 0) return
  const played = (await readMeta())
    .filter((entry) => entry.store === 'played')
    .sort((a, b) => a.lastUsed - b.lastUsed)
  let total = played.reduce((sum, entry) => sum + entry.size, 0)
  for (const entry of played) {
    if (total <= settings.limit) break
    await removeSong(entry)
    total -= entry.size
  }
}

/** Starts downloads while there is room, unless a song is loading. */
function pump() {
  if (playbackLoading) return
  for (const song of wanted.values()) {
    if (active.size >= PARALLEL_DOWNLOADS) return
    if (keptKeys.has(song.key) || active.has(song.key)) continue
    const failedAt = failed.get(song.key)
    if (failedAt && Date.now() - failedAt < RETRY_MS) continue
    download(song)
  }
}

async function download(song: Wanted) {
  const abort = new AbortController()
  active.set(song.key, abort)
  changed()
  try {
    const kept = await caches.open(KEPT)
    const played = await caches.open(PLAYED)
    // Already here as a played song: moved, not downloaded again.
    let response = await played.match(songUrl(song.key))
    const fromPlayed = !!response
    if (!response) {
      response = await fetch(song.url, { mode: 'cors', signal: abort.signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
    }
    const blob = await response.blob()
    const expected = Number(response.headers.get('content-length')) || 0
    if (expected && blob.size !== expected && !song.key.endsWith('.opus')) {
      throw new Error('Incomplete')
    }
    if (!wanted.has(song.key)) return
    await kept.put(songUrl(song.key), new Response(blob))
    if (fromPlayed) await played.delete(songUrl(song.key))
    await writeMeta({
      key: song.key,
      store: 'kept',
      size: blob.size,
      lastUsed: Date.now(),
    })
    keptKeys.add(song.key)
    failed.delete(song.key)
  } catch (error) {
    if (!abort.signal.aborted) {
      failed.set(song.key, Date.now())
      console.warn('[SongCache] Could not download', song.key, error)
    }
  } finally {
    active.delete(song.key)
    changed()
    pump()
  }
}

async function loadKept() {
  keptKeys = new Set(
    (await readMeta())
      .filter((entry) => entry.store === 'kept')
      .map((entry) => entry.key),
  )
}

export function setWebPlaybackLoading(loading: boolean) {
  playbackLoading = loading
  pump()
}

export function webBackend(): SongCacheBackend {
  return {
    configure: async (next) => {
      settings = next
      const meta = await caches.open(META)
      await meta.put(
        appUrl('__song-settings'),
        new Response(
          JSON.stringify({ cachePlayed: next.cachePlayed, limit: next.limit }),
        ),
      )
      await shrinkPlayed()
    },
    syncKept: async (songs: ISong[]) => {
      await loadKept()
      wanted = new Map(
        songs.map((song) => {
          const key = songCacheKey(song)
          return [key, { key, url: streamUrlFor(song) }]
        }),
      )
      if (songs.length > 0) navigator.storage?.persist?.().catch(() => {})
      for (const entry of await readMeta()) {
        if (entry.store === 'kept' && !wanted.has(entry.key)) {
          await removeSong(entry)
          keptKeys.delete(entry.key)
        }
      }
      for (const [key, abort] of active) {
        if (!wanted.has(key)) abort.abort()
      }
      changed()
      pump()
    },
    usage: async () => {
      let played = 0
      let kept = 0
      let keptSongs = 0
      for (const entry of await readMeta()) {
        if (entry.store === 'kept') {
          kept += entry.size
          keptSongs++
        } else {
          played += entry.size
        }
      }
      let keptPending = 0
      for (const key of wanted.keys()) if (!keptKeys.has(key)) keptPending++
      const estimate = await navigator.storage?.estimate?.().catch(() => null)
      const free =
        estimate?.quota !== undefined && estimate.usage !== undefined
          ? estimate.quota - estimate.usage
          : undefined
      return { played, kept, keptSongs, keptPending, free }
    },
    status: async (songs) => {
      const meta = new Map(
        (await readMeta()).map((entry) => [entry.key, entry]),
      )
      const states: Record<string, SongCacheState> = {}
      for (const song of songs) {
        const key = songCacheKey(song)
        const entry = meta.get(key)
        let state: SongCacheState = 'none'
        if (entry?.store === 'kept') state = 'kept'
        else if (active.has(key)) state = 'downloading'
        else if (wanted.has(key)) state = failed.has(key) ? 'failed' : 'queued'
        else if (entry?.store === 'played') state = 'cached'
        states[song.id] = state
      }
      return states
    },
    clearPlayed: async () => {
      for (const entry of await readMeta()) {
        if (entry.store === 'played') await removeSong(entry)
      }
    },
    clearKept: async () => {
      wanted = new Map()
      for (const abort of active.values()) abort.abort()
      for (const entry of await readMeta()) {
        if (entry.store === 'kept') await removeSong(entry)
      }
      keptKeys = new Set()
      changed()
    },
    onChange: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
