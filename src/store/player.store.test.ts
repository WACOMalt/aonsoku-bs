import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ISong } from '@/types/responses/song'
import { usePlayerStore } from './player.store'

// The store saves the queue to IndexedDB, which jsdom doesn't have.
vi.mock('idb-keyval', () => {
  const saved = new Map<string, unknown>()
  return {
    get: async (key: string) => saved.get(key),
    set: async (key: string, value: unknown) => {
      saved.set(key, value)
    },
    del: async (key: string) => {
      saved.delete(key)
    },
  }
})

const song = (id: string) => ({ id, title: id }) as ISong
const ids = (list: ISong[]) => list.map((s) => s.id)

/** A queue as a Jam guest or playSong leaves it: originalList untouched. */
function setQueue(list: ISong[], index: number, originalList: ISong[] = []) {
  usePlayerStore.setState((state) => {
    state.songlist.currentList = list
    state.songlist.currentSongIndex = index
    state.songlist.currentSong = list[index]
    state.songlist.originalList = originalList
    state.playerState.isShuffleActive = false
  })
}

const { toggleShuffle } = usePlayerStore.getState().actions
const songlist = () => usePlayerStore.getState().songlist

describe('toggleShuffle', () => {
  const queue = ['a', 'b', 'c', 'd', 'e'].map(song)

  beforeEach(() => setQueue(queue, 2))

  it('shuffles the whole queue with the current song first', () => {
    toggleShuffle()

    const { currentList, currentSongIndex } = songlist()
    expect(currentSongIndex).toBe(0)
    expect(currentList[0].id).toBe('c')
    expect([...ids(currentList)].sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(usePlayerStore.getState().playerState.isShuffleActive).toBe(true)
  })

  it('unshuffles back to the queue from before', () => {
    toggleShuffle()
    toggleShuffle()

    const { currentList, currentSongIndex } = songlist()
    expect(ids(currentList)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(currentSongIndex).toBe(2)
    expect(usePlayerStore.getState().playerState.isShuffleActive).toBe(false)
  })

  it('ignores a stale originalList without the current song', () => {
    // A Jam guest got the host's queue; originalList is an old one.
    setQueue(queue, 2, ['x', 'y'].map(song))

    toggleShuffle()
    const { currentList } = songlist()
    expect(currentList).toHaveLength(5)
    expect(currentList.every((s) => s !== undefined)).toBe(true)
    expect(currentList[0].id).toBe('c')

    toggleShuffle()
    expect(ids(songlist().currentList)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('ignores a stale originalList that has the current song', () => {
    setQueue(queue, 2, ['c', 'old1', 'old2'].map(song))

    toggleShuffle()
    toggleShuffle()

    expect(ids(songlist().currentList)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('shuffles on the last song of the queue too', () => {
    setQueue(queue, 4)

    toggleShuffle()

    expect(songlist().currentList[0].id).toBe('e')
    expect(songlist().currentList).toHaveLength(5)
  })

  it('keeps the queue when it was replaced while shuffled', () => {
    toggleShuffle()
    // A Jam replaces the queue (originalList untouched).
    usePlayerStore.setState((state) => {
      state.songlist.currentList = ['p', 'q', 'r'].map(song)
      state.songlist.currentSongIndex = 1
      state.songlist.currentSong = state.songlist.currentList[1]
    })

    toggleShuffle()

    expect(ids(songlist().currentList)).toEqual(['p', 'q', 'r'])
    expect(songlist().currentSongIndex).toBe(1)
    expect(usePlayerStore.getState().playerState.isShuffleActive).toBe(false)
  })

  it('does nothing with one song', () => {
    setQueue([song('a')], 0)

    toggleShuffle()

    expect(usePlayerStore.getState().playerState.isShuffleActive).toBe(false)
  })
})
