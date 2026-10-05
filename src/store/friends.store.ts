import { create } from 'zustand'

/** What a friend is playing, if they share it. */
export interface IFriendActivity {
  songId: string
  title: string
  artist: string
  album: string
  coverArt: string
  isPlaying: boolean
}

export interface IFriend {
  username: string
  online: boolean
  activity: IFriendActivity | null
  /** They allow friends to join and have something to join now. */
  joinable: boolean
  inJam: boolean
}

export interface IFriendInvite {
  id: string
  username: string
  createdAt: number
}

export interface IFriendSettings {
  shareActivity: boolean
  allowJoin: boolean
}

interface IFriendsState {
  /** The sync server sent friends at least once (it supports them). */
  loaded: boolean
  settings: IFriendSettings
  friends: IFriend[]
  incoming: IFriendInvite[]
  outgoing: IFriendInvite[]
  panelOpen: boolean
  actions: {
    setState: (state: {
      settings: IFriendSettings
      friends: IFriend[]
      incoming: IFriendInvite[]
      outgoing: IFriendInvite[]
    }) => void
    setPanelOpen: (open: boolean) => void
    reset: () => void
  }
}

const initial = {
  loaded: false,
  settings: { shareActivity: false, allowJoin: false },
  friends: [],
  incoming: [],
  outgoing: [],
}

/** Friends, as the sync server reports them (see service/friends.ts). */
export const useFriendsStore = create<IFriendsState>((set) => ({
  ...initial,
  panelOpen: false,
  actions: {
    setState: (state) => set({ ...state, loaded: true }),
    setPanelOpen: (panelOpen) => set({ panelOpen }),
    reset: () => set(initial),
  },
}))

/** Invites waiting for an answer: the count on the user icon. */
export const useFriendInviteCount = () =>
  useFriendsStore((state) => state.incoming.length)
