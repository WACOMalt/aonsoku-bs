import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { app, BrowserWindow, ipcMain, net, protocol } from 'electron'

/**
 * Songs kept on this computer (see src/service/song-cache), so a song plays
 * from the disk instead of the server:
 *
 * - Played songs: a song the player downloads whole (the gapless player
 *   does, or the web app asks for it, see song-audio.tsx) is written here as
 *   it arrives. The songs played longest ago are removed once the folder is
 *   over the size set in Settings.
 * - Kept songs: what the listener chose to "Keep cached", downloaded ahead,
 *   two at a time, and removed only when no longer kept.
 *
 * The player reads every song through aonsoku-song://song/<key>?src=<url>.
 * A song on the disk is served from it, with seeking. The player is sent to
 * the server for any other song (a redirect, not passed through here): a
 * stream the player stops reading, once it has enough, would keep its data
 * waiting on the server's connection, and with HTTP/2 that holds up every
 * other request on it, such as the album being opened.
 */

export const SONG_SCHEME = 'aonsoku-song'
const PARALLEL_DOWNLOADS = 2
// A failed kept download is tried again after this long.
const RETRY_MS = 5 * 60 * 1000

/** Called before the app is ready: the scheme can stream, seek and fetch. */
export function registerSongScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SONG_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        stream: true,
        supportFetchAPI: true,
        corsEnabled: true,
        bypassCSP: true,
      },
    },
  ])
}

type Entry = { size: number; lastUsed: number }

/** A folder of songs, with an index of their sizes and last use. */
class Store {
  readonly index = new Map<string, Entry>()
  private saveTimer: NodeJS.Timeout | undefined

  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true })
    try {
      const saved = JSON.parse(
        fs.readFileSync(path.join(dir, 'index.json'), 'utf8'),
      ) as Record<string, Entry>
      for (const [key, entry] of Object.entries(saved)) {
        if (fs.existsSync(this.file(key))) this.index.set(key, entry)
      }
    } catch {
      // A new or unreadable index starts empty.
    }
    // Leftovers of downloads that never finished.
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.part'))
        fs.rmSync(path.join(dir, name), { force: true })
    }
  }

  file(key: string) {
    return path.join(this.dir, key.replace(/[^\w.-]/g, '_'))
  }

  has(key: string) {
    return this.index.has(key)
  }

  add(key: string, size: number) {
    this.index.set(key, { size, lastUsed: Date.now() })
    this.save()
  }

  touch(key: string) {
    const entry = this.index.get(key)
    if (!entry) return
    entry.lastUsed = Date.now()
    this.save()
  }

  remove(key: string) {
    this.index.delete(key)
    fs.rmSync(this.file(key), { force: true })
    this.save()
  }

  clear() {
    for (const key of [...this.index.keys()]) this.remove(key)
  }

  total() {
    let bytes = 0
    for (const entry of this.index.values()) bytes += entry.size
    return bytes
  }

  /** Removes the songs used longest ago until it fits in `limit` bytes. */
  shrinkTo(limit: number) {
    if (limit <= 0) return
    const byAge = [...this.index.entries()].sort(
      (a, b) => a[1].lastUsed - b[1].lastUsed,
    )
    let total = this.total()
    for (const [key, entry] of byAge) {
      if (total <= limit) break
      this.remove(key)
      total -= entry.size
    }
  }

  private save() {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      const data = Object.fromEntries(this.index)
      const target = path.join(this.dir, 'index.json')
      fs.writeFile(`${target}.tmp`, JSON.stringify(data), (error) => {
        if (!error) fs.rename(`${target}.tmp`, target, () => {})
      })
    }, 1000)
  }
}

const TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  opus: 'audio/ogg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
}

/** A key ends with the song's format (see songCacheKey). */
function typeOf(key: string) {
  return (
    TYPES[key.slice(key.lastIndexOf('.') + 1)] ?? 'application/octet-stream'
  )
}

type Wanted = { key: string; url: string; title: string }
type Settings = { cachePlayed: boolean; limit: number }

