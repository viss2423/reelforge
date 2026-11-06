/**
 * ReelForge project model — the single source of truth shared by the web editor,
 * the server, the preview engine and the export compiler.
 *
 * Conventions
 * - All times are integer MICROSECONDS (`Us`). 1 s = 1_000_000 us. Never floats.
 * - All spatial values are in OUTPUT pixels of the 1080x1920 canvas unless noted.
 *   (0,0) is top-left. Transform x/y is the clip's CENTER position.
 * - The model is plain JSON (no classes, no Dates) so it can be diffed, patched (Immer),
 *   persisted and sent over the wire as-is.
 * - Every object that can be selected in the UI has a stable string `id`.
 */
import { z } from 'zod'

export const SCHEMA_VERSION = 1 as const

/* ------------------------------------------------------------------ primitives */

export const Us = z.number().int().nonnegative()
export type Us = z.infer<typeof Us>
export const Id = z.string().min(1).max(64)
export type Id = z.infer<typeof Id>
export const HexColor = z.string().regex(/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/)
export type HexColor = z.infer<typeof HexColor>

export const Easing = z.enum([
  'linear',
  'easeIn',
  'easeOut',
  'easeInOut',
  'easeOutBack',
  'easeOutElastic',
  'hold',
])
export type Easing = z.infer<typeof Easing>

/** A keyframe; `t` is relative to the clip's timeline start. */
export const Keyframe = z.object({ t: Us, value: z.number(), easing: Easing.default('easeInOut') })
export type Keyframe = z.infer<typeof Keyframe>

/** A number that is either constant or animated by keyframes (sorted by t, unique t). */
export const Animatable = z.object({
  value: z.number(),
  keyframes: z.array(Keyframe).default([]),
})
export type Animatable = z.infer<typeof Animatable>

/* ------------------------------------------------------------------ settings */

/** Reels-only: the canvas is always 9:16. Resolution is chosen at export. */
export const ProjectSettings = z.object({
  width: z.literal(1080).default(1080),
  height: z.literal(1920).default(1920),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]).default(30),
  background: HexColor.default('#000000'),
  /** Optional blurred-fill behind letterboxed media (very common on Reels). */
  backgroundBlur: z.boolean().default(false),
})
export type ProjectSettings = z.infer<typeof ProjectSettings>

/* ------------------------------------------------------------------ transform & look */

export const Transform = z.object({
  x: Animatable.default({ value: 540, keyframes: [] }),
  y: Animatable.default({ value: 960, keyframes: [] }),
  /** 1 = the "fit" size given by `fit`. */
  scale: Animatable.default({ value: 1, keyframes: [] }),
  /** Degrees, clockwise. */
  rotation: Animatable.default({ value: 0, keyframes: [] }),
  /** 0..1 */
  opacity: Animatable.default({ value: 1, keyframes: [] }),
  flipH: z.boolean().default(false),
  flipV: z.boolean().default(false),
})
export type Transform = z.infer<typeof Transform>

/** Source crop in normalized 0..1 coordinates of the source frame. */
export const Crop = z.object({
  left: z.number().min(0).max(1).default(0),
  top: z.number().min(0).max(1).default(0),
  right: z.number().min(0).max(1).default(0),
  bottom: z.number().min(0).max(1).default(0),
})
export type Crop = z.infer<typeof Crop>

/** Colour adjustments. All default to neutral (0). Ranges are -100..100 unless noted. */
export const Adjustments = z.object({
  brightness: z.number().min(-100).max(100).default(0),
  contrast: z.number().min(-100).max(100).default(0),
  saturation: z.number().min(-100).max(100).default(0),
  exposure: z.number().min(-100).max(100).default(0),
  temperature: z.number().min(-100).max(100).default(0),
  tint: z.number().min(-100).max(100).default(0),
  highlights: z.number().min(-100).max(100).default(0),
  shadows: z.number().min(-100).max(100).default(0),
  vibrance: z.number().min(-100).max(100).default(0),
  /** 0..100 */
  sharpen: z.number().min(0).max(100).default(0),
  /** 0..100 */
  vignette: z.number().min(0).max(100).default(0),
  /** 0..100 */
  grain: z.number().min(0).max(100).default(0),
  /** 0..100 */
  blur: z.number().min(0).max(100).default(0),
})
export type Adjustments = z.infer<typeof Adjustments>

