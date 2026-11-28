/**
 * Timeline chrome that sits on the ruler's right end, away from the clips: a "⋯" with the
 * edit modes (ripple trim, roll) and, on phones (no header column), the track controls; on
 * desktop also the zoom buttons. Phones get a bottom sheet, desktop a small popover.
 */
import { ArrowRightLeft, Ellipsis, Maximize2, WrapText, ZoomIn, ZoomOut } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Sheet } from '@/components/Sheet.tsx'
import { cn } from '@/lib/cn.ts'
import { setEditPref, useEditPref } from '../editPrefs.ts'
import { ShellMenu, ShellMenuItem } from '../ShellMenu.tsx'
import { ZOOM_STEP } from '../shortcuts.ts'
import { RULER_HEIGHT } from './constants.ts'
import type { Row } from './geometry.ts'
import { TrackControls } from './TrackHeaders.tsx'
import type { TimelineView } from './view.ts'

const RIPPLE_HINT = 'Trimming a clip moves the clips after it'
const ROLL_HINT = 'Dragging a cut trims both clips (Alt+drag also rolls)'

function EditModes({ tone }: { tone: 'plain' }) {
  const ripple = useEditPref('ripple')
  const roll = useEditPref('roll')
  return (
    <>
      <ShellMenuItem
        tone={tone}
        icon={<WrapText size={16} />}
        label="Ripple trim"
        hint={RIPPLE_HINT}
        pressed={ripple}
        data-testid="ripple-toggle"
        onClick={() => setEditPref('ripple', !ripple)}
      />
      <ShellMenuItem
        tone={tone}
        icon={<ArrowRightLeft size={16} />}
        label="Roll edit"
        hint={ROLL_HINT}
        pressed={roll}
        data-testid="roll-toggle"
        onClick={() => setEditPref('roll', !roll)}
      />
    </>
  )
}

function Mini({ label, icon, onClick }: { label: string; icon: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-7 place-items-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-fg"
    >
      {icon}
    </button>
  )
}

export function TimelineOptions({
  view,
  desktop,
  rows,
  captionsEnabled,
}: {
  view: TimelineView
  desktop: boolean
  rows: readonly Row[]
  captionsEnabled: boolean
}) {
  const [sheet, setSheet] = useState(false)
  const ripple = useEditPref('ripple')
  const roll = useEditPref('roll')
  const modes = ripple || roll
  return (
    // The fade lets taps through to the ruler (they seek); only the buttons take them.
    <div
      data-tl-ignore
      className="pointer-events-none absolute top-0 right-0 z-40 flex items-center gap-0.5 bg-gradient-to-l from-surface from-70% to-transparent pr-1.5 pl-5 [&>*]:pointer-events-auto"
      style={{ height: RULER_HEIGHT }}
    >
      {desktop && (
        <>
          <Mini
            label="Zoom out"
            icon={<ZoomOut size={14} />}
            onClick={() => view.zoomTo(view.zoom / ZOOM_STEP)}
          />
          <Mini
            label="Zoom in"
            icon={<ZoomIn size={14} />}
            onClick={() => view.zoomTo(view.zoom * ZOOM_STEP)}
          />
          <Mini
            label="Zoom to fit"
            icon={<Maximize2 size={13} />}
            onClick={() => {
              view.zoomTo(view.fitZoom(), 0)
              view.scrollTo(0)
            }}
          />
        </>
      )}
      {desktop ? (
        <ShellMenu
          label="Timeline options"
          icon={<Ellipsis size={16} />}
          triggerTestId="timeline-options"
          triggerClassName={cn(modes && 'text-accent')}
        >
          {() => <EditModes tone="plain" />}
        </ShellMenu>
      ) : (
        <>
          <button
            type="button"
            aria-label="Timeline options"
            title="Timeline options"
            aria-haspopup="dialog"
            aria-expanded={sheet}
            data-testid="timeline-options"
            onClick={() => setSheet(true)}
            className={cn(
              'relative grid size-7 place-items-center rounded-full transition-colors before:absolute before:-inset-2 before:content-[""] hover:bg-surface-2',
              modes ? 'text-accent' : 'text-muted hover:text-fg',
            )}
          >
            <Ellipsis size={16} />
          </button>
          <Sheet
            open={sheet}
            onClose={() => setSheet(false)}
            title="Timeline"
            snapPoints={[0.6, 0.9]}
            fit
          >
            <div className="flex flex-col gap-4 px-4 pb-4">
              <section aria-label="Editing" className="-mx-2.5 flex flex-col">
                <EditModes tone="plain" />
              </section>
              <TrackControls
                rows={rows}
                captionsEnabled={captionsEnabled}
                onAdded={() => setSheet(false)}
              />
            </div>
          </Sheet>
        </>
      )}
    </div>
  )
}
