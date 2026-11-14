import { Spinner } from '@/components/Spinner.tsx'

/** Full-screen loading state used while routes or the session load. */
export function Splash() {
  return (
    <div className="grid h-full place-items-center text-muted" data-testid="splash">
      <Spinner size={28} />
    </div>
  )
}
