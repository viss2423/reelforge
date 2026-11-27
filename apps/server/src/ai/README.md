# Local AI jobs

All AI runs on the host (CPU / iGPU). `index.ts` exports `aiJobs`, which the job queue
registers.

| kind       | resource | result                                   | cached on asset      |
| ---------- | -------- | ---------------------------------------- | -------------------- |
| transcribe | ai       | `{ words, language, model, backend, … }` | `transcript`         |
| silence    | cpu      | `{ ranges, thresholdDb, … }`             | no                   |
| beats      | cpu      | `{ bpm, beats, downbeats, engine }`      | `beats`, `downbeats` |
| scenes     | cpu      | `{ scenes }`                             | `scenes`             |
| reframe    | ai       | `{ path, subjects, mode, … }`            | no                   |
| matte      | ai       | `{ model, provider, frames, fps… }`      | `matte`              |
| highlights | ai       | `{ variants[{ moments[] }], ranker }`    | no                   |
| copywriter | ai       | `{ hooks, caption, hashtags }`           | no                   |
| emphasis   | ai       | `{ marks, chapters }`                    | no                   |

The last three are the local language model (see [llm/README.md](llm/README.md)).

Tools and models come from `pnpm bootstrap` (`scripts/setup.mjs`) and live in the data dir
(`REELFORGE_DATA`, default `~/.reelforge`): `bin/whisper/whisper-cli(.exe)`,
`models/whisper/ggml-*.bin`, `models/face/yunet.onnx`, `models/rnnoise/*.rnnn`,
`models/beats/*` (Beat This! + mel filterbank), `models/objects/dfine_s_coco.onnx`,
`models/saliency/u2netp.onnx` (see `scripts/lib/ai-models.ts`), `models/matte/modnet.onnx`.
The `matte` job (AI background removal, text behind subject) is documented, with its
benchmark, in [matte/README.md](matte/README.md).

## Backend choices and benchmarks

Measured on the reference host: ThinkPad T15, Ryzen 7 PRO 8840U (8C/16T), Radeon 780M,
16 GB, Windows 11, FFmpeg 9.0.2 (Gyan full build), whisper.cpp v1.9.5,
onnxruntime-node 1.31. RTF = processing time / media duration (lower is faster).

### Transcription

Speech is a 59 s SAPI TTS sample whose ground-truth word onsets are known.

| backend                                                     | wall time | RTF   | onset MAE |
| ----------------------------------------------------------- | --------- | ----- | --------- |
| whisper-cli, `base`, DTW timing (CPU)                       | 12 s      | 0.20  | 39–46 ms  |
| whisper-cli, `large-v3-turbo-q5_0`, DTW timing (CPU)        | 144 s     | 2.44  | —         |
| FFmpeg `whisper` filter, `large-v3-turbo-q5_0`, Vulkan iGPU | 14 s      | 0.24  | no words  |
| FFmpeg `whisper` filter, `large-v3-turbo-q5_0`, CPU         | 25 s      | 0.42  | no words  |
| **hybrid** (default): FFmpeg GPU turbo text + cli base DTW  | 20 s      | 0.335 | 46 ms     |

- **whisper.cpp build**: upstream publishes no Windows Vulkan binary, and building one is
  out of scope for the bootstrap, so Windows x64 installs the plain CPU build (AVX2/AVX-512
  ggml kernels with runtime CPU dispatch). It beat the OpenBLAS build because whisper's
  decoder runs small-batch matmuls where BLAS dispatch overhead dominates. A Vulkan or CUDA
  asset is chosen automatically when available (`scripts/lib/whisper.ts`).
- **FFmpeg 9's `whisper` filter** links whisper.cpp with Vulkan offload, so the large model
  runs about 10× faster than whisper-cli on the CPU. It only emits segment text, though, not
  per-token timestamps or probabilities, so on its own it cannot give word timing.
- **Hybrid (default when the filter is present)** runs both at once: large-v3-turbo on the
  iGPU through FFmpeg for the text, and `base` in whisper-cli on the CPU with DTW for word
  timing. `align.ts` aligns the two transcripts with a semi-global edit-distance DP per text
  segment, run over a monotonic window so the cost stays linear in transcript length. Words
  only the large model heard get timings interpolated by character length, with lower
  confidence; agreement between the two models is the confidence signal. `refine.ts` then
  snaps word starts to onsets in the 10 ms level envelope measured during the single decode
  (start MAE drops from 220 ms with raw DTW to about 45 ms), and drops hallucinated words
  that fall in silence. The result has large-model accuracy at roughly base-model speed.
- `backend: 'cli'` (or requesting the small model directly) runs a single whisper-cli pass.
- On short clips (≈10 s) the RTF rises to 0.5–0.9 because model load dominates.

### Other jobs

| job                  | measurement                                                    |
| -------------------- | -------------------------------------------------------------- |
| beats (DSP fallback) | 3-min 44.1 kHz track: 0.8-1.1 s end-to-end                     |
| reframe              | 37.6 analysed frames/s at 5 fps × 320 px (≈7.5× realtime), CPU |
| FFT                  | 2048-point real FFT ≈ 0.1 ms                                   |

