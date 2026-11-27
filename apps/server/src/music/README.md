# Automatic music

Three layers, all free and local-first. Trending Instagram/TikTok sounds are copyrighted and
are **never** downloaded or embedded; templates only carry a text `musicHint` that the editor
shows with a copy button ("Trending sound to add when posting").

```
POST /api/music/suggest ─► job music.suggest (cpu) ─► MusicService.suggest
   search sources (day cache) ─► rank ─► download + analyse the best few ─► re-rank
POST /api/music/import  ─► download once, analyse once ─► Asset { music: licence, beats, section }
core insertMusicClip    ─► trim to reel, enter at chorus, fades, beat markers, duck under speech
```

## 1. Royalty-free library

| Source              | Needs                                          | Catalogue / licences kept                    | Limits we respect                                            |
| ------------------- | ---------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------ |
| Openverse (default) | nothing                                        | Jamendo, ccMixter, Wikimedia… · CC0, PDM, BY | anonymous 20 req/min, 200/day: 1 request per 4 s, 24 h cache |
| ccMixter (default)  | nothing                                        | CC BY remixes/instrumentals, tagged BPM      | 1 request per second                                         |
| Jamendo (optional)  | free client id (`REELFORGE_JAMENDO_CLIENT_ID`) | CC0/BY with downloads allowed                | 2 requests per second                                        |

Policy (`licence.ts`): CC0, Public Domain Mark and CC BY are accepted. **NC** (forbids
sponsored/monetised posts), **ND** (syncing is an adaptation) and **SA** (the reel would have to
be share-alike) are rejected, as is anything unparseable. CC BY tracks store a TASL credit line
(`attribution`) on the asset; the editor shows all used credits in the export dialog as one
copyable caption line (`musicCredits` in core).

Other candidates evaluated and not adopted: Pixabay Music (no public music API; its content
licence forbids scraping and redistribution as a library), Free Music Archive (API retired),
YouTube Audio Library (no API, terms tie tracks to YouTube), Incompetech (CC BY, but no API:
scraping the site would break its ToS).

Hardening: sources only fetch `https` URLs to public host names (no IP literals, no
`localhost`/`.local`), downloads must answer `audio/*`, are capped at 80 MiB and 120 s, and
a 429/503 cools the source down for `Retry-After`. Searches fall back to the stale cache and
to already-downloaded tracks when offline; the UI shows a warning, never an exception.

Cache (`<data>/music`): `search/` (24 h), `tracks/<source>-<hash>/` with the original audio,
`meta.json`, `analysis.json` (BPM, beats, bars, loudness envelope) and `preview.m4a`. Budget 1 GiB,
least-recently-used tracks are removed first.

## 2. Analysis and chorus detection

One FFmpeg decode feeds the existing beat tracker (`analyzeBeats`, now with a `tap` hook) and a
10 Hz loudness envelope. `sections.ts` normalises the envelope (10th-95th percentile), smooths
it over 1 s and scores every bar start by mean energy over the reel length, the energy of the
first 8 s (the hook has to land immediately) and the energy rise into it (a chorus enters with
a jump). Earliest best wins ties. Tested on synthetic songs (intro / chorus / verse / outro).

## Trending sounds (trend-matched, never generated, never embedded)

Owner rule: **no AI-generated music anywhere**; music follows what is trending today.

- **Trend-matched ordering (default).** `MusicSuggestRequest.order` defaults to `trend`:
  the trend engine (`src/trends`) hands the library today's top chart sounds as profiles
  (`TrendSoundProfile`: BPM — measured by Deezer or estimated from the genre — and genre,
  mood and energy derived from genre/tempo in `trends/sounds.ts`). `rank.ts` scores every
  royalty-free candidate as 0.55 × the reel-fit score + 0.45 × similarity to the closest
  trending sound (tempo 0.5, genre/mood words 0.25, energy 0.25, scaled by chart rank) and
  records `trendMatch` ("sounds like …"). Auto music, Auto Edit and "Find similar free
  track" (`sound`: one specific chart sound) all use it; `order: 'relevance'` turns it off.
- **"Trending sounds today"** (Audio panel and Export dialog): name, artist, BPM (est.),
  source and freshness (first-seen tracking in the trend state); **Add this sound when you
  post** copies the name for Instagram's sound picker; **Find similar free track** inserts
  the trend-matched royalty-free pick with core `insertMusicClip`; **Match cuts to this
  sound** re-times the main-track cuts to the sound's grid (bars when the downbeats are
  clear).
- **Export → Music: "No music — add the sound in Instagram"** leaves the music bed out
  (`ExportSettings.music: 'none'`, core `withoutMusic`); it is the default once a trending
  sound was copied or previewed. "Free track baked in" mixes the royalty-free bed.
- **Auto Edit** shows the suggested trending sound with Copy in its result.

### "Preview with my reel" and the providers' terms (checked 27 Nov 2026)

The owner asked to play a trending sound's official 30 s preview in sync with the edit. The
terms were reviewed before shipping it:

- **Apple (iTunes Search API, performance-partners.apple.com/search-api):** previews are
  promotional content only and must be "streamed only, and not downloaded, saved, cached, or
  synchronized with video" and "not used for independent entertainment value". Playing a
  preview in sync with a reel is exactly what is excluded, so **Apple previews are not used
  at all**.
