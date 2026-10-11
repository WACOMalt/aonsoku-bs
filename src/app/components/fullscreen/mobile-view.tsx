import clsx from 'clsx'
import {
  ChevronDown,
  Disc3,
  Info,
  ListMusic,
  MicVocal,
  MoreHorizontal,
  Pause,
  Play,
  Repeat,
  Share2,
  Shuffle,
  SkipBack,
  SkipForward,
  User,
} from 'lucide-react'
import { ReactNode, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import RepeatOne from '@/app/components/icons/repeat-one'
import { ImageLoader } from '@/app/components/image-loader'
import { OptionsButtons } from '@/app/components/options/buttons'
import { DevicePicker } from '@/app/components/player/device-picker'
import { JamButton } from '@/app/components/player/jam-button'
import { AddToPlaylistSubMenu } from '@/app/components/song/add-to-playlist'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/app/components/ui/dropdown-menu'
import { useOptions } from '@/app/hooks/use-options'
import { useSwipe } from '@/app/hooks/use-swipe'
import { ROUTES } from '@/routes/routesList'
import { useAppStore } from '@/store/app.store'
import {
  usePlayerActions,
  usePlayerFullscreen,
  usePlayerIsPlaying,
  usePlayerLoop,
  usePlayerPrevAndNext,
  usePlayerShuffle,
  usePlayerSongStarred,
  usePlayerStore,
} from '@/store/player.store'
import { LoopState } from '@/types/playerContext'
import { pushBackHandler } from '@/utils/androidBackButton'
import { shareItem } from '@/utils/shareLinks'
import { LyricsTab } from './lyrics'
import { MarqueeTitle } from './marquee-title'
import { FullscreenProgress } from './progress'
import { FullscreenSongQueue } from './queue'
import { FullscreenSettings } from './settings'

type View = 'playing' | 'queue' | 'lyrics'

/**
 * The full player on phones, laid out like Spotify's: a header saying what
 * is playing from, big artwork, the title with a like button, a wide
 * transport row and a footer for devices, sharing, the queue and lyrics.
 * Sideways, the artwork (or queue, or lyrics) moves to the left half.
 */
export function MobileFullscreen() {
  const [view, setView] = useState<View>('playing')
  const { setIsFullscreen } = usePlayerFullscreen()
  const { playNextSong, playPrevSong } = usePlayerActions()
  const { hasPrev, hasNext } = usePlayerPrevAndNext()
  const loopState = usePlayerLoop()

  const toggleView = (next: View) =>
    setView((current) => (current === next ? 'playing' : next))

  // Android back from the queue or lyrics returns to the artwork first.
  useEffect(() => {
    if (view === 'playing') return
    return pushBackHandler(() => {
      setView('playing')
      return true
    }, 20)
  }, [view])

  const artSwipe = useSwipe({
    onSwipeLeft: () =>
      (hasNext || loopState === LoopState.All) && playNextSong(),
    onSwipeRight: () => hasPrev && playPrevSong(),
    onSwipeDown: () => setIsFullscreen(false),
    threshold: 60,
  })
  const closeSwipe = useSwipe({
    onSwipeDown: () => setIsFullscreen(false),
    threshold: 60,
  })

  return (
    <div className="absolute inset-0 z-10 flex flex-col landscape:flex-row gap-4 landscape:gap-8 px-6 landscape:px-8 pt-3 pb-[calc(1.25rem+env(safe-area-inset-bottom))] landscape:pt-4 landscape:pb-[calc(1rem+env(safe-area-inset-bottom))] overflow-hidden">
      <div className="landscape:hidden" {...closeSwipe}>
        <Header />
      </div>

      <div
        className="flex-1 min-h-0 landscape:flex-none landscape:w-[45%] landscape:h-full"
        {...(view === 'playing' ? artSwipe : {})}
      >
        {view === 'playing' && <Artwork />}
        {view === 'queue' && (
          <div className="h-full overflow-y-auto -mx-2">
            <FullscreenSongQueue />
          </div>
        )}
        {view === 'lyrics' && (
          <div className="h-full overflow-y-auto">
            <LyricsTab />
          </div>
        )}
      </div>

      <div className="shrink-0 flex flex-col gap-3 landscape:flex-1 landscape:min-w-0 landscape:justify-center">
        <div className="hidden landscape:block" {...closeSwipe}>
          <Header />
        </div>
        <Details />
        <FullscreenProgress layout="stacked" />
        <Transport />
        <Footer view={view} onToggleView={toggleView} />
      </div>
    </div>
  )
}

function Header() {
  const { t } = useTranslation()
  const { setIsFullscreen } = usePlayerFullscreen()
  const source = usePlayerStore(
    (state) => state.playerState.playbackContext.source,
  )
  const song = usePlayerStore((state) => state.songlist.currentSong)

  const label = source
    ? t(`fullscreen.playingFrom.${source.type}`)
    : t('fullscreen.nowPlaying')
  const name = source?.name ?? song?.album

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => setIsFullscreen(false)}
        aria-label={t('fullscreen.close')}
        className="size-10 -ml-2 flex items-center justify-center shrink-0"
      >
        <ChevronDown className="size-7" />
      </button>
      <div className="flex-1 min-w-0 text-center">
        <p className="text-[11px] uppercase tracking-wider text-foreground/70 truncate">
          {label}
        </p>
        {name && (
          <p className="text-sm font-semibold truncate leading-tight">{name}</p>
        )}
      </div>
      <MoreMenu />
    </div>
  )
}

