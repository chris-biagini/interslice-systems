// CRT engine v2 — WebGL2 backend (the core path every browser gets).
//
// Passes per frame (textures are stored top-row-first, "image
// orientation"; only the screen pass flips to the GL framebuffer):
//   1. persist  (signal res, RGBA16F ping-pong): decode the source to
//               linear light, afterglow = max(live, prev × decay).
//   2. hbeam    (signal res, RGBA16F): the beam's horizontal spread and
//               per-channel convergence, along each scanline.
//      mask     (output width × 1): the grille's per-column profile.
//   3. glow     (1/2 … 1/16 signal res, RGBA16F): a dual-filter (Kawase)
//               down/up chain over the afterglow light — bloom from the
//               near levels, halation from the far ones.
//   4. screen   (output res, default framebuffer): the tube — vertical
//               beam reconstruction, grille, damper wires, glow, glass.
// Uniform values come from the chassis (CRT#_uniforms) and are set by
// name, so this file maps values to GPU slots and nothing else.
(function () {
  'use strict';
  const CRT = window.CRT;
  if (!CRT) return;

  const VS = `#version 300 es
layout(location = 0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

  const COMMON = `#version 300 es
precision highp float;
precision highp int;
`;

  // Linear P3 → linear sRGB (D65). Rows are GLSL columns.
  const P3_TO_SRGB = `const mat3 P3_TO_SRGB = mat3(
   1.2249401, -0.0420569, -0.0196376,
  -0.2249404,  1.0420571, -0.0786361,
   0.0000001,  0.0000000,  1.0982735);`;

  const PERSIST_FS = COMMON + P3_TO_SRGB + `
uniform sampler2D uSrc;
uniform sampler2D uPrev;
uniform vec2 uSignalSize;
uniform vec2 uFitScale;
uniform vec2 uFitOffset;
uniform float uDecay;
uniform float uExposure;
uniform float uSignalP3;
out vec4 oColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uSignalSize;
  vec2 s = (uv - uFitOffset) / uFitScale;
  vec3 live = vec3(0.0);
  if (all(greaterThanEqual(s, vec2(0.0))) && all(lessThanEqual(s, vec2(1.0)))) {
    live = texture(uSrc, s).rgb;               // SRGB8_ALPHA8: hardware-decoded, linear
  }
  if (uSignalP3 > 0.5) live = P3_TO_SRGB * live;
  live = max(live, 0.0) * uExposure;
  vec3 prev = texelFetch(uPrev, ivec2(gl_FragCoord.xy), 0).rgb;
  // Phosphor: instant attack, exponential release.
  oColor = vec4(max(live, prev * uDecay), 1.0);
}`;

  // Horizontal beam: a per-channel Gaussian along the scanline. σ is the
  // focus cheat (sharper than physical, for legibility) floored at ~one
  // triad so a 1-px feature always spans R, G and B stripes. Convergence
  // shifts where each channel samples.
  //
  // It also precomputes the vertical beam for each scanline sample, since
  // the beam's width depends only on that sample's brightness: A = L ×
  // the unit-area Gaussian's peak, B = its −1/(2σ²). The screen pass then
  // needs just A·exp(dy²·B) per scanline. σ² folds in the output pixel's
  // footprint (box ⊗ Gaussian) plus a fade as scanlines approach the
  // pixel Nyquist limit, so fine scanlines blend instead of beating.
  const HBEAM_FS = COMMON + `
uniform sampler2D uPersist;
uniform vec2 uSignalSize;
uniform vec2 uOutSize;
uniform float uFocusPx;
uniform float uTriadFloorPx;
uniform vec3 uConvergence;     // x offsets in signal px, per channel
uniform float uBeamEnabled;
uniform float uBeamMin;
uniform float uBeamMax;
uniform float uBeamShape;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
const float INV_SQRT_2PI = 0.3989422804;
void main() {
  float sigma = max(max(uFocusPx, uTriadFloorPx), 0.05);
  int R = int(min(ceil(2.5 * sigma), 16.0));
  vec2 px = gl_FragCoord.xy;
  float y = px.y / uSignalSize.y;
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int k = -16; k <= 16; k++) {
    if (k < -R || k > R) continue;
    float fk = float(k);
    float w = exp(-0.5 * fk * fk / (sigma * sigma));
    sum.r += w * texture(uPersist, vec2((px.x + fk + uConvergence.r) / uSignalSize.x, y)).r;
    sum.g += w * texture(uPersist, vec2((px.x + fk + uConvergence.g) / uSignalSize.x, y)).g;
    sum.b += w * texture(uPersist, vec2((px.x + fk + uConvergence.b) / uSignalSize.x, y)).b;
    wsum += w;
  }
  vec3 L = max(sum / wsum, 0.0);
  if (uBeamEnabled < 0.5) { oA = vec4(L, 1.0); oB = vec4(0.0); return; }
  float lines = uSignalSize.y / uOutSize.y;      // scanlines per output pixel
  float extra = lines * lines / 12.0 + 0.1 * smoothstep(0.3, 0.6, lines);
  vec3 sig = mix(vec3(uBeamMin), vec3(uBeamMax), pow(L, vec3(uBeamShape)));
  vec3 s2 = sig * sig + extra;
  oA = vec4(L * inversesqrt(s2) * INV_SQRT_2PI, 1.0);
  oB = vec4(-0.5 / s2, 1.0);
}`;

  // The grille depends only on x, so it's computed once per frame into a
  // one-pixel-tall row (outW × 1) and fetched by the screen pass.
  //
  // Continuous R/G/B stripes, period one triad, each lit for stripeFill
  // of its third. Each pixel takes the stripe's exact average under a
  // pixel filter — a 1-px box blended with a 1-px-radius tent
  // (maskSoftness). Both filters tile perfectly (their shifted copies sum
  // to 1), so the grille conserves energy at any pitch and fractional
  // pitches can't beat into moiré. The averages come from closed-form
  // integrals of the periodic box, range-reduced to stay float-exact.
  // Output is the profile normalized to unit average (P / duty).
  const MASK_FS = COMMON + `
