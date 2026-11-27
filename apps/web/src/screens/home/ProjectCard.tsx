import { Clapperboard, Copy, EllipsisVertical, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { api } from '@/api/index.ts'
import { useDeleteProject, useDuplicateProject } from '@/api/queries.ts'
import type { ProjectSummary } from '@/api/schemas.ts'
import { Button } from '@/components/Button.tsx'
import { AdaptiveModal } from '@/components/Dialog.tsx'
import { IconButton } from '@/components/IconButton.tsx'
import { toast } from '@/components/Toast.tsx'
import { formatDuration, formatRelative } from '@/lib/format.ts'

/** 9:16 project tile with poster, duration and an actions menu. */
export function ProjectCard({ project }: { project: ProjectSummary }) {
  const [menu, setMenu] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [posterFailed, setPosterFailed] = useState(false)
  const remove = useDeleteProject()
  const duplicate = useDuplicateProject()

  return (
    <div className="group relative" data-testid="project-card">
      <Link to={`/p/${project.id}`} className="block rounded-2xl">
        <div className="relative aspect-[9/16] overflow-hidden rounded-2xl bg-surface-2 transition-transform duration-200 ease-[var(--ease-spring)] group-active:scale-[0.98]">
          {project.thumbAssetId && !posterFailed ? (
            <img
              src={api.posterUrl(project.thumbAssetId)}
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => setPosterFailed(true)}
              className="absolute inset-0 size-full object-cover"
            />
          ) : (
            <div className="absolute inset-0 grid place-items-center bg-gradient-to-br from-violet/25 to-accent/15 text-white/70">
              <Clapperboard size={28} aria-hidden />
            </div>
          )}
          {project.duration > 0 && (
            <span className="glass absolute bottom-2 left-2 rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums">
              {formatDuration(project.duration)}
            </span>
          )}
        </div>
        <div className="pt-2 pr-9">
          <p className="truncate text-[15px] font-semibold">{project.name}</p>
          <p className="truncate text-xs text-muted">{formatRelative(project.updatedAt)}</p>
        </div>
      </Link>
      <IconButton
        label={`Options for ${project.name}`}
        icon={<EllipsisVertical size={18} />}
        className="absolute -right-2 bottom-0 text-muted"
        onClick={() => setMenu(true)}
      />

      <AdaptiveModal
        open={menu}
        onClose={() => setMenu(false)}
        title={project.name}
        snapPoints={[0.34]}
      >
        <div className="flex flex-col gap-2">
          <Button
            icon={<Copy size={18} />}
            loading={duplicate.isPending}
            onClick={() =>
              duplicate.mutate(project.id, {
                onSuccess: () => {
                  setMenu(false)
                  toast.success('Project duplicated')
                },
                onError: (e) => toast.error('Could not duplicate', e.message),
              })
            }
          >
            Duplicate
          </Button>
          <Button
            variant="ghost"
            className="text-danger"
            icon={<Trash2 size={18} />}
            onClick={() => {
              setMenu(false)
              setConfirm(true)
            }}
          >
            Delete…
          </Button>
        </div>
      </AdaptiveModal>

      <AdaptiveModal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Delete project?"
        description={`“${project.name}” will be deleted. Your media stays in the library.`}
        locked={remove.isPending}
        snapPoints={[0.34]}
        footer={
          <>
            <Button block onClick={() => setConfirm(false)} disabled={remove.isPending}>
              Cancel
            </Button>
            <Button
              block
              variant="danger"
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(project.id, {
                  onSuccess: () => setConfirm(false),
                  onError: (e) => toast.error('Could not delete', e.message),
                })
              }
            >
              Delete
            </Button>
          </>
        }
      />
    </div>
  )
}
