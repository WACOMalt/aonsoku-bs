import { describe, expect, it } from 'vitest'
import { ISong } from '@/types/responses/song'
import {
  creditText,
  MbRelease,
  matchTracks,
  releaseEdits,
  releaseTracks,
  searchQuery,
} from './musicbrainz'

const release: MbRelease = {
  id: 'r1',
  title: 'The Dark Side of the Moon',
  date: '1973-03-01',
  'artist-credit': [{ name: 'Pink Floyd' }],
  genres: [
    { name: 'rock', count: 2 },
    { name: 'progressive rock', count: 9 },
  ],
  media: [
    {
      position: 1,
      'track-count': 3,
      tracks: [
        { position: 1, title: 'Speak to Me' },
        { position: 2, title: 'Breathe (In the Air)' },
        { position: 3, title: 'On the Run' },
      ],
    },
    {
      position: 2,
      'track-count': 1,
      tracks: [
        {
          position: 1,
          title: 'Money',
          'artist-credit': [
            { name: 'Pink Floyd', joinphrase: ' feat. ' },
            { name: 'Dick Parry' },
          ],
        },
      ],
    },
  ],
}

const song = (id: string, title: string, track: number, disc = 1) =>
  ({ id, title, track, discNumber: disc }) as ISong

describe('searchQuery', () => {
  it('searches an album by an artist, quoted', () => {
    expect(searchQuery('Dark "Side"', 'Pink Floyd')).toBe(
      'release:"Dark \\"Side\\"" AND artist:"Pink Floyd"',
    )
    expect(searchQuery('Album', '')).toBe('release:"Album"')
  })
})

describe('creditText', () => {
  it('joins the credited artists', () => {
    expect(creditText(release.media[1].tracks[0]['artist-credit'])).toBe(
      'Pink Floyd feat. Dick Parry',
    )
  })
})

describe('matchTracks', () => {
  const tracks = releaseTracks(release)

  it('matches by disc and track number', () => {
    expect(
      matchTracks(
        [song('a', 'Speak to me', 1), song('b', 'Money', 1, 2)],
        tracks,
      ),
    ).toEqual({ a: '1-1', b: '2-1' })
  })

  it('falls back to the title when the numbers are wrong', () => {
    expect(
      matchTracks([song('a', 'On The Run (2011 remaster)', 7)], tracks),
    ).toEqual({ a: '1-3' })
  })

  it('gives a track to one song only, and leaves the rest', () => {
    expect(
      matchTracks(
        [
          song('a', 'Breathe', 2),
          song('b', 'Breathe', 2),
          song('c', 'Unknown', 9),
        ],
        tracks,
      ),
    ).toEqual({ a: '1-2', b: null, c: null })
  })
})

describe('matchTracks on a CD that joins two songs', () => {
  // The 1986 CD has "Speak to Me / Breathe in the Air" as track 1.
  const cd: MbRelease = {
    ...release,
    media: [
      {
        position: 1,
        'track-count': 3,
        tracks: [
          { position: 1, title: 'Speak to Me / Breathe in the Air' },
          { position: 2, title: 'On the Run' },
          { position: 3, title: 'Time' },
        ],
      },
    ],
  }

  it('matches by title, and never guesses by number for a real title', () => {
    expect(
      matchTracks(
        [
          song('a', 'Speak to Me', 1),
          song('b', 'Breathe', 2),
          song('c', 'On the Run', 3),
        ],
        releaseTracks(cd),
      ),
    ).toEqual({ a: '1-1', b: null, c: '1-2' })
  })

  it('matches untitled songs by number', () => {
    expect(
      matchTracks(
        [song('a', 'Track 02', 2), song('b', '', 3)],
        releaseTracks(cd),
      ),
    ).toEqual({ a: '1-2', b: '1-3' })
  })
})

describe('releaseEdits', () => {
  it('gives every song the release, and each its own track', () => {
    const { shared, perSong } = releaseEdits(release, {
      a: '1-2',
      b: '2-1',
      c: null,
    })
    expect(shared).toEqual({
      album: 'The Dark Side of the Moon',
      albumArtist: 'Pink Floyd',
      year: '1973',
      genre: 'progressive rock',
    })
    expect(perSong).toEqual({
      a: {
        title: 'Breathe (In the Air)',
        artist: 'Pink Floyd',
        trackNumber: '2/3',
        discNumber: '1/2',
      },
      b: {
        title: 'Money',
        artist: 'Pink Floyd feat. Dick Parry',
        trackNumber: '1/1',
        discNumber: '2/2',
      },
    })
  })
})