uniform vec2 uOutSize;
uniform float uTriadsAcross;
uniform float uStripeFill;
uniform float uMaskSoftness;
out vec4 oColor;
float boxI(float u, float d) { float n = floor(u); return n * d + min(u - n, d); }
float boxI2(float u, float d) {
  float n = floor(u), r = u - n;
  float part = r < d ? 0.5 * r * r : d * r - 0.5 * d * d;
  return 0.5 * d * n * (n - 1.0) + n * (d - 0.5 * d * d) + n * d * r + part;
}
float stripe(float t, float phase, float d, float px) {
  float u = fract(t - phase) + 2.0;           // reduce; keeps u ± px ≥ 0
  float box = (boxI(u + 0.5 * px, d) - boxI(u - 0.5 * px, d)) / px;
  float tent = (boxI2(u + px, d) - 2.0 * boxI2(u, d) + boxI2(u - px, d)) / (px * px);
  return mix(box, tent, uMaskSoftness);
}
void main() {
  float triadPx = uOutSize.x / uTriadsAcross;
  float t = gl_FragCoord.x / triadPx;
  float px = min(1.0 / triadPx, 1.0);
  float duty = uStripeFill / 3.0;
  float off = (1.0 - uStripeFill) / 6.0;
  vec3 P = vec3(stripe(t, off, duty, px),
                stripe(t, 1.0 / 3.0 + off, duty, px),
                stripe(t, 2.0 / 3.0 + off, duty, px));
  oColor = vec4(P / duty, 1.0);
}`;

  // Dual-filter (Kawase) blur: cheap, wide, and smooth. Offsets scale
  // with a radius knob. Sources are linear light, so the glow adds up
  // the way light does.
  const DOWN_FS = COMMON + `
uniform sampler2D uTex;
uniform vec2 uTexel;            // 1 / source size
uniform float uOffset;
out vec4 oColor;
void main() {
  vec2 uv = gl_FragCoord.xy / vec2(textureSize(uTex, 0) / 2);
  vec2 h = uTexel * uOffset;
  vec3 c = texture(uTex, uv).rgb * 4.0;
  c += texture(uTex, uv + vec2(-h.x, -h.y)).rgb;
  c += texture(uTex, uv + vec2( h.x, -h.y)).rgb;
  c += texture(uTex, uv + vec2(-h.x,  h.y)).rgb;
  c += texture(uTex, uv + vec2( h.x,  h.y)).rgb;
  oColor = vec4(c / 8.0, 1.0);
}`;
  const UP_FS = COMMON + `
