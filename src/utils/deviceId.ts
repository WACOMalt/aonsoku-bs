import { getNativePlatform } from './platform'

// Generate a persistent device ID for this browser tab/instance
const STORAGE_KEY = 'aonsoku-device-id'

function generateDeviceId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 8)}`
}

export function getDeviceId(): string {
  let id = sessionStorage.getItem(STORAGE_KEY)
  if (!id) {
    id = generateDeviceId()
    sessionStorage.setItem(STORAGE_KEY, id)
  }
  return id
}

export function getDeviceName(): string {
  const ua = navigator.userAgent
  // The Capacitor global exists on every platform, so check the native
  // platform explicitly; otherwise desktop and web report "Android App".
  const nativePlatform = getNativePlatform()
  if (nativePlatform === 'android') return 'Android App'
  if (nativePlatform === 'ios') {
    const os = getOS()
    return os === 'iPhone' || os === 'iPad' ? `${os} App` : 'iOS App'
  }
  if (ua.includes('Electron')) return 'Desktop App'
  return `${getBrowser()} on ${getOS()}`
}

function getBrowser(): string {
  const ua = navigator.userAgent
  // Edge and Chrome on an iPhone say Safari too, and Edge says Chrome: the
  // most specific first.
  if (/Edg(e|A|iOS)?\//.test(ua)) return 'Edge'
  if (/Firefox|FxiOS/.test(ua)) return 'Firefox'
  if (/Chrome|CriOS/.test(ua)) return 'Chrome'
  if (ua.includes('Safari')) return 'Safari'
  return 'Browser'
}

function getOS(): string {
  const ua = navigator.userAgent
  // Phones and tablets first: an iPhone says "like Mac OS X", and Android
  // says Linux.
  if (ua.includes('iPhone')) return 'iPhone'
  if (ua.includes('iPad') || isIPadAsMac()) return 'iPad'
  if (ua.includes('Android')) return 'Android'
  if (ua.includes('Windows')) return 'Windows'
  if (ua.includes('Mac')) return 'macOS'
  if (ua.includes('CrOS')) return 'ChromeOS'
  if (ua.includes('Linux')) return 'Linux'
  return 'Unknown'
}

// An iPad asks for desktop sites, saying it is a Mac; Macs have no touch
// screen.
function isIPadAsMac() {
  return (
    navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1
  )
}
