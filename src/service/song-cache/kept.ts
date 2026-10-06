import { del, get, set } from 'idb-keyval'
import { toast } from 'react-toastify'
import { subsonic } from '@/service/subsonic'
import {
  KeptItem,
  KeptKind,
  keptId,
  SongCacheState,
  useSongCache,
} from '@/store/song-cache.store'
import { ISong } from '@/types/responses/song'
import { logger } from '@/utils/logger'
import { getSongCacheBackend } from './backend'
import { songCacheKey } from './key'

/**
 * "Keep cached": the albums, artists, playlists and songs the listener keeps
 * on this device. Each one's songs are read from the server, and the
 * platform (backend.ts) is told the whole list of songs to keep. The lists
 * follow the server: they are read again every few hours, and when the
 * listener opens one.
 */

// Read a kept item's songs from the server again after this long.
const RECHECK_MS = 6 * 60 * 60 * 1000
// Albums read at a time for a kept artist, to spare the server.
const ALBUMS_AT_ONCE = 3

const songsKey = (id: string) => `kept-songs:${id}`

/** A kept item's songs, as last read from the server. */
export async function keptSongs(id: string): Promise<ISong[]> {
  return (await get<ISong[]>(songsKey(id))) ?? []
}

async function albumSongs(id: string) {
  return (await subsonic.albums.getOne(id))?.song ?? []
}

/** An item's name, cover and songs, from the server. */
async function readFromServer(
  kind: KeptKind,
  id: string,
): Promise<{ name: string; coverArt?: string; songs: ISong[] } | null> {
  switch (kind) {
    case 'song': {
      const song = await subsonic.songs.getSong(id)
      return song
        ? { name: song.title, coverArt: song.coverArt, songs: [song] }
        : null
    }
    case 'album': {
      const album = await subsonic.albums.getOne(id)
      return album
        ? {
            name: album.name,
            coverArt: album.coverArt,
            songs: album.song ?? [],
          }
        : null
    }
    case 'playlist': {
      const playlist = await subsonic.playlists.getOne(id)
      return playlist
        ? {
            name: playlist.name,
            coverArt: playlist.coverArt,
            songs: playlist.entry ?? [],
          }
        : null
    }
    case 'artist': {
      const artist = await subsonic.artists.getOne(id)
      if (!artist) return null
      const albums = artist.album ?? []
      const songs: ISong[] = []
      for (let i = 0; i < albums.length; i += ALBUMS_AT_ONCE) {
        const batch = albums.slice(i, i + ALBUMS_AT_ONCE)
        const lists = await Promise.all(batch.map((a) => albumSongs(a.id)))
        for (const list of lists) songs.push(...list)
      }
      return { name: artist.name, coverArt: artist.coverArt, songs }
    }
  }
}

async function store(
  kind: KeptKind,
  id: string,
  found: { name: string; coverArt?: string; songs: ISong[] },
  addedAt: number,
) {
  const item: KeptItem = {
    kind,
    id,
    name: found.name,
    coverArt: found.coverArt,
    addedAt,
    checkedAt: Date.now(),
    songCount: found.songs.length,
  }
  await set(songsKey(keptId(kind, id)), found.songs)
  useSongCache.getState().putKept(item)
}

export function isKept(kind: KeptKind, id: string) {
  return !!useSongCache.getState().kept[keptId(kind, id)]
}

/** Starts keeping an item: reads its songs, then downloads them. */
export async function keep(kind: KeptKind, id: string) {
  if (!getSongCacheBackend()) {
    toast.error('Keeping songs on this device is not available here yet.')
    return
  }
  const found = await readFromServer(kind, id).catch((error) => {
    logger.error('[SongCache] Could not read', kind, id, error)
    return null
  })
  if (!found) {
    toast.error("Couldn't read it from the server. Try again.")
    return
  }
  await store(kind, id, found, Date.now())
  toast.success(
    found.songs.length === 1
      ? `Keeping “${found.name}” on this device.`
      : `Keeping “${found.name}” (${found.songs.length} songs) on this device.`,
  )
  scheduleSync()
}

