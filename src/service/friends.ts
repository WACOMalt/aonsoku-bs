/**
 * Friends, over the Connect socket every signed-in app keeps open (see
 * jam-sync-server/friends.js): invites by username, the friends list with
 * who's online and what they share, two settings, and joining a friend.
 * Joining a friend has their playing device open a Jam that the joiner then
 * enters as a guest.
 */

import { toast } from 'react-toastify'
import type { Socket } from 'socket.io-client'
import { jamService } from '@/service/jam'
import {
  type IFriend,
  type IFriendInvite,
  type IFriendSettings,
  useFriendsStore,
} from '@/store/friends.store'
import { logger } from '@/utils/logger'

export type InviteResult =
  | 'sent'
  | 'accepted'
  | 'not_found'
  | 'self'
  | 'already_friends'
  | 'already_invited'
  | 'rate_limited'
  | 'unavailable'

export type JoinResult =
  | 'ready'
  | 'starting'
  | 'not_allowed'
  | 'offline'
  | 'not_playing'
  | 'removed'
  | 'unavailable'

const REPLY_TIMEOUT_MS = 8000

let socket: Socket | null = null

/** Called by the Connect service for each socket it opens. */
export function attachFriends(connectSocket: Socket) {
  socket = connectSocket

  connectSocket.on(
    'friends_state',
    (state: {
      settings: IFriendSettings
      friends: IFriend[]
      incoming: IFriendInvite[]
      outgoing: IFriendInvite[]
    }) => {
      if (socket !== connectSocket) return
      useFriendsStore.getState().actions.setState(state)
    },
  )

  // A friend is joining and this device plays: open a Jam for them.
  connectSocket.on(
    'friend_join_start',
    ({ sessionId, username }: { sessionId: string; username: string }) => {
      if (socket !== connectSocket) return
      logger.info('[Friends] Opening a Jam for a friend', { username })
      jamService.createSession(sessionId)
      toast.info(`${username} is joining your session`)
    },
  )

  // The friend's Jam is open: join it.
  connectSocket.on(
    'friend_join_ready',
    ({ sessionId, username }: { sessionId: string; username: string }) => {
      if (socket !== connectSocket) return
      jamService.switchToSession(sessionId)
      toast.success(`Joined ${username}'s session`)
    },
  )

  connectSocket.on(
    'friend_join_failed',
    ({ username }: { username: string }) => {
      if (socket !== connectSocket) return
      toast.error(`Couldn't reach ${username}. Try again in a moment.`)
    },
  )
}

/** The Connect socket closed for good (sign-out, going offline). */
export function detachFriends() {
  socket = null
  useFriendsStore.getState().actions.reset()
}

/** Sends an event and waits for the server's reply ({ result, ... }). */
function request<R extends { result: string }>(
  event: string,
  payload: object,
): Promise<R | { result: 'unavailable' }> {
  const current = socket
  if (!current?.connected) return Promise.resolve({ result: 'unavailable' })
  return new Promise((resolve) => {
    current
      .timeout(REPLY_TIMEOUT_MS)
      .emit(event, payload, (error: Error | null, reply: R) => {
        resolve(error || !reply?.result ? { result: 'unavailable' } : reply)
      })
  })
}

function send(event: string, payload: object) {
  if (socket?.connected) socket.emit(event, payload)
}

export async function inviteFriend(username: string): Promise<InviteResult> {
  const reply = await request<{ result: InviteResult }>('friend_invite', {
    username: username.trim(),
  })
  return reply.result
}

export function respondToInvite(inviteId: string, accept: boolean) {
  send('friend_respond', { inviteId, accept })
}

export function cancelInvite(inviteId: string) {
  send('friend_cancel', { inviteId })
}

export function removeFriend(username: string) {
  send('friend_remove', { username })
}

export function setFriendSettings(settings: Partial<IFriendSettings>) {
  send('friend_settings', settings)
}

/**
 * Joins a friend's session. When they are already in a Jam it is joined at
 * once; otherwise their device opens one first (friend_join_ready).
 */
export async function joinFriend(username: string): Promise<JoinResult> {
  const reply = await request<{ result: JoinResult; sessionId?: string }>(
    'friend_join',
    { username },
  )
  if (reply.result === 'ready' && 'sessionId' in reply && reply.sessionId) {
    jamService.switchToSession(reply.sessionId)
    toast.success(`Joined ${username}'s session`)
  }
  return reply.result
}

/** Removes someone from this listener's Jam (the host only). */
export function removeFromJam(username: string) {
  send('jam_control', { action: 'kick', username })
}
