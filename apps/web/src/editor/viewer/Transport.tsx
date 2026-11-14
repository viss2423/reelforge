import { formatTimecode } from '@reelforge/core'
import {
  ChevronFirst,
  ChevronLast,
  Maximize,
  Minimize,
  Pause,
  Play,
  StepBack,
  StepForward,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { IconButton } from '@/components/IconButton.tsx'
import { cn } from '@/lib/cn.ts'
import { editorStore } from '@/state/editorStore.ts'
import { timelineEnd, useDuration, usePlayhead, usePlaying } from '@/state/selectors.ts'
import { stepFrames } from '../actions.ts'

/** Current / total timecode. Isolated so 60 fps playhead updates re-render only this. */
function Timecode() {
  const t = usePlayhead()
  const total = useDuration()
  return (
    // Phones stack current over total so the centred controls never get overlapped.
    <span
      className="flex flex-col font-mono text-[11px] leading-tight whitespace-nowrap tabular-nums text-muted sm:flex-row sm:gap-1 sm:text-xs"
      data-testid="timecode"
    >
      <span className="text-fg">{formatTimecode(t)}</span>
      <span>
        <span className="max-sm:hidden">/ </span>
        {formatTimecode(total)}
      </span>
    </span>
  )
}

export interface TransportProps {
  fullscreen: boolean
  onToggleFullscreen: () => void
  /** Extra controls on the left (e.g. the mobile "add media" button). */
  leading?: ReactNode
  /** Extra controls on the right. */
  trailing?: ReactNode
  className?: string
}

/** Play/pause, frame step, jump to start/end, timecode and fullscreen. */
export function Transport({
  fullscreen,
  onToggleFullscreen,
  leading,
  trailing,
  className,
}: TransportProps) {
  const playing = usePlaying()
  const s = editorStore.getState
  return (
    <div className={cn('flex h-12 items-center gap-1 px-2', className)}>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {leading}
        <Timecode />
      </div>
      <div className="flex items-center">
        <IconButton
          label="Go to start"
          icon={<ChevronFirst size={20} />}
          // max-sm: variant (not `hidden sm:inline-flex`): it must beat IconButton's own display class.
          className="max-sm:hidden"
          onClick={() => s().setPlayhead(0)}
        />
        <IconButton
          label="Previous frame"
          icon={<StepBack size={20} />}
          onClick={() => stepFrames(editorStore, -1)}
        />
        <IconButton
          label={playing ? 'Pause' : 'Play'}
          icon={
            playing ? (
              <Pause size={24} fill="currentColor" />
            ) : (
              <Play size={24} fill="currentColor" />
            )
          }
          onClick={() => s().togglePlaying()}
          data-testid="play-toggle"
        />
        <IconButton
          label="Next frame"
          icon={<StepForward size={20} />}
          onClick={() => stepFrames(editorStore, 1)}
        />
        <IconButton
          label="Go to end"
          icon={<ChevronLast size={20} />}
          // max-sm: variant (not `hidden sm:inline-flex`): it must beat IconButton's own display class.
          className="max-sm:hidden"
          onClick={() => s().setPlayhead(timelineEnd(s().project))}
        />
      </div>
      <div className="flex flex-1 items-center justify-end gap-1">
        {trailing}
        <IconButton
          label={fullscreen ? 'Exit full screen' : 'Full screen'}
          icon={fullscreen ? <Minimize size={20} /> : <Maximize size={20} />}
          onClick={onToggleFullscreen}
        />
      </div>
    </div>
  )
}
