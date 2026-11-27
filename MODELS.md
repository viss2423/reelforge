# Third-party models and binaries

ReelForge is MIT-licensed. Its bootstrap (`pnpm bootstrap`) downloads the models and binaries below
from their publishers into the local data directory. ReelForge does not bundle or redistribute them
in this repository; each remains under its own licence. All downloads are pinned to a commit/tag
and SHA-256 verified (`scripts/lib/manifest.ts`, `llm.ts`, `ai-models.ts`, `matte.ts`).

Licence verification: upstream repository / model card plus the specific hosted export that is
actually downloaded (audited 2026-11).

| Model                                                                                        | Used for                     | Source (hosted file)                                                                    | Licence                                                                                                                             | Size     | Notes                                                                                        |
| -------------------------------------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| whisper.cpp (binaries)                                                                       | Speech-to-text runtime       | github.com/ggml-org/whisper.cpp releases (latest, verified against GitHub asset digest) | MIT                                                                                                                                 | varies   | Copyright (c) ggml authors.                                                                  |
| Whisper ggml `large-v3-turbo-q5_0` (default), plus q8_0, small-q5_1, base-q5_1, tiny options | Transcription                | huggingface.co/ggerganov/whisper.cpp                                                    | MIT (OpenAI Whisper weights, "Copyright (c) 2022 OpenAI")                                                                           | 574 MB   | Converted/quantised by ggerganov; HF card also MIT.                                          |
| Whisper ggml `base` (default)                                                                | Fast transcription           | huggingface.co/ggerganov/whisper.cpp `ggml-base.bin`                                    | MIT                                                                                                                                 | 148 MB   | As above.                                                                                    |
| YuNet `face_detection_yunet_2026may.onnx`                                                    | Face detection for reframe   | github.com/opencv/opencv_zoo (commit 26cc381)                                           | MIT                                                                                                                                 | 230 KB   | opencv_zoo README: "All files in this directory are licensed under MIT".                     |
| RNNoise `sh.rnnn` ("somnolent-hogwash")                                                      | FFmpeg `arnndn` denoise      | github.com/GregorR/rnnoise-models (commit 3eee541)                                      | No licence file; author states the models are "not creative and thus not subject to copyright"                                      | 298 KB   | See Problems (minor). RNNoise code itself is BSD-3-Clause but is not downloaded.             |
| Beat This! small (`beat_this_small.onnx`)                                                    | Beat/downbeat tracking       | huggingface.co/Andremi/audioweb-models (analysis/)                                      | MIT (HF tag MIT; upstream CPJKU/beat_this: code and weights MIT)                                                                    | 4.9 MB   | Community ONNX export; upstream README warns some training files are copyrighted/limited-CC. |
| Beat This! mel filterbank                                                                    | Beat This! preprocessing     | huggingface.co/musetric/beat-this-onnx                                                  | MIT (inherited from upstream)                                                                                                       | 263 KB   | torchaudio MelScale table.                                                                   |
| D-FINE-S COCO (`onnx-community/dfine_s_coco-ONNX`)                                           | Person/object detection      | huggingface.co/onnx-community/dfine_s_coco-ONNX                                         | Apache-2.0 (upstream Peterande/D-FINE and ustc-community/dfine-small-coco: Apache-2.0). The ONNX repo itself shows no licence field | 41.5 MB  | COCO-only checkpoint, not the Objects365 ones (those carry a commercial caveat).             |
| U2-Netp (`BritishWerewolf/U-2-Netp`)                                                         | Salient-region fallback      | huggingface.co/BritishWerewolf/U-2-Netp                                                 | Apache-2.0 (upstream xuebinqin/U-2-Net Apache-2.0; ONNX from rembg)                                                                 | 4.6 MB   |                                                                                              |
| MODNet fp16 (`Xenova/modnet`)                                                                | Background removal (matting) | huggingface.co/Xenova/modnet                                                            | Apache-2.0 (upstream ZHKKKe/MODNet README: code, models and demos Apache-2.0)                                                       | 13 MB    | Upstream excludes only `doc/gif` files; irrelevant here.                                     |
| Qwen3.5-4B Q4_K_M GGUF (default)                                                             | Local LLM (captions/copy)    | huggingface.co/unsloth/Qwen3.5-4B-GGUF                                                  | Apache-2.0 (Qwen/Qwen3.5-4B: Apache-2.0)                                                                                            | 2.74 GB  | Unsloth quantisation.                                                                        |
| Qwen3.5-2B Q4_K_M GGUF (option)                                                              | Low-RAM LLM                  | huggingface.co/unsloth/Qwen3.5-2B-GGUF                                                  | Apache-2.0                                                                                                                          | 1.28 GB  |                                                                                              |
| Qwen3.5-9B Q4_K_M GGUF (option)                                                              | High-quality LLM             | huggingface.co/unsloth/Qwen3.5-9B-GGUF                                                  | Apache-2.0                                                                                                                          | 5.68 GB  |                                                                                              |
| llama.cpp `b12588` (llama-server binaries, per-OS)                                           | LLM runtime                  | github.com/ggml-org/llama.cpp releases                                                  | MIT                                                                                                                                 | 12-39 MB | Release archives also contain bundled-dependency licences; keep them alongside the binaries. |

