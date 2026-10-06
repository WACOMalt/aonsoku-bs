import {
  MutableRefObject,
  SyntheticEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { getSongStreamUrl } from '@/api/httpClient'
import {
  crossfadeElements,
  cutElementAt,
  resetElementFade,
} from '@/app/hooks/use-audio-context'
import { useAppMediaCache } from '@/store/app.store'
import {
  isPassiveConnectDevice,
  useCanOutputAudio,
} from '@/store/connect.store'
import {
  getVolume,
  useGaplessSettings,
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
import {
  calculateReplayGain,
  ReplayGainParams,
  replayGainParamsFor,
} from '@/utils/replayGain'
import { AudioPlayer } from './audio'
import { BufferLane } from './buffer-lane'

/**
 * How long before a track ends the next one is started, to cover the time
 * the next element takes to actually produce sound. That delay differs by
 * device, so the lead calibrates itself: after each handoff the real gap is
 * measured from the two elements' own playback clocks (which follow their
 * audio output, unlike the "playing" event) and the lead is corrected. The
 * result is remembered on the device.
 */
/**
 * Two separate elements can only be lined up to within a few milliseconds
 * (in Chromium the next one starts on ~21 ms steps), so the handoff aims for
 * a small overlap and crossfades across it: a hard cut would click, and a
 * gap would be audible on albums that run continuously.
 */
const CROSSFADE_SECONDS = 0.025
const TARGET_OVERLAP_SECONDS = 0.012

const LEAD_STORAGE_KEY = 'aonsoku-gapless-lead'
const DEFAULT_LEAD_SECONDS = 0.035
const MAX_LEAD_SECONDS = 0.5
let handoffLead = readStoredLead()

function readStoredLead() {
  try {
    const stored = Number(localStorage.getItem(LEAD_STORAGE_KEY))
    if (stored > 0 && stored <= MAX_LEAD_SECONDS) return stored
  } catch {
    // Storage unavailable; use the default.
  }
  return DEFAULT_LEAD_SECONDS
}

/** Positive: the join had a gap of that many seconds; negative: overlap. */
function correctLead(gapSeconds: number) {
  handoffLead = Math.min(
    MAX_LEAD_SECONDS,
    Math.max(0, handoffLead + gapSeconds * 0.8),
  )
  try {
    localStorage.setItem(LEAD_STORAGE_KEY, handoffLead.toFixed(4))
  } catch {
    // Not remembered; it recalibrates next session.
  }
}

/**
 * When, on the page clock, the element played position 0: its playback
 * clock follows the audio output, so this is when its sound started.
 * Averaged over a few readings; null when playback was interrupted.
 */
async function measureStart(element: HTMLAudioElement) {
  const starts: number[] = []
  for (let reading = 0; reading < 5; reading++) {
    if (element.paused || element.seeking) return null
    const rate = element.playbackRate || 1
    starts.push(performance.now() - (element.currentTime / rate) * 1000)
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  if (Math.max(...starts) - Math.min(...starts) > 20) return null
  return starts.reduce((sum, start) => sum + start, 0) / starts.length
}

/** Only start early when the stream length agrees with the track's. */
const DURATION_TOLERANCE_SECONDS = 2

/**
 * How long before the end of an element-played track its position is
 * located, to join the next track onto it on the audio clock.
 */
const LANE_JOIN_WINDOW_SECONDS = 8
// If the playing element never reports it can play through, the lane starts
// downloading after this long anyway.
const LANE_FETCH_FALLBACK_MS = 15000
const LANE_JOIN_ATTEMPTS = 3

/** Decoded tracks take a lot of memory; only desktop-class devices use them. */
function hasFinePointer() {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(pointer: fine)').matches === true
  )
}

type LaneJoin = {
  trackId: string
  state: 'measuring' | 'scheduled' | 'failed'
  attempts: number
  element?: HTMLAudioElement
}

type Slot = { song: ISong; url: string }
type SlotIndex = 0 | 1

function other(index: SlotIndex): SlotIndex {
  return index === 0 ? 1 : 0
}

interface SongAudioProps {
  /** Always points at the element that is playing (the active slot). */
  audioRef: MutableRefObject<HTMLAudioElement | null>
}

/**
 * Song playback with gapless transitions.
 *
 * On desktop-class devices tracks join on the exact sample: the next track
 * is decoded ahead and played from memory on the audio clock (the "lane",
 * see BufferLane), scheduled to start where the one before it ends.
 *
 * Otherwise, and whenever the lane cannot be used (a track too long to
 * decode, a failed download), two audio elements take turns: while one
 * plays, the other loads the next track, and just before the current one
 * ends the next one starts with a short crossfade. With gapless off only
 * one element is used.
 */
export function SongAudio({ audioRef }: SongAudioProps) {
  const { currentList, currentSongIndex } = usePlayerSonglist()
  const isPlaying = usePlayerIsPlaying()
  const loopState = usePlayerLoop()
  const { enabled: gaplessEnabled } = useGaplessSettings()
  const mediaCacheEnabled = useAppMediaCache()
  const {
    replayGainEnabled,
    replayGainError,
    replayGainType,
    replayGainPreAmp,
    replayGainDefaultGain,
  } = useReplayGainState()
  const canOutputAudio = useCanOutputAudio()
  const {
    setAudioPlayerRef,
    setCurrentDuration,
    setProgress,
    setPlayingState,
    handleSongEnded,
    getCurrentProgress,
    playNextSong,
  } = usePlayerActions()

  const firstSlot = useRef<HTMLAudioElement>(null)
  const secondSlot = useRef<HTMLAudioElement>(null)
  const slotRefs = useMemo(() => [firstSlot, secondSlot] as const, [])
  const [slots, setSlots] = useState<[Slot | null, Slot | null]>([null, null])
  const [active, setActive] = useState<SlotIndex>(0)
  const handoffTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // A handoff in progress: when the old track ends (page clock) and the
  // slot taking over, to measure how well the two lined up.
  const handoff = useRef<{ oldEnd: number; to: SlotIndex } | null>(null)

  // Set when the browser refuses to start the standby element; from then
  // on this session plays everything on the one element it allows.
  const [standbyBlocked, setStandbyBlocked] = useState(false)

  const song = currentList[currentSongIndex] as ISong | undefined
  const nextSong = getNextSong(currentList, currentSongIndex, loopState)
  const useStandby =
    gaplessEnabled && !standbyBlocked && loopState !== LoopState.One

  const laneAllowed =
    gaplessEnabled &&
    !replayGainError &&
    BufferLane.isSupported() &&
    hasFinePointer()
  const laneRef = useRef<BufferLane | null>(null)
  // The current track plays on the lane rather than an element.
  const [onLane, setOnLaneState] = useState(false)
  const onLaneRef = useRef(false)
  // Bumped when a track finishes decoding, to act on it.
  const [decodeTick, setDecodeTick] = useState(0)
  // The track whose element has loaded enough that the lane may download
  // (see the decode effect): the song that is playing comes first.
  const [laneMayFetch, setLaneMayFetch] = useState<string | null>(null)
  const laneTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const laneJoin = useRef<LaneJoin | null>(null)

  // Latest values for event handlers and timers.
  const live = useRef({
    active,
    slots,
    song,
    nextSong,
    useStandby,
    isPlaying,
    loopState,
  })
  live.current = {
    active,
    slots,
    song,
    nextSong,
    useStandby,
    isPlaying,
    loopState,
  }

  const makeSlot = useCallback(
    (track: ISong): Slot => ({
      song: track,
      url: getSongStreamUrl(
        track.id,
        undefined,
        ensureSupportForAlac(track.suffix),
        mediaCacheEnabled ? undefined : Date.now().toString(),
      ),
    }),
    [mediaCacheEnabled],
  )

  const cancelHandoff = useCallback(() => {
    if (handoffTimer.current) clearTimeout(handoffTimer.current)
    handoffTimer.current = null
  }, [])

  const laneGain = useCallback(
    (track: ISong) => {
      if (!replayGainEnabled) return 1
      const gain = calculateReplayGain(
        replayGainParamsFor(track, {
          type: replayGainType,
          preAmp: replayGainPreAmp,
          defaultGain: replayGainDefaultGain,
        }),
      )
      return Number.isFinite(gain) && gain > 0 ? gain : 1
    },
    [
      replayGainEnabled,
      replayGainType,
      replayGainPreAmp,
      replayGainDefaultGain,
    ],
  )

  const getLane = useCallback(() => {
    if (!laneAllowed) return null
    if (!laneRef.current) {
      laneRef.current = new BufferLane()
      laneRef.current.setVolume(getVolume() / 100)
    }
    return laneRef.current
  }, [laneAllowed])

  const clearLaneTimer = useCallback(() => {
    if (laneTimer.current) clearTimeout(laneTimer.current)
    laneTimer.current = null
  }, [])

  const setOnLane = useCallback((value: boolean) => {
    onLaneRef.current = value
    setOnLaneState(value)
  }, [])

  // A join onto the lane scheduled from an element that is no longer
  // going to happen (paused, sought, the next track changed).
  const cancelLaneJoin = useCallback(() => {
    const join = laneJoin.current
    laneJoin.current = null
    if (!join || join.state !== 'scheduled') return
    clearLaneTimer()
    const lane = laneRef.current
    if (lane?.next) {
      lane.stop(lane.next)
      lane.next = null
    }
    if (join.element) resetElementFade(join.element)
  }, [clearLaneTimer])

  const pauseElements = useCallback(() => {
    for (const ref of slotRefs) ref.current?.pause()
  }, [slotRefs])

  // Plays a decoded track on the lane now, from `offset` seconds.
  const startOnLane = useCallback(
    (track: ISong, offset: number) => {
      const lane = laneRef.current
      if (!lane) return false
      cancelLaneJoin()
      clearLaneTimer()
      lane.stopAll()
      const voice = lane.start(
        track.id,
        lane.context.currentTime + 0.02,
        offset,
        laneGain(track),
      )
      if (!voice) return false
      lane.current = voice
      lane.setVolume(getVolume() / 100)
      pauseElements()
      setOnLane(true)
      setCurrentDuration(Math.floor(voice.buffer.duration))
      setProgress(Math.floor(offset))
      return true
    },
    [
      cancelLaneJoin,
      clearLaneTimer,
      laneGain,
      pauseElements,
      setCurrentDuration,
      setOnLane,
      setProgress,
    ],
  )

  // The lane moved on to its next track (at the join, on the audio clock);
  // the queue follows.
  const advanceLane = useCallback(
    (fromTrackId: string) => {
      const lane = laneRef.current
      if (!lane?.next) return
      lane.current = lane.next
      lane.next = null
      laneJoin.current = null
      if (laneTimer.current) clearTimeout(laneTimer.current)
      laneTimer.current = null
      lane.setVolume(getVolume() / 100)
      setOnLane(true)
      const { currentList: list, currentSongIndex: at } =
        usePlayerStore.getState().songlist
      if (list[at]?.id === fromTrackId) playNextSong()
    },
    [playNextSong, setOnLane],
  )

  // On the lane: schedule the next track to start on the exact sample the
  // current one ends, or plan what happens at its end otherwise.
  const scheduleLaneNext = useCallback(() => {
    const lane = laneRef.current
    const current = lane?.current
    const { song: track, nextSong: next, loopState: loop } = live.current
    clearLaneTimer()
    if (!lane || !current || !track || current.key !== track.id) return
    if (!live.current.isPlaying) return

    lane.setLoop(current, loop === LoopState.One)
    if (loop === LoopState.One) return

    if (lane.next && lane.next.key !== next?.id) {
      lane.stop(lane.next)
      lane.next = null
    }
    const end = lane.endTime(current)
    if (!lane.next && next && lane.buffer(next.id)) {
      lane.next = lane.start(next.id, end, 0, laneGain(next))
    }

    const untilEnd = Math.max(0, (end - lane.context.currentTime) * 1000)
    if (lane.next) {
      laneTimer.current = setTimeout(() => advanceLane(track.id), untilEnd)
      return
    }

    const standby = slotRefs[other(live.current.active)].current
    const standbyReady =
      next &&
      live.current.slots[other(live.current.active)]?.song.id === next.id &&
      standby &&
      standby.readyState >= 3
    if (standbyReady) {
      // The next track could not be decoded: hand over to its element,
      // started a moment early to cover its start-up time.
      laneTimer.current = setTimeout(
        () => {
          laneTimer.current = null
          setOnLane(false)
          playNextSong()
        },
        Math.max(0, untilEnd - handoffLead * 1000),
      )
      return
    }

    // Nothing ready to follow: the track ends, as with an element.
    laneTimer.current = setTimeout(() => {
      laneTimer.current = null
      const endedId = track.id
      handleSongEnded()
      const state = usePlayerStore.getState()
      const { currentList: list, currentSongIndex: at } = state.songlist
      // Repeating a one-track queue comes back to the same track.
      if (state.playerState.isPlaying && list[at]?.id === endedId) {
        startOnLane(list[at], 0)
      }
    }, untilEnd + 50)
  }, [
    advanceLane,
    clearLaneTimer,
    handleSongEnded,
    laneGain,
    playNextSong,
    setOnLane,
    slotRefs,
    startOnLane,
  ])

  // Seeking on the lane restarts the track at the new position.
  const seekLane = useCallback(
    (seconds: number) => {
      const lane = laneRef.current
      const current = lane?.current
      if (!lane || !current) return
      const offset = Math.min(
        Math.max(0, seconds),
        Math.max(0, current.buffer.duration - 0.05),
      )
      lane.stop(current)
      lane.stop(lane.next)
      lane.next = null
      lane.current = lane.start(
        current.key,
        lane.context.currentTime + 0.01,
        offset,
        current.gain.gain.value,
      )
      scheduleLaneNext()
    },
    [scheduleLaneNext],
  )
  const seekLaneRef = useRef(seekLane)
  seekLaneRef.current = seekLane

  const laneShim = useMemo(
    () => createLaneShim(laneRef, (seconds) => seekLaneRef.current(seconds)),
    [],
  )

  // Keep the shared reference (seeking, sync, media controls) on the slot
  // that is playing.
  const pointAt = useCallback(
    (index: SlotIndex) => {
      const element = slotRefs[index].current
      if (!element) return
      audioRef.current = element
      // The store's copy is cleared when the queue ends; restore it too.
      if (usePlayerStore.getState().playerState.audioPlayerRef !== element) {
        setAudioPlayerRef(element)
      }
    },
    [audioRef, setAudioPlayerRef, slotRefs],
  )

  // The current track changed: play it from the standby slot when that
  // already has it loaded, otherwise load it into the active slot.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the track
  useEffect(() => {
    cancelHandoff()
    if (!song) return

    const lane = laneRef.current
    // Joined onto the lane at the end of the last track: already playing.
    if (onLaneRef.current && lane?.current?.key === song.id) return
    // The listener moved on to a track the lane has decoded: play it at
    // once, from memory.
    if (lane && canOutputAudio && lane.buffer(song.id)) {
      if (startOnLane(song, getCurrentProgress())) return
    }
    // Leaving the lane for an element.
    if (lane && (onLaneRef.current || laneJoin.current)) {
      cancelLaneJoin()
      clearLaneTimer()
      const current = lane.current
      // A handover at the end lets the lane's last moment play out.
      if (!current || lane.endTime(current) - lane.context.currentTime > 0.5) {
        lane.stopAll()
      } else {
        lane.stop(lane.next)
        lane.current = null
        lane.next = null
      }
      setOnLane(false)
    }

    const { active: current, slots: currentSlots } = live.current
    if (currentSlots[current]?.song.id === song.id) return

    const standby = other(current)
    if (currentSlots[standby]?.song.id === song.id) {
      const element = slotRefs[standby].current
      if (element) {
        // A handoff has its crossfade scheduled; anything else plays at once.
        if (handoff.current?.to !== standby) resetElementFade(element)
        // A skip (not a handoff) starts the preloaded track from the top.
        // Only seek when needed: a seek flushes the decoder, which delays
        // the start and so adds a gap at a handoff.
        if (element.paused && element.currentTime > 0) element.currentTime = 0
        element.volume = getVolume() / 100
        setCurrentDuration(
          Number.isFinite(element.duration)
            ? Math.floor(element.duration)
            : song.duration,
        )
        setProgress(Math.floor(element.currentTime))
      }
      setActive(standby)
      return
    }

    const element = slotRefs[current].current
    if (element) resetElementFade(element)
    setSlots((previous) => {
      const updated: [Slot | null, Slot | null] = [...previous]
      updated[current] = makeSlot(song)
      return updated
    })
  }, [song?.id])

  // Point the shared reference at the active slot once it is rendered (its
  // element only exists once the slot has a track).
  const activeUrl = slots[active]?.url
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-pointed when the track changes
  useEffect(() => {
    if (onLane) {
      audioRef.current = laneShim
      if (usePlayerStore.getState().playerState.audioPlayerRef !== laneShim) {
        setAudioPlayerRef(laneShim)
      }
      return
    }
    if (activeUrl) pointAt(active)
  }, [
    active,
    activeUrl,
    audioRef,
    laneShim,
    onLane,
    pointAt,
    setAudioPlayerRef,
    song?.id,
  ])

  // Preload the next track into the standby slot.
  // biome-ignore lint/correctness/useExhaustiveDependencies: decodeTick re-checks once decoding ends
  useEffect(() => {
    const standby = other(active)
    if (!useStandby || !nextSong || nextSong.id === song?.id) return
    // On the lane an element is only needed when the next track could not
    // be decoded.
    if (onLane && laneRef.current?.buffer(nextSong.id) !== null) return
    // Wait until the switch to the current track has happened; until then
    // the "standby" slot may be the one about to become active.
    if (!onLane && slots[active]?.song.id !== song?.id) return
    if (slots[standby]?.song.id === nextSong.id) return

    const assign = () =>
      setSlots((previous) => {
        const updated: [Slot | null, Slot | null] = [...previous]
        updated[standby] = makeSlot(nextSong)
        return updated
      })

    // Right after a handoff the standby element is still finishing the old
    // track; give it a moment rather than cutting its last notes.
    const element = slotRefs[standby].current
    if (element && !element.paused) {
      const timer = setTimeout(assign, 1500)
      return () => clearTimeout(timer)
    }
    assign()
    return undefined
  }, [
    active,
    nextSong,
    useStandby,
    song?.id,
    slots,
    makeSlot,
    slotRefs,
    onLane,
    decodeTick,
  ])

  // Pausing stops both elements, including a tail still finishing.
  useEffect(() => {
    if (isPlaying) return
    cancelHandoff()
    cancelLaneJoin()
    for (const ref of slotRefs) ref.current?.pause()
  }, [isPlaying, cancelHandoff, cancelLaneJoin, slotRefs])

  useEffect(() => cancelHandoff, [cancelHandoff])

  // Decode the next track ahead for the lane, and the current one while it
  // plays on an element (to locate the element and join onto it). One
  // download at a time, after the playing song: starting all three at once
  // (the element's stream and two full tracks) made a slow server or
  // connection start the song late, worse with several listeners in a Jam.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the tracks
  useEffect(() => {
    const lane = getLane()
    if (!lane || !song) return
    const bump = () => setDecodeTick((tick) => tick + 1)
    const next = nextSong && loopState !== LoopState.One ? nextSong : null
    lane.keepOnly(next ? [song.id, next.id] : [song.id])
    const prepareNext = () => {
      if (next)
        lane.prepare(next.id, makeSlot(next).url, next.duration).then(bump)
    }
    // Already playing from memory: only the next one to download.
    if (onLane) {
      prepareNext()
      return
    }
    // On an element: wait until its stream has loaded enough.
    if (laneMayFetch !== song.id) return
    lane.prepare(song.id, makeSlot(song).url, song.duration).then(() => {
      bump()
      prepareNext()
    })
  }, [song?.id, nextSong?.id, onLane, loopState, getLane, laneMayFetch])

  // The lane may download once the playing element can play through, or
  // after a while of playing if the browser never says so.
  const songId = song?.id
  useEffect(() => {
    if (!songId || !isPlaying || laneMayFetch === songId) return
    const timer = setTimeout(
      () => setLaneMayFetch(songId),
      LANE_FETCH_FALLBACK_MS,
    )
    return () => clearTimeout(timer)
  }, [songId, isPlaying, laneMayFetch])

  // The next track changed while a join onto it was scheduled.
  useEffect(() => {
    const join = laneJoin.current
    if (!join || join.state !== 'scheduled') return
    if (laneRef.current?.next?.key !== nextSong?.id) cancelLaneJoin()
  }, [nextSong?.id, cancelLaneJoin])

  // On the lane: keep the next track scheduled, and play or pause the lane
  // (by running or suspending the audio clock, which keeps its schedule).
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the lane state
  useEffect(() => {
    const lane = laneRef.current
    if (!onLane || !lane) return
    if (isPlaying && canOutputAudio) {
      lane.context.resume().then(() => scheduleLaneNext())
    } else {
      clearLaneTimer()
      lane.context.suspend()
    }
  }, [
    onLane,
    isPlaying,
    canOutputAudio,
    song?.id,
    nextSong?.id,
    decodeTick,
    loopState,
  ])

  // On the lane, the position comes from the audio clock.
  useEffect(() => {
    if (!onLane) return
    const timer = setInterval(() => {
      const lane = laneRef.current
      if (lane?.current) setProgress(Math.floor(lane.position(lane.current)))
    }, 250)
    return () => clearInterval(timer)
  }, [onLane, setProgress])

  // A passive Connect device plays nothing: leave the lane.
  useEffect(() => {
    if (canOutputAudio || !onLaneRef.current) return
    clearLaneTimer()
    laneRef.current?.stopAll()
    setOnLane(false)
  }, [canOutputAudio, clearLaneTimer, setOnLane])

  // The lane stops with the player.
  useEffect(
    () => () => {
      if (laneTimer.current) clearTimeout(laneTimer.current)
      laneRef.current?.stopAll()
      laneRef.current?.keepOnly([])
    },
    [],
  )

  const isActive = (index: SlotIndex) =>
    !onLaneRef.current && live.current.active === index

  function handleLoadedMetadata(index: SlotIndex, element: HTMLAudioElement) {
    if (!isActive(index)) return
    const track = live.current.song
    setCurrentDuration(
      Number.isFinite(element.duration)
        ? Math.floor(element.duration)
        : (track?.duration ?? 0),
    )
    // Resume where the track was (after a reload, or a synced position).
    element.currentTime = getCurrentProgress()
  }

  function handleTimeUpdate(index: SlotIndex, element: HTMLAudioElement) {
    if (!isActive(index)) return
    setProgress(Math.floor(element.currentTime))
    joinLaneFromElement(element)
    scheduleHandoff(index, element)
  }

  // Near the end of an element-played track, find exactly where the
  // element is on the audio clock and schedule the next track on the lane
  // to start on the sample where this one ends.
  function joinLaneFromElement(element: HTMLAudioElement) {
    const lane = laneRef.current
    const { song: track, nextSong: next } = live.current
    if (!lane || !track || !next || !live.current.isPlaying) return
    if (!canOutputAudio || isPassiveConnectDevice()) return
    const join = laneJoin.current
    if (join && join.trackId === track.id && join.state !== 'failed') return
    if (join?.trackId === track.id && join.attempts >= LANE_JOIN_ATTEMPTS) {
      return
    }
    const buffer = lane.buffer(track.id)
    if (!buffer || !lane.buffer(next.id)) return
    const remaining = element.duration - element.currentTime
    if (!(remaining <= LANE_JOIN_WINDOW_SECONDS && remaining > 2)) return

    const attempts = join?.trackId === track.id ? join.attempts + 1 : 1
    laneJoin.current = { trackId: track.id, state: 'measuring', attempts }
    lane.locateElement(element, track.id).then((clock) => {
      if (laneJoin.current?.trackId !== track.id) return
      const unchanged =
        live.current.song?.id === track.id &&
        live.current.nextSong?.id === next.id &&
        live.current.isPlaying &&
        !element.paused &&
        !element.seeking
      const end = clock
        ? (clock.frame + buffer.length - clock.position) /
          lane.context.sampleRate
        : 0
      if (!clock || !unchanged || end - lane.context.currentTime < 0.2) {
        laneJoin.current = { trackId: track.id, state: 'failed', attempts }
        return
      }
      const voice = lane.start(next.id, end, 0, laneGain(next))
      if (!voice) {
        laneJoin.current = { trackId: track.id, state: 'failed', attempts }
        return
      }
      lane.next = voice
      cutElementAt(element, end)
      laneJoin.current = {
        trackId: track.id,
        state: 'scheduled',
        attempts,
        element,
      }
      logger.info('[Gapless] Next track scheduled on the sample', {
        track: track.id,
        startsIn: (end - lane.context.currentTime).toFixed(3),
      })
      clearLaneTimer()
      laneTimer.current = setTimeout(
        () => advanceLane(track.id),
        Math.max(0, (end - lane.context.currentTime) * 1000),
      )
    })
  }

  // Near the end of the track, start the next one from the standby slot.
  function scheduleHandoff(index: SlotIndex, element: HTMLAudioElement) {
    const { slots: currentSlots, song: track, nextSong: next } = live.current
    if (handoffTimer.current || !live.current.useStandby) return
    // Joining on the exact sample instead (see joinLaneFromElement).
    const join = laneJoin.current
    if (join?.trackId === track?.id && join?.state !== 'failed') return
    if (!track || !next || !live.current.isPlaying) return
    if (isPassiveConnectDevice()) return

    const standbyElement = slotRefs[other(index)].current
    if (currentSlots[other(index)]?.song.id !== next.id) return
    if (!standbyElement || standbyElement.readyState < 3) return

    const { duration, currentTime, playbackRate } = element
    if (!Number.isFinite(duration)) return
    // A transcoded stream can report an estimated length; starting early
    // on a wrong estimate would cut off the end of the song.
    if (
      track.duration &&
      Math.abs(duration - track.duration) > DURATION_TOLERANCE_SECONDS
    ) {
      return
    }

    const remaining = (duration - currentTime) / (playbackRate || 1)
    if (remaining <= 0 || remaining > 1.2) return

    const trackId = track.id
    handoffTimer.current = setTimeout(
      () => {
        handoffTimer.current = null
        const state = usePlayerStore.getState()
        const { currentList: list, currentSongIndex: at } = state.songlist
        if (list[at]?.id !== trackId) return
        // Paused or sought back in the meantime.
        if (element.paused || element.duration - element.currentTime > 0.5) {
          return
        }
        const rate = element.playbackRate || 1
        const left = (element.duration - element.currentTime) / rate
        handoff.current = {
          oldEnd: performance.now() + left * 1000,
          to: other(index),
        }
        const nextElement = slotRefs[other(index)].current
        if (nextElement) {
          crossfadeElements(element, nextElement, left, CROSSFADE_SECONDS)
        }
        state.actions.playNextSong()
      },
      Math.max(0, (remaining - handoffLead) * 1000),
    )
  }

  // The element reached its end. With a join onto the lane scheduled, the
  // lane has already taken over on the audio clock; this may come before
  // the join's timer (timers run late in a background tab), so it moves the
  // queue on the same way rather than ending the track.
  function handleElementEnded(index: SlotIndex) {
    const join = laneJoin.current
    if (
      join?.state === 'scheduled' &&
      join.element === slotRefs[index].current
    ) {
      advanceLane(join.trackId)
      return
    }
    handleSongEnded()
  }

  // Once the new track is audible, silence the one it took over from: at
  // once after a skip, but a handoff lets the last few milliseconds of the
  // old track play out rather than cutting them.
  function handlePlaying(index: SlotIndex) {
    if (!isActive(index)) return
    const previous = slotRefs[other(index)].current
    const element = slotRefs[index].current

    if (handoff.current?.to === index && element) {
      const { oldEnd } = handoff.current
      handoff.current = null
      // Measure once playback has settled, then correct the lead.
      setTimeout(async () => {
        const newStart = await measureStart(element)
        if (newStart === null) return
        const gap = (newStart - oldEnd) / 1000
        // Larger means a pause, seek or stall got in the way.
        if (Math.abs(gap) < 0.4) correctLead(gap + TARGET_OVERLAP_SECONDS)
      }, 800)
    }

    if (!previous || previous.paused) return
    if (previous.duration - previous.currentTime > 0.3) previous.pause()
  }

  // The browser would not start this slot's element (some only allow an
  // element a tap has started). Play the track on the other element, which
  // has played before, and stop using a standby slot.
  function handlePlayBlocked(index: SlotIndex) {
    const track = live.current.song
    if (!isActive(index) || !track) return
    const fallback = other(index)
    setStandbyBlocked(true)
    setSlots((previous) => {
      const updated: [Slot | null, Slot | null] = [...previous]
      updated[fallback] = makeSlot(track)
      updated[index] = null
      return updated
    })
    setActive(fallback)
  }

  function replayGainFor(track: ISong): ReplayGainParams {
    return replayGainParamsFor(track, {
      type: replayGainType,
      preAmp: replayGainPreAmp,
      defaultGain: replayGainDefaultGain,
    })
  }

  return (
    <>
      {([0, 1] as const).map((index) => {
        const slot = slots[index]
        if (!slot) return null
        const slotIsActive = active === index

        return (
          <AudioPlayer
            key={index}
            active={slotIsActive && !onLane}
            audioRef={slotRefs[index]}
            replayGain={replayGainFor(slot.song)}
            src={slot.url}
            preload="auto"
            autoPlay={isPlaying}
            loop={slotIsActive && loopState === LoopState.One}
            onPlay={() => setPlayingState(true)}
            onPause={(event: SyntheticEvent<HTMLAudioElement>) => {
              // Reaching the end also pauses the element; what happens then
              // is up to the end of the track (the next one, or stopping),
              // and must not cancel a join onto the lane.
              if (!event.currentTarget.ended) setPlayingState(false)
            }}
            onEnded={() => handleElementEnded(index)}
            onPlaying={() => handlePlaying(index)}
            onPlayBlocked={
              standbyBlocked ? undefined : () => handlePlayBlocked(index)
            }
            onLoadedMetadata={(event: SyntheticEvent<HTMLAudioElement>) =>
              handleLoadedMetadata(index, event.currentTarget)
            }
            onCanPlayThrough={() => {
              // Loaded enough to play on: the lane may download now.
              if (isActive(index) && song) setLaneMayFetch(song.id)
            }}
            onTimeUpdate={(event: SyntheticEvent<HTMLAudioElement>) =>
              handleTimeUpdate(index, event.currentTarget)
            }
            onSeeking={() => {
              if (isActive(index)) cancelLaneJoin()
            }}
            onLoadStart={(event: SyntheticEvent<HTMLAudioElement>) => {
              event.currentTarget.volume = getVolume() / 100
            }}
            data-testid={
              slotIsActive ? 'player-song-audio' : 'player-song-audio-next'
            }
          />
        )
      })}
    </>
  )
}

/** The track that plays after the current one, if any. */
export function getNextSong(
  list: ISong[],
  index: number,
  loopState: LoopState,
): ISong | undefined {
  if (loopState === LoopState.One) return undefined
  if (index + 1 < list.length) return list[index + 1]
  if (loopState === LoopState.All && list.length > 1) return list[0]
  return undefined
}

/**
 * Stands in for an audio element while the lane plays, wherever the app
 * reads or sets the position (seek bars, lyrics, Jam and Connect sync) and
 * the volume.
 */
function createLaneShim(
  laneRef: MutableRefObject<BufferLane | null>,
  seek: (seconds: number) => void,
) {
  const shim = {
    get currentTime() {
      const lane = laneRef.current
      return lane?.current ? lane.position(lane.current) : 0
    },
    set currentTime(seconds: number) {
      if (Number.isFinite(seconds)) seek(seconds)
    },
    get duration() {
      return laneRef.current?.current?.buffer.duration ?? Number.NaN
    },
    get paused() {
      return !usePlayerStore.getState().playerState.isPlaying
    },
    get volume() {
      return getVolume() / 100
    },
    set volume(value: number) {
      laneRef.current?.setVolume(value)
    },
    playbackRate: 1,
    // Decoded in memory: always ready to play (see Jam's sync).
    readyState: 4,
    seeking: false,
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
