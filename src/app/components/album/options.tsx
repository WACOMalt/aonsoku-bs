import { OptionsButtons } from '@/app/components/options/buttons'
import { DownloadOptionHandler } from '@/app/components/options/download-handler'
import { KeepCachedOption } from '@/app/components/options/keep-cached-option'
import { AddToPlaylistSubMenu } from '@/app/components/song/add-to-playlist'
import {
  DropdownMenuGroup,
  DropdownMenuSeparator,
} from '@/app/components/ui/dropdown-menu'
import { useOptions } from '@/app/hooks/use-options'
import { useAppStore } from '@/store/app.store'
import { SingleAlbum } from '@/types/responses/album'
import { shareItem } from '@/utils/shareLinks'

interface AlbumOptionsProps {
  album: SingleAlbum
}

export function AlbumOptions({ album }: AlbumOptionsProps) {
  const hidePlaylistsSection = useAppStore().pages.hidePlaylistsSection
  const {
    playNext,
    playLast,
    startDownload,
    addToPlaylist,
    createNewPlaylist,
  } = useOptions()

  function handlePlayNext() {
    playNext(album.song)
  }

  function handlePlayLast() {
    playLast(album.song)
  }

  function handleDownload() {
    startDownload(album.id, `${album.name}.zip`)
  }

  function handleAddToPlaylist(id: string) {
    const songIdToAdd = album.song.map((song) => song.id)

    addToPlaylist(id, songIdToAdd)
  }

  function handleShare() {
    shareItem(
      { type: 'album', id: album.id },
      [album.name, album.artist].filter(Boolean).join(' - '),
    )
  }

  function handleCreateNewPlaylist() {
    const songIdToAdd = album.song.map((song) => song.id)

    createNewPlaylist(album.name, songIdToAdd)
  }

  return (
    <>
      <DropdownMenuGroup>
        <OptionsButtons.PlayNext onClick={handlePlayNext} />
        <OptionsButtons.PlayLast onClick={handlePlayLast} />
      </DropdownMenuGroup>
      {!hidePlaylistsSection && (
        <>
          <DropdownMenuSeparator />
          <OptionsButtons.AddToPlaylistOption variant="dropdown">
            <AddToPlaylistSubMenu
              type="dropdown"
              newPlaylistFn={handleCreateNewPlaylist}
              addToPlaylistFn={handleAddToPlaylist}
            />
          </OptionsButtons.AddToPlaylistOption>
        </>
      )}
      <DownloadOptionHandler>
        <OptionsButtons.Download onClick={handleDownload} />
      </DownloadOptionHandler>
      <KeepCachedOption kind="album" id={album.id} />
      <DropdownMenuSeparator />
      <OptionsButtons.Share onClick={handleShare} />
    </>
  )
}
