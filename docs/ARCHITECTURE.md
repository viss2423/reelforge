# ReelForge Architecture

ReelForge is a self-hosted editor for vertical short-form video (Instagram Reels, TikTok,
YouTube Shorts — always 9:16). One machine (the **host**, e.g. a laptop that is always on)
runs the server and does all heavy work: decoding, AI, rendering, encoding. Any device
(the host itself, phones, tablets, other laptops) opens the installable web app (PWA) and
edits; edits sync live between devices.

```
 Phone / tablet / laptop (PWA)                       Host machine
┌──────────────────────────────┐   HTTPS + WS   ┌──────────────────────────────────────┐
│ React 19 editor UI           │ ─────────────► │ Fastify 5 API  (apps/server)         │
│ Preview engine (WebGL2 +     │ ◄───────────── │  ├─ SQLite store (projects/assets)   │
│  JASSUB/libass for text)     │  proxies, thumbs│  ├─ Job queue (resource classes)    │
│ plays 540p proxies only      │  waveforms, ASS │  ├─ Media: probe/proxy/thumbs/wave  │
│ Immer patches + undo/redo    │                 │  ├─ Render: core compiler → FFmpeg  │
└──────────────────────────────┘                 │  │   (AMF/NVENC/QSV GPU encode)      │
                                                 │  ├─ AI: whisper.cpp, silence, beats, │
                                                 │  │   scenes, reframe (ONNX)          │
                                                 │  └─ Packs: auto-sync from GitHub     │
                                                 └──────────────────────────────────────┘
```

## Principles

1. **Host does the work.** Clients never decode originals or encode. The client only plays
   low-resolution proxies the host generated and composites them for preview.
2. **One model, two renderers, same result.** `@reelforge/core` owns the project model and
   compiles it to (a) an FFmpeg filter graph for export and (b) data the web preview draws.
   Text and captions are rendered by **libass in both places** (FFmpeg `ass` filter on the
   host, JASSUB WASM in the browser) from the same generated `.ass`, so what you see is what
   you export.
3. **Performance first.** GPU encode by default with verified fallback, proxies with short
   GOP for instant scrubbing, filter graphs instead of intermediate files, worker threads
   for CPU analysis, no blocking I/O on the request path, virtualised timeline rendering.
4. **Pure core, thin edges.** Every timeline operation is a pure function in `core` with
   unit + property tests. Server and web are adapters.
5. **Reels only.** Canvas is fixed at 1080×1920; export resolution scales that.

## Repository layout and ownership

| Path | Package | Responsibility |
| --- | --- | --- |
| `packages/core` | `@reelforge/core` | schema (zod), time utils, animation/easing evaluation, timeline ops, ASS generation, FFmpeg render compiler, pack schema |
| `apps/server` | `@reelforge/server` | Fastify API, auth/pairing, HTTPS/local CA, SQLite, uploads, media derivation, job queue, WebSocket events, export runner, AI jobs, pack sync, serving the web build |
| `apps/web` | `@reelforge/web` | React PWA: projects, media library/upload, editor (timeline, tools, inspector), preview engine, export UI, pairing |
| `packs/` | — | Trend packs (JSON + LUTs + stickers) and OFL fonts, auto-pulled by every install |
| `scripts/` | — | `setup.mjs` (downloads whisper.cpp + models, checks FFmpeg), Windows autostart/firewall scripts, pack build tool |
| `docs/` | — | Architecture, API, contributing |

## Conventions

- Node **26 LTS**, TypeScript **7** (`tsc` native), ESM everywhere, `.ts` import specifiers.
  The server runs TypeScript directly via Node's built-in type stripping (no build step), so
  server code must use **erasable syntax only** (no `enum`, no `namespace`, no parameter
  properties). Use zod enums / union types instead.
- Times are integer **microseconds** everywhere (`Us`). Spatial values in canvas px.
- Lint: `oxlint --type-aware`. Format: Prettier. Tests: Vitest (unit/integration), Playwright (e2e).
- No `any` without a comment explaining why. No `console.log` in committed code (use logger).
- Every module ships with tests. Integration tests that need FFmpeg generate their own
  fixtures with `lavfi` (`testsrc2`, `sine`, `anullsrc`) — no binary fixtures in git.
