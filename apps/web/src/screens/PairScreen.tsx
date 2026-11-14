import { ShieldAlert, Smartphone } from 'lucide-react'
import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { ApiError } from '@/api/client.ts'
import { pairWithCode, tryLocalPair, useToken } from '@/app/session.ts'
import { Button } from '@/components/Button.tsx'
import { Logo } from './Logo.tsx'

export const CODE_LENGTH = 6

/** Maps a pairing failure to a message the user can act on. */
export const pairErrorMessage = (err: unknown): string => {
  if (err instanceof ApiError) {
    if (err.status === 0)
      return "Can't reach your ReelForge host. Make sure it's running and this device is on the same network (or Tailscale)."
    if (err.status === 400 || err.status === 401 || err.status === 403)
      return 'That code is wrong or has expired. Check the code on the host screen and try again.'
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
    <div className="flex h-full flex-col items-center overflow-y-auto px-5 pt-safe pb-safe">
      <div className="flex w-full max-w-sm flex-1 flex-col justify-center gap-6 py-10">
        <div className="flex flex-col items-center gap-3 text-center">
          <Logo className="size-16" />
          <h1 className="text-2xl font-bold">Connect to your ReelForge</h1>
          <p className="text-muted">
            Enter the 6-digit code shown on the host computer, or scan its QR code.
          </p>
        </div>

        {token ? (
          <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 text-center">
            <p>This device is already paired.</p>
            <Button variant="primary" onClick={() => void navigate(destination, { replace: true })}>
              Continue
            </Button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <label htmlFor="pair-code" className="sr-only">
              Pairing code
            </label>
            <input
              id="pair-code"
              name="code"
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={CODE_LENGTH}
              placeholder="000000"
              value={code}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'pair-error' : undefined}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, '').slice(0, CODE_LENGTH)
                setCode(v)
                setError(null)
                if (v.length === CODE_LENGTH) void submit(v)
              }}
              className="h-16 w-full rounded-2xl border border-line bg-surface text-center font-mono text-3xl tracking-[0.5em] tabular-nums outline-none placeholder:text-subtle focus:border-accent"
            />
            {error && (
              <p id="pair-error" role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            <Button
              type="submit"
              variant="primary"
              size="lg"
              block
              loading={busy}
              disabled={code.length !== CODE_LENGTH}
            >
              Pair this device
            </Button>
          </form>
        )}

        <div className="flex gap-3 rounded-2xl bg-surface-2 p-4 text-sm text-muted">
          <Smartphone size={20} className="mt-0.5 shrink-0" />
          <p>
            On the host, open ReelForge and choose <b className="text-fg">Pair a device</b>. The
            code changes every few minutes and works once.
          </p>
        </div>

        {insecure && (
          <div className="flex gap-3 rounded-2xl border border-warning/40 bg-warning/10 p-4 text-sm">
            <ShieldAlert size={20} className="mt-0.5 shrink-0 text-warning" />
            <div className="flex flex-col gap-1">
              <p className="font-semibold">Secure connection needed to install the app</p>
              <p className="text-muted">
                Open the pairing page on the host's <b className="text-fg">http://…:8080</b>{' '}
                address, install the ReelForge certificate once, then use the{' '}
                <b className="text-fg">https://…:8443</b> link. Until then the app works but can't
                be installed or used offline.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
