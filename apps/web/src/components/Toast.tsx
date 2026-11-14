import { CircleAlert, CircleCheck, Info, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import { cn } from '@/lib/cn.ts'

export type ToastTone = 'info' | 'success' | 'error'

export interface ToastItem {
  id: number
  title: string
  description?: string | undefined
  tone: ToastTone
  action?: { label: string; onClick: () => void } | undefined
  duration: number
}

const store = createStore<{ toasts: ToastItem[] }>()(() => ({ toasts: [] }))
let seq = 0
const timers = new Map<number, ReturnType<typeof setTimeout>>()

export const dismissToast = (id: number): void => {
  clearTimeout(timers.get(id))
  timers.delete(id)
  store.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}

/**
 * Shows a toast. Callable from anywhere (not only components). Identical consecutive
 * messages are collapsed so a flaky network doesn't stack ten "Offline" toasts.
 */
export const toast = (
  title: string,
  opts: {
    description?: string
    tone?: ToastTone
    action?: ToastItem['action']
    duration?: number
  } = {},
): number => {
  const tone = opts.tone ?? 'info'
  const existing = store.getState().toasts.find((t) => t.title === title && t.tone === tone)
  if (existing) dismissToast(existing.id)
  const id = ++seq
  const duration = opts.duration ?? (tone === 'error' ? 6000 : 3500)
  store.setState((s) => ({
    toasts: [
      ...s.toasts.slice(-3),
      { id, title, description: opts.description, tone, action: opts.action, duration },
    ],
  }))
  if (duration > 0)
    timers.set(
      id,
      setTimeout(() => dismissToast(id), duration),
    )
  return id
}
toast.success = (title: string, description?: string) =>
  toast(title, { tone: 'success', ...(description ? { description } : {}) })
toast.error = (title: string, description?: string) =>
  toast(title, { tone: 'error', ...(description ? { description } : {}) })

const ICONS = { info: Info, success: CircleCheck, error: CircleAlert }

/** Renders the toast stack; mount once at the app root. */
export function Toaster() {
  const toasts = useStore(store, (s) => s.toasts)
  return createPortal(
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-0 z-[100] flex flex-col items-center gap-2 px-3 pt-[max(env(safe-area-inset-top),12px)]"
    >
      {toasts.map((t) => {
        const Icon = ICONS[t.tone]
        return (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            className="animate-fade-in pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-2xl border border-line bg-surface-2/95 p-3 shadow-pop backdrop-blur"
          >
            <Icon
              size={20}
              className={cn(
                'mt-0.5 shrink-0',
                t.tone === 'error' && 'text-danger',
                t.tone === 'success' && 'text-success',
                t.tone === 'info' && 'text-violet',
              )}
            />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{t.title}</p>
              {t.description && <p className="mt-0.5 text-sm text-muted">{t.description}</p>}
            </div>
            {t.action && (
              <button
                type="button"
                className="touch-target -my-2 shrink-0 rounded-lg px-2 font-semibold text-accent"
                onClick={() => {
                  t.action?.onClick()
                  dismissToast(t.id)
                }}
              >
                {t.action.label}
              </button>
            )}
            <button
              type="button"
              aria-label="Dismiss"
              className="touch-target -m-2 grid shrink-0 place-items-center text-muted"
              onClick={() => dismissToast(t.id)}
            >
              <X size={16} />
            </button>
          </div>
        )
      })}
    </div>,
    document.body,
  )
}
