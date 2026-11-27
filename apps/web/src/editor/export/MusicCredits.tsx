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
      className="flex w-full flex-col gap-2 rounded-xl bg-surface-2 p-3"
      data-testid="music-credits"
    >
      <p className="flex items-center gap-1.5 text-sm font-semibold">
        <Music size={14} /> Add to your caption
      </p>
      <p className="text-xs break-words text-muted">{text}</p>
      <Button size="sm" variant="secondary" icon={<Copy size={14} />} onClick={() => void copy()}>
        Copy credits
      </Button>
    </div>
  )
}
