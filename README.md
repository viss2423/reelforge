# ReelForge

**A self-hosted, AI-powered editor for Reels, Shorts and TikToks.**
Your always-on computer does all the work (decoding, AI, rendering, GPU encoding); your
phone, tablet and laptop get the same installable app and edit in sync.

> Status: under active development. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Highlights

- 9:16 only, built for vertical short-form video
- Multi-track timeline with magnetic main track, split/trim/speed/reverse, keyframes
- Auto-captions with word-level timing (whisper.cpp, runs locally) and trending caption styles
- One-tap AI: remove silences and filler words, beat-sync cuts, scene detection, auto-reframe
- Text presets, animations, transitions, effects, LUT filters, stickers, templates
- **Trend packs** that update automatically from this repository
- GPU-accelerated export (AMD AMF, NVIDIA NVENC, Intel QSV) with CPU fallback, loudness
  normalisation to platform targets
- Installable PWA on any device on your network (or anywhere via Tailscale)
- Private by design: your media never leaves your machine

## Requirements (host)

- Node.js 26 LTS, pnpm
- FFmpeg 8+ (full build with libass, rubberband, lut3d)
- Windows 10/11, macOS or Linux

## Quick start

```bash
pnpm install
pnpm setup     # downloads whisper.cpp + models, checks FFmpeg & GPU encoders
pnpm build
pnpm start     # prints a QR code — scan it with your phone
```

## License

MIT — see [LICENSE](LICENSE). Trend-pack content is CC0 unless noted; bundled fonts are OFL-1.1.
