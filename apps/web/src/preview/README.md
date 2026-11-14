# Preview engine

Real-time, frame-accurate preview of a `Project` in the browser, built to match the FFmpeg
export as closely as possible. The editor depends only on `index.ts`
(`createPreviewEngine(canvas, opts)`); everything else is internal.

```
rAF frame ──► PlaybackClock.tick (audio-mastered) ──► TimelineIndex.resolve(t)
          ──► SourcePool.update (visible + look-ahead) ──► source.frame(srcT)
          ──► Compositor (WebGL2: layers → transition → present)
          ──► TextLayer.render(t) (JASSUB worker, own canvas)
          ──► AudioEngine.schedule(t) (WebAudio, 1 s look-ahead)
          ──► AdaptiveQuality.record(cost)
```

While paused the loop runs only until every visible layer shows its exact frame, so an idle
editor costs nothing.

## Decision: decoding path

**WebCodecs `VideoDecoder` + our own MP4 demuxer (`media/mp4.ts`), `<video>` fallback.**

| Requirement                 | WebCodecs + demuxer                                                        | `<video>` element                                                        |
| --------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Frame-exact scrub / step    | yes: feed from the previous keyframe (≤ 14 frames, GOP 15), show exact cts | no: `currentTime` lands on "a" frame, presentation is asynchronous       |
| Deterministic playback      | frames decoded ahead of the clock, shown when due                          | element runs its own clock; slaved by `playbackRate` nudges and re-seeks |
| Two clips in a transition   | two decoders, each addressed independently                                 | two elements, both drifting                                              |
| Memory on phones            | ≤ 8 frames held per decoder, closed eagerly                                | browser-controlled                                                       |
| iOS Safari / Android Chrome | `VideoDecoder` (H.264) in Safari ≥ 16.4 and every Chromium; HW accelerated | everywhere                                                               |

The demuxer is tiny because our proxies are known (server proxy job: H.264 High, GOP 15, no
B-frames, AAC, `+faststart`, ≤ 960 px): opening a file reads `moov` with one range request
(~50 KB for minutes of video), sample bytes are read lazily with coalesced HTTP Range
requests, and the audio track is read separately from the same index (no interleaved video
bytes). It still handles `ctts` (B-frames), edit lists, rotation matrices and HEVC/AV1/VP9
sample descriptions for originals played without a proxy. mp4box.js was rejected: ~10× the
code, it is fed by appended buffers instead of random access, and it allocates an object per
sample (a 3-minute proxy has ~5 400 video samples; ours are typed arrays).

The decode policy (`media/decodePlan.ts`, pure and unit-tested) decides per request whether to
continue the current run, wait for frames already in flight, or reset at a keyframe, so
scrubbing never thrashes the decoder.

**Why not a Worker for demux/decode:** `VideoDecoder` already decodes off-thread (GPU/media
process); the JS on the main thread only slices bytes and enqueues chunks (~20 µs per frame).
A worker would add a `VideoFrame` transfer per frame plus a second copy of the sample tables
for no measured gain. Audio is decoded by `decodeAudioData` (off-thread), LUTs are parsed
once per ref, text renders in JASSUB's worker.

The `<video>` fallback (`media/element.ts`) is used when WebCodecs is missing or rejects the
codec. It tracks the frame actually presented via `requestVideoFrameCallback`, so "exact"
means the right pixels are on the texture.

## Clock & scheduling

- `clock.ts` — the AudioContext **output** time (`getOutputTimestamp`, latency-corrected) is
  the master while playing. The picture is predicted from the rAF clock and slewed towards
  the master (12 % of the error per frame, snap above 80 ms), so coarse audio-clock updates
  never stutter motion and the output never runs backwards. After start/seek the picture
  holds the start frame until that audio is actually audible, then locks on.
- Play and seek-while-playing start the clock only once the frame at the current time is
  composited exactly; starving during playback for 8 frames emits `'waiting'` and holds
  picture and sound together until every layer is ready again.
- `media/pool.ts` — one pixel source per visible-or-upcoming clip (keyed per clip, so a
  transition between two pieces of the same file gets two decoders). Look-ahead: 1 s while
  playing, 0.3 s paused. Decoder cap: 8 (4 on ≤ 4 GB / coarse-pointer devices; 4/2 for
  `<video>`), 1.5 s grace before an unneeded source closes so scrubbing across a cut is free.
