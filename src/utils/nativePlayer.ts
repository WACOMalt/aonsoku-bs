/**
 * Bridge to the Android app's native song player (NativePlayerPlugin.java),
 * which plays through ExoPlayer: tracks join sample-accurately, and playback
 * does not depend on the WebView staying awake.
 */

import { type PluginListenerHandle, registerPlugin } from '@capacitor/core'
import { ISong } from '@/types/responses/song'
import { getNativePlatform } from '@/utils/platform'

export interface NativeItem {
  /** Unique per item sent, so events can be matched to it. */
  key: string
  url: string
  title: string
  artist: string
  album: string
  artworkUrl: string
  durationMs: number
  /** Linear ReplayGain factor. */
  gain: number
  /** The song, which the native side keeps to resume it (see QueueMemory). */
  song?: ISong
}

export interface NativeProgress {
  key: string
  positionMs: number
  durationMs: number
  playing: boolean
  state: number
}

/**
 * A list Android Auto started, which the native player holds whole until
 * this app adopts it as its queue (see service/car.ts).
 */
export interface CarQueue {
  /** In playing order. */
  songs: ISong[]
  index: number
  /** In their own order, when the car shuffled them. */
  original?: ISong[]
  repeat: 'off' | 'all' | 'one'
  /** The native player's key for the current song. */
  key: string
  positionMs: number
  playing: boolean
}

interface NativePlayerPlugin {
  load(options: {
    previous?: NativeItem
    current: NativeItem
    upcoming: NativeItem[]
    positionMs: number
    playWhenReady: boolean
    repeatOne: boolean
    volume: number
  }): Promise<void>
  setAdjacent(options: {
    previous?: NativeItem
    upcoming: NativeItem[]
  }): Promise<void>
  skipTo(options: { key: string }): Promise<{ skipped: boolean }>
  setPlaying(options: { playing: boolean }): Promise<void>
  seekTo(options: { positionMs: number }): Promise<void>
  setVolume(options: { volume: number }): Promise<void>
  setRepeatOne(options: { enabled: boolean }): Promise<void>
  stop(): Promise<void>
  setKeepAwake(options: { enabled: boolean }): Promise<void>
  getState(): Promise<NativeProgress>
  /** The server Android Auto browses; no url signs it out. */
  setServer(options: {
    url: string
    username: string
    password: string
    authType: 'token' | 'password'
    protocolVersion: string
  }): Promise<void>
  getCarQueue(): Promise<CarQueue | { songs: null }>
  /** For the buttons in the car and the notification. */
  setModes(options: {
    shuffle: boolean
    repeat: 'off' | 'all' | 'one'
    starred: boolean
  }): Promise<void>
  adoptCarQueue(): Promise<void>

  addListener(
    event: 'progress',
    callback: (data: NativeProgress) => void,
  ): Promise<PluginListenerHandle>
  addListener(
    event: 'transition',
    callback: (data: { key: string; reason: number }) => void,
  ): Promise<PluginListenerHandle>
  addListener(
    event: 'playing',
    callback: (data: { playing: boolean; reason: number }) => void,
  ): Promise<PluginListenerHandle>
  addListener(
    event: 'ended',
    callback: (data: { key: string }) => void,
  ): Promise<PluginListenerHandle>
  addListener(
    event: 'error',
    callback: (data: { key: string; code: string; message: string }) => void,
  ): Promise<PluginListenerHandle>
  addListener(
    event: 'command',
    callback: (data: {
      action:
        | 'nexttrack'
        | 'previoustrack'
        | 'toggleshuffle'
        | 'togglerepeat'
        | 'togglestar'
    }) => void,
  ): Promise<PluginListenerHandle>
  addListener(
    event: 'carQueue',
    callback: (data: CarQueue) => void,
  ): Promise<PluginListenerHandle>
}

// Registered once, synchronously (see androidMediaSession.ts for why).
export const NativePlayer =
  getNativePlatform() === 'android'
    ? registerPlugin<NativePlayerPlugin>('NativePlayer')
    : null

/**
 * Whether songs play through the native player: only in the Android app,
 * with gapless on (turning it off falls back to the WebView's player) or
 * once Android Auto has started something (the car controls the native
 * player only), and only on the device that outputs the audio (a passive
 * Connect device plays nothing, and its notification mirrors the other
 * device instead).
 */
export function usesNativeSongPlayer(
  canOutputAudio: boolean,
  gaplessEnabled: boolean,
  carStarted = false,
) {
  return (
    NativePlayer !== null && canOutputAudio && (gaplessEnabled || carStarted)
  )
}
