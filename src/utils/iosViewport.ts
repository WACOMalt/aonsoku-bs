import { getNativePlatform } from '@/utils/platform'

/**
 * In the iOS app, the page doesn't zoom. iOS zooms in on a text field whose
 * text is under 16px when it's tapped (the server address, the search box),
 * and on a double tap, and stays zoomed: the app then shows larger than the
 * screen. Native apps don't zoom, and the Android app's WebView doesn't. The
 * website keeps pinch zoom.
 *
 * viewport-fit=cover: the page fills the screen, and env(safe-area-inset-*)
 * reports what the home indicator covers (zero elsewhere), which the tab bar
 * and the full-screen player keep clear of.
 */
export function lockIosZoom() {
  if (getNativePlatform() !== 'ios') return
  const viewport = document.querySelector('meta[name="viewport"]')
  viewport?.setAttribute(
    'content',
    'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover',
  )
}
