import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface IUpdatePrefs {
  /** Check for a newer version each time the app starts. */
  autoCheck: boolean
  /** A version the listener chose to ignore: not offered unless asked. */
  skippedVersion: string | null
  setAutoCheck: (value: boolean) => void
  setSkippedVersion: (version: string | null) => void
}

/** The listener's choices about app updates, kept on this device. */
export const useUpdatePrefs = create<IUpdatePrefs>()(
  persist(
    (set) => ({
      autoCheck: true,
      skippedVersion: null,
      setAutoCheck: (autoCheck) => set({ autoCheck }),
      setSkippedVersion: (skippedVersion) => set({ skippedVersion }),
    }),
    { name: 'update-prefs' },
  ),
)