let played: Store
let kept: Store
let window: BrowserWindow | null = null
const settings: Settings = { cachePlayed: true, limit: 2 * 1024 ** 3 }
// Played songs being written as they download.
const writing = new Set<string>()
// Kept songs: wanted, downloading now, and failed (with when).
let wanted = new Map<string, Wanted>()
const active = new Map<string, AbortController>()
const failed = new Map<string, number>()
let playbackLoading = false
let changeTimer: NodeJS.Timeout | undefined

/** Serves a file, all of it or the range asked for. */
async function serveFile(file: string, key: string, range: string | null) {
  const { size } = await fsp.stat(file)
  let start = 0
  let end = size - 1
  const match = range ? /bytes=(\d*)-(\d*)/.exec(range) : null
  if (match) {
    if (match[1] === '') {
      start = Math.max(0, size - Number(match[2]))
    } else {
      start = Number(match[1])
      if (match[2]) end = Math.min(Number(match[2]), size - 1)
    }
    if (start >= size) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}` },
      })
    }
  }
  const body = Readable.toWeb(
    fs.createReadStream(file, { start, end }),
  ) as ReadableStream
  const headers: Record<string, string> = {
    'Content-Type': typeOf(key),
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
  }
  if (match) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  return new Response(body, { status: match ? 206 : 200, headers })
}

/**
 * Downloads a whole song from the server for the player, and writes it to
 * the played songs as it passes. Kept only if it arrives complete.
 */
async function streamAndKeep(key: string, src: string) {
  const upstream = await net.fetch(src)
  if (!upstream.ok || !upstream.body) return upstream
  const expected = Number(upstream.headers.get('content-length')) || 0
  const target = played.file(key)
  const partial = `${target}.part`
  const out = fs.createWriteStream(partial)
  const reader = upstream.body.getReader()
  let written = 0
  let done = false
  writing.add(key)

  const fail = () => {
    if (done) return
    done = true
    writing.delete(key)
    out.destroy()
    fs.rm(partial, { force: true }, () => {})
  }
  const finish = () => {
    if (done) return
    done = true
    out.end(() => {
      writing.delete(key)
      // A converted song's (Opus) length is only estimated; any other must
      // arrive whole.
      const estimated = key.endsWith('.opus')
      if (written === 0 || (expected && written !== expected && !estimated)) {
        fs.rm(partial, { force: true }, () => {})
        return
      }
      fs.rename(partial, target, (error) => {
        if (error) return
        played.add(key, written)
        played.shrinkTo(settings.limit)
      })
    })
  }

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done: end, value } = await reader.read()
        if (end) {
          finish()
          controller.close()
          return
        }
        written += value.byteLength
        out.write(value)
        controller.enqueue(value)
      } catch (error) {
        fail()
        controller.error(error)
      }
    },
    cancel(reason) {
      fail()
      reader.cancel(reason).catch(() => {})
    },
  })
  return new Response(body, {
    status: upstream.status,
    headers: upstream.headers,
  })
}

async function handleSong(request: Request) {
  const url = new URL(request.url)
  const key = decodeURIComponent(url.pathname.slice(1))
  const src = url.searchParams.get('src')
  const range = request.headers.get('range')

  if (kept.has(key)) return serveFile(kept.file(key), key, range)
  if (played.has(key)) {
    played.touch(key)
    return serveFile(played.file(key), key, range)
  }
  if (!src) return new Response(null, { status: 404 })
  // A whole download (the gapless player's, read to the end) is kept on
  // its way through.
  if (!range && settings.cachePlayed && !writing.has(key)) {
    return streamAndKeep(key, src)
  }
  return new Response(null, { status: 307, headers: { Location: src } })
}

// ── Kept songs ──

function notifyChange() {
  clearTimeout(changeTimer)
  changeTimer = setTimeout(() => {
    if (window && !window.isDestroyed()) {
      window.webContents.send('song-cache-changed')
    }
  }, 1000)
}

/** Starts downloads while there is room, unless a song is loading. */
function pump() {
  if (playbackLoading) return
  for (const song of wanted.values()) {
    if (active.size >= PARALLEL_DOWNLOADS) return
    if (kept.has(song.key) || active.has(song.key)) continue
    const failedAt = failed.get(song.key)
    if (failedAt && Date.now() - failedAt < RETRY_MS) continue
    download(song)
  }
}

async function download(song: Wanted) {
  const abort = new AbortController()
  active.set(song.key, abort)
  notifyChange()
  const target = kept.file(song.key)
  const partial = `${target}.part`
  try {
    if (played.has(song.key)) {
      // Already here as a played song: copied, not downloaded again.
      await fsp.copyFile(played.file(song.key), partial)
    } else {
      const response = await net.fetch(song.url, { signal: abort.signal })
      if (!response.ok || !response.body)
        throw new Error(`HTTP ${response.status}`)
      await fsp.writeFile(partial, Readable.fromWeb(response.body as never))
    }
    if (!wanted.has(song.key)) throw new Error('No longer kept')
    await fsp.rename(partial, target)
    const { size } = await fsp.stat(target)
    kept.add(song.key, size)
    failed.delete(song.key)
  } catch (error) {
    await fsp.rm(partial, { force: true })
    if (!abort.signal.aborted) {
      failed.set(song.key, Date.now())
      console.warn('[SongCache] Could not download', song.title, error)
    }
  } finally {
    active.delete(song.key)
    notifyChange()
    pump()
  }
}

/** Makes the kept songs exactly these. */
function syncKept(list: Wanted[]) {
  wanted = new Map(list.map((song) => [song.key, song]))
  for (const key of [...kept.index.keys()]) {
    if (!wanted.has(key)) kept.remove(key)
  }
  for (const [key, abort] of active) {
    if (!wanted.has(key)) abort.abort()
  }
  for (const key of [...failed.keys()]) {
    if (!wanted.has(key)) failed.delete(key)
  }
  notifyChange()
  pump()
}

function stateOf(key: string) {
  if (kept.has(key)) return 'kept'
  if (active.has(key)) return 'downloading'
  if (wanted.has(key)) return failed.has(key) ? 'failed' : 'queued'
  if (played.has(key)) return 'cached'
  return 'none'
}

async function usage() {
  let keptPending = 0
  for (const key of wanted.keys()) if (!kept.has(key)) keptPending++
  let free: number | undefined
  try {
    const stats = await fsp.statfs(app.getPath('userData'))
    free = stats.bavail * stats.bsize
  } catch {
    free = undefined
  }
  return {
    played: played.total(),
    kept: kept.total(),
    keptSongs: kept.index.size,
    keptPending,
    free,
  }
}

type Call =
  | { method: 'configure'; args: Settings }
  | { method: 'syncKept'; args: Wanted[] }
  | { method: 'usage' }
  | { method: 'status'; args: string[] }
  | { method: 'clearPlayed' }
  | { method: 'clearKept' }
  | { method: 'setPlaybackLoading'; args: boolean }

/** Sets up the scheme and the calls from the web app, once the app is ready. */
export function setupSongCache(mainWindow: BrowserWindow | null) {
  window = mainWindow
  if (played) return
  const root = path.join(app.getPath('userData'), 'song-cache')
  played = new Store(path.join(root, 'played'))
  kept = new Store(path.join(root, 'kept'))

  protocol.handle(SONG_SCHEME, (request) =>
    handleSong(request).catch((error) => {
      console.warn('[SongCache] Could not serve a song', error)
      return new Response(null, { status: 502 })
    }),
  )

  ipcMain.handle('song-cache', async (_event, call: Call) => {
    switch (call.method) {
      case 'configure':
        settings.cachePlayed = call.args.cachePlayed
        settings.limit = call.args.limit
        played.shrinkTo(settings.limit)
        return null
      case 'syncKept':
        syncKept(call.args)
        return null
      case 'usage':
        return usage()
      case 'status':
        return Object.fromEntries(call.args.map((key) => [key, stateOf(key)]))
      case 'clearPlayed':
        played.clear()
        return null
      case 'clearKept':
        syncKept([])
        kept.clear()
        return null
      case 'setPlaybackLoading':
        playbackLoading = call.args
        pump()
        return null
    }
  })
}
