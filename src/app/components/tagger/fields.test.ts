import { describe, expect, it } from 'vitest'
import { ISong } from '@/types/responses/song'
import { buildItems, initialValues, isEditable, validate } from './fields'

const song = (id: string, extra: Partial<ISong> = {}) =>
  ({
    id,
    title: `Song ${id}`,
    artist: 'Artist',
    album: 'Album',
    track: Number(id),
    discNumber: 1,
    year: 2020,
    genre: 'Rock',
    ...extra,
  }) as ISong

describe('initialValues', () => {
  it('shows one song as it is', () => {
    expect(initialValues([song('3')])).toEqual({
      title: 'Song 3',
      artist: 'Artist',
      albumArtist: '',
      album: 'Album',
      trackNumber: '3',
      discNumber: '1',
      year: '2020',
      genre: 'Rock',
    })
  })

  it('marks fields that differ across songs', () => {
    const values = initialValues([song('1'), song('2', { genre: 'Jazz' })])
    expect(values.title).toBeNull()
    expect(values.trackNumber).toBeNull()
    expect(values.genre).toBeNull()
    expect(values.album).toBe('Album')
  })

  it('prefers the display artist and album artist', () => {
    const values = initialValues([
      song('1', {
        displayArtist: 'A & B',
        albumArtists: [{ id: 'x', name: 'Various' }],
      }),
    ])
    expect(values.artist).toBe('A & B')
    expect(values.albumArtist).toBe('Various')
  })
})

describe('buildItems', () => {
  const songs = [song('1'), song('2')]

  it('sends only the changed fields, to every song', () => {
    expect(buildItems(songs, { album: ' New ', genre: '' }, null)).toEqual([
      { songId: '1', tags: { album: 'New', genre: '' } },
      { songId: '2', tags: { album: 'New', genre: '' } },
    ])
  })

  it('never sends one title or track number to a batch', () => {
    expect(
      buildItems(songs, { title: 'Same', trackNumber: '1' }, null),
    ).toEqual([])
    expect(isEditable('title', 2)).toBe(false)
    expect(isEditable('title', 1)).toBe(true)
  })

  it('sends a cover alone', () => {
    const cover = { mimeType: 'image/jpeg' as const, dataBase64: 'x' }
    expect(buildItems([song('1')], {}, cover)).toEqual([{ songId: '1', cover }])
  })

  it('gives each song its own edits, under the shared ones', () => {
    expect(
      buildItems(songs, { genre: 'Jazz' }, null, {
        '1': { title: 'One', genre: 'Rock' },
      }),
    ).toEqual([
      { songId: '1', tags: { title: 'One', genre: 'Jazz' } },
      { songId: '2', tags: { genre: 'Jazz' } },
    ])
    expect(buildItems(songs, {}, null, { '2': { title: 'Two' } })).toEqual([
      { songId: '2', tags: { title: 'Two' } },
    ])
  })

  it('sends nothing without changes', () => {
    expect(buildItems(songs, {}, null)).toEqual([])
  })
})

describe('validate', () => {
  it('takes track and disc numbers with or without a total', () => {
    expect(validate('trackNumber', '3')).toBeNull()
    expect(validate('trackNumber', '3/12')).toBeNull()
    expect(validate('discNumber', '')).toBeNull()
    expect(validate('trackNumber', '0')).not.toBeNull()
    expect(validate('trackNumber', 'three')).not.toBeNull()
  })

  it('takes a year or a date', () => {
    expect(validate('year', '1999')).toBeNull()
    expect(validate('year', '1999-05-03')).toBeNull()
    expect(validate('year', '99')).not.toBeNull()
  })
})