/** A colour filter = LUT from a trend pack, mixed at `intensity`. */
export const FilterRef = z.object({
  /** `<packId>/<filterId>` */
  ref: z.string(),
  /** 0..1 */
  intensity: z.number().min(0).max(1).default(1),
})
export type FilterRef = z.infer<typeof FilterRef>

/** Transitions are attached to the INCOMING clip on the main track. */
export const TransitionType = z.enum([
  'fade',
  'fadeblack',
  'fadewhite',
  'dissolve',
  'wipeleft',
  'wiperight',
  'wipeup',
  'wipedown',
  'slideleft',
  'slideright',
  'slideup',
  'slidedown',
  'smoothleft',
  'smoothright',
  'smoothup',
  'smoothdown',
  'circleopen',
  'circleclose',
  'zoomin',
  'pixelize',
  'radial',
  'hblur',
  'squeezeh',
  'squeezev',
  'whip', // trend: fast whip-pan (directional motion blur + slide)
  'flash', // trend: white flash cut
  'glitch', // trend: RGB-split glitch
  'spin', // trend: rotational zoom
])
export type TransitionType = z.infer<typeof TransitionType>

export const Transition = z.object({
  type: TransitionType,
  /** Overlap with the previous clip. Must be <= half of either clip's duration. */
  duration: Us.min(50_000).max(3_000_000).default(400_000),
})
export type Transition = z.infer<typeof Transition>

/** Animated "effects" applied over a clip (shake, zoom pulse, rgb split...). From packs. */
export const EffectRef = z.object({
  id: Id,
  /** `<packId>/<effectId>` */
  ref: z.string(),
  /** Effect window relative to clip start; defaults to whole clip. */
  start: Us.default(0),
  duration: Us.optional(),
  intensity: z.number().min(0).max(1).default(1),
})
export type EffectRef = z.infer<typeof EffectRef>

export const ChromaKey = z.object({
  enabled: z.boolean().default(false),
  color: HexColor.default('#00ff00'),
  similarity: z.number().min(0).max(1).default(0.3),
  blend: z.number().min(0).max(1).default(0.1),
})
export type ChromaKey = z.infer<typeof ChromaKey>

/* ------------------------------------------------------------------ audio */

export const AudioProps = z.object({
  /** Linear gain 0..4 (1 = unity). */
  volume: z.number().min(0).max(4).default(1),
  muted: z.boolean().default(false),
  fadeIn: Us.default(0),
  fadeOut: Us.default(0),
  /** RNNoise-based voice clean-up. */
  denoise: z.boolean().default(false),
  /** Voice enhance: EQ + compression preset. */
  enhanceVoice: z.boolean().default(false),
  /** Keep pitch when speed != 1. */
  preservePitch: z.boolean().default(true),
})
export type AudioProps = z.infer<typeof AudioProps>

/* ------------------------------------------------------------------ text styling */

export const TextAnimation = z.object({
  /** `<packId>/<animationId>` or a builtin id such as `builtin/pop`. */
  ref: z.string(),
  duration: Us.default(400_000),
})
export type TextAnimation = z.infer<typeof TextAnimation>

