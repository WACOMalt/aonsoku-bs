import { OptionsButtons } from '@/app/components/options/buttons'
import { DownloadOptionHandler } from '@/app/components/options/download-handler'
import { KeepCachedOption } from '@/app/components/options/keep-cached-option'
import { ContextMenuSeparator } from '@/app/components/ui/context-menu'
import { songFileName, useOptions } from '@/app/hooks/use-options'
import { useAppStore } from '@/store/app.store'
import { ISong } from '@/types/responses/song'
import { shareItem } from '@/utils/shareLinks'
import { AddToPlaylistSubMenu } from './add-to-playlist'

interface SongMenuOptionsProps {
  variant: 'context' | 'dropdown'
  song: ISong
  index: number
}

export function SongMenuOptions({
  variant,
  song,
  index,
}: SongMenuOptionsProps) {
  const {
    playNext,
    playLast,
    createNewPlaylist,
    addToPlaylist,
    removeSongFromPlaylist,
    startDownload,
    openSongInfo,
    isOnPlaylistPage,
  } = useOptions()
  const hidePlaylistsSection = useAppStore().pages.hidePlaylistsSection
  const songIndexes = [index.toString()]

  return (
    <>
      <OptionsButtons.PlayNext
        variant={variant}
        onClick={(e) => {
          e.stopPropagation()
          playNext([song])
        }}
      />
      <OptionsButtons.PlayLast
        variant={variant}
        onClick={(e) => {
          e.stopPropagation()
          playLast([song])
        }}
      />
      {!hidePlaylistsSection && (
        <>
          <ContextMenuSeparator />
          <OptionsButtons.AddToPlaylistOption variant={variant}>
            <AddToPlaylistSubMenu
              type={variant}
              newPlaylistFn={() => createNewPlaylist(song.title, song.id)}
              addToPlaylistFn={(id) => addToPlaylist(id, song.id)}
            />
          </OptionsButtons.AddToPlaylistOption>
        </>
      )}
      {isOnPlaylistPage && (
        <OptionsButtons.RemoveFromPlaylist
          variant={variant}
          onClick={(e) => {
            e.stopPropagation()
            removeSongFromPlaylist(songIndexes)
          }}
        />
      )}
      <DownloadOptionHandler context={true}>
        <OptionsButtons.Download
          variant={variant}
          onClick={(e) => {
            e.stopPropagation()
            startDownload(song.id, songFileName(song))
          }}
        />
      </DownloadOptionHandler>
      <KeepCachedOption
        kind="song"
        id={song.id}
        song={song}
        variant={variant}
      />
      <ContextMenuSeparator />
      <OptionsButtons.Share
        variant={variant}
        onClick={(e) => {
          e.stopPropagation()
          shareItem(
            { type: 'song', id: song.id },
            [song.title, song.artist].filter(Boolean).join(' - '),
          )
        }}
      />
      <OptionsButtons.SongInfo
        variant={variant}
        onClick={(e) => {
          e.stopPropagation()
          openSongInfo(song.id)
        }}
      />
    </>
  )
}
