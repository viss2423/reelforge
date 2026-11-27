/**
 * Panel registry: what each `activePanel` id renders, its title and its sheet height. Used
 * by the phone sheets and by the desktop inspector (which shows the same panels).
 */
import type { Clip } from '@reelforge/core'
import type { ReactNode } from 'react'
import { locateClip, useEditor, useSelectedClip } from '@/state/selectors.ts'
import { AiPanel } from './ai/AiPanel.tsx'
import { hasAudio, isMedia, isSticker, isText, isVisual } from './model/draft.ts'
import { CLIP_PANEL, ROOT_PANEL, type ClipPanelId, type PanelId } from './panelIds.ts'
import { AudioPanel } from './root/AudioPanel.tsx'
import { CaptionsPanel } from './root/CaptionsPanel.tsx'
import { LookPanel } from './root/LookPanel.tsx'
import { StickersPanel } from './root/StickersPanel.tsx'
import { TemplatesPanel } from './root/TemplatesPanel.tsx'
import { TextPanel } from './root/TextPanel.tsx'
import { AnimationSection } from './sections/AnimationSection.tsx'
import { AudioSection } from './sections/AudioSection.tsx'
import { BackgroundSection } from './sections/BackgroundSection.tsx'
import { CanvasSection } from './sections/CanvasSection.tsx'
import { ChromaSection } from './sections/ChromaSection.tsx'
import { AdjustSection, EffectsSection, FilterSection } from './sections/LookSections.tsx'
import { ReplaceSection } from './sections/ReplaceSection.tsx'
import { SpeedSection } from './sections/SpeedSection.tsx'
import { TextSection } from './sections/TextSection.tsx'
import { TransformSection } from './sections/TransformSection.tsx'
import { TransitionSection } from './sections/TransitionSection.tsx'
import { PanelBody, PanelTitle } from './ui.tsx'

export interface PanelDef {
  title: string
  /** Sheet snap points on phones (fractions of the viewport). */
  snap: readonly number[]
  render: () => ReactNode
}

const SHORT = [0.42] as const
const TALL = [0.5, 0.9] as const

/** Whether a clip panel can edit `clip` (on `trackKind`). */
export const clipPanelApplies = (
  id: ClipPanelId,
  clip: Clip | undefined,
  trackKind?: string,
): boolean => {
  switch (id) {
    case CLIP_PANEL.speed:
    case CLIP_PANEL.volume:
    case CLIP_PANEL.fade:
      return hasAudio(clip)
    case CLIP_PANEL.animations:
      return isText(clip) || isSticker(clip)
    case CLIP_PANEL.text:
      return isText(clip)
    case CLIP_PANEL.adjust:
    case CLIP_PANEL.filter:
    case CLIP_PANEL.effects:
    case CLIP_PANEL.chroma:
    case CLIP_PANEL.background:
      return isMedia(clip)
    case CLIP_PANEL.transform:
      return isVisual(clip)
    case CLIP_PANEL.replace:
      return isMedia(clip) || clip?.type === 'audio'
    case CLIP_PANEL.transition:
      return isMedia(clip) && trackKind === 'main'
  }
}

/** Renders a clip panel for the selected clip (nothing when it doesn't apply). */
function ClipPanel({ id }: { id: ClipPanelId }) {
  const clip = useSelectedClip()
  const trackKind = useEditor((s) =>
    clip ? locateClip(s.project, clip.id)?.track.kind : undefined,
  )
  if (!clip || !clipPanelApplies(id, clip, trackKind)) return null
  return (
    <PanelBody>
      <ClipPanelContent id={id} clip={clip} trackKind={trackKind} />
    </PanelBody>
  )
}

