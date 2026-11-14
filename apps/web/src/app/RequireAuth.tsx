import { useEffect, useState } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router'
import { Realtime } from './Realtime.tsx'
import { Splash } from './Splash.tsx'
import { tryLocalPair, useToken } from './session.ts'

/**
 * Guards the app routes. With a stored token it renders immediately (no network round trip
 * on the critical path); otherwise it attempts loopback auto-pairing, then falls back to
 * `/pair?next=<where you were going>`.
 */
export function RequireAuth() {
  const token = useToken()
  const location = useLocation()
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (token) return
    let alive = true
    void tryLocalPair().then((ok) => {
      if (alive && !ok) setFailed(true)
    })
    return () => {
      alive = false
    }
  }, [token])

  if (token) {
    return (
      <>
        <Realtime />
        <Outlet />
      </>
    )
  }
  if (failed) {
    const next = location.pathname + location.search
    return (
      <Navigate replace to={next === '/' ? '/pair' : `/pair?next=${encodeURIComponent(next)}`} />
    )
  }
  return <Splash />
}
