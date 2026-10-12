import type {
  CoverUpload,
  TagEdit,
  TagField,
  WriteItem,
} from '@/service/tagger'
import { TAG_FIELDS } from '@/service/tagger'
import { ISong } from '@/types/responses/song'

/** A field's value in the editor; null when the songs differ. */
export type FieldValues = Record<TagField, string | null>

/** Fields each song keeps for itself: in a batch they can't be edited. */
export const PER_SONG_FIELDS: TagField[] = ['title', 'trackNumber']

/** What a song's tags say for a field, from the data the app already has. */
export function songValue(song: ISong, field: TagField): string {
  switch (field) {
    case 'title':
      return song.title ?? ''
    case 'artist':
      return song.displayArtist || song.artist || ''
    case 'albumArtist':
      return (
        song.displayAlbumArtist ||
        song.albumArtists?.map((a) => a.name).join(', ') ||
        ''
      )
    case 'album':
      return song.album ?? ''
    case 'trackNumber':
      return song.track ? String(song.track) : ''
    case 'discNumber':
      return song.discNumber ? String(song.discNumber) : ''
    case 'year':
      return song.year ? String(song.year) : ''
    case 'genre':
      return song.genre ?? ''
  }
}

export function initialValues(songs: ISong[]): FieldValues {
  const values = {} as FieldValues
  for (const field of TAG_FIELDS) {
    const all = songs.map((song) => songValue(song, field))
    values[field] = all.every((v) => v === all[0]) ? (all[0] ?? '') : null
  }
  return values
}

export function isEditable(field: TagField, songCount: number) {
  return songCount === 1 || !PER_SONG_FIELDS.includes(field)
}

/** Why a value is refused (an i18n key), or null. */
export function validate(field: TagField, value: string): string | null {
  const v = value.trim()
  if (v === '') return null
  if (field === 'trackNumber' || field === 'discNumber') {
    return /^[1-9]\d*(\/[1-9]\d*)?$/.test(v) ? null : 'tagger.invalid.number'
  }
  if (field === 'year') {
    return /^\d{4}(-\d{2}(-\d{2})?)?$/.test(v) ? null : 'tagger.invalid.year'
  }
  return null
}

/**
 * What to send: per song, only the fields the user changed (an emptied
 * field clears it), and the new cover. Songs with nothing to change are
 * left out.
 */
export function buildItems(
  songs: ISong[],
  changed: Partial<Record<TagField, string>>,
  cover: CoverUpload | null,
): WriteItem[] {
  const tags: TagEdit = {}
  for (const field of TAG_FIELDS) {
    const value = changed[field]
    if (value === undefined || !isEditable(field, songs.length)) continue
    tags[field] = value.trim()
  }
  const hasTags = Object.keys(tags).length > 0
  if (!hasTags && !cover) return []
  return songs.map((song) => ({
    songId: song.id,
    ...(hasTags ? { tags } : {}),
    ...(cover ? { cover } : {}),
  }))
}
