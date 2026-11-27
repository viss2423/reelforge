/**
 * Editor route (/p/:projectId). Owns the session (load → autosave → live sync), keyboard
 * shortcuts and the responsive shell; the timeline, tool panels and inspector plug into
 * the slots documented in ./README.md.
 *
 *  Phone (< 1024 px)                 Desktop (≥ 1024 px)
 *  ┌───────────────────┐             ┌──────────────────────────────────────────┐
 *  │ TopBar            │             │ TopBar                                   │
 *  │ Preview + Transport│            ├─────────┬────────────────────┬───────────┤
 *  ├───────────────────┤             │ Media   │ Preview + Transport│ Inspector │
 *  │ Timeline slot     │             │ library │                    │ slot      │
 *  ├───────────────────┤             ├─────────┴────────────────────┴───────────┤
 *  │ ToolPanels slot   │             │ ToolPanels slot (desktop strip)          │
 *  └───────────────────┘             │ Timeline slot                            │
 *   + media Sheet                    └──────────────────────────────────────────┘
 */
import { FileQuestion, Plus, TriangleAlert } from 'lucide-react'
import { useParams, useNavigate } from 'react-router'
import { ApiError } from '@/api/index.ts'
import { Button } from '@/components/Button.tsx'
import { EmptyState } from '@/components/EmptyState.tsx'
import { IconButton } from '@/components/IconButton.tsx'
import { Sheet } from '@/components/Sheet.tsx'
import { Splash } from '@/app/Splash.tsx'
import { useIsDesktop } from '@/lib/useMediaQuery.ts'
import { editorStore } from '@/state/editorStore.ts'
import { useActivePanel } from '@/state/selectors.ts'
import { Inspector } from './inspector/index.tsx'
import {
  DESKTOP_INSPECTOR_WIDTH,
  DESKTOP_LIBRARY_WIDTH,
  DESKTOP_TIMELINE_HEIGHT,
  MEDIA_PANEL,
  MOBILE_TIMELINE_VH,
} from './layout.ts'
import { MediaLibrary } from './media/MediaLibrary.tsx'
import { ToolPanels } from './panels/index.tsx'
import { useProjectSession } from './session.ts'
import { useEditorShortcuts } from './shortcuts.ts'
import { Timeline } from './timeline/index.tsx'
import { TopBar } from './TopBar.tsx'
import { useAutoEditLauncher } from './panels/ai/autoedit/session.ts'
import { useAutoInsertUploads } from './useAutoInsertUploads.ts'
import { PreviewArea } from './viewer/PreviewArea.tsx'

export function EditorScreen() {
  const { projectId = '' } = useParams()
  const session = useProjectSession(projectId)
  useAutoInsertUploads(projectId)
  useAutoEditLauncher(projectId)

  if (session.status === 'error') return <SessionError error={session.error} />
  if (session.status === 'loading') return <Splash />
  return <EditorShell />
}

/** Mounted only once the project is in the store, so slots can assume `project !== null`. */
function EditorShell() {
  useEditorShortcuts()
  const desktop = useIsDesktop()
  return (
    <div className="flex h-full flex-col bg-canvas pt-safe" data-testid="editor">
      <TopBar />
      {desktop ? <DesktopLayout /> : <MobileLayout />}
    </div>
  )
}

function DesktopLayout() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        <aside
          className="flex shrink-0 flex-col border-r border-line bg-surface"
          style={{ width: DESKTOP_LIBRARY_WIDTH }}
        >
          <MediaLibrary className="flex-1" />
        </aside>
        <PreviewArea className="min-w-0 flex-1" />
        <aside
          className="shrink-0 overflow-y-auto border-l border-line bg-surface"
          style={{ width: DESKTOP_INSPECTOR_WIDTH }}
          aria-label="Inspector"
          data-slot="inspector"
        >
          <Inspector />
        </aside>
      </div>
      <div className="shrink-0 border-t border-line bg-surface pb-safe">
        <div data-slot="tools">
          <ToolPanels variant="desktop" />
        </div>
        <div style={{ height: DESKTOP_TIMELINE_HEIGHT }} data-slot="timeline">
          <Timeline />
        </div>
      </div>
    </div>
  )
}

function MobileLayout() {
  const panel = useActivePanel()
  const s = editorStore.getState
  const closeMedia = () => {
    if (s().activePanel === MEDIA_PANEL) s().setActivePanel(null)
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PreviewArea
        className="min-h-0 flex-1"
        transportLeading={
          <IconButton
            label="Add media"
            icon={<Plus size={22} />}
            onClick={() => s().setActivePanel(MEDIA_PANEL)}
            className="bg-surface-2"
            data-testid="add-media"
          />
        }
      />
      <div
        className="shrink-0 border-t border-line bg-surface"
        style={{ height: `${MOBILE_TIMELINE_VH * 100}dvh` }}
        data-slot="timeline"
      >
        <Timeline />
      </div>
      <div className="shrink-0 border-t border-line bg-surface pb-safe" data-slot="tools">
        <ToolPanels variant="mobile" />
      </div>
      <Sheet
        open={panel === MEDIA_PANEL}
        onClose={closeMedia}
        title="Media"
        modal={false}
        snapPoints={[0.55, 0.92]}
      >
        <MediaLibrary onAdded={closeMedia} className="h-full" />
      </Sheet>
    </div>
  )
}

function SessionError({ error }: { error: Error }) {
  const navigate = useNavigate()
  const notFound = error instanceof ApiError && error.status === 404
  return (
    <div className="grid h-full place-items-center pt-safe pb-safe">
      <EmptyState
        icon={notFound ? <FileQuestion size={28} /> : <TriangleAlert size={28} />}
        title={notFound ? 'Project not found' : "Couldn't open this project"}
        description={notFound ? 'It may have been deleted on another device.' : error.message}
        action={
          <Button variant="primary" onClick={() => void navigate('/')}>
            Back to projects
          </Button>
        }
      />
    </div>
  )
}