function ClipPanelContent({
  id,
  clip,
  trackKind,
}: {
  id: ClipPanelId
  clip: Clip
  trackKind: string | undefined
}) {
  switch (id) {
    case CLIP_PANEL.speed:
      return hasAudio(clip) ? <SpeedSection clip={clip} /> : null
    case CLIP_PANEL.volume:
      return hasAudio(clip) ? <AudioSection clip={clip} parts="volume" /> : null
    case CLIP_PANEL.fade:
      return hasAudio(clip) ? <AudioSection clip={clip} parts="fade" /> : null
    case CLIP_PANEL.animations:
      return isText(clip) || isSticker(clip) ? <AnimationSection clip={clip} /> : null
    case CLIP_PANEL.text:
      return isText(clip) ? <TextSection clip={clip} /> : null
    case CLIP_PANEL.adjust:
      return isMedia(clip) ? <AdjustSection clips={[clip]} /> : null
    case CLIP_PANEL.filter:
      return isMedia(clip) ? <FilterSection clips={[clip]} /> : null
    case CLIP_PANEL.effects:
      return isMedia(clip) ? <EffectsSection clips={[clip]} /> : null
    case CLIP_PANEL.transform:
      return isVisual(clip) ? (
        <TransformSection clip={clip} onOverlay={trackKind === 'overlay'} />
      ) : null
    case CLIP_PANEL.chroma:
      return isMedia(clip) ? <ChromaSection clip={clip} /> : null
    case CLIP_PANEL.background:
      return isMedia(clip) ? <BackgroundSection clip={clip} /> : null
    case CLIP_PANEL.replace:
      return isMedia(clip) || clip.type === 'audio' ? <ReplaceSection clip={clip} /> : null
    case CLIP_PANEL.transition:
      return isMedia(clip) ? <TransitionSection clip={clip} /> : null
  }
}

const clipPanel = (id: ClipPanelId, title: string, snap: readonly number[] = SHORT): PanelDef => ({
  title,
  snap,
  render: () => <ClipPanel id={id} />,
})

const DEFS: Readonly<Record<PanelId, PanelDef>> = {
  [ROOT_PANEL.audio]: { title: 'Audio', snap: TALL, render: () => <AudioPanel /> },
  [ROOT_PANEL.text]: { title: 'Text', snap: TALL, render: () => <TextPanel /> },
  [ROOT_PANEL.captions]: { title: 'Captions', snap: TALL, render: () => <CaptionsPanel /> },
  [ROOT_PANEL.stickers]: { title: 'Stickers', snap: TALL, render: () => <StickersPanel /> },
  [ROOT_PANEL.effects]: {
    title: 'Effects',
    snap: TALL,
    render: () => <LookPanel kind="effects" />,
  },
  [ROOT_PANEL.filters]: {
    title: 'Filters',
    snap: TALL,
    render: () => <LookPanel kind="filters" />,
  },
  [ROOT_PANEL.templates]: { title: 'Templates', snap: TALL, render: () => <TemplatesPanel /> },
  [ROOT_PANEL.ai]: { title: 'Magic', snap: TALL, render: () => <AiPanel /> },
  [ROOT_PANEL.canvas]: {
    title: 'Canvas',
    snap: TALL,
    render: () => (
      <PanelBody>
        <CanvasSection />
      </PanelBody>
    ),
  },
  [CLIP_PANEL.speed]: clipPanel(CLIP_PANEL.speed, 'Speed', TALL),
  [CLIP_PANEL.volume]: clipPanel(CLIP_PANEL.volume, 'Volume', TALL),
  [CLIP_PANEL.fade]: clipPanel(CLIP_PANEL.fade, 'Fade'),
  [CLIP_PANEL.animations]: clipPanel(CLIP_PANEL.animations, 'Animations', TALL),
  [CLIP_PANEL.text]: clipPanel(CLIP_PANEL.text, 'Edit text', TALL),
  [CLIP_PANEL.adjust]: clipPanel(CLIP_PANEL.adjust, 'Adjust', TALL),
  [CLIP_PANEL.filter]: clipPanel(CLIP_PANEL.filter, 'Filter', TALL),
  [CLIP_PANEL.effects]: clipPanel(CLIP_PANEL.effects, 'Effects', TALL),
  [CLIP_PANEL.transform]: clipPanel(CLIP_PANEL.transform, 'Transform & crop', TALL),
  [CLIP_PANEL.chroma]: clipPanel(CLIP_PANEL.chroma, 'Chroma key', TALL),
  [CLIP_PANEL.background]: clipPanel(CLIP_PANEL.background, 'Background', TALL),
  [CLIP_PANEL.replace]: clipPanel(CLIP_PANEL.replace, 'Replace', TALL),
  [CLIP_PANEL.transition]: clipPanel(CLIP_PANEL.transition, 'Transition', TALL),
}

/** Every panel knows its title, so sections can skip a heading that repeats it. */
export const PANELS: Readonly<Record<PanelId, PanelDef>> = Object.fromEntries(
  Object.entries(DEFS).map(([id, def]) => [
    id,
    {
      ...def,
      render: () => <PanelTitle.Provider value={def.title}>{def.render()}</PanelTitle.Provider>,
    },
  ]),
) as Record<PanelId, PanelDef>

export const panelDef = (id: string | null): PanelDef | undefined =>
  id !== null && id in PANELS ? PANELS[id as PanelId] : undefined
