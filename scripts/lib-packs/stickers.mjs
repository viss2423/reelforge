/**
 * Original sticker artwork, drawn procedurally (CC0). Every sticker is a recipe
 * `{ pack, id, width, height, draw(canvas) }`; `renderSticker` returns PNG bytes.
 *
 * Style language: "die-cut" stickers (white border + soft shadow) for icons and badges,
 * marker strokes for annotations (circles, arrows, underlines) — the hand-drawn overlay
 * look that is trending on Reels/TikTok right now.
 */
import {
  Canvas,
  Path,
  blurMask,
  circle,
  ellipse,
  fillMask,
  heart,
  polygon,
  roundRect,
  sparkle,
  star,
  strokeMask,
  unionMask,
} from './raster.mjs'

/* ------------------------------------------------------------------ helpers */

/** Deterministic PRNG (mulberry32) so "hand-drawn" jitter is reproducible. */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Die-cut look: soft shadow, white border, then the fill. */
function dieCut(c, path, paint, { border = 14, shadow = true } = {}) {
  const fill = fillMask(c.w, c.h, path)
  const outline = unionMask(fill, strokeMask(c.w, c.h, path, border * 2))
  if (shadow) c.shadow(outline, { dy: 6, blur: 12, color: '#00000059' })
  c.composite(outline, '#ffffff')
  c.composite(fill, paint)
  return fill
}

/** Comic outline look: shapes are unioned, outlined in ink, white inside. */
function outlined(c, paths, paint = '#FFFFFF', ink = '#111111', width = 20) {
  let fill = new Float32Array(c.w * c.h)
  let outline = fill
  for (const p of paths) {
    const f = fillMask(c.w, c.h, p)
    fill = unionMask(fill, f)
    outline = unionMask(outline, unionMask(f, strokeMask(c.w, c.h, p, width)))
  }
  c.shadow(outline, { dy: 6, blur: 12, color: '#00000059' })
  c.composite(outline, ink)
  c.composite(fill, paint)
}

/** Marker stroke with a faint dark halo so it reads on any footage. */
function marker(c, path, width, paint, halo = '#00000040') {
  const m = strokeMask(c.w, c.h, path, width)
  c.composite(blurMask(m, c.w, c.h, 6), halo)
  c.composite(m, paint)
  return m
}

/* ------------------------------------------------------------------ stroke font */

const arcPts = (cx, cy, rx, ry, a0, a1, n = 24) =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)]
  })

/** Monoline rounded capitals: glyph = [advance, polylines] in cap-height units. */
const GLYPHS = {
  ' ': [0.32, []],
  '!': [
    0,
    [
      [
        [0, 0],
        [0, 0.6],
      ],
      [[0, 0.98]],
    ],
  ],
  0: [0.62, [arcPts(0.31, 0.5, 0.31, 0.5, -90, 270, 48)]],
  1: [
    0.3,
    [
      [
        [0, 0.2],
        [0.3, 0],
        [0.3, 1],
      ],
    ],
  ],
  B: [
    0.58,
    [
      [
        [0, 1],
        [0, 0],
        [0.28, 0],
        ...arcPts(0.28, 0.24, 0.24, 0.24, -90, 90),
        [0, 0.48],
        [0.32, 0.48],
        ...arcPts(0.32, 0.74, 0.26, 0.26, -90, 90),
        [0, 1],
      ],
    ],
  ],
  C: [0.66, [arcPts(0.4, 0.5, 0.4, 0.5, -45, -315, 40)]],
  E: [
    0.5,
    [
      [
        [0.5, 0],
        [0, 0],
        [0, 1],
        [0.5, 1],
      ],
      [
        [0, 0.5],
        [0.42, 0.5],
      ],
    ],
  ],
  F: [
    0.5,
    [
      [
        [0, 1],
        [0, 0],
        [0.5, 0],
      ],
      [
        [0, 0.48],
        [0.4, 0.48],
      ],
    ],
  ],
  I: [
    0,
    [
      [
        [0, 0],
        [0, 1],
      ],
    ],
  ],
  K: [
    0.56,
    [
      [
        [0, 0],
        [0, 1],
      ],
      [
        [0.54, 0],
        [0, 0.6],
      ],
      [
        [0.18, 0.42],
        [0.56, 1],
      ],
    ],
  ],
  L: [
    0.48,
    [
      [
        [0, 0],
        [0, 1],
        [0.48, 1],
      ],
    ],
  ],
  N: [
    0.64,
    [
      [
        [0, 1],
        [0, 0],
        [0.64, 1],
        [0.64, 0],
      ],
    ],
  ],
  O: [0.8, [arcPts(0.4, 0.5, 0.4, 0.5, -90, 270, 48)]],
  R: [
    0.58,
    [
      [[0, 1], [0, 0], [0.3, 0], ...arcPts(0.3, 0.25, 0.25, 0.25, -90, 90), [0, 0.5]],
      [
        [0.22, 0.5],
        [0.58, 1],
      ],
    ],
  ],
  S: [
    0.58,
    [[...arcPts(0.29, 0.25, 0.27, 0.25, -15, -270), ...arcPts(0.29, 0.75, 0.29, 0.25, -90, 165)]],
  ],
  U: [0.62, [[[0, 0], [0, 0.62], ...arcPts(0.31, 0.62, 0.31, 0.38, 180, 0), [0.62, 0]]]],
  W: [
    0.96,
    [
      [
        [0, 0],
        [0.22, 1],
        [0.48, 0.28],
        [0.74, 1],
        [0.96, 0],
      ],
    ],
  ],
}

