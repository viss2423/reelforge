/**
 * Route smoke tests: every route renders against a fake host (fetch stub), auth guards
 * redirect correctly and the editor shell comes up with the preview fallback (the preview
 * engine is still a stub on this branch, so `createPreviewEngine` throws).
 */
import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { auth, events } from '@/api/index.ts'
import { createQueryClient } from '@/api/queries.ts'
import { routes } from '@/app/routes.tsx'
import { resetSessionForTests } from '@/app/session.ts'
import { editorStore } from '@/state/editorStore.ts'
import { makeAsset, makeProject } from '../fixtures.ts'

type Handler = (init: RequestInit) => { status: number; body?: unknown }

const project = makeProject({ id: 'p1', name: 'Beach day' })
const routesTable = (): Record<string, Handler> => ({
  'GET /api/health': () => ({ status: 200, body: { ok: true, version: '0.1.0' } }),
  'POST /api/pair/local': () => ({ status: 403, body: { message: 'not loopback' } }),
  'POST /api/pair': () => ({ status: 200, body: { token: 'tok', deviceId: 'dev1' } }),
  'GET /api/projects': () => ({
    status: 200,
    body: [
      {
        id: 'p1',
        name: 'Beach day',
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        duration: 5_000_000,
      },
    ],
  }),
  'GET /api/projects/p1': () => ({ status: 200, body: project }),
  'GET /api/projects/gone': () => ({ status: 404, body: { message: 'not found' } }),
  'GET /api/assets': () => ({ status: 200, body: [makeAsset({ id: 'a1', name: 'beach.mp4' })] }),
  'GET /api/jobs': () => ({ status: 200, body: [] }),
  'GET /api/packs': () => ({
    status: 200,
    body: { index: { version: '1', updatedAt: '2026-01-01', packs: [], fonts: [] }, manifests: [] },
  }),
  'GET /api/system': () => ({ status: 200, body: {} }),
  'GET /api/devices': () => ({ status: 200, body: [] }),
})

const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

let table: Record<string, Handler>
let fetchMock: Mock<typeof fetch>

beforeEach(() => {
  table = routesTable()
  fetchMock = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = new URL(urlOf(input), 'https://host')
    const handler = table[`${init.method ?? 'GET'} ${url.pathname}`]
    const res = handler
      ? handler(init)
      : { status: 404, body: { message: `no route ${url.pathname}` } }
    return new Response(res.body === undefined ? null : JSON.stringify(res.body), {
      status: res.status,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  // No real socket in tests.
  vi.spyOn(events, 'start').mockImplementation(() => undefined)
  vi.spyOn(events, 'stop').mockImplementation(() => undefined)
  resetSessionForTests()
  auth.clear()
})

afterEach(() => {
  editorStore.getState().unload()
})

const renderAt = (path: string) => {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

const paired = () => auth.setSession({ token: 'tok', deviceId: 'dev1' })

describe('routes', () => {
  it('sends an unpaired device to /pair (after trying loopback pairing)', async () => {
    const router = renderAt('/exports')
    expect(await screen.findByText('Connect to your ReelForge')).toBeTruthy()
    expect(router.state.location.pathname).toBe('/pair')
    expect(router.state.location.search).toBe('?next=%2Fexports')
    expect(fetchMock.mock.calls.some(([u]) => urlOf(u).endsWith('/api/pair/local'))).toBe(true)
  })

  it('pairs automatically from a QR link and continues to next', async () => {
    const router = renderAt('/pair?code=123456&next=%2Fsettings')
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
    const pairCall = fetchMock.mock.calls.find(([u]) => urlOf(u).endsWith('/api/pair'))
    const body = pairCall?.[1]?.body
    expect(JSON.parse(typeof body === 'string' ? body : 'null')).toMatchObject({ code: '123456' })
    expect(auth.token).toBe('tok')
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy()
  })

  it('shows an actionable error for a wrong code', async () => {
    table['POST /api/pair'] = () => ({ status: 401, body: { message: 'bad code' } })
    renderAt('/pair?code=000000')
    expect((await screen.findByRole('alert')).textContent).toMatch(/wrong or has expired/)
  })

  it('never redirects off-site after pairing', async () => {
    const router = renderAt('/pair?code=123456&next=%2F%2Fevil.example')
    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
  })

  it('renders Home with the projects grid', async () => {
    paired()
    renderAt('/')
    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeTruthy()
    expect(await screen.findByText('Beach day')).toBeTruthy()
  })

  it('renders Exports and Settings', async () => {
    paired()
    renderAt('/exports')
    expect(await screen.findByText('No exports yet')).toBeTruthy()
  })

  it('renders Settings', async () => {
    paired()
    renderAt('/settings')
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy()
  })

  it('renders the share target with nothing shared', async () => {
    paired()
    renderAt('/share-target')
    expect(await screen.findByText('Nothing to import')).toBeTruthy()
  })

  // The editor route is a lazy chunk (timeline, panels, preview engine): its first import
  // under a loaded full-suite run can take several seconds.
  const LAZY = { timeout: 15_000 }

  it('opens the editor: project in the store, preview fallback, slots mounted', async () => {
    paired()
    renderAt('/p/p1')
    expect(await screen.findByTestId('editor', {}, LAZY)).toBeTruthy()
    expect((screen.getByLabelText('Project name') as HTMLInputElement).value).toBe('Beach day')
    expect(editorStore.getState().project?.id).toBe('p1')
    expect(await screen.findByTestId('preview-fallback')).toBeTruthy()
    expect(screen.getByTestId('timeline')).toBeTruthy()
    expect(screen.getByRole('toolbar', { name: 'Tools' })).toBeTruthy()
    expect(screen.getByTestId('timecode').textContent).toContain('0:05.00')
  }, 20_000)

  it('shows "Project not found" for a deleted project', async () => {
    paired()
    renderAt('/p/gone')
    expect(await screen.findByText('Project not found', {}, LAZY)).toBeTruthy()
  }, 20_000)

  it('renders the 404 page', async () => {
    renderAt('/definitely/not/here')
    expect(await screen.findByText('Page not found')).toBeTruthy()
  })
})
