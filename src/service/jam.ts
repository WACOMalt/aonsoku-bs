import { toast } from 'react-toastify'
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

// After a sync seek, how long before another one: a seek has to load.
const SYNC_SEEK_SETTLE_MS = 3000
// Joining a Jam the server doesn't have: tries again this often, this many
// times (see jam_error).
const JOIN_RETRY_MS = 3000
const JOIN_RETRIES = 2
// How long a leaving socket waits for the server to close it (see sendLast).
const LAST_MESSAGE_CLOSE_MS = 2000

/**
 * Sends a socket's last message (leaving, ending), then lets it go. The
 * server closes the socket once it has handled the message. Closing it here
 * at once can deliver the close in the same read as the message, and
 * Socket.IO drops an event that arrives with its socket's disconnect: the
 * leave would be lost. So this only closes it later, in case the server
 * doesn't.
 */
function sendLast(socket: Socket, event: string) {
  socket.removeAllListeners()
  socket.emit(event)
  setTimeout(() => socket.disconnect(), LAST_MESSAGE_CLOSE_MS)
}

class JamService {
  private socket: Socket | null = null
  private initialized = false
  // Suppresses both the drift-correction subscriber AND the emit subscriber
  // while we are applying a remote sync, preventing feedback loops
  private _isSyncing = false
  private lastSyncSeek = 0
  // Tries at joining a Jam the server doesn't know yet (see jam_error).
  private joinRetries = 0
  private joinRetryTimer: ReturnType<typeof setTimeout> | undefined
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
      // In: any retries are over.
      this.joinRetries = 0
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
      // The server may have just restarted, with the host about to open
      // the Jam again: try a couple more times before giving up. (A Jam
      // that really ended is reported as session_ended instead.)
      if (code === 'session_not_found' && this.joinRetries < JOIN_RETRIES) {
        this.joinRetries++
        this.socket?.removeAllListeners()
        this.socket?.disconnect()
        this.socket = null
        const retrying = useJamStore.getState().id
        clearTimeout(this.joinRetryTimer)
        this.joinRetryTimer = setTimeout(() => {
          if (useJamStore.getState().id === retrying && !this.socket) {
            this.connect('join')
          }
        }, JOIN_RETRY_MS)
        return
      }
      this.joinRetries = 0
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

    this.socket.on('session_ended', (data?: { reason?: string }) => {
      // The host may have ended it from another of their devices.
      const wasLead = useJamStore.getState().isLead
      this.socket?.disconnect()
      this.socket = null
      useJamStore.getState().actions.reset()
      if (wasLead && data?.reason === 'alone') {
        // The last guest left: the host carries on with the Jam's queue,
        // without being asked about the queue from before it.
        this.lastSentQueue = null
        clearJamSnapshot()
        toast.info('Everyone left, so the Jam ended. Your music keeps playing.')
        return
      }
      this.finishJam(wasLead ? 'ended' : 'host-ended')
    })

    // Left from another of this listener's devices.
    this.socket.on('jam_leave_request', () => {
      this.disconnect()
    })
  }

  /**
   * Sends where playback is. `progressOnly` (playing on, nothing chosen) is
   * only the host's to send: a guest with control sends what they change.
   */
  emitPlaybackState({ progressOnly = false }: { progressOnly?: boolean } = {}) {
    const { isLead, canGuestsControl } = useJamStore.getState()
    if (!this.socket?.connected) return
    if (!isLead && !canGuestsControl) return
    if (!isLead && progressOnly) return

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
      sendLast(this.socket, 'leave_session')
      this.socket = null
    }
    useJamStore.getState().actions.reset()
    if (silent) this.lastSentQueue = null
    else this.finishJam('left')
  }

  /** Ends the Jam for everyone. `silent` skips the restore prompt. */
  endSession({ silent = false }: { silent?: boolean } = {}) {
    // Also through the account's connection: if this socket is down, its
    // end_session would be dropped with it, leaving the guests in a Jam
    // nobody hosts. The server ignores the second one.
    connectService.sendJamControl('end')
    if (this.socket) {
      sendLast(this.socket, 'end_session')
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
      const songBefore = songlist.currentSong?.id

      // Save the lead's last known state so we can re-sync guests who drift.
      // Updates only carry the queue when it changes, so the last one sent
      // is kept: snapping a guest back (see init) needs it once they've
      // picked a song from another list.
      const leadQueue =
        data.queue ?? useJamStore.getState().lastLeadState?.queue
      useJamStore.getState().actions.setLastLeadState({
        songId: data.songId,
        isPlaying: data.isPlaying,
        progress: data.progress,
        timestamp: data.timestamp,
        queue: leadQueue,
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
          usePlayerStore.setState((state) => {
            state.songlist.currentList = data.queue!
            state.songlist.currentSongIndex = newIndex
            state.songlist.currentSong = data.queue![newIndex]
          })
        }
      } else if (songlist.currentSong?.id !== data.songId) {
        // Same queue but different song (e.g. host skipped to next/prev track)
        console.log('[Jam] Syncing song change within existing queue')
        const newIndex = songlist.currentList.findIndex(
          (s: ISong) => s.id === data.songId,
        )
        if (newIndex !== -1) {
          usePlayerStore.setState((state) => {
            state.songlist.currentSongIndex = newIndex
            state.songlist.currentSong = state.songlist.currentList[newIndex]
          })
        } else {
          // Song not found in the current list at all: use the lead's queue.
          // A guest without control who picked something else gets the one
          // kept from earlier updates (this one may not carry it); one with
          // control keeps their own, which the lead takes up.
          const { canGuestsControl } = useJamStore.getState()
          const queue = data.queue ?? (canGuestsControl ? undefined : leadQueue)
          const queueIndex = queue
            ? queue.findIndex((s: ISong) => s.id === data.songId)
            : -1
          if (queue && queueIndex !== -1) {
            console.log("[Jam] Back to the lead's queue")
            usePlayerStore.setState((state) => {
              state.songlist.currentList = queue
              state.songlist.currentSongIndex = queueIndex
              state.songlist.currentSong = queue[queueIndex]
            })
          }
        }
      }

      // Moved to another song (joining, or the host skipped): it starts at
      // the host's position when it loads, rather than being seeked while
      // it's still loading.
      const songChanged =
        usePlayerStore.getState().songlist.currentSong?.id !== songBefore
      if (songChanged) {
        actions.setProgress(Math.floor(data.progress))
        // The first correction once it can play goes at once (the player
        // may have started it from 0 while switching).
        this.lastSyncSeek = 0
      }

      // Sync play/pause
      if (playerState.isPlaying !== data.isPlaying) {
        actions.setPlayingState(data.isPlaying)
      }

      // Sync progress if drift exceeds the configurable threshold, once the
      // song can play. Seeking a song that's still loading restarts the
      // load, and the host's next update (every second) would do it again,
      // so the guest would sit at 0:00.
      const { syncThreshold } = useJamStore.getState()
      const audio = playerState.audioPlayerRef
      // The Android player and the desktop lane stand in for an element and
      // report these the same way.
      const ready =
        !!audio &&
        audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA &&
        !audio.seeking
      if (
        audio &&
        !songChanged &&
        ready &&
        Date.now() - this.lastSyncSeek > SYNC_SEEK_SETTLE_MS
      ) {
        const drift = Math.abs(audio.currentTime - data.progress)
        if (drift > syncThreshold) {
          audio.currentTime = data.progress
          this.lastSyncSeek = Date.now()
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
    this.joinRetries = 0
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
    if (end) connectService.sendJamControl('end')
    sendLast(this.socket, end ? 'end_session' : 'leave_session')
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
