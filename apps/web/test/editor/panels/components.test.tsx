/**
 * Panel components rendered against the real editor store: tool bar → sheets, clip panels,
 * the AI panel against a mocked host (progress, review, failure + retry, one undo step),
 * captions and text galleries from a pack fixture, and the desktop inspector.
 */
import { QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { sec, type Job, type MediaClip, type TextClip } from '@reelforge/core'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { api, events } from '@/api/index.ts'
import { createQueryClient, qk } from '@/api/queries.ts'
import { aiTasks } from '@/editor/panels/ai/tasks.ts'
import { DEFAULT_CAPTION_STYLE } from '@/editor/panels/ai/launch.ts'
import { ToolPanels } from '@/editor/panels/index.tsx'
import { CLIP_PANEL, ROOT_PANEL } from '@/editor/panels/panelIds.ts'
import { panelDef } from '@/editor/panels/registry.tsx'
import { Inspector } from '@/editor/inspector/index.tsx'
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

let jobResult: (input: { kind: string; assetId?: string }) => Partial<Job>

const wrap = (ui: ReactNode) => {
  const qc = createQueryClient()
  qc.setQueryData(qk.packs, packsFixture())
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  )
}

let createJob: MockInstance<(typeof api)['createJob']>
let cancelJob: MockInstance<(typeof api)['cancelJob']>

beforeEach(() => {
  s().load(richProject(), Object.values(richAssets()))
  let n = 0
  jobResult = (input) => ({
    status: 'done',
    progress: 1,
    result:
      input.kind === 'silence'
        ? { ranges: [{ start: sec(0.5), end: sec(1) }] }
        : { words: [{ text: 'hi', start: 0, end: sec(0.5) }] },
  })
  createJob = vi
    .spyOn(api, 'createJob')
    .mockImplementation(async (input) =>
      makeJob({ id: `cj${++n}`, kind: input.kind, ...jobResult(input) }),
    )
  vi.spyOn(api, 'job').mockImplementation(async (id) => makeJob({ id, status: 'running' }))
  cancelJob = vi.spyOn(api, 'cancelJob').mockResolvedValue(undefined)
  vi.spyOn(events, 'on').mockReturnValue(() => undefined)
})

afterEach(() => {
  for (const id of Object.keys(aiTasks.store.getState().tasks)) aiTasks.dismiss(id as never)
  s().unload()
})

describe('tool bar and sheets (phone)', () => {
  it('opens a root panel sheet from the tool bar and closes it again', async () => {
    wrap(<ToolPanels variant="mobile" />)
    const bar = screen.getByRole('toolbar', { name: 'Tools' })
    fireEvent.click(within(bar).getByRole('button', { name: /Canvas/ }))
    expect(s().activePanel).toBe(ROOT_PANEL.canvas)
    expect(await screen.findByRole('dialog', { name: 'Canvas' })).toBeTruthy()
    fireEvent.click(within(bar).getByRole('button', { name: /Canvas/ }))
    expect(s().activePanel).toBeNull()
  })

  it('switches to clip tools on selection and edits through a clip panel', async () => {
    wrap(<ToolPanels variant="mobile" />)
    act(() => s().select(['v2']))
    const bar = screen.getByRole('toolbar', { name: 'Tools' })
    expect(within(bar).queryByRole('button', { name: /Templates/ })).toBeNull()
    fireEvent.click(within(bar).getByRole('button', { name: /Speed/ }))
    expect(s().activePanel).toBe(CLIP_PANEL.speed)
    fireEvent.click(await screen.findByRole('button', { name: 'Bullet' }))
    expect(clip<MediaClip>('v2').speedRamp.length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Bullet' }).getAttribute('aria-pressed')).toBe('true')
    // Done: back to the project tools, clip panel closed.
    fireEvent.click(within(bar).getByRole('button', { name: 'Done' }))
    expect(s().selection.clipIds).toEqual([])
    expect(s().activePanel).toBeNull()
    expect(within(bar).getByRole('button', { name: /Templates/ })).toBeTruthy()
  })

  it('renders every panel definition without crashing', () => {
    s().select(['v2'])
    for (const id of [...Object.values(ROOT_PANEL), ...Object.values(CLIP_PANEL)]) {
      const target = id === CLIP_PANEL.text || id === CLIP_PANEL.animations ? 'txt' : 'v2'
      act(() => s().select([target]))
      const { container, unmount } = wrap(<>{panelDef(id)!.render()}</>)
      // Each panel renders real content for a clip it applies to.
      expect(container.textContent).not.toBe('')
      unmount()
    }
  })
})

describe('AI panel', () => {
  const openAi = () => {
    wrap(<>{panelDef(ROOT_PANEL.ai)!.render()}</>)
  }

  it('remove silences: preview what it saves, apply as one undo step', async () => {
    openAi()
    fireEvent.click(screen.getByRole('button', { name: 'Find silences' }))
    const card = await screen.findByTestId('task-silence')
    await waitFor(() => expect(within(card).getByText('2 silences · saves 1.0 s')).toBeTruthy())
    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'silence', payload: { assetId: 'a1', minSilence: 400_000 } }),
    )
    const before = s().project
    fireEvent.click(within(card).getByRole('button', { name: 'Apply' }))
    expect(clip<MediaClip>('v1').duration).toBe(sec(1.5))
    expect(screen.queryByTestId('task-silence')).toBeNull()
    s().undo()
    expect(s().project).toEqual(before)
  })

  it('shows host progress, then failure with a working retry', async () => {
    let fail = true
    jobResult = () =>
      fail ? { status: 'failed', error: 'whisper missing' } : { status: 'running', progress: 0.4 }
    openAi()
    fireEvent.click(screen.getByRole('button', { name: 'Generate captions' }))
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('Auto captions failed')).toBeTruthy()
    expect(within(alert).getByText('whisper missing')).toBeTruthy()
    fail = false
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    const bar = await screen.findByRole('progressbar', { name: 'Auto captions' })
    await waitFor(() => expect(bar.getAttribute('aria-valuenow')).toBe('38'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('progressbar')).toBeNull()
    await waitFor(() => expect(cancelJob).toHaveBeenCalled())
  })

  it('voice toggles apply to every voice clip in one step', () => {
    openAi()
    fireEvent.click(screen.getByRole('switch', { name: /Reduce noise/ }))
    expect(clip<MediaClip>('v1').audio.denoise).toBe(true)
    expect(clip<MediaClip>('ov1').audio.denoise).toBe(true)
    expect(s().history.undoLabel).toBe('Reduce noise')
  })
})

