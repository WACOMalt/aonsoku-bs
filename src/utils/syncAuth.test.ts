import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store/app.store'
import { AuthType } from '@/types/serverConfig'
import { getSyncAuth } from './syncAuth'

const initial = useAppStore.getState().data

function signIn(authType: AuthType | null, password: string) {
  useAppStore.setState((state) => ({
    data: { ...state.data, username: 'ben', password, authType },
  }))
}

describe('getSyncAuth', () => {
  afterEach(() => {
    useAppStore.setState((state) => ({ data: { ...state.data, ...initial } }))
  })

  it('sends a password sign-in as p', () => {
    signIn(AuthType.PASSWORD, 'enc:62656e')
    expect(getSyncAuth()).toMatchObject({ u: 'ben', p: 'enc:62656e' })
  })

  it('sends a token sign-in as t and s', () => {
    signIn(AuthType.TOKEN, 'token')
    const auth = getSyncAuth()
    expect(auth).toMatchObject({ u: 'ben' })
    expect(auth?.t).toBeTruthy()
    expect(auth?.s).toBeTruthy()
  })

  it('is null when not signed in', () => {
    signIn(null, '')
    expect(getSyncAuth()).toBeNull()
  })
})