## Verdicts

All entries are OK or OK-WITH-ATTRIBUTION. Nothing is non-commercial, share-alike or gated.

- OK-WITH-ATTRIBUTION (MIT/Apache-2.0 notices apply only if you redistribute the files; download-at-install does not
  redistribute, but the notices below are included for good practice): Whisper, whisper.cpp, llama.cpp,
  YuNet, Beat This!, D-FINE, U2-Netp, MODNet, Qwen3.5.
- OK: RNNoise `sh.rnnn` (no licence asserted by author; see Problems).

## Attribution notices

If ReelForge ever mirrors, bundles or ships these files (for example in a Docker image or release
archive), include the upstream licence text and copyright line with them:

- Whisper models: "Copyright (c) 2022 OpenAI", MIT License.
- whisper.cpp: "Copyright (c) 2023-2024 The ggml authors", MIT License.
- llama.cpp: "Copyright (c) 2023-2024 The ggml authors", MIT License (plus the third-party notices inside the release archive).
- YuNet / OpenCV Zoo: MIT License, Copyright the OpenCV Zoo authors and the libfacedetection (Shiqi Yu) authors.
- Beat This!: MIT License, Copyright JKU Linz (CPJKU). Please cite: F. Foscarin, J. Schlüter, G. Widmer,
  "Beat this! Accurate beat tracking without DBN postprocessing", ISMIR 2024.
- D-FINE: Apache License 2.0, Copyright the D-FINE authors (Peng, Li, Wu, Zhang, Sun, Wu; arXiv:2410.13842).
  Trained on COCO (Lin et al., 2014).
- U2-Netp: Apache License 2.0, Copyright Xuebin Qin et al. (U-2-Net); ONNX via rembg (Daniel Gatis).
- MODNet: Apache License 2.0, Copyright Zhanghan Ke et al. (ZHKKKe/MODNet).
- Qwen3.5: Apache License 2.0, Copyright Alibaba Cloud / Qwen Team; GGUF quantisation by Unsloth.

Apache-2.0 redistribution would additionally require including the licence text and noting changes
(quantisation/ONNX conversion).

## Problems

No blocking problems. Minor items to be aware of:

1. RNNoise `sh.rnnn` has no explicit licence. The author says the files are not copyrightable
   and training-data provenance is undocumented. Risk is low, and the file is downloaded rather than
   redistributed. If a clearly licensed model is wanted, the Xiph RNNoise project's own
   default weights (BSD-3-Clause, https://github.com/xiph/rnnoise) are a permissive alternative; the
   `arnndn` filter would need a model converted to its `.rnnn` format. Alternatively make
   denoise opt-in and document this.
2. `onnx-community/dfine_s_coco-ONNX` does not display a licence field on its model card. The upstream
   weights (Apache-2.0) are the reference. Consider pinning the card's licence in the docs as above.
3. Training-data caveats exist upstream for Beat This! (some copyrighted/limited-CC audio) and
   Whisper/Qwen (undisclosed corpora). These are the publishers' licence terms, which grant use under MIT/Apache.
4. D-FINE: only the COCO-only checkpoint is used. Do not swap in `*_obj365` / `*_obj2coco`
   checkpoints without clearing Objects365 terms.
