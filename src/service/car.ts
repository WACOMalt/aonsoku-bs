/**
 * Android Auto. The car browses and plays through the native side of the
 * Android app (PlaybackService.java), which works while this app is closed:
 * it needs the server sign-in from here, and plays what is picked in the
 * car straight away, holding the whole list. This app then adopts that list
 * as its queue (now, or when it next opens), so the queue, Jam, Connect and
 * scrobbling carry on from it; the song playing is not interrupted.
 */

import { connectService } from '@/service/connect'
import { useAppStore } from '@/store/app.store'
import { useCarStore } from '@/store/car.store'
import { idbStorage } from '@/store/idb'
import { usePlayerStore } from '@/store/player.store'
import { AuthType } from '@/types/serverConfig'
import { logger } from '@/utils/logger'
import { type CarQueue, NativePlayer } from '@/utils/nativePlayer'

let started = false

export function initCar() {
  if (!NativePlayer || started) return
  started = true
  const player = NativePlayer

  shareServer()
  useAppStore.subscribe(shareServer)

  player.addListener('carQueue', adopt)

  // A list the car started while this app was closed is still playing:
  // take it over before anything loads the native player.
  ;(async () => {
    try {
      await songlistLoaded()
      const queue = await player.getCarQueue()
      if (queue.songs) adopt(queue as CarQueue)
    } catch (error) {
      logger.error('[Car] Could not check for a car queue', error)
    } finally {
      useCarStore.setState({ checked: true })
    }
  })()
}

let lastServer = ''

/** Hands the native side the server sign-in when it changes. */
function shareServer() {
  const { url, username, password, authType, protocolVersion } =
    useAppStore.getState().data
  const server = {
    url: url ?? '',
    username: username ?? '',
    password: password ?? '',
    authType:
      authType === AuthType.PASSWORD
        ? ('password' as const)
        : ('token' as const),
    protocolVersion: protocolVersion || '1.16.0',
  }
  const key = JSON.stringify(server)
  if (key === lastServer) return
  lastServer = key
  NativePlayer?.setServer(server).catch((error) => {
    logger.error('[Car] Could not share the server', error)
  })
}

/** Makes the car's list this app's queue. */
function adopt(queue: CarQueue) {
  const song = queue.songs[queue.index]
  if (!song) return
  logger.info('[Car] Adopting the car queue', {
    songs: queue.songs.length,
    index: queue.index,
  })
  useCarStore.setState({
    started: true,
    adoption: {
      songId: song.id,
      key: queue.key,
      positionMs: queue.positionMs,
    },
  })
  connectService.takeOver(() => {
    const { actions } = usePlayerStore.getState()
    actions.setSongList(queue.songs, queue.index)
    actions.setProgress(Math.floor(queue.positionMs / 1000))
    actions.setPlayingState(queue.playing)
  })
}

/**
 * Resolves once the saved queue has been read back (it loads from
 * IndexedDB after the rest of the player store), so it does not land on
 * top of the car's.
 */
function songlistLoaded() {
  return new Promise<void>((resolve) => {
    idbStorage.getItem('player_songlist', () => resolve())
  })
}
