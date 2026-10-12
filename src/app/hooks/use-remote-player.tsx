import { connectService } from '@/service/connect'
import { useConnectState } from '@/store/connect.store'
import { usePlayerStore } from '@/store/player.store'

export function useRemotePlayer() {
  const { isActivePlayer, isConnected } = useConnectState()

  const play = () => {
    if (isConnected && !isActivePlayer) {
      connectService.sendRemoteCommand('play')
    } else {
      usePlayerStore.getState().actions.setPlayingState(true)
    }
  }

  const pause = () => {
    if (isConnected && !isActivePlayer) {
      connectService.sendRemoteCommand('pause')
    } else {
      usePlayerStore.getState().actions.setPlayingState(false)
    }
  }

  const togglePlay = () => {
    const isPlaying = usePlayerStore.getState().playerState.isPlaying
    if (isPlaying) pause()
    else play()
  }

  const next = () => {
    if (isConnected && !isActivePlayer) {
      connectService.sendRemoteCommand('next')
    } else {
      usePlayerStore.getState().actions.playNextSong()
    }
  }

  const previous = () => {
    if (isConnected && !isActivePlayer) {
      connectService.sendRemoteCommand('previous')
    } else {
      usePlayerStore.getState().actions.playPrevSong()
    }
  }

  const seek = (position: number) => {
    if (isConnected && !isActivePlayer) {
      connectService.sendRemoteCommand('seek', { position })
    } else {
      const audio = usePlayerStore.getState().playerState.audioPlayerRef
      if (audio) audio.currentTime = position
    }
  }

  return {
    play,
    pause,
    togglePlay,
    next,
    previous,
    seek,
    isActivePlayer,
    isConnected,
  }
}
