/**
 * Neural models for beat tracking and smarter auto-reframe, downloaded by `pnpm bootstrap`
 * into <data>/models/<area>/. URLs are pinned to a repository commit and every file is
 * SHA-256 verified. All weights are MIT or Apache-2.0 (see the module READMEs).
 *
 * - beats/    Beat This! small (JKU Linz, MIT) + its torchaudio mel filterbank
 * - objects/  D-FINE small, COCO (Apache-2.0): person and salient-object detection
 * - saliency/ U²-Netp (Apache-2.0): salient-region fallback for shots without subjects
 */
import type { PinnedFile } from './manifest.ts'

const HF = 'https://huggingface.co'

/** Beat This! small0 (4.9 MB; fp32 compute), dynamic time axis. MIT. */
export const BEAT_MODEL: PinnedFile = {
  id: 'beat-this-small',
  url: `${HF}/Andremi/audioweb-models/resolve/953d0a9e46fd364860c9413ee4c7a9aa4fbcae4b/analysis/beat_this_small.onnx`,
  sha256: '6d9e1b3ebdb953b0bacf6755e6fa421e04e74709cdbe4abcc6f0e4b432c89f09',
  size: 4_915_083,
  dest: 'models/beats/beat_this_small0.onnx',
  description: 'Beat This! small — neural beat and downbeat tracker (MIT)',
}

/** torchaudio `MelScale.fb` [513, 128] float32 row-major, as shipped with the ONNX export. */
export const BEAT_FILTERBANK: PinnedFile = {
  id: 'beat-this-mel',
  url: `${HF}/musetric/beat-this-onnx/resolve/25308706dda545c0d5950065bb0604ad71bcf1f5/mel-filterbank.bin`,
  sha256: '1ee975d96f44ccf2c3bfe37825c1c1f0b089f5703c7a12a84b1f0a3bce004533',
  size: 262_656,
  dest: 'models/beats/beat_this_mel_filterbank.bin',
  description: 'Beat This! mel filterbank (MIT)',
}

/** D-FINE small, COCO: 78 % of person boxes of the large model at ~5× the speed. Apache-2.0. */
export const OBJECT_MODEL: PinnedFile = {
  id: 'dfine-s',
  url: `${HF}/onnx-community/dfine_s_coco-ONNX/resolve/a3cf03147a9b86c78475139115c8ac142577352d/onnx/model.onnx`,
  sha256: 'cd8a49a945feda6d28c6304ae8ae85c2759ba1d78a5a83a22c5ce8db82ef7238',
  size: 41_535_197,
  dest: 'models/objects/dfine_s_coco.onnx',
  description: 'D-FINE small (COCO) — person and object detector (Apache-2.0)',
}

export const SALIENCY_MODEL: PinnedFile = {
  id: 'u2netp',
  url: `${HF}/BritishWerewolf/U-2-Netp/resolve/7112208dbac3a3642496c8d54e2f0f9bb3dc1dc8/onnx/model.onnx`,
  sha256: '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8',
  size: 4_574_861,
  dest: 'models/saliency/u2netp.onnx',
  description: 'U²-Netp salient-object model (Apache-2.0)',
}

/** Everything this module installs, in download order. */
export const AI_MODELS: readonly PinnedFile[] = [
  BEAT_MODEL,
  BEAT_FILTERBANK,
  OBJECT_MODEL,
  SALIENCY_MODEL,
]
