/**
 * GLSL ES 3.00 sources. Every colour formula here has a CPU twin that is unit-tested
 * against FFmpeg (color/adjustments.ts, color/cube.ts, color/keying.ts, effects/effects.ts,
 * gl/transitions.ts); keep them in lock-step.
 *
 * Texture conventions: source textures are uploaded unflipped (texture v = 0 is the picture
 * TOP); render targets have row 0 at the BOTTOM (GL convention). Layer quads are given in
 * picture coordinates (y down) and mapped to NDC by the layer matrix, so targets hold
 * upright pictures in GL orientation and full-screen passes copy row-for-row.
 */
import { BLEND_ID } from '../color/keying.ts'

/** Full-screen pass: vUV = (0,0) at the bottom-left of the target. */
export const FULLSCREEN_VS = /* glsl */ `#version 300 es
in vec2 aPos;
out vec2 vUV;
void main() {
  vUV = aPos + 0.5;
  gl_Position = vec4(aPos * 2.0, 0.0, 1.0);
}
`

/** Copy (optionally flipping vertically when `uFlip` is set). */
export const COPY_FS = /* glsl */ `#version 300 es
precision mediump float;
in vec2 vUV;
uniform sampler2D uSrc;
uniform bool uFlip;
out vec4 outColor;
void main() {
  outColor = texture(uSrc, uFlip ? vec2(vUV.x, 1.0 - vUV.y) : vUV);
}
`

/** Dual-filter (Kawase) downsample: 4×centre + 4 diagonal taps. */
export const KAWASE_DOWN_FS = /* glsl */ `#version 300 es
precision mediump float;
in vec2 vUV;
uniform sampler2D uSrc;
uniform vec2 uOff;
out vec4 outColor;
void main() {
  vec4 s = texture(uSrc, vUV) * 4.0;
  s += texture(uSrc, vUV - uOff);
  s += texture(uSrc, vUV + uOff);
  s += texture(uSrc, vUV + vec2(uOff.x, -uOff.y));
  s += texture(uSrc, vUV - vec2(uOff.x, -uOff.y));
  outColor = s / 8.0;
}
`

/** Dual-filter (Kawase) upsample: 8 taps on a diamond, diagonals weighted 2. */
export const KAWASE_UP_FS = /* glsl */ `#version 300 es
precision mediump float;
in vec2 vUV;
uniform sampler2D uSrc;
uniform vec2 uOff;
out vec4 outColor;
void main() {
  vec2 o = uOff;
  vec4 s = texture(uSrc, vUV + vec2(-2.0 * o.x, 0.0));
  s += texture(uSrc, vUV + vec2(-o.x, o.y)) * 2.0;
  s += texture(uSrc, vUV + vec2(0.0, 2.0 * o.y));
  s += texture(uSrc, vUV + vec2(o.x, o.y)) * 2.0;
  s += texture(uSrc, vUV + vec2(2.0 * o.x, 0.0));
  s += texture(uSrc, vUV + vec2(o.x, -o.y)) * 2.0;
  s += texture(uSrc, vUV + vec2(0.0, -2.0 * o.y));
  s += texture(uSrc, vUV + vec2(-o.x, -o.y)) * 2.0;
  outColor = s / 12.0;
}
`

/** Layer vertex shader: unit quad → NDC through the 2×3 affine matrix of layers.ts. */
export const LAYER_VS = /* glsl */ `#version 300 es
in vec2 aPos;
uniform vec2 uM0;
uniform vec2 uM1;
uniform vec2 uM2;
out vec2 vQuad;
void main() {
  vQuad = aPos;
  gl_Position = vec4(uM0 * aPos.x + uM1 * aPos.y + uM2, 0.0, 1.0);
}
`

/**
 * Layer fragment shader: crop/rotation sampling, chroma key, sharpen, colour adjustments,
 * 3D LUT, effects, vignette, opacity and blend mode. Uniform layout documented inline;
 * packed by gl/compositor.ts.
 */
export const LAYER_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vQuad;
out vec4 outColor;

