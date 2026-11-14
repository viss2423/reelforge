/**
 * Pinned third-party assets downloaded by `pnpm bootstrap`. Every file has a pinned SHA-256
 * taken from the publisher (Hugging Face LFS oid / GitHub LFS pointer). Whisper.cpp binaries
 * are resolved dynamically (latest release) and verified against GitHub's published asset
 * digest instead — see whisper.ts.
 */

export interface PinnedFile {
  /** Short id used on the command line and in the summary. */
  id: string
  url: string
  sha256: string
  size: number
  /** Path relative to the data dir. */
  dest: string
  description: string
}

const HF_WHISPER = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

/** Whisper ggml models (multilingual). `id` is what `--models` accepts. */
export const WHISPER_MODELS: readonly PinnedFile[] = [
  {
    id: 'large-v3-turbo-q5_0',
    url: `${HF_WHISPER}/ggml-large-v3-turbo-q5_0.bin`,
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    size: 574_041_195,
    dest: 'models/whisper/ggml-large-v3-turbo-q5_0.bin',
    description: 'Large v3 Turbo, 5-bit — best accuracy (default)',
  },
  {
    id: 'large-v3-turbo-q8_0',
    url: `${HF_WHISPER}/ggml-large-v3-turbo-q8_0.bin`,
    sha256: '317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1',
    size: 874_188_075,
    dest: 'models/whisper/ggml-large-v3-turbo-q8_0.bin',
    description: 'Large v3 Turbo, 8-bit',
  },
  {
    id: 'small-q5_1',
    url: `${HF_WHISPER}/ggml-small-q5_1.bin`,
    sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb',
    size: 190_085_487,
    dest: 'models/whisper/ggml-small-q5_1.bin',
    description: 'Small, 5-bit — balanced',
  },
  {
    id: 'base',
    url: `${HF_WHISPER}/ggml-base.bin`,
    sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
    size: 147_951_465,
    dest: 'models/whisper/ggml-base.bin',
    description: 'Base — fastest usable (drafts, long files)',
  },
  {
    id: 'base-q5_1',
    url: `${HF_WHISPER}/ggml-base-q5_1.bin`,
    sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898',
    size: 59_707_625,
    dest: 'models/whisper/ggml-base-q5_1.bin',
    description: 'Base, 5-bit',
  },
  {
    id: 'tiny',
    url: `${HF_WHISPER}/ggml-tiny.bin`,
    sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21',
    size: 77_691_713,
    dest: 'models/whisper/ggml-tiny.bin',
    description: 'Tiny — tests / very slow machines',
  },
]

/** Installed when `--models` is not given: accurate default + a fast model. */
export const DEFAULT_WHISPER_MODELS = ['large-v3-turbo-q5_0', 'base'] as const

/**
 * YuNet face detector. The 2026may export is the 2023mar network with symbolic H/W input
 * dims, so frames can be fed at their native (padded) size without resizing.
 */
export const FACE_MODEL: PinnedFile = {
  id: 'yunet',
  url: 'https://media.githubusercontent.com/media/opencv/opencv_zoo/26cc381e4d2594bb9f47a26eb8fd96c94a13660d/models/face_detection_yunet/face_detection_yunet_2026may.onnx',
  sha256: 'ebafce4e3c118d6554634be5c27ab333b4c047a9a8c3faf1d7cf93101c22f0f0',
  size: 229_738,
  dest: 'models/face/yunet.onnx',
  description: 'YuNet face detector (OpenCV Zoo, 2026may dynamic-shape export)',
}

/** RNNoise voice model for FFmpeg `arnndn` ("somnolent hogwash": general speech/noise). */
export const RNNOISE_MODEL: PinnedFile = {
  id: 'rnnoise-sh',
  url: 'https://raw.githubusercontent.com/GregorR/rnnoise-models/3eee541a283fd3b8f81b85b1748e3b9ccbefa04d/somnolent-hogwash-2018-09-01/sh.rnnn',
  sha256: '70bb6685eb0c2a1d18e2918dca3fbfbd39317010b1802eb1b6ea73a92f3fdec0',
  size: 297_646,
  dest: 'models/rnnoise/sh.rnnn',
  description: 'RNNoise speech denoiser (GregorR/rnnoise-models "sh")',
}
