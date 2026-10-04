import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useCarStore } from '@/store/car.store'
import { useCanOutputAudio } from '@/store/connect.store'
import { useJamStore } from '@/store/jam.store'
import {
  useGaplessSettings,
  usePlayerIsPlaying,
  usePlayerMediaType,
  usePlayerSonglist,
} from '@/store/player.store'
import {
  destroyAndroidMediaSession,
  isAndroidCapacitor,
  requestAndroidNotificationPermission,
  setupAndroidMediaSessionListeners,
  updateAndroidMediaSession,
  updateAndroidPlaybackState,
  updateAndroidPodcastMediaSession,
  updateAndroidRadioMediaSession,
} from '@/utils/androidMediaSession'
import { appName } from '@/utils/appName'
import { NativePlayer, usesNativeSongPlayer } from '@/utils/nativePlayer'
import { manageMediaSession } from '@/utils/setMediaSession'

export function MediaSessionObserver() {
  const { t } = useTranslation()
  const isPlaying = usePlayerIsPlaying()
  const { isRadio, isSong, isPodcast } = usePlayerMediaType()
  const { currentList, radioList, currentSongIndex, podcastList } =
    usePlayerSonglist()
  const radioLabel = t('radios.label')
  const androidListenerSetup = useRef(false)
  const canOutputAudio = useCanOutputAudio()
  const { enabled: gaplessEnabled } = useGaplessSettings()
  // Songs played by the Android app's native player have their own media
  // session and notification; this one would only duplicate them.
  const carStarted = useCarStore((state) => state.started)
  const nativeSongs =
    isSong && usesNativeSongPlayer(canOutputAudio, gaplessEnabled, carStarted)

  const song = currentList[currentSongIndex] ?? null
  const radio = radioList[currentSongIndex] ?? null
  const episode = podcastList[currentSongIndex] ?? null

  const hasNothingPlaying =
    currentList.length === 0 &&
    radioList.length === 0 &&
    podcastList.length === 0

  const resetAppTitle = useCallback(() => {
    document.title = appName
  }, [])

  // Keep the page running in the background while it has something to do:
  // playing (the queue, Connect) or taking part in a Jam, whose queue others
  // keep changing. Otherwise the phone freezes the page with the screen off.
  const inJam = useJamStore((state) => state.id !== null)
  useEffect(() => {
    NativePlayer?.setKeepAwake({ enabled: Boolean(isPlaying) || inJam })
  }, [isPlaying, inJam])

  // Proactively request notification permission on Android 13+ at startup
  useEffect(() => {
    if (isAndroidCapacitor()) {
      requestAndroidNotificationPermission()
    }
  }, [])

  // Set up Android native media session listeners once
  useEffect(() => {
    if (isAndroidCapacitor() && !androidListenerSetup.current) {
      androidListenerSetup.current = true
      setupAndroidMediaSessionListeners()
    }
  }, [])

  useEffect(() => {
    const isAndroid = isAndroidCapacitor()

    // Update playback state on both web and Android
    if (!isAndroid) {
      manageMediaSession.setPlaybackState(isPlaying)
    } else if (nativeSongs) {
      destroyAndroidMediaSession()
    } else {
      updateAndroidPlaybackState(isPlaying ?? false)
    }

    if (hasNothingPlaying) {
      if (!isAndroid) {
        manageMediaSession.removeMediaSession()
      } else {
        destroyAndroidMediaSession()
      }
    }

    if (hasNothingPlaying || !isPlaying) {
      resetAppTitle()
      return
    }

    let title = ''

    if (isRadio && radio) {
      title = `${radioLabel} - ${radio.name}`
      if (!isAndroid) {
        manageMediaSession.setRadioMediaSession(radioLabel, radio.name)
      } else {
        updateAndroidRadioMediaSession(radioLabel, radio.name)
      }
    }
    if (isSong && song) {
      title = `${song.artist} - ${song.title}`
      if (!isAndroid) {
        manageMediaSession.setMediaSession(song)
      } else if (!nativeSongs) {
        updateAndroidMediaSession(song)
      }
    }
    if (isPodcast && episode) {
      title = `${episode.title} - ${episode.podcast.title}`
      if (!isAndroid) {
        manageMediaSession.setPodcastMediaSession(episode)
      } else {
        updateAndroidPodcastMediaSession(episode)
      }
    }

    document.title = title
  }, [
    episode,
    hasNothingPlaying,
    isPlaying,
    isPodcast,
    isRadio,
    isSong,
    nativeSongs,
    radio,
    radioLabel,
    song,
    resetAppTitle,
  ])

  return null
}