uniform sampler2D uTex;
uniform vec2 uTexel;            // 1 / source size
uniform vec2 uDstSize;
uniform float uOffset;
out vec4 oColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uDstSize;
  vec2 h = uTexel * uOffset;
  vec3 c = texture(uTex, uv + vec2(-2.0 * h.x, 0.0)).rgb;
  c += texture(uTex, uv + vec2( 2.0 * h.x, 0.0)).rgb;
  c += texture(uTex, uv + vec2(0.0, -2.0 * h.y)).rgb;
  c += texture(uTex, uv + vec2(0.0,  2.0 * h.y)).rgb;
  c += texture(uTex, uv + vec2(-h.x, -h.y)).rgb * 2.0;
  c += texture(uTex, uv + vec2( h.x, -h.y)).rgb * 2.0;
  c += texture(uTex, uv + vec2(-h.x,  h.y)).rgb * 2.0;
  c += texture(uTex, uv + vec2( h.x,  h.y)).rgb * 2.0;
  oColor = vec4(c / 12.0, 1.0);
}`;

  // The tube, at output resolution.
  const SCREEN_FS = COMMON + `
uniform sampler2D uHBeamA;
uniform sampler2D uHBeamB;
uniform sampler2D uMask;
uniform vec2 uSignalSize;
uniform vec2 uOutSize;
uniform float uBeamEnabled;
uniform float uBeamMin;
uniform float uBeamMax;
uniform float uBeamShape;
uniform float uGrilleEnabled;
uniform float uTriadsAcross;
uniform float uStripeFill;
uniform float uMaskStrength;
uniform float uHeadroom;
uniform sampler2D uBloomTex;
uniform sampler2D uHalationTex;
uniform float uBloom;
uniform float uHalation;
uniform vec2 uDamperY;          // fractions of height; < 0 = absent
uniform float uDamperStrength;
uniform float uDamperWidthPx;
uniform vec3 uGradeGains;
uniform float uGradeSaturation;
uniform float uWarmup;
uniform float uToneEnabled;
uniform float uShoulderStart;
uniform float uVignette;
uniform float uCornerRadius;
uniform float uCurvature;
uniform float uGloss;
uniform float uOutputP3;
out vec4 oColor;
// Linear sRGB → linear Display P3 (D65); GLSL columns.
const mat3 SRGB_TO_P3 = mat3(
  0.8224621, 0.0331941, 0.0170827,
  0.1775380, 0.9668058, 0.0723974,
  0.0000000, 0.0000000, 0.9105199);
float enc1(float l) { float a = abs(l); return sign(l) * (a <= 0.0031308 ? 12.92 * a : 1.055 * pow(a, 1.0 / 2.4) - 0.055); }
vec3 enc(vec3 c) { return vec3(enc1(c.r), enc1(c.g), enc1(c.b)); }

// Vertical beam reconstruction. Each scanline j contributes its light
// under a unit-area Gaussian whose width grows with that line's
// brightness, per channel (precomputed by the hbeam pass as A, B): bright
// lines swell, dark lines thin, and a flat field keeps its energy.
vec3 beam(vec2 sp) {                       // sp: signal-px coords, y top-first
  if (uBeamEnabled < 0.5) return texture(uHBeamA, sp / uSignalSize).rgb;
  int j0 = int(floor(sp.y - 0.5)) - 1;
  vec3 sum = vec3(0.0);
  for (int k = 0; k < 4; k++) {
    int j = j0 + k;
    if (j < 0 || j >= int(uSignalSize.y)) continue;
    float dy = sp.y - (float(j) + 0.5);
    vec2 uv = vec2(sp.x / uSignalSize.x, (float(j) + 0.5) / uSignalSize.y);
    sum += texture(uHBeamA, uv).rgb * exp(dy * dy * texture(uHBeamB, uv).rgb);
  }
  return sum;
}

// The mask mixes toward flat only as far as the headroom demands: in SDR,
// bright light blooms across the stripes instead of clipping; with HDR
// headroom the stripes stay dark. The profile has unit average, so the
// mix never changes a region's energy.
vec3 grille(vec3 L, float xOut) {
  if (uGrilleEnabled < 0.5) return L;
  vec3 Pn = texture(uMask, vec2(xOut / uOutSize.x, 0.5)).rgb;
  float duty = uStripeFill / 3.0;
  vec3 s = clamp((uHeadroom / max(L, vec3(1e-4)) - 1.0) / (1.0 / duty - 1.0), 0.0, uMaskStrength);
  return L * mix(vec3(1.0), Pn, s);
}

