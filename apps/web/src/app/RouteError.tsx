import { TriangleAlert } from 'lucide-react'
import { isRouteErrorResponse, useRouteError } from 'react-router'
import { Button } from '@/components/Button.tsx'
import { EmptyState } from '@/components/EmptyState.tsx'

/** Last-resort error screen (render errors, failed lazy chunks after a deploy). */
export function RouteError() {
  const err = useRouteError()
  const message = isRouteErrorResponse(err)
    ? `${err.status} ${err.statusText}`
    : err instanceof Error
      ? err.message
      : 'Unknown error'
  return (
    <div className="grid h-full place-items-center pt-safe pb-safe">
      <EmptyState
        icon={<TriangleAlert size={28} />}
        title="Something went wrong"
        description={<span className="font-mono text-xs break-all">{message}</span>}
        action={
          <div className="flex gap-2">
            <Button onClick={() => location.reload()}>Reload</Button>
            <Button variant="primary" onClick={() => location.assign('/')}>
              Go home
            </Button>
          </div>
        }
      />
    </div>
  )
}
