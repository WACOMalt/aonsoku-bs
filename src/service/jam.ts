import { io, Socket } from 'socket.io-client'
import { connectService } from '@/service/connect'
import { useAppStore } from '@/store/app.store'
import { useConnectStore } from '@/store/connect.store'
import { useJamStore } from '@/store/jam.store'
import { usePlayerStore } from '@/store/player.store'
import { ISong } from '@/types/responses/song'
import {
  clearJamSnapshot,
  loadJamSnapshot,
  saveJamSnapshot,
} from '@/utils/jamSnapshot'
import {
  createSessionId,
  describeSyncError,
  getSyncAuth,
} from '@/utils/syncAuth'
import { getSyncServerUrl } from '@/utils/syncServerUrl'

class JamService {
  private socket: Socket | null = null
  private initialized = false
  // Suppresses both the drift-correction subscriber AND the emit subscriber
  // while we are applying a remote sync, preventing feedback loops
  private _isSyncing = false
  // The queue last sent to the server. Updates only carry the queue when it
  // changes; reset on every connect so a fresh server session gets it once.
  private lastSentQueue: ISong[] | null = null
  // True while joining because the listener was already in a Jam (switching,
  // or rejoining after a reload). Their pre-Jam queue is then still the one
  // saved before that earlier Jam, and must not be overwritten.
  private keepSnapshot = false
  // A Jam remembered across a reload, waiting for Connect to say whether
  // this device is the one to play it (see reconcileWithAccount).
  private rejoinPending = false

  get isSyncing() {
    return this._isSyncing
  }

  private init() {
    if (this.initialized) return
    this.initialized = true

    // Watch for guest drift: if a non-controlling guest manually changes song, snap them back.
    // Guard with _isSyncing so we don't create a feedback loop when handleRemoteSync itself
    // changes the song.
    usePlayerStore.subscribe(
      (state) => state.songlist.currentSong?.id,
      (currentSongId) => {
        // Never snap back while we are in the middle of applying a remote sync
        if (this._isSyncing) return

        const { isConnected, isLead, canGuestsControl, lastLeadState } =
          useJamStore.getState()
        // Only act for connected guests who don't have control permission
        if (!isConnected || isLead || canGuestsControl) return
        // If there's a known lead state and the guest has drifted to a different song, snap back
        if (
          lastLeadState &&
          currentSongId &&
          currentSongId !== lastLeadState.songId
        ) {
          console.log('[Jam] Guest drifted from lead song — snapping back')
          this.handleRemoteSync(lastLeadState)
        }
      },
    )
  }

