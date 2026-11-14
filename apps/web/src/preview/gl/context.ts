/**
 * Thin WebGL2 helpers: program compilation with cached uniform locations, render targets
 * (texture + framebuffer) and the shared unit-quad geometry. No per-frame allocation: all
 * objects are created up front or pooled by the compositor.
 */

export interface Program {
  readonly program: WebGLProgram
  /** Uniform location by name (null when optimised out — setting null is a no-op in GL). */
  u(name: string): WebGLUniformLocation | null
}

export class GlError extends Error {
  override name = 'GlError'
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)
  if (!s) throw new GlError('createShader failed (context lost?)')
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(s) ?? ''
    gl.deleteShader(s)
    throw new GlError(`shader compile failed:\n${log}`)
  }
  return s
}

/** Compile + link; attribute 0 is always `aPos` (the quad). */
export function createProgram(gl: WebGL2RenderingContext, vs: string, fs: string): Program {
  const p = gl.createProgram()
  if (!p) throw new GlError('createProgram failed (context lost?)')
  const v = compileShader(gl, gl.VERTEX_SHADER, vs)
  const f = compileShader(gl, gl.FRAGMENT_SHADER, fs)
  gl.attachShader(p, v)
  gl.attachShader(p, f)
  gl.bindAttribLocation(p, 0, 'aPos')
  gl.linkProgram(p)
  gl.deleteShader(v)
  gl.deleteShader(f)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new GlError(`program link failed:\n${gl.getProgramInfoLog(p) ?? ''}`)
  }
  const cache = new Map<string, WebGLUniformLocation | null>()
  return {
    program: p,
    u(name) {
      let l = cache.get(name)
      if (l === undefined) {
        l = gl.getUniformLocation(p, name)
        cache.set(name, l)
      }
      return l
    },
  }
}

/** A colour texture with its framebuffer. */
export interface Target {
  readonly tex: WebGLTexture
  readonly fbo: WebGLFramebuffer
  width: number
  height: number
}

export function createTexture(
  gl: WebGL2RenderingContext,
  filter: number = gl.LINEAR,
): WebGLTexture {
  const t = gl.createTexture()
  if (!t) throw new GlError('createTexture failed (context lost?)')
  gl.bindTexture(gl.TEXTURE_2D, t)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return t
}

export function createTarget(gl: WebGL2RenderingContext, width: number, height: number): Target {
  const tex = createTexture(gl)
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height)
  const fbo = gl.createFramebuffer()
  if (!fbo) throw new GlError('createFramebuffer failed (context lost?)')
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  return { tex, fbo, width, height }
}

export function deleteTarget(gl: WebGL2RenderingContext, t: Target): void {
  gl.deleteFramebuffer(t.fbo)
  gl.deleteTexture(t.tex)
}

/** Bind `t` (or the canvas when null) as the draw target and set the viewport. */
export function bindTarget(
  gl: WebGL2RenderingContext,
  t: Target | null,
  w: number,
  h: number,
): void {
  gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null)
  gl.viewport(0, 0, t ? t.width : w, t ? t.height : h)
}

/** Unit quad (−0.5..0.5, y down = picture top at −0.5) as a 4-vertex triangle strip. */
export function createQuad(gl: WebGL2RenderingContext): WebGLVertexArrayObject {
  const vao = gl.createVertexArray()
  const buf = gl.createBuffer()
  if (!vao || !buf) throw new GlError('createVertexArray failed (context lost?)')
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]),
    gl.STATIC_DRAW,
  )
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
  gl.bindVertexArray(null)
  return vao
}
