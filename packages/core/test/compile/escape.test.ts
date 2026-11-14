import { describe, expect, it } from 'vitest'
import { escapeFilterPath, escapeOptionValue, filter } from '../../src/compile/escape.ts'
import { parseGraph } from './helpers.ts'

/** Round-trip a value through a one-filter graph and FFmpeg's two unescaping levels. */
const roundTrip = (value: string): string => {
  const [chain] = parseGraph(`[0:v]${filter('ass', { filename: value, x: 1 })}[out]`)
  return chain!.filters[0]!.options.filename!
}

describe('escapeOptionValue', () => {
  it('leaves plain values untouched', () => {
    expect(escapeOptionValue('lanczos')).toBe('lanczos')
    expect(escapeOptionValue('0x1A2B3C')).toBe('0x1A2B3C')
    expect(escapeOptionValue('iw*0.5')).toBe('iw*0.5')
  })

  it('quotes values containing graph or option specials', () => {
    expect(escapeOptionValue('a,b')).toBe("'a,b'")
    expect(escapeOptionValue('a:b')).toBe("'a\\:b'")
    expect(escapeOptionValue('x y')).toBe("'x y'")
    expect(escapeOptionValue('[a]')).toBe("'[a]'")
    expect(escapeOptionValue('')).toBe("''")
  })

  it('splices literal quotes', () => {
    expect(escapeOptionValue("it's")).toBe("'it\\'\\''s'")
  })

  it.each([
    'a,b;c',
    'C:/Users/me/My Videos/clip.ass',
    "data dir's/text.ass",
    'weird[name]=x.ass',
    'back\\slash',
    "'quoted'",
    ':::',
    'if(lt(t,1),0,1)',
  ])('round-trips %j through both unescaping levels', (value) => {
    expect(roundTrip(value)).toBe(value)
  })
})

describe('escapeFilterPath', () => {
  it('normalises Windows backslashes and escapes the drive colon', () => {
    expect(escapeFilterPath('C:\\Users\\me\\fonts')).toBe("'C\\:/Users/me/fonts'")
  })

  it('round-trips Windows paths with spaces, apostrophes and brackets', () => {
    const p = "C:\\Users\\O'Brien\\Video Projects [2026]\\text.ass"
    const [chain] = parseGraph(`[0:v]ass=filename=${escapeFilterPath(p)}[o]`)
    expect(chain!.filters[0]!.options.filename).toBe(p.replaceAll('\\', '/'))
  })

  it('handles UNC paths', () => {
    const [chain] = parseGraph(`[0:v]lut3d=file=${escapeFilterPath('\\\\nas\\luts\\a.cube')}[o]`)
    expect(chain!.filters[0]!.options.file).toBe('//nas/luts/a.cube')
  })
})

describe('filter', () => {
  it('builds name=k=v pairs, omitting undefined/false and mapping true to 1', () => {
    expect(filter('scale', { w: 1080, h: 1920, flags: 'lanczos', x: undefined, y: false })).toBe(
      'scale=w=1080:h=1920:flags=lanczos',
    )
    expect(filter('overlay', { eof_action: 'pass', shortest: true })).toBe(
      'overlay=eof_action=pass:shortest=1',
    )
    expect(filter('null')).toBe('null')
    expect(filter('eq', { gamma: 1 / 3 })).toBe('eq=gamma=0.333333')
  })
})
