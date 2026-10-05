import {
  MutableRefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'react-toastify'
import { getSimpleCoverArtUrl, getSongStreamUrl } from '@/api/httpClient'
import { useAppMediaCache } from '@/store/app.store'
import { useCarStore } from '@/store/car.store'
import {
  getVolume,
  usePlayerActions,
  usePlayerIsPlaying,
  usePlayerLoop,
  usePlayerSonglist,
  usePlayerStore,
  useReplayGainState,
} from '@/store/player.store'
import { LoopState } from '@/types/playerContext'
import { ISong } from '@/types/responses/song'
import { ensureSupportForAlac } from '@/utils/alac'
import { logger } from '@/utils/logger'
import { NativeItem, NativePlayer } from '@/utils/nativePlayer'
import { calculateReplayGain, replayGainParamsFor } from '@/utils/replayGain'

/** An item the native player holds. */
type Entry = { key: string; songId: string; item: NativeItem }

/**
 * The tracks the native player holds: the current one, the one before it,
 * and a stretch of the queue after it.
 */
type Held = {
  previous: Entry | null
  current: Entry | null
  upcoming: Entry[]
}

const NOTHING_HELD: Held = { previous: null, current: null, upcoming: [] }

/**
 * How many upcoming tracks the native player holds. If this page stalls in
 * the background, playback goes on through these before it stops.
 */
const UPCOMING_LIMIT = 25

/** The last position the native player reported, to extrapolate from. */
type Clock = {
  key: string
  positionMs: number
  durationMs: number
  playing: boolean
  /** The native player has the track buffered (not loading). */
  ready: boolean
  at: number
}

// ExoPlayer's Player.STATE_READY.
const STATE_READY = 3

// Ignore position reports this long after a seek (they can predate it),
// unless they already show the new position.
const SEEK_SETTLE_MS = 400

let keyCounter = 0

interface NativeSongAudioProps {
  /** Set to a stand-in for an audio element (see createElementShim). */
  audioRef: MutableRefObject<HTMLAudioElement | null>
}

/**
 * Song playback in the Android app, through the native player. It holds the
 * current track, the one before it and a stretch of the queue after it; it
 * preloads the next and joins onto it without a gap, even with the screen
 * off. The queue stays here: whenever the native player moves (by itself,
 * or from the notification or a headset, which it handles without waiting
 * for this page), the queue follows and the held tracks are brought up to
 * date.
 */
export function NativeSongAudio({ audioRef }: NativeSongAudioProps) {
  const { t } = useTranslation()
  const { currentList, currentSongIndex } = usePlayerSonglist()
  const isPlaying = usePlayerIsPlaying()
  const loopState = usePlayerLoop()
  const mediaCacheEnabled = useAppMediaCache()
  const {
    replayGainEnabled,
    replayGainError,
    replayGainType,
    replayGainPreAmp,
    replayGainDefaultGain,
  } = useReplayGainState()
  const {
    setAudioPlayerRef,
    setCurrentDuration,
    setProgress,
    setPlayingState,
    handleSongEnded,
    getCurrentProgress,
    playNextSong,
    playPrevSong,
  } = usePlayerActions()

  const song = currentList[currentSongIndex] as ISong | undefined
  const upcomingSongs = useMemo(
    () => getUpcomingSongs(currentList, currentSongIndex, loopState),
    [currentList, currentSongIndex, loopState],
  )
  const upcomingIds = upcomingSongs.map((track) => track.id).join(',')
  const prevSong =
    currentSongIndex > 0 ? currentList[currentSongIndex - 1] : undefined

  const held = useRef<Held>(NOTHING_HELD)
  const clock = useRef<Clock>({
    key: '',
    positionMs: 0,
    durationMs: -1,
    playing: false,
    ready: false,
    at: 0,
  })
  const seekGuard = useRef({ until: 0, targetMs: 0 })

  // Latest values for the one-time listeners and the load effect.
  const live = useRef({ isPlaying, loopState, song, upcomingSongs, prevSong })
  live.current = { isPlaying, loopState, song, upcomingSongs, prevSong }

  const shim = useMemo(() => createElementShim(clock, seekGuard), [])

  const makeEntry = useCallback(
    (track: ISong): Entry => {
      const gain =
        replayGainEnabled && !replayGainError
          ? calculateReplayGain(
              replayGainParamsFor(track, {
                type: replayGainType,
                preAmp: replayGainPreAmp,
                defaultGain: replayGainDefaultGain,
              }),
            )
          : 1
      const key = `${track.id}#${++keyCounter}`
      const item: NativeItem = {
        key,
        url: getSongStreamUrl(
          track.id,
          undefined,
          ensureSupportForAlac(track.suffix),
          mediaCacheEnabled ? undefined : Date.now().toString(),
        ),
        title: track.title ?? '',
        artist: track.artist ?? '',
        album: track.album ?? '',
        artworkUrl: track.coverArt
          ? getSimpleCoverArtUrl(track.coverArt, 'song', '512')
          : '',
        durationMs: (track.duration ?? 0) * 1000,
        gain: Number.isFinite(gain) && gain > 0 ? gain : 1,
        song: track,
      }
      return { key, songId: track.id, item }
    },
    [
      mediaCacheEnabled,
      replayGainEnabled,
      replayGainError,
      replayGainType,
      replayGainPreAmp,
      replayGainDefaultGain,
    ],
  )

  const restartClock = useCallback((key: string, positionMs: number) => {
    clock.current = {
      key,
      positionMs,
      durationMs: -1,
      playing: clock.current.playing,
      ready: false,
      at: performance.now(),
    }
  }, [])

  // The shared reference (seeking, sync, lyrics) points at the stand-in.
  useEffect(() => {
    audioRef.current = shim
    setAudioPlayerRef(shim)
    return () => {
      if (audioRef.current === shim) audioRef.current = null
      if (usePlayerStore.getState().playerState.audioPlayerRef === shim) {
        setAudioPlayerRef(null as unknown as HTMLAudioElement)
      }
      // Loaded again from scratch if this mounts again.
      held.current = NOTHING_HELD
      NativePlayer?.stop()
    }
  }, [audioRef, setAudioPlayerRef, shim])

  // Events from the native player.
  // biome-ignore lint/correctness/useExhaustiveDependencies: listeners are registered once
  useEffect(() => {
    if (!NativePlayer) return
    const handles = [
      NativePlayer.addListener('progress', (data) => {
        if (data.key !== held.current.current?.key) return
        const now = performance.now()
        const guard = seekGuard.current
        if (
          now < guard.until &&
          Math.abs(data.positionMs - guard.targetMs) > 1000
        ) {
          return
        }
        clock.current = {
          key: data.key,
          positionMs: data.positionMs,
          durationMs: data.durationMs,
          playing: data.playing,
          ready: data.state === STATE_READY,
          at: now,
        }
        setProgress(Math.floor(data.positionMs / 1000))
        if (data.durationMs > 0) {
          setCurrentDuration(Math.floor(data.durationMs / 1000))
        }
      }),

      // The native player moved by itself (the end of a track, the
      // notification, a headset, or a pick in the car's queue, which can be
      // several tracks ahead); follow it in the queue. A skip made here has
      // already moved the queue.
      NativePlayer.addListener('transition', ({ key }) => {
        const { previous, current, upcoming } = held.current
        const { currentList: list, currentSongIndex: at } =
          usePlayerStore.getState().songlist
        const ahead = upcoming.findIndex((entry) => entry.key === key)
        if (ahead >= 0) {
          const target = upcoming[ahead]
          held.current = {
            previous: ahead > 0 ? upcoming[ahead - 1] : current,
            current: target,
            upcoming: upcoming.slice(ahead + 1),
          }
          restartClock(key, 0)
          if (list[at]?.id !== target.songId) {
            for (let step = 0; step <= ahead; step++) playNextSong()
          }
        } else if (previous?.key === key && current) {
          held.current = {
            previous: null,
            current: previous,
            upcoming: [current, ...upcoming],
          }
          restartClock(key, 0)
          if (list[at]?.id !== previous.songId) playPrevSong()
        }
      }),

      // Played or paused from the notification, a headset, or because
      // another app took over the audio.
      NativePlayer.addListener('playing', ({ playing }) => {
        if (usePlayerStore.getState().playerState.isPlaying !== playing) {
          setPlayingState(playing)
        }
      }),

      NativePlayer.addListener('ended', ({ key }) => {
        if (key && key !== held.current.current?.key) return
        held.current = NOTHING_HELD
        const endedId = live.current.song?.id
        handleSongEnded()
        // Repeating a one-track queue comes back to the same track, which
        // does not count as a change of track; start it again here.
        const state = usePlayerStore.getState()
        const { currentList: list, currentSongIndex: at } = state.songlist
        if (state.playerState.isPlaying && list[at]?.id === endedId) {
          loadRef.current()
        }
      }),

      NativePlayer.addListener('error', (data) => {
        if (data.key && data.key !== held.current.current?.key) return
        logger.error('Native playback error', data)
        toast.error(t('warnings.songError'))
        // Loading the track again (play, or picking it) retries it.
        held.current = NOTHING_HELD
        setPlayingState(false)
      }),

      // From the notification, a headset, or the buttons in the car.
      NativePlayer.addListener('command', ({ action }) => {
        const { actions } = usePlayerStore.getState()
        if (action === 'nexttrack') playNextSong()
        if (action === 'previoustrack') playPrevSong()
        if (action === 'toggleshuffle') actions.toggleShuffle()
        if (action === 'togglerepeat') actions.toggleLoop()
        if (action === 'togglestar') actions.starCurrentSong()
      }),
    ]
    return () => {
      for (const handle of handles) handle.then((h) => h.remove())
    }
  }, [])

  // Starts the current track from the queue's position.
  const loadCurrent = useCallback(() => {
    const { song: track, upcomingSongs: after, prevSong: before } = live.current
    if (!track || !NativePlayer) return

    // Loading replaces whatever the native player holds, a car queue too.
    if (useCarStore.getState().adoption)
      useCarStore.setState({ adoption: null })
    const current = makeEntry(track)
    const previous = before ? makeEntry(before) : null
    const upcoming = after.map(makeEntry)
    held.current = { previous, current, upcoming }
    // Resume where the track was (after a reload, or a synced position).
    const positionMs = getCurrentProgress() * 1000
    restartClock(current.key, positionMs)
    setCurrentDuration(track.duration)
    NativePlayer.load({
      previous: previous?.item,
      current: current.item,
      upcoming: upcoming.map((entry) => entry.item),
      positionMs,
      playWhenReady: live.current.isPlaying,
      repeatOne: live.current.loopState === LoopState.One,
      volume: getVolume() / 100,
    })
  }, [getCurrentProgress, makeEntry, restartClock, setCurrentDuration])
  const loadRef = useRef(loadCurrent)
  loadRef.current = loadCurrent

  // Android Auto started a list, which the native player is playing (see
  // service/car.ts). Once the queue here has it, take over the song that
  // plays, under the native player's key, without loading it again, and
  // hand it this queue's tracks around it.
  const carAdoption = useCarStore((state) => state.adoption)
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the adoption
  useEffect(() => {
    if (!carAdoption || !song || !NativePlayer) return
    if (carAdoption.songId !== song.id) return
    useCarStore.setState({ adoption: null })

    const entry = makeEntry(song)
    const current: Entry = {
      key: carAdoption.key,
      songId: song.id,
      item: { ...entry.item, key: carAdoption.key },
    }
    held.current = { previous: null, current, upcoming: [] }
    restartClock(carAdoption.key, carAdoption.positionMs)
    setCurrentDuration(song.duration)
    NativePlayer.adoptCarQueue().then(() => syncAdjacent())
  }, [carAdoption, song?.id])

  // The current track changed: move to a neighbour the native player
  // already holds when it is the one, otherwise load it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the track
  useEffect(() => {
    if (!song || !NativePlayer) return
    if (usePlayerStore.getState().playerState.audioPlayerRef !== shim) {
      setAudioPlayerRef(shim)
    }

    const { previous, current, upcoming } = held.current
    if (current?.songId === song.id) return

    const [next, ...rest] = upcoming
    let target: Entry
    if (next?.songId === song.id) {
      target = next
      held.current = { previous: current, current: next, upcoming: rest }
    } else if (previous?.songId === song.id && current) {
      target = previous
      held.current = {
        previous: null,
        current: previous,
        upcoming: [current, ...upcoming],
      }
    } else {
      loadCurrent()
      return
    }

    restartClock(target.key, 0)
    setCurrentDuration(song.duration)
    NativePlayer.skipTo({ key: target.key }).then(({ skipped }) => {
      if (!skipped) logger.info('Native player skip missed', target.key)
    })
  }, [song?.id])

  // Keep the tracks around the current one loaded: the next one preloads
  // for a gapless join, the previous one and the upcoming ones let the
  // notification and headset buttons move without this page, and the
  // upcoming ones keep playing if this page stalls in the background.
  // Tracks already held in the right order keep their entries, so a
  // preloaded track is not loaded again.
  const syncAdjacent = useCallback(() => {
    const { song: track, upcomingSongs: after, prevSong: before } = live.current
    if (!track || !NativePlayer) return
    const { previous, current, upcoming } = held.current
    // The current track is still being loaded.
    if (current?.songId !== track.id) return

    const samePrevious = (previous?.songId ?? null) === (before?.id ?? null)
    const kept = upcoming.findIndex(
      (entry, index) => entry.songId !== after[index]?.id,
    )
    const keep = kept === -1 ? upcoming.length : kept
    if (samePrevious && keep === after.length && keep === upcoming.length)
      return

    held.current = {
      previous: samePrevious ? previous : before ? makeEntry(before) : null,
      current,
      upcoming: [
        ...upcoming.slice(0, keep),
        ...after.slice(keep).map(makeEntry),
      ],
    }
    NativePlayer.setAdjacent({
      previous: held.current.previous?.item,
      upcoming: held.current.upcoming.map((entry) => entry.item),
    })
  }, [makeEntry])

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the tracks
  useEffect(() => {
    syncAdjacent()
  }, [song?.id, prevSong?.id, upcomingIds])

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on play state
  useEffect(() => {
    // After an error the track is loaded again when play is pressed.
    if (isPlaying && !held.current.current) {
      loadCurrent()
      return
    }
    NativePlayer?.setPlaying({ playing: isPlaying })
  }, [isPlaying])

  useEffect(() => {
    NativePlayer?.setRepeatOne({ enabled: loopState === LoopState.One })
  }, [loopState])

  // The state the buttons in the car and the notification show.
  const isShuffleActive = usePlayerStore(
    (state) => state.playerState.isShuffleActive,
  )
  const starred = typeof song?.starred === 'string'
  useEffect(() => {
    NativePlayer?.setModes({
      shuffle: isShuffleActive,
      repeat:
        loopState === LoopState.One
          ? 'one'
          : loopState === LoopState.All
            ? 'all'
            : 'off',
      starred,
    })
  }, [isShuffleActive, loopState, starred])

  return null
}

/**
 * Stands in for an audio element wherever the app reads or sets the
 * position (seek bars, lyrics, Jam and Connect sync), and the volume. The
 * position is extrapolated between the native player's reports.
 */
function createElementShim(
  clock: MutableRefObject<Clock>,
  seekGuard: MutableRefObject<{ until: number; targetMs: number }>,
) {
  const shim = {
    get currentTime() {
      const { positionMs, durationMs, playing, at } = clock.current
      let ms = positionMs + (playing ? performance.now() - at : 0)
      if (durationMs > 0) ms = Math.min(ms, durationMs)
      return Math.max(0, ms) / 1000
    },
    set currentTime(seconds: number) {
      if (!Number.isFinite(seconds)) return
      const positionMs = Math.max(0, seconds * 1000)
      const now = performance.now()
      clock.current = { ...clock.current, positionMs, at: now }
      seekGuard.current = { until: now + SEEK_SETTLE_MS, targetMs: positionMs }
      NativePlayer?.seekTo({ positionMs: Math.round(positionMs) })
    },
    get duration() {
      const { durationMs } = clock.current
      return durationMs > 0 ? durationMs / 1000 : Number.NaN
    },
    // As an element reports it: whether the track can play yet. Jam's sync
    // waits for this before correcting the position, since every seek
    // makes the native player load the track again.
    get readyState() {
      return clock.current.ready
        ? HTMLMediaElement.HAVE_ENOUGH_DATA
        : HTMLMediaElement.HAVE_NOTHING
    },
    get seeking() {
      return performance.now() < seekGuard.current.until
    },
    get paused() {
      return !usePlayerStore.getState().playerState.isPlaying
    },
    get volume() {
      return getVolume() / 100
    },
    set volume(value: number) {
      NativePlayer?.setVolume({ volume: value })
    },
    playbackRate: 1,
    play() {
      usePlayerStore.getState().actions.setPlayingState(true)
      return Promise.resolve()
    },
    pause() {
      usePlayerStore.getState().actions.setPlayingState(false)
    },
  }
  return shim as unknown as HTMLAudioElement
}

/**
 * The tracks that play after the current one, in order, as far as the
 * queue goes (wrapping round with repeat-all), up to UPCOMING_LIMIT.
 * Repeat-one has none: the native player repeats the track itself.
 */
function getUpcomingSongs(
  list: ISong[],
  index: number,
  loopState: LoopState,
): ISong[] {
  if (loopState === LoopState.One || index < 0) return []
  const upcoming = list.slice(index + 1, index + 1 + UPCOMING_LIMIT)
  if (loopState === LoopState.All && list.length > 1) {
    // After the last track the queue starts again, up to the current one.
    for (let at = 0; upcoming.length < UPCOMING_LIMIT && at <= index; at++) {
      upcoming.push(list[at])
    }
  }
  return upcoming
}
