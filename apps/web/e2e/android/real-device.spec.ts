/**
 * Real-device pass: the phone's own Chrome, driven over USB (adb + Chrome DevTools Protocol,
 * one tab of its own — see cdp.ts), against the real server. `adb reverse` maps the test
 * ports so the phone opens `https://localhost:<port>`, a secure context for the service
 * worker and PWA install.
 *
 * Covers pairing (code path), project + upload + timeline, preview playback measured with
 * `window.__rfPreviewStats` (decoder, first frame, seek latency, fps, frame time, waits,
 * pixels), real touch on the timeline (trim, long-press reorder, pinch), the AI panel, export
 * + download inside the page, and installability (manifest, service worker, CDP).
 *
 * Skipped, with the reason printed, when no unlocked device is attached. Leaves the phone as
 * found: the test tab is closed, the origin's site data cleared, adb forward/reverse removed.
 *
 *   ADB=<path to adb> pnpm --filter @reelforge/web test:e2e:android
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'
import { mainTrackLayout, type Project } from '@reelforge/core'
import { BASE_URL, E2E_PAIR_CODE, FLOW_MEDIA, HTTPS_PORT, HTTP_PORT } from '../env.ts'
import { brightFraction, grayPng } from '../media.ts'
import { TabDriver } from './cdp.ts'

const run = promisify(execFile)
const ADB = process.env.ADB ?? 'adb'
/** Host port the phone's DevTools socket is forwarded to. */
const CDP_PORT = Number(process.env.RF_ANDROID_CDP_PORT ?? 29222)
const DEVTOOLS = `http://127.0.0.1:${CDP_PORT}`
/** Opened by intent only to start Chrome when it isn't running; closed again at the end. */
const MARKER = `http://localhost:${HTTP_PORT}/?rf-device-test`

const adb = async (serial: string | undefined, ...args: string[]) =>
  (await run(ADB, [...(serial ? ['-s', serial] : []), ...args])).stdout

/** The device to use, or why the pass can't run. */
const findDevice = async (): Promise<{ serial?: string; reason?: string }> => {
  let serial: string | undefined
  try {
    serial =
      process.env.RF_ANDROID_SERIAL ??
      (await adb(undefined, 'devices'))
        .split('\n')
        .slice(1)
        .map((l) => l.trim().split(/\s+/))
        .find(([, state]) => state === 'device')?.[0]
  } catch (err) {
    return { reason: `adb not available (${ADB}): ${String(err)}` }
  }
  if (!serial) return { reason: 'no authorised Android device attached (adb devices)' }
  // Chrome only renders (rAF, video decode) on an awake, unlocked screen.
  const locked = /isKeyguardShowing=true/.test(await adb(serial, 'shell', 'dumpsys', 'window'))
  const awake = /mWakefulness=Awake/.test(await adb(serial, 'shell', 'dumpsys', 'power'))
  if (locked || !awake)
    return { reason: `device ${serial} is ${locked ? 'locked' : 'asleep'}: unlock it` }
  return { serial }
}

const targets = async (): Promise<{ id: string; url: string }[]> =>
  fetch(`${DEVTOOLS}/json/list`).then(
    async (r) => (r.ok ? ((await r.json()) as { id: string; url: string }[]) : []),
    () => [],
  )

/** Closes the tabs this spec opens (by URL: the marker page and the test origin). */
const closeOwnTabs = async () => {
  for (const t of await targets())
    if (t.url.includes('rf-device-test') || t.url.startsWith(BASE_URL))
      await fetch(`${DEVTOOLS}/json/close/${t.id}`).catch(() => undefined)
}

const quantile = (xs: number[], q: number) => {
  const s = xs.toSorted((a, b) => a - b)
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * q))] ?? 0)
}

interface Measurements {
  device?: string
  chrome?: string
  firstFrameMs?: number
  seekMs?: { p50: number; p95: number; n: number }
  playback?: { fps: number; frameMs: number; waits: number; inexactFrames: number }
  heapMB?: number
  exportMs?: number
  autoMusicMs?: number
  matteMs?: number
  autoEditMs?: number
  trends?: { topics: number; sounds: number; ms: number }
  pwa?: { serviceWorker?: string; installabilityErrors: string[] }
  errors: string[]
}

