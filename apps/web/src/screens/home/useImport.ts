import { useNavigate } from 'react-router'
import { useCreateProject } from '@/api/queries.ts'
import { toast } from '@/components/Toast.tsx'
import { enqueueUploads } from '@/state/uploads.ts'

/** Default name for a new project, e.g. "Reel · Nov 6, 14:05". */
export const newProjectName = (now = new Date()): string =>
  `Reel · ${now.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`

/**
 * Creates a project and opens it. With files, they upload in the background and the editor
 * places each on the timeline (in pick order) as soon as it arrives — the user can start
 * editing the first clip while the rest are still uploading.
 */
export const useStartProject = () => {
  const create = useCreateProject()
  const navigate = useNavigate()
  const start = async (files: readonly File[] = []): Promise<void> => {
    try {
      const project = await create.mutateAsync({ name: newProjectName() })
      if (files.length) enqueueUploads(files, { projectId: project.id, addToTimeline: true })
      void navigate(`/p/${project.id}`)
    } catch (err) {
      toast.error('Could not create the project', err instanceof Error ? err.message : undefined)
    }
  }
  return { start, pending: create.isPending }
}
