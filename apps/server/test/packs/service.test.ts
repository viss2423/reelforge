/** Pack sync against a local HTTP fixture server: ETags, reuse, sha256 verification, atomic swap. */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import type { PackIndex, PackManifest, ServerEvent } from '@reelforge/core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { EventBus } from '../../src/jobs/events.ts'
import {
  compareVersions,
  encodePath,
  isSafePackId,
  resolveInside,
  safeSegments,
} from '../../src/packs/files.ts'
import { PackSyncError, PacksService } from '../../src/packs/service.ts'
import { log, tempDir } from '../helpers.ts'

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

/** In-memory static server with ETag support and a request log. */
class FixtureServer {
  files = new Map<string, Buffer>()
  /** Paths whose served bytes differ from the published ones (to simulate tampering). */
  tampered = new Map<string, Buffer>()
  requests: string[] = []
  server: Server
  base = ''

  constructor() {
    this.server = createServer((req, res) => {
      const url = decodeURIComponent((req.url ?? '/').split('?')[0]!)
      this.requests.push(url)
      const body = this.tampered.get(url) ?? this.files.get(url)
      if (!body) {
        res.writeHead(404).end()
        return
      }
      const etag = `"${sha(body).slice(0, 16)}"`
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag }).end()
        return
      }
      res.writeHead(200, { etag, 'content-length': body.length }).end(body)
    })
  }

  async listen(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r))
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/packs`
  }

  close(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()))
  }

  put(rel: string, body: Buffer | string): void {
    this.files.set(`/packs/${rel}`, Buffer.isBuffer(body) ? body : Buffer.from(body))
  }
}

interface PublishOptions {
  indexVersion: string
  packVersion: string
  files: Record<string, Buffer>
  font: Buffer
  minAppVersion?: string
  extraFiles?: Array<{ path: string; sha256: string; size: number }>
}

/** Publishes one pack ("trend-a") plus one font family to the fixture server. */
const publish = (
  srv: FixtureServer,
  o: PublishOptions,
): { index: PackIndex; manifest: PackManifest } => {
  const manifest = {
    id: 'trend-a',
    version: o.packVersion,
    name: 'Trend A',
    curatedAt: '2026-11-01',
    files: [
      ...Object.entries(o.files).map(([p, b]) => ({ path: p, sha256: sha(b), size: b.length })),
      ...(o.extraFiles ?? []),
    ],
    animations: [
      {
        id: 'pop',
        name: 'Pop',
        kind: 'in',
        tracks: {
          scale: [
            { t: 0, value: 0 },
            { t: 1, value: 1 },
          ],
        },
      },
    ],
    templates: [{ id: 'quick', name: 'Quick cuts', slots: [{ duration: 1_000_000 }] }],
  }
  const index = {
    version: o.indexVersion,
    updatedAt: '2026-11-01T00:00:00Z',
    minAppVersion: o.minAppVersion ?? '0.1.0',
    packs: [{ id: 'trend-a', version: o.packVersion, name: 'Trend A', curatedAt: '2026-11-01' }],
    fonts: [
      {
        family: 'Inter',
        files: [
          {
            path: 'fonts/Inter/Inter-Regular.ttf',
            sha256: sha(o.font),
            size: o.font.length,
            weight: 400,
          },
        ],
      },
    ],
  }
  srv.put('index.json', JSON.stringify(index))
  srv.put('trend-a/pack.json', JSON.stringify(manifest))
  for (const [p, b] of Object.entries(o.files)) srv.put(`trend-a/${p}`, b)
  srv.put('fonts/Inter/Inter-Regular.ttf', o.font)
  return { index: index as unknown as PackIndex, manifest: manifest as unknown as PackManifest }
}

describe('PacksService sync', () => {
  const srv = new FixtureServer()
  let root: string
  let cleanup: () => Promise<void>
  let bus: EventBus
  let events: ServerEvent[]
  const lut = Buffer.from('LUT_3D_SIZE 2\n0 0 0\n1 1 1\n')
  const sticker = randomBytes(5000)
  const font = randomBytes(20_000)

  const service = (over: Partial<ConstructorParameters<typeof PacksService>[0]> = {}) =>
    new PacksService({ root, url: srv.base, appVersion: '0.1.0', log, bus, ...over })

  beforeAll(() => srv.listen())
  afterAll(() => srv.close())
  beforeEach(async () => {
    ;({ dir: root, cleanup } = await tempDir('rf-packs-'))
    srv.files.clear()
    srv.tampered.clear()
    srv.requests = []
    bus = new EventBus()
    events = []
    bus.subscribe((e) => events.push(e))
  })
  afterEach(() => cleanup())

  const v1 = (): ReturnType<typeof publish> =>
    publish(srv, {
      indexVersion: '2026.11.1',
      packVersion: '1.0.0',
      files: { 'luts/warm.cube': lut, 'stickers/star.png': sticker },
      font,
    })

  it('falls back to bundled packs, or none, before the first sync', async () => {
    const empty = service()
    expect((await empty.init()).source).toBe('none')
    expect(empty.resolveFile('fonts/x.ttf')).toBeUndefined()

    // A bundled tree (repo ./packs) is used when nothing was synced.
    const bundled = path.join(root, 'bundled')
    const { index, manifest } = v1()
    await mkdir(path.join(bundled, 'trend-a'), { recursive: true })
    await writeFile(path.join(bundled, 'index.json'), JSON.stringify(index))
    await writeFile(path.join(bundled, 'trend-a', 'pack.json'), JSON.stringify(manifest))
    const svc = service({ bundledDir: bundled })
    const snap = await svc.init()
    expect(snap).toMatchObject({ source: 'bundled', dir: bundled })
    expect(snap.manifests.map((m) => m.id)).toEqual(['trend-a'])
    expect(svc.findAnimation('trend-a/pop')?.kind).toBe('in')
    expect(svc.findTemplate('trend-a/quick')?.slots).toHaveLength(1)
    expect(svc.findTemplate('trend-a/nope')).toBeUndefined()
    expect(svc.findAnimation('nopack')).toBeUndefined()
  })

  it('downloads, verifies and activates a pack tree; then 304s on the ETag', async () => {
    v1()
    const svc = service()
    await svc.init()
    const result = await svc.sync()
    expect(result).toMatchObject({
      status: 'updated',
      version: '2026.11.1',
      downloaded: 3,
      reused: 0,
    })
    expect(svc.snapshot.source).toBe('synced')
    expect(svc.version).toBe('2026.11.1')
    expect(events).toEqual([{ type: 'packs', version: '2026.11.1' }])
    const file = svc.resolveFile('trend-a/stickers/star.png')!
    expect((await readFile(file)).equals(sticker)).toBe(true)
    expect((await readFile(svc.resolveFile('fonts/Inter/Inter-Regular.ttf')!)).equals(font)).toBe(
      true,
    )
    expect(svc.resolveFile('../active.json')).toBeUndefined()
    const pointer = JSON.parse(await readFile(path.join(root, 'active.json'), 'utf8'))
    expect(pointer).toMatchObject({ version: '2026.11.1', etag: expect.any(String) })

    srv.requests = []
    expect(await svc.sync()).toEqual({ status: 'unchanged', version: '2026.11.1' })
    expect(srv.requests).toEqual(['/packs/index.json'])

    // A restart picks the synced tree up from the persisted pointer.
    const again = service()
    expect((await again.init()).source).toBe('synced')
    expect(again.version).toBe('2026.11.1')
  })

  it('reuses unchanged files, downloads changed ones and garbage-collects the old tree', async () => {
    v1()
    const svc = service()
    await svc.init()
    await svc.sync()
    const oldDir = svc.dir!
    const lut2 = Buffer.from('LUT_3D_SIZE 2\n0 0 0\n0.9 0.9 0.9\n')
    publish(srv, {
      indexVersion: '2026.11.2',
      packVersion: '1.1.0',
      files: { 'luts/warm.cube': lut2, 'stickers/star.png': sticker },
      font,
    })
    srv.requests = []
    const result = await svc.sync()
    expect(result).toMatchObject({
      status: 'updated',
      version: '2026.11.2',
      downloaded: 1,
      reused: 2,
    })
    expect(srv.requests.sort()).toEqual([
      '/packs/index.json',
      '/packs/trend-a/luts/warm.cube',
      '/packs/trend-a/pack.json',
    ])
    expect((await readFile(svc.resolveFile('trend-a/luts/warm.cube')!)).equals(lut2)).toBe(true)
    expect(svc.dir).not.toBe(oldDir)
    expect(existsSync(oldDir)).toBe(false)
    const dirs = (await readdir(root)).filter((d) => d !== 'active.json')
    expect(dirs).toEqual([path.basename(svc.dir!)])
  })

  it('rejects a sha256 mismatch and keeps the previous tree active (atomic swap)', async () => {
    v1()
    const svc = service()
    await svc.init()
    await svc.sync()
    const activeBefore = await readFile(path.join(root, 'active.json'), 'utf8')
    const dirBefore = svc.dir

    publish(srv, {
      indexVersion: '2026.11.3',
      packVersion: '1.2.0',
      files: {
        'luts/warm.cube': Buffer.from('LUT_3D_SIZE 2\n1 1 1\n0 0 0\n'),
        'stickers/star.png': sticker,
      },
      font,
    })
    // Same size, different bytes.
    srv.tampered.set('/packs/trend-a/luts/warm.cube', Buffer.from('LUT_3D_SIZE 2\n1 1 1\n0 0 1\n'))
    events = []
    await expect(svc.sync()).rejects.toThrow(/sha256 mismatch/)
    expect(svc.version).toBe('2026.11.1')
    expect(svc.dir).toBe(dirBefore)
    expect(await readFile(path.join(root, 'active.json'), 'utf8')).toBe(activeBefore)
    expect((await readFile(svc.resolveFile('trend-a/luts/warm.cube')!)).equals(lut)).toBe(true)
    expect((await readdir(root)).some((d) => d.startsWith('.staging-'))).toBe(false)
    expect(events).toEqual([])

    // Oversized downloads are cut off as soon as they exceed the declared size.
    srv.tampered.set('/packs/trend-a/luts/warm.cube', Buffer.alloc(10_000))
    await expect(svc.sync()).rejects.toBeInstanceOf(PackSyncError)
    expect(svc.version).toBe('2026.11.1')
  })

  it('rejects unsafe paths from the network', async () => {
    publish(srv, {
      indexVersion: '1',
      packVersion: '1.0.0',
      files: {},
      font,
      extraFiles: [{ path: '../../evil.txt', sha256: sha(Buffer.from('x')), size: 1 }],
    })
    const svc = service()
    await svc.init()
    await expect(svc.sync()).rejects.toThrow(/unsafe file path/)
    expect(svc.snapshot.source).toBe('none')
  })

  it('skips packs that need a newer app and fails cleanly on HTTP errors', async () => {
    publish(srv, {
      indexVersion: '9',
      packVersion: '1.0.0',
      files: {},
      font,
      minAppVersion: '99.0.0',
    })
    const svc = service()
    await svc.init()
    expect(await svc.sync()).toMatchObject({ status: 'skipped' })
    expect(svc.snapshot.source).toBe('none')

    srv.files.clear()
    await expect(svc.sync()).rejects.toThrow(/HTTP 404/)
  })

  it('shares one in-flight sync between concurrent callers', async () => {
    v1()
    const svc = service()
    await svc.init()
    const [a, b] = await Promise.all([svc.sync(), svc.sync()])
    expect(a).toBe(b)
    expect(srv.requests.filter((r) => r === '/packs/index.json')).toHaveLength(1)
  })

  it('start() syncs immediately and stop() halts the schedule', async () => {
    v1()
    const svc = service()
    await svc.init()
    svc.start(60_000)
    await svc.idle()
    await expect.poll(() => svc.version).toBe('2026.11.1')
    svc.stop()
  })
})

describe('pack path safety', () => {
  it('accepts normal relative paths', () => {
    expect(safeSegments('trend-a/luts/warm.cube')).toEqual(['trend-a', 'luts', 'warm.cube'])
    expect(safeSegments('fonts/Bebas Neue/BebasNeue-Regular.ttf')).toHaveLength(3)
  })

  it.each([
    '',
    '../x',
    'a/../b',
    './a',
    'a//b',
    '/abs',
    'a\\b',
    '.hidden',
    'a/b.',
    'a/b ',
    'nul\u0000',
    'CON',
    'packs/aux.txt',
    'x'.repeat(600),
  ])('rejects %j', (p) => {
    expect(safeSegments(p)).toBeUndefined()
  })

  it('resolveInside never escapes the root', () => {
    const root = path.resolve('/data/packs')
    expect(resolveInside(root, 'a/b.cube')).toBe(path.join(root, 'a', 'b.cube'))
    expect(resolveInside(root, '../secrets')).toBeUndefined()
  })

  it('validates pack ids, encodes URLs and compares versions', () => {
    expect(isSafePackId('trend-2026.11')).toBe(true)
    expect(isSafePackId('..')).toBe(false)
    expect(isSafePackId('a..b')).toBe(false)
    expect(isSafePackId('lpt1')).toBe(false)
    expect(isSafePackId('-x')).toBe(false)
    expect(encodePath('fonts/Bebas Neue/a#b.ttf')).toBe('fonts/Bebas%20Neue/a%23b.ttf')
    expect(compareVersions('1.10.0', '1.9.3')).toBe(1)
    expect(compareVersions('0.1.0', '0.1')).toBe(0)
    expect(compareVersions('0.1.0', '0.2.0-beta')).toBe(-1)
  })
})
