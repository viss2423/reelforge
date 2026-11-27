/**
 * Credit lines for CC BY music used in the reel, ready to paste into the post caption (the
 * licence requires them). Hidden when no used track needs a credit.
 */
import { musicCredits } from '@reelforge/core'
import { Copy, Music } from 'lucide-react'
import { Button } from '@/components/Button.tsx'
import { toast } from '@/components/Toast.tsx'
import { useAssetsMap, useProject } from '@/state/selectors.ts'

export const creditsCaption = (lines: readonly string[]): string =>
  lines.length === 0 ? '' : `🎵 Music: ${lines.join(' | ')}`

export function MusicCredits() {
  const project = useProject()
  const assets = useAssetsMap()
  const lines = project ? musicCredits(project, assets) : []
  if (lines.length === 0) return null
  const text = creditsCaption(lines)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success('Credits copied', 'Paste them into your caption')
    } catch {
      toast.error("Couldn't copy", text)
    }
  }
  return (
    <div
      className="flex w-full items-center gap-2.5 rounded-2xl bg-surface-2 py-1.5 pr-1.5 pl-3"
      data-testid="music-credits"
    >
      <Music size={16} className="shrink-0 text-muted" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[11px] text-muted">Music credit for your caption</span>
        <span className="truncate text-sm" title={text}>
          {text}
        </span>
      </span>
      <Button size="sm" variant="ghost" icon={<Copy size={14} />} onClick={() => void copy()}>
        Copy credits
      </Button>
    </div>
  )
}