function MoreMenu() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const hidePlaylistsSection = useAppStore().pages.hidePlaylistsSection
  const { setIsFullscreen } = usePlayerFullscreen()
  const song = usePlayerStore((state) => state.songlist.currentSong)
  const { addToPlaylist, createNewPlaylist, openSongInfo } = useOptions()

  if (!song?.id) {
    return <div className="size-10 -mr-2 shrink-0" />
  }

  const goTo = (path: string) => {
    setIsFullscreen(false)
    navigate(path)
  }

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('fullscreen.more')}
          className="size-10 -mr-2 flex items-center justify-center shrink-0"
        >
          <MoreHorizontal className="size-6" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        {!hidePlaylistsSection && (
          <>
            <OptionsButtons.AddToPlaylistOption variant="dropdown">
              <AddToPlaylistSubMenu
                type="dropdown"
                newPlaylistFn={() => createNewPlaylist(song.title, song.id)}
                addToPlaylistFn={(id) => addToPlaylist(id, song.id)}
              />
            </OptionsButtons.AddToPlaylistOption>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onClick={() => goTo(ROUTES.ALBUM.PAGE(song.albumId))}>
          <Disc3 className="mr-2 size-4" />
          {t('fullscreen.goToAlbum')}
        </DropdownMenuItem>
        {song.artistId && (
          <DropdownMenuItem
            onClick={() => goTo(ROUTES.ARTIST.PAGE(song.artistId!))}
          >
            <User className="mr-2 size-4" />
            {t('fullscreen.goToArtist')}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() =>
            shareItem(
              { type: 'song', id: song.id },
              [song.title, song.artist].filter(Boolean).join(' - '),
            )
          }
        >
          <Share2 className="mr-2 size-4" />
          {t('options.share')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => openSongInfo(song.id)}>
          <Info className="mr-2 size-4" />
          {t('options.info')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Square artwork as large as the space allows, whatever its shape. */
function Artwork() {
  const song = usePlayerStore((state) => state.songlist.currentSong)
  const boxRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState(0)

  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setSize(Math.floor(Math.min(width, height)))
    })
    observer.observe(box)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={boxRef} className="size-full flex items-center justify-center">
      {song?.coverArt && size > 0 && (
        <div
          className="rounded-lg overflow-hidden shadow-2xl bg-accent/60"
          style={{ width: size, height: size }}
        >
          <ImageLoader id={song.coverArt} type="song" size={800}>
            {(src) => (
              <img
                src={src}
                alt={`${song.artist} - ${song.title}`}
                className="size-full object-cover"
                draggable={false}
              />
            )}
          </ImageLoader>
        </div>
      )}
    </div>
  )
}

function Details() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const hideFavoritesSection = useAppStore().pages.hideFavoritesSection
  const song = usePlayerStore((state) => state.songlist.currentSong)
  const isStarred = usePlayerSongStarred()
  const { starCurrentSong } = usePlayerActions()
  const { setIsFullscreen } = usePlayerFullscreen()

  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <MarqueeTitle gap="mr-6">
          <h2 className="text-2xl font-bold tracking-tight leading-tight text-shadow-md">
            {song?.title}
          </h2>
        </MarqueeTitle>
        <button
          type="button"
          className="text-base text-foreground/70 truncate max-w-full text-left"
          disabled={!song?.artistId}
          onClick={() => {
            if (!song?.artistId) return
            setIsFullscreen(false)
            navigate(ROUTES.ARTIST.PAGE(song.artistId))
          }}
        >
          {song?.artist}
        </button>
      </div>
      {!hideFavoritesSection && (
        <button
          type="button"
          onClick={starCurrentSong}
          aria-label={t('player.like')}
          className="size-11 -mr-2 flex items-center justify-center shrink-0"
        >
          <HeartIcon filled={isStarred} />
        </button>
      )}
    </div>
  )
}