  /**
   * Opens the socket for the Jam in the store. `create` starts the session
   * if it does not exist; `join` only enters an existing one, so a stale
   * invite cannot make the invitee host of an empty Jam.
   */
  connect(mode: 'create' | 'join') {
    this.init()

    const { id: sessionId, isLead } = useJamStore.getState()
    const { username } = useAppStore.getState().data
    const { setConnected, setConnecting, setError, setParticipants } =
      useJamStore.getState().actions

    if (!sessionId) return
    // Listening offline: Jam is off until they go online.
    if (useConnectStore.getState().offline) return
    // The Jam plays on the device the listener is using, not on another of
    // their devices, so this one takes over audio (Connect).
    connectService.claimControl()
    // Never leave an old socket running alongside the new one.
    if (this.socket) {
      this.socket.removeAllListeners()
      this.socket.disconnect()
      this.socket = null
    }

    const syncUrl = getSyncServerUrl()
    if (!syncUrl) {
      setError(
        'No sync server URL configured. In Electron, set it via Settings → Content → Jam / Connect.',
      )
      console.error(
        '[Jam] No sync server URL available. In Electron, configure it via Settings → Content → Jam / Connect.',
      )
      return
    }

    const auth = getSyncAuth()
    if (!auth) {
      setError('Sign in again to use Jam.')
      return
    }

    setConnecting(true)

    console.log('[Jam] Connecting to sync server at:', syncUrl)

    this.socket = io(syncUrl, {
      path: '/jam-sync/socket.io', // Proxy-compatible path
      // The server verifies `auth` and decides who hosts. username and isLead
      // are only read by sync servers that predate authentication.
      query: { sessionId, mode, username, isLead: String(isLead) },
      auth,
    })

    this.socket.on('connect', () => {
      this.lastSentQueue = null
      setConnected(true)
      setConnecting(false)
      console.log('[Jam] Connected to sync server')
    })

    this.socket.on('connect_error', (err) => {
      setError(describeSyncError(err.message))
      setConnecting(false)
    })

    // The server decides who hosts; correct our local idea of it.
    this.socket.on('jam_role', ({ isLead }: { isLead: boolean }) => {
      useJamStore.getState().actions.setIsLead(isLead)
    })

    this.socket.on('participants_update', (participants) => {
      const before = useJamStore.getState().participants.length
      setParticipants(participants)
      // Someone joined: the host sends where it is now (queue included), so
      // they catch up without waiting for the next change.
      if (useJamStore.getState().isLead && participants.length > before) {
        this.lastSentQueue = null
        this.emitPlaybackState()
      }
    })

    this.socket.on(
      'sync_playback',
      (data: {
        songId: string
        isPlaying: boolean
        progress: number
        timestamp: number
        queue?: ISong[]
      }) => {
        const { isLead, canGuestsControl } = useJamStore.getState()
        // Lead only syncs from guests when canGuestsControl is enabled
        if (isLead && !canGuestsControl) return

        this.handleRemoteSync(data)
      },
    )

    this.socket.on(
      'guest_control_update',
      ({ canGuestsControl }: { canGuestsControl: boolean }) => {
        useJamStore.getState().actions.setCanGuestsControl(canGuestsControl)
      },
    )

    this.socket.on('jam_error', ({ code }: { code: string }) => {
      if (code !== 'session_not_found' && code !== 'removed') return
      this.socket?.removeAllListeners()
      this.socket?.disconnect()
      this.socket = null
      useJamStore.getState().actions.reset()
      // Nothing played yet in this Jam, so a snapshot saved for it is moot.
      if (!this.keepSnapshot) clearJamSnapshot()
      this.keepSnapshot = false
      this.finishJam(code === 'removed' ? 'removed' : 'expired')
    })

    // The host removed this listener.
    this.socket.on('jam_removed', () => {
      this.socket?.removeAllListeners()
      this.socket?.disconnect()
      this.socket = null
      useJamStore.getState().actions.reset()
      this.finishJam('removed')
    })

    this.socket.on('session_ended', () => {
      // The host may have ended it from another of their devices.
      const wasLead = useJamStore.getState().isLead
      this.socket?.disconnect()
      this.socket = null
      useJamStore.getState().actions.reset()
      this.finishJam(wasLead ? 'ended' : 'host-ended')
    })

    // Left from another of this listener's devices.
    this.socket.on('jam_leave_request', () => {
      this.disconnect()
    })
  }

  emitPlaybackState() {
    const { isLead, canGuestsControl } = useJamStore.getState()
    if (!this.socket?.connected) return
    if (!isLead && !canGuestsControl) return

    const { songlist, playerState, playerProgress } = usePlayerStore.getState()
    const currentSong = songlist.currentSong

    if (!currentSong) return

    // The queue can be hundreds of full song objects, so send it only when
    // it has changed. The store replaces the array on every edit, so a
    // reference comparison is enough.
    const queueChanged = songlist.currentList !== this.lastSentQueue

    this.socket.emit('playback_update', {
      songId: currentSong.id,
      isPlaying: playerState.isPlaying,
      progress: playerProgress.progress,
      ...(queueChanged ? { queue: songlist.currentList } : {}),
      timestamp: Date.now(),
    })

    if (queueChanged) this.lastSentQueue = songlist.currentList
  }

  /** Leaves the Jam. `silent` skips the restore prompt when switching Jams. */
  disconnect({ silent = false }: { silent?: boolean } = {}) {
    if (this.socket) {
      this.socket.emit('leave_session')
      this.socket.removeAllListeners()
      this.socket.disconnect()
      this.socket = null
    }
    useJamStore.getState().actions.reset()
    if (silent) this.lastSentQueue = null
    else this.finishJam('left')
  }

