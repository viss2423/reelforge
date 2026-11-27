import { ChevronDown, Monitor, ShieldAlert } from 'lucide-react'
import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { ApiError } from '@/api/client.ts'
import { pairWithCode, tryLocalPair, useToken } from '@/app/session.ts'
import { Button } from '@/components/Button.tsx'
import { cn } from '@/lib/cn.ts'
import { Logo } from './Logo.tsx'

export const CODE_LENGTH = 6

/** Maps a pairing failure to a message the user can act on. */
export const pairErrorMessage = (err: unknown): string => {
  if (err instanceof ApiError) {
    if (err.status === 0)
      return "Can't reach your computer. Make sure ReelForge is running and you're on the same network (or Tailscale)."
    if (err.status === 400 || err.status === 401 || err.status === 403)
      return 'That code is wrong or has expired. Check the code on your computer and try again.'
    if (err.status === 429) return 'Too many attempts. Wait a minute, then try again.'
    return err.message
  }
  return err instanceof Error ? err.message : 'Pairing failed'
}

/** Only allow same-app relative redirects after pairing (no open redirects). */
export const safeNext = (next: string | null): string =>
  next && next.startsWith('/') && !next.startsWith('//') ? next : '/'

/**
 * Pair this device with the host: type the 6-digit code shown on the host, or open the QR
 * link (`/pair?code=123456`) which pairs automatically.
 */
export function PairScreen() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const token = useToken()
  const destination = safeNext(params.get('next'))
  const [code, setCode] = useState(() =>
    (params.get('code') ?? '').replace(/\D/g, '').slice(0, CODE_LENGTH),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const autoTried = useRef(false)

  const submit = async (value: string) => {
    if (value.length !== CODE_LENGTH || busy) return
    setBusy(true)
    setError(null)
    try {
      await pairWithCode(value)
      void navigate(destination, { replace: true })
    } catch (err) {
      setError(pairErrorMessage(err))
      setBusy(false)
    }
  }

  // QR links carry the code: pair without a tap. On the host itself, loopback pairing
  // needs no code at all. Runs once (guarded by the ref); later input goes through the form.
  const autoPair = useEffectEvent(async () => {
    if (code.length === CODE_LENGTH) return submit(code)
    if (await tryLocalPair()) void navigate(destination, { replace: true })
  })
  useEffect(() => {
    if (autoTried.current || token) return
    autoTried.current = true
    void autoPair()
  }, [token])

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    void submit(code)
  }

  const insecure = typeof window !== 'undefined' && !window.isSecureContext

  return (
    <div className="relative flex h-full flex-col items-center overflow-x-hidden overflow-y-auto px-5 pt-safe pb-safe">
      {/* Soft glow behind the mark (decorative; static for reduced motion). */}
      <div
        aria-hidden
        className="bg-magic-soft animate-rf-drift pointer-events-none absolute -top-40 left-1/2 h-96 w-[36rem] -translate-x-1/2 rounded-full opacity-60 blur-3xl"
      />
      <div className="relative flex w-full max-w-sm flex-1 flex-col justify-center gap-8 py-10">
        <div className="flex flex-col items-center gap-4 text-center">
          <Logo className="size-16 drop-shadow-[0_8px_24px_rgb(255_45_122/0.35)]" />
          <div className="flex flex-col gap-1.5">
            <h1 className="text-[26px] leading-tight font-bold tracking-tight">
              Connect to your ReelForge
            </h1>
            <p className="text-[15px] text-muted">Enter the code shown on your computer</p>
          </div>
        </div>

        {token ? (
          <div className="flex flex-col gap-3 rounded-3xl bg-surface p-5 text-center">
            <p>This device is already paired.</p>
            <Button
              variant="primary"
              size="lg"
              className="bg-magic rounded-full"
              onClick={() => void navigate(destination, { replace: true })}
            >
              Continue
            </Button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <label htmlFor="pair-code" className="sr-only">
              Pairing code
            </label>
            <div className="relative">
              <input
                id="pair-code"
                name="code"
                autoFocus
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={CODE_LENGTH}
                placeholder="••••••"
                value={code}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'pair-error' : 'pair-help'}
                onChange={(e) => {
                  const v = e.target.value.replace(/\D/g, '').slice(0, CODE_LENGTH)
                  setCode(v)
                  setError(null)
                  if (v.length === CODE_LENGTH) void submit(v)
                }}
                className={cn(
                  'h-18 w-full rounded-3xl bg-surface pl-[0.5em] text-center font-mono text-[34px] font-semibold tracking-[0.5em] tabular-nums ring-1 ring-line outline-none transition-shadow placeholder:text-subtle focus:ring-2 focus:ring-accent',
                  error && 'ring-2 ring-danger',
                )}
              />
              {/* Progress dots: one per digit typed. */}
              <div aria-hidden className="mt-3 flex justify-center gap-2">
                {Array.from({ length: CODE_LENGTH }, (_, i) => (
                  <span
                    key={i}
                    className={cn(
                      'h-1.5 w-6 rounded-full transition-colors duration-200',
                      i < code.length ? 'bg-accent' : 'bg-surface-3',
                    )}
                  />
                ))}
              </div>
            </div>
            {error && (
              <p id="pair-error" role="alert" className="text-center text-sm text-danger">
                {error}
              </p>
            )}
            <Button
              type="submit"
              variant="primary"
              size="lg"
              block
              className="bg-magic rounded-full"
              loading={busy}
              disabled={code.length !== CODE_LENGTH}
            >
              Pair this device
            </Button>
          </form>
        )}

        <p id="pair-help" className="flex items-center justify-center gap-2 text-sm text-muted">
          <Monitor size={16} aria-hidden className="shrink-0" />
          <span>
            On your computer: <b className="font-semibold text-fg">Pair a device</b>
          </span>
        </p>

        {insecure && (
          <details className="group rounded-2xl bg-warning/10 text-sm ring-1 ring-warning/30">
            <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 px-4 font-semibold">
              <ShieldAlert size={18} className="shrink-0 text-warning" aria-hidden />
              <span className="flex-1">Secure connection needed to install</span>
              <ChevronDown
                size={16}
                aria-hidden
                className="shrink-0 text-muted transition-transform group-open:rotate-180"
              />
            </summary>
            <p className="px-4 pb-4 text-muted">
              Open the pairing page on your computer's <b className="text-fg">http://…:8080</b>{' '}
              address, install the ReelForge certificate once, then use the{' '}
              <b className="text-fg">https://…:8443</b> link. Until then the app works but can't be
              installed or used offline.
            </p>
          </details>
        )}
      </div>
    </div>
  )
}
