import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useMatches } from 'react-router-dom'
import { toast } from 'react-toastify'
import { getDownloadUrl } from '@/api/httpClient'
import { saveFileOnAndroid } from '@/service/song-cache/backend'
import { subsonic } from '@/service/subsonic'
import { usePlayerActions } from '@/store/player.store'
import { usePlaylistRemoveSong } from '@/store/playlists.store'
import { useSongInfo } from '@/store/ui.store'
import { PlaybackSource } from '@/types/playerContext'
import { UpdateParams } from '@/types/responses/playlist'
import { ISong } from '@/types/responses/song'
import { isDesktop } from '@/utils/desktop'
import { getNativePlatform } from '@/utils/platform'
import { queryKeys } from '@/utils/queryKeys'
import { useDownload } from './use-download'

type SongIdToAdd = Pick<UpdateParams, 'songIdToAdd'>['songIdToAdd']

export function useOptions() {
  const { setNextOnQueue, setLastOnQueue, setSongList } = usePlayerActions()
  const { downloadBrowser, downloadDesktop } = useDownload()
  const { setActionData, setConfirmDialogState } = usePlaylistRemoveSong()
  const matches = useMatches()
  const { setSongId, setModalOpen } = useSongInfo()

  const isOnPlaylistPage = matches.find((route) => route.id === 'playlist')
  const playlistId = isOnPlaylistPage?.params.playlistId ?? ''

  const queryClient = useQueryClient()

  function play(list: ISong[], source?: PlaybackSource) {
    setSongList(list, 0, false, source)
  }

  function playNext(list: ISong[]) {
    setNextOnQueue(list)
  }

  function playLast(list: ISong[]) {
    setLastOnQueue(list)
  }

  /**
   * Save file: the original file of a song, or a ZIP of an album, artist or
   * playlist, to the Downloads folder. `fileName` names it on Android (the
   * server names it elsewhere).
   */
  function startDownload(id: string, fileName = id) {
    const url = getDownloadUrl(id)

    if (isDesktop()) {
      downloadDesktop(url, id)
    } else if (getNativePlatform() === 'android') {
      saveFileOnAndroid(url, safeFileName(fileName))
        .then(() =>
          toast.success(`Saving ${safeFileName(fileName)} to Downloads.`),
        )
        .catch(() => toast.error(`Couldn't save ${safeFileName(fileName)}.`))
    } else {
      downloadBrowser(url)
    }
  }

  /** Save file for several songs, one after another. */
  function saveSongs(list: ISong[]) {
    list.forEach((song, index) => {
      // A moment apart: browsers may drop downloads started all at once.
      setTimeout(() => startDownload(song.id, songFileName(song)), index * 800)
    })
  }

  const updateMutation = useMutation({
    mutationFn: subsonic.playlists.update,
    onSuccess: () => {
      if (isOnPlaylistPage) {
        queryClient.invalidateQueries({
          queryKey: [queryKeys.playlist.single, playlistId],
        })
      }
    },
  })

  async function addToPlaylist(id: string, songIdToAdd: SongIdToAdd) {
    await updateMutation.mutateAsync({
      playlistId: id,
      songIdToAdd,
    })
  }

  const createMutation = useMutation({
    mutationFn: subsonic.playlists.createWithDetails,
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [queryKeys.playlist.all],
      })
    },
  })

  async function createNewPlaylist(name: string, songIdToAdd: SongIdToAdd) {
    await createMutation.mutateAsync({
      name,
      comment: '',
      isPublic: 'false',
      songIdToAdd,
    })
  }

  function removeSongFromPlaylist(songIndexes: string[]) {
    setActionData({
      playlistId,
      songIndexes,
    })
    setConfirmDialogState(true)
  }

  function openSongInfo(id: string) {
    setSongId(id)
    setModalOpen(true)
  }

  return {
    play,
    playNext,
    playLast,
    startDownload,
    saveSongs,
    addToPlaylist,
    createNewPlaylist,
    removeSongFromPlaylist,
    openSongInfo,
    isOnPlaylistPage,
    playlistId,
  }
}

/** A file name without the characters file systems refuse. */
function safeFileName(name: string) {
  return name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'download'
}

/** "Artist - Title.flac" */
export function songFileName(song: ISong) {
  const name = [song.artist, song.title].filter(Boolean).join(' - ')
  return song.suffix ? `${name}.${song.suffix}` : name
}
