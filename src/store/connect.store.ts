import { create } from 'zustand'
import { devtools, persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'

export interface IDevice {
  id: string
  name: string
  isActivePlayer: boolean
  lastSeen: string
}

export interface IConnectSession {
  // Connection state
  isConnected: boolean
  isConnecting: boolean
  error: string | null

  // Device state
  devices: IDevice[]
  thisDeviceId: string | null // socket.id of this device
  isActivePlayer: boolean // convenience: is THIS device the active player?
  /**
   * The connection dropped while another device was playing: this device
   * stays a silent remote until it reconnects or the drop lasts too long
   * (see ConnectService). A phone loses its connection whenever it sits in
   * the background, and turning into a player each time would start and
   * stop its native player over and over.
   */
  passiveHold: boolean

  /**
   * Listening offline: this device stays off the sync server, so what it
   * plays does not touch the listener's online session (their other
   * devices, Connect, Jam). Remembered on the device until they go online.
   */
  offline: boolean
  /**
   * Back online with a queue here while the online session has one too:
   * waiting for the listener to pick which to continue with (this device
   * takes over the online session either way).
   */
  onlineChoice: { onlineSong: string | null } | null
}

interface IConnectActions {
  setConnected: (value: boolean) => void
  setConnecting: (value: boolean) => void
  setError: (error: string | null) => void
  setDevices: (devices: IDevice[]) => void
  setThisDeviceId: (id: string) => void
  setIsActivePlayer: (value: boolean) => void
  setPassiveHold: (value: boolean) => void
  setOffline: (value: boolean) => void
  setOnlineChoice: (choice: { onlineSong: string | null } | null) => void
  reset: () => void
}

export const useConnectStore = create<
  IConnectSession & { actions: IConnectActions }
>()(
  devtools(
    persist(
      immer((set) => ({
        offline: false,
        onlineChoice: null,
        isConnected: false,
        isConnecting: false,
        error: null,
        devices: [],
        thisDeviceId: null,
        isActivePlayer: true, // Default to true (single device = active)
        passiveHold: false,
        actions: {
          setConnected: (value) =>
            set((s) => {
              s.isConnected = value
            }),
          setConnecting: (value) =>
            set((s) => {
              s.isConnecting = value
            }),
          setError: (error) =>
            set((s) => {
              s.error = error
            }),
          setDevices: (devices) =>
            set((s) => {
              s.devices = devices
              // Update isActivePlayer based on this device's status
              if (s.thisDeviceId) {
                const thisDevice = devices.find((d) => d.id === s.thisDeviceId)
                // A list that does not include us yet says nothing about our role.
                if (thisDevice) s.isActivePlayer = thisDevice.isActivePlayer
              }
            }),
          setThisDeviceId: (id) =>
            set((s) => {
              s.thisDeviceId = id
            }),
          setIsActivePlayer: (value) =>
            set((s) => {
              s.isActivePlayer = value
            }),
          setPassiveHold: (value) =>
            set((s) => {
              s.passiveHold = value
            }),
          setOffline: (value) =>
            set((s) => {
              s.offline = value
            }),
          setOnlineChoice: (choice) =>
            set((s) => {
              s.onlineChoice = choice
            }),
          reset: () =>
            set((s) => {
              s.isConnected = false
              s.isConnecting = false
              s.error = null
              s.devices = []
              s.thisDeviceId = null
              s.isActivePlayer = true
              s.passiveHold = false
              s.onlineChoice = null
            }),
        },
      })),
      {
        name: 'connect-storage',
        partialize: (s) => ({ offline: s.offline }),
      },
    ),
  ),
)

export const useConnectActions = () => useConnectStore((s) => s.actions)
export const useConnectState = () =>
  useConnectStore((s) => ({
    isConnected: s.isConnected,
    isConnecting: s.isConnecting,
    error: s.error,
    devices: s.devices,
    thisDeviceId: s.thisDeviceId,
    isActivePlayer: s.isActivePlayer,
  }))

/**
 * True when another of this user's devices is the one playing audio. This
 * device then mirrors that playback without sound and acts as a remote.
 */
export function isPassiveConnectDevice() {
  const { isConnected, passiveHold, isActivePlayer } =
    useConnectStore.getState()
  return (isConnected || passiveHold) && !isActivePlayer
}

export const useConnectOffline = () => useConnectStore((s) => s.offline)

/** Whether this device may output audio (see isPassiveConnectDevice). */
export const useCanOutputAudio = () =>
  useConnectStore((s) => !(s.isConnected || s.passiveHold) || s.isActivePlayer)