uniform sampler2D uTex;
uniform vec2 uTexel;        // 1 / texture size (sharpen, key neighbourhood)
uniform vec4 uUV;           // crop rect in displayed UV (u0, v0, u1, v1), v down
uniform int uRot;           // display rotation 0/90/180/270
uniform float uOpacity;
uniform vec2 uLayerSize;    // drawn size in canvas px (vignette)
uniform bool uAdjOn;
uniform vec4 uAdj;          // sharpen, vignette angle, grain, curves on (packAdjustUniforms)
uniform sampler2D uCurves;  // 256x1 Y/U/V curve table = the export's lutyuv
uniform float uLutMix;      // 0 = no LUT
uniform sampler3D uLut;
uniform float uLutN;
uniform vec3 uLutMin;
uniform vec3 uLutScale;     // 1 / (max - min)
uniform bool uKeyOn;
uniform vec4 uKey;          // key U, key V (8-bit), similarity, blend
uniform vec4 uFx0;          // rgb split (quad units), white mix, desaturate, scanline depth
uniform vec4 uFx1;          // noise amplitude, seed, glow strength, scanline period (target px)
uniform sampler2D uGlow;
uniform int uBlend;
uniform sampler2D uDst;

const vec3 K709 = vec3(0.2126, 0.7152, 0.0722);

vec2 texUV(vec2 q) {
  vec2 d = mix(uUV.xy, uUV.zw, q);
  if (uRot == 90) return vec2(d.y, 1.0 - d.x);
  if (uRot == 180) return 1.0 - d;
  if (uRot == 270) return vec2(1.0 - d.y, d.x);
  return d;
}

float luma(vec3 c) { return dot(c, K709); }

vec2 chromaUV(vec3 c) {
  float y = luma(c);
  return vec2(128.0 + 224.0 * (c.b - y) / 1.8556, 128.0 + 224.0 * (c.r - y) / 1.5748);
}

// vf_chromakey: mean normalised UV distance over a 3x3 chroma neighbourhood (2 px apart, as
// 4:2:0 chroma samples are), mapped through similarity / blend
float keyAlpha(vec2 uv) {
  float diff = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 d = chromaUV(texture(uTex, uv + vec2(float(i), float(j)) * 2.0 * uTexel).rgb) - uKey.xy;
      diff += sqrt(dot(d, d) / (255.0 * 255.0 * 2.0));
    }
  }
  diff /= 9.0;
  if (uKey.w > 0.0001) return clamp((diff - uKey.z) / uKey.w, 0.0, 1.0);
  return diff > uKey.z ? 1.0 : 0.0;
}

// exact 5x5 box mean of luma from 9 bilinear taps (offsets ±1.5 average texel pairs)
float box5(vec2 uv) {
  float s = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      float w = (i == 0 ? 1.0 : 2.0) * (j == 0 ? 1.0 : 2.0);
      s += w * luma(texture(uTex, uv + vec2(float(i), float(j)) * 1.5 * uTexel).rgb);
    }
  }
  return s / 25.0;
}

// the export's lutyuv: integer BT.709 limited code values through the per-plane tables
vec3 adjust(vec3 c) {
  vec3 yuv = clamp(floor(vec3(16.0 + 219.0 * luma(c), chromaUV(c)) + 0.5), 0.0, 255.0);
  float Y = (texelFetch(uCurves, ivec2(int(yuv.x), 0), 0).r * 255.0 - 16.0) / 219.0;
  float Cb = (texelFetch(uCurves, ivec2(int(yuv.y), 0), 0).g * 255.0 - 128.0) / 224.0;
  float Cr = (texelFetch(uCurves, ivec2(int(yuv.z), 0), 0).b * 255.0 - 128.0) / 224.0;
  return clamp(vec3(Y + 1.5748 * Cr, Y - 0.187324 * Cb - 0.468124 * Cr, Y + 1.8556 * Cb), 0.0, 1.0);
}

vec3 lutAt(int r, int g, int b) { return texelFetch(uLut, ivec3(r, g, b), 0).rgb; }