// Damper wires: two thin horizontal shadows on the phosphor, anti-aliased
// by the overlap of the wire with this pixel's row.
float damper(float yOut) {
  float shade = 1.0;
  for (int i = 0; i < 2; i++) {
    float f = uDamperY[i];
    if (f < 0.0) continue;
    float c = f * uOutSize.y, hw = 0.5 * uDamperWidthPx;
    float cov = max(0.0, min(yOut + 0.5, c + hw) - max(yOut - 0.5, c - hw));
    shade *= 1.0 - uDamperStrength * min(cov, 1.0);
  }
  return shade;
}

// Cylindrical Trinitron face: horizontals bow, verticals stay straight.
vec2 curve(vec2 p) {
  if (uCurvature <= 0.0) return p;
  float cx = p.x - 0.5;
  return vec2(cx * (1.0 + uCurvature * cx * cx * 4.0) + 0.5, p.y);
}

// Soft shoulder on the brightest channel (hue-preserving): identity below
// the knee, then a C1-continuous rational curve approaching the headroom.
vec3 shoulder(vec3 c) {
  float H = uHeadroom;
  float k = uShoulderStart * H;
  float m = max(c.r, max(c.g, c.b));
  if (uToneEnabled < 0.5 || m <= k) return c;
  float x = m - k;
  return c * ((k + x / (1.0 + x / (H - k))) / m);
}

