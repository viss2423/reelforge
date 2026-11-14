import { X } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import { cn } from '@/lib/cn.ts'
import { useIsDesktop } from '@/lib/useMediaQuery.ts'
import { IconButton } from './IconButton.tsx'
import { Sheet } from './Sheet.tsx'

export interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children?: ReactNode
  footer?: ReactNode
  className?: string
  /** Prevents closing via Escape/backdrop (e.g. while a request is running). */
  locked?: boolean
}

/**
 * Centered modal built on native `<dialog>`: the browser provides the top layer, focus
 * trapping, inert background and Escape handling for free.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
  locked,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (open && !el.open) {
      if (typeof el.showModal === 'function') el.showModal()
      else el.setAttribute('open', '')
    } else if (!open && el.open) {
      el.close()
    }
  }, [open])

  return (
    <dialog
      ref={ref}
      aria-label={title}
      className={cn(
        'm-auto w-[min(92vw,32rem)] max-h-[88vh] overflow-hidden rounded-3xl border border-line bg-surface p-0 text-fg shadow-pop backdrop:bg-scrim',
        className,
      )}
      onCancel={(e) => {
        e.preventDefault()
        if (!locked) onClose()
      }}
      onClick={(e) => {
        // Clicks on the ::backdrop target the dialog element itself.
        if (e.target === e.currentTarget && !locked) onClose()
      }}
    >
      {open && (
        <div className="flex max-h-[88vh] flex-col">
          <header className="flex items-start gap-3 px-5 pt-5 pb-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold">{title}</h2>
              {description && <p className="mt-1 text-sm text-muted">{description}</p>}
            </div>
            <IconButton
              label="Close"
              icon={<X size={20} />}
              onClick={onClose}
              disabled={locked}
              className="-mt-2 -mr-2"
            />
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">{children}</div>
          {footer && (
            <footer className="flex gap-2 border-t border-line px-5 py-4">{footer}</footer>
          )}
        </div>
      )}
    </dialog>
  )
}

/** Dialog on desktop, bottom sheet on phones — same props. */
export function AdaptiveModal(props: DialogProps & { snapPoints?: readonly number[] }) {
  const desktop = useIsDesktop()
  if (desktop) return <Dialog {...props} />
  const { open, onClose, title, description, children, footer, locked, snapPoints, className } =
    props
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      dismissible={!locked}
      snapPoints={snapPoints ?? [0.88]}
      {...(className ? { className } : {})}
    >
      <div className="px-4 pb-4">
        {description && <p className="mb-3 text-sm text-muted">{description}</p>}
        {children}
      </div>
      {footer && (
        <div className="sticky bottom-0 flex gap-2 border-t border-line bg-surface px-4 py-3">
          {footer}
        </div>
      )}
    </Sheet>
  )
}