export const TextStyle = z.object({
  fontFamily: z.string().default('Montserrat'),
  fontWeight: z.number().int().min(100).max(900).default(800),
  italic: z.boolean().default(false),
  fontSize: z.number().min(8).max(400).default(72),
  color: HexColor.default('#FFFFFF'),
  /** Outline (stroke) */
  strokeColor: HexColor.default('#000000'),
  strokeWidth: z.number().min(0).max(40).default(6),
  shadowColor: HexColor.default('#00000099'),
  shadowBlur: z.number().min(0).max(40).default(0),
  shadowX: z.number().min(-50).max(50).default(0),
  shadowY: z.number().min(-50).max(50).default(4),
  /** Box behind text */
  backgroundColor: HexColor.optional(),
  backgroundPadding: z.number().min(0).max(80).default(16),
  backgroundRadius: z.number().min(0).max(80).default(12),
  align: z.enum(['left', 'center', 'right']).default('center'),
  letterSpacing: z.number().min(-20).max(60).default(0),
  lineHeight: z.number().min(0.6).max(3).default(1.1),
  uppercase: z.boolean().default(false),
  /** Max text box width in px; text wraps beyond it. */
  maxWidth: z.number().min(100).max(1080).default(900),
})
export type TextStyle = z.infer<typeof TextStyle>

/** Caption style: TextStyle + word-level emphasis behaviour (Hormozi/MrBeast-style captions). */
export const CaptionStyle = z.object({
  base: TextStyle,
  /** Colour applied to the currently spoken word. */
  activeColor: HexColor.default('#FFE400'),
  /** Optional box behind the active word. */
  activeBackgroundColor: HexColor.optional(),
  /** Scale of the active word (1 = none). */
  activeScale: z.number().min(1).max(2).default(1.15),
  /** How words appear. */
  mode: z.enum(['karaoke', 'word-by-word', 'line', 'pop', 'bounce', 'typewriter']).default('karaoke'),
  maxWordsPerLine: z.number().int().min(1).max(12).default(3),
  maxLines: z.number().int().min(1).max(3).default(1),
  /** Vertical anchor of the caption block, in px (center). */
  y: z.number().min(0).max(1920).default(1300),
  /** Highlight emojis / keywords automatically (keyword colouring). */
  emphasizeKeywords: z.boolean().default(true),
  keywordColor: HexColor.default('#00E5FF'),
})
export type CaptionStyle = z.infer<typeof CaptionStyle>

/* ------------------------------------------------------------------ clips */

const ClipBase = z.object({
  id: Id,
  /** Position on the timeline. */
  start: Us,
  /** Duration on the timeline (after speed is applied). */
  duration: Us.min(1),
  /** Optional user label */
  name: z.string().max(200).optional(),
})

/** Video or still image placed on a visual track. */
export const MediaClip = ClipBase.extend({
  type: z.enum(['video', 'image']),
  assetId: Id,
  /** Source in-point (video only). */
  in: Us.default(0),
  /** Playback speed 0.1..16. Timeline duration = source span / speed. */
  speed: z.number().min(0.1).max(16).default(1),
  /** Optional speed ramp (value = speed multiplier) — keyframes over clip time. */
  speedRamp: z.array(Keyframe).default([]),
  reverse: z.boolean().default(false),
  fit: z.enum(['cover', 'contain', 'fill']).default('cover'),
  transform: Transform.default(Transform.parse({})),
  crop: Crop.default(Crop.parse({})),
  adjustments: Adjustments.default(Adjustments.parse({})),
  filter: FilterRef.optional(),
  effects: z.array(EffectRef).default([]),
  chromaKey: ChromaKey.optional(),
  /** Transition INTO this clip from the previous clip on the main track. */
  transitionIn: Transition.optional(),
  /** Audio embedded in the video. */
  audio: AudioProps.default(AudioProps.parse({})),
  /** Blend mode for overlay tracks. */
  blendMode: z.enum(['normal', 'screen', 'multiply', 'overlay', 'lighten', 'darken', 'add']).default('normal'),
  /** Ken-Burns style auto motion for images. */
  autoMotion: z.enum(['none', 'zoomIn', 'zoomOut', 'panLeft', 'panRight']).default('none'),
})
export type MediaClip = z.infer<typeof MediaClip>

export const AudioClip = ClipBase.extend({
  type: z.literal('audio'),
  assetId: Id,
  in: Us.default(0),
  speed: z.number().min(0.1).max(16).default(1),
  audio: AudioProps.default(AudioProps.parse({})),
  /** Automatically lower this clip under speech on other tracks. */
  duckUnderVoice: z.boolean().default(false),
  role: z.enum(['music', 'voiceover', 'sfx']).default('music'),
})
export type AudioClip = z.infer<typeof AudioClip>

