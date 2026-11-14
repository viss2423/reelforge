/**
 * Property sections and root panels: each control's UI action → the expected project change
 * through the store (one undo step), rendered with the pack fixture.
 */
import { QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import {
  sec,
  type AudioClip,
  type MediaClip,
  type StickerClip,
  type TextClip,
} from '@reelforge/core'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { api, events } from '@/api/index.ts'
import { createQueryClient, qk } from '@/api/queries.ts'
import { aiTasks } from '@/editor/panels/ai/tasks.ts'
import { DEFAULT_CAPTION_STYLE } from '@/editor/panels/ai/launch.ts'
import { CLIP_PANEL, ROOT_PANEL } from '@/editor/panels/panelIds.ts'
import { panelDef } from '@/editor/panels/registry.tsx'
import { editorStore } from '@/state/editorStore.ts'
import { makeJob, packsFixture, richAssets, richProject } from './helpers.ts'

vi.mock('@reelforge/core', async (importOriginal) => {
  const real = await importOriginal<typeof import('@reelforge/core')>()
  const { fakeCore } = await import('./fakeCore.ts')
  return { ...real, ...fakeCore(real) }
})

const toasts = vi.hoisted(() => ({
  plain: vi.fn<typeof import('@/components/Toast.tsx').toast>(),
  error: vi.fn<(title: string, description?: string) => number>(),
}))
vi.mock('@/components/Toast.tsx', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/Toast.tsx')>()),
  toast: Object.assign(toasts.plain, { error: toasts.error }),
}))

const s = () => editorStore.getState()
const clip = <C,>(id: string) =>
  s()
    .project!.tracks.flatMap((t) => t.clips)
    .find((c) => c.id === id) as C

const panel = (id: string, select?: string) => {
  if (select) act(() => s().select([select]))
  const qc = createQueryClient()
  qc.setQueryData(qk.packs, packsFixture())
  const ui: ReactNode = panelDef(id)!.render()
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  )
}

const withCaptions = () =>
  s().dispatch('captions', (d) => {
    d.captions = {
      enabled: true,
      language: 'en',
      style: DEFAULT_CAPTION_STYLE,
      words: [
        { text: 'so', start: 0, end: sec(0.3), confidence: 1, filler: false, emphasis: false },
        {
          text: 'um',
          start: sec(0.4),
          end: sec(0.6),
          confidence: 1,
          filler: true,
          emphasis: false,
        },
        {
          text: 'great',
          start: sec(0.7),
          end: sec(1),
          confidence: 1,
          filler: false,
          emphasis: false,
        },
      ],
    }
  })

let createJob: MockInstance<(typeof api)['createJob']>

beforeEach(() => {
  s().load(richProject(), Object.values(richAssets()))
  createJob = vi
    .spyOn(api, 'createJob')
    .mockImplementation(async (input) => makeJob({ kind: input.kind, status: 'running' }))
  vi.spyOn(api, 'job').mockImplementation(async (id) => makeJob({ id, status: 'running' }))
  vi.spyOn(api, 'cancelJob').mockResolvedValue(undefined)
  vi.spyOn(events, 'on').mockReturnValue(() => undefined)
})

afterEach(() => {
  for (const id of Object.keys(aiTasks.store.getState().tasks)) aiTasks.cancel(id as never)
  s().unload()
})

describe('transform & keyframes', () => {
  it('diamond toggles a keyframe at the playhead for that property only', () => {
    s().setPlayhead(sec(0.5))
    panel(CLIP_PANEL.transform, 'txt')
    fireEvent.click(screen.getByRole('button', { name: 'Add Scale keyframe' }))
    const t = clip<TextClip>('txt').transform
    expect(t.scale.keyframes).toEqual([{ t: sec(0.5), value: 1, easing: 'easeInOut' }])
    expect(t.x.keyframes).toEqual([])
    expect(
      screen.getByRole('button', { name: 'Remove Scale keyframe' }).getAttribute('aria-pressed'),
    ).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Remove Scale keyframe' }))
    expect(clip<TextClip>('txt').transform.scale.keyframes).toEqual([])
  })
})