function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={clsx(
        'size-7',
        filled ? 'fill-primary text-primary' : 'fill-none text-foreground',
      )}
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
    </svg>
  )
}

function Transport() {
  const { t } = useTranslation()
  const isPlaying = usePlayerIsPlaying()
  const isShuffleActive = usePlayerShuffle()
  const loopState = usePlayerLoop()
  const { hasPrev, hasNext } = usePlayerPrevAndNext()
  const {
    isPlayingOneSong,
    toggleShuffle,
    playNextSong,
    playPrevSong,
    togglePlayPause,
    toggleLoop,
  } = usePlayerActions()

  return (
    <div className="flex items-center justify-between">
      <ToggleButton
        active={isShuffleActive}
        onClick={toggleShuffle}
        disabled={isPlayingOneSong() || !hasNext}
        label={t('player.tooltips.shuffle.enable')}
      >
        <Shuffle className="size-6" />
      </ToggleButton>
      <button
        type="button"
        onClick={playPrevSong}
        disabled={!hasPrev}
        aria-label={t('player.tooltips.previous')}
        className="size-12 flex items-center justify-center disabled:opacity-40"
      >
        <SkipBack className="size-8 fill-current" />
      </button>
      <button
        type="button"
        onClick={togglePlayPause}
        aria-label={
          isPlaying ? t('player.tooltips.pause') : t('player.tooltips.play')
        }
        className="size-16 rounded-full bg-foreground text-background flex items-center justify-center shadow-lg active:scale-95 transition-transform"
      >
        {isPlaying ? (
          <Pause className="size-7 fill-current" strokeWidth={0} />
        ) : (
          <Play className="size-7 fill-current ml-1" strokeWidth={0} />
        )}
      </button>
      <button
        type="button"
        onClick={playNextSong}
        disabled={!hasNext && loopState !== LoopState.All}
        aria-label={t('player.tooltips.next')}
        className="size-12 flex items-center justify-center disabled:opacity-40"
      >
        <SkipForward className="size-8 fill-current" />
      </button>
      <ToggleButton
        active={loopState !== LoopState.Off}
        onClick={toggleLoop}
        label={t('player.tooltips.repeat.enable')}
      >
        {loopState === LoopState.One ? (
          <RepeatOne className="size-6" size={24} />
        ) : (
          <Repeat className="size-6" />
        )}
      </ToggleButton>
    </div>
  )
}

/** Green with a dot underneath while on, like Spotify's shuffle and repeat. */
function ToggleButton({
  active,
  onClick,
  disabled,
  label,
  children,
}: {
  active: boolean
  onClick: () => void
  disabled?: boolean
  label: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      className={clsx(
        'relative size-11 flex items-center justify-center disabled:opacity-40',
        active ? 'text-primary' : 'text-foreground',
      )}
    >
      {children}
      {active && (
        <span className="absolute bottom-0.5 size-1 rounded-full bg-primary" />
      )}
    </button>
  )
}

function Footer({
  view,
  onToggleView,
}: {
  view: View
  onToggleView: (view: View) => void
}) {
  const { t } = useTranslation()
  const song = usePlayerStore((state) => state.songlist.currentSong)

  return (
    <div className="flex items-center justify-between -mx-2 [&_button]:text-foreground">
      <div className="flex items-center">
        <DevicePicker />
        <JamButton />
        <div className="[&_button]:!size-10 [&_svg]:!size-5">
          <FullscreenSettings />
        </div>
      </div>
      <div className="flex items-center">
        {song?.id && (
          <FooterButton
            label={t('options.share')}
            onClick={() =>
              shareItem(
                { type: 'song', id: song.id },
                [song.title, song.artist].filter(Boolean).join(' - '),
              )
            }
          >
            <Share2 className="size-5" />
          </FooterButton>
        )}
        <FooterButton
          label={t('fullscreen.queue')}
          active={view === 'queue'}
          onClick={() => onToggleView('queue')}
        >
          <ListMusic className="size-5" />
        </FooterButton>
        <FooterButton
          label={t('fullscreen.lyrics')}
          active={view === 'lyrics'}
          onClick={() => onToggleView('lyrics')}
        >
          <MicVocal className="size-5" />
        </FooterButton>
      </div>
    </div>
  )
}

function FooterButton({
  label,
  active = false,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={clsx(
        'size-10 flex items-center justify-center rounded-full',
        active && '!text-primary',
      )}
    >
      {children}
    </button>
  )
}
