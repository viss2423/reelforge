/**
 * Preview dev harness: loads a project (demo, picked media, or a JSON file) into the real
 * preview engine with local or served media, and shows live engine stats. Exposes
 * `window.__rfHarness` for the Playwright measurement script (dev/measure.ts).
 */
import { Asset, formatTimecode, Project } from '@reelforge/core'
import { createPreviewEngine, type PreviewEngine, type PreviewEngineOptions } from '../index.ts'
import { BlobByteSource, HttpByteSource } from '../media/byteSource.ts'
import { buildDemo, devEffect, warmCube, type Demo, type MediaEntry } from './demoProject.ts'

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel)
  if (!el) throw new Error(`missing ${sel}`)
  return el
}

const canvas = $<HTMLCanvasElement>('#view')
const statsEl = $<HTMLPreElement>('#stats')
const seek = $<HTMLInputElement>('#seek')
const timeEl = $<HTMLSpanElement>('#time')
const playBtn = $<HTMLButtonElement>('#play')
const logEl = $<HTMLDivElement>('#log')

const params = new URLSearchParams(location.search)
const decoder = (params.get('decoder') ?? 'auto') as NonNullable<PreviewEngineOptions['decoder']>
$<HTMLSelectElement>('#decoder').value = decoder

/** Media URL per asset id (served fixture paths or blob: URLs of picked files). */
let urls: Record<string, string> = {}
/** blob: URL → File, so local media is read with Blob slices instead of fetch. */
const localFiles = new Map<string, Blob>()
let fonts: { family: string; url: string }[] = []
const lutUrl = URL.createObjectURL(new Blob([warmCube()], { type: 'text/plain' }))
let current: Demo | undefined
let engine: PreviewEngine

const log = (msg: string): void => {
  logEl.textContent = `${msg}\n${logEl.textContent ?? ''}`.slice(0, 4000)
}
addEventListener('error', (e) => log(e.message))
addEventListener('unhandledrejection', (e) => log(String(e.reason)))

function createEngine(): PreviewEngine {
  const e = createPreviewEngine(canvas, {
    mediaUrl: (assetId) => urls[assetId] ?? '',
    assUrl: () => '',
    packFileUrl: (p) => `/packs/${p}`,
    fonts,
    resolveEffect: devEffect,
    resolveLut: (ref) => (ref === 'dev/warm' ? lutUrl : undefined),
    openMedia: (url) => {
      const blob = localFiles.get(url)
      return blob ? new BlobByteSource(blob) : new HttpByteSource(url)
    },
    decoder,
  })
  e.on('time', (t) => {
    timeEl.textContent = formatTimecode(t)
    const d = e.duration ?? 0
    if (d > 0 && document.activeElement !== seek) seek.value = String(Math.round((t / d) * 1000))
  })
  e.on('play', () => (playBtn.textContent = 'Pause'))
  e.on('pause', () => (playBtn.textContent = 'Play'))
  e.on('waiting', () => log(`waiting at ${formatTimecode(e.time)}`))
  return e
}

engine = createEngine()

function load(demo: Demo): void {
  current = demo
  urls = demo.urls
  engine.setProject(demo.project, demo.assets)
  engine.seek(0)
}

/** Probe a picked file's kind and dimensions with the browser's own decoders. */
async function probeFile(file: File): Promise<MediaEntry> {
  const url = URL.createObjectURL(file)
  localFiles.set(url, file)
  const kind = file.type.startsWith('image/')
    ? 'image'
    : file.type.startsWith('audio/')
      ? 'audio'
      : 'video'
  if (kind === 'image') {
    const bmp = await createImageBitmap(file)
    const entry = { name: file.name, kind, url, width: bmp.width, height: bmp.height } as const
    bmp.close()
    return entry
  }
  const el = document.createElement(kind)
  el.preload = 'metadata'
  el.src = url
  await new Promise<void>((res, rej) => {
    el.onloadedmetadata = () => res()
    el.onerror = () => rej(new Error(`cannot read ${file.name}`))
  })
  const v = el instanceof HTMLVideoElement ? el : undefined
  return {
    name: file.name,
    kind,
    url,
    width: v?.videoWidth,
    height: v?.videoHeight,
    duration: Math.round(el.duration * 1e6),
    hasAudio: true,
  }
}

/** Load the generated fixtures served from dev/.media (see fixtures.ts). */
async function loadDemoMedia(clips?: number): Promise<void> {
  const res = await fetch('/demo.json')
  if (!res.ok) throw new Error('demo media missing: run `node src/preview/dev/fixtures.ts`')
  const entries = (await res.json()) as (Omit<MediaEntry, 'url' | 'name'> & { file: string })[]
  load(
    buildDemo(
      entries.map((e) => ({ ...e, name: e.file, url: `/${e.file}` })),
      { clips },
    ),
  )
}