  /** Ends the Jam for everyone. `silent` skips the restore prompt. */
  endSession({ silent = false }: { silent?: boolean } = {}) {
    if (this.socket) {
      this.socket.emit('end_session')
      this.socket.removeAllListeners()
      this.socket.disconnect()
      this.socket = null
    }
    useJamStore.getState().actions.reset()
    if (silent) this.lastSentQueue = null
    else this.finishJam('ended')
  }

  /**
   * Offers to restore what was playing before the Jam, when there is
   * something to restore. Otherwise just tells a guest the host ended it.
   */
  private finishJam(
    reason: 'host-ended' | 'left' | 'ended' | 'expired' | 'removed',
  ) {
    this.lastSentQueue = null
    const canRestore = loadJamSnapshot() !== null
    if (!canRestore) clearJamSnapshot()
    useJamStore.getState().actions.setEndPrompt({ reason, canRestore })
  }

  setGuestControl(canControl: boolean) {
    if (this.socket?.connected) {
      this.socket.emit('set_guest_control', { canControl })
    }
  }

  private handleRemoteSync(data: {
    songId: string
    isPlaying: boolean
    progress: number
    timestamp: number
    queue?: ISong[]
  }) {
    // Set flag so both the drift-correction subscriber AND the emit subscriber
    // ignore changes we make here, preventing feedback loops
    this._isSyncing = true

    try {
      const { actions, songlist, playerState } = usePlayerStore.getState()

      // Save the lead's last known state so we can re-sync guests who drift
      useJamStore.getState().actions.setLastLeadState({
        songId: data.songId,
        isPlaying: data.isPlaying,
        progress: data.progress,
        timestamp: data.timestamp,
        queue: data.queue,
      })

      // 1. Sync Queue if provided and different
      if (
        data.queue &&
        JSON.stringify(data.queue.map((s: ISong) => s.id)) !==
          JSON.stringify(songlist.currentList.map((s: ISong) => s.id))
      ) {
        console.log('[Jam] Syncing shared queue')
        const newIndex = data.queue.findIndex(
          (s: ISong) => s.id === data.songId,
        )
        if (newIndex !== -1) {
          usePlayerStore.setState(
            (state: ReturnType<typeof usePlayerStore.getState>) => {
              state.songlist.currentList = data.queue!
              state.songlist.currentSongIndex = newIndex
              state.songlist.currentSong = data.queue![newIndex]
            },
          )
        }
      } else if (songlist.currentSong?.id !== data.songId) {
        // Same queue but different song (e.g. host skipped to next/prev track)
        console.log('[Jam] Syncing song change within existing queue')
        const newIndex = songlist.currentList.findIndex(
          (s: ISong) => s.id === data.songId,
        )
        if (newIndex !== -1) {
          usePlayerStore.setState(
            (state: ReturnType<typeof usePlayerStore.getState>) => {
              state.songlist.currentSongIndex = newIndex
              state.songlist.currentSong = state.songlist.currentList[newIndex]
            },
          )
        } else if (data.queue) {
          // Song not found in current list at all — use the provided queue
          const queueIndex = data.queue.findIndex(
            (s: ISong) => s.id === data.songId,
          )
          if (queueIndex !== -1) {
            usePlayerStore.setState(
              (state: ReturnType<typeof usePlayerStore.getState>) => {
                state.songlist.currentList = data.queue!
                state.songlist.currentSongIndex = queueIndex
                state.songlist.currentSong = data.queue![queueIndex]
              },
            )
          }
        }
      }

      // Sync play/pause
      if (playerState.isPlaying !== data.isPlaying) {
        actions.setPlayingState(data.isPlaying)
      }

      // Sync progress if drift exceeds the configurable threshold
      const { syncThreshold } = useJamStore.getState()
      const audio = playerState.audioPlayerRef
      if (audio) {
        const drift = Math.abs(audio.currentTime - data.progress)
        if (drift > syncThreshold) {
          audio.currentTime = data.progress
        }
      }
    } finally {
      // Always clear the flag, even if an error occurs
      // Use a microtask so Zustand's synchronous subscriber fires first
      Promise.resolve().then(() => {
        this._isSyncing = false
      })
    }
  }

  /**
   * Starts a Jam with this listener as host. A friend joining asks for one
   * with a given id (see service/friends.ts).
   */
  createSession(sessionId = createSessionId()) {
    this.keepSnapshot = false
    saveJamSnapshot()
    useJamStore.getState().actions.setSession(sessionId, true)
    this.connect('create')
    return sessionId
  }