/** Width of `text` in cap-height units for a given weight/size ratio. */
function textAdvance(chars, gap) {
  return chars.reduce((sum, ch, i) => {
    const g = GLYPHS[ch]
    if (!g) throw new Error(`sticker font has no glyph "${ch}"`)
    return sum + g[0] + (i < chars.length - 1 ? gap : 0)
  }, 0)
}

/**
 * Path of `text` centred on (cx, cy) with cap height `size` and stroke width `weight`,
 * shrunk uniformly when it would be wider than `maxWidth` (stroke included).
 */
function textPath(text, { cx, cy, size, weight, maxWidth = Infinity }) {
  const chars = [...text]
  const gap = 0.22 + weight / size
  const fit = Math.min(1, maxWidth / (textAdvance(chars, gap) * size + weight))
  const s = size * fit
  const path = new Path()
  let x = cx - (textAdvance(chars, gap) * s) / 2
  const top = cy - s / 2
  for (const ch of chars) {
    const [adv, lines] = GLYPHS[ch]
    for (const line of lines) {
      path.moveTo(x + line[0][0] * s, top + line[0][1] * s)
      for (const [gx, gy] of line.slice(1)) path.lineTo(x + gx * s, top + gy * s)
    }
    x += (adv + gap) * s
  }
  return { path, weight: weight * fit }
}

/** Stroke text, optionally with an outline behind it. */
function drawText(c, text, { outline, outlineColor = '#000000', color, ...layout }) {
  const { path, weight } = textPath(text, layout)
  const scale = weight / layout.weight
  if (outline) c.composite(strokeMask(c.w, c.h, path, weight + outline * 2 * scale), outlineColor)
  c.composite(strokeMask(c.w, c.h, path, weight), color)
}

/** Hand-drawn loop: an ellipse traced ~1.15 times with seeded wobble. */
function scribbleLoop(cx, cy, rx, ry, seed, turns = 1.15) {
  const rand = rng(seed)
  const wob = Array.from({ length: 6 }, () => (rand() - 0.5) * 0.08)
  const p = new Path()
  const steps = 160
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * turns
    const a = (t * 360 - 100) * (Math.PI / 180)
    const k = 1 + wob[0] * Math.sin(a * 2 + wob[1] * 40) + wob[2] * Math.cos(a * 3) + t * 0.06
    const x = cx + rx * k * Math.cos(a) + wob[3] * rx * t
    const y = cy + ry * k * Math.sin(a) + wob[4] * ry * t
    if (i === 0) p.moveTo(x, y)
    else p.lineTo(x, y)
  }
  return p
}

/** Arrow head as a polyline "V" at point (x, y) pointing along angle `deg`. */
function arrowHead(x, y, deg, len, spread = 32) {
  const back = (a) => [
    x - len * Math.cos((a * Math.PI) / 180),
    y - len * Math.sin((a * Math.PI) / 180),
  ]
  return new Path()
    .moveTo(...back(deg - spread))
    .lineTo(x, y)
    .lineTo(...back(deg + spread))
}

function face(c, cx, cy, r) {
  const head = circle(cx, cy, r)
  dieCut(c, head, {
    radial: [cx - r * 0.3, cy - r * 0.35, r * 1.5],
    stops: [
      [0, '#FFE873'],
      [1, '#F5A300'],
    ],
  })
}

const DARK = '#3A2412'

/* ------------------------------------------------------------------ recipes */

