import { Theme } from '@/types/themeContext'
import { isDesktop } from './desktop'
import { hslToHex, hslToHsla, isDarkColor } from './getAverageColor'
import { getNativePlatform, isCapacitor } from './platform'

const DEFAULT_TITLE_BAR_COLOR = '#ff000000'
const DEFAULT_TITLE_BAR_SYMBOL = '#ffffff'

export function setDesktopTitleBarColors(transparent = false) {
  if (!isDesktop()) return

  let color = DEFAULT_TITLE_BAR_COLOR
  let symbol = DEFAULT_TITLE_BAR_SYMBOL

  const root = window.document.documentElement
  const styles = getComputedStyle(root)

  if (!transparent) {
    symbol = hslToHsla(styles.getPropertyValue('--foreground').trim())
    color = hslToHsla(styles.getPropertyValue('--background').trim())
  }

  const bgColor = hslToHex(styles.getPropertyValue('--background').trim())

  window.api.setTitleBarOverlayColors({
    color,
    symbol,
    bgColor,
  })
}

/**
 * Updates the <meta name="theme-color"> tag with the current theme's
 * background color. Works on all platforms (web, Android, Electron).
 */
export function updateMetaThemeColor() {
  const root = window.document.documentElement
  const styles = getComputedStyle(root)
  const bgHsl = styles.getPropertyValue('--background').trim()

  if (!bgHsl) return

  const hexColor = hslToHex(bgHsl)

  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) {
    meta.setAttribute('content', hexColor)
  }
}

/**
 * Reads the current theme's --background CSS variable and returns
 * the hex color and whether it's a dark color.
 * Uses requestAnimationFrame to ensure CSS has been applied to the DOM.
 */
function getThemeBackgroundColor(): Promise<{
  hexColor: string
  dark: boolean
} | null> {
  return new Promise((resolve) => {
    // Use requestAnimationFrame to ensure the theme class has been applied
    // and the browser has recalculated styles
    requestAnimationFrame(() => {
      const root = window.document.documentElement
      const styles = getComputedStyle(root)
      const bgHsl = styles.getPropertyValue('--background').trim()

      if (!bgHsl) {
        console.warn('[SystemBars] No --background CSS variable found')
        resolve(null)
        return
      }

      try {
        const hexColor = hslToHex(bgHsl)
        const dark = isDarkColor(bgHsl)
        resolve({ hexColor, dark })
      } catch (error) {
        console.error(
          '[SystemBars] Failed to parse --background:',
          bgHsl,
          error,
        )
        resolve(null)
      }
    })
  })
}

/**
 * Updates the Android status bar color and style via the Capacitor StatusBar plugin.
 * Uses requestAnimationFrame to ensure CSS has been applied before reading computed styles.
 */
export async function updateCapacitorStatusBar() {
  if (!isCapacitor()) return

  const bg = await getThemeBackgroundColor()
  if (!bg) return

  const { hexColor, dark } = bg

  console.log(
    `[StatusBar] Setting color=${hexColor}, style=${dark ? 'Dark' : 'Light'}`,
  )

  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar')

    // Set status bar background color
    await StatusBar.setBackgroundColor({ color: hexColor })

    // Capacitor naming is about the bar, not the icons:
    // Style.Dark  = dark bar with light icons, Style.Light = light bar with dark icons.
    await StatusBar.setStyle({
      style: dark ? Style.Dark : Style.Light,
    })

    console.log('[StatusBar] Successfully updated status bar')
  } catch (error) {
    console.error('[StatusBar] Failed to update status bar:', error)
  }
}

interface NavigationBarPlugin {
  setBackgroundColor(options: {
    color: string
    isLight: boolean
  }): Promise<{ color: string }>
}

/**
 * Updates the Android navigation bar color via the custom NavigationBar Capacitor plugin.
 * Uses requestAnimationFrame to ensure CSS has been applied before reading computed styles.
 */
export async function updateCapacitorNavigationBar() {
  // The navigation bar plugin is the Android app's own.
  if (getNativePlatform() !== 'android') return

  const bg = await getThemeBackgroundColor()
  if (!bg) return

  const { hexColor, dark } = bg

  console.log(`[NavigationBar] Setting color=${hexColor}, isLight=${!dark}`)

  try {
    const { registerPlugin } = await import('@capacitor/core')
    const NavigationBar = registerPlugin<NavigationBarPlugin>('NavigationBar')

    await NavigationBar.setBackgroundColor({
      color: hexColor,
      isLight: !dark,
    })

    console.log('[NavigationBar] Successfully updated navigation bar')
  } catch (error) {
    console.error('[NavigationBar] Failed to update navigation bar:', error)
  }
}

/**
 * Updates both the status bar and navigation bar colors on Android.
 * Combines both operations for convenience.
 */
export async function updateCapacitorSystemBars() {
  if (!isCapacitor()) return

  await Promise.all([
    updateCapacitorStatusBar(),
    updateCapacitorNavigationBar(),
  ])
}

export function getValidThemeFromEnv(): Theme | null {
  const { APP_THEME } = window

  if (APP_THEME && Object.values(Theme).includes(APP_THEME as Theme)) {
    return APP_THEME as Theme
  }

  return null
}