- Commits: conventional commits (`feat(core): …`). **No co-author / tool attribution trailers.**

## Core (`@reelforge/core`)

```
src/schema.ts        project/asset/job/event model (zod) — THE contract
src/packs.ts         trend pack schemas
src/time.ts          microsecond helpers
src/animation.ts     easing functions, evaluate(Animatable, t), pack animation evaluation
src/ops/*.ts         pure timeline operations (mutate a draft in place; Immer-compatible)
src/validate.ts      invariants check → Issue[]
src/ass.ts           buildAss(project, ctx) → .ass document (text clips + captions)
src/compile/*.ts     compileRender(project, ctx) → RenderPlan (FFmpeg inputs + filter graph)
src/ids.ts           id generation (crypto.randomUUID-based, short)
```

### Operations (all `(draft: Project, …) => void` unless noted; throw `OpError` on invalid input)

- `createProject({ name, fps?, id?, now? }) → Project` — creates `main` track + one `audio` + one `text` track.
- `projectDuration(p) → Us`
- `findClip(p, clipId) → { track, clip, index } | undefined`
- `addTrack(p, kind, opts?) → Track`, `removeTrack(p, trackId)`
- `insertMediaClip(p, { trackId, asset, at?, index? }) → MediaClip` — main track: insert at index & ripple; others: place at `at`, find free spot.
- `insertAudioClip`, `insertTextClip`, `insertStickerClip`
- `splitClip(p, clipId, t)` — t in timeline time; both halves keep source mapping, keyframes split correctly.
- `trimClip(p, clipId, { start?, end? })` — edges in timeline time; main track ripples.
- `moveClip(p, clipId, { trackId?, start?, index? })`
- `deleteClips(p, clipIds, { ripple })`, `duplicateClip(p, clipId) → Clip`
- `setClipSpeed(p, clipId, speed)` — recomputes duration; keeps start.
- `removeSourceRanges(p, clipId, ranges: {start,end}[])` — used by silence/filler removal: ranges are in the asset's **source** time; splits and removes, ripples main track, remaps captions.
- `buildCaptions(p, transcripts: Record<assetId, Word[]>, style)` — maps source-time words through main-track (and overlay video) clips into timeline time, drops words in cut regions.
- `syncToBeats(p, beats: Us[], { every?: 1|2|4, trackId? })` — re-times main-track clip boundaries to beat markers.
- `applyTemplate(template, assets, { packs }) → Project`
- `applyReframe(p, clipId, path: {t: Us, x: number}[])` — keyframes `transform.x` to follow subject.
- `normalizeMainTrack(p)` — enforces contiguity; called by ops that touch main.
- Time mapping helpers: `timelineToSource(clip, t)`, `sourceToTimeline(clip, s)`.

### Render compiler

```ts
compileRender(project: Project, ctx: CompileContext): RenderPlan

interface CompileContext {
  assets: Record<string, Asset & { path: string }>   // originals on disk
  settings: ExportSettings
  output: string                                    // output file path
  assPath?: string                                  // where the server wrote buildAss() output
  fontsDir: string
  resolveLut(ref: string): string | undefined       // pack LUT ref → .cube path
  resolveSticker(ref: string): string | undefined
  encoder: { video: string; args: string[] }        // chosen by the server (GPU or CPU)
}

interface RenderPlan {
  args: string[]            // full ffmpeg argv (without the binary), uses -/filter_complex <file>
  filterGraph: string       // written by the server to a temp file referenced in args
  filterGraphPath: string   // placeholder path the args reference (server substitutes/writes)
  duration: Us              // for progress
  frames: number
}
```