void main() {
  float yTop = uOutSize.y - gl_FragCoord.y;
  vec2 p0 = vec2(gl_FragCoord.x, yTop) / uOutSize;   // top-first UV on the glass
  vec2 p = curve(p0);                                 // where the raster lands
  if (any(lessThan(p, vec2(0.0))) || any(greaterThan(p, vec2(1.0)))) { oColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec3 c = beam(p * uSignalSize);
  c = grille(c, p.x * uOutSize.x);
  c *= damper(p.y * uOutSize.y);
  // Glow is light scattered in the glass: unmasked, added after the grille.
  if (uBloom > 0.0) c += texture(uBloomTex, p).rgb * uBloom;
  if (uHalation > 0.0) c += texture(uHalationTex, p).rgb * uHalation;

  // The tube's color character, on emitted light only. Saturation past 1
  // can leave sRGB; it stays signed until the P3 conversion below.
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(luma), c, uGradeSaturation) * uGradeGains;
  c *= uWarmup;

  // Glass, in front of the phosphor.
  vec2 q = (p0 - 0.5) * 2.0;
  c *= 1.0 - uVignette * pow(clamp(length(q) * 0.7071, 0.0, 1.0), 3.0);
  vec2 g = (p0 - vec2(0.3, 0.2)) / vec2(0.18, 0.12);
  c += vec3(uGloss * exp(-0.5 * dot(g, g)));
  if (uCornerRadius > 0.0) {
    vec2 px = (p0 - 0.5) * uOutSize;
    float r = uCornerRadius * min(uOutSize.x, uOutSize.y);
    float d = length(max(abs(px) - (0.5 * uOutSize - vec2(r)), 0.0)) - r;
    c *= 1.0 - smoothstep(-1.0, 0.5, d);
  }

  c = shoulder(c);
  if (uOutputP3 > 0.5) c = SRGB_TO_P3 * c;
  oColor = vec4(enc(clamp(c, 0.0, uHeadroom)), 1.0);
}`;

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('CRT shader compile failed: ' + log);
    }
    return sh;
  }

  function program(gl, fsSrc) {
    const vs = compile(gl, gl.VERTEX_SHADER, VS);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('CRT program link failed: ' + gl.getProgramInfoLog(p));
    // Uniform location cache keyed by name; samplers are tracked so the
    // generic setter skips them.
    const locs = {};
    const samplers = new Set();
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const name = info.name.replace(/\[0\]$/, '');
      locs[name] = gl.getUniformLocation(p, info.name);
      if (info.type === gl.SAMPLER_2D) samplers.add(name);
    }
    return { p, locs, samplers };
  }

  // Set every uniform the program declares from a flat {name: value} map.
  function setUniforms(gl, prog, values) {
    for (const name in prog.locs) {
      if (prog.samplers.has(name)) continue;
      const v = values[name];
      if (v === undefined) continue;
      const loc = prog.locs[name];
      if (typeof v === 'number') gl.uniform1f(loc, v);
      else if (v.length === 2) gl.uniform2fv(loc, v);
      else if (v.length === 3) gl.uniform3fv(loc, v);
      else if (v.length === 4) gl.uniform4fv(loc, v);
    }
  }

  function bindSampler(gl, prog, name, unit, tex) {
    const loc = prog.locs[name];
    if (loc === undefined) return;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
  }

  function create(canvas, { opts }) {
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 unavailable');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('WebGL2 float rendering unavailable');
    if ('unpackColorSpace' in gl) {
      try { gl.unpackColorSpace = opts.signalColorSpace === 'display-p3' ? 'display-p3' : 'srgb'; } catch (_) { /* unsupported value */ }
    }

    // Wide-gamut output where the display has it: the drawing buffer is
    // tagged Display P3 and the screen pass converts into it.
    let outputColorSpace = 'srgb';
    const wantP3 = opts.outputColorSpace === 'display-p3' ||
      (opts.outputColorSpace === 'auto' && window.matchMedia && window.matchMedia('(color-gamut: p3)').matches);
    if (wantP3 && 'drawingBufferColorSpace' in gl) {
      try { gl.drawingBufferColorSpace = 'display-p3'; } catch (_) { /* unsupported */ }
      if (gl.drawingBufferColorSpace === 'display-p3') outputColorSpace = 'display-p3';
    }

    const progs = { persist: program(gl, PERSIST_FS), hbeam: program(gl, HBEAM_FS), mask: program(gl, MASK_FS), down: program(gl, DOWN_FS), up: program(gl, UP_FS), screen: program(gl, SCREEN_FS) };

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const texParams = (filter, mip) => {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    };
    const target = (w, h) => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, w, h);
      texParams(gl.LINEAR, false);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { tex, fbo, w, h };
    };
    const target2 = (w, h) => {
      const mk = () => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, w, h); texParams(gl.LINEAR, false); return t; };
      const tex = mk(), tex2 = mk();
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, tex2, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { tex, tex2, fbo, w, h };
    };
    const freeTarget = (t) => { if (t) { gl.deleteTexture(t.tex); if (t.tex2) gl.deleteTexture(t.tex2); gl.deleteFramebuffer(t.fbo); } };
    const freeGlow = () => { if (glow) { glow.d.forEach(freeTarget); ['bloom', 'halA', 'halB'].forEach((k) => freeTarget(glow[k])); } };

    const src = { tex: gl.createTexture(), w: 0, h: 0, mip: false };
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    texParams(gl.LINEAR, false);

    let fit = { scale: [1, 1], offset: [0, 0] };
    let signal = [1, 1];
    let persist = [null, null];
    let hbeam = null;
    let maskRow = null;
    let glow = null;   // { d: [1/2, 1/4, 1/8, 1/16], bloom, halA (1/8), halB (1/4) }
    let flip = 0;

    const draw = (t, prog, w, h) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null);
      gl.viewport(0, 0, w, h);
      gl.useProgram(prog.p);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const backend = {
      kind: 'webgl2',
      hdr: false,
      outputColorSpace,

      resize(w, h) {
        canvas.width = w;
        canvas.height = h;
        freeTarget(maskRow);
        maskRow = target(w, 1);
      },

      setSignalSize(w, h) {
        signal = [w, h];
        persist.forEach(freeTarget);
        persist = [target(w, h), target(w, h)];
        freeTarget(hbeam);
        hbeam = target2(w, h);
        freeGlow();
        const lv = (k) => target(Math.max(1, w >> k), Math.max(1, h >> k));
        glow = { d: [lv(1), lv(2), lv(3), lv(4)], bloom: lv(1), halA: lv(3), halB: lv(2) };
        backend.clearPersistence();
      },

      // Source rows land top-first (no UNPACK_FLIP_Y): textures stay in
      // image orientation throughout.
      upload(source, f) {
        fit = f;
        const w = source.videoWidth || source.width;
        const h = source.videoHeight || source.height;
        if (!w || !h) return;
        const mip = w > signal[0] * 1.5 || h > signal[1] * 1.5;   // downscaling video: mipmap it
        gl.bindTexture(gl.TEXTURE_2D, src.tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
        if (mip) gl.generateMipmap(gl.TEXTURE_2D);
        if (mip !== src.mip) { texParams(gl.LINEAR, mip); src.mip = mip; }
        src.w = w; src.h = h;
      },

      render(frame) {
        const u = frame.uniforms;
        const [w, h] = signal;
        const prev = persist[flip];
        const next = persist[1 - flip];

        const P = progs.persist;
        gl.useProgram(P.p);
        setUniforms(gl, P, Object.assign({ uFitScale: fit.scale, uFitOffset: fit.offset, uDecay: frame.decay }, u));
        bindSampler(gl, P, 'uSrc', 0, src.tex);
        bindSampler(gl, P, 'uPrev', 1, prev.tex);
        draw(next, P, w, h);
        flip = 1 - flip;

        const H = progs.hbeam;
        gl.useProgram(H.p);
        setUniforms(gl, H, u);
        bindSampler(gl, H, 'uPersist', 0, next.tex);
        draw(hbeam, H, w, h);

        if (u.uGrilleEnabled) {
          const M = progs.mask;
          gl.useProgram(M.p);
          setUniforms(gl, M, u);
          draw(maskRow, M, maskRow.w, 1);
        }

        // Glow chain. Quality 0: bloom at 1/2 res; 1: bloom at 1/4; 2: no
        // halation levels at all (the chassis also zeroes its strength).
        const needBloom = u.uBloom > 0, needHal = u.uHalation > 0;
        let bloomTex = next.tex, halTex = next.tex;
        if (needBloom || needHal) {
          const D = progs.down, Up = progs.up;
          const down = (srcT, dst, radius) => {
            gl.useProgram(D.p);
            setUniforms(gl, D, { uTexel: [1 / srcT.w, 1 / srcT.h], uOffset: radius });
            bindSampler(gl, D, 'uTex', 0, srcT.tex);
            draw(dst, D, dst.w, dst.h);
          };
          const up = (srcT, dst, radius) => {
            gl.useProgram(Up.p);
            setUniforms(gl, Up, { uTexel: [1 / srcT.w, 1 / srcT.h], uDstSize: [dst.w, dst.h], uOffset: radius });
            bindSampler(gl, Up, 'uTex', 0, srcT.tex);
            draw(dst, Up, dst.w, dst.h);
          };
          const q = frame.quality || 0;
          const bR = u.uBloomRadius, hR = u.uHalationRadius;
          down(next, glow.d[0], bR);
          down(glow.d[0], glow.d[1], bR);
          if (needBloom) {
            if (q >= 1) { bloomTex = glow.d[1].tex; }
            else { up(glow.d[1], glow.bloom, bR); bloomTex = glow.bloom.tex; }
          }
          if (needHal && q < 2) {
            down(glow.d[1], glow.d[2], hR);
            down(glow.d[2], glow.d[3], hR);
            up(glow.d[3], glow.halA, hR);
            up(glow.halA, glow.halB, hR);
            halTex = glow.halB.tex;
          }
        }

        const S = progs.screen;
        gl.useProgram(S.p);
        setUniforms(gl, S, u);
        bindSampler(gl, S, 'uHBeamA', 0, hbeam.tex);
        bindSampler(gl, S, 'uHBeamB', 1, hbeam.tex2);
        bindSampler(gl, S, 'uBloomTex', 2, bloomTex);
        bindSampler(gl, S, 'uHalationTex', 3, halTex);
        bindSampler(gl, S, 'uMask', 4, maskRow.tex);
        draw(null, S, canvas.width, canvas.height);
      },

      clearPersistence() {
        for (const t of persist) {
          if (!t) continue;
          gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
          gl.clearBufferfv(gl.COLOR, 0, new Float32Array([0, 0, 0, 1]));
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      },

      // Tests only: RGBA8 of the frame just drawn, top row first.
      readPixels() {
        const w = canvas.width, h = canvas.height;
        const raw = new Uint8Array(w * h * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
        const out = new Uint8Array(raw.length);
        const row = w * 4;
        for (let y = 0; y < h; y++) out.set(raw.subarray((h - 1 - y) * row, (h - y) * row), y * row);
        return out;
      },

      destroy() {
        if (gl.isContextLost()) return;
        persist.forEach(freeTarget);
        freeTarget(hbeam);
        freeTarget(maskRow);
        freeGlow();
        gl.deleteTexture(src.tex);
        for (const k in progs) gl.deleteProgram(progs[k].p);
        gl.deleteBuffer(vbo);
        gl.deleteVertexArray(vao);
      },
    };
    return backend;
  }

  CRT.backends.webgl2 = { create };
})();
