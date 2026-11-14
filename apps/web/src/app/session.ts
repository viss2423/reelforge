/**
 * Session bootstrap: decides whether this device is paired and, on the host itself
 * (loopback), pairs silently so the owner never sees a code on their own laptop.
 */
import { useSyncExternalStore } from 'react'
import { api, auth, describeDevice } from '@/api/index.ts'

const subscribe = (listener: () => void) => auth.subscribe(listener)

export const useToken = (): string | null =>
  useSyncExternalStore(
    subscribe,
    () => auth.token,
    () => null,
  )

let localAttempt: Promise<boolean> | undefined

/**
 * Tries `POST /api/pair/local` once per page load. The server only allows it from
 * loopback clients; everyone else gets 403 and goes to the pairing screen.
 */
export const tryLocalPair = (): Promise<boolean> => {
  localAttempt ??= api
    .pairLocal()
    .then((s) => {
      auth.setSession(s)
      return true
    })
    .catch(() => false)
  return localAttempt
}

/** Pairs with a 6-digit code (from the host screen or the QR link). */
export const pairWithCode = async (code: string): Promise<void> => {
  const s = await api.pair(code.replace(/\D/g, ''), describeDevice())
  auth.setSession(s)
}

/** Test hook. */
export const resetSessionForTests = (): void => {
  localAttempt = undefined
}