// lut3d interp=tetrahedral (CPU twin: color/cube.ts sampleTetrahedral)
vec3 lut(vec3 c) {
  float m = uLutN - 1.0;
  vec3 s = clamp((c - uLutMin) * uLutScale * m, 0.0, m);
  vec3 p = floor(s);
  vec3 d = s - p;
  ivec3 P = ivec3(p);
  ivec3 N = min(P + 1, ivec3(int(m)));
  vec3 c000 = lutAt(P.x, P.y, P.z);
  vec3 c111 = lutAt(N.x, N.y, N.z);
  vec3 ca; vec3 cb; float w0; float wa; float wb; float w1;
  if (d.r > d.g) {
    if (d.g > d.b) {
      ca = lutAt(N.x, P.y, P.z); cb = lutAt(N.x, N.y, P.z);
      w0 = 1.0 - d.r; wa = d.r - d.g; wb = d.g - d.b; w1 = d.b;
    } else if (d.r > d.b) {
      ca = lutAt(N.x, P.y, P.z); cb = lutAt(N.x, P.y, N.z);
      w0 = 1.0 - d.r; wa = d.r - d.b; wb = d.b - d.g; w1 = d.g;
    } else {
      ca = lutAt(P.x, P.y, N.z); cb = lutAt(N.x, P.y, N.z);
      w0 = 1.0 - d.b; wa = d.b - d.r; wb = d.r - d.g; w1 = d.g;
    }
  } else if (d.b > d.g) {
    ca = lutAt(P.x, P.y, N.z); cb = lutAt(P.x, N.y, N.z);
    w0 = 1.0 - d.b; wa = d.b - d.g; wb = d.g - d.r; w1 = d.r;
  } else if (d.b > d.r) {
    ca = lutAt(P.x, N.y, P.z); cb = lutAt(P.x, N.y, N.z);
    w0 = 1.0 - d.g; wa = d.g - d.b; wb = d.b - d.r; w1 = d.r;
  } else {
    ca = lutAt(P.x, N.y, P.z); cb = lutAt(N.x, N.y, P.z);
    w0 = 1.0 - d.g; wa = d.g - d.r; wb = d.r - d.b; w1 = d.b;
  }
  return w0 * c000 + wa * ca + wb * cb + w1 * c111;
}

float hash(vec2 p, float seed) {
  vec3 q = fract(vec3(p.xyx) * 0.1031 + seed);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

vec3 blendMode(vec3 d, vec3 s) {
  if (uBlend == ${BLEND_ID.screen}) return 1.0 - (1.0 - d) * (1.0 - s);
  if (uBlend == ${BLEND_ID.multiply}) return d * s;
  if (uBlend == ${BLEND_ID.overlay}) return mix(2.0 * d * s, 1.0 - 2.0 * (1.0 - d) * (1.0 - s), step(0.5, d));
  if (uBlend == ${BLEND_ID.lighten}) return max(d, s);
  if (uBlend == ${BLEND_ID.darken}) return min(d, s);
  if (uBlend == ${BLEND_ID.add}) return min(d + s, 1.0);
  return s;
}

void main() {
  vec2 q = vQuad + 0.5;
  vec2 uv = texUV(q);
  vec4 src = texture(uTex, uv);
  vec3 c = src.rgb;
  if (uFx0.x != 0.0) {
    c.r = texture(uTex, texUV(q - vec2(uFx0.x, 0.0))).r;
    c.b = texture(uTex, texUV(q + vec2(uFx0.x, 0.0))).b;
  }
  float a = src.a * uOpacity;
  if (uKeyOn) a *= keyAlpha(uv);
  if (uAdjOn) {
    if (uAdj.x > 0.0) c = clamp(c + uAdj.x * (luma(c) - box5(uv)), 0.0, 1.0);
    if (uAdj.w > 0.5) c = adjust(c);
  }
  if (uLutMix > 0.0) c = mix(c, lut(c), uLutMix);
  if (uFx1.z > 0.0) c = min(c + texture(uGlow, uv).rgb * uFx1.z, 1.0);
  if (uFx0.z > 0.0) c = mix(c, vec3(luma(c)), uFx0.z);
  if (uFx0.y > 0.0) c = mix(c, vec3(1.0), uFx0.y);
  if (uFx0.w > 0.0) c *= 1.0 - uFx0.w * (0.5 + 0.5 * cos(6.283185307 * gl_FragCoord.y / uFx1.w));
  if (uFx1.x > 0.0) c = clamp(c + (hash(gl_FragCoord.xy, uFx1.y) - 0.5) * 2.0 * uFx1.x, 0.0, 1.0);
  if (uAdjOn && uAdj.y > 0.0) {
    // vf_vignette (natural, aspect 1) over the drawn layer
    float dn = length(vQuad * uLayerSize) / length(uLayerSize * 0.5);
    float v = dn > 1.0 ? 0.0 : cos(uAdj.y * dn);
    c *= v * v * v * v;
  }
  if (uBlend == 0) {
    outColor = vec4(c * a, a);
  } else {
    vec3 d = texelFetch(uDst, ivec2(gl_FragCoord.xy), 0).rgb;
    outColor = vec4(mix(d, blendMode(d, c), a), 1.0);
  }
}
`