  /**
   * Joins a Jam, leaving any Jam the listener is currently in. The queue
   * saved before their first Jam is kept, so restoring later goes back to
   * what they had before any of it.
   */
  switchToSession(sessionId: string) {
    const { id, isConnected, isConnecting, isLead } = useJamStore.getState()
    if (id === sessionId && (isConnected || isConnecting)) return

    const wasInJam = !!id && (isConnected || isConnecting)
    if (wasInJam) {
      if (isLead) this.endSession({ silent: true })
      else this.disconnect({ silent: true })
    } else if (id) {
      // A Jam id left over from before a reload that never reconnected.
      useJamStore.getState().actions.reset()
    }

    this.keepSnapshot = wasInJam
    if (!wasInJam) saveJamSnapshot()
    useJamStore.getState().actions.setSession(sessionId, false)
    this.connect('join')
  }

  /** Kept for callers that join from a plain id without switching logic. */
  joinSession(sessionId: string) {
    this.switchToSession(sessionId)
  }

  /**
   * After a reload the store still names the Jam the listener was in, but
   * nothing is connected. Rejoin it: a host recreates it if everyone left,
   * a guest only rejoins if it still exists.
   */
  rejoinPersistedSession() {
    const { id, isConnected, isConnecting } = useJamStore.getState()
    if (!id || isConnected || isConnecting || this.socket) return
    // Only the device that plays rejoins, which Connect has yet to say.
    this.rejoinPending = true
    this.reconcileWithAccount()
  }

  /**
   * A Jam belongs to the listener's account and plays on whichever of their
   * devices plays audio (Connect). This device joins the Jam's room when it
   * is that device, and leaves it quietly once another of their devices has
   * taken the Jam over.
   */
  reconcileWithAccount() {
    const connect = useConnectStore.getState()
    const jam = useJamStore.getState()
    const account = jam.accountJam
    // Wait until the server has said who plays and which Jam this is.
    if (!connect.isConnected || account === undefined) return
    if (!connect.devices.some((device) => device.id === connect.thisDeviceId)) {
      return
    }

    if (connect.isActivePlayer) {
      if (this.socket) {
        this.rejoinPending = false
        return
      }
      if (account) {
        this.rejoinPending = false
        this.keepSnapshot = true
        jam.actions.setSession(account.id, account.isLead)
        this.connect(account.isLead ? 'create' : 'join')
      } else if (this.rejoinPending && jam.id) {
        // The server no longer has it (restarted): a host recreates it.
        this.rejoinPending = false
        this.keepSnapshot = true
        this.connect(jam.isLead ? 'create' : 'join')
      }
      return
    }

    // Another of the listener's devices plays.
    this.rejoinPending = false
    if (!this.socket) {
      // A Jam remembered from before a reload is that device's now.
      if (jam.id && !jam.isConnecting) jam.actions.reset()
      return
    }
    const mine = this.socket.id
    if (account && account.id !== jam.id) {
      // They joined another Jam there; one this device hosts ends, as
      // when switching Jams on one device.
      this.leaveQuietly(jam.isLead)
    } else if (account?.sockets.some((id) => id !== mine)) {
      // That device has joined this Jam: hand it over.
      this.leaveQuietly(false)
    }
  }

  /** Leaves the Jam's room without the end-of-Jam prompt or restore. */
  private leaveQuietly(end: boolean) {
    if (!this.socket) return
    this.socket.emit(end ? 'end_session' : 'leave_session')
    this.socket.removeAllListeners()
    this.socket.disconnect()
    this.socket = null
    this.lastSentQueue = null
    useJamStore.getState().actions.reset()
  }
}

export const jamService = new JamService()

// Follow the account's Jam as devices take over playback (see
// reconcileWithAccount).
useConnectStore.subscribe((state, previous) => {
  if (
    state.isActivePlayer !== previous.isActivePlayer ||
    state.isConnected !== previous.isConnected ||
    state.devices !== previous.devices
  ) {
    jamService.reconcileWithAccount()
  }
})
useJamStore.subscribe((state, previous) => {
  if (state.accountJam !== previous.accountJam) {
    jamService.reconcileWithAccount()
  }
})
