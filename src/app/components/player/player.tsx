import {
  memo,
  RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { getProxyURL } from '@/api/podcastClient'
import { MiniPlayerButton } from '@/app/components/mini-player/button'
import { RadioInfo } from '@/app/components/player/radio-info'
import { TrackInfo } from '@/app/components/player/track-info'
import { podcasts } from '@/service/podcasts'
import { useAppStore } from '@/store/app.store'
import { useCanOutputAudio } from '@/store/connect.store'
import {
  getVolume,
  useGaplessSettings,
  usePlayerActions,
  usePlayerIsPlaying,
  usePlayerMediaType,
  usePlayerRef,
  usePlayerSonglist,
  usePlayerStore,
} from '@/store/player.store'
import { hasPiPSupport } from '@/utils/browser'
import { logger } from '@/utils/logger'
import { usesNativeSongPlayer } from '@/utils/nativePlayer'
import { AudioPlayer } from './audio'
import { PlayerClearQueueButton } from './clear-queue-button'
import { ControllerBanner } from './controller-banner'
import { PlayerControls } from './controls'
import { DevicePicker } from './device-picker'
import { PlayerExpandButton } from './expand-button'
import { JamButton } from './jam-button'
import { PlayerLikeButton } from './like-button'
import { PlayerLyricsButton } from './lyrics-button'
import { MobilePlayer } from './mobile-player'
import { NativeSongAudio } from './native-song-audio'
import { PodcastInfo } from './podcast-info'
import { PodcastPlaybackRate } from './podcast-playback-rate'
import { PlayerProgress } from './progress'
import { PlayerQueueButton } from './queue-button'
import { SongAudio } from './song-audio'
import { PlayerVolume } from './volume'

const MemoTrackInfo = memo(TrackInfo)
const MemoRadioInfo = memo(RadioInfo)
const MemoPodcastInfo = memo(PodcastInfo)
const MemoPlayerControls = memo(PlayerControls)
const MemoPlayerProgress = memo(PlayerProgress)
const MemoPlayerLikeButton = memo(PlayerLikeButton)
const MemoPlayerQueueButton = memo(PlayerQueueButton)
const MemoPlayerClearQueueButton = memo(PlayerClearQueueButton)
const MemoPlayerVolume = memo(PlayerVolume)
const MemoJamButton = memo(JamButton)
const MemoDevicePicker = memo(DevicePicker)
const MemoControllerBanner = memo(ControllerBanner)
const MemoPlayerExpandButton = memo(PlayerExpandButton)
const MemoPodcastPlaybackRate = memo(PodcastPlaybackRate)
const MemoLyricsButton = memo(PlayerLyricsButton)
const MemoMiniPlayerButton = memo(MiniPlayerButton)
const MemoMobilePlayer = memo(MobilePlayer)

export function Player() {
  const hideFavoritesSection = useAppStore().pages.hideFavoritesSection
  // Points at whichever song element is playing (see SongAudio).
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const radioRef = useRef<HTMLAudioElement>(null)
  const podcastRef = useRef<HTMLAudioElement>(null)
  const {
    setAudioPlayerRef,
    setCurrentDuration,
    setProgress,
    setPlayingState,
    handleSongEnded,
    getCurrentProgress,
    getCurrentPodcastProgress,
  } = usePlayerActions()
  const { currentList, currentSongIndex, radioList, podcastList } =
    usePlayerSonglist()
  const isPlaying = usePlayerIsPlaying()
  const { isSong, isRadio, isPodcast } = usePlayerMediaType()
  const audioPlayerRef = usePlayerRef()
  const currentPlaybackRate = usePlayerStore().playerState.currentPlaybackRate
  const canOutputAudio = useCanOutputAudio()
  const { enabled: gaplessEnabled } = useGaplessSettings()
  // The Android app plays songs natively (see NativeSongAudio).
  const nativeSongs = usesNativeSongPlayer(canOutputAudio, gaplessEnabled)

  const song = currentList[currentSongIndex]

  const layoutRef = useRef<HTMLDivElement>(null)
  const buttonsRef = useRef<HTMLDivElement>(null)
  const buttonsLayout = useButtonsLayout(layoutRef, buttonsRef)

  const radio = radioList[currentSongIndex]
  const podcast = podcastList[currentSongIndex]

  const getAudioRef = useCallback(() => {
    if (isRadio) return radioRef
    if (isPodcast) return podcastRef

    return audioRef
  }, [isPodcast, isRadio])

  // biome-ignore lint/correctness/useExhaustiveDependencies: audioRef needed
  useEffect(() => {
    if (!isSong && !song) return

    if (audioPlayerRef === null && audioRef.current)
      setAudioPlayerRef(audioRef.current)
  }, [audioPlayerRef, audioRef, isSong, setAudioPlayerRef, song])

  useEffect(() => {
    const audio = podcastRef.current
    if (!audio || !isPodcast) return

    audio.playbackRate = currentPlaybackRate
  }, [currentPlaybackRate, isPodcast])

  const setupDuration = useCallback(() => {
    const audio = getAudioRef().current
    if (!audio) return

    const audioDuration = Math.floor(audio.duration)
    const infinityDuration = audioDuration === Infinity

    if (!infinityDuration) {
      setCurrentDuration(audioDuration)
    } else if (isSong && song?.duration) {
      setCurrentDuration(song.duration)
    }

    if (isPodcast && infinityDuration && podcast) {
      setCurrentDuration(podcast.duration)
    }

    if (isPodcast) {
      const podcastProgress = getCurrentPodcastProgress()

      logger.info('[Player] - Resuming episode from:', {
        seconds: podcastProgress,
      })

      setProgress(podcastProgress)
      audio.currentTime = podcastProgress
    } else {
      const progress = getCurrentProgress()
      audio.currentTime = progress
    }
  }, [
    getAudioRef,
    isPodcast,
    isSong,
    song,
    podcast,
    setCurrentDuration,
    getCurrentPodcastProgress,
    setProgress,
    getCurrentProgress,
  ])

  const setupProgress = useCallback(() => {
    const audio = getAudioRef().current
    if (!audio) return

    const currentProgress = Math.floor(audio.currentTime)
    setProgress(currentProgress)
  }, [getAudioRef, setProgress])

  const setupInitialVolume = useCallback(() => {
    const audio = getAudioRef().current
    if (!audio) return

    audio.volume = getVolume() / 100
  }, [getAudioRef])

  const sendFinishProgress = useCallback(() => {
    if (!isPodcast || !podcast) return

    podcasts
      .saveEpisodeProgress(podcast.id, podcast.duration)
      .then(() => {
        logger.info('Complete progress sent:', podcast.duration)
      })
      .catch((error) => {
        logger.error('Error sending complete progress', error)
      })
  }, [isPodcast, podcast])

  return (
    <>
      {/* On phones the player card says where Connect is playing instead. */}
      <div className="compact:hidden">
        <MemoControllerBanner />
      </div>
      <footer className="border-t h-[--player-height] w-full fixed bottom-0 left-0 right-0 z-40 bg-background compact:border-t-0 compact:bg-transparent compact:bottom-[--bottom-nav-height]">
        {/* Phone player: a floating card above the tab bar */}
        <div className="hidden compact:block h-full">
          <MemoMobilePlayer />
        </div>

        {/* Desktop player layout */}
        <div
          ref={layoutRef}
          className="w-full h-full hidden md:grid compact:hidden gap-2 px-4 items-center"
          style={{
            gridTemplateColumns: `minmax(${buttonsLayout.side}px, 1fr) minmax(0, ${CENTER_MAX_WIDTH}px) minmax(${buttonsLayout.side}px, 1fr)`,
          }}
        >
          {/* Track Info */}
          <div className="flex items-center gap-2 w-full min-w-0">
            {isSong && <MemoTrackInfo song={song} />}
            {isRadio && <MemoRadioInfo radio={radio} />}
            {isPodcast && <MemoPodcastInfo podcast={podcast} />}
          </div>
          {/* Main Controls */}
          <div className="flex flex-col justify-center items-center px-2 gap-1 min-w-0">
            <MemoPlayerControls
              song={song}
              radio={radio}
              podcast={podcast}
              audioRef={getAudioRef()}
            />

            {(isSong || isPodcast) && (
              <MemoPlayerProgress audioRef={getAudioRef()} />
            )}
          </div>
          {/* Remain Controls and Volume: wrap onto a second line rather
              than run into the controls when the window is narrow. */}
          <div className="flex items-center w-full min-w-0 justify-end">
            <div
              ref={buttonsRef}
              className="flex flex-wrap items-center justify-end gap-1"
            >
              {isSong && !hideFavoritesSection && (
                <MemoPlayerLikeButton disabled={!song} />
              )}
              {isSong && (
                <>
                  <MemoLyricsButton disabled={!song} />
                  <MemoPlayerQueueButton disabled={!song} />
                </>
              )}
              {isPodcast && <MemoPodcastPlaybackRate />}
              {(isRadio || isPodcast) && (
                <MemoPlayerClearQueueButton disabled={!radio && !podcast} />
              )}

              <MemoJamButton />
              <MemoDevicePicker />

              <MemoPlayerVolume
                expanded={buttonsLayout.volumeSlider}
                audioRef={getAudioRef()}
                disabled={!song && !radio && !podcast}
              />

              {isSong && <MemoPlayerExpandButton disabled={!song} />}
              {isSong && hasPiPSupport && <MemoMiniPlayerButton />}
            </div>
          </div>
        </div>

        {isSong &&
          song &&
          (nativeSongs ? (
            <NativeSongAudio audioRef={audioRef} />
          ) : (
            <SongAudio audioRef={audioRef} />
          ))}

        {isRadio && radio && (
          <AudioPlayer
            src={radio.streamUrl}
            autoPlay={isPlaying}
            audioRef={radioRef}
            onPlay={() => setPlayingState(true)}
            onPause={() => setPlayingState(false)}
            onLoadStart={setupInitialVolume}
            data-testid="player-radio-audio"
          />
        )}

        {isPodcast && podcast && (
          <AudioPlayer
            src={getProxyURL(podcast.audio_url)}
            autoPlay={isPlaying}
            audioRef={podcastRef}
            preload="auto"
            onPlay={() => setPlayingState(true)}
            onPause={() => setPlayingState(false)}
            onLoadedMetadata={setupDuration}
            onTimeUpdate={setupProgress}
            onEnded={() => {
              sendFinishProgress()
              handleSongEnded()
            }}
            onLoadStart={setupInitialVolume}
            data-testid="player-podcast-audio"
          />
        )}
      </footer>
    </>
  )
}

// The player's columns: the controls in the middle up to their full width,
// at least this wide on each side for the track info.
const CENTER_MAX_WIDTH = 640
const SIDE_MIN_WIDTH = 250
// Before the buttons on the right wrap, the controls give up width down to
// the transport buttons, or a seekbar this short; the whole until measured.
const SEEKBAR_MIN_WIDTH = 100
const CENTER_MIN_WIDTH = 240
const VOLUME_BUTTON_WIDTH = 40
// The inline volume slider, measured when it shows.
let volumeSliderWidth = 172

type ButtonsLayout = { side: number; volumeSlider: boolean }

/**
 * Lays out the buttons on the right of the desktop player from the room
 * there is. The side columns stay equal so the controls stay centred; they
 * take the width the buttons need, and the controls give up width (the
 * progress bar shrinks) before the buttons wrap. When they do wrap, they
 * split evenly over two lines. The volume shows as an inline slider only
 * when it fits beside the controls at their full width.
 */
function useButtonsLayout(
  layoutRef: RefObject<HTMLDivElement>,
  rowRef: RefObject<HTMLDivElement>,
) {
  const [layout, setLayout] = useState<ButtonsLayout>({
    side: SIDE_MIN_WIDTH,
    volumeSlider: false,
  })

  useLayoutEffect(() => {
    const grid = layoutRef.current
    const row = rowRef.current
    if (!grid || !row) return

    const update = () => {
      const gridStyle = getComputedStyle(grid)
      const width =
        grid.clientWidth -
        Number.parseFloat(gridStyle.paddingLeft) -
        Number.parseFloat(gridStyle.paddingRight)
      // Hidden: the phone layout is showing.
      if (width <= 0) return
      const columnGap = Number.parseFloat(gridStyle.columnGap) || 0
      const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0

      // Each button's width, with the volume as a plain button.
      const widths: number[] = []
      for (const item of [...row.children] as HTMLElement[]) {
        let itemWidth = item.getBoundingClientRect().width
        if (item.dataset.playerVolume !== undefined) {
          if (item.dataset.expanded === 'true') volumeSliderWidth = itemWidth
          itemWidth = VOLUME_BUTTON_WIDTH
        }
        if (itemWidth > 0) widths.push(itemWidth)
      }
      const lineWidth = (items: number[]) =>
        items.reduce((sum, itemWidth) => sum + itemWidth, 0) +
        gap * Math.max(0, items.length - 1)
      const natural = lineWidth(widths)
      const withSlider = natural - VOLUME_BUTTON_WIDTH + volumeSliderWidth

      const spare = width - 2 * columnGap
      const centerMin = measureCenterMinWidth(grid) ?? CENTER_MIN_WIDTH
      const volumeSlider =
        spare - CENTER_MAX_WIDTH >= 2 * Math.max(SIDE_MIN_WIDTH, withSlider)
      const wanted = Math.max(
        SIDE_MIN_WIDTH,
        volumeSlider ? withSlider : natural,
      )
      const room = Math.max(SIDE_MIN_WIDTH, Math.floor((spare - centerMin) / 2))
      let side = Math.min(wanted, room)

      // Not enough room even so: two even lines, and the column only as
      // wide as they are, so the seekbar gets the rest.
      let maxWidth = ''
      if (!volumeSlider && natural > side) {
        const firstLine = widths.slice(0, Math.ceil(widths.length / 2))
        const secondLine = widths.slice(firstLine.length)
        const wrapped = Math.ceil(
          Math.max(lineWidth(firstLine), lineWidth(secondLine)) + 1,
        )
        maxWidth = `${wrapped}px`
        side = Math.max(SIDE_MIN_WIDTH, wrapped)
      }
      if (row.style.maxWidth !== maxWidth) row.style.maxWidth = maxWidth

      setLayout((previous) =>
        previous.side === side && previous.volumeSlider === volumeSlider
          ? previous
          : { side, volumeSlider },
      )
    }

    const observer = new ResizeObserver(update)
    observer.observe(grid)
    observer.observe(row)
    // Buttons come and go (radio, podcasts, Connect, Jam).
    const mutations = new MutationObserver(update)
    mutations.observe(row, { childList: true })
    update()
    return () => {
      observer.disconnect()
      mutations.disconnect()
    }
  }, [layoutRef, rowRef])

  return layout
}

/**
 * The narrowest the player's controls go: the transport buttons, or the
 * seekbar row with the seekbar at its shortest, with the controls' padding.
 */
function measureCenterMinWidth(grid: HTMLElement) {
  const center = grid.children[1] as HTMLElement | undefined
  if (!center) return null
  const [transport, seekbarRow] = [...center.children] as HTMLElement[]
  if (!transport) return null

  const rowWidth = (row: HTMLElement, flexible?: Element) => {
    const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0
    const items = [...row.children].filter(
      (item) => item.getBoundingClientRect().width > 0 || item === flexible,
    )
    return (
      items.reduce(
        (sum, item) =>
          sum +
          (item === flexible
            ? SEEKBAR_MIN_WIDTH
            : item.getBoundingClientRect().width),
        0,
      ) +
      gap * Math.max(0, items.length - 1)
    )
  }

  const slider = seekbarRow?.querySelector(
    '[data-testid=player-progress-slider], .pointer-events-none',
  )
  const seekbar =
    slider && seekbarRow
      ? [...seekbarRow.children].find((item) => item.contains(slider))
      : undefined
  const needed = Math.max(
    rowWidth(transport),
    seekbarRow && seekbar ? rowWidth(seekbarRow, seekbar) : 0,
  )
  const centerStyle = getComputedStyle(center)
  return Math.ceil(
    needed +
      Number.parseFloat(centerStyle.paddingLeft) +
      Number.parseFloat(centerStyle.paddingRight),
  )
}
