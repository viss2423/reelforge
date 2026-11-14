import { describe, expect, it } from 'vitest'
import { HARD_RESYNC_US, PlaybackClock, audioOutputTime } from './clock.ts'
import { AdaptiveQuality, LEVELS, LOW_WIDTH } from './quality.ts'

describe('PlaybackClock', () => {
  it('runs on the performance clock without a master', () => {
    const c = new PlaybackClock()
    c.start(1_000_000, 100)
    expect(c.tick(116.5)).toBe(1_016_500)
    expect(c.tick(150)).toBe(1_050_000)
    expect(c.stop()).toBe(1_050_000)
    expect(c.tick(500)).toBe(1_050_000) // stopped: frozen
  })

  it('converges on a master that runs fast or slow (drift correction)', () => {
    for (const drift of [1.002, 0.998]) {
      const c = new PlaybackClock()
      c.start(0, 0, 10)
      let perf = 0
      let t = 0
      for (let i = 0; i < 600; i++) {
        perf += 1000 / 60
        t = c.tick(perf, 10 + (perf / 1000) * drift)
      }
      const master = (perf / 1000) * drift * 1e6
      expect(Math.abs(t - master)).toBeLessThan(1500) // within ~1.5 ms after 10 s
    }
  })

  it('smooths a coarse, stepping audio clock and stays monotonic', () => {
    const c = new PlaybackClock()
    c.start(0, 0, 0)
    let perf = 0
    let prev = -1
    let maxStepDev = 0
    for (let i = 0; i < 300; i++) {
      perf += 1000 / 60
      // audio clock that only advances in 40 ms chunks
      const audio = Math.floor(perf / 40) * 0.04
      const t = c.tick(perf, audio)
      expect(t).toBeGreaterThanOrEqual(prev)
      if (i > 30) maxStepDev = Math.max(maxStepDev, Math.abs(t - prev - 16_667))
      prev = t
    }
    // a raw 40 ms-step clock would produce steps of 0 or 40 000 us
    expect(maxStepDev).toBeLessThan(8_000)
  })

  it('hard-resyncs on large errors and re-anchors on seek', () => {
    const c = new PlaybackClock()
    c.start(0, 0, 5)
    c.tick(16, 5.016)
    // master jumps ahead (device switch / stall)
    expect(c.tick(32, 5.5)).toBe(500_000)
    expect(HARD_RESYNC_US).toBeLessThan(500_000)
    c.seek(3_000_000, 40, 7)
    expect(c.tick(56, 7.016)).toBe(3_016_000)
  })

  it('holds the start frame until the scheduled sound is audible, then runs', () => {
    const c = new PlaybackClock()
    // audio scheduled to start at ctx 10.05 s; output (heard) time is 9.96 s now
    c.start(3_000_000, 0, 10.05)
    expect(c.tick(16, 9.976)).toBe(3_000_000)
    expect(c.tick(50, 10.01)).toBe(3_000_000)
    expect(c.tick(90, 10.05)).toBe(3_000_000)
    const t = c.tick(106, 10.066)
    expect(t).toBeGreaterThan(3_000_000)
    expect(t).toBeLessThanOrEqual(3_016_000)
    // and it never runs backwards over a resume cycle
    let prev = t
    for (let i = 1; i <= 60; i++) {
      const now = c.tick(106 + i * 16, 10.066 + i * 0.016)
      expect(now).toBeGreaterThanOrEqual(prev)
      prev = now
    }
    expect(prev).toBeGreaterThan(3_900_000)
  })

  it('anchors a master that appears mid-playback without jumping', () => {
    const c = new PlaybackClock()
    c.start(0, 0)
    c.tick(100)
    expect(c.tick(116, 42)).toBe(116_000)
    expect(c.tick(132, 42.016)).toBe(132_000)
  })

  it('audioOutputTime prefers getOutputTimestamp and falls back to latency-corrected time', () => {
    const fake = (o: Record<string, unknown> = {}): AudioContext =>
      ({
        state: 'running',
        currentTime: 2,
        outputLatency: 0.05,
        baseLatency: 0.01,
        getOutputTimestamp: () => ({ contextTime: 1.9, performanceTime: 1000 }),
        ...o,
      }) as unknown as AudioContext
    expect(audioOutputTime(fake(), 1100)).toBeCloseTo(2.0)
    expect(audioOutputTime(fake({ getOutputTimestamp: undefined }), 0)).toBeCloseTo(1.95)
    expect(audioOutputTime(fake({ state: 'suspended' }), 0)).toBe(undefined)
  })
})

describe('AdaptiveQuality', () => {
  it('sizes to device pixels, capped at 1080x1920, even and 9:16', () => {
    const q = new AdaptiveQuality()
    q.setMode('high')
    expect(q.renderSize(360, 640, 3)).toEqual({ width: 1080, height: 1920 })
    expect(q.renderSize(300, 1000, 2)).toEqual({ width: 600, height: 1066 })
    // letterboxed: a wide element is height-limited
    expect(q.renderSize(1000, 400, 1)).toEqual({ width: 226, height: 402 })
    q.setMode('low')
    expect(q.renderSize(360, 640, 3).width).toBe(LOW_WIDTH)
  })

  it('auto steps down under load and back up with hysteresis', () => {
    const q = new AdaptiveQuality()
    q.setBudget(1000 / 60)
    for (let i = 0; i < 25; i++) q.record(20)
    expect(q.level).toBe(1)
    expect(q.renderSize(360, 640, 3).width).toBe(Math.round((1080 * LEVELS[1]) / 2) * 2)
    // brief spikes do not change it
    for (let i = 0; i < 10; i++) q.record(3)
    expect(q.level).toBe(1)
    let changed = false
    for (let i = 0; i < 400; i++) changed = q.record(2) || changed
    expect(changed).toBe(true)
    expect(q.level).toBe(0)
  })

  it('fixed modes never adapt', () => {
    const q = new AdaptiveQuality()
    q.setMode('high')
    for (let i = 0; i < 100; i++) expect(q.record(100)).toBe(false)
    expect(q.level).toBe(0)
    expect(q.averageCost).toBeGreaterThan(50)
  })
})
