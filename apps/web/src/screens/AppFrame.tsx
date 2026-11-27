import { Clapperboard, Film, Settings, TrendingUp } from 'lucide-react'
import type { ReactNode } from 'react'
import { NavLink } from 'react-router'
import { cn } from '@/lib/cn.ts'
import { Logo } from './Logo.tsx'

const NAV = [
  { to: '/', label: 'Projects', icon: Clapperboard, end: true },
  { to: '/trending', label: 'Trending', icon: TrendingUp, end: false },
  { to: '/exports', label: 'Exports', icon: Film, end: false },
  { to: '/settings', label: 'Settings', icon: Settings, end: false },
] as const

export interface AppFrameProps {
  title: string
  /** Right side of the header. */
  actions?: ReactNode
  children: ReactNode
}

const GUTTER =
  'pr-[max(1rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))] md:px-6'

/**
 * Chrome for the non-editor screens: a calm header, a floating glass tab bar on phones and
 * the same links as a slim top nav on wider screens. Content scrolls inside so the bars
 * never move; the phone bar floats over the bottom of the content.
 */
export function AppFrame({ title, actions, children }: AppFrameProps) {
  return (
    <div className="relative flex h-full flex-col">
      <header className="shrink-0 bg-canvas pt-safe md:border-b md:border-line/60">
        <div className={cn('mx-auto flex h-14 max-w-6xl items-center gap-3 md:h-16', GUTTER)}>
          <Logo className="size-7 shrink-0" />
          <h1 className="min-w-0 flex-1 truncate text-[22px] leading-tight font-bold tracking-tight">
            {title}
          </h1>
          <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  cn(
                    'flex h-9 items-center gap-2 rounded-full px-3.5 text-sm font-semibold transition-colors',
                    isActive ? 'bg-fg text-canvas' : 'text-muted hover:bg-surface-2 hover:text-fg',
                  )
                }
              >
                <Icon size={16} aria-hidden />
                {label}
              </NavLink>
            ))}
          </nav>
          {actions && <div className="flex shrink-0 items-center gap-1 md:ml-2">{actions}</div>}
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {/* Bottom padding keeps the last row clear of the floating tab bar on phones. */}
        <div
          className={cn(
            'mx-auto max-w-6xl pb-[calc(env(safe-area-inset-bottom)+6.5rem)] md:pb-12',
            GUTTER,
          )}
        >
          {children}
        </div>
      </main>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:hidden">
        <nav
          aria-label="Main"
          className="pointer-events-auto flex w-full max-w-sm items-center justify-between gap-1 rounded-full bg-[rgb(18_18_26/0.72)] p-1.5 shadow-pop ring-1 ring-white/10 backdrop-blur-md"
        >
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex h-11 min-w-11 items-center justify-center rounded-full text-[13px] font-semibold transition-[background-color,color,padding,flex-grow] duration-200 ease-[var(--ease-spring)]',
                  isActive ? 'bg-white px-4 text-[#121218]' : 'px-3 text-white/70 hover:text-white',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <Icon size={20} aria-hidden className="shrink-0" />
                  {/* Inactive labels stay in the accessible name but take no space. */}
                  <span
                    className={cn(
                      'overflow-hidden whitespace-nowrap transition-[max-width,opacity,margin] duration-200 ease-[var(--ease-spring)]',
                      isActive ? 'ml-2 max-w-24 opacity-100' : 'ml-0 max-w-0 opacity-0',
                    )}
                  >
                    {label}
                  </span>
                </>
              )}
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  )
}

/** Section heading used across screens: small, uppercase and quiet. */
export function SectionTitle({
  children,
  action,
  className,
}: {
  children: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(className ?? 'mt-8', 'mb-3 flex min-h-8 items-center justify-between gap-3')}
    >
      <h2 className="text-[13px] font-semibold tracking-wider text-muted uppercase">{children}</h2>
      {action}
    </div>
  )
}
