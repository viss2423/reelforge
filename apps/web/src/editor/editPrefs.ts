/**
 * Editing preferences that are UI state, not project data: the timeline's ripple and roll
 * trim modes and the preview's Reels safe-zone overlay. Persisted per device.
 */
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'

export interface EditPrefs {
  /** Trims on free tracks shift the later clips on the same track. */
  ripple: boolean
  /** Dragging a main-track cut moves it between both clips (roll edit). */
  roll: boolean
  /** Show the Reels/TikTok/Shorts UI safe zones over the preview. */
  safeZones: boolean
}

const KEY = 'rf.editPrefs'
const DEFAULTS: EditPrefs = { ripple: false, roll: false, safeZones: false }

const load = (): EditPrefs => {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY)
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<EditPrefs>) } : DEFAULTS
  } catch {
    return DEFAULTS
  }
}

export const editPrefs = createStore<EditPrefs>()(() => load())

editPrefs.subscribe((s) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    // Private mode / quota: preferences are a convenience.
  }
})

export const setEditPref = <K extends keyof EditPrefs>(key: K, value: EditPrefs[K]): void =>
  editPrefs.setState({ [key]: value } as Pick<EditPrefs, K>)

export const useEditPref = <K extends keyof EditPrefs>(key: K): EditPrefs[K] =>
  useStore(editPrefs, (s) => s[key])
