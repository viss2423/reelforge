/**
 * Still images and stickers. Bitmaps are decoded off the main thread by
 * `createImageBitmap` (EXIF orientation applied, straight alpha, no colour conversion so the
 * pixels match what FFmpeg reads), downscaled to {@link MAX_IMAGE_SIDE} so a 48 MP phone photo
 * never costs 190 MB of GPU memory, and shared between clips through an LRU keyed by URL.
 */
import { LruCache } from '../lru.ts'
import type { FrameHandle, PixelSource, SourceInfo } from './source.ts'

/** Longest side kept for stills: the canvas is 1080×1920, autoMotion zooms ≤ 1.15×. */
export const MAX_IMAGE_SIDE = 2304

/** Size (w, h) that fits `MAX_IMAGE_SIDE` preserving aspect, or null when no resize needed. */
export function fitImageSize(w: number, h: number, max = MAX_IMAGE_SIDE): [number, number] | null {
  const long = Math.max(w, h)
  if (long <= max || long <= 0) return null
  const k = max / long
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))]
}

type Fetcher = (url: string) => Promise<Blob>

const defaultFetch: Fetcher = async (url) => {
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`)
  return res.blob()
}

async function decodeBitmap(blob: Blob): Promise<ImageBitmap> {
  const opts: ImageBitmapOptions = {
    imageOrientation: 'from-image',
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  }
  const full = await createImageBitmap(blob, opts)
  const size = fitImageSize(full.width, full.height)
  if (!size) return full
  const small = await createImageBitmap(full, {
    ...opts,
    resizeWidth: size[0],
    resizeHeight: size[1],
    resizeQuality: 'high',
  })
  full.close()
  return small
}

interface Entry {
  bitmap: ImageBitmap | undefined
  error: Error | undefined
  promise: Promise<void>
}

/** URL → decoded bitmap, bounded by bytes (w·h·4). */
export class ImageCache {
  readonly #lru: LruCache<string, Entry>
  readonly #fetch: Fetcher

  constructor(maxBytes = 192 * 1024 * 1024, fetcher: Fetcher = defaultFetch) {
    this.#fetch = fetcher
    this.#lru = new LruCache(maxBytes, (_k, e) => e.bitmap?.close())
  }

  /** The entry for `url`, starting a load when absent. */
  get(url: string): Entry {
    let e = this.#lru.get(url)
    if (!e) {
      const entry: Entry = { bitmap: undefined, error: undefined, promise: Promise.resolve() }
      entry.promise = this.#fetch(url)
        .then(decodeBitmap)
        .then((bmp) => {
          entry.bitmap = bmp
          // re-insert with the real size so the byte budget is accurate
          if (this.#lru.peek(url) === entry) this.#lru.set(url, entry, bmp.width * bmp.height * 4)
          else bmp.close() // evicted while loading
        })
        .catch((err: unknown) => {
          entry.error = err instanceof Error ? err : new Error(String(err))
        })
      this.#lru.set(url, entry, 1)
      e = entry
    }
    return e
  }

  get bytes(): number {
    return this.#lru.size
  }

  clear(): void {
    this.#lru.clear()
  }
}

/** A still image as a {@link PixelSource} (time-independent). */
export class ImageSource implements PixelSource {
  readonly kind = 'image'
  readonly #url: string
  readonly #cache: ImageCache
  #bitmap: ImageBitmap | undefined
  #version = 0
  readonly #handle = {
    image: null as unknown as TexImageSource,
    timestamp: 0,
    exact: true,
    version: 0,
  }

  constructor(url: string, cache: ImageCache) {
    this.#url = url
    this.#cache = cache
    cache.get(url)
  }

  get info(): SourceInfo | undefined {
    const b = this.#cache.get(this.#url).bitmap
    return b ? { width: b.width, height: b.height, rotation: 0, duration: 0 } : undefined
  }

  get error(): Error | undefined {
    return this.#cache.get(this.#url).error
  }

  /** Resolves once the bitmap is decoded (or failed). */
  get ready(): Promise<void> {
    return this.#cache.get(this.#url).promise
  }

  want(): void {
    // stills need no scheduling; touching the cache keeps the bitmap hot in the LRU
    this.#cache.get(this.#url)
  }

  frame(): FrameHandle | null {
    const b = this.#cache.get(this.#url).bitmap
    if (!b) return null
    if (b !== this.#bitmap) {
      this.#bitmap = b
      this.#version++
    }
    const h = this.#handle
    h.image = b
    h.version = this.#version
    return h
  }

  close(): void {
    this.#bitmap = undefined
  }
}