/** Keeps songs the app already has (a song's menu, selected songs). */
export async function keepSongs(songs: ISong[]) {
  if (!getSongCacheBackend()) {
    toast.error('Keeping songs on this device is not available here yet.')
    return
  }
  for (const song of songs) {
    await store(
      'song',
      song.id,
      { name: song.title, coverArt: song.coverArt, songs: [song] },
      Date.now(),
    )
  }
  toast.success(
    songs.length === 1
      ? `Keeping “${songs[0].title}” on this device.`
      : `Keeping ${songs.length} songs on this device.`,
  )
  scheduleSync()
}

/** Stops keeping an item. Songs another kept item has stay. */
export async function release(kind: KeptKind, id: string) {
  const key = keptId(kind, id)
  const item = useSongCache.getState().kept[key]
  useSongCache.getState().removeKept(key)
  await del(songsKey(key))
  if (item) toast.info(`“${item.name}” is no longer kept on this device.`)
  scheduleSync()
}

export async function releaseAll() {
  const ids = Object.keys(useSongCache.getState().kept)
  useSongCache.getState().clearKept()
  await Promise.all(ids.map((id) => del(songsKey(id))))
  await getSongCacheBackend()?.clearKept()
}

/**
 * Reads kept items' songs from the server again: those not read for a
 * while, or all of them with `force`. An item the server no longer has
 * stays as it was (it may be offline), until the listener removes it.
 */
export async function refreshKept({ force = false } = {}) {
  const { kept } = useSongCache.getState()
  let changed = false
  for (const item of Object.values(kept)) {
    if (!force && Date.now() - item.checkedAt < RECHECK_MS) continue
    changed = (await refreshOne(item)) || changed
  }
  if (changed) scheduleSync()
}

/** Reads one kept item again (opened by the listener). */
export async function refreshKeptItem(kind: KeptKind, id: string) {
  const item = useSongCache.getState().kept[keptId(kind, id)]
  if (item && (await refreshOne(item))) scheduleSync()
}

/** Reads a kept item's songs again; true when they changed. */
async function refreshOne(item: KeptItem) {
  const found = await readFromServer(item.kind, item.id).catch(() => null)
  if (!found) return false
  const before = await keptSongs(keptId(item.kind, item.id))
  await store(item.kind, item.id, found, item.addedAt)
  const keys = (songs: ISong[]) => songs.map(songCacheKey).sort().join()
  const changed = keys(before) !== keys(found.songs)
  if (changed) logger.info('[SongCache] Changed on the server:', item.name)
  return changed
}

/** Every kept song, once each. */
export async function allKeptSongs() {
  const { kept } = useSongCache.getState()
  const byKey = new Map<string, ISong>()
  for (const id of Object.keys(kept)) {
    for (const song of await keptSongs(id)) byKey.set(songCacheKey(song), song)
  }
  return [...byKey.values()]
}

let syncTimer: ReturnType<typeof setTimeout> | undefined

/** Tells the platform the songs to keep, shortly (changes come in bursts). */
export function scheduleSync() {
  clearTimeout(syncTimer)
  syncTimer = setTimeout(syncNow, 500)
}

export async function syncNow() {
  const songs = await allKeptSongs()
  useSongCache.getState().setKeptSongIds(new Set(songs.map((song) => song.id)))
  const backend = getSongCacheBackend()
  if (!backend) return
  try {
    await backend.syncKept(songs)
  } catch (error) {
    logger.error('[SongCache] Could not update the kept songs', error)
  }
}

/** Reads the state of these songs on this device into the store. */
export async function refreshStates(songs: ISong[]) {
  const backend = getSongCacheBackend()
  if (!backend || songs.length === 0) return
  try {
    const states = await backend.status(songs)
    useSongCache.getState().setStates(states as Record<string, SongCacheState>)
  } catch (error) {
    logger.error('[SongCache] Could not read song states', error)
  }
}
