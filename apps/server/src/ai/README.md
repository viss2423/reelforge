# Local AI jobs

All AI runs on the host (CPU / iGPU). `index.ts` exports `aiJobs`, which the job queue
registers.

| kind       | resource | result                                   | cached on asset |
| ---------- | -------- | ---------------------------------------- | --------------- |
| transcribe | ai       | `{ words, language, model, backend, … }` | `transcript`    |
| silence    | cpu      | `{ ranges, thresholdDb, … }`             | no              |
| beats      | cpu      | `{ bpm, beats, downbeats }`              | `beats`         |
| scenes     | cpu      | `{ scenes }`                             | `scenes`        |
| reframe    | ai       | `{ path, facesFound, provider }`         | no              |

Tools and models come from `pnpm bootstrap` (`scripts/setup.mjs`) and live in the data dir
(`REELFORGE_DATA`, default `~/.reelforge`): `bin/whisper/whisper-cli(.exe)`,
`models/whisper/ggml-*.bin`, `models/face/yunet.onnx`, `models/rnnoise/*.rnnn`.

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

| job     | measurement                                                    |
| ------- | -------------------------------------------------------------- |
| beats   | 3-min 44.1 kHz track: 1.7 s end-to-end (≈104× realtime)        |
| reframe | 37.6 analysed frames/s at 5 fps × 320 px (≈7.5× realtime), CPU |
| FFT     | 2048-point real FFT ≈ 0.1 ms                                   |

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