describe('captions & text', () => {
  it('applies a gallery caption style instantly to existing captions', () => {
    s().dispatch('captions', (d) => {
      d.captions = { enabled: true, language: 'en', words: [], style: DEFAULT_CAPTION_STYLE }
    })
    wrap(<>{panelDef(ROOT_PANEL.captions)!.render()}</>)
    fireEvent.click(screen.getByRole('button', { name: 'Hormozi' }))
    expect(s().project!.captions).toMatchObject({
      styleRef: 'trend/hormozi',
      style: { activeColor: '#00FF00' },
    })
  })

  it('adds a trending text preset at the playhead and opens its editor', () => {
    s().setPlayhead(sec(2))
    wrap(<>{panelDef(ROOT_PANEL.text)!.render()}</>)
    fireEvent.click(screen.getByRole('button', { name: 'Neon' }))
    const [id] = s().selection.clipIds
    expect(clip<TextClip>(id!)).toMatchObject({
      text: 'NEON',
      start: sec(2),
      presetRef: 'trend/neon',
    })
    expect(s().activePanel).toBe(CLIP_PANEL.text)
  })

  it('applies a filter to every main clip from the root Filters tool', () => {
    wrap(<>{panelDef(ROOT_PANEL.filters)!.render()}</>)
    fireEvent.click(screen.getByRole('button', { name: 'Warm' }))
    expect(clip<MediaClip>('v1').filter?.ref).toBe('trend/warm')
    expect(clip<MediaClip>('v2').filter?.ref).toBe('trend/warm')
    expect(s().history.undoLabel).toBeTruthy()
    s().undo()
    expect(clip<MediaClip>('v1').filter).toBeUndefined()
  })
})

describe('desktop inspector', () => {
  it('shows project settings with nothing selected', () => {
    wrap(<Inspector />)
    expect(screen.getByRole('heading', { name: 'Project' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'AI tools' }))
    expect(s().activePanel).toBe(ROOT_PANEL.ai)
    expect(screen.getByRole('heading', { name: 'AI tools' })).toBeTruthy()
  })

  it('lays out the property sections of the selected clip', () => {
    act(() => s().select(['v2']))
    wrap(<Inspector />)
    for (const name of ['Speed', 'Adjust', 'Chroma key', 'Transition'])
      expect(screen.getAllByRole('region', { name: new RegExp(name) }).length).toBeGreaterThan(0)
    act(() => s().select(['txt']))
    expect(screen.queryByRole('region', { name: /^Speed$/ })).toBeNull()
    expect(screen.getAllByRole('region', { name: /Animation/ }).length).toBeGreaterThan(0)
  })
})
