# Subject matting (AI background)

The `matte` job (resource `ai`) separates the subject from the background of a video or
photo once per asset. Everything built on it runs from that one cached matte:

- **Remove background**, **Blur background**, **Replace background** (colour / image) per
  clip, and **Text behind subject** per text clip.
- **Preview**: the WebGL compositor samples the 540p-class mask proxy as a texture
  (`/api/assets/:id/matte?v=<version>`), same math as the export.
- **Export**: the compiler decodes the lossless matte next to the original (same trim, speed,
  crop, flips) and merges it with `alphamerge` + `overlay` (see `packages/core/src/compile/visual.ts`,
  `decodeMedia`). Text behind subject is a second "subject pass" of the main track laid over the
  text (`video.ts`, `applyBehindText`).

## Pipeline

```
FFmpeg decode (D3D11VA, rotation applied, ≤ 1280 px long side, source fps ≤ 60)
  → MODNet (onnxruntime-node, DirectML on Windows, CPU elsewhere)
  → motion-adaptive temporal smoothing (refine.ts)
  → 8-bit gray frames → one FFmpeg process writing both outputs (writer.ts):
       <asset>/matte.mkv          FFV1 gray, lossless, full matte size (export)
       <asset>/matte-proxy.mp4    H.264 ≤ 960 px, GOP 15, no B-frames, +faststart (preview)
       <asset>/matte-proxy.png    stills
```

Decode, inference and encode overlap with bounded queues; the previous frame's refinement and
encode run while the network works on the next one. Files are written to `.part` names and
renamed on success, so cancelling or failing never leaves a half matte and keeps the previous
good one. The result is cached on `asset.matte` (`status`, `model`, `version`); a rerun with the
same model is a no-op unless `force`. Progress is source time over duration; cancel kills FFmpeg
and drops the session.

Sessions load lazily and unload 60 s after the last job. The job runs in the queue's `ai`
class, so it never overlaps Whisper or reframe.

## Model choice (measured on the reference host)

ThinkPad T15, Ryzen 7 PRO 8840U, Radeon 780M, 16 GB shared, Windows 11, onnxruntime-node 1.31.
Test set: 7 green-screen clips (Mixkit, free licence), keyed to a ground-truth alpha with FFmpeg and
composited over 5 other real clips (1280×720, 30 frames each at 10 fps). Metrics at 640 px: IoU of the
0.5-binarised matte, SAD (Σ|α−α̂|/1000 per frame), MSE (×10³), dtSSD (×100, RMS error of the temporal
derivative: the flicker metric). ms/frame is inference only; the machine was shared with other work
during the runs, so absolute times are pessimistic.

| model                     | EP  | ms/frame   | IoU   | SAD  | dtSSD | notes                                 |
| ------------------------- | --- | ---------- | ----- | ---- | ----- | ------------------------------------- |
| **MODNet fp16** (shipped) | DML | **130**    | 0.994 | 0.70 | 3.38  | 13 MB                                 |
| MODNet fp32               | DML | 195        | 0.994 | 0.70 | 3.38  | 26 MB                                 |
| MODNet fp32               | CPU | 527        | 0.994 | 0.70 | 3.38  |                                       |
| MODNet fp16               | CPU | 1071       | 0.994 | 0.70 | 3.38  | CPU has no fp16 kernels               |
| MODNet uint8              | DML | 1064       | 0.977 | 1.60 | 5.5   | slower _and_ worse                    |
| MODNet 384 px input       | DML | 93         | 0.992 | 0.69 | 3.62  | ~30 % faster, flickers more           |
| MediaPipe selfie 256 px   | DML | 17         | 0.945 | 3.51 | 7.23  | fastest; blocky edges, people only    |
| BiRefNet-lite fp32 1024²  | CPU | **30 298** | 0.993 | 0.45 | 2.87  | 6.8 GB RSS: unusable                  |
| BiRefNet-lite fp16 1024²  | DML | fails      | —     | —    | —     | DirectML "not enough memory" (shared) |
| BEN2 fp16 1024²           | DML | not run    | —     | —    | —     | same graph size as BiRefNet           |

MODNet (Apache-2.0, `Xenova/modnet` fp16 export, SHA-256 pinned in `scripts/lib/matte.ts`) is the
best trade-off: BiRefNet's edges are better (SAD 0.45) but a 1024² Swin graph neither fits the
shared 16 GB on DirectML nor runs on the CPU in useful time, and MODNet is already within 0.3 SAD.
A smaller input (384) costs temporal stability, so 512 stays. DirectML is 4× faster than the CPU
for the fp16 model; `auto` picks it on Windows and falls back to CPU if the session fails. The
Ryzen AI NPU (VitisAI EP) was not adopted: onnxruntime-node ships no VitisAI provider, and the
published Ryzen AI runtime needs a separate Python/C++ stack and quantised, NPU-compiled models,
which would break the plain `pnpm bootstrap` install.

### Refinement

| post-processing (MODNet fp16, DML) | SAD  | dtSSD | cost / frame (1280×720) |
| ---------------------------------- | ---- | ----- | ----------------------- |
| none                               | 0.70 | 3.38  | 0                       |
| **temporal ×0.4** (default)        | 0.79 | 3.32  | ≈ 17 ms                 |
| temporal ×0.7                      | 0.93 | 3.44  | ≈ 17 ms                 |
| temporal + guided filter (s=2)     | 1.43 | 3.90  | ≈ 150 ms                |
| temporal + guided filter (s=4)     | 1.52 | 4.03  | ≈ 100 ms                |

The luma-guided filter made the matte worse (it blurs edges MODNet already resolves), so it is off
by default (`RefineOptions.radius`). Temporal smoothing is weighted per pixel by the luma change,
so static regions settle while motion never ghosts; stronger weights lag moving edges.

## Reproducing the benchmark

```
node apps/server/src/ai/matte/bench.ts <dataset dir> <model dir> modnet-fp16 --provider=dml [--refine=temporal --temporal=0.4]
```

The dataset dir holds `<name>.mp4` (composite) + `<name>.alpha.mkv` (ground truth) pairs.

## Limits

- One subject class: MODNet is a portrait matter. It handles people and handheld objects close to
  them well, and generic objects poorly (BiRefNet would, but is out of reach on this host).
- The matte is stored at source frame rate (≤ 60) and size ≤ 1280 px long side; the export upsamples
  it with the frame (bilinear), so edges are as sharp as the 512 px network resolution allows.
- Speed ramps and reverse use the same source-time mapping as the video, so the matte stays aligned.
- Preview feathering uses a 3×3 Gaussian-like kernel; the export uses `gblur`. They agree closely for
  small feathers; large feathers differ by a few LSB at the edge only.
