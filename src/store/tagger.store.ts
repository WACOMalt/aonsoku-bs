import { devtools } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import { createWithEqualityFn } from 'zustand/traditional'
import type { TaggerCapabilities } from '@/service/tagger'
import { ISong } from '@/types/responses/song'

interface TaggerState {
  capabilities: TaggerCapabilities | null
  isAdmin: boolean
  /** The songs in the "Edit tags" dialog; empty when it is closed. */
  editing: ISong[]
  /** Opened from an album: the folder cover is offered. */
  fromAlbum: boolean
  actions: {
    setAccess: (capabilities: TaggerCapabilities, isAdmin: boolean) => void
    openEditor: (songs: ISong[], fromAlbum?: boolean) => void
    closeEditor: () => void
  }
}

export const useTaggerStore = createWithEqualityFn<TaggerState>()(
  devtools(
    immer((set) => ({
      capabilities: null,
      isAdmin: false,
      editing: [],
      fromAlbum: false,
      actions: {
        setAccess: (capabilities, isAdmin) => {
          set((state) => {
            state.capabilities = capabilities
            state.isAdmin = isAdmin
          })
        },
        openEditor: (songs, fromAlbum = false) => {
          set((state) => {
            state.editing = songs
            state.fromAlbum = fromAlbum
          })
        },
        closeEditor: () => {
          set((state) => {
            state.editing = []
          })
        },
      },
    })),
    { name: 'tagger_store' },
  ),
)

/** Whether "Edit tags" is offered: the plugin can write, and an admin is signed in. */
export const useCanEditTags = () =>
  useTaggerStore(
    (state) => state.isAdmin && !!state.capabilities?.features.write,
  )

export const useTaggerActions = () => useTaggerStore((state) => state.actions)