- **beats**: FFmpeg decodes to 22.05 kHz mono float32 over a pipe. The chunks go straight
  to a worker thread (STFT with Hann window and hop 512, log spectral flux, autocorrelation
  tempo with a log-Gaussian prior at 120 BPM, Ellis DP beat tracking, downbeat phase), so
  decoding and DSP overlap and the event loop is never blocked.
- **reframe / YuNet execution provider**: YuNet is tiny (~75 k parameters). CPU takes
  2.1 ms per 320×180 frame (4.6 ms at 320×568). DirectML takes 4.3 ms and 28.8 ms, because
  upload and dispatch cost more than the GPU saves, and its session starts in 380 ms against
  140 ms for CPU. `auto` therefore selects CPU, and `provider: 'dml'` stays available for
  weak CPUs. Frames stream as raw video from FFmpeg (D3D11VA decode with a portable
  fallback, rotation honoured) with backpressure, so memory stays flat on long videos.
- **scenes**: `scdet` on a 320 px hardware-decoded downscale, with cuts closer than 250 ms
  merged.
- **silence**: the threshold is max(-50 dB, speech level − 25 dB). The speech level is
  the 80th percentile of gated 10 ms RMS levels from the same decode, and ranges are padded by
  100 ms on each side.

## Neural beat tracking (`beats`)

**Default engine: Beat This! small** (Foscarin, Schlüter & Widmer, ISMIR 2024; 2.1 M
parameters, 4.9 MB ONNX; weights and code MIT, JKU Linz), with the DSP tracker (spectral flux
\+ Ellis DP, see above) as the fallback when the model is not installed or `engine: 'dsp'` is
requested. Beat This! needs no DBN post-processing: the network emits per-frame beat and
downbeat logits at 50 fps, we pick peaks (`neural.ts`).

- **Front end** (`mel.ts`, in the beat worker, overlapping decode): 22.05 kHz mono (channels
  averaged with `pan`, not FFmpeg's √2 louder `-ac 1`), STFT 1024/441 centred, magnitude/√1024,
  torchaudio's 128-band mel filterbank, `log1p(1000·x)`. Verified against the reference
  `mel_spectrogram.onnx` (max error 2.2e-5 on log-mel values).
- **Windows**: 30 s (1500 frames) with 6 frames of border and `keep_first` aggregation, exactly
  like the reference `split_piece`; two windows run concurrently.
- **Result** also carries `downbeats` (bar starts) and `engine`; both beats and downbeats are
  cached on the asset. Sync options in the AI panel: cut on the beat, every 2 beats, every bar
  or every 2 bars (`syncToBeats({ unit, every, downbeats })`).
- **Sessions** come from the shared pool (`../onnx.ts`): loaded lazily, released 60 s after the
  last use.

### Candidates and benchmark

Synthetic music with exact ground truth (8 styles x 60 s: four-on-the-floor, swung hip-hop,
174 BPM drum & bass, piano without drums, 3/4 waltz, humanised funk with a tempo ramp
100 → 116, noisy reggaeton, loud off-beat hi-hats; `test/ai/music-synth.ts`), F-measure within
±70 ms (first 5 s ignored, mir_eval convention). Host: ThinkPad T15 (Ryzen 7 PRO 8840U),
onnxruntime-node 1.31, **CPU provider**.

| engine                          | beat F | downbeat F | BPM within 4 % | model size |
| ------------------------------- | ------ | ---------- | -------------- | ---------- |
| DSP (previous default)          | 0.622  | 0.287      | 5/8            | none       |
| Beat This! small0 (**default**) | 0.916  | 0.942      | 6/8            | 4.9 MB     |
| Beat This! final0               | 0.932  | 0.898      | 6/8            | 83–190 MB  |

(The two BPM misses of both neural models are the 3/4 waltz, reported at half tempo although
beat F is 0.5-0.6 there, and the tempo-ramp track, whose mean tempo (108) differs from the
starting tempo (100) the check uses.)

Real music: nine Kevin MacLeod tracks from incompetech.com (CC BY 4.0; BPM from his published
catalogue), 2.5–3.5 minutes each, tempo error within 4 %:

| track (published BPM)             | DSP   | small0 | final0 |
| --------------------------------- | ----- | ------ | ------ |
| Carefree (96)                     | 96.1  | 96.0   | 96.0   |
| Fluffing a Duck (122)             | 61.1  | 121.9  | 122.0  |
| Funkorama (101)                   | 50.6  | 101.0  | 101.0  |
| Investigations (94)               | 94.8  | 95.1   | 94.9   |
| Local Forecast – Elevator (82)    | 109.8 | 82.0   | 82.0   |
| Monkeys Spinning Monkeys (144)    | 143.9 | 273.2  | 144.0  |
| Pixel Peeker Polka – faster (144) | 72.5  | 145.8  | 145.0  |
| Sneaky Snitch (87)                | 87.0  | 87.0   | 87.0   |
| Wallpaper (92)                    | 93.0  | 93.0   | 93.0   |
| **within 4 %**                    | 5/9   | 8/9    | 9/9    |

Speed on this host (FFmpeg decode + log-mel + inference, end to end; the machine was shared
with other builds, so these are conservative): 3-minute tracks take 3.6-7 s with small0 and
7-12 s with final0, against 0.8-1.1 s for DSP when idle. The neural engine is therefore ~5×
slower than DSP but 8× faster than real time and runs once per asset (cached). It is the
default because it fixes the DSP tracker's half/double-tempo and off-beat failures (beat F
0.62 → 0.92) and finds bar starts.

