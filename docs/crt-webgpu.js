// CRT engine v2 — WebGPU backend (HDR where the display has it).
//
// The same passes as crt-webgl2.js, in WGSL — persist, hbeam, mask, the
// glow chain, screen — reading the same uniform values from the chassis.
// What it adds is the output: on an HDR display the canvas is
// rgba16float / display-p3 / toneMapping 'extended', so the lit phosphor
// can be driven above page white while the grille stays dark (the
// chassis raises `headroom` to opts.hdrHeadroom). Elsewhere it renders
// SDR exactly like the WebGL2 backend (the parity tests hold it to that).
//
// WebGPU needs an adapter and device before the canvas is touched, and a
// canvas's context type is permanent — so this backend is only reachable
// through the async CRT.create(), which prepares the device first and
// falls back to WebGL2 on the same canvas if that fails.
(function () {
  'use strict';
  const CRT = window.CRT;
  if (!CRT) return;

  // Every chassis uniform this backend packs. The parity of this list with
  // CRT#_uniforms() is a test (webgpu.test.js): a uniform the chassis
  // gains must be packed here too, or the two backends drift.
  const UNIFORM_KEYS = [
    'uSignalSize', 'uOutSize', 'uExposure', 'uSignalP3',
    'uBeamEnabled', 'uBeamMin', 'uBeamMax', 'uBeamShape', 'uFocusPx', 'uTriadFloorPx', 'uConvergence',
    'uGrilleEnabled', 'uTriadsAcross', 'uStripeFill', 'uMaskStrength', 'uMaskSoftness', 'uHeadroom',
    'uBloom', 'uBloomRadius', 'uHalation', 'uHalationRadius',
    'uDamperY', 'uDamperStrength', 'uDamperWidthPx',
    'uGradeGains', 'uGradeSaturation', 'uWarmup', 'uToneEnabled', 'uShoulderStart',
    'uVignette', 'uCornerRadius', 'uCurvature', 'uGloss', 'uOutputP3',
  ];

  // One uniform block for every pass, all vec4s (no alignment surprises).
  const PRELUDE = /* wgsl */ `
struct U {
  sizes: vec4f,   // signalW, signalH, outW, outH
  fit: vec4f,     // scale.xy, offset.xy
  m0: vec4f,      // decay, exposure, signalP3, headroom
  beam: vec4f,    // enabled, min, max, shape
  beam2: vec4f,   // focusPx, triadFloorPx, grilleEnabled, triadsAcross
  conv: vec4f,    // r, g, b, srcDown
  grille: vec4f,  // stripeFill, maskStrength, maskSoftness, toneEnabled
  glow: vec4f,    // bloom, bloomRadius, halation, halationRadius
  damper: vec4f,  // y0, y1, strength, widthPx
  grade: vec4f,   // gains.rgb, saturation
  tone: vec4f,    // warmup, shoulderStart, vignette, cornerRadius
  glass: vec4f,   // curvature, gloss, outputP3, -
  glowA: vec4f,   // texel.xy, offset, -   (glow passes)
  glowB: vec4f,   // dst.xy, -, -   (glow passes)
};
@group(0) @binding(0) var<uniform> u: U;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
`;
  const UNIFORM_BYTES = 14 * 16;
  const SLOT = 256;                      // minUniformBufferOffsetAlignment

  const PERSIST = PRELUDE + /* wgsl */ `
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var src: texture_2d<f32>;
@group(0) @binding(3) var prev: texture_2d<f32>;
const P3_TO_SRGB = mat3x3f(
   1.2249401, -0.0420569, -0.0196376,
  -0.2249404,  1.0420571, -0.0786361,
   0.0000001,  0.0000000,  1.0982735);
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let uv = pos.xy / u.sizes.xy;
  let s = (uv - u.fit.zw) / u.fit.xy;
  var live = vec3f(0.0);
  if (all(s >= vec2f(0.0)) && all(s <= vec2f(1.0))) {
    if (u.conv.w > 0.5) {
      // Downscaling video: average a 2×2 spread over the signal pixel's
      // footprint (the WebGL2 path uses mipmaps for the same job).
      let fp = 0.25 / (u.sizes.xy * u.fit.xy);
      live = 0.25 * (textureSampleLevel(src, samp, s + vec2f(-fp.x, -fp.y), 0.0).rgb +
                     textureSampleLevel(src, samp, s + vec2f( fp.x, -fp.y), 0.0).rgb +
                     textureSampleLevel(src, samp, s + vec2f(-fp.x,  fp.y), 0.0).rgb +
                     textureSampleLevel(src, samp, s + vec2f( fp.x,  fp.y), 0.0).rgb);
    } else {
      live = textureSampleLevel(src, samp, s, 0.0).rgb;   // rgba8unorm-srgb: hardware-decoded, linear
    }
  }
  if (u.m0.z > 0.5) { live = P3_TO_SRGB * live; }
  live = max(live, vec3f(0.0)) * u.m0.y;
  let pr = textureLoad(prev, vec2i(pos.xy), 0).rgb;
  return vec4f(max(live, pr * u.m0.x), 1.0);
}`;

  const HBEAM = PRELUDE + /* wgsl */ `
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var persist: texture_2d<f32>;
struct Out { @location(0) a: vec4f, @location(1) b: vec4f };
const INV_SQRT_2PI = 0.3989422804;
@fragment fn fs(@builtin(position) pos: vec4f) -> Out {
  let sigma = max(max(u.beam2.x, u.beam2.y), 0.05);
  let R = i32(min(ceil(2.5 * sigma), 16.0));
  let y = pos.y / u.sizes.y;
  var sum = vec3f(0.0);
  var wsum = 0.0;
  for (var k = -R; k <= R; k++) {
    let fk = f32(k);
    let w = exp(-0.5 * fk * fk / (sigma * sigma));
    sum.r += w * textureSampleLevel(persist, samp, vec2f((pos.x + fk + u.conv.x) / u.sizes.x, y), 0.0).r;
    sum.g += w * textureSampleLevel(persist, samp, vec2f((pos.x + fk + u.conv.y) / u.sizes.x, y), 0.0).g;
    sum.b += w * textureSampleLevel(persist, samp, vec2f((pos.x + fk + u.conv.z) / u.sizes.x, y), 0.0).b;
    wsum += w;
  }
  let L = max(sum / wsum, vec3f(0.0));
  var o: Out;
  if (u.beam.x < 0.5) { o.a = vec4f(L, 1.0); o.b = vec4f(0.0); return o; }
  let lines = u.sizes.y / u.sizes.w;
  let extra = lines * lines / 12.0 + 0.1 * smoothstep(0.3, 0.6, lines);
  let sig = mix(vec3f(u.beam.y), vec3f(u.beam.z), pow(L, vec3f(u.beam.w)));
  let s2 = sig * sig + extra;
  o.a = vec4f(L * inverseSqrt(s2) * INV_SQRT_2PI, 1.0);
  o.b = vec4f(-0.5 / s2, 1.0);
  return o;
}`;

  const MASK = PRELUDE + /* wgsl */ `
fn boxI(uu: f32, d: f32) -> f32 { let n = floor(uu); return n * d + min(uu - n, d); }
fn boxI2(uu: f32, d: f32) -> f32 {
  let n = floor(uu);
  let r = uu - n;
  var part = d * r - 0.5 * d * d;
  if (r < d) { part = 0.5 * r * r; }
  return 0.5 * d * n * (n - 1.0) + n * (d - 0.5 * d * d) + n * d * r + part;
}
fn stripe(t: f32, phase: f32, d: f32, px: f32) -> f32 {
  let uu = fract(t - phase) + 2.0;
  let box = (boxI(uu + 0.5 * px, d) - boxI(uu - 0.5 * px, d)) / px;
  let tent = (boxI2(uu + px, d) - 2.0 * boxI2(uu, d) + boxI2(uu - px, d)) / (px * px);
  return mix(box, tent, u.grille.z);
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let triadPx = u.sizes.z / u.beam2.w;
  let t = pos.x / triadPx;
  let px = min(1.0 / triadPx, 1.0);
  let duty = u.grille.x / 3.0;
  let off = (1.0 - u.grille.x) / 6.0;
  let P = vec3f(stripe(t, off, duty, px), stripe(t, 1.0 / 3.0 + off, duty, px), stripe(t, 2.0 / 3.0 + off, duty, px));
  return vec4f(P / duty, 1.0);
}`;

  const DOWN = PRELUDE + /* wgsl */ `
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let uv = pos.xy / u.glowB.xy;
  let h = u.glowA.xy * u.glowA.z;
  var c = textureSampleLevel(tex, samp, uv, 0.0).rgb * 4.0;
  c += textureSampleLevel(tex, samp, uv + vec2f(-h.x, -h.y), 0.0).rgb;
  c += textureSampleLevel(tex, samp, uv + vec2f( h.x, -h.y), 0.0).rgb;
  c += textureSampleLevel(tex, samp, uv + vec2f(-h.x,  h.y), 0.0).rgb;
  c += textureSampleLevel(tex, samp, uv + vec2f( h.x,  h.y), 0.0).rgb;
  return vec4f(c / 8.0, 1.0);
}`;

  const UP = PRELUDE + /* wgsl */ `
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let uv = pos.xy / u.glowB.xy;
  let h = u.glowA.xy * u.glowA.z;
  var c = textureSampleLevel(tex, samp, uv + vec2f(-2.0 * h.x, 0.0), 0.0).rgb;
  c += textureSampleLevel(tex, samp, uv + vec2f( 2.0 * h.x, 0.0), 0.0).rgb;
  c += textureSampleLevel(tex, samp, uv + vec2f(0.0, -2.0 * h.y), 0.0).rgb;
  c += textureSampleLevel(tex, samp, uv + vec2f(0.0,  2.0 * h.y), 0.0).rgb;
  c += textureSampleLevel(tex, samp, uv + vec2f(-h.x, -h.y), 0.0).rgb * 2.0;
  c += textureSampleLevel(tex, samp, uv + vec2f( h.x, -h.y), 0.0).rgb * 2.0;
  c += textureSampleLevel(tex, samp, uv + vec2f(-h.x,  h.y), 0.0).rgb * 2.0;
  c += textureSampleLevel(tex, samp, uv + vec2f( h.x,  h.y), 0.0).rgb * 2.0;
  return vec4f(c / 12.0, 1.0);
}`;

  const SCREEN = PRELUDE + /* wgsl */ `
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var hbA: texture_2d<f32>;
@group(0) @binding(3) var hbB: texture_2d<f32>;
@group(0) @binding(4) var mask: texture_2d<f32>;
@group(0) @binding(5) var bloomTex: texture_2d<f32>;
@group(0) @binding(6) var halTex: texture_2d<f32>;
const SRGB_TO_P3 = mat3x3f(
  0.8224621, 0.0331941, 0.0170827,
  0.1775380, 0.9668058, 0.0723974,
  0.0000000, 0.0000000, 0.9105199);
fn enc1(l: f32) -> f32 {
  let a = abs(l);
  var e = 1.055 * pow(a, 1.0 / 2.4) - 0.055;
  if (a <= 0.0031308) { e = 12.92 * a; }
  return sign(l) * e;
}
fn beam(sp: vec2f) -> vec3f {
  if (u.beam.x < 0.5) { return textureSampleLevel(hbA, samp, sp / u.sizes.xy, 0.0).rgb; }
  let j0 = i32(floor(sp.y - 0.5)) - 1;
  var sum = vec3f(0.0);
  for (var k = 0; k < 4; k++) {
    let j = j0 + k;
    if (j < 0 || j >= i32(u.sizes.y)) { continue; }
    let dy = sp.y - (f32(j) + 0.5);
    let uv = vec2f(sp.x / u.sizes.x, (f32(j) + 0.5) / u.sizes.y);
    sum += textureSampleLevel(hbA, samp, uv, 0.0).rgb * exp(dy * dy * textureSampleLevel(hbB, samp, uv, 0.0).rgb);
  }
  return sum;
}
fn grilleMix(L: vec3f, xOut: f32) -> vec3f {
  if (u.beam2.z < 0.5) { return L; }
  let Pn = textureSampleLevel(mask, samp, vec2f(xOut / u.sizes.z, 0.5), 0.0).rgb;
  let duty = u.grille.x / 3.0;
  let s = clamp((u.m0.w / max(L, vec3f(1e-4)) - 1.0) / (1.0 / duty - 1.0), vec3f(0.0), vec3f(u.grille.y));
  return L * mix(vec3f(1.0), Pn, s);
}
fn damper(yOut: f32) -> f32 {
  var shade = 1.0;
  for (var i = 0; i < 2; i++) {
    let f = select(u.damper.y, u.damper.x, i == 0);
    if (f < 0.0) { continue; }
    let c = f * u.sizes.w;
    let hw = 0.5 * u.damper.w;
    let cov = max(0.0, min(yOut + 0.5, c + hw) - max(yOut - 0.5, c - hw));
    shade *= 1.0 - u.damper.z * min(cov, 1.0);
  }
  return shade;
}
fn curve(p: vec2f) -> vec2f {
  if (u.glass.x <= 0.0) { return p; }
  let cx = p.x - 0.5;
  return vec2f(cx * (1.0 + u.glass.x * cx * cx * 4.0) + 0.5, p.y);
}
fn shoulder(c: vec3f) -> vec3f {
  let H = u.m0.w;
  let k = u.tone.y * H;
  let m = max(c.r, max(c.g, c.b));
  if (u.grille.w < 0.5 || m <= k) { return c; }
  let x = m - k;
  return c * ((k + x / (1.0 + x / (H - k))) / m);
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let p0 = pos.xy / u.sizes.zw;                 // top-first already in WebGPU
  let p = curve(p0);
  if (any(p < vec2f(0.0)) || any(p > vec2f(1.0))) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  var c = beam(p * u.sizes.xy);
  c = grilleMix(c, p.x * u.sizes.z);
  c *= damper(p.y * u.sizes.w);
  if (u.glow.x > 0.0) { c += textureSampleLevel(bloomTex, samp, p, 0.0).rgb * u.glow.x; }
  if (u.glow.z > 0.0) { c += textureSampleLevel(halTex, samp, p, 0.0).rgb * u.glow.z; }
  let luma = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  c = mix(vec3f(luma), c, u.grade.w) * u.grade.xyz;
  c *= u.tone.x;
  let q = (p0 - 0.5) * 2.0;
  c *= 1.0 - u.tone.z * pow(clamp(length(q) * 0.7071, 0.0, 1.0), 3.0);
  let g = (p0 - vec2f(0.3, 0.2)) / vec2f(0.18, 0.12);
  c += vec3f(u.glass.y * exp(-0.5 * dot(g, g)));
  if (u.tone.w > 0.0) {
    let px = (p0 - 0.5) * u.sizes.zw;
    let r = u.tone.w * min(u.sizes.z, u.sizes.w);
    let d = length(max(abs(px) - (0.5 * u.sizes.zw - vec2f(r)), vec2f(0.0))) - r;
    c *= 1.0 - smoothstep(-1.0, 0.5, d);
  }
  c = shoulder(c);
  if (u.glass.z > 0.5) { c = SRGB_TO_P3 * c; }
  let e = clamp(c, vec3f(0.0), vec3f(u.m0.w));
  return vec4f(enc1(e.r), enc1(e.g), enc1(e.b), 1.0);
}`;

  function pack(f32, base, u, x) {
    const v = [
      u.uSignalSize[0], u.uSignalSize[1], u.uOutSize[0], u.uOutSize[1],
      x.fit.scale[0], x.fit.scale[1], x.fit.offset[0], x.fit.offset[1],
      x.decay, u.uExposure, u.uSignalP3, u.uHeadroom,
      u.uBeamEnabled, u.uBeamMin, u.uBeamMax, u.uBeamShape,
      u.uFocusPx, u.uTriadFloorPx, u.uGrilleEnabled, u.uTriadsAcross,
      u.uConvergence[0], u.uConvergence[1], u.uConvergence[2], x.srcDown,
      u.uStripeFill, u.uMaskStrength, u.uMaskSoftness, u.uToneEnabled,
      u.uBloom, u.uBloomRadius, u.uHalation, u.uHalationRadius,
      u.uDamperY[0], u.uDamperY[1], u.uDamperStrength, u.uDamperWidthPx,
      u.uGradeGains[0], u.uGradeGains[1], u.uGradeGains[2], u.uGradeSaturation,
      u.uWarmup, u.uShoulderStart, u.uVignette, u.uCornerRadius,
      u.uCurvature, u.uGloss, u.uOutputP3, 0,
      x.texel[0], x.texel[1], x.offset, 0,
      x.dst[0], x.dst[1], 0, 0,
    ];
    f32.set(v, base / 4);
  }

  // Acquire adapter + device and build every pipeline without touching the
  // canvas (see header). createRenderPipelineAsync rejects on WGSL or
  // validation errors — so a shader the browser's compiler dislikes fails
  // here, where CRT.create can still fall back to WebGL2, instead of
  // rendering a silent black canvas later. Screen pipelines are built for
  // every canvas format create() might configure.
  const F16 = 'rgba16float';
  async function prepare() {
    const adapter = navigator.gpu && await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('WebGPU unavailable: no adapter');
    const device = await adapter.requestDevice();
    try {
      const mods = {};
      const pipe = async (name, code, formats) => {
        const module = mods[name] || (mods[name] = device.createShaderModule({ code }));
        return device.createRenderPipelineAsync({
          layout: 'auto',
          vertex: { module, entryPoint: 'vs' },
          fragment: { module, entryPoint: 'fs', targets: formats.map((f) => ({ format: f })) },
          primitive: { topology: 'triangle-list' },
        });
      };
      const screenFormats = [navigator.gpu.getPreferredCanvasFormat()];
      if (window.matchMedia && window.matchMedia('(dynamic-range: high)').matches && !screenFormats.includes(F16)) screenFormats.push(F16);
      const [persist, hbeam, mask, down, up, ...screens] = await Promise.all([
        pipe('persist', PERSIST, [F16]), pipe('hbeam', HBEAM, [F16, F16]), pipe('mask', MASK, [F16]),
        pipe('down', DOWN, [F16]), pipe('up', UP, [F16]),
        ...screenFormats.map((f) => pipe('screen', SCREEN, [f])),
      ]);
      const screen = {};
      screenFormats.forEach((f, i) => { screen[f] = screens[i]; });
      return { adapter, device, pipelines: { persist, hbeam, mask, down, up, screen } };
    } catch (e) {
      device.destroy();
      throw e;
    }
  }

  function create(canvas, { opts, chassis }) {
    const prep = opts._prepared;
    if (!prep || !prep.device || !prep.pipelines) throw new Error('WebGPU unavailable: use CRT.create()');
    const device = prep.device;
    const ctx = canvas.getContext('webgpu');
    if (!ctx) throw new Error('WebGPU unavailable: no canvas context');

    // Output: HDR (extended range, P3) when the display reports high
    // dynamic range and the browser accepts it; otherwise SDR, P3 where
    // the display has the gamut.
    const mm = (q) => !!(window.matchMedia && window.matchMedia(q).matches);
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | (opts._testReadback ? GPUTextureUsage.COPY_SRC : 0);
    let hdr = false, format, colorSpace;
    if (mm('(dynamic-range: high)')) {
      try {
        ctx.configure({ device, format: 'rgba16float', colorSpace: 'display-p3', toneMapping: { mode: 'extended' }, alphaMode: 'opaque', usage });
        const cfg = ctx.getConfiguration ? ctx.getConfiguration() : null;
        hdr = !!(cfg && cfg.toneMapping && cfg.toneMapping.mode === 'extended');
        if (hdr) { format = 'rgba16float'; colorSpace = 'display-p3'; }
      } catch (_) { hdr = false; }
    }
    if (!hdr) {
      format = navigator.gpu.getPreferredCanvasFormat();
      const wantP3 = opts.outputColorSpace === 'display-p3' || (opts.outputColorSpace === 'auto' && mm('(color-gamut: p3)'));
      colorSpace = wantP3 ? 'display-p3' : 'srgb';
      ctx.configure({ device, format, colorSpace, alphaMode: 'opaque', usage });
    }

    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const P = Object.assign({}, prep.pipelines, { screen: prep.pipelines.screen[format] });
    if (!P.screen) throw new Error(`CRT WebGPU: no screen pipeline for ${format}`);

    const SLOTS = 11;
    const ubuf = device.createBuffer({ size: SLOTS * SLOT, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const ustage = new Float32Array(SLOTS * SLOT / 4);

    const target = (w, h) => device.createTexture({
      size: [Math.max(1, w), Math.max(1, h)], format: F16,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    let signal = [1, 1], out = [1, 1];
    let persist = [], hbA = null, hbB = null, maskRow = null, glow = null;
    let src = null, srcSize = [0, 0];
    let fit = { scale: [1, 1], offset: [0, 0] };
    let srcDown = 0;
    let flip = 0;
    let readback = null;
    const destroyAll = (arr) => arr.forEach((t) => t && t.destroy());

    // Device loss (GPU reset, driver update, OS reclaim): halt cleanly and
    // tell the owner, who can rebuild through CRT.create (a new device) or
    // fall back. Our own destroy() is not a loss.
    let destroying = false;
    device.lost.then((info) => {
      if (destroying) return;
      console.warn('[crt] WebGPU device lost:', info.message);
      chassis._haltLoop();
      chassis._backend = null;
      if (typeof opts.onLost === 'function') opts.onLost(info);
    });

    const bind = (pipeline, slot, textures) => device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: ubuf, offset: slot * SLOT, size: UNIFORM_BYTES } },
        ...(textures.length ? [{ binding: 1, resource: sampler }] : []),
        ...textures.map((t, i) => ({ binding: i + 2, resource: t.createView() })),
      ],
    });
    // Mask has no sampler/textures; persist needs prev via textureLoad (still bound as a texture).
    const draw = (enc, pipeline, group, views) => {
      const pass = enc.beginRenderPass({ colorAttachments: views.map((v) => ({ view: v, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } })) });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
    };

    const backend = {
      kind: 'webgpu',
      hdr,
      outputColorSpace: colorSpace,

      resize(w, h) {
        canvas.width = w; canvas.height = h;
        out = [w, h];
        if (maskRow) maskRow.destroy();
        maskRow = target(w, 1);
      },

      setSignalSize(w, h) {
        signal = [w, h];
        destroyAll(persist); destroyAll([hbA, hbB]);
        if (glow) destroyAll([...glow.d, glow.bloom, glow.halA, glow.halB]);
        persist = [target(w, h), target(w, h)];
        hbA = target(w, h); hbB = target(w, h);
        const lv = (k) => target(Math.max(1, w >> k), Math.max(1, h >> k));
        glow = { d: [lv(1), lv(2), lv(3), lv(4)], bloom: lv(1), halA: lv(3), halB: lv(2) };
        backend.clearPersistence();
      },

      upload(source, f) {
        fit = f;
        const w = source.videoWidth || source.width, h = source.videoHeight || source.height;
        if (!w || !h) return;
        if (!src || srcSize[0] !== w || srcSize[1] !== h) {
          if (src) src.destroy();
          src = device.createTexture({ size: [w, h], format: 'rgba8unorm-srgb',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
          srcSize = [w, h];
        }
        srcDown = (w > signal[0] * 1.5 || h > signal[1] * 1.5) ? 1 : 0;
        device.queue.copyExternalImageToTexture({ source }, { texture: src,
          colorSpace: opts.signalColorSpace === 'display-p3' ? 'display-p3' : 'srgb' }, [w, h]);
      },

      render(frame) {
        const u = frame.uniforms;
        if (!src) {           // nothing uploaded yet: a defined black source
          src = device.createTexture({ size: [1, 1], format: 'rgba8unorm-srgb', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
          srcSize = [1, 1];
        }
        const base = { fit, decay: frame.decay, srcDown, texel: [0, 0], offset: 0, dst: [0, 0] };
        const slot = (i, extra) => pack(ustage, i * SLOT, u, Object.assign({}, base, extra));
        const prev = persist[flip], next = persist[1 - flip];
        const q = frame.quality || 0;
        const needBloom = u.uBloom > 0, needHal = u.uHalation > 0 && q < 2;
        const lvl = (t, k) => ({ texel: [1 / t.width, 1 / t.height], offset: k });
        slot(0, {}); slot(1, {}); slot(2, {});
        slot(3, Object.assign(lvl(next, u.uBloomRadius), { dst: [glow.d[0].width, glow.d[0].height] }));
        slot(4, Object.assign(lvl(glow.d[0], u.uBloomRadius), { dst: [glow.d[1].width, glow.d[1].height] }));
        slot(5, Object.assign(lvl(glow.d[1], u.uHalationRadius), { dst: [glow.d[2].width, glow.d[2].height] }));
        slot(6, Object.assign(lvl(glow.d[2], u.uHalationRadius), { dst: [glow.d[3].width, glow.d[3].height] }));
        slot(7, Object.assign(lvl(glow.d[1], u.uBloomRadius), { dst: [glow.bloom.width, glow.bloom.height] }));
        slot(8, Object.assign(lvl(glow.d[3], u.uHalationRadius), { dst: [glow.halA.width, glow.halA.height] }));
        slot(9, Object.assign(lvl(glow.halA, u.uHalationRadius), { dst: [glow.halB.width, glow.halB.height] }));
        slot(10, {});
        device.queue.writeBuffer(ubuf, 0, ustage);

        const enc = device.createCommandEncoder();
        draw(enc, P.persist, bind(P.persist, 0, [src, prev]), [next.createView()]);
        flip = 1 - flip;
        draw(enc, P.hbeam, bind(P.hbeam, 1, [next]), [hbA.createView(), hbB.createView()]);
        if (u.uGrilleEnabled) draw(enc, P.mask, bind(P.mask, 2, []), [maskRow.createView()]);
        let bloomTex = next, halTex = next;
        if (needBloom || needHal) {
          draw(enc, P.down, bind(P.down, 3, [next]), [glow.d[0].createView()]);
          draw(enc, P.down, bind(P.down, 4, [glow.d[0]]), [glow.d[1].createView()]);
          if (needBloom) {
            if (q >= 1) bloomTex = glow.d[1];
            else { draw(enc, P.up, bind(P.up, 7, [glow.d[1]]), [glow.bloom.createView()]); bloomTex = glow.bloom; }
          }
          if (needHal) {
            draw(enc, P.down, bind(P.down, 5, [glow.d[1]]), [glow.d[2].createView()]);
            draw(enc, P.down, bind(P.down, 6, [glow.d[2]]), [glow.d[3].createView()]);
            draw(enc, P.up, bind(P.up, 8, [glow.d[3]]), [glow.halA.createView()]);
            draw(enc, P.up, bind(P.up, 9, [glow.halA]), [glow.halB.createView()]);
            halTex = glow.halB;
          }
        }
        const current = ctx.getCurrentTexture();
        draw(enc, P.screen, bind(P.screen, 10, [hbA, hbB, maskRow, bloomTex, halTex]), [current.createView()]);

        if (opts._testReadback) {
          const bpp = format === 'rgba16float' ? 8 : 4;
          const bytesPerRow = Math.ceil(out[0] * bpp / 256) * 256;
          if (readback) readback.destroy();
          readback = { buf: device.createBuffer({ size: bytesPerRow * out[1], usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }), bytesPerRow, bpp, w: out[0], h: out[1] };
          enc.copyTextureToBuffer({ texture: current }, { buffer: readback.buf, bytesPerRow }, [out[0], out[1]]);
        }
        device.queue.submit([enc.finish()]);
      },

      clearPersistence() {
        const enc = device.createCommandEncoder();
        for (const t of persist) {
          const pass = enc.beginRenderPass({ colorAttachments: [{ view: t.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
          pass.end();
        }
        device.queue.submit([enc.finish()]);
      },

      // Tests only (opts._testReadback): RGBA8 of the last frame, top row
      // first. Async — WebGPU readback maps a buffer.
      async readPixels() {
        if (!readback) return null;
        const { buf, bytesPerRow, bpp, w, h } = readback;
        await buf.mapAsync(GPUMapMode.READ);
        const raw = new Uint8Array(buf.getMappedRange());
        const outPx = new Uint8Array(w * h * 4);
        const bgra = format === 'bgra8unorm';
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const i = y * bytesPerRow + x * bpp, o = (y * w + x) * 4;
          if (bpp === 4) {
            outPx[o] = raw[i + (bgra ? 2 : 0)]; outPx[o + 1] = raw[i + 1]; outPx[o + 2] = raw[i + (bgra ? 0 : 2)]; outPx[o + 3] = 255;
          }
        }
        buf.unmap();
        return outPx;
      },

      destroy() {
        destroyAll(persist); destroyAll([hbA, hbB, maskRow, src]);
        if (glow) destroyAll([...glow.d, glow.bloom, glow.halA, glow.halB]);
        if (readback) readback.buf.destroy();
        ubuf.destroy();
        try { ctx.unconfigure(); } catch (_) { /* older engines */ }
        destroying = true;
        device.destroy();               // each CRT.create prepares its own device
      },
    };
    return backend;
  }

  CRT.backends.webgpu = { create, prepare, UNIFORM_KEYS };
})();
