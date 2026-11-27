/**
 * Subject-matting models for AI background removal (`matte` job). Pinned to Hugging Face
 * commits with their LFS SHA-256. Both are fp16 ONNX exports: on the Radeon 780M (DirectML)
 * they run faster than fp32 with identical quality (apps/server/src/ai/matte/README.md).
 */
import type { PinnedFile } from './manifest.ts'

export const MATTE_MODELS: readonly PinnedFile[] = [
  {
    id: 'matte-modnet',
    url: 'https://huggingface.co/Xenova/modnet/resolve/fa2fa546052fba4c08921230a26cc69a333fca12/onnx/model_fp16.onnx',
    sha256: '25f165da9bfd30830a575f1f0490f1acd995975cb349bc02f3d79332e1fe5cf6',
    size: 12_984_781,
    dest: 'models/matte/modnet.onnx',
    description: 'MODNet portrait matting, fp16 (Apache-2.0) — fast default',
  },
]