Graph shape: base colour/blur-fill canvas → main track clips (trim/setpts/speed/reverse,
scale+crop to fit, transform with expressions for keyframes, adjustments via `eq`/
`colortemperature`/`curves`, `lut3d` + mix for filters, effects) chained with `xfade` for
transitions → `overlay` per overlay-track clip with `enable='between(t,a,b)'` → stickers →
`ass` (text + captions) → `scale` to export resolution → format. Audio: per clip `atrim`/
`asetpts`/`atempo` (rubberband when preservePitch) /`volume`/`afade`, `arnndn` for denoise,
sidechain ducking, `amix`, `loudnorm` → AAC 320k.

Snapshot tests assert graphs; server integration tests render real files and ffprobe them.

## Server (`@reelforge/server`)

Contracts live in `apps/server/src/contracts.ts` (DataPaths, Toolchain, Store, JobContext,
JobDefinition). Directory ownership:

```
src/index.ts          boot: config → toolchain detect → store → queue → packs → http(s)
src/config.ts         env + defaults (ports 8080 http / 8443 https, data dir ~/.reelforge)
src/toolchain.ts      locate ffmpeg/ffprobe/whisper; test-encode to verify GPU encoders
src/db/               better-sqlite3 Store impl + migrations (WAL mode)
src/http/             Fastify app factory, routes, auth hook, static web, Range streaming
src/auth/             device pairing (6-digit rotating code + QR), tokens (hashed), cookie
src/net/              local CA + leaf cert for LAN IPs/hostnames, mDNS name, Tailscale detect
src/jobs/             queue with resource classes, priorities, cancellation, persistence, events
src/media/            uploads (chunked/resumable), probe, proxy, thumbnails sprite, waveform peaks
src/render/           export runner (compileRender → ffmpeg, progress, GPU fallback), preview renders
src/ai/               transcribe (whisper.cpp), silence, fillers, beats, scenes, reframe, denoise
src/packs/            pack sync from GitHub (sha256 verify, atomic swap), serving pack files
```

### HTTP API (all JSON unless noted; all `/api/*` except `health` and `pair*` require auth)

Auth is a device token sent as `Authorization: Bearer <token>` **or** the `rf_token`
HttpOnly cookie (so `<video src>` works). Loopback clients on the host may obtain a token
without a code.

| Method | Path | Body → Response |
| --- | --- | --- |
| GET | `/api/health` | → `{ ok, version }` |
| GET | `/api/pair/info` | loopback only → `{ code, expiresAt, urls[], qrSvg }` |
| POST | `/api/pair` | `{ code, deviceName }` → `{ token, deviceId }` + cookie (rate limited) |
| POST | `/api/pair/local` | loopback only → `{ token, deviceId }` + cookie |
| GET | `/api/devices` / DELETE `/api/devices/:id` | list / revoke paired devices |
| GET | `/api/system` | toolchain, encoders, CPU, RAM, disk free, versions |
| GET | `/api/projects` | → summaries |
| POST | `/api/projects` | `{ name, templateRef?, assetIds? }` → Project |
| GET | `/api/projects/:id` | → Project |
| PUT | `/api/projects/:id` | `{ project, expectedRevision, deviceId }` → `{ revision }` · 409 `{ project }` |
| DELETE | `/api/projects/:id` | |
| POST | `/api/projects/:id/duplicate` | → Project |
| POST | `/api/uploads` | `{ name, size, mime }` → `{ uploadId, chunkSize }` |
| PUT | `/api/uploads/:id/chunks/:index` | raw bytes → `{ received }` (idempotent) |
| GET | `/api/uploads/:id` | → `{ received: number[] }` (resume) |
| POST | `/api/uploads/:id/complete` | → Asset (enqueues probe→proxy/thumbnails/waveform) |
| GET | `/api/assets` · `/api/assets/:id` · DELETE `/api/assets/:id` | |
| GET | `/api/assets/:id/original` · `/proxy` | video/audio bytes, HTTP Range |
| GET | `/api/assets/:id/thumbs.jpg` · `/thumbs.json` · `/poster.jpg` · `/waveform.json` | |
| POST | `/api/jobs` | `{ kind, payload, projectId?, assetId? }` → Job |
| GET | `/api/jobs?active=1&projectId=` · `/api/jobs/:id` | |
| POST | `/api/jobs/:id/cancel` | |
| GET | `/api/exports/:jobId/file` | MP4, Range, `?download=1` sets Content-Disposition |
| GET | `/api/projects/:id/ass` | generated `.ass` for the preview (JASSUB) |
| GET | `/api/packs` | → `{ index, manifests }` |
| GET | `/api/packs/files/*` | LUTs, stickers, thumbs, fonts (immutable cache headers) |
| POST | `/api/packs/sync` | trigger update now |
| WS | `/api/events` | stream of `ServerEvent` (zod in core) |