/** @typedef {{ pack: string, id: string, width: number, height: number, draw: (c: Canvas) => void }} StickerRecipe */

/** @type {StickerRecipe[]} */
export const STICKERS = [
  /* -------- essentials: annotations */
  {
    pack: 'essentials',
    id: 'arrow-hand-drawn',
    width: 512,
    height: 512,
    draw(c) {
      const shaft = new Path().moveTo(90, 420).cubicTo(130, 260, 260, 150, 420, 120)
      marker(c, shaft, 26, '#FF3B30')
      marker(c, arrowHead(420, 120, -12, 95, 38), 26, '#FF3B30')
    },
  },
  {
    pack: 'essentials',
    id: 'arrow-bold',
    width: 512,
    height: 512,
    draw(c) {
      const p = polygon([
        [70, 200],
        [290, 200],
        [290, 110],
        [450, 256],
        [290, 402],
        [290, 312],
        [70, 312],
      ])
      dieCut(c, p, {
        linear: [70, 0, 450, 0],
        stops: [
          [0, '#FFE400'],
          [1, '#FFB800'],
        ],
      })
    },
  },
  {
    pack: 'essentials',
    id: 'arrow-curved-white',
    width: 512,
    height: 512,
    draw(c) {
      const shaft = new Path().moveTo(110, 110).cubicTo(420, 90, 470, 300, 260, 420)
      marker(c, shaft, 24, '#FFFFFF', '#000000a0')
      marker(c, arrowHead(260, 420, 150, 90, 36), 24, '#FFFFFF', '#000000a0')
    },
  },
  {
    pack: 'essentials',
    id: 'circle-scribble',
    width: 512,
    height: 384,
    draw(c) {
      marker(c, scribbleLoop(256, 192, 205, 140, 7), 16, '#FF3B30')
    },
  },
  {
    pack: 'essentials',
    id: 'underline-scribble',
    width: 512,
    height: 160,
    draw(c) {
      const p = new Path().moveTo(30, 95)
      for (let x = 30; x <= 482; x += 4)
        p.lineTo(x, 88 + Math.sin((x - 30) / 28) * 16 - (x - 30) * 0.03)
      marker(c, p, 18, '#FF3B30')
    },
  },
  {
    pack: 'essentials',
    id: 'underline-double',
    width: 512,
    height: 160,
    draw(c) {
      marker(c, new Path().moveTo(36, 70).quadTo(256, 52, 478, 66), 16, '#FFE400')
      marker(c, new Path().moveTo(70, 110).quadTo(260, 94, 450, 106), 16, '#FFE400')
    },
  },
  {
    pack: 'essentials',
    id: 'highlight-swipe',
    width: 512,
    height: 160,
    draw(c) {
      const p = new Path().moveTo(40, 86).quadTo(256, 70, 472, 80)
      c.composite(strokeMask(c.w, c.h, p, 92), '#FFE400', 0.55)
    },
  },
  {
    pack: 'essentials',
    id: 'heart',
    width: 512,
    height: 512,
    draw(c) {
      dieCut(c, heart(256, 262, 190), {
        radial: [190, 170, 330],
        stops: [
          [0, '#FF6B81'],
          [1, '#E0002A'],
        ],
      })
    },
  },
  {
    pack: 'essentials',
    id: 'star',
    width: 512,
    height: 512,
    draw(c) {
      dieCut(c, star(256, 272, 220, 100, 5), {
        radial: [220, 200, 300],
        stops: [
          [0, '#FFF27A'],
          [1, '#FFB300'],
        ],
      })
    },
  },
  {
    pack: 'essentials',
    id: 'sparkle',
    width: 512,
    height: 512,
    draw(c) {
      const m = fillMask(c.w, c.h, sparkle(256, 256, 210))
      c.composite(blurMask(m, c.w, c.h, 26), '#FFFFFFb0')
      c.composite(m, '#FFFFFF')
    },
  },
  {
    pack: 'essentials',
    id: 'sparkles-cluster',
    width: 512,
    height: 512,
    draw(c) {
      for (const [x, y, r] of [
        [200, 290, 170],
        [390, 130, 90],
        [395, 400, 60],
      ]) {
        const m = fillMask(c.w, c.h, sparkle(x, y, r))
        c.composite(blurMask(m, c.w, c.h, 14), '#FFC80080')
        c.composite(m, '#FFE14D')
      }
    },
  },
  {
    pack: 'essentials',
    id: 'check',
    width: 512,
    height: 512,
    draw(c) {
      dieCut(c, circle(256, 256, 210), '#22C55E')
      const tick = new Path().moveTo(160, 262).lineTo(228, 330).lineTo(358, 190)
      c.stroke(tick, 48, '#FFFFFF')
    },
  },
  {
    pack: 'essentials',
    id: 'cross',
    width: 512,
    height: 512,
    draw(c) {
      dieCut(c, circle(256, 256, 210), '#EF4444')
      c.stroke(new Path().moveTo(180, 180).lineTo(332, 332), 48, '#FFFFFF')
      c.stroke(new Path().moveTo(332, 180).lineTo(180, 332), 48, '#FFFFFF')
    },
  },
  {
    pack: 'essentials',
    id: 'speech-bubble',
    width: 512,
    height: 448,
    draw(c) {
      outlined(c, [
        roundRect(40, 40, 432, 280, 90),
        polygon([
          [130, 290],
          [110, 410],
          [230, 300],
        ]),
      ])
    },
  },
  {
    pack: 'essentials',
    id: 'thought-bubble',
    width: 512,
    height: 448,
    draw(c) {
      const puffs = [
        [150, 170, 95],
        [250, 120, 105],
        [360, 160, 95],
        [330, 240, 90],
        [200, 250, 90],
        [130, 345, 32],
        [85, 405, 20],
      ]
      outlined(c, [...puffs.map(([x, y, r]) => circle(x, y, r)), roundRect(130, 130, 260, 150, 60)])
    },
  },
  {
    pack: 'essentials',
    id: 'location-pin',
    width: 384,
    height: 512,
    draw(c) {
      const pin = new Path()
        .moveTo(192, 470)
        .cubicTo(120, 370, 52, 300, 52, 200)
        .arc(192, 200, 140, 140, 180, 360, 64)
        .cubicTo(332, 300, 264, 370, 192, 470)
        .close()
      dieCut(c, pin, {
        linear: [0, 60, 0, 470],
        stops: [
          [0, '#FF5A5F'],
          [1, '#D7263D'],
        ],
      })
      c.fill(circle(192, 200, 58), '#FFFFFF')
    },
  },

  /* -------- trending-2026-11: badges, reactions, y2k */
  {
    pack: 'trending-2026-11',
    id: 'follow-pill',
    width: 640,
    height: 224,
    draw(c) {
      dieCut(c, roundRect(30, 30, 580, 160, 80), {
        linear: [30, 0, 610, 0],
        stops: [
          [0, '#FF3D8B'],
          [1, '#FF8A3D'],
        ],
      })
      c.stroke(new Path().moveTo(110, 110).lineTo(170, 110), 18, '#FFFFFF')
      c.stroke(new Path().moveTo(140, 80).lineTo(140, 140), 18, '#FFFFFF')
      drawText(c, 'FOLLOW', {
        cx: 375,
        cy: 110,
        size: 70,
        weight: 17,
        maxWidth: 330,
        color: '#FFFFFF',
      })
    },
  },
  {
    pack: 'trending-2026-11',
    id: 'subscribe-pill',
    width: 768,
    height: 224,
    draw(c) {
      dieCut(c, roundRect(30, 30, 708, 160, 80), {
        linear: [30, 0, 738, 0],
        stops: [
          [0, '#FF4B2B'],
          [1, '#E0123A'],
        ],
      })
      const bell = new Path()
        .moveTo(92, 140)
        .lineTo(102, 124)
        .lineTo(102, 98)
        .arc(130, 98, 28, 30, 180, 360, 24)
        .lineTo(158, 124)
        .lineTo(168, 140)
        .close()
      c.fill(bell, '#FFFFFF')
      c.fill(circle(130, 150, 10), '#FFFFFF')
      drawText(c, 'SUBSCRIBE', {
        cx: 445,
        cy: 110,
        size: 66,
        weight: 16,
        maxWidth: 480,
        color: '#FFFFFF',
      })
    },
  },
  {
    pack: 'trending-2026-11',
    id: 'like-pill',
    width: 512,
    height: 224,
    draw(c) {
      dieCut(c, roundRect(30, 30, 452, 160, 80), '#FFFFFF', { border: 10 })
      c.stroke(roundRect(30, 30, 452, 160, 80), 6, '#E5E5EA')
      c.fill(heart(130, 112, 46), '#FF2D55')
      drawText(c, 'LIKE', {
        cx: 310,
        cy: 110,
        size: 72,
        weight: 18,
        maxWidth: 250,
        color: '#1C1C1E',
      })
    },
  },
  {
    pack: 'trending-2026-11',
    id: 'new-burst',
    width: 512,
    height: 512,
    draw(c) {
      dieCut(c, star(256, 256, 236, 196, 18), {
        radial: [256, 256, 236],
        stops: [
          [0, '#FFF36B'],
          [1, '#FFC400'],
        ],
      })
      drawText(c, 'NEW', {
        cx: 256,
        cy: 256,
        size: 120,
        weight: 30,
        maxWidth: 300,
        color: '#E0123A',
      })
    },
  },
  {
    pack: 'trending-2026-11',
    id: 'wow-burst',
    width: 512,
    height: 512,
    draw(c) {
      const rand = rng(42)
      const pts = []
      for (let i = 0; i < 26; i++) {
        const r = i % 2 === 0 ? 220 + rand() * 25 : 130 + rand() * 30
        const a = ((i * 360) / 26 - 90) * (Math.PI / 180)
        pts.push([256 + r * Math.cos(a), 256 + r * Math.sin(a) * 0.85])
      }
      const burst = polygon(pts)
      const fill = fillMask(c.w, c.h, burst)
      const outline = unionMask(fill, strokeMask(c.w, c.h, burst, 24))
      c.shadow(outline, { dy: 8, blur: 12, color: '#00000066' })
      c.composite(outline, '#111111')
      c.composite(fill, {
        radial: [256, 256, 240],
        stops: [
          [0, '#FFE14D'],
          [1, '#FF7A00'],
        ],
      })
      drawText(c, 'WOW!', {
        cx: 256,
        cy: 256,
        size: 120,
        weight: 30,
        maxWidth: 300,
        color: '#FFFFFF',
        outline: 12,
        outlineColor: '#111111',
      })
    },
  },
  {
    pack: 'trending-2026-11',
    id: 'face-smile',
    width: 512,
    height: 512,
    draw(c) {
      face(c, 256, 256, 210)
      c.fill(ellipse(185, 210, 26, 38), DARK)
      c.fill(ellipse(327, 210, 26, 38), DARK)
      c.stroke(new Path().arc(256, 270, 120, 95, 20, 160, 40), 26, DARK)
      c.fill(ellipse(150, 300, 34, 20), '#FF7A7A', 0.45)
      c.fill(ellipse(362, 300, 34, 20), '#FF7A7A', 0.45)
    },
  },
  {
    pack: 'trending-2026-11',
    id: 'face-heart-eyes',
    width: 512,
    height: 512,
    draw(c) {
      face(c, 256, 256, 210)
      c.fill(heart(180, 205, 56), '#FF2D55')
      c.fill(heart(332, 205, 56), '#FF2D55')
      const mouth = new Path()
        .moveTo(160, 300)
        .quadTo(256, 330, 352, 300)
        .quadTo(256, 430, 160, 300)
        .close()
      c.fill(mouth, DARK)
    },
  },
  {
    pack: 'trending-2026-11',
    id: 'face-laugh-tears',
    width: 512,
    height: 512,
    draw(c) {
      face(c, 256, 256, 210)
      c.stroke(new Path().moveTo(150, 215).lineTo(200, 185).lineTo(225, 225), 22, DARK)
      c.stroke(new Path().moveTo(362, 215).lineTo(312, 185).lineTo(287, 225), 22, DARK)
      const mouth = new Path()
        .moveTo(140, 280)
        .quadTo(256, 300, 372, 280)
        .quadTo(360, 420, 256, 420)
        .quadTo(152, 420, 140, 280)
        .close()
      c.fill(mouth, DARK)
      c.fill(
        new Path().moveTo(200, 382).quadTo(256, 350, 312, 382).quadTo(256, 425, 200, 382).close(),
        '#FF6B81',
      )
      for (const s of [-1, 1]) {
        const x = 256 + s * 200
        const drop = new Path()
          .moveTo(x - s * 40, 220)
          .quadTo(x + s * 30, 260, x + s * 26, 300)
          .arc(x, 300, 26 * s, 30, 0, 180, 24)
          .close()
        dieCut(c, drop, '#4FC3F7', { border: 8, shadow: false })
      }
    },
  },
  {
    pack: 'trending-2026-11',
    id: 'fire',
    width: 448,
    height: 512,
    draw(c) {
      const outer = new Path()
        .moveTo(224, 480)
        .cubicTo(90, 480, 40, 380, 60, 290)
        .cubicTo(80, 200, 150, 180, 150, 90)
        .cubicTo(230, 140, 250, 210, 240, 250)
        .cubicTo(280, 220, 290, 160, 280, 120)
        .cubicTo(370, 190, 410, 290, 390, 360)
        .cubicTo(375, 440, 310, 480, 224, 480)
        .close()
      dieCut(c, outer, {
        linear: [0, 480, 0, 90],
        stops: [
          [0, '#FF3D00'],
          [0.6, '#FF7A00'],
          [1, '#FFB000'],
        ],
      })
      const inner = new Path()
        .moveTo(224, 470)
        .cubicTo(160, 470, 135, 420, 150, 370)
        .cubicTo(165, 320, 205, 310, 210, 260)
        .cubicTo(260, 300, 300, 350, 298, 400)
        .cubicTo(296, 445, 270, 470, 224, 470)
        .close()
      c.fill(inner, {
        linear: [0, 470, 0, 260],
        stops: [
          [0, '#FFF59D'],
          [1, '#FFC107'],
        ],
      })
    },
  },
  {
    pack: 'trending-2026-11',
    id: 'hundred',
    width: 512,
    height: 384,
    draw(c) {
      drawText(c, '100', {
        cx: 256,
        cy: 170,
        size: 200,
        weight: 34,
        maxWidth: 440,
        color: '#FF1744',
        outline: 10,
        outlineColor: '#FFFFFF',
      })
      for (const [y, w] of [
        [300, 380],
        [338, 300],
      ]) {
        const p = new Path().moveTo(256 - w / 2, y).quadTo(256, y - 14, 256 + w / 2, y - 4)
        c.composite(strokeMask(c.w, c.h, p, 40), '#FFFFFF')
        c.composite(strokeMask(c.w, c.h, p, 22), '#FF1744')
      }
    },
  },
  {
    pack: 'trending-2026-11',
    id: 'y2k-star',
    width: 512,
    height: 512,
    draw(c) {
      const big = sparkle(256, 256, 230, 0.12)
      const m = fillMask(c.w, c.h, big)
      c.composite(blurMask(m, c.w, c.h, 30), '#B388FF99')
      c.composite(m, {
        linear: [100, 60, 420, 460],
        stops: [
          [0, '#FFFFFF'],
          [0.3, '#C8D3FF'],
          [0.5, '#8E7CFF'],
          [0.7, '#E7E9FF'],
          [1, '#7AA7FF'],
        ],
      })
      c.fill(sparkle(390, 120, 60, 0.15), '#FFFFFF')
    },
  },
  {
    pack: 'trending-2026-11',
    id: 'notification-badge',
    width: 384,
    height: 384,
    draw(c) {
      dieCut(
        c,
        circle(192, 192, 150),
        {
          radial: [150, 140, 220],
          stops: [
            [0, '#FF5A5F'],
            [1, '#E0002A'],
          ],
        },
        { border: 16 },
      )
      drawText(c, '1', { cx: 192, cy: 192, size: 150, weight: 34, color: '#FFFFFF' })
    },
  },
  {
    pack: 'trending-2026-11',
    id: 'swipe-up',
    width: 384,
    height: 512,
    draw(c) {
      ;[0, 1, 2].forEach((i) => {
        const y = 150 + i * 110
        const chevron = new Path()
          .moveTo(92, y + 70)
          .lineTo(192, y - 20)
          .lineTo(292, y + 70)
        const m = strokeMask(c.w, c.h, chevron, 40)
        c.composite(blurMask(m, c.w, c.h, 10), '#00000055')
        c.composite(m, '#FFFFFF', 1 - i * 0.3)
      })
    },
  },
  {
    pack: 'trending-2026-11',
    id: 'typing-bubble',
    width: 512,
    height: 320,
    draw(c) {
      const body = roundRect(40, 40, 432, 200, 100)
      const tail = new Path().add(circle(70, 250, 26)).add(circle(40, 290, 14))
      const fill = unionMask(fillMask(c.w, c.h, body), fillMask(c.w, c.h, tail))
      c.shadow(fill, { dy: 6, blur: 12, color: '#00000059' })
      c.composite(fill, '#E9E9EB')
      for (const [i, x] of [176, 256, 336].entries())
        c.fill(circle(x, 140, 30), '#8E8E93', 1 - i * 0.25)
    },
  },
]

/** Render one recipe to PNG bytes. */
export function renderSticker(recipe) {
  const c = new Canvas(recipe.width, recipe.height)
  recipe.draw(c)
  return c.toPNG()
}
