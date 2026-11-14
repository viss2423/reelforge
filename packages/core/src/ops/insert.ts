/** Clip insertion ops. */
import {
  AudioClip,
  MediaClip,
  StickerClip,
  TextClip,
  TextStyle,
  type Asset,
  type Project,
  type Track,
  type TrackKind,
  type Us,
} from '../schema.ts'
import { newId } from '../ids.ts'
import { OpError, clone } from './errors.ts'
import { assertUnlocked, defaultTrack, getTrack, minClipDuration, placeClip } from './project.ts'
import { editMain, mainIndexAt } from './main.ts'

/** Default length of stills, text and stickers. */
export const DEFAULT_STILL_DURATION: Us = 3_000_000

/** Parse with schema defaults, then deep-copy so no default object is shared between clips. */
export const makeMediaClip = (input: Record<string, unknown>): MediaClip =>
  clone(MediaClip.parse(input))

function trackOfKind(p: Project, trackId: string | undefined, kind: Exclude<TrackKind, 'main'>) {
  if (trackId === undefined) return defaultTrack(p, kind)
  const track = getTrack(p, trackId)
  if (track.kind !== kind) {
    throw new OpError('track_kind', `track ${trackId} is a ${track.kind} track, expected ${kind}`)
  }
  return track
}

function checkDuration(p: Project, d: Us): void {
  if (!Number.isFinite(d) || d < minClipDuration(p.settings.fps)) {
    throw new OpError('too_short', `clip duration ${d}µs is shorter than one frame`)
  }
}

/**
 * Insert a video/image asset. Main track: inserted at `index` (or at the boundary nearest to
 * playback time `at`, default: end) and the track ripples. Overlay track: placed at `at`
 * (default 0) on the first track with room (see placeClip).
 */
export function insertMediaClip(
  p: Project,
  args: { trackId: string; asset: Asset; at?: Us; index?: number; duration?: Us },
): MediaClip {
  const { asset } = args
  const track = getTrack(p, args.trackId)
  if (track.kind !== 'main' && track.kind !== 'overlay') {
    throw new OpError('track_kind', `media clips go on the main or an overlay track`)
  }
  if (asset.kind === 'audio') throw new OpError('asset_kind', 'use insertAudioClip for audio')
  let duration: Us
  if (asset.kind === 'video') {
    if (!asset.duration) throw new OpError('asset_not_ready', `asset ${asset.id} has no duration`)
    duration = Math.min(args.duration ?? asset.duration, asset.duration)
  } else duration = args.duration ?? DEFAULT_STILL_DURATION
  checkDuration(p, duration)

  const clip = makeMediaClip({
    id: newId('c_'),
    type: asset.kind,
    assetId: asset.id,
    start: args.at ?? 0,
    duration,
    name: asset.name.slice(0, 200),
  })
  if (track.kind === 'main') {
    assertUnlocked(track)
    editMain(p, () => {
      const index =
        args.index ?? (args.at !== undefined ? mainIndexAt(p, args.at) : track.clips.length)
      track.clips.splice(Math.max(0, Math.min(index, track.clips.length)), 0, clip)
    })
  } else placeClip(p, track, clip)
  return clip
}

/** Insert an audio asset (or the audio of a video asset) at playback time `at`. */
export function insertAudioClip(
  p: Project,
  args: { trackId?: string; asset: Asset; at: Us; role?: AudioClip['role'] },
): AudioClip {
  const { asset } = args
  if (asset.kind === 'image' || (asset.kind === 'video' && !asset.hasAudio)) {
    throw new OpError('asset_kind', `asset ${asset.id} has no audio`)
  }
  if (!asset.duration) throw new OpError('asset_not_ready', `asset ${asset.id} has no duration`)
  checkDuration(p, asset.duration)
  const clip = clone(
    AudioClip.parse({
      id: newId('c_'),
      type: 'audio',
      assetId: asset.id,
      start: Math.max(0, args.at),
      duration: asset.duration,
      role: args.role ?? 'music',
      name: asset.name.slice(0, 200),
    }),
  )
  placeClip(p, trackOfKind(p, args.trackId, 'audio'), clip)
  return clip
}

/** Insert a text clip at playback time `at`. */
export function insertTextClip(
  p: Project,
  args: {
    trackId?: string
    at: Us
    duration?: Us
    text: string
    style?: Partial<TextStyle>
    presetRef?: string
  },
): TextClip {
  const duration = args.duration ?? DEFAULT_STILL_DURATION
  checkDuration(p, duration)
  const clip = clone(
    TextClip.parse({
      id: newId('c_'),
      type: 'text',
      start: Math.max(0, args.at),
      duration,
      text: args.text,
      style: TextStyle.parse(args.style ?? {}),
      ...(args.presetRef !== undefined && { presetRef: args.presetRef }),
    }),
  )
  placeClip(p, trackOfKind(p, args.trackId, 'text'), clip)
  return clip
}

/** Insert a sticker (user image asset or pack sticker ref) on an overlay track. */
export function insertStickerClip(
  p: Project,
  args: { trackId?: string; at: Us; duration?: Us; assetId?: string; ref?: string },
): StickerClip {
  if (args.assetId === undefined && args.ref === undefined) {
    throw new OpError('sticker_source', 'a sticker needs an assetId or a pack ref')
  }
  const duration = args.duration ?? DEFAULT_STILL_DURATION
  checkDuration(p, duration)
  const clip = clone(
    StickerClip.parse({
      id: newId('c_'),
      type: 'sticker',
      start: Math.max(0, args.at),
      duration,
      ...(args.assetId !== undefined && { assetId: args.assetId }),
      ...(args.ref !== undefined && { ref: args.ref }),
    }),
  )
  const track: Track = trackOfKind(p, args.trackId, 'overlay')
  placeClip(p, track, clip)
  return clip
}