- **Deezer (developers.deezer.com/termsofuse, last updated 27 Oct 2026, and /guidelines):**
  the API exposes 30 s extracts, but access is for "Developers who have been expressly
  selected and approved by DEEZER", for private non-commercial use; local copies are not
  allowed (III.4), "The Developer shall not combine any Content with visual or audiovisual
  images" (III.2), and the content may not be modified (III.10).

Playing a Deezer preview over the reel is therefore **not covered by default**. ReelForge
ships it **off**: the row offers **Listen on Deezer** (opens the sound's Deezer page) and
**Match cuts** uses the chart BPM grid; no preview audio is requested at all. A host owner
who has Deezer's approval can enable it with `TRENDS_SOUND_PREVIEW=1`: the preview is then
streamed through the host (`GET /api/trends/sounds/preview`, CDN allow-list `*.dzcdn.net`,
`cache-control: no-store`), decoded in memory and played by the preview engine's audio graph,
looped every 30 s in place of the music bed — never written to disk, never an asset, never in
an export — and "Match cuts" analyses the stream with the beat tracker (Beat This!, else
DSP). Sounds without a preview say so and offer the closest free match.

## 3. AI music generation: evaluated, not adopted

Candidates (late 2026) and why none is the default:

| Model                              | Weights licence           | Verdict on this laptop                                                                                                                                                                                                                                                                                                       |
| ---------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACE-Step 1.5 (GGUF, `acestep.cpp`) | MIT                       | Needs a C++ build or a temporary third-party Windows binary host (no signed release, no pinned sha256 from the project); the turbo DiT is 1.4-2.5 GB plus a 0.6-4 B LM, a VAE and a text encoder (up to ~7.7 GB). No published numbers for a 780M, and with 16 GB shared RAM it cannot run next to the editor and an export. |
| HeartMuLa 3B                       | Apache-2.0                | 3 B autoregressive codec LM: far from real time on CPU/iGPU.                                                                                                                                                                                                                                                                 |
| Magenta RealTime 2 (ONNX)          | CC BY 4.0 (attribution)   | Streaming model; ONNX export is community-made and the host loop is JS/WebGPU only, no Node reference.                                                                                                                                                                                                                       |
| MiniMax Music 3                    | open weights, ~11 B       | Too large.                                                                                                                                                                                                                                                                                                                   |
| YuE, MusicGen                      | non-commercial / CC BY-NC | Cannot be a default.                                                                                                                                                                                                                                                                                                         |

The bar was 30 s of audio in under ~2 minutes with decent quality without starving the rest
of the host. ACE-Step 1.5 is the only plausible one; its distribution story (no pinned,
verifiable Windows build) and footprint do not meet our bootstrap rules yet, so there is no
`music.generate` job. The adapter seam is ready: add a `MusicSource` whose `search` returns a
generated track (`source: 'generated'`, licence `generated`) once a verifiable build exists.

## Measurements (ThinkPad T15, Ryzen 7 PRO 8840U, live Openverse)

See `apps/server/test/music/live.test.ts` (`RF_MUSIC_LIVE=1`) for the harness. Numbers from
the last run are in the PR description / result JSON.

## Configuration

| Variable                      | Default | Meaning                            |
| ----------------------------- | ------- | ---------------------------------- |
| `REELFORGE_MUSIC_ONLINE`      | on      | search the online catalogues       |
| `REELFORGE_JAMENDO_CLIENT_ID` | unset   | enables the Jamendo source         |
| `TRENDS_SOUND_PREVIEW`        | off     | synced Deezer previews (see above) |

## API

| Method | Path                                                        | Notes                                                                                                                                                                       |
| ------ | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/music/sources`                                        | sources and availability                                                                                                                                                    |
| GET    | `/api/music/search?q&mood&genre&bpmMin&bpmMax&source&limit` | metadata only                                                                                                                                                               |
| POST   | `/api/music/suggest`                                        | `{vibe?, mood?, genre?, targetBpm?, energy?, order?, sound?, duration, hasSpeech, limit, analyze, projectId?}` → ranked tracks with `trendMatch` (runs job `music.suggest`) |
| POST   | `/api/music/import`                                         | `{trackId, length?}` → `{asset, bpm, beats, downbeats, section}`                                                                                                            |
| GET    | `/api/music/tracks/:id`                                     | one track                                                                                                                                                                   |
| GET    | `/api/music/tracks/:id/preview`                             | 10 s AAC from the chorus, Range supported                                                                                                                                   |

From server code (e.g. the Auto Edit flow): `suggestMusic(ctx, request)` and
`importMusic(ctx, trackId, { length })` in `apps/server/src/music/index.ts`, then core
`insertMusicClip(project, { asset, sourceStart, length, duck, beats, downbeats })`.
| GET | `/api/trends/sounds/preview-info?title&artist` | `{available, source?, duration?}`, or `{available: false, disabled: true}` when off |
| GET | `/api/trends/sounds/preview?title&artist` | Deezer 30 s preview streamed through (opt-in, no-store) |
| POST | `/api/trends/sounds/beats` | `{title, artist?, bpm?}` → beat/bar grid of the preview, else a BPM grid |
