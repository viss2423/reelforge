import { Suspense } from 'react'
import { Outlet, ScrollRestoration } from 'react-router'
import { Toaster } from '@/components/Toast.tsx'
import { Splash } from './Splash.tsx'

/** Top-level layout shared by every route. */
export function RootLayout() {
  return (
    <>
      <Suspense fallback={<Splash />}>
        <Outlet />
      </Suspense>
      <Toaster />
      <ScrollRestoration />
    </>
  )
}