export const TextClip = ClipBase.extend({
  type: z.literal('text'),
  text: z.string().max(2000),
  /** Optional preset ref the style originated from (`<packId>/<presetId>`). */
  presetRef: z.string().optional(),
  style: TextStyle.default(TextStyle.parse({})),
  transform: Transform.default(Transform.parse({})),
  animationIn: TextAnimation.optional(),
  animationOut: TextAnimation.optional(),
  animationLoop: TextAnimation.optional(),
})
export type TextClip = z.infer<typeof TextClip>

/** Sticker / emoji / shape (image asset or pack sticker), always on an overlay track. */
export const StickerClip = ClipBase.extend({
  type: z.literal('sticker'),
  /** Either a user asset or a pack sticker ref. */
  assetId: Id.optional(),
  ref: z.string().optional(),
  transform: Transform.default(Transform.parse({})),
  animationIn: TextAnimation.optional(),
  animationOut: TextAnimation.optional(),
})
export type StickerClip = z.infer<typeof StickerClip>

export const Clip = z.discriminatedUnion('type', [
  MediaClip,
  AudioClip,
  TextClip,
  StickerClip,
])
export type Clip = z.infer<typeof Clip>

/* ------------------------------------------------------------------ captions */

export const Word = z.object({
  text: z.string(),
  start: Us,
  end: Us,
  /** Whisper confidence 0..1 */
  confidence: z.number().min(0).max(1).default(1),
  /** Marked as filler ("um", "uh", ...) by the AI pass. */
  filler: z.boolean().default(false),
  /** Emphasised keyword (bigger / coloured). */
  emphasis: z.boolean().default(false),
  emoji: z.string().optional(),
})
export type Word = z.infer<typeof Word>

/** Captions are in TIMELINE time (already mapped through cuts/speed). */
export const Captions = z.object({
  enabled: z.boolean().default(true),
  language: z.string().default('auto'),
  words: z.array(Word).default([]),
  /** `<packId>/<styleId>` the style originated from */
  styleRef: z.string().optional(),
  style: CaptionStyle,
})
export type Captions = z.infer<typeof Captions>

/* ------------------------------------------------------------------ tracks */

/**
 * Track kinds:
 * - `main`    exactly one; magnetic (clips are contiguous from 0, no gaps, no overlaps);
 *             only MediaClips; supports transitions.
 * - `overlay` picture-in-picture / stickers / b-roll; free placement; MediaClip | StickerClip.
 * - `text`    TextClips; free placement.
 * - `audio`   AudioClips; free placement.
 * Within a non-main track clips must not overlap. Visual stacking: tracks later in the
 * array are drawn on top. Captions are always drawn above everything.
 */
export const TrackKind = z.enum(['main', 'overlay', 'text', 'audio'])
export type TrackKind = z.infer<typeof TrackKind>

export const Track = z.object({
  id: Id,
  kind: TrackKind,
  name: z.string().max(100).default(''),
  muted: z.boolean().default(false),
  hidden: z.boolean().default(false),
  locked: z.boolean().default(false),
  clips: z.array(Clip).default([]),
})
export type Track = z.infer<typeof Track>

export const Marker = z.object({
  id: Id,
  t: Us,
  kind: z.enum(['beat', 'scene', 'user']).default('user'),
  label: z.string().max(100).optional(),
})
export type Marker = z.infer<typeof Marker>

/* ------------------------------------------------------------------ project */

export const Project = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  id: Id,
  name: z.string().min(1).max(200),
  createdAt: z.string(), // ISO-8601
  updatedAt: z.string(), // ISO-8601
  /** Monotonic revision for optimistic concurrency between devices. */
  revision: z.number().int().nonnegative().default(0),
  settings: ProjectSettings.default(ProjectSettings.parse({})),
  tracks: z.array(Track),
  captions: Captions.optional(),
  markers: z.array(Marker).default([]),
  /** Template this project was created from (`<packId>/<templateId>`). */
  templateRef: z.string().optional(),
})
export type Project = z.infer<typeof Project>

