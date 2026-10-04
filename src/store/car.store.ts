import { create } from 'zustand'
import { getNativePlatform } from '@/utils/platform'

/** A car queue this app is taking over (see service/car.ts). */
export interface ICarAdoption {
  songId: string
  /** The native player's key for the song, which keeps playing. */
  key: string
  positionMs: number
}

interface ICarState {
  /**
   * Whether it is known if the native player holds a car queue. Until then
   * nothing loads the native player, which would cut off what the car plays.
   */
  checked: boolean
  /** Android Auto started something since the app opened. */
  started: boolean
  /** A car queue for the native song player to adopt. */
  adoption: ICarAdoption | null
}

export const useCarStore = create<ICarState>(() => ({
  checked: getNativePlatform() !== 'android',
  started: false,
  adoption: null,
}))
