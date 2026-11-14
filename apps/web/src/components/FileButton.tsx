import { useId, type ReactNode } from 'react'
import { cn } from '@/lib/cn.ts'

/** Media types the host can ingest. */
export const MEDIA_ACCEPT = 'video/*,image/*,audio/*'

export interface FileButtonProps {
  onFiles: (files: File[]) => void
  accept?: string
  multiple?: boolean
  disabled?: boolean
  children: ReactNode
  className?: string
  /** Accessible name when the children are icon-only. */
  label?: string
  testId?: string
}

/**
 * A button that opens the system file / photo picker. Implemented as a `<label>` wrapping
 * a visually hidden `<input type=file>` — the only approach that works inside user-gesture
 * rules on every mobile browser — and keyboard-activatable via the input itself.
 */
export function FileButton({
  onFiles,
  accept = MEDIA_ACCEPT,
  multiple = true,
  disabled = false,
  children,
  className,
  label,
  testId,
}: FileButtonProps) {
  const id = useId()
  return (
    <label
      htmlFor={id}
      aria-label={label}
      className={cn(
        'relative inline-flex cursor-pointer select-none items-center justify-center has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent',
        disabled && 'pointer-events-none opacity-50',
        className,
      )}
    >
      <input
        id={id}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        data-testid={testId}
        className="sr-only"
        onChange={(e) => {
          const files = [...(e.currentTarget.files ?? [])]
          // Reset so picking the same file again still fires `change`.
          e.currentTarget.value = ''
          if (files.length) onFiles(files)
        }}
      />
      {children}
    </label>
  )
}
