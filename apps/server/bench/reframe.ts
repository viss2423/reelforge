/** node bench/reframe.ts <video> [seconds]: fast (YuNet) vs smart reframe. */
import { analyzeReframe, findReframeModels } from '../src/ai/reframe/index.ts'
import { findFfmpeg } from './ffmpeg.ts'
const data = process.env.REELFORGE_DATA ?? 'C:/tmp/rf-tb/data'
const models = findReframeModels({ models: data + '/models' } as never)!
const ffmpeg = findFfmpeg()
const file = process.argv[2]!
const limit = Number(process.argv[3] ?? 0)
const only = process.env.MODES ?? 'fast,smart'
for (const mode of only.split(',') as Array<'fast' | 'smart'>) {
  const t0 = performance.now()
  const r = await analyzeReframe({
    ffmpeg,
    file,
    model: models.face,
    models,
    mode,
    channels: 2,
    ...(limit ? { signal: AbortSignal.timeout(limit * 1000) } : {}),
  })
  const s = (performance.now() - t0) / 1000
  console.log(
    mode,
    'wall',
    s.toFixed(1) + 's',
    'fps',
    r.analysisFps,
    'subjects',
    r.subjects,
    'faces',
    r.facesFound,
    'coverage',
    r.coverage,
    'pts',
    r.path.length,
    JSON.stringify(r.framing ?? {}),
    'zoomPts',
    r.path.filter((p) => p.w).length,
  )
}
