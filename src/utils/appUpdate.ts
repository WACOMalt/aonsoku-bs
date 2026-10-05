/**
 * Updates for the installed apps, behind one interface the update dialog
 * uses (see update-observer.tsx): the desktop app through electron-updater,
 * the Android app from the latest GitHub release (AppUpdatePlugin.java).
 */

import { registerPlugin } from '@capacitor/core'
import { getAppInfo } from '@/utils/appName'
import { isDesktop } from '@/utils/desktop'
import { getNativePlatform } from '@/utils/platform'

export interface AvailableUpdate {
  version: string
  /** Release notes, Markdown. */
  notes: string
}

/** Why an install did not go ahead. */
export class UpdateError extends Error {
  constructor(
    readonly reason: 'failed' | 'needs-permission',
    message: string,
  ) {
    super(message)
  }
}

export interface UpdateSource {
  check(): Promise<AvailableUpdate | null>
  /**
   * Downloads and installs the update; progress runs 0..1. Resolves once
   * the install has been handed over (the app restarts or the system's
   * installer opens).
   */
  install(onProgress: (fraction: number) => void): Promise<void>
  /** Opens what install() needs permission for (Android: install apps). */
  grantPermission?(): Promise<void>
}

// ── Desktop ──

let desktopInstall: {
  resolve: () => void
  reject: (error: Error) => void
  onProgress: (fraction: number) => void
} | null = null
let desktopListening = false

const desktopUpdates: UpdateSource = {
  async check() {
    const result = await window.api.checkForUpdates()
    if (!result?.isUpdateAvailable) return null
    const { releaseNotes, version } = result.updateInfo
    const notes =
      typeof releaseNotes === 'string'
        ? releaseNotes
        : Array.isArray(releaseNotes)
          ? releaseNotes.map((note) => note.note).join('\n')
          : version
    return { version, notes }
  },
  install(onProgress) {
    if (!desktopListening) {
      desktopListening = true
      window.api.onDownloadProgress((progress) => {
        desktopInstall?.onProgress(progress.percent / 100)
      })
      window.api.onUpdateDownloaded(() => {
        desktopInstall?.resolve()
        desktopInstall = null
        window.api.quitAndInstall()
      })
      window.api.onUpdateError(() => {
        desktopInstall?.reject(new UpdateError('failed', 'Update failed'))
        desktopInstall = null
      })
    }
    return new Promise((resolve, reject) => {
      desktopInstall = { resolve, reject, onProgress }
      window.api.downloadUpdate()
    })
  },
}

// ── Android ──

interface AppUpdatePlugin {
  download(options: { url: string }): Promise<{ size: number }>
  install(): Promise<{ needsPermission: boolean }>
  openInstallSettings(): Promise<void>
  addListener(
    event: 'progress',
    callback: (data: { fraction: number }) => void,
  ): Promise<{ remove: () => Promise<void> }>
}

const AppUpdate =
  getNativePlatform() === 'android'
    ? registerPlugin<AppUpdatePlugin>('AppUpdate')
    : null

const LATEST_RELEASE =
  'https://api.github.com/repos/WACOMalt/aonsoku-bs/releases/latest'
// GitHub allows 60 unauthenticated requests an hour; checking this often
// is far inside that.
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
const CHECK_KEY = 'aonsoku-android-update-check'

interface AndroidRelease extends AvailableUpdate {
  apkUrl: string
}

let androidRelease: AndroidRelease | null = null
// The version whose APK is downloaded (tapping again after allowing installs
// does not download it again).
let downloadedVersion: string | null = null

/** "v0.18.0" or "0.18.0-beta" to [0, 18, 0]. */
function versionParts(version: string) {
  return version
    .replace(/^v/, '')
    .split('-')[0]
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0)
}

export function isNewerVersion(candidate: string, current: string) {
  const a = versionParts(candidate)
  const b = versionParts(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff > 0
  }
  return false
}

async function latestRelease(): Promise<AndroidRelease | null> {
  try {
    const saved = JSON.parse(localStorage.getItem(CHECK_KEY) ?? 'null') as {
      at: number
      release: AndroidRelease | null
    } | null
    if (saved && Date.now() - saved.at < CHECK_EVERY_MS) return saved.release
  } catch {
    // Unreadable or no storage: check again.
  }

  const response = await fetch(LATEST_RELEASE, {
    headers: { Accept: 'application/vnd.github+json' },
  })
  if (!response.ok) throw new Error(`GitHub: HTTP ${response.status}`)
  const release = (await response.json()) as {
    tag_name: string
    body: string | null
    draft: boolean
    prerelease: boolean
    assets: { name: string; browser_download_url: string }[]
  }
  const apk = release.assets.find((asset) =>
    asset.name.endsWith('-android.apk'),
  )
  const found: AndroidRelease | null =
    release.draft || release.prerelease || !apk
      ? null
      : {
          version: release.tag_name.replace(/^v/, ''),
          notes: release.body ?? '',
          apkUrl: apk.browser_download_url,
        }
  try {
    localStorage.setItem(
      CHECK_KEY,
      JSON.stringify({ at: Date.now(), release: found }),
    )
  } catch {
    // Checked again next time.
  }
  return found
}

const androidUpdates: UpdateSource = {
  async check() {
    const release = await latestRelease()
    if (!release || !isNewerVersion(release.version, getAppInfo().version)) {
      return null
    }
    androidRelease = release
    return { version: release.version, notes: release.notes }
  },
  async install(onProgress) {
    if (!AppUpdate || !androidRelease) {
      throw new UpdateError('failed', 'No update to install')
    }
    if (downloadedVersion !== androidRelease.version) {
      const listener = await AppUpdate.addListener('progress', ({ fraction }) =>
        onProgress(fraction),
      )
      try {
        await AppUpdate.download({ url: androidRelease.apkUrl })
        downloadedVersion = androidRelease.version
      } catch (error) {
        throw new UpdateError('failed', String(error))
      } finally {
        await listener.remove()
      }
    }
    const { needsPermission } = await AppUpdate.install()
    if (needsPermission) {
      throw new UpdateError('needs-permission', 'Allow Aonsoku to install apps')
    }
  },
  async grantPermission() {
    await AppUpdate?.openInstallSettings()
  },
}

/** Where this app's updates come from, or null (the web app). */
export function getUpdateSource(): UpdateSource | null {
  if (isDesktop()) return desktopUpdates
  if (AppUpdate) return androidUpdates
  return null
}
