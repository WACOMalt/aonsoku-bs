import { authQueryParams } from '@/api/httpClient'
import { useAppStore } from '@/store/app.store'
import { appName } from '@/utils/appName'

/**
 * Credentials for the Jam / Connect sync server handshake.
 *
 * The sync server verifies these against the Navidrome server it is
 * configured for, and only then trusts the username. They are the same
 * Subsonic credentials every API request already carries, and they travel
 * in the Socket.IO auth payload rather than the URL so they stay out of
 * proxy access logs.
 */
export function getSyncAuth(): Record<string, string> | null {
  const { username, password, authType, protocolVersion } =
    useAppStore.getState().data
  // authType is an enum whose first value (password) is 0.
  if (!username || !password || authType === null || authType === undefined)
    return null

  try {
    return {
      ...authQueryParams(username, password, authType),
      v: protocolVersion || '1.16.0',
      c: appName,
    }
  } catch {
    return null
  }
}

/** A readable message for a sync server connection error. */
export function describeSyncError(message: string): string {
  switch (message) {
    case 'unauthorized':
      return 'The sync server could not verify your login.'
    case 'auth_unavailable':
      return 'The sync server could not reach the music server to verify your login.'
    case 'sync_not_configured':
      return 'The sync server is not configured for a music server.'
    default:
      return message
  }
}

/** A random session id that is hard to guess. */
export function createSessionId(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return (
    Array.from(bytes, (b) => (b % 36).toString(36)).join('') +
    Date.now().toString(36).slice(-2)
  )
}
