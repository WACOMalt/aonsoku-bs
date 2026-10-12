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
    const body = JSON.parse(init.body as string)
    expect(body.covers).toEqual({ cover0: cover })
    expect(body.items).toEqual([
      { songId: 'a', tags: { album: 'X' }, cover: 'cover0' },
      { songId: 'b', tags: { album: 'X' }, cover: 'cover0' },
      { songId: 'c', tags: { album: 'X' } },
    ])
    expect(body.folderCover).toBe(true)
  })

  it('names a request that was too large', async () => {
    setUp(new Response('<html>413</html>', { status: 413 }))
    const error = await tagger
      .write([{ songId: 'a', cover }], false)
      .catch((e) => e)
    expect(error).toBeInstanceOf(TaggerError)
    expect(error.code).toBe('TOO_LARGE')
  })
})
