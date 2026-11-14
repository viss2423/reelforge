import { MonitorOff } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '@/api/index.ts'
import { useQueryClient } from '@tanstack/react-query'
import { qk, usePacks } from '@/api/queries.ts'
import type { Packs } from '@/api/schemas.ts'
import { Spinner } from '@/components/Spinner.tsx'
import { cn } from '@/lib/cn.ts'
import { packFonts } from '@/lib/packs.ts'
import { createPreviewEngine, type PreviewEngine } from '@/preview/index.ts'
import { editorStore } from '@/state/editorStore.ts'
import { bindPreviewEngine, startFallbackClock } from './bindEngine.ts'
import { backingSize, fitAspect } from './fit.ts'

/**
 * The 9:16 preview surface. Sizes the canvas to the largest 9:16 box that fits its
 * container (backing store at device pixel ratio, capped at 2×), creates the preview engine
 * and binds it to the editor store. If the engine can't start (unsupported GPU, or not
 * built yet) it shows a fallback and a plain clock keeps playback/timeline working.
 */
export function PreviewCanvas({ className }: { className?: string }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<PreviewEngine | null>(null)
  const [css, setCss] = useState({ width: 0, height: 0 })
  const [backing, setBacking] = useState({ width: 0, height: 0 })
  const [failure, setFailure] = useState<string | null>(null)
  const [waiting, setWaiting] = useState(false)
  const qc = useQueryClient()
  const packs = usePacks()
  // Fonts come from packs; wait for that request to settle (success or not) so text renders
  // with the right faces from the first frame.
  const packsSettled = !packs.isPending

  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return
      const fit = fitAspect(entry.contentRect.width, entry.contentRect.height)
      setCss((c) => (c.width === fit.width && c.height === fit.height ? c : fit))
      const b = backingSize(fit, window.devicePixelRatio)
      setBacking((c) => (c.width === b.width && c.height === b.height ? c : b))
    })
    ro.observe(box)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!packsSettled) return
    const canvas = canvasRef.current
    if (!canvas) return
    let engine: PreviewEngine
    try {
      engine = createPreviewEngine(canvas, {
        mediaUrl: (id, variant) => api.mediaUrl(id, variant),
        assUrl: (id, rev) => api.assUrl(id, rev),
        packFileUrl: (p) => api.packFileUrl(p),
        // Read once: fonts are fixed for the engine's lifetime (pack updates apply on reopen).
        fonts: packFonts(qc.getQueryData<Packs>(qk.packs), (p) => api.packFileUrl(p)),
      })
    } catch (err) {
      // The engine is an external system; its construction outcome can only be known here.
      // oxlint-disable-next-line react/set-state-in-effect
      setFailure(err instanceof Error ? err.message : String(err))
      return startFallbackClock(editorStore)
    }
    setFailure(null)
    engine.setQuality('auto')
    engineRef.current = engine
    const unbind = bindPreviewEngine(engine, editorStore, { onWaiting: setWaiting })
    return () => {
      unbind()
      engineRef.current = null
      engine.destroy()
    }
  }, [packsSettled, qc])

  // Resizing the backing store clears it; ask the engine to redraw the current frame.
  useEffect(() => {
    const engine = engineRef.current
    if (engine && !engine.playing) engine.seek(engine.time)
  }, [backing])

  return (
    <div ref={boxRef} className={cn('relative grid min-h-0 min-w-0 place-items-center', className)}>
      <div
        className="relative overflow-hidden rounded-lg bg-preview shadow-pop"
        style={{ width: css.width, height: css.height }}
      >
        <canvas
          ref={canvasRef}
          width={backing.width || 1}
          height={backing.height || 1}
          className="block size-full"
          data-testid="preview-canvas"
        />
        {failure !== null && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-white/70"
            data-testid="preview-fallback"
          >
            <MonitorOff size={28} />
            <p className="text-sm font-semibold">Preview unavailable</p>
            <p className="text-xs text-white/50">{failure}</p>
          </div>
        )}
        {waiting && failure === null && (
          <div className="absolute inset-0 grid place-items-center bg-black/20 text-white">
            <Spinner size={28} />
          </div>
        )}
      </div>
    </div>
  )
}
