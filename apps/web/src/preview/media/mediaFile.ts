/**
 * One opened media file: a byte source plus its lazily parsed MP4 index, shared by the video
 * decoders and the audio segment loader so `moov` is fetched and parsed once per asset.
 */
import { HttpByteSource, type ByteSource } from './byteSource.ts'
import { readMp4Info, type Mp4Info } from './mp4.ts'

export interface MediaFile {
  readonly url: string
  readonly source: ByteSource
  /** Rejects for non-MP4 inputs (e.g. MP3/WAV audio) — callers fall back accordingly. */
  info(): Promise<Mp4Info>
}

class OpenedFile implements MediaFile {
  readonly url: string
  readonly source: ByteSource
  #info: Promise<Mp4Info> | undefined

  constructor(url: string, source: ByteSource) {
    this.url = url
    this.source = source
  }

  info(): Promise<Mp4Info> {
    this.#info ??= readMp4Info(this.source)
    return this.#info
  }
}

/** Cache of opened files by URL. */
export class MediaFiles {
  readonly #files = new Map<string, MediaFile>()
  readonly #factory: (url: string) => ByteSource

  constructor(factory: (url: string) => ByteSource = (url) => new HttpByteSource(url)) {
    this.#factory = factory
  }

  open(url: string): MediaFile {
    let f = this.#files.get(url)
    if (!f) {
      f = new OpenedFile(url, this.#factory(url))
      this.#files.set(url, f)
    }
    return f
  }

  /** Forget files whose URL is not in `keep` (assets removed from the project). */
  retain(keep: ReadonlySet<string>): void {
    for (const url of this.#files.keys()) if (!keep.has(url)) this.#files.delete(url)
  }
}
