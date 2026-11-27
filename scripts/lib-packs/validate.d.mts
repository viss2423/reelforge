/** Types for validate.mjs (used by the server's trend engine). */
export declare const BASE_PACK: string
export declare const ID_RE: RegExp
export declare const THUMB_KINDS: Record<string, string>
export declare const COLLECTIONS: string[]
export declare function parseCube(text: string): number
export declare function validatePacks(input: {
  manifests: unknown[]
  fonts: Array<{ family: string; files: Array<{ weight: number; italic: boolean }> }>
  fileExists: (packId: string, rel: string) => boolean
}): string[]
