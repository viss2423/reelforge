/**
 * A procedurally drawn 9:16 "test scene" used as the backdrop for every thumbnail.
 *
 * It deliberately contains the colours a grade has to handle — a warm-to-blue sky, a sun
 * with highlight roll-off, foliage greens, water blues, a saturated red/pink, and a skin
 * tone — so LUT previews show the look's character instead of a flat swatch.
 */
import { Canvas, Path, blurMask, circle, ellipse, fillMask, roundRect } from './raster.mjs'

/** Scene size: half of the 1080×1920 canvas keeps generation fast; thumbs are smaller still. */
export const SCENE_W = 540
export const SCENE_H = 960

/** Closed path along `fn(x)` from x=0..w, then down to the bottom edge. */
function ridge(w, h, fn, step = 6) {
  const p = new Path().moveTo(0, h)
  for (let x = 0; x <= w; x += step) p.lineTo(x, fn(x))
  return p.lineTo(w, h).close()
}

/** @returns {Canvas} */
export function drawScene() {
  const w = SCENE_W
  const h = SCENE_H
  const c = new Canvas(w, h, '#000000')
  // Sky: deep blue zenith → magenta → warm horizon.
  c.composite(new Float32Array(w * h).fill(1), {
    linear: [0, 0, 0, 560],
    stops: [
      [0, '#1d3f8f'],
      [0.45, '#5f7fd0'],
      [0.75, '#f08a8a'],
      [1, '#ffc27a'],
    ],
  })
  // Sun with a soft glow (tests highlight handling).
  const sun = fillMask(w, h, circle(360, 470, 62))
  c.composite(blurMask(sun, w, h, 70), '#fff0b0', 0.9)
  c.composite(sun, '#fff8e0')
  // Far mountains (cool), near hills (greens).
  c.fill(
    ridge(w, h, (x) => 520 - 70 * Math.sin(x / 70) - 40 * Math.sin(x / 23 + 1)),
    '#6a5f9e',
  )
  c.fill(
    ridge(w, h, (x) => 590 - 35 * Math.sin(x / 90 + 2) - 12 * Math.sin(x / 17)),
    {
      linear: [0, 540, 0, 680],
      stops: [
        [0, '#3f8a4a'],
        [1, '#1f5a2c'],
      ],
    },
  )
  // Lake with a sun reflection.
  c.fill(roundRect(-20, 660, w + 40, 150, 0), {
    linear: [0, 660, 0, 810],
    stops: [
      [0, '#4aa3c8'],
      [1, '#1b5f86'],
    ],
  })
  c.fill(ellipse(360, 700, 46, 12), '#ffe9b0', 0.7)
  // Foreground ground.
  c.fill(
    ridge(w, h, (x) => 800 + 18 * Math.sin(x / 60)),
    {
      linear: [0, 790, 0, h],
      stops: [
        [0, '#7a5a3a'],
        [1, '#3a2a1c'],
      ],
    },
  )
  // A person: red top, skin-tone face, dark hair — the "skin tone" probe.
  c.fill(roundRect(110, 690, 150, 270, 70), '#d7263d')
  c.fill(circle(185, 640, 58), '#e9b48f')
  c.fill(new Path().arc(185, 632, 62, 60, 180, 360, 40).close(), '#2b1a12')
  // Pink flowers in the grass (saturated magenta probe).
  for (const [x, y] of [
    [330, 880],
    [380, 860],
    [430, 895],
    [480, 870],
  ]) {
    c.fill(circle(x, y, 13), '#ff4fa3')
    c.fill(circle(x, y, 5), '#ffe14d')
  }
  return c
}