- `timeline/layout.ts` + `timeline/resolve.ts` — main-track layout with transition overlap
  (total = Σ durations − Σ transition durations, as xfade produces) and an allocation-free
  "what is visible at t" index (O(tracks · log clips)).

## Compositor (WebGL2)

`gl/compositor.ts` describes a frame as `begin → layer(...)* → [transition] → present`. Source
textures are re-uploaded only when a source's frame version changes; render targets are pooled;
uniforms come from caller-owned typed arrays (zero allocations per frame).

- Layer shader: fit cover/contain/fill, crop, transform (x, y, scale, rotation, opacity, flips;
  keyframes via core's `evaluate`), colour adjustments, 3D LUT (`sampler3D` via `texelFetch`
  with tetrahedral interpolation = `lut3d` default, intensity mix), chroma key (FFmpeg
  `chromakey` YUV distance), blend modes, effect outputs.
- Background colour + blurred fill (dual-filter Kawase blur, `gl/blur.ts`: σ = 40 px costs about
  one full-resolution copy; the levels/offset → σ table is measured with a CPU twin).
- Transitions (`gl/transitions.ts`): the 24 xfade types are ports of `vf_xfade.c`; whip, flash,
  glitch and spin are defined here in a form expressible as xfade `custom` expressions.
- Context loss: `webglcontextlost` drops all GL objects; `webglcontextrestored` rebuilds them and
  re-renders.

**Correctness chain FFmpeg ≈ CPU reference ≈ GLSL:** every colour/transition formula has a CPU
twin. Unit tests compare the CPU twins with real FFmpeg output (the export's lutyuv curves,
vignette, lut3d, every xfade type); chroma key and blend twins follow
`vf_chromakey.c` and the W3C definitions. `gl/gpu.test.ts` runs `dev/gpucheck.html` in
Chromium to compare the shipped GLSL with the CPU twins pixel by pixel.

### Colour adjustments

