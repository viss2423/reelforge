/**
 * Transcript editor for captions: every word is a chip (tap = seek + select); the selected
 * word can be retyped, merged, split, deleted, emphasised or re-timed by a frame at a time.
 *
 * Performance: a 10-minute talk is ~1500 words. Chips are plain buttons rendered once per
 * captions change; following the playhead does NOT re-render React — a store subscription
 * moves a `data-active` attribute between two DOM nodes.
 */
import type { Word } from '@reelforge/core'
import { ArrowLeftToLine, ArrowRightToLine, Combine, Scissors, Star, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { IconButton } from '@/components/IconButton.tsx'
import { cn } from '@/lib/cn.ts'
import { editorStore } from '@/state/editorStore.ts'
import { useEditor, useFps } from '@/state/selectors.ts'
import { edit } from '../model/commands.ts'
import {
  deleteWord,
  editWord,
  mergeWithNext,
  nudgeWord,
  setEmphasis,
  splitWord,
  wordIndexAt,
} from '../model/transcript.ts'
import { isFiller } from '../model/ranges.ts'
import { Hint } from '../ui.tsx'

const EMPTY: readonly Word[] = []

function WordEditor({ index, word, last }: { index: number; word: Word; last: boolean }) {
  const fps = useFps()
  const frame = Math.round(1_000_000 / fps)
  // Local while typing; the parent re-keys this editor when the word's text changes.
  const [text, setText] = useState(word.text)
  const commitText = () => {
    if (text.trim() !== word.text) edit('Edit caption', (d) => editWord(d, index, text))
  }
  const nudge = (edge: 'start' | 'end', delta: number) =>
    edit('Caption timing', (d) => nudgeWord(d, index, edge, delta), {
      coalesce: `nudge:${index}:${edge}`,
    })
  return (
    <div
      className="flex flex-col gap-2 rounded-xl border border-line bg-surface-2 p-3"
      aria-label="Edit word"
    >
      <input
        aria-label="Word"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commitText}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
        className="h-10 rounded-lg border border-line bg-surface px-3 text-base outline-none focus:border-accent"
      />
      <div className="flex flex-wrap items-center gap-1">
        <IconButton
          size="sm"
          label="Start earlier"
          icon={<ArrowLeftToLine size={16} />}
          onClick={() => nudge('start', -frame)}
        />
        <IconButton
          size="sm"
          label="Start later"
          icon={<ArrowRightToLine size={16} />}
          onClick={() => nudge('start', frame)}
        />
        <span className="mx-1 text-xs text-muted tabular-nums">
          {(word.start / 1e6).toFixed(2)}–{(word.end / 1e6).toFixed(2)} s
        </span>
        <IconButton
          size="sm"
          label="End earlier"
          icon={<ArrowLeftToLine size={16} />}
          onClick={() => nudge('end', -frame)}
        />
        <IconButton
          size="sm"
          label="End later"
          icon={<ArrowRightToLine size={16} />}
          onClick={() => nudge('end', frame)}
        />
        <span className="flex-1" />
        <IconButton
          size="sm"
          label="Emphasise"
          pressed={word.emphasis}
          icon={<Star size={16} fill={word.emphasis ? 'currentColor' : 'none'} />}
          onClick={() => edit('Emphasis', (d) => setEmphasis(d, index, !word.emphasis))}
        />
        <IconButton
          size="sm"
          label="Split word"
          icon={<Scissors size={16} />}
          onClick={() => edit('Split caption', (d) => splitWord(d, index))}
        />
        <IconButton
          size="sm"
          label="Merge with next"
          icon={<Combine size={16} />}
          disabled={last}
          onClick={() => edit('Merge captions', (d) => mergeWithNext(d, index))}
        />
        <IconButton
          size="sm"
          label="Delete word"
          icon={<Trash2 size={16} />}
          onClick={() => edit('Delete caption', (d) => deleteWord(d, index))}
        />
      </div>
    </div>
  )
}

export function TranscriptEditor() {
  const words = useEditor((s) => s.project?.captions?.words ?? EMPTY)
  const [selected, setSelected] = useState<number | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Follow the playhead without re-rendering: move the highlight between chips.
  useEffect(() => {
    const cur: { el: Element | null; index: number } = { el: null, index: -2 }
    const sync = (t: number) => {
      const i = wordIndexAt(words, t)
      if (i === cur.index) return
      cur.index = i
      cur.el?.removeAttribute('data-active')
      cur.el = i >= 0 ? (listRef.current?.querySelector(`[data-i="${i}"]`) ?? null) : null
      cur.el?.setAttribute('data-active', '')
    }
    sync(editorStore.getState().playhead)
    return editorStore.subscribe((s, prev) => {
      if (s.playhead !== prev.playhead) sync(s.playhead)
    })
  }, [words])

  if (words.length === 0) return <Hint>Generate captions to edit the transcript here.</Hint>
  const sel = selected !== null && selected < words.length ? selected : null
  const word = sel !== null ? words[sel] : undefined
  return (
    <div className="flex flex-col gap-3">
      {word && sel !== null && (
        <WordEditor
          key={`${sel}:${word.text}`}
          index={sel}
          word={word}
          last={sel === words.length - 1}
        />
      )}
      <div
        ref={listRef}
        className="flex max-h-72 flex-wrap gap-1 overflow-y-auto"
        aria-label="Transcript"
      >
        {words.map((w, i) => (
          <button
            // Index keys are right here: words are positional and edits re-key by position.
            key={i}
            type="button"
            data-i={i}
            aria-pressed={sel === i}
            onClick={() => {
              setSelected(i)
              editorStore.getState().setPlayhead(w.start)
            }}
            className={cn(
              'rounded-md px-1.5 py-0.5 text-sm data-[active]:bg-accent/25',
              sel === i ? 'bg-accent text-accent-fg' : 'hover:bg-surface-2',
              isFiller(w) && 'text-muted line-through decoration-danger/60',
              w.emphasis && 'font-bold',
            )}
          >
            {w.text}
          </button>
        ))}
      </div>
    </div>
  )
}
