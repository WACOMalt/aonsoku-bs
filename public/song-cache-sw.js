/*
 * The song cache of the web app, in its service worker (imported by sw.js;
 * see src/service/song-cache/web.ts for the page's side).
 *
 * The player reads every song through <app>/__song/<key>?src=<server url>:
 * a song kept or played before is answered from the browser's storage, with
 * seeking. For any other song the player is sent to the server (a
 * redirect, not passed through here): a stream the player stops reading
 * would keep data waiting on the server's connection and, with HTTP/2,
 * hold up every other request on it. A whole download (the
 * gapless player's) is kept as a played song on its way through. The songs
 * played longest ago are removed once they pass the size in Settings.
 */

const SONGS_KEPT = 'aonsoku-songs-kept'
const SONGS_PLAYED = 'aonsoku-songs-played'
const SONGS_META = 'aonsoku-songs-meta'
const writingSongs = new Set()

const songUrl = (key) =>
  new URL(`__song/${encodeURIComponent(key)}`, self.registration.scope).href
const metaUrl = (key) =>
  new URL(`__song-meta/${encodeURIComponent(key)}`, self.registration.scope)
    .href
const settingsUrl = () =>
  new URL('__song-settings', self.registration.scope).href

const SONG_TYPES = {
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

// A key ends with the song's format (see songCacheKey).
const songType = (key) =>
  SONG_TYPES[key.slice(key.lastIndexOf('.') + 1)] || 'application/octet-stream'

async function songSettings() {
  const meta = await caches.open(SONGS_META)
  const saved = await meta.match(settingsUrl())
  const defaults = { cachePlayed: true, limit: 2 * 1024 ** 3 }
  return saved ? { ...defaults, ...(await saved.json()) } : defaults
}

async function writeSongMeta(key, value) {
  const meta = await caches.open(SONGS_META)
  await meta.put(metaUrl(key), new Response(JSON.stringify(value)))
}

async function touchSong(key) {
  const meta = await caches.open(SONGS_META)
  const saved = await meta.match(metaUrl(key))
  if (!saved) return
  const value = await saved.json()
  value.lastUsed = Date.now()
  await meta.put(metaUrl(key), new Response(JSON.stringify(value)))
}

/** Removes the played songs used longest ago until they fit the limit. */
async function shrinkPlayedSongs() {
  const { limit } = await songSettings()
  if (!limit || limit <= 0) return
  const meta = await caches.open(SONGS_META)
  const played = await caches.open(SONGS_PLAYED)
  const entries = []
  for (const request of await meta.keys()) {
    if (!request.url.includes('/__song-meta/')) continue
    const value = await (await meta.match(request)).json()
    if (value.store === 'played') entries.push({ request, ...value })
  }
  entries.sort((a, b) => a.lastUsed - b.lastUsed)
  let total = entries.reduce((sum, entry) => sum + entry.size, 0)
  for (const entry of entries) {
    if (total <= limit) break
    await played.delete(songUrl(entry.key))
    await meta.delete(entry.request)
    total -= entry.size
  }
}

/** Answers from storage: all of it, or the range asked for. */
async function serveSong(hit, key, range) {
  const blob = await hit.blob()
  const size = blob.size
  const headers = {
    'Content-Type': songType(key),
    'Accept-Ranges': 'bytes',
  }
  const match = range && /bytes=(\d*)-(\d*)/.exec(range)
  if (!match) {
    return new Response(blob, {
      status: 200,
      headers: { ...headers, 'Content-Length': String(size) },
    })
  }
  let start = 0
  let end = size - 1
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
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      ...headers,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${size}`,
    },
  })
}

/** Downloads a whole song for the player and keeps it as it passes. */
async function streamAndKeepSong(key, src) {
  const abort = new AbortController()
  const upstream = await fetch(src, { mode: 'cors', signal: abort.signal })
  if (!upstream.ok || !upstream.body) return upstream
  const expected = Number(upstream.headers.get('content-length')) || 0
  const [toPlayer, toCache] = upstream.body.tee()
  writingSongs.add(key)

  // Kept only if it arrives complete; a converted song's (Opus) length is
  // only estimated.
  ;(async () => {
    try {
      const played = await caches.open(SONGS_PLAYED)
      await played.put(
        songUrl(key),
        new Response(toCache, { headers: { 'Content-Type': songType(key) } }),
      )
      const stored = await played.match(songUrl(key))
      const size = stored ? (await stored.blob()).size : 0
      if (!size || (expected && size !== expected && !key.endsWith('.opus'))) {
        await played.delete(songUrl(key))
        return
      }
      await writeSongMeta(key, {
        key,
        store: 'played',
        size,
        lastUsed: Date.now(),
      })
      await shrinkPlayedSongs()
    } catch {
      // Stopped (skipped) or no space: nothing is kept.
    } finally {
      writingSongs.delete(key)
    }
  })()

  // The player stopping (a skip) stops the download too.
  const reader = toPlayer.getReader()
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) controller.close()
        else controller.enqueue(value)
      } catch (error) {
        controller.error(error)
      }
    },
    cancel() {
      abort.abort()
    },
  })
  return new Response(body, {
    status: upstream.status,
    headers: upstream.headers,
  })
}

async function handleSong(request, url) {
  const marker = '/__song/'
  const key = decodeURIComponent(
    url.pathname.slice(url.pathname.lastIndexOf(marker) + marker.length),
  )
  const src = url.searchParams.get('src')
  const range = request.headers.get('range')

  const kept = await (await caches.open(SONGS_KEPT)).match(songUrl(key))
  if (kept) return serveSong(kept, key, range)
  const played = await (await caches.open(SONGS_PLAYED)).match(songUrl(key))
  if (played) {
    touchSong(key).catch(() => {})
    return serveSong(played, key, range)
  }
  if (!src) return new Response(null, { status: 404 })
  const { cachePlayed } = await songSettings()
  if (!range && cachePlayed && !writingSongs.has(key)) {
    return streamAndKeepSong(key, src)
  }
  return Response.redirect(src, 307)
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return
  if (!url.pathname.includes('/__song/')) return
  event.respondWith(
    handleSong(event.request, url).catch(
      () => new Response(null, { status: 502 }),
    ),
  )
})
