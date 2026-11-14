import { describe, expect, it } from 'vitest'
import { parseProgressLine } from '../../src/ai/media.ts'
import {
  parsePayload,
  ReframePayloadSchema,
  SilencePayloadSchema,
  TranscribePayloadSchema,
} from '../../src/ai/payloads.ts'
import { CancelledError, run, runChecked, throwIfAborted, ToolError } from '../../src/ai/proc.ts'

const node = process.execPath
const script = (code: string): string[] => ['-e', code]

describe('run', () => {
  it('streams stdout/stderr lines, including \\r progress redraws and split UTF-8', async () => {
    const out: string[] = []
    const err: string[] = []
    const r = await run(
      node,
      script(
        "process.stdout.write('a\\nb'); process.stdout.write(Buffer.from([0xc3])); process.stdout.write(Buffer.from([0xa9, 0x0a])); process.stderr.write('p=1%\\rp=2%\\r\\nlast')",
      ),
      { onStdoutLine: (l) => out.push(l), onStderrLine: (l) => err.push(l) },
    )
    expect(r.code).toBe(0)
    expect(out).toEqual(['a', 'bé'])
    expect(err).toEqual(['p=1%', 'p=2%', 'last'])
    expect(r.stderrTail).toEqual(['p=1%', 'p=2%', 'last'])
  })

  it('applies backpressure: the async consumer sees every byte in order', async () => {
    let total = 0
    let maxInFlight = 0
    let inFlight = 0
    await run(node, script('process.stdout.write(Buffer.alloc(4 << 20, 7))'), {
      onStdoutData: async (chunk) => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((r) => setTimeout(r, 1))
        total += chunk.length
        inFlight--
      },
    })
    expect(total).toBe(4 << 20)
    expect(maxInFlight).toBe(1)
  })

  it('resolves with non-zero exit codes; runChecked turns them into ToolError with the stderr tail', async () => {
    const r = await run(node, script("console.error('boom'); process.exit(3)"))
    expect(r.code).toBe(3)
    const err = await runChecked(
      'tool',
      node,
      script("console.error('bad input'); process.exit(2)"),
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ToolError)
    expect((err as ToolError).code).toBe(2)
    expect((err as Error).message).toMatch(/tool failed \(exit 2\):\nbad input/)
  })

  it('kills the process on abort and rejects with CancelledError', async () => {
    const ac = new AbortController()
    const started = Date.now()
    const p = run(node, script('setTimeout(() => {}, 60_000)'), { signal: ac.signal })
    setTimeout(() => ac.abort(), 100)
    await expect(p).rejects.toBeInstanceOf(CancelledError)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('rejects immediately when already aborted, and on spawn errors', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(run(node, script(''), { signal: ac.signal })).rejects.toBeInstanceOf(
      CancelledError,
    )
    await expect(run('definitely-not-a-binary-xyz', [])).rejects.toThrow(/ENOENT|not found|spawn/i)
  })

  it('propagates consumer errors and stops the producer', async () => {
    await expect(
      run(node, script('setInterval(() => process.stdout.write("x".repeat(1000)), 1)'), {
        onStdoutData: () => {
          throw new Error('consumer failed')
        },
      }),
    ).rejects.toThrow('consumer failed')
  })

  it('throwIfAborted', () => {
    const ac = new AbortController()
    expect(() => throwIfAborted(ac.signal)).not.toThrow()
    expect(() => throwIfAborted(undefined)).not.toThrow()
    ac.abort()
    expect(() => throwIfAborted(ac.signal)).toThrow(CancelledError)
    expect(new CancelledError().name).toBe('AbortError')
  })
})

describe('parseProgressLine', () => {
  it('reads out_time_us', () => {
    expect(parseProgressLine('out_time_us=1500000')).toBe(1_500_000)
    expect(parseProgressLine('out_time_us=N/A')).toBeUndefined()
    expect(parseProgressLine('out_time_ms=1500000')).toBeUndefined()
  })
})

describe('payload validation', () => {
  it('accepts valid payloads and reports every issue otherwise', () => {
    expect(
      parsePayload(TranscribePayloadSchema, { assetId: 'abc_1', language: 'en', model: 'base' }),
    ).toEqual({
      assetId: 'abc_1',
      language: 'en',
      model: 'base',
    })
    expect(() =>
      parsePayload(TranscribePayloadSchema, { assetId: 'a/b', language: 'English' }),
    ).toThrow(/invalid payload — assetId: invalid assetId; language: /)
    expect(() => parsePayload(TranscribePayloadSchema, { assetId: 'a', model: '../../x' })).toThrow(
      /model/,
    )
    expect(() => parsePayload(SilencePayloadSchema, { assetId: 'a', thresholdDb: 3 })).toThrow(
      /thresholdDb/,
    )
    expect(
      parsePayload(ReframePayloadSchema, { assetId: 'a', fps: 8, provider: 'dml' }).provider,
    ).toBe('dml')
    expect(() => parsePayload(ReframePayloadSchema, null)).toThrow(/invalid payload/)
  })
})
