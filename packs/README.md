# ReelForge trend packs

Everything ReelForge offers out of the box that is _content_ rather than code lives here:
caption styles, text presets, animations, colour looks (LUTs), transition and effect
presets, stickers, reel templates and the fonts they use. Packs are plain JSON plus a few
small asset files, so keeping ReelForge current is a pull request, not a release.

```
packs/
  index.json                    PackIndex: pack versions + every font file (sha256/size)
  fonts/<Family>/*.ttf          static TTFs shared by all packs (+ OFL.txt / LICENSE.txt)
  essentials/                   timeless basics, the base pack every other pack may use
    pack.json                   PackManifest (schema: packages/core/src/packs.ts)
    luts/<id>.cube              33³ 3D LUTs referenced by filters
    stickers/<id>.png           RGBA stickers with transparent backgrounds
    thumbs/<kind>-<id>.webp     generated previews (filters, captions, text, templates)
  trending-2026-11/             what feeds look like right now (same layout)
```

Refs everywhere are `<packId>/<itemId>` (for example `essentials/teal-orange`); text
animations may also use core's builtins, `builtin/<id>`.

## How packs auto-update

1. Every ReelForge server polls `packs/index.json` from this repository (every 6 hours by
   default, and on demand via `POST /api/packs/sync`).
2. `index.json.version` is content-addressed (`<curation date>+<hash>`): it changes when, and
   only when, any pack manifest, index entry or font file changes.
3. For each pack whose `version` differs from the local copy, the server downloads
   `pack.json` and every file in its `files[]`, verifies each sha256 and size, validates the
   manifest with the core zod schemas, then swaps the new folder in atomically. A bad
   download never replaces a working pack.
4. The web app picks up the new manifests on its next `/api/packs` request; items are sorted
   by `trendScore`, so fresh trends float to the top.

Because clients verify hashes, `files[]` and `index.json` must always match the bytes in the
repo. Never edit them by hand: `scripts/build-packs.mjs` owns them.

## Build tool

```sh
node scripts/build-packs.mjs              # recompute files[], thumbs, sticker sizes, index.json; validate
node scripts/build-packs.mjs --generate   # also regenerate LUTs, stickers and thumbnails (needs FFmpeg
                                          # with libass + libwebp) and prove libass resolves every font
node scripts/build-packs.mjs --check      # CI: validate and fail if anything is out of date; writes nothing
```

The build is deterministic: the same inputs produce byte-identical outputs (LUTs and
stickers are pure arithmetic, thumbnails are rendered with FFmpeg's bitexact flags), so a
regenerate on any machine leaves a clean `git status`. Generation runs on a worker pool;
on the reference laptop (Ryzen 7 8840U) a full `--generate` takes about 14 s.

Validation fails loudly on: schema errors, duplicate or non-slug ids, unresolved or
cross-pack refs (a trend pack may reference itself and `essentials`, never another trend
pack), animation refs of the wrong kind, malformed animations (`in` must end at the resting
pose, `out` must start from it, `loops` must be seamless), transitions outside
50 ms–3 s or longer than half a neighbouring template slot, invalid LUTs, non-RGBA
stickers, fonts whose family name or weight libass would not match, missing font
weights, unreferenced files and stale derived data. `packages/core/test/packs-content.test.ts`
re-checks all of it independently in the normal test run.

Generators live in `scripts/lib-packs/`:

| File                           | Produces                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| `luts.mjs`                     | every look as a list of colour ops (white balance, curves, split tone, fade…) → `.cube`  |
| `stickers.mjs`, `raster.mjs`   | sticker recipes drawn with a tiny anti-aliased vector rasteriser                         |
| `png.mjs`                      | dependency-free deterministic PNG encoder                                                |
| `scene.mjs`, `thumbs.mjs`      | a synthetic test scene, then FFmpeg `lut3d` / `ass` renders → WebP thumbnails            |
| `ass-preview.mjs`              | ASS subtitle files that preview caption styles and text presets with the real fonts      |
| `fontcheck.mjs`, `ttf.mjs`     | reads each font's name table and asks libass which face it picks for every family/weight |
| `fonts.py`                     | maintainers only: fetches fonts from google/fonts at a pinned commit and cuts statics    |
| `generate.mjs`, `validate.mjs` | the worker pool and the semantic validator used by `build-packs.mjs`                     |

## Contributing a trend

Spotted a caption style, transition or edit format taking over the feed? Add it.

1. Pick the pack: evergreen basics go in `essentials`; anything current goes in the newest
   `trending-YYYY-MM` pack. Start a new month's pack by copying the folder, renaming its
   `id`, `name` and `curatedAt`, and resetting `version` to `1.0.0`.
2. Edit `pack.json` (hand-edited source; keep each array in a sensible order). For a new
   look, add its colour ops to `LOOKS` in `scripts/lib-packs/luts.mjs`; for a new sticker,
   add a recipe to `STICKERS` in `scripts/lib-packs/stickers.mjs`.
3. Run `node scripts/build-packs.mjs --generate`, then `pnpm --filter @reelforge/core test`.
4. Bump the pack's `version` (patch for tweaks, minor for new items, major for removals or
   renamed ids, which break saved projects that reference them).

PR checklist:

- [ ] Content is **original**. Describe a trend generically ("Bold Podcast", "Photo Dump");
      never copy a proprietary template, branded style, logo, creator name or platform
      name, and never ship audio — templates only carry a `musicHint` (mood + BPM).
- [ ] `trendScore` is honest: 90+ is everywhere right now, 70–89 rising or common, 50–69
      steady, below 50 niche or fading. Lower the scores of items that have cooled off.
- [ ] Template slot durations are whole beats at the suggested BPM
      (`round(n × 60 000 000 / bpm)` µs) so cuts land on the beat.
- [ ] Styles use only font families and weights shipped in `packs/fonts` (see `index.json`).
- [ ] `node scripts/build-packs.mjs --check` and the core tests pass; the regenerated
      thumbnails look right.
- [ ] Times are integer microseconds; ids are lowercase slugs and never reused for
      something different.

## Fonts

Fonts are static TTFs from [google/fonts](https://github.com/google/fonts) at a pinned
commit (Playfair Display from Google Fonts' versioned static builds). Families published
only as variable fonts are cut into static instances, and every file of a family is
normalised to the same legacy family name (name ID 1) with the weight in
`OS/2.usWeightClass`, which is exactly what libass matches on. Shipped weights:

| Family                                                                            | Weights                       |
| --------------------------------------------------------------------------------- | ----------------------------- |
| Montserrat, Poppins                                                               | 400, 600, 700, 800, 900       |
| Inter                                                                             | 400, 600, 800                 |
| Oswald                                                                            | 400, 600, 700                 |
| Roboto, Rubik                                                                     | 400, 700, 900                 |
| Playfair Display                                                                  | 400, 700 (upright and italic) |
| Caveat                                                                            | 400, 700                      |
| Anton, Archivo Black, Bangers, Bebas Neue, Lilita One, Pacifico, Permanent Marker | 400                           |

To add a weight or family, extend `scripts/lib-packs/fonts.py`, run it, and keep the total
under 20 MB.

## Licensing

- Pack content (manifests, LUTs, stickers, thumbnails, templates) is original work released
  under [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/): use it anywhere,
  no attribution required. Contributions are accepted under the same terms.
- Fonts keep their own licences, shipped next to each family: SIL Open Font License 1.1
  (`OFL.txt`) for all families except Permanent Marker, which is Apache-2.0
  (`LICENSE.txt`), as published upstream.
