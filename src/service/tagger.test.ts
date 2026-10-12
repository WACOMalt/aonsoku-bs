import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/app.store'
import { useJamStore } from '@/store/jam.store'
import { AuthType } from '@/types/serverConfig'
import { CoverUpload, TaggerError, tagger } from './tagger'

const cover: CoverUpload = { mimeType: 'image/jpeg', dataBase64: '/9j/4A' }

function setUp(response: Response) {
  useAppStore.setState((state) => ({
    data: {
      ...state.data,
      username: 'ben',
      password: 'token',
      authType: AuthType.TOKEN,
    },
  }))
  useJamStore.setState({ syncServerUrl: 'https://sync.example' })
  const fetchMock = vi.fn(async () => response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('tagger.write', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('uploads a cover the songs share once', async () => {
    const fetchMock = setUp(
      Response.json({ results: [], scanTriggered: false }),
    )
    await tagger.write(
      [
        { songId: 'a', tags: { album: 'X' }, cover },
        { songId: 'b', tags: { album: 'X' }, cover },
        { songId: 'c', tags: { album: 'X' } },
      ],
      true,
    )
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(await (init.body as Blob).text())
    expect(body.covers).toEqual({ cover0: cover })
    expect(body.items).toEqual([
      { songId: 'a', tags: { album: 'X' }, cover: 'cover0' },
      { songId: 'b', tags: { album: 'X' }, cover: 'cover0' },
      { songId: 'c', tags: { album: 'X' } },
    ])
    expect(body.folderCover).toBe(true)
  })

  it('says when a server in front refuses the save as too large', async () => {
    setUp(new Response('<html>413</html>', { status: 413 }))
    const error = await tagger
      .write([{ songId: 'a', cover }], false)
      .catch((e) => e)
    expect(error).toBeInstanceOf(TaggerError)
    expect(error.code).toBe('SERVER_TOO_LARGE')
    expect(error.params).toEqual({ size: 0, max: 24 })
  })

  it('refuses a save over the limit without sending it', async () => {
    const fetchMock = setUp(Response.json({}))
    const huge = {
      mimeType: 'image/jpeg' as const,
      dataBase64: 'A'.repeat(25 * 1024 * 1024),
    }
    const error = await tagger
      .write([{ songId: 'a', cover: huge }], false)
      .catch((e) => e)
    expect(error.code).toBe('TOO_LARGE')
    expect(error.params).toEqual({ size: 25, max: 24 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses more songs than a save may change', async () => {
    const fetchMock = setUp(Response.json({}))
    const items = Array.from({ length: 501 }, (_, i) => ({
      songId: `s${i}`,
      tags: { genre: 'Rock' },
    }))
    const error = await tagger.write(items, false).catch((e) => e)
    expect(error.code).toBe('TOO_MANY_SONGS')
    expect(error.params).toEqual({ max: 500 })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('tagger.coverFromFile', () => {
  it('says how large a refused cover is', async () => {
    const file = new Blob([new Uint8Array(16 * 1024 * 1024)], {
      type: 'image/jpeg',
    })
    const error = await tagger.coverFromFile(file).catch((e) => e)
    expect(error.code).toBe('COVER_TOO_LARGE')
    expect(error.params).toEqual({ size: 16, max: 15 })
  })
})
