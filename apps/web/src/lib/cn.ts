/** Joins truthy class names. Tiny on purpose: no runtime class-merging library needed. */
export const cn = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter(Boolean).join(' ')
