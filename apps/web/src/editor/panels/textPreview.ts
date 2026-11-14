/**
 * CSS previews of text/caption styles for gallery tiles and the font list. Pack fonts are
 * registered with the document once as FontFace objects: registering is free, and the
 * browser downloads a face only when a tile actually renders text in it.
 */
import type { TextStyle } from '@reelforge/core'
import type { CSSProperties } from 'react'
import { api } from '@/api/index.ts'
import type { Packs } from '@/api/schemas.ts'

const registered = new Set<string>()

/** Registers every pack font face (idempotent; no-op where FontFace is unavailable). */
export const registerPackFonts = (packs: Packs | undefined): void => {
  if (!packs || typeof FontFace === 'undefined' || typeof document === 'undefined') return
  for (const f of packs.index.fonts) {
    for (const file of f.files) {
      if (registered.has(file.path)) continue
      registered.add(file.path)
      const face = new FontFace(f.family, `url("${api.packFileUrl(file.path)}")`, {
        weight: String(file.weight),
        style: file.italic ? 'italic' : 'normal',
        display: 'swap',
      })
      document.fonts.add(face)
    }
  }
}

/** Font families every install ships (shared convention), used before packs load. */
export const FALLBACK_FAMILIES = [
  'Anton',
  'Archivo Black',
  'Bangers',
  'Bebas Neue',
  'Caveat',
  'Inter',
  'Lilita One',
  'Montserrat',
  'Oswald',
  'Pacifico',
  'Permanent Marker',
  'Playfair Display',
  'Poppins',
  'Roboto',
  'Rubik',
] as const

/**
 * Inline style approximating a TextStyle at `scale` (1 = canvas px). Stroke uses
 * paint-order so the outline sits behind the fill, as libass renders it.
 */
export const textPreviewStyle = (s: TextStyle, scale: number): CSSProperties => ({
  fontFamily: `"${s.fontFamily}", system-ui, sans-serif`,
  fontWeight: s.fontWeight,
  fontStyle: s.italic ? 'italic' : 'normal',
  fontSize: Math.max(8, s.fontSize * scale),
  lineHeight: s.lineHeight,
  letterSpacing: s.letterSpacing * scale,
  textTransform: s.uppercase ? 'uppercase' : 'none',
  textAlign: s.align,
  color: s.color,
  WebkitTextStroke:
    s.strokeWidth > 0
      ? `${Math.max(0.5, s.strokeWidth * scale * 2)}px ${s.strokeColor}`
      : undefined,
  paintOrder: 'stroke fill',
  textShadow:
    s.shadowBlur > 0 || s.shadowX !== 0 || s.shadowY !== 0
      ? `${s.shadowX * scale}px ${s.shadowY * scale}px ${s.shadowBlur * scale}px ${s.shadowColor}`
      : undefined,
  backgroundColor: s.backgroundColor,
  padding: s.backgroundColor
    ? `${s.backgroundPadding * scale * 0.5}px ${s.backgroundPadding * scale}px`
    : undefined,
  borderRadius: s.backgroundColor ? s.backgroundRadius * scale : undefined,
  overflowWrap: 'anywhere',
})
