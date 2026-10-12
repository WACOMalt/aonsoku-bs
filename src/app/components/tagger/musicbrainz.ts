import type { TagEdit } from '@/service/tagger'
import { ISong } from '@/types/responses/song'

/** The parts of MusicBrainz's JSON the editor uses. */
export interface MbArtistCredit {
  name: string
  joinphrase?: string
}

export interface MbReleaseSummary {
  id: string
  title: string
  'artist-credit'?: MbArtistCredit[]
  date?: string
  country?: string
  'track-count'?: number
  media?: { format?: string; 'track-count'?: number }[]
  score?: number
}

export interface MbRelease extends MbReleaseSummary {
  media: {
    position: number
    format?: string
    'track-count': number
    tracks: {
      position: number
      number?: string
      title: string
      'artist-credit'?: MbArtistCredit[]
    }[]
  }[]
  genres?: { name: string; count: number }[]
  'release-group'?: { genres?: { name: string; count: number }[] }
}

/** One track of a release, flattened. */
export interface ReleaseTrack {
  key: string
  disc: number
  discTotal: number
  number: number
  trackTotal: number
  title: string
  artist: string
}

/** The text of an artist credit: "A feat. B". */
export function creditText(credit: MbArtistCredit[] | undefined): string {
  return (credit ?? []).map((c) => c.name + (c.joinphrase ?? '')).join('')
}

/** A MusicBrainz search for an album by an artist. */
export function searchQuery(album: string, artist: string): string {
  const quote = (s: string) => `"${s.replace(/[\\"]/g, '\\$&')}"`
  const parts: string[] = []
  if (album.trim()) parts.push(`release:${quote(album.trim())}`)
  if (artist.trim()) parts.push(`artist:${quote(artist.trim())}`)
  return parts.join(' AND ')
}

/** "CD + CD", for a release's formats. */
export function formats(release: MbReleaseSummary): string {
  const names = (release.media ?? []).map((m) => m.format || '?')
  return [...new Set(names)].join(' + ')
}

export function releaseTracks(release: MbRelease): ReleaseTrack[] {
  const discTotal = release.media.length
  return release.media.flatMap((medium) =>
    medium.tracks.map((track) => ({
      key: `${medium.position}-${track.position}`,
      disc: medium.position,
      discTotal,
      number: track.position,
      trackTotal: medium['track-count'] ?? medium.tracks.length,
      title: track.title,
      artist: creditText(track['artist-credit']),
    })),
  )
}

function normalize(title: string) {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Shared words over all words: 1 for the same title. */
function similarity(a: string, b: string) {
  const wa = new Set(normalize(a).split(' ').filter(Boolean))
  const wb = new Set(normalize(b).split(' ').filter(Boolean))
  if (wa.size === 0 || wb.size === 0) return 0
  let shared = 0
  for (const w of wa) if (wb.has(w)) shared++
  return shared / Math.max(wa.size, wb.size)
}

/** "Track 02", "03", "": a title that says nothing about the song. */
function noRealTitle(title: string) {
  return /^\s*(track|piste|titel|pista)?\s*\d*\s*$/i.test(title)
}

/**
 * Which release track each song is: by disc and track number when the
 * titles agree, then by title, and by number alone only for songs with no
 * real title. A track goes to one song at most. Unmatched songs map to null.
 */
export function matchTracks(
  songs: ISong[],
  tracks: ReleaseTrack[],
): Record<string, string | null> {
  const mapping: Record<string, string | null> = {}
  const taken = new Set<string>()
  const take = (song: ISong, track: ReleaseTrack | undefined) => {
    if (!track || taken.has(track.key)) return false
    mapping[song.id] = track.key
    taken.add(track.key)
    return true
  }
  const byNumber = (song: ISong) =>
    tracks.find(
      (t) => t.disc === (song.discNumber || 1) && t.number === song.track,
    )

  // Number and title agree.
  for (const song of songs) {
    const track = byNumber(song)
    if (track && similarity(track.title, song.title) > 0) take(song, track)
  }
  // By title, for every song left, before any number-only guess.
  for (const song of songs) {
    if (song.id in mapping) continue
    const best = tracks
      .filter((t) => !taken.has(t.key))
      .map((t) => ({ t, score: similarity(t.title, song.title) }))
      .sort((a, b) => b.score - a.score)[0]
    if (best && best.score >= 0.5) take(song, best.t)
  }
  // By number alone, for songs that have no real title yet.
  for (const song of songs) {
    if (song.id in mapping) continue
    if (!(noRealTitle(song.title) && take(song, byNumber(song)))) {
      mapping[song.id] = null
    }
  }
  return mapping
}

/** The edits a release gives: the same for all songs, and per song. */
export function releaseEdits(
  release: MbRelease,
  mapping: Record<string, string | null>,
): { shared: TagEdit; perSong: Record<string, TagEdit> } {
  const tracks = new Map(releaseTracks(release).map((t) => [t.key, t]))
  const genres = [
    ...(release.genres ?? []),
    ...(release['release-group']?.genres ?? []),
  ].sort((a, b) => b.count - a.count)
  const shared: TagEdit = {
    album: release.title,
    albumArtist: creditText(release['artist-credit']),
  }
  const year = release.date?.slice(0, 4)
  if (year && /^\d{4}$/.test(year)) shared.year = year
  if (genres[0]) shared.genre = genres[0].name

  const perSong: Record<string, TagEdit> = {}
  for (const [songId, key] of Object.entries(mapping)) {
    const track = key ? tracks.get(key) : undefined
    if (!track) continue
    perSong[songId] = {
      title: track.title,
      artist: track.artist || shared.albumArtist,
      trackNumber: `${track.number}/${track.trackTotal}`,
      discNumber: `${track.disc}/${track.discTotal}`,
    }
  }
  return { shared, perSong }
}
