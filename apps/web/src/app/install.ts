/**
 * "Install app" support. Chromium fires `beforeinstallprompt` once, early — possibly before
 * React mounts — so the event is captured at module load (imported by main.tsx) and kept
 * until the user taps Install in Settings. iOS has no prompt API: the UI shows
 * Share → Add to Home Screen instructions instead.
 */
import { useSyncExternalStore } from 'react'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export type InstallState = 'installed' | 'available' | 'ios' | 'unsupported'

let deferred: BeforeInstallPromptEvent | null = null
let installed = false
const listeners = new Set<() => void>()
const notify = () => {
  for (const l of listeners) l()
}

const isStandalone = (): boolean =>
  typeof window !== 'undefined' &&
  (matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true)

const isIos = (): boolean =>
  typeof navigator !== 'undefined' &&
  (/iPhone|iPad|iPod/.test(navigator.userAgent) ||
    // iPadOS reports itself as a Mac with touch.
    (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1))

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferred = e as BeforeInstallPromptEvent
    notify()
  })
  window.addEventListener('appinstalled', () => {
    installed = true
    deferred = null
    notify()
  })
}

export const getInstallState = (): InstallState => {
  if (installed || isStandalone()) return 'installed'
  if (deferred) return 'available'
  if (isIos()) return 'ios'
  return 'unsupported'
}

/** Shows the browser's install prompt. Resolves true if the user accepted. */
export const promptInstall = async (): Promise<boolean> => {
  const e = deferred
  if (!e) return false
  deferred = null
  await e.prompt()
  const { outcome } = await e.userChoice
  notify()
  return outcome === 'accepted'
}

export const useInstallState = (): InstallState =>
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    getInstallState,
    () => 'unsupported',
  )
