/**
 * Export benchmark (not part of the test suite): a 30 s 1080×1920 @ 30 fps reel with six
 * clips, five transitions, a Ken Burns still, a keyframed zoom, music and text, exported
 * with the hardware H.264 encoder (if any) and with libx264.
 *
 *   node test/render/bench.ts [quality=high]
 */
import type { ExportPayload } from '../../src/contracts.ts'
import { runExport } from '../../src/render/index.ts'
import {
  FIXTURES,
  addFixture,
  createEnv,
  detectHwH264,
  fakeJob,
  mainClips,
  makeProject,
  probe,
  videoStream,
} from './harness.ts'

const quality = (process.argv[2] ?? 'high') as ExportPayload['settings']['quality']

const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Title,Arial,96,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,6,2,5,0,0,0,1
Style: Caption,Arial,72,&H00FFFFFF,&H0000E4FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,0,2,60,60,520,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 1,0:00:00.00,0:00:03.00,Title,,0,0,0,,{\\pos(540,500)\\fad(200,200)\\t(0,300,\\fscx120\\fscy120)}MY TRIP
${Array.from({ length: 60 }, (_, i) => {
  const s = (i * 0.5).toFixed(2)
  const e = (i * 0.5 + 0.5).toFixed(2)
  return `Dialogue: 0,0:00:${s.padStart(5, '0')},0:00:${e.padStart(5, '0')},Caption,,0,0,0,,{\\k25}word {\\k25}number ${i}`
}).join('\n')}
`

const hw = await detectHwH264()
const env = await createEnv(hw ? { h264: hw } : {})
await Promise.all(FIXTURES.map((f) => addFixture(env, f)))

const D = 5_400_000
const T = { duration: 480_000 }
const project = makeProject([
  {
    kind: 'main',
    clips: mainClips([
      { duration: D, assetId: 'land' },
      { duration: D, assetId: 'port', transitionIn: { type: 'fade', ...T } },
      {
        duration: D,
        type: 'image',
        assetId: 'img',
        autoMotion: 'zoomIn',
        transitionIn: { type: 'slideleft', ...T },
      },
      {
        duration: D,
        assetId: 'land',
        in: 300_000,
        transform: {
          scale: {
            value: 1,
            keyframes: [
              { t: 0, value: 1 },
              { t: D, value: 1.4 },
            ],
          },
        },
        transitionIn: { type: 'whip', ...T },
      },
      {
        duration: D,
        assetId: 'port',
        adjustments: { contrast: 20, saturation: 15 },
        transitionIn: { type: 'circleopen', ...T },
      },
      { duration: D, assetId: 'land', in: 200_000, transitionIn: { type: 'dissolve', ...T } },
    ]),
  },
  {
    kind: 'text',
    clips: [{ id: 'title', type: 'text', text: 'MY TRIP', start: 0, duration: 3_000_000 }],
  },
  {
    kind: 'audio',
    clips: [
      {
        id: 'm',
        type: 'audio',
        assetId: 'music',
        start: 0,
        duration: 10_000_000,
        duckUnderVoice: true,
      },
    ],
  },
])
env.store.projects.set(project.id, project)

const encoders: Array<ExportPayload['settings']['encoder']> = hw ? ['gpu', 'cpu'] : ['cpu']
for (const encoder of encoders) {
  const job = fakeJob<ExportPayload>(env, 'export', {
    projectId: project.id,
    settings: { resolution: '1080p', quality, encoder } as ExportPayload['settings'],
  })
  const t0 = performance.now()
  const r = await runExport(job.ctx, { buildAss: () => ass })
  const wall = (performance.now() - t0) / 1000
  const v = videoStream(await probe(r.file))
  console.warn(
    `${r.encoder.padEnd(10)} quality=${quality} wall=${wall.toFixed(2)}s realtime=${(r.duration / 1e6 / wall).toFixed(2)}x ` +
      `duration=${(r.duration / 1e6).toFixed(3)}s frames=${v.nb_frames} size=${(r.size / 1e6).toFixed(1)}MB${r.fallbackReason ? ` fallback: ${r.fallbackReason}` : ''}`,
  )
}
await env.dispose()