type Stats = Record<string, number | boolean | string>

test.describe.configure({ mode: 'serial' })

test.describe('real Android device', () => {
  let serial = ''
  let tab: TabDriver
  let projectId = ''
  const m: Measurements = { errors: [] }

  const stats = () =>
    tab.eval<Stats | undefined>(() => {
      const s = (globalThis as { __rfPreviewStats?: object }).__rfPreviewStats
      return s ? { ...s } : undefined
    })
  const project = () =>
    tab.eval<Project>(async (id: string) => (await fetch(`/api/projects/${id}`)).json(), projectId)
  const saved = () =>
    tab.waitFor(
      'autosave',
      () => document.querySelector('[data-testid="sync"]')?.getAttribute('data-status') === 'saved',
    )
  const clipSel = '[data-testid="timeline-clip"]'
  const clipCount = () =>
    tab.eval<number>(() => document.querySelectorAll('[data-testid="timeline-clip"]').length)
  /** Taps the first visible button (or radio) whose accessible name or text matches. */
  const tapText = async (text: string, within = 'body') => {
    await tab.waitFor(
      `button "${text}"`,
      ([t, w]: [string, string]) => {
        document.querySelector('[data-rf-tap]')?.removeAttribute('data-rf-tap')
        const el = [...document.querySelectorAll(`${w} button, ${w} [role="radio"]`)].find(
          (b) =>
            (b.getAttribute('aria-label') ?? b.textContent ?? '').trim() === t &&
            (b as HTMLElement).offsetParent !== null,
        )
        el?.setAttribute('data-rf-tap', '')
        return !!el
      },
      { arg: [text, within] },
    )
    await tab.tapOn('[data-rf-tap]')
  }
  /** Text of the first visible alert, prefixed so a test can tell it from success. */
  const failure = () => {
    const a = document.querySelector('[role="alert"]')?.textContent
    return a ? `ERROR ${a}` : ''
  }
  /**
   * `adb shell input`, but only while this test's tab is what's on screen: real input goes
   * to whatever is showing, and it must never land in another app or another tab the owner
   * has open.
   */
  const input = async (...args: string[]) => {
    const visible = await tab.eval<string>(() => document.visibilityState).catch(() => '?')
    if (visible !== 'visible')
      throw new Error(
        'not sending real input: the test tab is not on screen (another tab or app is in front). Leave the phone alone during the pass.',
      )
    const top = await adb(
      serial,
      'shell',
      'dumpsys activity activities | grep -m1 topResumedActivity',
    )
    // "topResumedActivity=ActivityRecord{… u0 com.android.chrome/….Main t2}" → the package.
    const app = / u\d+ ([\w.]+)\//.exec(top)?.[1]
    if (app !== 'com.android.chrome')
      throw new Error(
        `not sending real input: ${app ?? 'another app'} is in front, not Chrome. Leave the phone on Chrome during the pass.`,
      )
    await adb(serial, 'shell', 'input', ...args)
  }
  /**
   * Real finger input (`adb shell input`): the OS touch pipeline, exactly like a person.
   * CSS px → screen px needs the page's offset on screen (Chrome's own UI above it), found
   * once by tapping a transparent overlay and reading where the page saw the touch.
   */
  let toScreen: ((x: number, y: number) => [number, number]) | undefined
  const screenMap = async () => {
    if (toScreen) return toScreen
    await tab.eval(() => {
      const o = document.createElement('div')
      o.id = 'rf-calibrate'
      o.style.cssText = 'position:fixed;inset:0;z-index:2147483647'
      o.addEventListener('pointerdown', (e) => {
        o.dataset.at = `${e.clientX},${e.clientY}`
      })
      document.body.append(o)
    })
    const [sx, sy] = [400, 1200]
    await input('tap', String(sx), String(sy))
    const at = await tab.waitFor<string>('calibration tap', () => {
      const o = document.getElementById('rf-calibrate')
      return o?.dataset.at
    })
    const dpr = await tab.eval<number>(() => {
      document.getElementById('rf-calibrate')?.remove()
      return devicePixelRatio
    })
    const [cx, cy] = at.split(',').map(Number) as [number, number]
    const [ox, oy] = [sx - cx * dpr, sy - cy * dpr]
    toScreen = (x, y) => [Math.round(ox + x * dpr), Math.round(oy + y * dpr)]
    return toScreen
  }
  const fingerTap = async (selector: string) => {
    const map = await screenMap()
    const vw = await tab.eval<number>(() => innerWidth)
    /** The part of the element inside the viewport, horizontally. */
    const visible = (b: { x: number; width: number }) => {
      const lo = Math.max(0, b.x)
      const hi = Math.min(vw, b.x + b.width)
      return { lo, hi, enough: hi - lo >= Math.min(b.width, 40) - 0.5 }
    }
    // Mostly off-screen in a horizontal strip (the tool bar)? Swipe it into view like a person.
    for (let i = 0; i < 6; i++) {
      const b = await tab.waitBox(selector)
      if (visible(b).enough) break
      const [, y] = map(0, b.y + b.height / 2)
      const [l] = map(vw * 0.25, 0)
      const [r] = map(vw * 0.75, 0)
      const [from, to] = b.x < 0 ? [l, r] : [r, l]
      await input('swipe', String(from), String(y), String(to), String(y), '400')
      await new Promise((res) => setTimeout(res, 700))
    }
    // A tap during a fling only stops it (as on any phone): wait for the strip to come to rest.
    let box = await tab.waitBox(selector)
    for (let still = 0, i = 0; still < 2 && i < 30; i++) {
      await new Promise((res) => setTimeout(res, 120))
      const next = await tab.waitBox(selector)
      still = Math.abs(next.x - box.x) < 0.5 && Math.abs(next.y - box.y) < 0.5 ? still + 1 : 0
      box = next
    }
    const { lo, hi } = visible(box)
    const [x, y] = map((lo + hi) / 2, box.y + box.height / 2)
    await input('tap', String(x), String(y))
  }
  /** Closes the open tool sheet the way a person does: swipe its handle down. */
  const closeSheet = async () => {
    const sel = '[data-testid="sheet-handle"]'
    const vh = await tab.eval<number>(() => innerHeight)
    // Wait until the sheet has finished sliding in (handle on screen and still).
    let h = await tab.waitBox(sel)
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 80))
      const next = await tab.waitBox(sel)
      const still = Math.abs(next.y - h.y) < 0.5
      h = next
      if (still && h.y < vh - h.height) break
    }
    const map = await screenMap()
    const [x1, y1] = map(h.x + h.width / 2, h.y + h.height / 2)
    const [, y2] = map(0, vh - 8)
    await input('swipe', String(x1), String(y1), String(x1), String(y2), '250')
    // The sheet stays mounted (it animates closed); closed = no tool is pressed any more.
    await tab.waitFor(
      'sheet closed',
      () => !document.querySelector('[role="toolbar"] [aria-pressed="true"]'),
    )
    // Human pace: Chrome on Android ignores a tap that lands within ~1 s of a swipe it
    // treated as a fling (measured on the OnePlus: the click never fires).
    await new Promise((r) => setTimeout(r, 1000))
  }
  /**
   * Opens a tool panel from the tool dock with a real tap. Tools that aren't docked are
   * behind "More": tap it, then the tool in its grid; the open tool then shows, pressed, in
   * the dock.
   */
  const openTool = async (id: string) => {
    const sel = `[role="toolbar"] [data-tool="${id}"]`
    const docked = await tab.eval<boolean>((q: string) => !!document.querySelector(q), sel)
    if (docked) await fingerTap(sel)
    else {
      await fingerTap('[data-testid="dock-more"]')
      const item = `[data-testid="dock-more-sheet"] [data-tool="${id}"]`
      // Let the grid sheet finish sliding in before tapping into it.
      let b = await tab.waitBox(item)
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 80))
        const next = await tab.waitBox(item)
        const still = Math.abs(next.y - b.y) < 0.5
        b = next
        if (still) break
      }
      await fingerTap(item)
    }
    await tab.waitFor(
      `${id} panel`,
      (q: string) => document.querySelector(q)?.getAttribute('aria-pressed') === 'true',
      { arg: sel },
    )
  }
  const audioClips = async () =>
    (await project()).tracks.filter((t) => t.kind === 'audio').flatMap((t) => t.clips).length

  test.beforeAll(async () => {
    test.setTimeout(120_000)
    const found = await findDevice()
    if (!found.serial) {
      console.log(`real-device spec skipped: ${found.reason}`)
      test.skip(true, found.reason)
      return
    }
    serial = found.serial
    m.device = (await adb(serial, 'shell', 'getprop', 'ro.product.model')).trim()
    for (const port of [HTTPS_PORT, HTTP_PORT])
      await adb(serial, 'reverse', `tcp:${port}`, `tcp:${port}`)
    await adb(serial, 'forward', `tcp:${CDP_PORT}`, 'localabstract:chrome_devtools_remote')
    await closeOwnTabs() // left behind by an interrupted run
    const version = () =>
      fetch(`${DEVTOOLS}/json/version`).then(
        async (r) => (r.ok ? ((await r.json()) as { Browser: string }) : undefined),
        () => undefined,
      )
    // Always (re)open the marker page: it starts Chrome if needed and, just as important,
    // brings it to the foreground — a backgrounded Chrome never fires load events or renders.
    const intent = ['am', 'start', '-a', 'android.intent.action.VIEW', '-d', `'${MARKER}'`]
    await adb(serial, 'shell', ...intent, 'com.android.chrome')
    await expect.poll(async () => !!(await version()), { timeout: 20_000 }).toBe(true)
    m.chrome = (await version())!.Browser
    tab = await TabDriver.open(DEVTOOLS)
    // The phone does not trust the host's local CA (installing it would change the phone);
    // ignore certificate errors in this tab's DevTools session only.
    await tab.send('Security.setIgnoreCertificateErrors', { ignore: true })
    // Start unpaired even when an interrupted run never reached its cleanup.
    await tab.send('Storage.clearDataForOrigin', { origin: BASE_URL, storageTypes: 'all' })
    await tab.send('Runtime.enable')
    await tab.send('Network.enable')
    tab.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails as { text?: string; exception?: { description?: string } }
      m.errors.push(d.exception?.description ?? d.text ?? 'exception')
    })
    tab.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error')
        m.errors.push((p.args as { value?: unknown }[]).map((a) => String(a.value)).join(' '))
    })
    tab.on('Network.responseReceived', (p) => {
      const r = p.response as { status: number; url: string }
      // The 403 for code-less pairing is this spec's own interception (below).
      if (r.status >= 400 && !r.url.endsWith('/api/pair/local'))
        m.errors.push(`${r.status} ${r.url}`)
    })
    // Over adb reverse the server sees loopback; refuse code-less pairing to test the phone path.
    await tab.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/pair/local' }] })
    tab.on('Fetch.requestPaused', (p) => {
      void tab.send('Fetch.fulfillRequest', {
        requestId: p.requestId,
        responseCode: 403,
        responseHeaders: [{ name: 'content-type', value: 'application/json' }],
        body: Buffer.from('{"error":"off"}').toString('base64'),
      })
    })
  })

  // A failed step attaches what the phone actually showed (the OS screenshot, Chrome UI included).
  // Playwright requires the fixtures argument to be a destructuring pattern.
  // oxlint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, info) => {
    if (!serial || info.status === info.expectedStatus) return
    const file = info.outputPath('phone.png')
    await adb(serial, 'shell', 'screencap', '-p', '/sdcard/rf-e2e.png')
    await adb(serial, 'pull', '/sdcard/rf-e2e.png', file)
    await adb(serial, 'shell', 'rm', '/sdcard/rf-e2e.png')
    await info.attach('phone', { path: file, contentType: 'image/png' })
  })

  test.afterAll(async () => {
    if (!serial) return
    try {
      if (tab) {
        await tab
          .send('Storage.clearDataForOrigin', { origin: BASE_URL, storageTypes: 'all' })
          .catch(() => undefined)
        await tab.close()
      }
      await closeOwnTabs()
    } finally {
      await adb(serial, 'forward', '--remove', `tcp:${CDP_PORT}`).catch(() => undefined)
      for (const port of [HTTPS_PORT, HTTP_PORT])
        await adb(serial, 'reverse', '--remove', `tcp:${port}`).catch(() => undefined)
      console.log(`real device: ${JSON.stringify(m)}`)
    }
  })

  test('pairs with the code and creates a project', async () => {
    await tab.goto(`${BASE_URL}/`)
    await tab.waitFor('pairing screen', () => location.pathname.startsWith('/pair'))
    await tab.tapOn('#pair-code')
    await tab.send('Input.insertText', { text: E2E_PAIR_CODE })
    // Functions run in the page: they can't close over Node-side helpers.
    await tab.waitFor('home', () => {
      // Home's quiet "Blank project" button keeps the accessible name "New project".
      const button = document.querySelector('button[aria-label="New project"]')
      button?.setAttribute('data-rf-test', 'new-project')
      return !!button
    })
    await tab.tapOn('[data-rf-test="new-project"]')
    projectId = await tab.waitFor<string>('editor', () =>
      document.querySelector('[data-testid="editor"]')
        ? (/\/p\/([^/?#]+)/.exec(location.pathname)?.[1] ?? '')
        : '',
    )
  })

  test('uploads a clip and puts it on the timeline twice', async () => {
    test.setTimeout(120_000)
    const name = `device-${Date.now()}.mp4`
    const tile = `[data-testid="media-item"][aria-label="Add ${name} to timeline"]`
    await tab.tapOn('[data-testid="add-media"]')
    await tab.setInputFile(
      '[data-testid="library-upload"]',
      name,
      'video/mp4',
      await readFile(FLOW_MEDIA.clipA),
    )
    await tab.waitFor(
      'proxy ready',
      (sel: string) => document.querySelector(sel)?.getAttribute('data-proxy') === 'ready',
      { arg: tile, timeout: 90_000 },
    )
    await tab.tapOn(tile)
    await expect.poll(clipCount).toBe(1)
    await tab.tapOn('[data-testid="add-media"]')
    await tab.tapOn(tile)
    await expect.poll(clipCount).toBe(2)
    await saved()
  })

  test('preview: WebCodecs, first frame, seeks, playback, pixels', async () => {
    test.setTimeout(120_000)
    // First frame after a cold load of the editor.
    const t0 = Date.now()
    await tab.goto(`${BASE_URL}/p/${projectId}`)
    await tab
      .waitFor(
        'first exact frame',
        () =>
          (globalThis as { __rfPreviewStats?: { frameExact: boolean } }).__rfPreviewStats
            ?.frameExact === true,
        { timeout: 20_000 },
      )
      .catch(async (err: unknown) => {
        // Say why: decoder, GPU context, fetches, decoded frames.
        throw new Error(`${String(err)}
preview stats: ${JSON.stringify(await stats())}`)
      })
    m.firstFrameMs = Date.now() - t0
    expect((await stats())!.decoder).toBe('webcodecs')

    // Seeks: tap the ruler at spread-out spots; latency from the touch to the exact frame.
    const ruler = await tab.waitBox('[data-testid="timeline-ruler"]')
    const vp = await tab.waitBox('[data-testid="timeline-viewport"]')
    const seeks: number[] = []
    for (const f of [0.15, 0.7, 0.35, 0.9, 0.05, 0.55, 0.25, 0.8, 0.45, 0.6, 0.1, 0.75]) {
      // Re-measured each time: the view may follow the playhead.
      const first = await tab.waitBox(clipSel, 0)
      const last = await tab.waitBox(clipSel, -1)
      const lo = Math.max(first.x, vp.x) + 4
      // The ruler's right corner holds the timeline "⋯" button: a tap there opens its sheet.
      const options = await tab.waitBox('[data-testid="timeline-options"]')
      const hi = Math.min(last.x + last.width, vp.x + vp.width, options.x - 8) - 4
      await tab.eval(() => {
        type S = { time: number; frameExact: boolean }
        const s = () => (globalThis as { __rfPreviewStats?: S }).__rfPreviewStats!
        const prev = s().time
        let start = 0
        addEventListener('pointerdown', (e) => (start = e.timeStamp), {
          once: true,
          capture: true,
        })
        ;(globalThis as { __rfSeek?: Promise<number> }).__rfSeek = new Promise<number>(
          (resolve) => {
            const poll = (now: number) => {
              // Time and exactness are published together, after the frame is composited.
              if (start && s().time !== prev && s().frameExact) return resolve(now - start)
              if (start && now - start > 3000) return resolve(-1)
              requestAnimationFrame(poll)
            }
            requestAnimationFrame(poll)
          },
        )
      })
      await tab.tap(lo + (hi - lo) * f, ruler.y + ruler.height / 2)
      const ms = await tab.eval<number>('globalThis.__rfSeek')
      if (ms >= 0) seeks.push(ms)
    }
    expect(seeks.length).toBeGreaterThanOrEqual(10)
    m.seekMs = { p50: quantile(seeks, 0.5), p95: quantile(seeks, 0.95), n: seeks.length }

    // Playback from the start: fps, compose time, waits, exactness, pixels.
    const first = await tab.waitBox(clipSel, 0)
    await tab.tap(Math.max(first.x, vp.x) + 1, ruler.y + ruler.height / 2)
    const before = (await stats())!
    await tab.eval(() => {
      const w = globalThis as { __rfWaits?: number; __rfSampler?: ReturnType<typeof setInterval> }
      w.__rfWaits = 0
      let was = false
      w.__rfSampler = setInterval(() => {
        const s = (globalThis as { __rfPreviewStats?: { waiting: boolean } }).__rfPreviewStats!
        if (s.waiting && !was) w.__rfWaits!++
        was = s.waiting
      }, 16)
    })
    await tab.tapOn('[data-testid="play-toggle"]')
    await new Promise((r) => setTimeout(r, 2500))
    const during = (await stats())!
    const canvas = await tab.waitBox('[data-testid="preview-canvas"]')
    const shot = await grayPng(await tab.screenshot(canvas), 90, 160)
    await tab.tapOn('[data-testid="play-toggle"]')
    const waits = await tab.eval<number>(() => {
      const w = globalThis as { __rfWaits?: number; __rfSampler?: ReturnType<typeof setInterval> }
      clearInterval(w.__rfSampler)
      return w.__rfWaits!
    })
    m.playback = {
      fps: Math.round(Number(during.fps)),
      frameMs: +Number(during.frameMs).toFixed(2),
      waits,
      inexactFrames: Number(during.inexactFrames) - Number(before.inexactFrames),
    }
    expect(m.playback.fps).toBeGreaterThanOrEqual(28)
    expect(waits).toBe(0)
    expect(brightFraction(shot, 0, shot.height, 40)).toBeGreaterThan(0.3)
    await tab.waitFor(
      'exact frame after pause',
      () =>
        (globalThis as { __rfPreviewStats?: { frameExact: boolean } }).__rfPreviewStats?.frameExact,
    )
    const heap = await tab.send<{ usedSize: number }>('Runtime.getHeapUsage')
    m.heapMB = +(heap.usedSize / 1048576).toFixed(1)
  })

  test('timeline by touch: pinch, trim, long-press reorder', async () => {
    const vp = await tab.waitBox('[data-testid="timeline-viewport"]')
    const clip0 = await tab.waitBox(clipSel, 0)
    const y = clip0.y + clip0.height / 2
    const cx = vp.x + vp.width / 2
    const fingers = (d: number) => [
      { x: cx - d, y },
      { x: cx + d, y },
    ]
    const pinch = async (from: number, to: number) => {
      await tab.touch('touchStart', fingers(from))
      const step = from < to ? 10 : -10
      for (let d = from + step; step > 0 ? d <= to : d >= to; d += step)
        await tab.touch('touchMove', fingers(d))
      await tab.touch('touchEnd', [])
    }
    const width0 = async () => (await tab.waitBox(clipSel, 0)).width

    // Pinch in until both clips fit on screen (their edges must be reachable).
    const w0 = await width0()
    for (let i = 0; i < 4; i++) {
      const last = await tab.waitBox(clipSel, -1)
      if (last.x + last.width < vp.x + vp.width - 8) break
      await pinch(150, 30)
    }
    expect(await width0()).toBeLessThan(w0)

    // Trim: tap to select the first clip, drag its end handle left.
    const b0 = await tab.waitBox(clipSel, 0)
    await tab.tap(b0.x + b0.width / 2, y)
    await tab.waitFor('selected', () =>
      document.querySelector('[data-testid="timeline-clip"]')?.getAttribute('data-selected'),
    )
    const before = mainTrackLayout(await project())
    await tab.drag([b0.x + b0.width - 4, y], [b0.x + b0.width * 0.6, y])
    let trimmed = before
    await expect
      .poll(
        async () => {
          trimmed = mainTrackLayout(await project())
          return trimmed[0]!.clip.duration
        },
        { timeout: 10_000, message: 'trimmed clip autosaved' },
      )
      .toBeLessThan(before[0]!.clip.duration)

    // Reorder: long-press the first clip, carry it past the second.
    const firstId = trimmed[0]!.clip.id
    const a = await tab.waitBox(clipSel, 0)
    const b1 = await tab.waitBox(clipSel, 1)
    await tab.drag([a.x + a.width / 2, y], [b1.x + b1.width - 4, y], { hold: 600, steps: 20 })
    await expect
      .poll(async () => mainTrackLayout(await project()).at(-1)?.clip.id, { timeout: 10_000 })
      .toBe(firstId)

    // Pinch out: clips get wider again.
    const w1 = await width0()
    await pinch(30, 150)
    await expect.poll(width0).toBeGreaterThan(w1 * 1.5)
  })

  test('Magic panel opens with its tools', async () => {
    await tab.eval(() =>
      document.querySelector<HTMLButtonElement>('[role="toolbar"] [aria-label="Done"]')?.click(),
    )
    await tab.tapOn('[role="toolbar"] [data-tool="ai"]')
    await tab.waitFor('Magic tools', () => {
      const grid = document.querySelector('[aria-label="Magic tools"]')
      const labels = [...(grid?.querySelectorAll('button') ?? [])].map((b) => b.textContent?.trim())
      return (
        !!document.querySelector('[aria-label="Auto edit"]') &&
        labels.includes('Captions') &&
        labels.includes('Silences')
      )
    })
    await closeSheet()
  })

  test('auto music: a real trend-matched royalty-free track lands on the timeline', async () => {
    test.setTimeout(180_000)
    await openTool('audio')
    const before = await audioClips()
    const t0 = Date.now()
    await tab.tapOn('[data-testid="auto-music"]', 0)
    const pick = await tab.waitFor<string>(
      'auto music pick',
      `(${String(failure)})() || document.querySelector('[data-testid="auto-music-pick"]')?.textContent`,
      { timeout: 150_000 },
    )
    expect(pick).not.toMatch(/^ERROR/)
    m.autoMusicMs = Date.now() - t0
    await saved()
    await expect.poll(audioClips).toBeGreaterThan(before)
    await closeSheet()
  })

  test('background removal runs on the host with the real model', async () => {
    test.setTimeout(240_000)
    const main = (await project()).tracks.find((t) => t.kind === 'main')!.clips[0]!.id
    await fingerTap(`${clipSel}[data-clip-id="${main}"]`)
    await tab.waitFor(
      'clip selected',
      (id: string) =>
        document
          .querySelector(`[data-testid="timeline-clip"][data-clip-id="${id}"]`)
          ?.hasAttribute('data-selected'),
      { arg: main },
    )
    await openTool('background')
    await tapText('Remove', '[role="radiogroup"][aria-label="Background"]')
    const t0 = Date.now()
    const outcome = await tab.waitFor<string>(
      'subject separated',
      `(${String(failure)})() || (document.body.innerText.includes('Subject separated.') && 'done')`,
      { timeout: 220_000 },
    )
    expect(outcome).toBe('done')
    m.matteMs = Date.now() - t0
    await saved()
    await closeSheet()
    await tab.eval(() =>
      document.querySelector<HTMLButtonElement>('[role="toolbar"] [aria-label="Done"]')?.click(),
    )
  })

  test('auto edit this project with the local LLM, variants to choose from', async () => {
    test.setTimeout(300_000)
    await openTool('ai')
    await tapText('Make it a reel')
    const t0 = Date.now()
    const outcome = await tab.waitFor<string>(
      'auto edit variants',
      `(${String(failure)})() || (!!document.querySelector('[data-testid="autoedit-variants"]') && 'done')`,
      { timeout: 280_000 },
    )
    expect(outcome).toBe('done')
    m.autoEditMs = Date.now() - t0
    const variants = await tab.eval<number>(
      () => document.querySelectorAll('[data-testid="autoedit-variants"] [role="radio"]').length,
    )
    expect(variants).toBeGreaterThan(0)
    await saved()
    expect(await clipCount()).toBeGreaterThan(0)
    await closeSheet()
  })

  test('exports and downloads the MP4 on the phone', async () => {
    test.setTimeout(180_000)
    await fingerTap('[data-testid="export-open"]')
    const t0 = Date.now()
    await tab.tapOn('[data-testid="export-start"]')
    const outcome = await tab.waitFor<string>(
      'export',
      () =>
        document.querySelector('[data-testid="export-done"]')
          ? 'done'
          : (document.querySelector('[data-testid="export-failed"]')?.textContent ?? ''),
      { timeout: 150_000 },
    )
    expect(outcome).toBe('done')
    m.exportMs = Date.now() - t0
    const file = await tab.eval<{ status: number; type: string; size: number; brand: string }>(
      async () => {
        const link = document.querySelector('[data-testid="export-download"]')
        const res = await fetch(link!.getAttribute('href')!)
        const buf = new Uint8Array(await res.arrayBuffer())
        return {
          status: res.status,
          type: res.headers.get('content-type') ?? '',
          size: buf.length,
          brand: String.fromCharCode(...buf.subarray(4, 8)),
        }
      },
    )
    expect(file).toMatchObject({ status: 200, type: 'video/mp4', brand: 'ftyp' })
    expect(file.size).toBeGreaterThan(50_000)
  })

  test('Trending tab shows live topics on the phone', async () => {
    test.setTimeout(240_000)
    await tab.goto(`${BASE_URL}/trending`)
    await tab.waitBox('[data-testid="trending"]')
    const t0 = Date.now()
    const counts = await tab.waitFor<{ topics: number; sounds: number }>(
      'trend topics',
      () => {
        const topics = document.querySelectorAll('[data-testid="trend-topics"] li').length
        const sounds = document.querySelectorAll('[data-testid="trend-sounds"] li').length
        return topics > 0 ? { topics, sounds } : undefined
      },
      { timeout: 220_000 },
    )
    m.trends = { ...counts, ms: Date.now() - t0 }
    expect(counts.topics).toBeGreaterThan(0)
  })

  test('is an installable PWA (manifest, service worker, installability)', async () => {
    const sw = await tab.eval<string | undefined>(async () => {
      const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<undefined>((r) => setTimeout(() => r(undefined), 15_000)),
      ])
      if (reg) return reg.active?.state
      // Not ready: surface why (registration errors are otherwise only logged).
      return navigator.serviceWorker.register('/sw.js', { type: 'module' }).then(
        (r) => `registered late: ${r.installing?.state ?? r.active?.state}`,
        (e: unknown) => `registration failed: ${String(e)}`,
      )
    })
    const manifest = await tab.send<{ url: string; errors: unknown[] }>('Page.getAppManifest')
    const { installabilityErrors } = await tab.send<{
      installabilityErrors: { errorId: string }[]
    }>('Page.getInstallabilityErrors')
    m.pwa = { serviceWorker: sw, installabilityErrors: installabilityErrors.map((e) => e.errorId) }
    expect(manifest.errors).toEqual([])
    expect(manifest.url).toMatch(/manifest/)
    if (sw === 'activated') {
      expect(installabilityErrors).toEqual([])
    } else {
      // Chrome refuses service-worker scripts served with an untrusted certificate, and this
      // phone (deliberately) does not have the host's local CA installed. That must be the
      // only thing missing: everything else about installability checks out.
      expect(sw).toMatch(/SSL certificate error/)
      for (const e of installabilityErrors)
        expect(e.errorId).toMatch(/service-worker|offline|fetch-handler/)
    }
    expect(m.errors).toEqual([])
  })
})
