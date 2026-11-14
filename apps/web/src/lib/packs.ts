/** Helpers over the synced trend packs (`GET /api/packs`). */
import type { TemplatePreset } from '@reelforge/core'
import type { Packs } from '@/api/schemas.ts'

export interface TemplateEntry {
  /** `<packId>/<templateId>` — what `POST /api/projects` expects as `templateRef`. */
  ref: string
  packId: string
  template: TemplatePreset
  /** Pack-relative thumbnail path (resolve with `api.packFileUrl`), if any. */
  thumbPath?: string
  /** Sum of slot durations (us). */
  duration: number
}

/** All templates across packs, most trending first (ties: name). */
export const listTemplates = (packs: Packs | undefined): TemplateEntry[] => {
  if (!packs) return []
  const out: TemplateEntry[] = []
  for (const m of packs.manifests) {
    for (const t of m.templates) {
      out.push({
        ref: `${m.id}/${t.id}`,
        packId: m.id,
        template: t,
        ...(t.thumb ? { thumbPath: `${m.id}/${t.thumb}` } : {}),
        duration: t.slots.reduce((sum, s) => sum + s.duration, 0),
      })
    }
  }
  return out.sort(
    (a, b) =>
      b.template.trendScore - a.template.trendScore ||
      a.template.name.localeCompare(b.template.name),
  )
}

/** Font faces shipped in packs, for the preview engine's text renderer. */
export const packFonts = (
  packs: Packs | undefined,
  fileUrl: (path: string) => string,
): { family: string; url: string }[] =>
  packs?.index.fonts.flatMap((f) =>
    f.files.map((file) => ({ family: f.family, url: fileUrl(file.path) })),
  ) ?? []
