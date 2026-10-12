import { httpClient } from '@/api/httpClient'
import type { AcoustidResult } from '@/app/components/tagger/musicbrainz'
import { useAppStore } from '@/store/app.store'
import { SubsonicResponse } from '@/types/responses/subsonicResponse'
import { getSyncAuth } from '@/utils/syncAuth'
import { getSyncServerUrl } from '@/utils/syncServerUrl'

/**
 * The tag editor. Edits go to the Aonsoku-BS server, which passes them to
 * the Navidrome plugin that writes the files (see jam-sync-server/tagger.js
 * and tagger-plugin/). Only Navidrome admins may edit; the server and the
 * plugin both check, with the credentials the app signed in with.
 */

export interface TaggerCapabilities {
  enabled: boolean
  pluginVersion: string | null
  features: { write: boolean; lookup: boolean; fingerprint: boolean }
}

export const TAG_FIELDS = [
  'title',
  'artist',
  'albumArtist',
  'album',
  'trackNumber',
  'discNumber',
  'year',
  'genre',
] as const

export type TagField = (typeof TAG_FIELDS)[number]
export type TagEdit = Partial<Record<TagField, string>>

export interface CoverUpload {
  mimeType: 'image/jpeg' | 'image/png'
  dataBase64: string
}

export interface WriteItem {
  songId: string
  tags?: TagEdit
  cover?: CoverUpload
}

export interface WriteResult {
  songId: string
  ok: boolean
  error?: string
}

/** Why a write did not happen at all (a code, see the i18n "tagger.errors"). */
export class TaggerError extends Error {
  constructor(
    readonly code: string,
    /** Values for the message, e.g. a size. */
    readonly params: Record<string, string | number> = {},
  ) {
    super(code)
  }
}

/** The most a save may change and carry; the server refuses more. */
export const MAX_SONGS = 500
export const MAX_SAVE_MB = 24
export const MAX_COVER_MB = 15

/** Bytes as megabytes for a message, e.g. 7.4. */
const megabytes = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10

const DISABLED: TaggerCapabilities = {
  enabled: false,
  pluginVersion: null,
  features: { write: false, lookup: false, fingerprint: false },
}

function taggerUrl(path: string) {
  const server = getSyncServerUrl()
  return server ? `${server.replace(/\/$/, '')}/jam-sync/tagger/${path}` : null
}

/** What the server offers; any failure means the tag editor is off. */
async function capabilities(): Promise<TaggerCapabilities> {
  const url = taggerUrl('capabilities')
  if (!url) return DISABLED
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return DISABLED
    const body = (await res.json()) as TaggerCapabilities
    return body?.enabled ? body : DISABLED
  } catch {
    return DISABLED
  }
}

/** Whether the signed-in user is a Navidrome admin. */
async function isAdmin(): Promise<boolean> {
  const { username } = useAppStore.getState().data
  if (!username) return false
  try {
    const response = await httpClient<
      SubsonicResponse & { user?: { adminRole?: boolean } }
    >('/getUser', { method: 'GET', query: { username } })
    return response?.data?.user?.adminRole === true
  } catch {
    return false
  }
}

/** Writes the edits; one result per song, in order. */
async function write(
  items: WriteItem[],
  folderCover: boolean,
): Promise<{ results: WriteResult[]; scanTriggered: boolean }> {
  const url = taggerUrl('write')
  const auth = getSyncAuth()
  if (!url || !auth) throw new TaggerError('TAGGER_UNAVAILABLE')
  if (items.length > MAX_SONGS) {
    throw new TaggerError('TOO_MANY_SONGS', { max: MAX_SONGS })
  }
  // Songs that share a cover (an album's, usually) share one upload.
  const covers: Record<string, CoverUpload> = {}
  const keys = new Map<CoverUpload, string>()
  const sent = items.map(({ cover, ...item }) => {
    if (!cover) return item
    let key = keys.get(cover)
    if (!key) {
      key = `cover${keys.size}`
      keys.set(cover, key)
      covers[key] = cover
    }
    return { ...item, cover: key }
  })
  const body = new Blob(
    [JSON.stringify({ auth, items: sent, covers, folderCover })],
    { type: 'application/json' },
  )
  const size = megabytes(body.size)
  if (body.size > MAX_SAVE_MB * 1024 * 1024) {
    throw new TaggerError('TOO_LARGE', { size, max: MAX_SAVE_MB })
  }
  let res: Response
  try {
    res = await fetch(url, { method: 'POST', body })
  } catch {
    throw new TaggerError('TAGGER_UNAVAILABLE')
  }
  // Under our limit, so a web server in front of Aonsoku-BS has a lower one.
  if (res.status === 413) {
    throw new TaggerError('SERVER_TOO_LARGE', { size, max: MAX_SAVE_MB })
  }
  const reply = await res.json().catch(() => null)
  if (!res.ok) throw new TaggerError(reply?.error ?? 'TAGGER_UNAVAILABLE')
  return reply
}

/** A lookup (MusicBrainz, cover art) through the server, as an admin. */
async function lookup(path: string): Promise<Response> {
  const url = taggerUrl(path)
  const auth = getSyncAuth()
  if (!url || !auth) throw new TaggerError('TAGGER_UNAVAILABLE')
  const res = await fetch(url, {
    headers: { 'X-Tagger-Auth': btoa(JSON.stringify(auth)) },
  })
  if (!res.ok && res.status !== 404) {
    const body = await res.json().catch(() => null)
    throw new TaggerError(body?.error ?? 'UPSTREAM_UNAVAILABLE')
  }
  return res
}

/** AcoustID's matches for a fingerprint (see musicbrainz.ts). */
async function identify(
  fingerprint: string,
  duration: number,
): Promise<AcoustidResult[]> {
  const url = taggerUrl('acoustid/lookup')
  const auth = getSyncAuth()
  if (!url || !auth) throw new TaggerError('TAGGER_UNAVAILABLE')
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tagger-Auth': btoa(JSON.stringify(auth)),
      },
      body: JSON.stringify({ fingerprint, duration }),
    })
  } catch {
    throw new TaggerError('TAGGER_UNAVAILABLE')
  }
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new TaggerError(body?.error ?? 'UPSTREAM_UNAVAILABLE')
  return body?.results ?? []
}

/** A picked image file as an upload: JPEG or PNG, up to 15 MB. */
async function coverFromFile(file: Blob): Promise<CoverUpload> {
  if (file.type !== 'image/jpeg' && file.type !== 'image/png') {
    throw new TaggerError('COVER_TYPE')
  }
  if (file.size > MAX_COVER_MB * 1024 * 1024) {
    throw new TaggerError('COVER_TOO_LARGE', {
      size: megabytes(file.size),
      max: MAX_COVER_MB,
    })
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return { mimeType: file.type, dataBase64: btoa(binary) }
}

export const tagger = {
  capabilities,
  isAdmin,
  write,
  lookup,
  identify,
  coverFromFile,
}
