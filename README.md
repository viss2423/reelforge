# ReelForge

**A self-hosted, AI-powered editor for Reels, Shorts and TikToks.**
Your always-on computer does all the work (decoding, AI, rendering, GPU encoding); your
phone, tablet and laptop get the same installable app and edit in sync.

> Status: under active development. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Features

- **9:16 only**, built for vertical short-form video (1080×1920 canvas; export 720p–4K)
- **Timeline**: magnetic main track plus overlay, text and audio tracks; split, trim,
  ripple delete, duplicate, reorder, speed (with pitch preservation) and reverse, keyframes,
  snapping, pinch-zoom, undo/redo; edits autosave and sync live between devices
- **Auto captions** with word-level timing (whisper.cpp on the host, nothing leaves your
  network), karaoke/keyword styles from trend packs, editable transcript
- **Auto Edit**: raw clips → finished reel in one tap (15/30/60 s, vibe, topic): the local
  LLM (Qwen3.5 4B on llama.cpp/Vulkan) picks the hook and best moments and writes the hook
  text, caption and hashtags; today's trend-pack look, trend-matched royalty-free music, cuts
  on the beat (on bars when the track has clear downbeats), captions, 2–3 switchable
  variants, one undo step — also without speech or without the LLM
- **Trending Now**: a free local trend engine (Google Trends, Wikipedia, Apple Music and
  Deezer charts) generates fresh caption styles, hooks and templates daily with the local
  LLM; "Make this reel" opens Auto Edit with the topic and vibe
- **Music that follows the trends, never AI-generated**: royalty-free tracks (Openverse,
  ccMixter, Jamendo) ranked by similarity to today's trending sounds; "Trending sounds today"
  with copy-the-name, one-tap similar free track and match cuts; export with "No music — add
  the sound in Instagram"
- **One-tap AI**: remove silences and filler words (with a review step), neural beat-sync
  cuts to your music (Beat This!, on beats or bars), split at scene changes, auto-reframe landscape clips to 9:16 (people, active speaker and group tracking),
  **remove / blur / replace the background** (AI subject matting) and put text **behind the subject**,
  voice enhance and noise reduction, and **Magic edit** that chains them in one undo step
- **Pro editing**: on-canvas move/scale/rotate/crop with snapping and Reels safe zones,
  slip, roll and ripple edits, box select, copy/paste
- **Look**: text presets and animations, transitions, LUT filters, adjustments, effects,
  chroma key, stickers, templates
- **Preview** that matches the export: WebGL2 compositor over host-made 540p proxies and the
  same libass text renderer (JASSUB) the exporter uses
- **Export** on the GPU (AMD AMF, NVIDIA NVENC, Intel QSV, verified at startup, CPU
  fallback), H.264/HEVC/AV1, loudness normalised to -14 LUFS, HDR phone footage tone-mapped
  to SDR
- **Trend packs** (caption styles, text presets, LUTs, transitions, effects, stickers,
  templates, fonts) that update automatically from this repository
- **Installable PWA** on every device on your network, or anywhere through Tailscale
- **Private by design**: your media never leaves your machine

## Install (Windows host)

ReelForge runs on Windows 10/11, macOS and Linux; the steps below are for Windows, the
reference host. On other systems install the same tools with your package manager.

1. **Prerequisites** (PowerShell):

   ```powershell
   winget install Git.Git OpenJS.NodeJS.LTS pnpm.pnpm Gyan.FFmpeg
   ```

   Node.js 26 LTS, pnpm 12 and FFmpeg 8+ (the Gyan _full_ build: libass, rubberband, lut3d,
   zscale, libplacebo). Open a new terminal afterwards so `PATH` picks them up. ReelForge
   also finds the winget FFmpeg on its own.

2. **Get ReelForge and its AI toolchain**:

   ```powershell
   git clone https://github.com/viss2423/reelforge.git
   cd reelforge
   pnpm install
   pnpm bootstrap
   pnpm build
   ```

   `pnpm bootstrap` checks Node and FFmpeg (filters and GPU encoders), then downloads into
   the data directory (`%USERPROFILE%\.reelforge`, or `REELFORGE_DATA`): the fastest
   whisper.cpp build for your machine, the `large-v3-turbo-q5_0` and `base` speech models
   (~700 MB), the YuNet face model, the RNNoise voice model, the neural beat, person-detection,
   saliency and MODNet matting models (~80 MB) and llama.cpp with the Qwen3.5 4B language
   model (~2.7 GB; `--llm-model qwen3.5-2b|9b|none`) — about **3.5 GB** in total. Every
   model, its source and licence is listed in [MODELS.md](MODELS.md). Every file is SHA-256
   verified; re-running resumes and skips what is already there. `pnpm bootstrap -- --help`
   lists the options (other models, CPU-only, custom data dir).

3. **Start it**:

   ```powershell
   pnpm start
   ```

   The terminal prints the addresses and a pairing QR code. HTTPS is on port **8443**
   (the app), plain HTTP on **8080** (pairing page and certificate download).

