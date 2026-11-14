/**
 * Root Filters / Effects tools (nothing selected): apply to the main clip under the
 * playhead or to every main-track clip at once — the quickest way to grade a whole reel.
 */
import type { MediaClip } from '@reelforge/core'
import { useState } from 'react'
import { SegmentedControl } from '@/components/SegmentedControl.tsx'
import { useEditorShallow } from '@/state/selectors.ts'
import { mainClipAt, mainMediaClips } from '../model/draft.ts'
import { AdjustSection, EffectsSection, FilterSection } from '../sections/LookSections.tsx'
import { Hint, PanelBody } from '../ui.tsx'

type Scope = 'playhead' | 'all'

const SCOPES = [
  { value: 'playhead', label: 'This clip' },
  { value: 'all', label: 'All clips' },
] as const

const NONE: readonly MediaClip[] = []

/** Main-track clips a root look tool edits for `scope`. */
export const useLookTargets = (scope: Scope): readonly MediaClip[] =>
  useEditorShallow((s) => {
    if (!s.project) return NONE
    if (scope === 'all') return mainMediaClips(s.project)
    const c = mainClipAt(s.project, s.playhead)
    return c ? [c] : NONE
  })

export function LookPanel({ kind }: { kind: 'filters' | 'effects' | 'adjust' }) {
  const [scope, setScope] = useState<Scope>(kind === 'filters' ? 'all' : 'playhead')
  const clips = useLookTargets(scope)
  return (
    <PanelBody>
      <SegmentedControl label="Apply to" options={SCOPES} value={scope} onChange={setScope} />
      {clips.length === 0 ? (
        <Hint>Add a video or photo to the main track first.</Hint>
      ) : kind === 'filters' ? (
        <FilterSection clips={clips} />
      ) : kind === 'effects' ? (
        <EffectsSection clips={clips} />
      ) : (
        <AdjustSection clips={clips} />
      )}
    </PanelBody>
  )
}
