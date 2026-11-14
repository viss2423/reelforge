/**
 * Light haptic feedback where supported (Android Chrome). iOS Safari has no Vibration API,
 * so this is a silent no-op there.
 */
export const haptic = (pattern: number | number[] = 8): void => {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate(pattern)
    } catch {
      // Some browsers throw when called without a user gesture; feedback is optional.
    }
  }
}