describe('text', () => {
  it('style toggles and the preset gallery edit the selected text', () => {
    panel(CLIP_PANEL.text, 'txt')
    fireEvent.click(screen.getByRole('switch', { name: /All caps/ }))
    expect(clip<TextClip>('txt').style.uppercase).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Background', expanded: false }))
    fireEvent.click(screen.getByRole('switch', { name: /Background box/ }))
    expect(clip<TextClip>('txt').style.backgroundColor).toBeDefined()
    fireEvent.click(screen.getByRole('radio', { name: 'Right' }))
    expect(clip<TextClip>('txt').style.align).toBe('right')
    fireEvent.click(screen.getByRole('button', { name: 'Neon' }))
    expect(clip<TextClip>('txt')).toMatchObject({
      presetRef: 'trend/neon',
      style: { color: '#FF00FF' },
    })
  })

  it('animation pickers set in/out/loop slots', () => {
    panel(CLIP_PANEL.animations, 'txt')
    fireEvent.click(screen.getByRole('button', { name: 'Swoosh' }))
    expect(clip<TextClip>('txt').animationIn?.ref).toBe('trend/swoosh')
    fireEvent.click(screen.getByRole('tab', { name: 'Loop' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pulse' }))
    expect(clip<TextClip>('txt').animationLoop?.ref).toBe('builtin/pulse')
    fireEvent.click(screen.getByRole('button', { name: 'None' }))
    expect(clip<TextClip>('txt').animationLoop).toBeUndefined()
  })
})

describe('transitions', () => {
  it('applies a pack transition and spreads it to all cuts', () => {
    panel(CLIP_PANEL.transition, 'v2')
    fireEvent.click(screen.getByRole('button', { name: 'Whip' }))
    expect(clip<MediaClip>('v2').transitionIn).toEqual({ type: 'whip', duration: 300_000 })
    fireEvent.click(screen.getByRole('button', { name: 'Apply to all' }))
    expect(toasts.plain).toHaveBeenCalledWith('Applied to 1 cuts')
    fireEvent.click(screen.getByRole('button', { name: 'None' }))
    expect(clip<MediaClip>('v2').transitionIn).toBeUndefined()
  })
})

describe('audio', () => {
  it('mute toggles as one undo step', () => {
    panel(CLIP_PANEL.volume, 'mus')
    fireEvent.click(screen.getByRole('switch', { name: /Mute/ }))
    expect(clip<AudioClip>('mus').audio.muted).toBe(true)
    expect(s().history.undoLabel).toBe('Mute')
    s().undo()
    expect(clip<AudioClip>('mus').audio.muted).toBe(false)
  })

  it('the fade panel shows only the fade controls', () => {
    panel(CLIP_PANEL.fade, 'mus')
    expect(screen.getByRole('region', { name: 'Fade' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Volume' })).toBeNull()
  })
})

describe('canvas & stickers', () => {
  it('blur fill toggle and frame rate', () => {
    panel(ROOT_PANEL.canvas)
    fireEvent.click(screen.getByRole('switch', { name: /Blur fill/ }))
    expect(s().project!.settings.backgroundBlur).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: '60' }))
    expect(s().project!.settings.fps).toBe(60)
  })

  it('adds a trending sticker at the playhead', () => {
    s().setPlayhead(sec(1))
    panel(ROOT_PANEL.stickers)
    fireEvent.click(screen.getByRole('button', { name: 'Fire' }))
    const st = s()
      .project!.tracks.flatMap((t) => t.clips)
      .find((c) => c.type === 'sticker' && c.id !== 'stk') as StickerClip
    expect(st).toMatchObject({ ref: 'trend/fire', start: sec(1) })
  })
})

describe('captions panel', () => {
  it('generate uses the picked gallery style before captions exist', async () => {
    panel(ROOT_PANEL.captions)
    fireEvent.click(screen.getByRole('button', { name: 'Clean' }))
    expect(s().project!.captions).toBeUndefined()
    fireEvent.click(screen.getByRole('button', { name: 'Generate captions' }))
    expect(await screen.findByRole('progressbar', { name: 'Auto captions' })).toBeTruthy()
    expect(createJob).toHaveBeenCalledWith(expect.objectContaining({ kind: 'transcribe' }))
  })

  it('transcript editor edits and deletes words; filler removal offered', () => {
    withCaptions()
    panel(ROOT_PANEL.captions)
    expect(screen.getByRole('button', { name: 'Remove filler words' })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Transcript' }))
    const list = screen.getAllByLabelText('Transcript').find((el) => !el.getAttribute('role'))!
    fireEvent.click(within(list).getByRole('button', { name: 'great' }))
    expect(s().playhead).toBe(sec(0.7))
    const input = screen.getByRole('textbox', { name: 'Word' })
    fireEvent.change(input, { target: { value: 'awesome' } })
    fireEvent.blur(input)
    expect(s().project!.captions!.words[2]!.text).toBe('awesome')
    fireEvent.click(within(list).getByRole('button', { name: 'um' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete word' }))
    expect(s().project!.captions!.words.map((w) => w.text)).toEqual(['so', 'awesome'])
  })

  it('options tab edits layout', () => {
    withCaptions()
    panel(ROOT_PANEL.captions)
    fireEvent.click(screen.getByRole('tab', { name: 'Options' }))
    fireEvent.click(screen.getByRole('switch', { name: /All caps/ }))
    expect(s().project!.captions!.style.base.uppercase).toBe(true)
    fireEvent.click(screen.getByRole('switch', { name: /Show captions/ }))
    expect(s().project!.captions!.enabled).toBe(false)
  })
})
