import { useSyncExternalStore } from 'react'

/** Subscribes to a CSS media query without an extra render on mount. */
export const useMediaQuery = (query: string): boolean =>
  useSyncExternalStore(
    (cb) => {
      const mql = matchMedia(query)
      mql.addEventListener('change', cb)
      return () => mql.removeEventListener('change', cb)
    },
    () => matchMedia(query).matches,
    () => false,
  )

/** Desktop three-pane layout breakpoint (matches Tailwind `lg`). */
export const DESKTOP_QUERY = '(min-width: 1024px)'
export const useIsDesktop = (): boolean => useMediaQuery(DESKTOP_QUERY)