- **Why small0**: final0 is 0.016 better in beat F and more robust on real music (one
  double-tempo slip for small0) but twice as slow and 17-40× larger. `findBeatModel(paths,
name)` accepts another file name in `models/beats/`.
- **DirectML**: 3-4× slower than the CPU provider on this 780M (transformer attention over
  1500 frames dispatches poorly), so the neural beats stay on CPU. The Ryzen AI NPU was not
  evaluated (onnxruntime-node does not bundle the VitisAI provider).
- **Other candidates**: madmom's RNN+DBN needs Python/Cython (not runnable via ONNX without a
  custom DBN); Beat This! `final0` 190 MB static graph is the WebGPU export.

## Smarter auto-reframe (`reframe`)

Two modes, `smart` (default when the models are installed) and `fast` (the original YuNet-only
path, always the fallback):

| stage           | model / method                                                                | license    |
| --------------- | ----------------------------------------------------------------------------- | ---------- |
| people, objects | **D-FINE small** (COCO, 480 px input), onnxruntime CPU                        | Apache-2.0 |
| faces           | YuNet (kept; 8 ms per 640x268 frame)                                          | MIT        |
| no subject      | U²-Netp saliency map → salient region                                         | Apache-2.0 |
| speaker         | mouth-region change minus eye-region change (YuNet landmarks) x speech energy | —          |

`planner.ts` selects the subject: people (large, central, persistent, boosted while speaking),
else a salient COCO object (animals, vehicles, balls), else the saliency centre, else the
centre. Several significant people are all kept in frame by widening the visible area (the
clip scales down to ≥ 50 % at most 1.4x the crop, the blurred background fills the rest); when
they do not fit, the camera follows the active speaker. Shots (cached `scenes`) are planned
independently with hard cuts. The camera is unchanged (dead zone + zero-phase critically damped
spring); `strength` (0 calm ... 1 tight, default 0.5 = the old tuning) scales dead zone, spring
speed and subject-switch hysteresis. The AI panel offers Calm / Balanced / Tight.

### Detector benchmark

Real footage: Tears of Steel (Blender Foundation, CC BY 3.0) 3 min 720p + Sintel trailer
(CC BY 3.0), 116 frames sampled at 0.5 fps. Reference ("pseudo ground truth") for person boxes
is D-FINE small at 640 px, score ≥ 0.5, 148 boxes. "Primary found" is the share of frames whose
largest reference person is detected (IoU > 0.5). Timings: single frame, onnxruntime CPU, 4
threads, host shared with other builds (idle numbers are ~1.5-2x lower).

| detector                   | input | recall | precision | primary found | ms / frame |
| -------------------------- | ----- | ------ | --------- | ------------- | ---------- |
| D-FINE nano, thr 0.3       | 640   | 0.53   | 0.92      | 0.49          | 210        |
| D-FINE nano, thr 0.2       | 640   | 1.45   | 0.70      | 0.80          | 280        |
| **D-FINE small, thr 0.4**  | 480   | 0.93   | 0.82      | **0.92**      | 350        |
| D-FINE small, thr 0.4      | 416   | 0.82   | 0.78      | 0.81          | 294        |
| D-FINE small int8, thr 0.4 | 640   | 0.98   | 0.86      | 0.96          | 4474       |
| DEIMv2 pico                | 640   | —      | —         | —             | 100-600    |
| YuNet (faces only)         | 640   | —      | —         | —             | 8.5        |

Nano misses too many people on cinematic footage; int8 (QDQ) is >10x slower on this CPU; DEIMv2
pico exports with unusable class labels (`class_N`) and unstable timings. D-FINE small at 480 px
is the best trade-off. RT-DETRv4 and DEIMv2-S were considered but not benchmarked (no ready-made COCO ONNX export
with a clear license was found); YOLO-family weights are AGPL and excluded.

End to end on a 60 s clip of Tears of Steel: fast mode 5.7 s
(10x realtime, faces found in 17 % of samples); smart mode 96 s on the shared host (0.6x
realtime at 3 fps; 1.9 analysed frames/s), subject found in 50 % of samples, 15 group-framed
samples, 78 centred (shots without a subject). Smart mode is therefore a deliberate "analyse
once, ~1x realtime" job; use `mode: 'fast'` for a quick pass.
