/** Speed: log-scale constant speed, speed-curve presets and preserve pitch. */
import type { AudioClip, MediaClip } from '@reelforge/core'
import { baseGesture, edit } from '../model/commands.ts'
import { setAudio, setSpeed, setSpeedCurve } from '../model/edits.ts'
import { isVideo } from '../model/draft.ts'
import {
  detectCurve,
  formatSpeed,
  positionToSpeed,
  SPEED_CURVES,
  speedToPosition,
  type CurveId,
} from '../model/speed.ts'
import { Advanced, Chips, HeroSlider, Section, Tile, Toggle } from '../ui.tsx'

/** One-tap speeds under the slider. */
const PRESETS = [0.5, 1, 1.5, 2, 3].map((s) => ({ value: String(s), label: formatSpeed(s) }))

/** Tiny SVG sparkline of a curve preset (tile preview). */
function CurveGlyph({ id }: { id: CurveId | 'none' }) {
  const curve = SPEED_CURVES.find((c) => c.id === id)
  const pts = curve?.points ?? [
    { u: 0, r: 1 },
    { u: 1, r: 1 },
  ]
  const max = Math.max(...pts.map((p) => p.r))
  const y = (r: number) => 34 - (r / max) * 26
  const d = pts
    .map((p, i) => {
      const x = 4 + p.u * 56
      if (i > 0 && p.e === 'hold') {
        const prev = pts[i - 1]!
        return `L${x},${y(prev.r)} L${x},${y(p.r)}`
      }
      return `${i === 0 ? 'M' : 'L'}${x},${y(p.r)}`
    })
    .join(' ')
  return (
    <svg viewBox="0 0 64 40" className="w-4/5 text-accent" aria-hidden>
      <path d={d} fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinejoin="round" />
    </svg>
  )
}

export function SpeedSection({ clip }: { clip: MediaClip | AudioClip }) {
  const speedHandlers = baseGesture<number>('Speed', (d, pos) =>
    setSpeed(d, clip.id, positionToSpeed(pos)),
  )
  const video = isVideo(clip) ? clip : undefined
  const active = video ? detectCurve(video.speedRamp, video.duration, video.speed) : 'none'
  return (
    <>
      <Section title="Speed">
        <HeroSlider
          label="Speed"
          display={formatSpeed(clip.speed)}
          value={speedToPosition(clip.speed)}
          min={0}
          max={1}
          step={0.001}
          defaultValue={speedToPosition(1)}
          format={(p) => formatSpeed(positionToSpeed(p))}
          {...speedHandlers}
        />
        <Chips
          label="Speed presets"
          options={PRESETS}
          value={PRESETS.find((p) => Number(p.value) === clip.speed)?.value}
          onChange={(v) => edit('Speed', (d) => setSpeed(d, clip.id, Number(v)))}
        />
        <Advanced id="speed">
          <Toggle
            label="Preserve pitch"
            description="Natural voices at any speed"
            checked={clip.audio.preservePitch}
            onChange={(on) =>
              edit('Preserve pitch', (d) => setAudio(d, [clip.id], { preservePitch: on }))
            }
          />
        </Advanced>
      </Section>
      {video && (
        <Section title="Speed curve">
          <div
            role="group"
            aria-label="Speed curves"
            className="-mx-4 grid auto-cols-[5.25rem] grid-flow-col gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:grid-flow-row sm:grid-cols-7 sm:px-0"
          >
            <Tile
              label="None"
              aspect="wide"
              selected={active === 'none'}
              onClick={() => edit('Speed curve', (d) => setSpeedCurve(d, clip.id, 'none'))}
            >
              <CurveGlyph id="none" />
            </Tile>
            {SPEED_CURVES.map((c) => (
              <Tile
                key={c.id}
                label={c.name}
                aspect="wide"
                selected={active === c.id}
                onClick={() => edit('Speed curve', (d) => setSpeedCurve(d, clip.id, c.id))}
              >
                <CurveGlyph id={c.id} />
              </Tile>
            ))}
          </div>
        </Section>
      )}
    </>
  )
}
