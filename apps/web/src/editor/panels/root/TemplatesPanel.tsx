/**
 * Templates: apply a trending reel skeleton to the media already in this project (one undo
 * step), or start a new project from it with the same media.
 */
import { applyTemplate, formatTimecode, type Asset, type Project } from '@reelforge/core'
import { LayoutTemplate } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useCreateProject, useTrends } from '@/api/queries.ts'
import { AdaptiveModal } from '@/components/Dialog.tsx'
import { Button } from '@/components/Button.tsx'
import { toast } from '@/components/Toast.tsx'
import { listTemplates, type TemplateEntry } from '@/lib/packs.ts'
import { editorStore } from '@/state/editorStore.ts'
import { usePacksData } from '../hooks.ts'
import { describeError, edit } from '../model/commands.ts'
import { mainMediaClips } from '../model/draft.ts'
import { Gallery, Hint, PackThumb, PanelBody, Tile } from '../ui.tsx'

/** Distinct assets of the main track, in timeline order (the template's slot fillers). */
export const templateMedia = (p: Project, assets: Readonly<Record<string, Asset>>): Asset[] => {
  const seen = new Set<string>()
  const out: Asset[] = []
  for (const c of mainMediaClips(p)) {
    const a = assets[c.assetId]
    if (a && !seen.has(a.id)) {
      seen.add(a.id)
      out.push(a)
    }
  }
  return out
}

/**
 * Replaces the project's content with `template` filled by `media`, keeping identity
 * (id, name, created date, revision) so sync and history treat it as an edit.
 */
export const applyTemplateInPlace = (
  d: Project,
  entry: TemplateEntry,
  media: readonly Asset[],
  manifests: Parameters<typeof applyTemplate>[2]['packs'],
): void => {
  const next = applyTemplate(entry.template, media, { packs: manifests, name: d.name })
  d.settings = next.settings
  d.tracks = next.tracks
  d.markers = next.markers
  d.templateRef = entry.ref
  // Captions are timeline-timed: the template re-cuts everything, so old words would be
  // out of sync. The template's caption style (if any) replaces them; auto captions re-run
  // instantly because transcripts are cached per asset on the host.
  if (next.captions) d.captions = next.captions
  else delete d.captions
}

export function TemplatesPanel() {
  const packs = usePacksData()
  const trends = useTrends()
  const templates = listTemplates(packs, trends.data)
  const [picked, setPicked] = useState<TemplateEntry | null>(null)
  const navigate = useNavigate()
  const create = useCreateProject()

  const media = () => {
    const s = editorStore.getState()
    return s.project ? templateMedia(s.project, s.assets) : []
  }

  const useHere = (entry: TemplateEntry) => {
    const m = media()
    if (m.length === 0) {
      toast('Add your clips first', { description: 'Templates fill their slots with your media.' })
      return
    }
    const ok = edit(`Template: ${entry.template.name}`, (d) =>
      applyTemplateInPlace(d, entry, m, packs?.manifests ?? []),
    )
    if (ok !== undefined) {
      setPicked(null)
      toast.success(`Applied ${entry.template.name}`)
    }
  }

  const startNew = async (entry: TemplateEntry) => {
    try {
      const project = await create.mutateAsync({
        name: entry.template.name,
        templateRef: entry.ref,
        assetIds: media().map((a) => a.id),
      })
      setPicked(null)
      void navigate(`/p/${project.id}`)
    } catch (err) {
      toast.error("Couldn't create the project", describeError(err))
    }
  }

  return (
    <PanelBody>
      {templates.length === 0 ? (
        <Hint>Templates arrive with trend packs — sync packs in Settings.</Hint>
      ) : (
        <Gallery label="Templates">
          {templates.map((t) => (
            <Tile
              key={t.ref}
              label={t.template.name}
              aspect="portrait"
              onClick={() => setPicked(t)}
              badge={
                <>
                  {t.fresh && (
                    <span className="absolute top-1 left-1 rounded bg-accent px-1 text-[10px] font-semibold text-accent-fg">
                      New today
                    </span>
                  )}
                  <span className="absolute right-1 bottom-1 rounded bg-black/60 px-1 text-[10px] text-white tabular-nums">
                    {t.template.slots.length} · {formatTimecode(t.duration, false)}
                  </span>
                </>
              }
            >
              {t.thumbPath ? (
                <PackThumb path={t.thumbPath} />
              ) : (
                <LayoutTemplate size={24} className="text-muted" />
              )}
            </Tile>
          ))}
        </Gallery>
      )}
      <AdaptiveModal
        open={picked !== null}
        onClose={() => setPicked(null)}
        title={picked?.template.name ?? 'Template'}
        snapPoints={[0.5]}
      >
        {picked && (
          <div className="flex flex-col gap-4 py-2">
            {picked.template.description && (
              <p className="text-sm text-muted">{picked.template.description}</p>
            )}
            <p className="text-sm">
              {picked.template.slots.length} clips · {formatTimecode(picked.duration, false)}
              {picked.template.musicHint ? ` · ♪ ${picked.template.musicHint.title}` : ''}
            </p>
            <Button
              variant="primary"
              size="lg"
              block
              className="panels-cta"
              onClick={() => useHere(picked)}
            >
              Use with my clips
            </Button>
            <Button
              block
              variant="ghost"
              loading={create.isPending}
              onClick={() => void startNew(picked)}
            >
              New project from template
            </Button>
          </div>
        )}
      </AdaptiveModal>
    </PanelBody>
  )
}
