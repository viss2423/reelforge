# Trend engine (`src/trends`)

Keeps ReelForge's trends current 24/7 on the host, for free: no paid APIs, no cloud AI,
no accounts beyond optional free keys. Once a day (and on demand) it reads public trend
signals, re-ranks every pack item, generates new caption styles, hook presets and
templates, and publishes them as the local `trending-live` pack plus the data behind the
**Trending Now** screen.

```
sources/*  ──►  extract.ts  ──►  rank.ts ─────────────► packs overlay (live trendScores)
 (cached,        signals:         every item's score
  polite HTTP)   topics, sounds,
                 formats, looks,  generate.ts
                 caption cues,     remix (no LLM) + LLM specs ─► catalogue.ts compilers
                 hashtags                                          │
                                  livepack.ts  ◄──────────────────┘
                                   merge/carry · dedupe · localise refs · validate
                                   (zod + scripts/lib-packs/validate.mjs) · thumbnails
                                   (scripts/lib-packs/thumbs.mjs) · atomic pointer swap
                                   │
                                   ├─► <data>/packs/local/<v-…>/trending-live  (served)
                                   └─► publish.ts (optional, gh → PR on `trends`)
```

## Sources

| Source               | Endpoint                                                                 | Key          | Gives                                  | Fetch cadence    |
| -------------------- | ------------------------------------------------------------------------ | ------------ | -------------------------------------- | ---------------- |
| Google Trends        | `trends.google.com/trending/rss?geo=US` (public RSS)                     | none         | rising searches, traffic, headlines    | ≤ every 3 h      |
| Wikipedia most read  | Wikimedia REST `metrics/pageviews/top/en.wikipedia/…` (CC0 data)         | none         | what people read about (films, games…) | daily            |
| Apple Music          | `rss.marketingtools.apple.com/api/v2/us/music/most-played/25/songs.json` | none         | trending songs + genres                | ≤ every 12 h     |
| Deezer chart         | `api.deezer.com/chart/0/tracks`, `/track/<id>`                           | none         | trending songs + tempo where known     | ≤ 12 h, BPM 30 d |
| YouTube most popular | Data API v3 `videos?chart=mostPopular`                                   | free API key | titles, tags, hashtags, formats        | ≤ every 12 h     |
| Reddit creator subs  | `oauth.reddit.com/r/<sub>/top?t=day` (app-only OAuth)                    | free app id  | creator chatter: formats, caption cues | ≤ every 12 h     |
| Calendar (built in)  | —                                                                        | —            | seasonal moments (always available)    | —                |

Every source is a `TrendSource` (`types.ts`) and is tested against recorded responses in
`test/trends/fixtures` (YouTube and Reddit fixtures are synthetic samples in the
documented response shape because live calls need keys). `RF_LIVE_TRENDS=1 pnpm test`
runs one live smoke test against the keyless sources.

### Terms of service and politeness

- Only official feeds/APIs are used, never scraping. TikTok's Creative Center and Instagram
  are **not** used: their terms forbid automated collection and there is no free API.
- Reddit blocks anonymous JSON/RSS since 2025 (HTTP 403/429); the source therefore uses
  the official Data API with a free "script" app (100 requests/min free tier; we use ~6/day).
- YouTube costs 1 quota unit per call out of 10 000/day; we use ~2/day.
- Deezer: ~11 requests/day against a 50 requests/5 s quota. **No audio is downloaded** —
  only names and the `bpm` metadata field. Sound names and links (Deezer search) are shown
  so the user attaches the real sound when posting.
