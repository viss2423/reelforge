import { MonitorOff, Plus, Wand2 } from 'lucide-react'
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
import { useEditor } from '@/state/selectors.ts'
import { MEDIA_PANEL } from '../layout.ts'
import { ROOT_PANEL } from '../panels/panelIds.ts'
import { bindPreviewEngine, startFallbackClock } from './bindEngine.ts'
import { backingSize, fitAspect } from './fit.ts'
import { TransformOverlay } from './overlay/TransformOverlay.tsx'

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
  const empty = useEditor((s) => s.project?.tracks.every((t) => t.clips.length === 0) ?? false)

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
        matteUrl: (id, version) => api.matteUrl(id, version),
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
      {/* The overlay sits outside the clipped box so handles stay grabbable past the edges. */}
      <div className="relative" style={{ width: css.width, height: css.height }}>
        <div className="relative size-full overflow-hidden rounded-lg bg-preview shadow-pop">
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
            <div className="pointer-events-none absolute inset-0 grid place-items-center bg-black/20 text-white">
              <Spinner size={28} />
            </div>
          )}
        </div>
        <TransformOverlay width={css.width} height={css.height} />
        {empty && css.width > 0 && <EmptyStage />}
      </div>
    </div>
  )
}

/** An empty project's stage: one big glass "Add clips", and Magic → Auto edit as the aside. */
function EmptyStage() {
  const s = editorStore.getState
  return (
    <div
      className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 overflow-hidden rounded-lg p-4 text-center"
      data-testid="empty-stage"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_70%_at_50%_35%,color-mix(in_srgb,var(--rf-violet)_22%,transparent),transparent_70%)]"
      />
      <button
        type="button"
        onClick={() => s().setActivePanel(MEDIA_PANEL)}
        data-testid="add-media"
        className="shell-glass relative flex flex-col items-center gap-3 rounded-3xl px-7 py-6 transition-transform duration-200 ease-[var(--ease-spring)] hover:bg-black/55 active:scale-[0.97]"
      >
        <span className="shell-gradient grid size-14 place-items-center rounded-full text-white shadow-pop">
          <Plus size={28} strokeWidth={2.5} aria-hidden />
        </span>
        <span className="text-[17px] font-semibold">Add clips</span>
      </button>
      <button
        type="button"
        onClick={() => {
          s().setActivePanel(ROOT_PANEL.ai)
          s().setActiveTool('ai')
        }}
        aria-label="Or try Magic: Auto edit"
        className="group relative flex flex-col items-center gap-1.5 text-[13px] whitespace-nowrap text-white/75 transition-colors hover:text-white"
      >
        <span>or try</span>
        <span className="shell-magic inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 font-semibold text-white shadow-pop transition-transform duration-150 ease-[var(--ease-spring)] group-active:scale-95">
          <Wand2 size={14} aria-hidden />
          Magic
          <span aria-hidden className="opacity-80">
            →
          </span>
          Auto edit
        </span>
      </button>
    </div>
  )
}
