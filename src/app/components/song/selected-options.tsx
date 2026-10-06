import { Table } from '@tanstack/react-table'
import { useTranslation } from 'react-i18next'
import { OptionsButtons } from '@/app/components/options/buttons'
import { DownloadOptionHandler } from '@/app/components/options/download-handler'
import {
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/app/components/ui/context-menu'
import { useOptions } from '@/app/hooks/use-options'
import { getSongCacheBackend } from '@/service/song-cache/backend'
import { keepSongs, release } from '@/service/song-cache/kept'
import { useAppStore } from '@/store/app.store'
import { keptId, useSongCache } from '@/store/song-cache.store'
import { ISong } from '@/types/responses/song'
import { shareItem } from '@/utils/shareLinks'
import { AddToPlaylistSubMenu } from './add-to-playlist'

interface SelectedSongsProps {
  table: Table<ISong>
}

export function SelectedSongsMenuOptions({ table }: SelectedSongsProps) {
  const { t } = useTranslation()
  const songOptions = useOptions()
  const hidePlaylistsSection = useAppStore().pages.hidePlaylistsSection

  const { rows } = table.getFilteredSelectedRowModel()
  const isSingleSelected = rows.length === 1
  const songs = rows.map((row) => row.original)
  const firstSong = songs[0]
  const allKept = useSongCache((state) =>
    songs.every((song) => !!state.kept[keptId('song', song.id)]),
  )

  function reset(action: () => void) {
    action()
    table.resetRowSelection()
  }

  async function handlePlayNext() {
    reset(() => songOptions.playNext(songs))
  }

  async function handlePlayLast() {
    reset(() => songOptions.playLast(songs))
  }

  async function handleDownload() {
    reset(() => songOptions.saveSongs(songs))
  }

  function handleKeepCached() {
    reset(() => {
      if (allKept) for (const song of songs) release('song', song.id)
      else keepSongs(songs)
    })
  }

  async function handleAddToPlaylist(id: string) {
    const songIdToAdd = songs.map((s) => s.id)

    reset(() => songOptions.addToPlaylist(id, songIdToAdd))
  }

  async function handleCreateNewPlaylist() {
    const songIdToAdd = songs.map((s) => s.id)

    reset(() => songOptions.createNewPlaylist(firstSong.title, songIdToAdd))
  }

  function handleRemoveSongsFromPlaylist() {
    const songIndexes = rows.map((row) => row.index.toString())

    reset(() => songOptions.removeSongFromPlaylist(songIndexes))
  }

  function handleShare() {
    if (!isSingleSelected) return

    reset(() =>
      shareItem(
        { type: 'song', id: firstSong.id },
        [firstSong.title, firstSong.artist].filter(Boolean).join(' - '),
      ),
    )
  }

  function handleSongInfoOption() {
    if (!isSingleSelected) return

    reset(() => songOptions.openSongInfo(firstSong.id))
  }

  return (
    <>
      <OptionsButtons.PlayNext
        variant="context"
        onClick={(e) => {
          e.stopPropagation()
          handlePlayNext()
        }}
      />
      <OptionsButtons.PlayLast
        variant="context"
        onClick={(e) => {
          e.stopPropagation()
          handlePlayLast()
        }}
      />
      {!hidePlaylistsSection && (
        <>
          <ContextMenuSeparator />
          <OptionsButtons.AddToPlaylistOption variant="context">
            <AddToPlaylistSubMenu
              type="context"
              newPlaylistFn={handleCreateNewPlaylist}
              addToPlaylistFn={handleAddToPlaylist}
            />
          </OptionsButtons.AddToPlaylistOption>
        </>
      )}
      {songOptions.isOnPlaylistPage && (
        <OptionsButtons.RemoveFromPlaylist
          variant="context"
          onClick={(e) => {
            e.stopPropagation()
            handleRemoveSongsFromPlaylist()
          }}
        />
      )}
      <DownloadOptionHandler context={true}>
        <OptionsButtons.Download
          variant="context"
          onClick={(e) => {
            e.stopPropagation()
            handleDownload()
          }}
        />
      </DownloadOptionHandler>
      {getSongCacheBackend() && (
        <OptionsButtons.KeepCached
          variant="context"
          kept={allKept}
          onClick={(e) => {
            e.stopPropagation()
            handleKeepCached()
          }}
        />
      )}
      {isSingleSelected && (
        <>
          <ContextMenuSeparator />
          <OptionsButtons.Share
            variant="context"
            onClick={(e) => {
              e.stopPropagation()
              handleShare()
            }}
          />
          <OptionsButtons.SongInfo
            variant="context"
            onClick={(e) => {
              e.stopPropagation()
              handleSongInfoOption()
            }}
          />
        </>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem disabled inset>
        {t('table.menu.selectedCount', { count: rows.length })}
      </ContextMenuItem>
    </>
  )
}