The export folds every tonal/colour slider into one `lutyuv` (per-plane 8-bit curves defined in
`packages/core/src/compile/adjustments.ts`). The preview evaluates core's `lumaCurve` /
`chromaCurve` into a 256×1 texture and the shader looks up each pixel's integer BT.709 code
values in it, so preview and export apply the same table. Spatial sliders (sharpen, blur,
vignette, grain) use core's `ADJUSTMENT_MAPPING`. Export order: `lutyuv → unsharp → gblur →
vignette → noise → lut3d(+mix)`; the single-pass shader sharpens from the source
neighbourhood before the curve lookup.

### Effects

Closed-form functions of `t` = seconds since the effect window started and `I` = intensity, so
the render compiler can write the same expressions as FFmpeg filter expressions. Parameters
(defaults) can be overridden by the preset's `params`.

| Effect      | Params (default)                                         | Formula                                                               |
| ----------- | -------------------------------------------------------- | --------------------------------------------------------------------- |
| `shake`     | amplitude 24 px, frequency 12 Hz                         | dx = A(0.6 sin 2πft + 0.4 sin(2π·1.7ft + 1.3)); dy likewise (1.3/2.1) |
| `zoomPulse` | amount 0.08, frequency 2 Hz                              | scale ×= 1 + a(½ − ½ cos 2πft)                                        |
| `beatZoom`  | bpm 120, amount 0.1, decay 8 /s                          | scale ×= 1 + a·e^(−k·(t mod 60/bpm))                                  |
| `rgbSplit`  | amount 12 px                                             | red +amount, blue −amount (horizontal)                                |
| `flash`     | fade 0.3 s                                               | white = I·max(0, 1 − t/fade)                                          |
| `strobe`    | frequency 8 Hz, mix 0.7                                  | white = mix·I while ⌊2ft⌋ is even                                     |
| `blurIn`    | duration 0.5 s, sigma 30 px                              | σ = sigma·I·max(0, 1 − t/duration)                                    |
| `vhs`       | offset 4 px, scanlines 0.15, noise 0.08, desaturate 0.25 | rgbSplit + scanline darkening + noise + desaturation                  |
| `glow`      | sigma 12 px, strength 0.6                                | additive blurred copy                                                 |
| `filmGrain` | amount 0.12                                              | luma noise amplitude                                                  |

Translations add, scales multiply, white mixes take the max.

## Text & captions

`text/textLayer.ts`: JASSUB (libass → WASM) renders the same `.ass` the export burns in, in its
own worker onto an OffscreenCanvas stacked over the WebGL canvas (PlayRes 1080×1920 scaled to
the canvas). The `.ass` is generated in the browser with core's `buildAss`, debounced 50 ms
after text/caption edits; only the font families the document uses are loaded, before it is
shown. Rendering follows the engine clock every frame.

## Audio

`audio/*`: per clip voice → GainNode (volume, fades, transition crossfades, ducking) → master →
DynamicsCompressor limiter. Proxy AAC is fetched per 10 s segment (audio samples only), wrapped
as ADTS and decoded with `decodeAudioData` into an LRU (128 MB, 48 MB on small devices).
Pieces are scheduled 1 s ahead on the AudioContext timeline. Speed uses `playbackRate`
(pitch shifts — WebAudio has no time-stretch; the export uses rubberband). Ducking reacts to
clip presence (the export reacts to speech level). iOS: the context is resumed on the first
user gesture.

## Quality & performance

- `quality.ts` — `'high'` = device resolution capped at 1080×1920, `'low'` = 540 wide, `'auto'`
  steps through 100/85/70/55/42 % when frame cost exceeds the budget and back up after
  sustained headroom (hysteresis). `prefers-reduced-motion` only affects editor UI, never the
  preview content.
- GPU memory: images downscaled to ≤ 2304 px, LUTs and blur targets pooled with LRU, decoded
  frames capped per decoder; `stats.gpuBytes` reports the total.
- Stats: `engine.stats` and `window.__rfPreviewStats` (Playwright hook).

### Measured (dev harness, `dev/measure.ts`, headless Chromium 156, Radeon 780M / D3D11, 1280×900 viewport, DPR 1)

Demo project: 12.5 s, 4 main clips with transitions, chroma-keyed and blended overlays,
blurred fill, LUT, effects, text, music. Host under load from parallel builds.

| Metric                              | WebCodecs      | `<video>` fallback      |
| ----------------------------------- | -------------- | ----------------------- |
| first frame                         | 3–30 ms        | ~650 ms                 |
| random seek (settled exact) p50/p95 | 65 / 140 ms    | 30 / 170 ms (not exact) |
| frame step p50/p95                  | 3 / 70 ms      | 31 / 39 ms              |
| playback fps / rAF p99              | 60.0 / 16.8 ms | 60.0 / 16.8 ms          |
| inexact frames during playback      | 0 / 760        | 16 / 776                |
| 'waiting' stalls                    | 0              | 2 (clip boundaries)     |
| A/V clock drift (max)               | 0.8 ms         | stall-induced           |
| compose CPU per frame (EMA)         | 0.6 ms         | 0.7 ms                  |
| GPU memory                          | 11 MB          | 9 MB                    |
| snapshot (PNG)                      | 23–130 ms      |                         |

## Dev harness

```
node src/preview/dev/fixtures.ts                                         # demo media → dev/.media (lavfi)
pnpm --filter @reelforge/web exec vite --config src/preview/dev/vite.config.ts
node src/preview/dev/measure.ts [--decoder=element] [--headed] [--out=dir]  # from apps/web
```

The harness loads the demo project, picked local proxy files or a project JSON, and shows an
FPS/decode stats overlay. `dev/gpucheck.html` shows the GPU self-check.

## Tests

Part of `pnpm --filter @reelforge/web test` (the `preview` Vitest project; alone:
`pnpm exec vitest run --project preview` from `apps/web`). FFmpeg tests generate lavfi
fixtures in a temp dir; the GPU test needs Playwright's Chromium
(`pnpm dlx playwright install chromium`) and is skipped with a message otherwise. Tests run
against the real core.

## Known differences from the export

- The trend transitions (whip, flash, glitch, spin) and the effects are closed-form GLSL
  approximations of the export's FFmpeg chains (`packages/core/src/compile/transitions.ts`,
  `visual.ts`); timing matches, pixel parity does not.
