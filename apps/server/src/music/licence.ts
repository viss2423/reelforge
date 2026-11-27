/**
 * Licence policy for library music. Only licences that allow syncing the track to a video
 * and posting it — including on monetised accounts — without a fee are accepted:
 *
 * | code | licence                     | attribution | accepted |
 * | ---- | --------------------------- | ----------- | -------- |
 * | cc0  | CC0 1.0 public domain       | no          | yes      |
 * | pdm  | Public Domain Mark          | no          | yes      |
 * | by   | CC BY (any version)         | yes         | yes      |
 * | -sa  | CC BY-SA                    | yes         | no: the reel would have to be BY-SA too |
 * | -nc  | CC BY-NC*                   | —           | no: forbids commercial use (sponsored/monetised posts) |
 * | -nd  | CC BY-ND*                   | —           | no: syncing to video is an adaptation |
 */
import type { MusicLicence } from '@reelforge/core'

const CC = /creativecommons\.org\/(licenses|publicdomain)\/([a-z-]+)\/(\d(?:\.\d)?)?/i

/** Licence from a Creative Commons URL, or undefined when it is not acceptable. */
export const licenceFromUrl = (url: string | undefined): MusicLicence | undefined => {
  if (!url) return undefined
  const m = CC.exec(url)
  if (!m) return undefined
  const kind = m[2]!.toLowerCase()
  const version = m[3]
  const canonical = url.replace(/^http:/, 'https:')
  if (m[1]!.toLowerCase() === 'publicdomain') {
    if (kind === 'zero')
      return { code: 'cc0', name: 'CC0 1.0', url: canonical, attributionRequired: false }
    if (kind === 'mark')
      return { code: 'pdm', name: 'Public Domain', url: canonical, attributionRequired: false }
    return undefined
  }
  return licenceFromCode(kind, version, canonical)
}

/** Licence from a short code (`by`, `cc0`, `pdm`, `by-nc`, …), or undefined when not accepted. */
export const licenceFromCode = (
  code: string,
  version?: string,
  url?: string,
): MusicLicence | undefined => {
  const c = code.toLowerCase()
  const v = version ? ` ${version}` : ''
  if (c === 'cc0' || c === 'zero')
    return { code: 'cc0', name: 'CC0 1.0', ...(url ? { url } : {}), attributionRequired: false }
  if (c === 'pdm' || c === 'mark')
    return {
      code: 'pdm',
      name: 'Public Domain',
      ...(url ? { url } : {}),
      attributionRequired: false,
    }
  if (c === 'by')
    return {
      code: 'by',
      name: `CC BY${v}`,
      url: url ?? `https://creativecommons.org/licenses/by/${version ?? '4.0'}/`,
      attributionRequired: true,
    }
  return undefined
}

/** Standard TASL credit line (Title, Author, Source, Licence). */
export const creditLine = (t: {
  title: string
  artist: string
  pageUrl?: string | undefined
  licence: MusicLicence
}): string =>
  `"${t.title}" by ${t.artist || 'unknown artist'}` +
  (t.pageUrl ? ` (${t.pageUrl})` : '') +
  ` · ${t.licence.name}`