The server also serves `apps/web/dist` at `/` (SPA fallback) and, on plain HTTP, a pairing
landing page with the local CA download so phones can trust HTTPS and install the PWA.

### Job kinds → resource class

| kind | class | notes |
| --- | --- | --- |
| probe, waveform, thumbnails | io / cpu | fast, high priority |
| proxy | gpu-encode | 540×960, H.264, GOP 15, AAC — instant scrubbing on phones |
| export, preview | gpu-encode | AMF/NVENC/QSV → libx264/libx265/libsvtav1 fallback |
| transcribe | ai | whisper.cpp, word timestamps, cached per asset |
| silence, scenes | cpu | FFmpeg `silencedetect` / `scdet` |
| beats | cpu | onset/tempo detection in a worker thread on decoded PCM |
| reframe | ai | ONNX face detection (onnxruntime-node, DirectML on Windows) + smoothing |

## Web (`@reelforge/web`)

React 19 + Vite 8 + Tailwind 4 + Zustand/Immer + TanStack Query, `vite-plugin-pwa`.
Mobile-first (CapCut-style: preview on top, timeline below, tool bar at bottom); desktop gets
a three-pane layout and keyboard shortcuts.

```
src/main.tsx, src/app/       router (Home, Editor, Pair, Settings, Exports)
src/api/                     typed client, websocket (reconnect), chunked uploader
src/state/                   project store (Immer patches, undo/redo, autosave with revision),
                             selection, playhead, UI state
src/editor/                  Timeline (virtualised, pinch-zoom, snapping, magnetic main track),
                             Toolbar + panels (Edit, Audio, Text, Captions, Effects, Filters,
                             Adjust, Transitions, Stickers, Templates, AI), Inspector
src/preview/                 PreviewEngine (WebGL2 compositor, JASSUB overlay, WebAudio mix)
src/components/              design system primitives
```

Preview engine interface (consumed by the editor):

```ts
createPreviewEngine(canvas: HTMLCanvasElement, opts: {
  mediaUrl(assetId: string, variant: 'proxy' | 'original'): string
  assUrl(projectId: string): string
  packFileUrl(path: string): string
  fonts: { family: string; url: string }[]
}): PreviewEngine

interface PreviewEngine {
  setProject(p: Project, assets: Record<string, Asset>): void   // cheap; diff internally
  seek(t: Us): void
  play(): void
  pause(): void
  readonly playing: boolean
  readonly time: Us
  on(event: 'time' | 'play' | 'pause' | 'ended' | 'waiting', cb: (t: Us) => void): () => void
  setQuality(q: 'auto' | 'low' | 'high'): void
  destroy(): void
}
```

## Networking & install

- HTTPS on `:8443` with a locally generated CA (installed once per phone from the pairing
  page) so the PWA is installable and can use service workers; HTTP `:8080` serves only the
  pairing landing page + CA and redirects everything else.
- Pairing: the host shows a QR code (URL + one-time 6-digit code). Scanning it on a phone
  pairs the device and opens the app; "Add to Home Screen" installs it.
- Remote access away from home: Tailscale (documented; detected and shown in Settings).
- `scripts/windows/install-autostart.ps1` registers a startup task and firewall rule.

## Trend packs

See `packages/core/src/packs.ts`. Packs live in this repo under `packs/` and are pulled by
every install (default every 6 h, and on demand). A pack bump is a normal PR: anyone can
contribute new caption styles, templates, LUTs, transitions and effects that are trending.
`scripts/build-packs.mjs` computes sha256/size for every file and regenerates `index.json`.