- `http.ts`: descriptive User-Agent (Wikimedia's policy), disk cache with TTL so a source is
  hit at most once per TTL however often refreshes run, ETag/Last-Modified revalidation,
  ≥ 1 s between requests to one host, exponential backoff honouring `Retry-After` on
  429/5xx, no retries on other 4xx, and the last good copy is used when a source is down.
  API keys never reach cache file names or logs.

## Ranking (works without an LLM)

`rank.ts` matches each pack item's name, tags and description against the signals
(formats ×1.2, aesthetics/caption cues ×1, hashtags ×0.8, topics ×0.5) and computes
`score = clamp(base × 0.9 + (1 − e^(−match)) × 25)` from the item's _shipped_ score, so runs
never compound and unmatched items only cool off by 10 %. Scores are applied as an overlay
(`PacksService.setOverlay`): the hash-verified synced packs are never modified.

## Generation

- **Beat remixes** (always, no LLM): the best-matching existing templates are re-cut on the
  tempo of today's top sounds (whole beats per slot) with `musicHint` = sound name + BPM.
  Tempo comes from Deezer when known, else the genre's typical tempo (`bpm.ts`).
- **LLM** (when `LlmPort.available()`): four short calls (caption styles, hook text presets,
  templates, hashtags) plus one for reel ideas. The model fills closed-vocabulary _specs_
  (`catalogue.ts`: shipped fonts, catalogue refs, slots in beats, transitions by name) that
  are compiled to schema-valid items; unknown fonts/refs snap to safe defaults; invalid
  items are skipped individually. JSON Schemas are passed for constrained decoding.
- **Reel ideas** for the top topics: LLM-written (hooks, shot list, caption, hashtags,
  suggested template) or, without an LLM, hook formulas + the best-matching template.
  `POST /api/trends/ideas` answers any other topic on demand (cached).

The LLM port (`llm-port.ts`) is implemented by `src/ai/llm`; `startServer({ llm })` wires
it. Until then the engine runs ranking + remixes + fallback ideas.

## The live pack

`livepack.ts` builds `trending-live` (version = date, `2026.11.20`): today's items first
(tagged `new` → "New today" badge), items from the last 14 days carried, max 24 per
collection. Items it borrows from the monthly trend pack (animations, effects, LUT looks,
hook presets) are copied in, because trend packs may only depend on themselves and
`essentials`. Validation = core zod schemas + `validatePacks` (refs, fonts/weights libass
can match, animation shapes, transition timing) + sanity rules (3–90 s templates,
≥ 200 ms slots, text length); failing or duplicate items are dropped with a reason
(`state.dropped`). Thumbnails are rendered with the build tool's FFmpeg/libass code at
concurrency 2. The pack is staged, then `packs/local/active.json` is swapped atomically.
The export pipeline resolves `trending-live/…` refs through the same pointer.

## Scheduling and resources

- Runs as a `trends` job in the queue's `ai` resource class at priority 200 (lowest), so
  it never overlaps another model and yields to everything interactive.
- At startup (after 90 s) when the last refresh is older than 24 h, and daily at
  `TRENDS_HOUR` (default 04:00), only when no export or AI job is queued or running.
  A failed attempt is retried at most hourly.
- Manual: Settings → Trends → Refresh now, or pull-to-refresh on Trending Now.

## Publishing (optional)

`PUBLISH_TRENDS=github` (plus the Settings toggle) commits the pack to the `trends` branch
of `PUBLISH_TRENDS_REPO` (default: the repo packs are pulled from) and opens or refreshes a
PR, through the owner's existing `gh` login and the Git Data API — the server's checkout is
never touched, ref updates are fast-forward only (`force: false`).
`PUBLISH_TRENDS_MODE=main` pushes to main instead. Maintainers run
`node scripts/build-packs.mjs` on the PR to index the pack.

## Configuration

| Env                                           | Default           | Meaning                       |
| --------------------------------------------- | ----------------- | ----------------------------- |
| `TRENDS`                                      | `true`            | enable the scheduler          |
| `TRENDS_REGION`                               | `US`              | country for regional charts   |
| `TRENDS_HOUR`                                 | `4`               | local hour of the daily run   |
| `YOUTUBE_API_KEY`                             | —                 | enables the YouTube source    |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET`   | —                 | enables the Reddit source     |
| `PUBLISH_TRENDS`                              | off               | `github` enables auto-publish |
| `PUBLISH_TRENDS_MODE` / `PUBLISH_TRENDS_REPO` | `pr` / packs repo | publish target                |

## HTTP API

- `GET /api/trends` → topics, formats, aesthetics, hashtags, sounds (name, artist, BPM,
  link, sources), generated items (ref, trend, createdAt, fresh), ideas, source status,
  settings. Auto Edit can pick "the latest matching template" from `items`.
- `POST /api/trends/refresh` → `202 { jobId }` (joins a running refresh).
- `POST /api/trends/ideas { topic }` → reel idea.
- `PUT /api/trends/settings { autoPublish }`.

## Measured (ThinkPad T15, Ryzen 7 PRO 8840U)

See the result table in the PR / `docs` for the latest numbers; reproduce with
`pnpm --filter @reelforge/server exec node test/trends/bench.ts`.
