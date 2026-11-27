/**
 * Tempo helpers. Charts rarely publish BPM, so a sound without a measured tempo gets the
 * typical tempo of its genre (the centre of the genre's common range, with hip-hop/latin
 * counted at the half-time feel short-form edits cut to). Template slots are always whole
 * beats so cuts land on the beat.
 */

const GENRE_BPM: ReadonlyArray<readonly [RegExp, number]> = [
  [/hip.?hop|rap|trap|drill/i, 92],
  [/r&b|soul/i, 96],
  [/reggaeton|latin|afro/i, 96],
  [/dance|electronic|edm|house/i, 124],
  [/k-?pop/i, 122],
  [/rock|metal|punk/i, 126],
  [/alternative|indie/i, 118],
  [/country/i, 112],
  [/singer|songwriter|folk|acoustic/i, 100],
  [/holiday|christmas/i, 112],
  [/jazz|blues/i, 104],
  [/soundtrack|classical|ambient/i, 90],
  [/pop/i, 118],
]

export const DEFAULT_BPM = 120

/** Typical tempo of a genre name (Apple/Deezer genre strings); DEFAULT_BPM when unknown. */
export const genreBpm = (genre: string | undefined): number => {
  if (!genre) return DEFAULT_BPM
  return GENRE_BPM.find(([re]) => re.test(genre))?.[1] ?? DEFAULT_BPM
}

/** Folds a tempo into the 80–160 BPM band edits are cut in (doubling/halving). */
export const editTempo = (bpm: number): number => {
  let b = bpm
  while (b < 80) b *= 2
  while (b > 160) b /= 2
  return Math.round(b * 10) / 10
}

/** Duration of `beats` beats at `bpm`, in integer microseconds. */
export const beatsUs = (beats: number, bpm: number): number =>
  Math.round((beats * 60_000_000) / bpm)
