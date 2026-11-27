/** Every built-in trend source, in fetch order. */
import type { TrendSource } from '../types.ts'
import { appleMusic } from './apple-music.ts'
import { deezer } from './deezer.ts'
import { googleTrends } from './google-trends.ts'
import { reddit } from './reddit.ts'
import { wikipedia } from './wikipedia.ts'
import { youtube } from './youtube.ts'

export const ALL_SOURCES: readonly TrendSource[] = [
  googleTrends,
  wikipedia,
  appleMusic,
  deezer,
  youtube,
  reddit,
]
