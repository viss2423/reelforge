import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/cn.ts'
import { PreviewCanvas } from './PreviewCanvas.tsx'
import { Transport } from './Transport.tsx'

/**
 * Preview + transport. Full screen uses the Fullscreen API where available and otherwise
 * (iPhone Safari only allows it for <video>) an immersive fixed overlay.
 */
export function PreviewArea({
  transportLeading,
  className,
}: {
  transportLeading?: ReactNode
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [native, setNative] = useState(false)
  const [immersive, setImmersive] = useState(false)

  useEffect(() => {
    const onChange = () => setNative(document.fullscreenElement === ref.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  useEffect(() => {
    if (!immersive) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setImmersive(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [immersive])

  const fullscreen = native || immersive
  const toggle = () => {
    if (native) void document.exitFullscreen()
    else if (immersive) setImmersive(false)
    else if (document.fullscreenEnabled && ref.current?.requestFullscreen)
      ref.current.requestFullscreen().catch(() => setImmersive(true))
    else setImmersive(true)
  }

  return (
    <div
      ref={ref}
      className={cn(
        'flex min-h-0 flex-col bg-canvas',
        fullscreen && 'bg-black',
        immersive && 'fixed inset-0 z-40 pt-safe pb-safe',
        className,
      )}
    >
      <PreviewCanvas className="flex-1 p-2" />
      <Transport
        fullscreen={fullscreen}
        onToggleFullscreen={toggle}
        leading={fullscreen ? undefined : transportLeading}
      />
    </div>
  )
}