/* ------------------------------------------------------------------ assets (server-owned) */

export const AssetKind = z.enum(['video', 'image', 'audio'])
export type AssetKind = z.infer<typeof AssetKind>

/** Metadata about an uploaded media file. Owned by the server; read-only for the client. */
export const Asset = z.object({
  id: Id,
  kind: AssetKind,
  name: z.string(),
  size: z.number().int().nonnegative(),
  mime: z.string(),
  createdAt: z.string(),
  /** Probe results */
  duration: Us.optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  fps: z.number().optional(),
  rotation: z.number().optional(),
  hasAudio: z.boolean().default(false),
  hasVideo: z.boolean().default(false),
  videoCodec: z.string().optional(),
  audioCodec: z.string().optional(),
  /** Processing state of derived files */
  proxy: z.enum(['pending', 'processing', 'ready', 'failed', 'not-needed']).default('pending'),
  thumbnails: z.enum(['pending', 'ready', 'failed']).default('pending'),
  waveform: z.enum(['pending', 'ready', 'failed', 'not-needed']).default('pending'),
  /** Cached AI analysis */
  transcript: z.array(Word).optional(),
  beats: z.array(Us).optional(),
  scenes: z.array(Us).optional(),
})
export type Asset = z.infer<typeof Asset>

/* ------------------------------------------------------------------ export */

export const ExportSettings = z.object({
  resolution: z.enum(['720p', '1080p', '1440p', '2160p']).default('1080p'),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]).optional(),
  codec: z.enum(['h264', 'hevc', 'av1']).default('h264'),
  /** 'auto' prefers GPU (AMF/NVENC/QSV/VideoToolbox) and falls back to CPU. */
  encoder: z.enum(['auto', 'gpu', 'cpu']).default('auto'),
  quality: z.enum(['draft', 'standard', 'high', 'max']).default('high'),
  /** Integrated loudness target for platforms (Reels/TikTok ≈ -14 LUFS). */
  loudnessTarget: z.number().min(-30).max(-5).default(-14),
  normalizeLoudness: z.boolean().default(true),
  /** Optional range export */
  range: z.object({ start: Us, end: Us }).optional(),
})
export type ExportSettings = z.infer<typeof ExportSettings>

/* ------------------------------------------------------------------ jobs */

export const JobKind = z.enum([
  'probe',
  'proxy',
  'thumbnails',
  'waveform',
  'export',
  'transcribe',
  'silence',
  'beats',
  'scenes',
  'reframe',
  'denoise',
  'preview',
])
export type JobKind = z.infer<typeof JobKind>

export const JobStatus = z.enum(['queued', 'running', 'done', 'failed', 'cancelled'])
export type JobStatus = z.infer<typeof JobStatus>

export const Job = z.object({
  id: Id,
  kind: JobKind,
  status: JobStatus,
  /** 0..1 */
  progress: z.number().min(0).max(1).default(0),
  /** Human status line ("Encoding 512/900 frames · 2.4x") */
  message: z.string().optional(),
  projectId: Id.optional(),
  assetId: Id.optional(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  error: z.string().optional(),
  /** Kind-specific result payload (e.g. export output id, transcript words). */
  result: z.unknown().optional(),
  /** ETA in microseconds */
  eta: Us.optional(),
})
export type Job = z.infer<typeof Job>

/* ------------------------------------------------------------------ realtime events (server -> client, WebSocket) */

export const ServerEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('job'), job: Job }),
  z.object({ type: z.literal('asset'), asset: Asset }),
  z.object({
    type: z.literal('project'),
    projectId: Id,
    revision: z.number().int(),
    /** Device id that made the change, so it can ignore its own echo. */
    origin: z.string(),
  }),
  z.object({ type: z.literal('packs'), version: z.string() }),
  z.object({ type: z.literal('hello'), serverVersion: z.string(), deviceId: z.string() }),
])
export type ServerEvent = z.infer<typeof ServerEvent>
