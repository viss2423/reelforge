/**
 * Theme preference (dark default, light, or follow the OS). The resolved theme is written to
 * `<html data-theme>`; index.html applies the stored preference before first paint so
 * there is no flash.
 */
import { useSyncExternalStore } from 'react'

export type ThemePref = 'dark' | 'light' | 'system'

const KEY = 'rf.theme'
const LIGHT_QUERY = '(prefers-color-scheme: light)'
const listeners = new Set<() => void>()

const readPref = (): ThemePref => {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'system' ? v : 'dark'
  } catch {
    return 'dark'
  }
}

let pref: ThemePref = typeof localStorage === 'undefined' ? 'dark' : readPref()

const resolve = (p: ThemePref): 'dark' | 'light' =>
  p === 'system' ? (matchMedia(LIGHT_QUERY).matches ? 'light' : 'dark') : p

/** Applies the current preference to the document (and the browser chrome colour). */
export const applyTheme = (): void => {
  const t = resolve(pref)
  document.documentElement.dataset.theme = t
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', t === 'light' ? '#f5f5f8' : '#0b0b10')
}

export const setThemePref = (next: ThemePref): void => {
  pref = next
  try {
    localStorage.setItem(KEY, next)
  } catch {
    // Non-essential.
  }
  applyTheme()
  for (const l of listeners) l()
}

/** Keeps a `system` preference in sync with OS changes. Call once at startup. */
export const watchSystemTheme = (): (() => void) => {
  const mql = matchMedia(LIGHT_QUERY)
  const onChange = () => {
    if (pref === 'system') applyTheme()
  }
  mql.addEventListener('change', onChange)
  return () => mql.removeEventListener('change', onChange)
}

export const useThemePref = (): ThemePref =>
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => pref,
    () => 'dark',
  )