## Pair a phone and install the app

1. Put the phone on the same Wi-Fi and scan the QR code from `pnpm start` (or open
   `http://<computer-ip>:8080`). On the computer itself, open `https://localhost:8443`: it
   pairs without a code.
2. **Trust the computer once per device.** ReelForge creates its own local certificate
   authority; the pairing page has the download and these steps:
   - **iPhone/iPad**: open the page in Safari → _Download certificate_ → Allow →
     Settings → _Profile Downloaded_ → Install → Settings → General → About →
     _Certificate Trust Settings_ → turn on **ReelForge Local CA**.
   - **Android**: _Download certificate_ → Settings → Security & privacy → More security
     settings → Encryption & credentials → _Install a certificate_ → _CA certificate_ →
     Install anyway → pick `reelforge-ca.crt`.
   - **Another computer**: Windows: open the file → Install Certificate → Local Machine →
     _Trusted Root Certification Authorities_. macOS: Keychain Access → Always Trust.
3. Tap **Open ReelForge** and enter the 6-digit code shown on the computer (QR links pair
   automatically). Paired devices are listed, and can be revoked, in Settings.
4. **Install the app**: Android Chrome → menu → _Install app_ (or the install banner);
   iPhone Safari → Share → _Add to Home Screen_. Installed, it opens full screen and (on
   Android) appears in the share sheet, so videos go straight from the gallery to a project.

## Run it automatically (Windows)

From an elevated PowerShell in the repository:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\install-autostart.ps1 -StartNow
```

It registers a hidden **ReelForge** logon task that restarts the server after a crash,
opens the two ports on **Private** networks only, and prints the LAN URLs. Options, logs
and uninstalling: [scripts/windows/README.md](scripts/windows/README.md).

## Remote access with Tailscale

Install [Tailscale](https://tailscale.com) on the computer and the phone
(`winget install Tailscale.Tailscale`) and sign in to the same tailnet. ReelForge detects
it, adds the Tailscale address and MagicDNS name to its certificate (restart it once after
installing Tailscale) and shows them in Settings. Pair through
`https://<machine>.<tailnet>.ts.net:8443` exactly as on the LAN; nothing is exposed to the
internet.

## Configuration

Environment variables (all optional):

| Variable                                                 | Default                   | Meaning                                                                              |
| -------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------ |
| `REELFORGE_DATA`                                         | `~/.reelforge`            | Projects, media, exports, models, certificates                                       |
| `REELFORGE_HTTPS_PORT` / `REELFORGE_HTTP_PORT`           | `8443` / `8080`           | Ports                                                                                |
| `HOST`                                                   | `::`                      | Bind address (`::` = IPv6 and IPv4; falls back to `0.0.0.0` without IPv6)            |
| `FFMPEG_PATH`                                            | auto                      | FFmpeg binary or directory                                                           |
| `MDNS`                                                   | off                       | Answer `reelforge.local` on the LAN                                                  |
| `MAX_UPLOAD_SIZE`                                        | `20GB`                    | Largest single upload                                                                |
| `GPU_ENCODE_CONCURRENCY`                                 | `1`                       | Parallel GPU encodes                                                                 |
| `EXPORT_RETENTION` / `JOB_RETENTION`                     | `30d` / `7d`              | Pruning of finished exports / jobs                                                   |
| `REELFORGE_PACKS_SYNC` / `PACKS_SYNC_INTERVAL`           | on / `6h`                 | Trend-pack updates from GitHub (`off` serves `./packs`)                              |
| `LOG_LEVEL` / `LOG_PRETTY`                               | `info` / on in a terminal | Logging                                                                              |
| `TRENDS` / `TRENDS_REGION` / `TRENDS_HOUR`               | on / `US` / `4`           | Daily trend refresh (see `apps/server/src/trends/README.md`)                         |
| `TRENDS_SOUND_PREVIEW`                                   | off                       | Synced Deezer previews of trending sounds (terms: `apps/server/src/music/README.md`) |
| `REELFORGE_MUSIC_ONLINE` / `REELFORGE_JAMENDO_CLIENT_ID` | on / unset                | Royalty-free music search                                                            |

## Performance

Measured on the reference host (ThinkPad T15, Ryzen 7 PRO 8840U, Radeon 780M, 16 GB,
Windows 11, FFmpeg 9.0.2) through the real server API:

