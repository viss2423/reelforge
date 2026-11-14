import { Compass } from 'lucide-react'
import { Link } from 'react-router'
import { EmptyState } from '@/components/EmptyState.tsx'

export function NotFound() {
  return (
    <div className="grid h-full place-items-center pt-safe pb-safe">
      <EmptyState
        icon={<Compass size={28} />}
        title="Page not found"
        action={
          <Link to="/" className="font-semibold text-accent">
            Back to projects
          </Link>
        }
      />
    </div>
  )
}
