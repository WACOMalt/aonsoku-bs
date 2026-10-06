import { electronApp, optimizer, platform } from '@electron-toolkit/utils'
import { app } from 'electron'
import {
  deliverDeepLink,
  findDeepLink,
  registerDeepLinkProtocol,
} from './core/deepLinks'
import { createAppMenu } from './core/menu'
import { registerSongScheme } from './core/songCache'
import { initAutoUpdater } from './core/updater'
import { createWindow, mainWindow } from './window'

export let isQuitting = false

const currentDesktop = process.env.XDG_CURRENT_DESKTOP ?? ''

if (platform.isLinux && currentDesktop.toLowerCase().includes('gnome')) {
  process.env.XDG_CURRENT_DESKTOP = 'Unity'
}

const instanceLock = app.requestSingleInstanceLock()

if (!instanceLock) {
  app.quit()
} else {
  createAppMenu()
  // Songs kept on this computer are served through their own scheme.
  registerSongScheme()

  // macOS delivers links through this event, possibly before 'ready'.
  app.on('open-url', (event, url) => {
    event.preventDefault()
    deliverDeepLink(url)
  })

  app.on('second-instance', (_event, argv) => {
    // Windows and Linux start a second process for a link; it lands here.
    const link = findDeepLink(argv)
    if (link) deliverDeepLink(link)

    if (!mainWindow || mainWindow.isDestroyed()) return

    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    } else if (!mainWindow.isVisible()) {
      mainWindow.show()
    }

    mainWindow.focus()
  })

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('com.victoralvesf.aonsoku')
    registerDeepLinkProtocol()

    initAutoUpdater()
    createWindow()
  })

  app.on('activate', function () {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow()
      return
    }

    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    } else if (!mainWindow.isVisible()) {
      mainWindow.show()
    }

    mainWindow.focus()
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)

    window.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F11') {
        event.preventDefault()
      }
    })
  })

  app.on('before-quit', () => {
    isQuitting = true
  })

  app.on('window-all-closed', () => {
    if (!platform.isMacOS) {
      app.quit()
    }
  })
}
