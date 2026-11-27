/** Types for thumbs.mjs (used by the server's trend engine). */
export interface ThumbManifest {
  dir: string
  manifest: unknown
}
export declare const FRAME_THUMB: { w: number; h: number }
export declare const TEXT_THUMB: { w: number; h: number }
export declare function thumbPath(kind: string, id: string): string
export declare function generateThumbs(opts: {
  manifests: ThumbManifest[]
  fontFiles: string[]
  refManifests?: ThumbManifest[]
  ffmpegPath?: string
  concurrency?: number
}): Promise<number>
export declare function listFontFiles(fontsDir: string): Promise<string[]>
