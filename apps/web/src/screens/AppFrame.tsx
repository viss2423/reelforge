import { Clapperboard, Film, Settings } from 'lucide-react'
import type { ReactNode } from 'react'
import { NavLink } from 'react-router'
import { cn } from '@/lib/cn.ts'
import { Logo } from './Logo.tsx'

const NAV = [
  { to: '/', label: 'Projects', icon: Clapperboard, end: true },
  { to: '/exports', label: 'Exports', icon: Film, end: false },
  { to: '/settings', label: 'Settings', icon: Settings, end: false },
] as const

export interface AppFrameProps {
  title: string
  /** Right side of the header. */
  actions?: ReactNode
  children: ReactNode
}

/**
 * Chrome for the non-editor screens: a header, a bottom tab bar on phones and the same
 * links inline in the header on wider screens. Content scrolls inside so the bars never move.
 */
export function AppFrame({ title, actions, children }: AppFrameProps) {
  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b border-line bg-canvas/90 pt-safe backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 pr-[max(1rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))]">
          <Logo className="size-8" />
          <h1 className="min-w-0 flex-1 truncate text-lg font-bold">{title}</h1>
          <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  cn(
                    'flex h-10 items-center gap-2 rounded-xl px-3 text-sm font-semibold',
                    isActive ? 'bg-surface-2 text-fg' : 'text-muted hover:text-fg',
                  )
                }
              >
                <Icon size={18} />
                {label}
              </NavLink>
            ))}
          </nav>
          {actions}
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-6xl pr-[max(1rem,env(safe-area-inset-right))] pb-8 pl-[max(1rem,env(safe-area-inset-left))]">
          {children}
        </div>
      </main>
      <nav
        aria-label="Main"
        className="grid shrink-0 grid-cols-3 border-t border-line bg-surface pb-safe md:hidden"
      >
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                'flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold',
                isActive ? 'text-accent' : 'text-muted',
              )
            }
          >
            <Icon size={22} />
            {label}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}

/** Section heading used across screens. */
export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mt-6 mb-3 flex items-center justify-between gap-3">
      <h2 className="text-base font-bold">{children}</h2>
      {action}
    </div>
  )
}