| What                                                          | Result                                                                                                                                                            |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Export 1080p, 60 s clip                                       | **3.97× realtime on AMD AMF** (15.1 s) vs 2.75× with libx264 (21.8 s)                                                                                             |
| Export 1080p, 30 s reel (6 clips, 5 transitions, text, music) | 2.70× realtime AMF, 2.02× libx264                                                                                                                                 |
| Proxy (540×960, GOP 15) of a 60 s 1080×1920 clip              | 8.5 s (7.1× realtime); probe 0.09 s, waveform 0.2 s, filmstrip + poster 3.9 s                                                                                     |
| Auto captions, 70 s of speech (default hybrid backend)        | 14.1 s (RTF 0.20); whisper-cli `large-v3-turbo` alone on the CPU: RTF 1.25                                                                                        |
| Server cold start (to `/api/health`)                          | 1.9 s on a fresh data dir (CA, certificate, GPU test encodes), 1.4 s afterwards                                                                                   |
| Web app initial JS                                            | 130 KB gzip (+10 KB CSS); the editor (170 KB gzip) loads on demand                                                                                                |
| Timeline, 200-clip project (desktop Chromium)                 | pointer-move handler 0.05 ms avg / 0.1 ms p95; frame work 0.3 ms avg / 0.6 ms p95; 22 clips mounted                                                               |
| Real phone (OnePlus 13R, Chrome 157): preview                 | first exact frame ≈ 0.55–0.7 s after opening; seek p50 ≈ 90 ms / p95 ≈ 120 ms; playback at display rate (90 fps measured), 1 ms compose, no stalls; 34 MB JS heap |

Details per subsystem: [AI backends](apps/server/src/ai/README.md),
[preview engine](apps/web/src/preview/README.md).

## Troubleshooting

| Symptom                                                    | Fix                                                                                                                                                                                                      |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phone can't reach `http://<ip>:8080`                       | Same Wi-Fi? Windows network set to **Private** (`Set-NetConnectionProfile -Name '<network>' -NetworkCategory Private`) and the firewall rules installed (autostart script, or allow Node.js on Private). |
| "Your connection is not private" / no _Install app_ option | The local CA is not trusted on that device yet (step 2 above). On iPhone the _Certificate Trust Settings_ switch is required, installing the profile alone is not enough.                                |
| Pairing code rejected                                      | Codes rotate every 5 minutes and are rate limited; use the current one from the terminal or Settings on the computer.                                                                                    |
| Auto captions say whisper is not installed                 | Run `pnpm bootstrap` (with the same `REELFORGE_DATA` as the server) and restart ReelForge.                                                                                                               |
| Export uses the CPU                                        | Settings → Host lists the GPU encoders the startup test encode verified. Update the GPU driver; check the server log for `GPU encode failed; using CPU`.                                                 |
| "Port already in use"                                      | Another ReelForge (e.g. the autostart task) is running: `Stop-ScheduledTask ReelForge`, or set `REELFORGE_HTTPS_PORT` / `REELFORGE_HTTP_PORT`.                                                           |
| Preview shows "Preview unavailable"                        | The browser lacks WebGL2 or WebCodecs; update it. Editing and exporting still work.                                                                                                                      |
| Where are the logs?                                        | The terminal, or `<data>\logs\server.log` with the autostart task.                                                                                                                                       |

## Development

```bash
pnpm dev          # server (watch) + Vite dev server
pnpm check        # format, lint (oxlint --type-aware), typecheck, unit/integration tests
pnpm test:e2e     # Playwright: production build + real server, Pixel 9 / iPhone 16 / desktop
pnpm --filter @reelforge/web test:e2e:ui   # UI-only specs against a mocked API
pnpm --filter @reelforge/web test:e2e:android   # a real Android phone over USB (adb)
```

The end-to-end suite generates its media with FFmpeg (and Windows text-to-speech). Point
`RF_E2E_TOOLS_DATA` at a bootstrapped data directory to include the real-AI full-flow spec
(whisper captions, silence removal, beat sync, GPU export verified with ffprobe and pixel
checks); `RF_E2E_HTTPS_PORT` / `RF_E2E_HTTP_PORT` move the test server's ports. The
Android pass drives the phone's own Chrome through `adb reverse` + DevTools in a tab of its
own (set `ADB` if adb is not on `PATH`; the phone must be unlocked) and leaves no tabs,
site data or port mappings behind.

### Testing on a real Android phone

1. Install adb once: `winget install Google.PlatformTools`.
2. On the phone: Settings → About phone → tap _Build number_ 7 times, then Developer options
   → turn on **USB debugging**.
3. Plug the phone in over USB, choose **File transfer** in the USB notification, and accept
   the _Allow USB debugging_ prompt. `adb devices` must list it as `device`.
4. Unlock the phone and keep the screen on (Chrome only renders on an awake screen), then:

   ```powershell
   pnpm --filter @reelforge/web test:e2e:android
   ```

   It starts the test server, maps its ports with `adb reverse`, opens one Chrome tab of its
   own and prints the device numbers (first frame, seek p50/p95, playback fps, frame time,
   JS heap, errors). With no unlocked device attached it skips, printing why, and exits 0.
   The phone does not need the local CA for this run; the service worker then reports the
   untrusted certificate, which the test accepts as the only installability gap.

## License

MIT — see [LICENSE](LICENSE). Trend-pack content is CC0 unless noted; bundled fonts are OFL-1.1.
