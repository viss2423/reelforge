/**
 * A minimal Chrome DevTools Protocol driver for ONE tab of the phone's Chrome.
 *
 * Playwright's `connectOverCDP` attaches to every open tab of the browser; on a personal
 * phone that means dozens of the owner's tabs (slow, can stall on discarded tabs, and is
 * intrusive). This driver opens its own tab through the DevTools HTTP endpoint and talks to
 * that target only, over its page WebSocket.
 */

interface Target {
  id: string
  url: string
  webSocketDebuggerUrl?: string
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

type Listener = (params: Record<string, unknown>) => void

const connect = (url: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.addEventListener('open', () => resolve(ws), { once: true })
    ws.addEventListener('error', () => reject(new Error(`DevTools WebSocket ${url} failed`)), {
      once: true,
    })
  })

export class TabDriver {
  readonly #ws: WebSocket
  readonly #pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()
  readonly #listeners = new Map<string, Set<Listener>>()
  #seq = 0
  readonly id: string
  readonly #endpoint: string

  private constructor(endpoint: string, target: Target, ws: WebSocket) {
    this.#endpoint = endpoint
    this.id = target.id
    this.#ws = ws
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number
        result?: unknown
        error?: { message: string }
        method?: string
        params?: Record<string, unknown>
      }
      if (msg.id !== undefined) {
        const p = this.#pending.get(msg.id)
        this.#pending.delete(msg.id)
        if (msg.error) p?.reject(new Error(msg.error.message))
        else p?.resolve(msg.result)
      } else if (msg.method) {
        for (const l of this.#listeners.get(msg.method) ?? []) l(msg.params ?? {})
      }
    })
  }

  /**
   * Opens a new blank tab and attaches to it. The tab is created with one browser-level
   * `Target.createTarget` call (no auto-attach to other tabs), then driven over its own
   * page WebSocket.
   */
  static async open(endpoint: string): Promise<TabDriver> {
    const version = (await (await fetch(`${endpoint}/json/version`)).json()) as {
      webSocketDebuggerUrl: string
    }
    const browserWs = await connect(version.webSocketDebuggerUrl)
    const targetId = await new Promise<string>((resolve, reject) => {
      browserWs.addEventListener('message', (ev) => {
        const msg = JSON.parse(String(ev.data)) as {
          id?: number
          result?: { targetId: string }
          error?: { message: string }
        }
        if (msg.id !== 1) return
        if (msg.result) resolve(msg.result.targetId)
        else reject(new Error(msg.error?.message ?? 'Target.createTarget failed'))
      })
      browserWs.send(
        JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'about:blank' } }),
      )
    })
    browserWs.close()
    const host = new URL(endpoint).host
    const ws = await connect(`ws://${host}/devtools/page/${targetId}`)
    return new TabDriver(endpoint, { id: targetId, url: 'about:blank' }, ws)
  }

  send<T = Record<string, unknown>>(method: string, params: object = {}): Promise<T> {
    const id = ++this.#seq
    this.#ws.send(JSON.stringify({ id, method, params }))
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    })
  }

  on(method: string, cb: Listener): () => void {
    let set = this.#listeners.get(method)
    if (!set) this.#listeners.set(method, (set = new Set()))
    set.add(cb)
    return () => set.delete(cb)
  }

  /** Evaluates an expression (or `(arg) => …` source applied to `arg`) in the page. */
  async eval<T>(fn: string | ((arg: never) => unknown), arg?: unknown): Promise<T> {
    const expression =
      typeof fn === 'string' ? fn : `(${fn.toString()})(${JSON.stringify(arg ?? null)})`
    const r = await this.send<{
      result: { value?: unknown }
      exceptionDetails?: { text: string; exception?: { description?: string } }
    }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails)
      throw new Error(
        `page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`,
      )
    return r.result.value as T
  }

  async goto(url: string): Promise<void> {
    await this.send('Page.enable')
    const loaded = new Promise<void>((resolve) => {
      const off = this.on('Page.loadEventFired', () => {
        off()
        resolve()
      })
    })
    await this.send('Page.navigate', { url })
    await loaded
  }

  /** Polls `fn` in the page until it returns a truthy value (which is returned). */
  async waitFor<T>(
    what: string,
    fn: string | ((arg: never) => unknown),
    { timeout = 15_000, arg }: { timeout?: number; arg?: unknown } = {},
  ): Promise<T> {
    const end = Date.now() + timeout
    for (;;) {
      const v = await this.eval<T>(fn, arg).catch(() => undefined)
      if (v) return v
      if (Date.now() > end) {
        const where = await this.eval<string>(
          () => `${location.href} — ${document.body.innerText.slice(0, 300)}`,
        ).catch(() => '?')
        throw new Error(`timed out waiting for ${what} at ${where}`)
      }
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  /** Viewport box of the first element matching `selector` (undefined when absent/hidden). */
  box(selector: string, nth = 0): Promise<Box | undefined> {
    return this.eval<Box | undefined>(
      ([sel, i]: [string, number]) => {
        const all = document.querySelectorAll(sel)
        const el = all[i < 0 ? all.length + i : i]
        if (!el) return undefined
        const r = el.getBoundingClientRect()
        return r.width && r.height
          ? { x: r.x, y: r.y, width: r.width, height: r.height }
          : undefined
      },
      [selector, nth],
    )
  }

  async waitBox(selector: string, nth = 0, timeout = 15_000): Promise<Box> {
    const end = Date.now() + timeout
    for (;;) {
      const b = await this.box(selector, nth)
      if (b) return b
      if (Date.now() > end) throw new Error(`no visible ${selector}`)
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  async touch(type: 'touchStart' | 'touchMove' | 'touchEnd', points: { x: number; y: number }[]) {
    await this.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points.map((p, i) => ({ ...p, id: i + 1 })),
    })
  }

  async tap(x: number, y: number): Promise<void> {
    await this.touch('touchStart', [{ x, y }])
    await this.touch('touchEnd', [])
  }

  /** Scrolls the element into view and taps its centre. */
  async tapOn(selector: string, nth = 0): Promise<void> {
    await this.eval(
      ([sel, i]: [string, number]) =>
        document.querySelectorAll(sel)[i]?.scrollIntoView({ block: 'nearest' }),
      [selector, nth],
    )
    // Wait until it stops moving (sheets slide in): a tap mid-animation lands elsewhere.
    let b = await this.waitBox(selector, nth)
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 80))
      const next = await this.waitBox(selector, nth)
      const still = Math.abs(next.x - b.x) < 0.5 && Math.abs(next.y - b.y) < 0.5
      b = next
      if (still) break
    }
    await this.tap(b.x + b.width / 2, b.y + b.height / 2)
  }

  /** One finger: down, optional hold, interpolated moves, up. */
  async drag(from: [number, number], to: [number, number], { hold = 0, steps = 12 } = {}) {
    await this.touch('touchStart', [{ x: from[0], y: from[1] }])
    if (hold) await new Promise((r) => setTimeout(r, hold))
    for (let i = 1; i <= steps; i++)
      await this.touch('touchMove', [
        {
          x: from[0] + ((to[0] - from[0]) * i) / steps,
          y: from[1] + ((to[1] - from[1]) * i) / steps,
        },
      ])
    await this.touch('touchEnd', [])
  }

  /** Puts a file into an `<input type=file>` and fires `change` (as a real pick does). */
  async setInputFile(selector: string, name: string, mime: string, data: Buffer): Promise<void> {
    await this.eval(
      ([sel, n, t, b64]: [string, string, string, string]) => {
        const input = document.querySelector<HTMLInputElement>(sel)
        if (!input) throw new Error(`no ${sel}`)
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
        const dt = new DataTransfer()
        dt.items.add(new File([bytes], n, { type: t }))
        input.files = dt.files
        input.dispatchEvent(new Event('change', { bubbles: true }))
      },
      [selector, name, mime, data.toString('base64')],
    )
  }

  /** PNG of a viewport region. */
  async screenshot(clip: Box): Promise<Buffer> {
    const r = await this.send<{ data: string }>('Page.captureScreenshot', {
      format: 'png',
      clip: { ...clip, scale: 1 },
    })
    return Buffer.from(r.data, 'base64')
  }

  /** Detaches and closes the tab. */
  async close(): Promise<void> {
    this.#ws.close()
    await fetch(`${this.#endpoint}/json/close/${this.id}`).catch(() => undefined)
  }
}
