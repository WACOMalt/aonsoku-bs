import { existsSync, lstatSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

// The app was called "Aonsoku" before "Aonsoku-BS", and its settings folder
// is named after it.
const OLD_NAME = 'Aonsoku'

/**
 * Moves the settings folder of the app from before it was renamed (settings,
 * sign-in, kept songs) to this app's folder, once. Runs before anything
 * opens a file in it: imported first by index.ts.
 *
 * While that folder can't be moved (the old app is still running, or a file
 * in it is in use), the app uses it where it is, and tries again next start.
 */
function migrateUserData() {
  // A folder given with --user-data-dir is used as it is.
  if (app.commandLine.hasSwitch('user-data-dir')) return

  const current = app.getPath('userData')
  const old = join(app.getPath('appData'), OLD_NAME)
  if (current === old || !existsSync(old) || !isEmpty(current)) return

  if (isLocked(old)) {
    app.setPath('userData', old)
    return
  }
  try {
    renameSync(old, current)
    console.log(`[UserData] Moved ${old} to ${current}`)
  } catch (error) {
    console.warn(`[UserData] Could not move ${old}, using it there`, error)
    app.setPath('userData', old)
  }
}

function isEmpty(dir: string) {
  try {
    return readdirSync(dir).length === 0
  } catch {
    return true
  }
}

// A running app holds a lock in its folder: SingletonLock on Linux and
// macOS (a link, so lstat), lockfile on Windows (renaming fails there anyway).
function isLocked(dir: string) {
  try {
    lstatSync(join(dir, 'SingletonLock'))
    return true
  } catch {
    return false
  }
}

migrateUserData()
