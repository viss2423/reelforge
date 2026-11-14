/**
 * Desktop inspector slot (see ../README.md). Shows, in order of priority:
 * 1. the panel opened from the tool strip (same panels as the phone sheets);
 * 2. every property section of the selected clip, with numeric inputs (tap a slider's value)
 *    and keyframe diamonds;
 * 3. project settings and AI shortcuts when nothing is selected.
 */
import { formatTimecode, type Clip } from '@reelforge/core'
import { ChevronLeft, MousePointerClick, Wand2, Captions } from 'lucide-react'
import { Button } from '@/components/Button.tsx'
import { IconButton } from '@/components/IconButton.tsx'
import { editorStore } from '@/state/editorStore.ts'
import {
  locateClip,
  useActivePanel,
  useEditorShallow,
  useSelectedClip,
  useSelection,
} from '@/state/selectors.ts'
import { closePanel } from '../panels/index.tsx'
import { hasAudio, isMedia, isSticker, isText, isVisual } from '../panels/model/draft.ts'
import { ROOT_PANEL } from '../panels/panelIds.ts'
import { panelDef } from '../panels/registry.tsx'
import { AnimationSection } from '../panels/sections/AnimationSection.tsx'
import { AudioSection } from '../panels/sections/AudioSection.tsx'
import { CanvasSection } from '../panels/sections/CanvasSection.tsx'
import { ChromaSection } from '../panels/sections/ChromaSection.tsx'
import { AdjustSection, EffectsSection, FilterSection } from '../panels/sections/LookSections.tsx'
import { ReplaceSection } from '../panels/sections/ReplaceSection.tsx'
import { SpeedSection } from '../panels/sections/SpeedSection.tsx'
import { TextSection } from '../panels/sections/TextSection.tsx'
import { TransformSection } from '../panels/sections/TransformSection.tsx'
import { TransitionSection } from '../panels/sections/TransitionSection.tsx'
import { Hint, SectionsCollapsible } from '../panels/ui.tsx'

const TYPE_LABEL: Record<Clip['type'], string> = {
  video: 'Video',
  image: 'Photo',
  audio: 'Audio',
  text: 'Text',
  sticker: 'Sticker',
}

function Header({
  title,
  subtitle,
  onBack,
}: {
  title: string
  subtitle?: string
  onBack?: () => void
}) {
  return (
    <header className="sticky top-0 z-10 flex min-h-14 items-center gap-2 border-b border-line bg-surface/95 px-3 backdrop-blur">
      {onBack && (
        <IconButton
          size="sm"
          label="Back to properties"
          icon={<ChevronLeft size={18} />}
          onClick={onBack}
        />
      )}
      <div className="flex min-w-0 flex-col">
        <h2 className="truncate text-[15px] font-bold">{title}</h2>
        {subtitle && <span className="truncate text-xs text-muted tabular-nums">{subtitle}</span>}
      </div>
    </header>
  )
}

/** All property sections of one clip, in the order editors reach for them. */
export function ClipProperties({ clip }: { clip: Clip }) {
  const where = useEditorShallow((s) => {
    const loc = locateClip(s.project, clip.id)
    return { kind: loc?.track.kind, index: loc?.index ?? 0 }
  })
  const kind = where.kind
  return (
    <SectionsCollapsible value>
      <div className="flex flex-col gap-6 p-4 pb-10">
        {isText(clip) && <TextSection clip={clip} />}
        {(isText(clip) || isSticker(clip)) && <AnimationSection clip={clip} />}
        {isVisual(clip) && <TransformSection clip={clip} onOverlay={kind === 'overlay'} />}
        {hasAudio(clip) && <SpeedSection clip={clip} />}
        {hasAudio(clip) && <AudioSection clip={clip} />}
        {isMedia(clip) && (
          <>
            <AdjustSection clips={[clip]} />
            <FilterSection clips={[clip]} />
            <EffectsSection clips={[clip]} />
            <ChromaSection clip={clip} />
          </>
        )}
        {isMedia(clip) && kind === 'main' && where.index > 0 && <TransitionSection clip={clip} />}
        {(isMedia(clip) || clip.type === 'audio') && <ReplaceSection clip={clip} />}
      </div>
    </SectionsCollapsible>
  )
}

function ProjectProperties() {
  const count = useSelection().clipIds.length
  const open = (panel: string) => editorStore.getState().setActivePanel(panel)
  return (
    <div className="flex flex-col gap-6 p-4 pb-10">
      <Hint>
        <span className="flex items-center gap-2">
          <MousePointerClick size={16} className="shrink-0" />
          {count > 1
            ? `${count} clips selected — select one clip to edit it.`
            : 'Select a clip to edit its properties.'}
        </span>
      </Hint>
      <div className="grid grid-cols-2 gap-2">
        <Button icon={<Wand2 size={16} />} onClick={() => open(ROOT_PANEL.ai)}>
          AI tools
        </Button>
        <Button icon={<Captions size={16} />} onClick={() => open(ROOT_PANEL.captions)}>
          Captions
        </Button>
      </div>
      <CanvasSection />
    </div>
  )
}

export function Inspector() {
  const panel = useActivePanel()
  const def = panelDef(panel)
  const clip = useSelectedClip()
  if (def) {
    return (
      <div className="flex min-h-full flex-col">
        <Header title={def.title} onBack={() => closePanel()} />
        {def.render()}
      </div>
    )
  }
  if (clip) {
    return (
      <div className="flex min-h-full flex-col">
        <Header
          title={clip.name ?? TYPE_LABEL[clip.type]}
          subtitle={`${TYPE_LABEL[clip.type]} · ${formatTimecode(clip.start)} · ${formatTimecode(clip.duration)}`}
        />
        <ClipProperties key={clip.id} clip={clip} />
      </div>
    )
  }
  return (
    <div className="flex min-h-full flex-col">
      <Header title="Project" />
      <ProjectProperties />
    </div>
  )
}