$<HTMLButtonElement>('#demo').onclick = () =>
  void loadDemoMedia().catch((e: unknown) => log(String(e)))

$<HTMLInputElement>('#media').onchange = async (ev) => {
  const files = [...((ev.target as HTMLInputElement).files ?? [])]
  try {
    load(buildDemo(await Promise.all(files.map(probeFile))))
  } catch (e) {
    log(String(e))
  }
}

$<HTMLInputElement>('#json').onchange = async (ev) => {
  const file = (ev.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    // `{ project, assets }`; media is matched by asset name to picked files, else served
    const raw = JSON.parse(await file.text()) as {
      project: unknown
      assets: Record<string, unknown>
    }
    const project = Project.parse(raw.project)
    const assets: Record<string, Asset> = {}
    const picked = new Map<string, string>()
    for (const [url, blob] of localFiles) if (blob instanceof File) picked.set(blob.name, url)
    const map: Record<string, string> = {}
    for (const [id, a] of Object.entries(raw.assets)) {
      const asset = Asset.parse(a)
      assets[id] = asset
      map[id] = picked.get(asset.name) ?? `/${asset.name}`
    }
    load({ project, assets, urls: map })
  } catch (e) {
    log(String(e))
  }
}

$<HTMLInputElement>('#fonts').onchange = (ev) => {
  const files = [...((ev.target as HTMLInputElement).files ?? [])]
  // family = file name up to the first '-' (Montserrat-ExtraBold.ttf → Montserrat)
  fonts = files.map((f) => ({
    family: f.name.replace(/[-_.].*$/, ''),
    url: URL.createObjectURL(f),
  }))
  engine.destroy()
  engine = createEngine()
  if (current) load(current)
}

playBtn.onclick = () => (engine.playing ? engine.pause() : engine.play())
seek.oninput = () => engine.seek(Math.round(((engine.duration ?? 0) * Number(seek.value)) / 1000))
const frameUs = (): number => 1e6 / (current?.project.settings.fps ?? 30)
$<HTMLButtonElement>('#step-back').onclick = () => engine.seek(Math.max(0, engine.time - frameUs()))
$<HTMLButtonElement>('#step-fwd').onclick = () => engine.seek(engine.time + frameUs())
$<HTMLSelectElement>('#quality').onchange = (ev) =>
  engine.setQuality((ev.target as HTMLSelectElement).value as 'auto' | 'low' | 'high')
$<HTMLSelectElement>('#decoder').onchange = (ev) => {
  params.set('decoder', (ev.target as HTMLSelectElement).value)
  location.search = params.toString()
}
$<HTMLButtonElement>('#snapshot').onclick = async () => {
  try {
    const blob = await engine.snapshot({ type: 'image/png' })
    const img = $<HTMLImageElement>('#snap')
    if (img.src) URL.revokeObjectURL(img.src)
    img.src = URL.createObjectURL(blob)
    img.hidden = false
  } catch (e) {
    log(String(e))
  }
}
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return
  if (e.code === 'Space') {
    e.preventDefault()
    playBtn.click()
  } else if (e.code === 'ArrowLeft') $<HTMLButtonElement>('#step-back').click()
  else if (e.code === 'ArrowRight') $<HTMLButtonElement>('#step-fwd').click()
})

// stats overlay at 4 Hz: cheap, and never competes with the frame loop
setInterval(() => {
  const s = engine.stats
  if (!s) return
  statsEl.textContent = [
    `${s.fps.toFixed(1)} fps  compose ${s.frameMs.toFixed(2)} ms  q${s.qualityLevel}`,
    `render ${s.renderWidth}×${s.renderHeight}  draws ${s.drawCalls}  uploads ${s.textureUploads}`,
    `decoder ${s.decoder}  active ${s.activeDecoders}  decoded ${s.framesDecoded}  resets ${s.decoderResets}`,
    `inexact ${s.inexactFrames}/${s.framesComposited}  ${s.waiting ? 'WAITING' : ''}`,
    `fetched ${(s.bytesFetched / 1048576).toFixed(1)} MB  gpu ${(s.gpuBytes / 1048576).toFixed(1)} MB`,
    `audio ${(s.audioDecodedBytes / 1048576).toFixed(1)} MB  images ${(s.imageBytes / 1048576).toFixed(1)} MB`,
  ].join('\n')
}, 250)

declare global {
  interface Window {
    __rfHarness?: {
      readonly engine: PreviewEngine
      loadDemoMedia(clips?: number): Promise<void>
    }
  }
}

window.__rfHarness = {
  get engine() {
    return engine
  },
  loadDemoMedia,
}
if (params.has('demo')) void loadDemoMedia().catch((e: unknown) => log(String(e)))
