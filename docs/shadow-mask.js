(function () {
  'use strict';

  function compileShader(gl, type, source) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('Shader compile failed: ' + log);
    }
    return sh;
  }

  function linkProgram(gl, vs, fs) {
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error('Program link failed: ' + log);
    }
    return prog;
  }

  // Shared vertex shader: full-screen triangle that covers the viewport
  // after clipping. Saves one vertex vs a quad and avoids the diagonal
  // seam in some GPU drivers' interpolation. The explicit layout
  // location is load-bearing — every program below relies on aPos
  // being at attribute 0 (matches the VAO setup in _initGpu).
  const FULLSCREEN_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

  // Phosphor fragment shader — delta-triad hex-tiled dot lattice,
  // beam spread.
  // MRT: slot 0 = phosphor output, slot 1 = persistence next-frame.
  const PHOSPHOR_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSignal;
uniform sampler2D uPersistencePrev;
uniform vec2 uViewSize;
uniform vec2 uCellSize;
uniform float uPersistence;
uniform vec2 uConvergenceR;
uniform vec2 uConvergenceG;
uniform vec2 uConvergenceB;
uniform float uBeamSpreadPx;
uniform float uBeamSpreadVerticalPx;
uniform float uDotRadius;
uniform float uPhosphorCoupling;
uniform float uStripeEnabled;
uniform float uPersistenceEnabled;
uniform float uConvergenceEnabled;
uniform float uBeamSpreadEnabled;
uniform float uCouplingEnabled;

layout(location = 0) out vec4 oPhosphor;
layout(location = 1) out vec4 oPersistenceNext;

// Same beam-spread sampler as Trinitron's — anisotropic 9-tap Gaussian.
// Shadow-mask defaults to isotropic (V == H) since the dot lattice
// quantizes both axes; the option exists for parity with the Trinitron
// API.
vec4 sampleBeamSpread(sampler2D tex, vec2 uv, float spreadPxH, float spreadPxV) {
  if (spreadPxH < 0.7 && spreadPxV < 0.7) return texture(tex, uv);
  float dx = spreadPxH / uViewSize.x;
  float dy = spreadPxV / uViewSize.y;
  vec4 sum = texture(tex, uv)                                * 0.252;
  sum     += texture(tex, uv + vec2(0.0, -1.0 * dy))          * 0.226;
  sum     += texture(tex, uv + vec2(0.0,  1.0 * dy))          * 0.226;
  sum     += texture(tex, uv + vec2(0.0, -2.0 * dy))          * 0.148;
  sum     += texture(tex, uv + vec2(0.0,  2.0 * dy))          * 0.148;
  sum     += texture(tex, uv + vec2(-1.0 * dx, 0.0))          * 0.226;
  sum     += texture(tex, uv + vec2( 1.0 * dx, 0.0))          * 0.226;
  sum     += texture(tex, uv + vec2(-2.0 * dx, 0.0))          * 0.148;
  sum     += texture(tex, uv + vec2( 2.0 * dx, 0.0))          * 0.148;
  return sum / 1.748;
}

void main() {
  vec2 px = vUv * uViewSize;

  // Hex-staggered rectangular cell grid. One cell = one phosphor triad =
  // one image pixel on the simulated CRT. Within each cell we paint
  // three small round dots (R top-left, G top-right, B bottom-center)
  // co-located like the real shadow-mask geometry: the three electron
  // guns converge on a single triad position, so R/G/B always live
  // side-by-side at every image pixel rather than being scattered
  // across the lattice. Adjacent rows are x-shifted by half a cell to
  // give the dot field its characteristic honeycomb pattern.
  int row = int(floor(px.y / uCellSize.y));
  float shift = float(row & 1) * uCellSize.x * 0.5;
  int col = int(floor((px.x - shift) / uCellSize.x));

  vec2 cellCenter = vec2(
    (float(col) + 0.5) * uCellSize.x + shift,
    (float(row) + 0.5) * uCellSize.y
  );

  // Sample the signal at the cell center (one sample per triad).
  // Sampling per-fragment instead would let signal edges that cross
  // through a cell slice it into bright/dim halves at the underlying
  // source-vector boundary — real CRT phosphors emit as discrete
  // units. Beam spread, convergence, and persistence all read at this
  // cellUv so the whole triad responds to one signal value.
  vec2 cellUv = cellCenter / uViewSize;

  vec2 cR = (uConvergenceR / uViewSize) * uConvergenceEnabled;
  vec2 cG = (uConvergenceG / uViewSize) * uConvergenceEnabled;
  vec2 cB = (uConvergenceB / uViewSize) * uConvergenceEnabled;

  float beamSpreadH = uBeamSpreadPx * uBeamSpreadEnabled;
  float beamSpreadV = max(beamSpreadH, uBeamSpreadVerticalPx * uBeamSpreadEnabled);
  float sR = sampleBeamSpread(uSignal, cellUv + cR, beamSpreadH, beamSpreadV).r;
  float sG = sampleBeamSpread(uSignal, cellUv + cG, beamSpreadH, beamSpreadV).g;
  float sB = sampleBeamSpread(uSignal, cellUv + cB, beamSpreadH, beamSpreadV).b;
  float sA = sampleBeamSpread(uSignal, cellUv, beamSpreadH, beamSpreadV).a;
  vec4 live = vec4(sR, sG, sB, sA);

  vec4 prev = texture(uPersistencePrev, cellUv);
  float decay = uPersistence * uPersistenceEnabled;
  vec4 lerped = prev * decay + live * (1.0 - decay);

  oPersistenceNext = lerped;

  // Triad geometry — three dot positions within the cell, in source
  // pixels relative to cell center. Inverted-equilateral-ish triangle:
  // R top-left, G top-right, B bottom-center. Inset 30% horizontally
  // and 25% vertically from cell edges so dots stay inside their cell
  // with a small margin (no overflow into neighbor cells, which would
  // get the wrong signal value).
  vec2 local = px - cellCenter;
  vec2 posR = vec2(-0.30, -0.22) * uCellSize;
  vec2 posG = vec2( 0.30, -0.22) * uCellSize;
  vec2 posB = vec2( 0.00,  0.28) * uCellSize;

  // Soft round dot masks. uDotRadius is in source pixels; the ±0.4 px
  // smoothstep window softens dot edges into a glowing fall-off
  // (suggesting phosphor light scatter, not a hard polygon edge).
  float maskR = 1.0 - smoothstep(uDotRadius - 0.4, uDotRadius + 0.4, distance(local, posR));
  float maskG = 1.0 - smoothstep(uDotRadius - 0.4, uDotRadius + 0.4, distance(local, posG));
  float maskB = 1.0 - smoothstep(uDotRadius - 0.4, uDotRadius + 0.4, distance(local, posB));

  // Per-dot emission with phosphor coupling. Each dot emits its
  // primary channel at full signal, plus a fraction of the other two
  // channels at coupling x their signal. This models cross-talk
  // (UV bleed, phosphor cross-contamination, eye-surface blending)
  // and softens the chromatic mismatch when individual dots are
  // visually resolved — a pure-white signal still reads as white at
  // each dot instead of one-channel-tinted. coupling=0 → strict
  // architectural behavior (each dot lights only its primary
  // channel). coupling=1 → all dots emit the full signal (equivalent
  // to painting raw signal, just gated by the dot mask).
  //
  // The mix() honors the stripeProfile toggle: OFF paints the raw
  // signal everywhere, bypassing the triad mask entirely.
  float c = uPhosphorCoupling * uCouplingEnabled;
  vec3 emR = vec3(lerped.r,     c * lerped.g, c * lerped.b);
  vec3 emG = vec3(c * lerped.r, lerped.g,     c * lerped.b);
  vec3 emB = vec3(c * lerped.r, c * lerped.g, lerped.b);
  vec3 dotColors = emR * maskR + emG * maskG + emB * maskB;
  vec3 phosphor = mix(lerped.rgb, dotColors, uStripeEnabled);

  oPhosphor = vec4(phosphor, lerped.a);
}`;

  const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPhosphor;
uniform sampler2D uGloss;
uniform sampler2D uVignette;
uniform sampler2D uBloom;
uniform vec2 uCanvasSize;
uniform float uCurvature;
uniform float uCurvatureMode;       // 0 = spherical (generic), 1 = cylindrical (Trinitron)
uniform float uBloomStrength;
uniform float uBrightness;
uniform float uStripeFraction;
uniform float uStripeMargin;
uniform float uOpaqueBackground;
uniform float uCurvatureEnabled;
uniform float uGlossEnabled;
uniform float uVignetteEnabled;
uniform float uBloomEnabled;
uniform float uScanlineEnabled;
uniform float uScanlineCycles;      // number of bright/dim cycles across stripeUv.y = 1
uniform float uScanlineDepth;       // 0 = no scanlines, 1 = troughs hit zero
out vec4 oColor;

vec2 curveUv(vec2 uv, float cAmt, float mode) {
  vec2 c = uv - 0.5;
  vec2 warped;
  if (mode > 0.5) {
    // Cylindrical (Trinitron face): warp X only, by x-distance from
    // the vertical center axis. Vertical lines stay straight.
    warped = vec2(c.x * (1.0 + cAmt * c.x * c.x * 4.0), c.y);
  } else {
    // Spherical / generic barrel: r²-based warp on both axes.
    float r2 = dot(c, c);
    warped = c * (1.0 + cAmt * r2 * 4.0);
  }
  return warped + 0.5;
}

void main() {
  float curvAmt = uCurvature * uCurvatureEnabled;
  vec2 sampleUv = curveUv(vUv, curvAmt, uCurvatureMode);
  if (sampleUv.x < 0.0 || sampleUv.x > 1.0 ||
      sampleUv.y < 0.0 || sampleUv.y > 1.0) {
    // Out of bounds (e.g. curvature corners): transparent, not
    // opaque black. Page background shows through.
    oColor = vec4(0.0);
    return;
  }

  // Remap to stripe-region UV: the phosphor texture occupies the
  // central (viewSize * stripeUpscale) / canvasSize fraction of the
  // canvas, with bleed-margin space on each side reserved for the
  // bloom halo to spread into.
  vec2 stripeUv = (sampleUv - vec2(uStripeMargin)) / uStripeFraction;
  bool inStripe = stripeUv.x >= 0.0 && stripeUv.x <= 1.0 &&
                  stripeUv.y >= 0.0 && stripeUv.y <= 1.0;

  vec3 color = vec3(0.0);
  // Canvas alpha tracks the silhouette mask (phos.a) — sharp edge,
  // softened only by the upstream beam-spread blur on the signal.
  // When opaqueBackground=true (any opaque CRT face), the
  // uniform mix below forces alpha to 1 regardless.
  float alpha = 0.0;
  if (inStripe) {
    vec4 phos = texture(uPhosphor, stripeUv);
    color = phos.rgb;
    alpha = phos.a;
    vec4 bloom = texture(uBloom, stripeUv);
    color += bloom.rgb * uBloomStrength * uBloomEnabled;

    // Horizontal scanlines: cosine modulation along stripeUv.y. cycle
    // peaks (cos=1) stay full brightness; troughs (cos=-1) dim by
    // uScanlineDepth. uScanlineCycles is set so one cycle equals
    // scanlinePeriod source pixels.
    if (uScanlineEnabled > 0.5) {
      float wave = 0.5 - 0.5 * cos(stripeUv.y * uScanlineCycles * 6.28318530718);
      color *= 1.0 - uScanlineDepth * wave;
    }
  }

  vec4 gloss = texture(uGloss, sampleUv);
  color += vec3(gloss.a) * uGlossEnabled;

  vec4 vig = texture(uVignette, sampleUv);
  color *= mix(1.0, vig.r, uVignetteEnabled);

  color *= uBrightness;

  // opaqueBackground=true → canvas is always fully opaque (e.g.,
  // a CRT face filling its card). false → alpha follows the
  // silhouette+bloom mask (e.g., a logo on transparent page bg).
  float finalAlpha = mix(alpha, 1.0, uOpaqueBackground);
  oColor = vec4(color, finalAlpha);
}`;

  const BLOOM_THRESHOLD_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPhosphor;
uniform float uThreshold;
out vec4 oColor;
void main() {
  vec4 c = texture(uPhosphor, vUv);
  float luma = max(c.r, max(c.g, c.b));
  float overshoot = max(0.0, luma - uThreshold);
  oColor = vec4(c.rgb * overshoot, c.a);
}`;

  // Separable Gaussian. The base 9-tap kernel (weights 0.227027,
  // 0.194594, 0.121622, 0.054054, 0.016216 at offsets 0..4) corresponds
  // to a sigma of ~2 texels in the bloom (half-res) texture. uBlurRadius
  // scales the offsets — keeping the weights fixed and just stretching
  // the kernel widens the visible halo without re-tuning weights. The
  // CPU side picks the reference so that bleedRadius=30 → uBlurRadius=1
  // (i.e., the original visible spread).
  const BLOOM_BLUR_H_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexSize;
uniform float uBlurRadius;
out vec4 oColor;
void main() {
  vec2 px = 1.0 / uTexSize;
  float r = uBlurRadius;
  vec4 sum = texture(uTex, vUv) * 0.227027;
  sum += texture(uTex, vUv + vec2( px.x * 1.0 * r, 0.0)) * 0.194594;
  sum += texture(uTex, vUv + vec2(-px.x * 1.0 * r, 0.0)) * 0.194594;
  sum += texture(uTex, vUv + vec2( px.x * 2.0 * r, 0.0)) * 0.121622;
  sum += texture(uTex, vUv + vec2(-px.x * 2.0 * r, 0.0)) * 0.121622;
  sum += texture(uTex, vUv + vec2( px.x * 3.0 * r, 0.0)) * 0.054054;
  sum += texture(uTex, vUv + vec2(-px.x * 3.0 * r, 0.0)) * 0.054054;
  sum += texture(uTex, vUv + vec2( px.x * 4.0 * r, 0.0)) * 0.016216;
  sum += texture(uTex, vUv + vec2(-px.x * 4.0 * r, 0.0)) * 0.016216;
  oColor = sum;
}`;

  const BLOOM_BLUR_V_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexSize;
uniform float uBlurRadius;
out vec4 oColor;
void main() {
  vec2 px = 1.0 / uTexSize;
  float r = uBlurRadius;
  vec4 sum = texture(uTex, vUv) * 0.227027;
  sum += texture(uTex, vUv + vec2(0.0,  px.y * 1.0 * r)) * 0.194594;
  sum += texture(uTex, vUv + vec2(0.0, -px.y * 1.0 * r)) * 0.194594;
  sum += texture(uTex, vUv + vec2(0.0,  px.y * 2.0 * r)) * 0.121622;
  sum += texture(uTex, vUv + vec2(0.0, -px.y * 2.0 * r)) * 0.121622;
  sum += texture(uTex, vUv + vec2(0.0,  px.y * 3.0 * r)) * 0.054054;
  sum += texture(uTex, vUv + vec2(0.0, -px.y * 3.0 * r)) * 0.054054;
  sum += texture(uTex, vUv + vec2(0.0,  px.y * 4.0 * r)) * 0.016216;
  sum += texture(uTex, vUv + vec2(0.0, -px.y * 4.0 * r)) * 0.016216;
  oColor = sum;
}`;

  // Opts the panels snapshot for stateDiff(). curvatureMode and
  // beamSpreadVerticalPx stay listed even though the menu no longer
  // offers them — console-driven changes should still diff.
  const PANEL_OPT_KEYS = [
    'dotRadius', 'phosphorCoupling', 'persistenceHalfLifeMs',
    'beamSpreadPx', 'beamSpreadVerticalPx',
    'curvature', 'curvatureMode', 'bloomThreshold', 'bloomStrength',
    'bleedRadius', 'scanlineDepth', 'scanlinePeriod',
  ];

  class ShadowMask {
    constructor(canvasEl, opts) {
      this.canvas = canvasEl;
      this.opts = Object.assign({
        viewSize: [200, 200],
        canvasSize: [240, 240],
        // Hex-tile dimensions: cellSize.x is the horizontal pitch
        // between adjacent cells in a row; cellSize.y is the row pitch.
        // [3, 3] matches the Trinitron's source-pixel resolution
        // (Trinitron uses cellSize 3 for its stripe pitch), so each
        // letter is resolved by the same number of phosphor positions
        // in either renderer. The hex stagger is then ±1.5 source-px,
        // which floors to 1 — slightly skewed hexes, but the
        // delta-triad geometry still reads.
        cellSize: [3, 3],
        // Radius of each phosphor dot within its cell, in source pixels.
        // Each cell holds a triad of three dots (R, G, B); this controls
        // their size. Values that fit cleanly in cellSize=3 without dot
        // centers (at ±0.30 cellSize from center) overflowing the cell
        // edge: up to ~0.6 px. Larger values pack dots more tightly into
        // a continuous "phosphor field" texture, smaller values leave
        // more black mask area between dots.
        dotRadius: 0.7,
        // Phosphor coupling — each dot emits its primary channel at
        // full signal AND a fraction of the other two channels at
        // `coupling × their signal`. Models phosphor cross-talk and
        // softens the per-dot chromatic mismatch when individual dots
        // are visually resolved (pure white reads as white at each dot
        // rather than one-channel-tinted). 0 = strict architectural
        // behavior, each dot lights only its primary channel; 0.3 ≈
        // tasteful softening; 1 = every dot emits the full signal.
        phosphorCoupling: 0,
        // Integer factor for stretching the signal canvas onto the main
        // canvas via nearest-neighbor drawImage. The shadow-mask phosphor
        // pass tiles dots over the upscaled canvas; an upscale > 1 lets
        // the same source pixel light a larger area of the dot lattice
        // without re-rendering the signal at higher resolution.
        stripeUpscale: 1,
        // Selective-bloom kernel spread in source pixels. The base
        // separable-Gaussian kernel is ~2 texels of the half-res bloom
        // FBO; this value scales the kernel offsets, so bleedRadius=30
        // is the no-scaling baseline (uBlurRadius=1). Lower values get
        // a tighter "phosphor glow at the surface"; higher values get a
        // diffuse "halo through glass." Re-uploaded only via the debug
        // panel — there's no per-frame cost.
        bleedRadius: 30,
        // Phosphor afterglow half-life in ms. Frame-rate independent:
        // each rendered frame converts this to a per-frame decay via
        // pow(0.5, dt / halfLife), so trails are the same length at
        // 60 Hz, 120 Hz, or any video frame rate. 71 ms ≈ the old
        // 0.85-per-frame decay at 60 Hz.
        persistenceHalfLifeMs: 71,
        convergence: { r: [-0.5, -0.5], g: [0.0, 0.0], b: [0.5, 0.5] },
        // Electron-beam spread, applied as a Gaussian blur on the
        // convergence canvases before sampling. A real ShadowMask beam
        // has a fuzzy spot that spreads each scan line into adjacent ones;
        // without this, abrupt features (the bottom of an arm, the cap of
        // a curved edge) terminate razor-sharp mid-phosphor like an LCD.
        // Units are source pixels. Chromium's canvas filter blur no-ops
        // below ~0.7 px, so values under that have no effect.
        beamSpreadPx: 0.0,
        // Additional vertical-only beam spread. When > beamSpreadPx,
        // the kernel becomes anisotropic: horizontal sigma stays at
        // beamSpreadPx, while vertical sigma widens to this
        // value. Most shadow-mask CRTs are isotropic (the dot lattice
        // quantizes both axes the same way), so the default of 0 leaves
        // V == H. The option exists for API parity with the Trinitron
        // renderer where the asymmetry is load-bearing.
        beamSpreadVerticalPx: 0.0,
        // Barrel-distortion strength for the composite glass pass.
        // 0 = flat panel.
        curvature: 0,
        // Curvature axis distribution — tube-determined, not a menu
        // option. A delta-gun shadow-mask face is spherical (generic r²
        // barrel, bowing on both axes). Callers can still override to
        // 'cylindrical' (warp X only, the Trinitron geometry), but the
        // ?debug=1 panel no longer offers the choice.
        curvatureMode: 'spherical',
        // Horizontal scanlines (GPU composite pass). scanlineDepth = 0
        // means flat brightness; 1 means troughs go to black.
        // scanlinePeriod = source pixels per bright/dim cycle, so on a
        // vh=320 hero with period=2 you get 160 scanlines.
        scanlineDepth: 0.18,
        scanlinePeriod: 2,
        bloomThreshold: 0.6,
        bloomStrength: 1.0,
        signal: () => {},
        respectReducedMotion: true,
        // Whether the GPU path should create the ?debug=1 effect-
        // toggle overlay. Only one ShadowMask per page should claim
        // it; secondary instances opt out.
        debugOverlay: true,
        // When true (default), canvas pixels are always opaque —
        // the canvas fills its parent's background and effects like
        // vignette are visible across the entire surface.
        // When false, canvas alpha tracks the phosphor silhouette
        // (plus the bloom feather), so the canvas reads as a
        // cut-out of the page background. The hero screen wants
        // opaque (it's a bounded CRT face); a free-floating logo
        // sim would want transparent.
        opaqueBackground: true,
      }, opts);

      // Per-effect runtime toggles. Mutable; setters take effect on
      // the next frame. The default subset (stripeProfile, phosphorCoupling,
      // persistence, beamSpread) is the minimum that reads as a CRT
      // without piling on effects that fight each other or pull focus
      // from the content. Callers can pass any subset via
      // opts.effects to flip individual defaults.
      this.effects = Object.assign({
        // Phosphor pass — four effects on, one off.
        stripeProfile: true,
        phosphorCoupling: true,
        convergence: false,
        persistence: true,
        beamSpread: true,
        // Composite pass — selectiveBloom is off by default since it
        // interacts oddly with the stripe profile; callers opt in.
        selectiveBloom: false,
        // Horizontal scanlines — periodic dim/bright bands along Y in
        // the composite pass. Off by default since it adds a strong
        // visual layer that compounds with the vertical stripe pattern.
        scanlines: false,
        // Glass — all off; curvature warps the stripe pattern and
        // gloss/vignette obscure the phosphor character on the
        // small physical sizes we're working with.
        curvature: false,
        gloss: false,
        vignette: false,
        // Slow modulator — off by default; warmup is a one-shot
        // brightness ramp that callers can re-enable if they want the
        // tube-warming-up moment.
        warmup: false,
      }, opts.effects || {});

      // Baseline for stateDiff() — captured before any panel mutation.
      this._baseline = this._snapshotState();

      this._initGpu();

      this._wasStartedByUser = false;
      this._setupReducedMotionListener();
      this._rafHandle = null;
      this._startTime = null;
      this._lastRenderT = null;
    }

    // --- Panel/bench param API ------------------------------------------
    // Shared by the built-in ?debug=1 overlay and external benches
    // (docs/tv.html). Synthetic params (double-underscore) translate
    // UI-friendly scalars into structured opts:
    //   __convergenceSpread → 2-D r/b offsets (delta guns sit in a
    //                         triangle, so misconvergence fringes
    //                         diagonally; see spec
    //                         2026-06-10-crt-effect-axes-and-tv-page-design.md)
    readParam(opt) {
      if (opt === '__convergenceSpread') return Math.abs(this.opts.convergence?.r?.[0] ?? 0);
      return this.opts[opt] ?? 0;
    }

    writeParam(opt, v) {
      if (opt === '__convergenceSpread') {
        // Delta guns sit in a triangle — misconvergence fringes in 2-D.
        this.opts.convergence = { r: [-v, -v], g: [0, 0], b: [v, v] };
      } else {
        this.opts[opt] = v;
      }
      if (this._gl) this._uploadStaticUniforms();
    }

    _snapshotState() {
      const snap = { effects: { ...this.effects }, opts: {} };
      for (const k of PANEL_OPT_KEYS) {
        if (k in this.opts) snap.opts[k] = this.opts[k];
      }
      const c = this.opts.convergence;
      if (c) {
        snap.opts.convergence = {
          r: [c.r?.[0] ?? 0, c.r?.[1] ?? 0],
          g: [c.g?.[0] ?? 0, c.g?.[1] ?? 0],
          b: [c.b?.[0] ?? 0, c.b?.[1] ?? 0],
        };
      }
      return snap;
    }

    // Human-readable diff of effects/opts vs. the constructor-time
    // baseline — the "copy state" payload.
    stateDiff() {
      const fmtNum = (n) => Number.isInteger(n) ? String(n) : String(Math.round(n * 10000) / 10000);
      const curr = this._snapshotState();
      const base = this._baseline;
      const lines = [];
      for (const k of Object.keys(curr.effects)) {
        if (curr.effects[k] !== base.effects[k]) lines.push(`  effects.${k} = ${curr.effects[k]}`);
      }
      for (const k of Object.keys(curr.opts)) {
        const cv = curr.opts[k];
        const bv = base.opts[k];
        if (k === 'convergence') {
          const eq = bv && cv && ['r', 'g', 'b'].every(
            (ch) => cv[ch][0] === bv[ch][0] && cv[ch][1] === bv[ch][1]);
          if (!eq) {
            lines.push(`  opts.convergence = { r: [${cv.r.map(fmtNum).join(', ')}], g: [${cv.g.map(fmtNum).join(', ')}], b: [${cv.b.map(fmtNum).join(', ')}] }`);
          }
        } else if (cv !== bv) {
          lines.push(typeof cv === 'string' ? `  opts.${k} = '${cv}'` : `  opts.${k} = ${fmtNum(cv)}`);
        }
      }
      if (!lines.length) return 'shadow-mask state: (no changes from construction)';
      return ['shadow-mask state diff (from construction):', ...lines].join('\n');
    }

    _initGpu() {
      const gl = this.canvas.getContext('webgl2', {
        alpha: true,
        antialias: false,
        preserveDrawingBuffer: false,
        // Output straight-alpha (R, G, B, A), not premultiplied
        // (R*A, G*A, B*A, A). With the default premultipliedAlpha:true,
        // the browser would dim the feathered-edge bloom by an extra
        // factor of A during display compositing — color and alpha
        // both ~0.3 in the bleed region multiply to ~0.09, invisible.
        premultipliedAlpha: false,
      });
      if (!gl) throw new Error('WebGL2 unavailable');

      // Float textures for persistence (no extension needed in WebGL2).
      // EXT_color_buffer_float lets us render TO float — required because
      // the phosphor/persistence attachments are RGBA32F. Check (and
      // throw) BEFORE mutating this.* so the constructor leaves no
      // half-initialized GPU state behind on failure.
      const cbf = gl.getExtension('EXT_color_buffer_float');
      if (!cbf) throw new Error('EXT_color_buffer_float unavailable');
      // OES_texture_float_linear lets us sample RGBA32F textures with
      // LINEAR filtering in a shader. Without it, `texture(uPhosphor, ...)`
      // in the composite pass silently returns vec4(0) — no GL error,
      // just a black phosphor read — because LINEAR on a float texture
      // is "texture-incomplete" in WebGL2. The phosphor and persistence
      // textures use LINEAR (Task 9 consistency fix), so this extension
      // is load-bearing. Same throw-before-mutate discipline as above.
      const tfl = gl.getExtension('OES_texture_float_linear');
      if (!tfl) throw new Error('OES_texture_float_linear unavailable');

      this._gl = gl;

      const dpr = window.devicePixelRatio || 1;
      const [cw, ch] = this.opts.canvasSize;
      this.canvas.width = cw * dpr;
      this.canvas.height = ch * dpr;

      const [vw, vh] = this.opts.viewSize;

      // Stripe-region geometry: the phosphor texture occupies the
      // central `min(viewSize * stripeUpscale, canvasSize)` canvas
      // pixels. When viewSize*stripeUpscale ≥ canvasSize (i.e. the
      // source resolution already exceeds the canvas backing),
      // stripeFraction = 1 and there's no margin — phosphor fills
      // the canvas. Otherwise the margin is reserved for the bleed
      // halo so the bloom feather has somewhere to spread.
      const su = Math.max(1, Math.floor(this.opts.stripeUpscale || 1));
      const stripeRegionPx = Math.min(vw * su, cw);
      this._stripeFraction = stripeRegionPx / cw;
      this._stripeMargin = (1 - this._stripeFraction) / 2;

      // Full-screen triangle VAO. aPos is at location 0 via the
      // layout qualifier in FULLSCREEN_VS.
      const tri = new Float32Array([-1, -1, 3, -1, -1, 3]);
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      this._vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
      gl.bufferData(gl.ARRAY_BUFFER, tri, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      this._vao = vao;

      // Signal canvas — caller's signal callback paints into this 2D
      // canvas each frame; we upload it as a texture below.
      // No ctx.scale here — GPU pipeline works in clip space.
      this._signalCanvas = document.createElement('canvas');
      this._signalCanvas.width = vw;
      this._signalCanvas.height = vh;
      this._signalCtx = this._signalCanvas.getContext('2d', { willReadFrequently: false });
      this._signalCtx.imageSmoothingEnabled = true;
      this._signalCtx.imageSmoothingQuality = 'high';

      this._texSignal = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this._texSignal);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, vw, vh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      // Persistence ping-pong textures (RGBA32F). Persistence textures
      // are LINEAR so convergence-shifted reads in the phosphor pass
      // produce chromatic-fringe blending consistent with the signal
      // sample. The phosphor output texture is NEAREST so the composite
      // pass's upscale (canvas backing ≫ viewSize) tiles each phosphor
      // source pixel as a sharp block; LINEAR on this texture averaged
      // adjacent stripes into mush.
      const makeFloatTex = (w, h, filter) => {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
      };
      this._texPersistA = makeFloatTex(vw, vh, gl.LINEAR);
      this._texPersistB = makeFloatTex(vw, vh, gl.LINEAR);
      this._texPhosphor = makeFloatTex(vw, vh, gl.NEAREST);

      // Two pre-configured FBOs for the phosphor pass. Both write the
      // phosphor output to _texPhosphor; they differ only in which
      // persistence texture is bound at COLOR_ATTACHMENT1. We swap
      // between them each frame for ping-pong, avoiding per-frame
      // framebufferTexture2D / drawBuffers calls.
      this._fboPhosphorWithB = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboPhosphorWithB);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._texPhosphor, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this._texPersistB, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

      this._fboPhosphorWithA = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboPhosphorWithA);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._texPhosphor, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this._texPersistA, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      // Ping-pong orientation. The flag describes the CURRENT frame
      // (before the end-of-frame flip):
      //   false → render this frame into _texPersistB; next frame's
      //           persistence INPUT (sampled by the shader) is
      //           _texPersistA (the previously-written one).
      //   true  → render into _texPersistA; next frame's input is
      //           _texPersistB.
      // Equivalently: the SAMPLER input is always the texture NOT
      // attached to the currently-bound FBO. Task 8 wires this up.
      this._pingPongFlip = false;

      // Programs land in later tasks. Track them here for cleanup.
      this._programs = [];

      // Phosphor program. aPos is at attribute location 0 via the
      // `layout(location = 0)` qualifier in FULLSCREEN_VS, matching the
      // VAO setup above.
      const phVs = compileShader(gl, gl.VERTEX_SHADER, FULLSCREEN_VS);
      const phFs = compileShader(gl, gl.FRAGMENT_SHADER, PHOSPHOR_FS);
      this._progPhosphor = linkProgram(gl, phVs, phFs);
      gl.detachShader(this._progPhosphor, phVs);
      gl.detachShader(this._progPhosphor, phFs);
      gl.deleteShader(phVs);
      gl.deleteShader(phFs);
      this._programs.push(this._progPhosphor);

      // Uniform locations (cache once).
      this._uPhosphor = {
        signal:               gl.getUniformLocation(this._progPhosphor, 'uSignal'),
        persistencePrev:      gl.getUniformLocation(this._progPhosphor, 'uPersistencePrev'),
        viewSize:             gl.getUniformLocation(this._progPhosphor, 'uViewSize'),
        cellSize:             gl.getUniformLocation(this._progPhosphor, 'uCellSize'),
        persistence:          gl.getUniformLocation(this._progPhosphor, 'uPersistence'),
        convergenceR:         gl.getUniformLocation(this._progPhosphor, 'uConvergenceR'),
        convergenceG:         gl.getUniformLocation(this._progPhosphor, 'uConvergenceG'),
        convergenceB:         gl.getUniformLocation(this._progPhosphor, 'uConvergenceB'),
        dotRadius:            gl.getUniformLocation(this._progPhosphor, 'uDotRadius'),
        phosphorCoupling:     gl.getUniformLocation(this._progPhosphor, 'uPhosphorCoupling'),
        stripeEnabled:        gl.getUniformLocation(this._progPhosphor, 'uStripeEnabled'),
        persistenceEnabled:   gl.getUniformLocation(this._progPhosphor, 'uPersistenceEnabled'),
        convergenceEnabled:   gl.getUniformLocation(this._progPhosphor, 'uConvergenceEnabled'),
        couplingEnabled:      gl.getUniformLocation(this._progPhosphor, 'uCouplingEnabled'),
        beamSpreadPx:         gl.getUniformLocation(this._progPhosphor, 'uBeamSpreadPx'),
        beamSpreadVerticalPx: gl.getUniformLocation(this._progPhosphor, 'uBeamSpreadVerticalPx'),
        beamSpreadEnabled:    gl.getUniformLocation(this._progPhosphor, 'uBeamSpreadEnabled'),
      };

      const cmpVs = compileShader(gl, gl.VERTEX_SHADER, FULLSCREEN_VS);
      const cmpFs = compileShader(gl, gl.FRAGMENT_SHADER, COMPOSITE_FS);
      this._progComposite = linkProgram(gl, cmpVs, cmpFs);
      gl.detachShader(this._progComposite, cmpVs);
      gl.detachShader(this._progComposite, cmpFs);
      gl.deleteShader(cmpVs);
      gl.deleteShader(cmpFs);
      this._programs.push(this._progComposite);

      this._uComposite = {
        phosphor:          gl.getUniformLocation(this._progComposite, 'uPhosphor'),
        gloss:             gl.getUniformLocation(this._progComposite, 'uGloss'),
        vignette:          gl.getUniformLocation(this._progComposite, 'uVignette'),
        canvasSize:        gl.getUniformLocation(this._progComposite, 'uCanvasSize'),
        curvature:         gl.getUniformLocation(this._progComposite, 'uCurvature'),
        curvatureEnabled:  gl.getUniformLocation(this._progComposite, 'uCurvatureEnabled'),
        glossEnabled:      gl.getUniformLocation(this._progComposite, 'uGlossEnabled'),
        vignetteEnabled:   gl.getUniformLocation(this._progComposite, 'uVignetteEnabled'),
        stripeFraction:    gl.getUniformLocation(this._progComposite, 'uStripeFraction'),
        stripeMargin:      gl.getUniformLocation(this._progComposite, 'uStripeMargin'),
        opaqueBackground:  gl.getUniformLocation(this._progComposite, 'uOpaqueBackground'),
      };
      this._uComposite.bloom            = gl.getUniformLocation(this._progComposite, 'uBloom');
      this._uComposite.bloomStrength    = gl.getUniformLocation(this._progComposite, 'uBloomStrength');
      this._uComposite.bloomEnabled     = gl.getUniformLocation(this._progComposite, 'uBloomEnabled');
      this._uComposite.brightness       = gl.getUniformLocation(this._progComposite, 'uBrightness');
      this._uComposite.curvatureMode    = gl.getUniformLocation(this._progComposite, 'uCurvatureMode');
      this._uComposite.scanlineEnabled  = gl.getUniformLocation(this._progComposite, 'uScanlineEnabled');
      this._uComposite.scanlineCycles   = gl.getUniformLocation(this._progComposite, 'uScanlineCycles');
      this._uComposite.scanlineDepth    = gl.getUniformLocation(this._progComposite, 'uScanlineDepth');

      // Bloom programs.
      const bthVs = compileShader(gl, gl.VERTEX_SHADER, FULLSCREEN_VS);
      const bthFs = compileShader(gl, gl.FRAGMENT_SHADER, BLOOM_THRESHOLD_FS);
      this._progBloomThresh = linkProgram(gl, bthVs, bthFs);
      gl.detachShader(this._progBloomThresh, bthVs);
      gl.detachShader(this._progBloomThresh, bthFs);
      gl.deleteShader(bthVs);
      gl.deleteShader(bthFs);
      this._programs.push(this._progBloomThresh);
      this._uBloomThresh = {
        phosphor:  gl.getUniformLocation(this._progBloomThresh, 'uPhosphor'),
        threshold: gl.getUniformLocation(this._progBloomThresh, 'uThreshold'),
      };

      const bhVs = compileShader(gl, gl.VERTEX_SHADER, FULLSCREEN_VS);
      const bhFs = compileShader(gl, gl.FRAGMENT_SHADER, BLOOM_BLUR_H_FS);
      this._progBloomH = linkProgram(gl, bhVs, bhFs);
      gl.detachShader(this._progBloomH, bhVs);
      gl.detachShader(this._progBloomH, bhFs);
      gl.deleteShader(bhVs);
      gl.deleteShader(bhFs);
      this._programs.push(this._progBloomH);
      this._uBloomH = {
        tex:        gl.getUniformLocation(this._progBloomH, 'uTex'),
        texSize:    gl.getUniformLocation(this._progBloomH, 'uTexSize'),
        blurRadius: gl.getUniformLocation(this._progBloomH, 'uBlurRadius'),
      };

      const bvVs = compileShader(gl, gl.VERTEX_SHADER, FULLSCREEN_VS);
      const bvFs = compileShader(gl, gl.FRAGMENT_SHADER, BLOOM_BLUR_V_FS);
      this._progBloomV = linkProgram(gl, bvVs, bvFs);
      gl.detachShader(this._progBloomV, bvVs);
      gl.detachShader(this._progBloomV, bvFs);
      gl.deleteShader(bvVs);
      gl.deleteShader(bvFs);
      this._programs.push(this._progBloomV);
      this._uBloomV = {
        tex:        gl.getUniformLocation(this._progBloomV, 'uTex'),
        texSize:    gl.getUniformLocation(this._progBloomV, 'uTexSize'),
        blurRadius: gl.getUniformLocation(this._progBloomV, 'uBlurRadius'),
      };

      // Half-res bloom textures + FBOs.
      const bw = Math.max(1, vw >> 1);
      const bh = Math.max(1, vh >> 1);
      this._bloomW = bw;
      this._bloomH = bh;
      const makeRGBA8Tex = (w, h) => {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
      };
      this._texBloomA = makeRGBA8Tex(bw, bh);
      this._texBloomB = makeRGBA8Tex(bw, bh);
      this._fboBloomA = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboBloomA);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._texBloomA, 0);
      this._fboBloomB = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboBloomB);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._texBloomB, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      this._buildStaticTextures();
      this._uploadStaticUniforms();

      // Frame counter for diagnostics.
      this._frameCount = 0;

      this._initDebugOverlay();
    }

    _initDebugOverlay() {
      // Only build the panel when ?debug=1 is in the URL AND this
      // instance was constructed with debugOverlay:true (default).
      // Secondary instances on the same page should opt out so the
      // primary instance's panel isn't overlapped.
      if (!this.opts.debugOverlay) return;
      const params = new URLSearchParams(location.search);
      if (params.get('debug') !== '1') return;

      const panel = document.createElement('div');
      panel.style.cssText = `
        position: fixed; top: 12px; right: 12px; z-index: 9999;
        background: rgba(0,0,0,0.85); color: #fff;
        font: 11px/1.4 monospace; padding: 12px 14px;
        border: 1px solid #555; border-radius: 4px;
        max-width: 320px; max-height: 86vh; overflow: auto;
      `;
      // Header row: title + collapse toggle. Everything below the header
      // lives in `body` so collapsing shrinks the panel to a small chip.
      // Collapsed state persists in sessionStorage — the panel is torn
      // down and rebuilt on every renderer destroy/reconstruct (resize,
      // renderer swap), and the collapse should survive that.
      const header = document.createElement('div');
      header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;';
      const titleEl = document.createElement('div');
      titleEl.style.cssText = 'font-weight:700;';
      titleEl.textContent = 'shadow-mask debug';
      header.appendChild(titleEl);
      const collapseBtn = document.createElement('button');
      collapseBtn.style.cssText = 'background:#222;color:#5EE2FF;border:1px solid #555;font:11px/1 monospace;cursor:pointer;border-radius:2px;padding:2px 7px;';
      header.appendChild(collapseBtn);
      panel.appendChild(header);

      const body = document.createElement('div');
      body.style.marginTop = '8px';
      panel.appendChild(body);

      const COLLAPSE_KEY = 'crt-debug-panel-collapsed';
      let collapsed = false;
      try { collapsed = sessionStorage.getItem(COLLAPSE_KEY) === '1'; } catch (_) { /* sandboxed */ }
      const applyCollapsed = () => {
        body.style.display = collapsed ? 'none' : '';
        collapseBtn.textContent = collapsed ? '+' : '−';
        collapseBtn.title = collapsed ? 'expand' : 'collapse';
      };
      collapseBtn.addEventListener('click', () => {
        collapsed = !collapsed;
        try { sessionStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch (_) { /* sandboxed */ }
        applyCollapsed();
      });
      applyCollapsed();

      // FPS readout.
      const fpsEl = document.createElement('div');
      fpsEl.style.cssText = 'margin-bottom:10px;color:#5EE2FF;';
      fpsEl.textContent = 'fps: --';
      body.appendChild(fpsEl);
      this._debugFps = fpsEl;
      this._debugFpsLast = performance.now();
      this._debugFpsFrames = 0;

      // "Copy state" button. Writes stateDiff() — effects/opts vs. the
      // constructor-time baseline — to clipboard; falls back to console
      // if clipboard is unavailable. Localhost is a secure context so
      // clipboard works on the dev server.
      const copyBtn = document.createElement('button');
      copyBtn.textContent = 'copy state diff';
      copyBtn.style.cssText = 'display:block;width:100%;padding:5px 6px;margin-bottom:10px;background:#222;color:#5EE2FF;border:1px solid #555;font:11px monospace;cursor:pointer;border-radius:2px;';
      copyBtn.addEventListener('click', async () => {
        const text = this.stateDiff();
        const restore = () => { copyBtn.textContent = 'copy state diff'; };
        try {
          await navigator.clipboard.writeText(text);
          copyBtn.textContent = 'copied to clipboard';
        } catch (err) {
          console.log('[shadow-mask]\n' + text);
          copyBtn.textContent = 'clipboard failed — see console';
        }
        setTimeout(restore, 1400);
      });
      body.appendChild(copyBtn);

      // Captioned effect groups with inline sliders for tunable scalars,
      // built from the class-level effectSchema (the single source of
      // truth shared with external benches). Order mirrors the GPU pass
      // order (phosphor → composite → glass); "modulation" holds the slow
      // brightness modulators. Sliders go through readParam/writeParam so
      // synthetic (double-underscore) params resolve to structured opts
      // and _uploadStaticUniforms runs on every write.
      const fmt = (v, step) => v.toFixed(Math.max(0, -Math.floor(Math.log10(step))));

      for (const group of this.constructor.effectSchema) {
        const head = document.createElement('div');
        head.style.cssText = 'margin-top:10px;margin-bottom:4px;color:#A99CFF;font-weight:700;font-size:10px;letter-spacing:0.06em;text-transform:uppercase;';
        head.textContent = group.title;
        body.appendChild(head);

        for (const item of group.items) {
          const block = document.createElement('div');
          block.style.cssText = 'margin-bottom:8px;';

          const row = document.createElement('label');
          row.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;padding:1px 0;';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = !!this.effects[item.key];
          cb.addEventListener('change', () => { this.effects[item.key] = cb.checked; });
          row.appendChild(cb);
          const lbl = document.createElement('span');
          lbl.textContent = item.label;
          row.appendChild(lbl);
          block.appendChild(row);

          const desc = document.createElement('div');
          desc.style.cssText = 'padding-left:20px;color:#9aa;font-size:10px;line-height:1.35;margin-top:1px;';
          desc.textContent = item.desc;
          block.appendChild(desc);

          if (item.params) {
            for (const p of item.params) {
              const prow = document.createElement('div');
              prow.style.cssText = 'display:flex;align-items:center;gap:6px;padding-left:20px;margin-top:3px;';
              const sub = document.createElement('span');
              sub.style.cssText = 'color:#888;min-width:62px;font-size:10px;';
              sub.textContent = p.sub;
              prow.appendChild(sub);

              if (p.kind === 'select') {
                const select = document.createElement('select');
                select.style.cssText = 'flex:1;min-width:0;background:#222;color:#5EE2FF;border:1px solid #555;font:10px monospace;padding:1px 3px;';
                for (const optVal of p.options) {
                  const opt = document.createElement('option');
                  opt.value = optVal;
                  opt.textContent = optVal;
                  select.appendChild(opt);
                }
                select.value = String(this.readParam(p.opt) ?? p.options[0]);
                select.addEventListener('change', () => { this.writeParam(p.opt, select.value); });
                prow.appendChild(select);
              } else {
                const slider = document.createElement('input');
                slider.type = 'range';
                slider.min = String(p.min);
                slider.max = String(p.max);
                slider.step = String(p.step);
                slider.style.cssText = 'flex:1;min-width:0;accent-color:#5EE2FF;';
                const valEl = document.createElement('span');
                valEl.style.cssText = 'color:#5EE2FF;min-width:38px;text-align:right;font-size:10px;';
                const initV = this.readParam(p.opt);
                slider.value = String(initV);
                valEl.textContent = fmt(initV, p.step);
                slider.addEventListener('input', () => {
                  const v = parseFloat(slider.value);
                  valEl.textContent = fmt(v, p.step);
                  this.writeParam(p.opt, v);
                });
                prow.appendChild(slider);
                prow.appendChild(valEl);
              }

              block.appendChild(prow);
            }
          }

          body.appendChild(block);
        }
      }

      document.body.appendChild(panel);
      this._debugPanel = panel;
    }

    _destroyGpu() {
      const gl = this._gl;
      if (!gl) return;
      for (const p of (this._programs || [])) gl.deleteProgram(p);
      if (this._vao) gl.deleteVertexArray(this._vao);
      if (this._vbo) gl.deleteBuffer(this._vbo);
      if (this._texSignal)   gl.deleteTexture(this._texSignal);
      if (this._texPersistA) gl.deleteTexture(this._texPersistA);
      if (this._texPersistB) gl.deleteTexture(this._texPersistB);
      if (this._texPhosphor) gl.deleteTexture(this._texPhosphor);
      if (this._fboPhosphorWithA) gl.deleteFramebuffer(this._fboPhosphorWithA);
      if (this._fboPhosphorWithB) gl.deleteFramebuffer(this._fboPhosphorWithB);
      if (this._texGloss)    gl.deleteTexture(this._texGloss);
      if (this._texVignette) gl.deleteTexture(this._texVignette);
      if (this._texBloomA) gl.deleteTexture(this._texBloomA);
      if (this._texBloomB) gl.deleteTexture(this._texBloomB);
      if (this._fboBloomA) gl.deleteFramebuffer(this._fboBloomA);
      if (this._fboBloomB) gl.deleteFramebuffer(this._fboBloomB);
      this._gl = null;
      if (this._debugPanel && this._debugPanel.parentNode) {
        this._debugPanel.parentNode.removeChild(this._debugPanel);
      }
      this._debugPanel = null;
      this._debugFps = null;
    }

    _buildStaticTextures() {
      const gl = this._gl;
      const [vw, vh] = this.opts.viewSize;

      // GLOSS: upper-left elliptical highlight on a 256×256 LUT. Soft
      // bright ellipse positioned at (80, 64) — virtual light source
      // above-left of the screen.
      const glossCanvas = document.createElement('canvas');
      glossCanvas.width = 256;
      glossCanvas.height = 256;
      const gctx = glossCanvas.getContext('2d');
      const grad = gctx.createRadialGradient(80, 64, 0, 80, 64, 200);
      grad.addColorStop(0,   'rgba(255,255,255,0.18)');
      grad.addColorStop(0.5, 'rgba(255,255,255,0.04)');
      grad.addColorStop(1,   'rgba(255,255,255,0)');
      gctx.fillStyle = grad;
      gctx.fillRect(0, 0, 256, 256);
      this._texGloss = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this._texGloss);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, glossCanvas);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      // VIGNETTE: radial darkening from center toward corners, 128×128.
      // White center → darker edge alpha. Composite multiplies by this
      // texture's red channel so the corners dim ~18%.
      const vigCanvas = document.createElement('canvas');
      vigCanvas.width = 128;
      vigCanvas.height = 128;
      const vctx = vigCanvas.getContext('2d');
      vctx.fillStyle = 'white';
      vctx.fillRect(0, 0, 128, 128);
      const vgrad = vctx.createRadialGradient(64, 64, 40, 64, 64, 92);
      vgrad.addColorStop(0,   'rgba(0,0,0,0)');
      vgrad.addColorStop(1,   'rgba(0,0,0,0.18)');
      vctx.fillStyle = vgrad;
      vctx.fillRect(0, 0, 128, 128);
      this._texVignette = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this._texVignette);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, vigCanvas);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    // Upload uniforms that don't change for the lifetime of this
    // renderer — sampler unit bindings, viewSize/cellSize, the
    // base option values (dotRadius, beam spread,
    // bloom threshold, composite geometry, opaque background flag),
    // and the convergence base. Called once at the end of _initGpu,
    // saving ~30 CPU→GPU command-buffer writes per frame.
    //
    // Uniforms still uploaded per frame in _renderGpu: the *Enabled
    // toggles (?debug=1 panel mutates them at runtime), the persistence
    // decay (derived from the half-life and the inter-frame dt), and
    // brightness (the warmup ramp modulates it).
    _uploadStaticUniforms() {
      const gl = this._gl;
      const [vw, vh] = this.opts.viewSize;

      // Phosphor program.
      gl.useProgram(this._progPhosphor);
      gl.uniform1i(this._uPhosphor.signal,          0);
      gl.uniform1i(this._uPhosphor.persistencePrev, 1);
      gl.uniform2f(this._uPhosphor.viewSize, vw, vh);
      const csX = Array.isArray(this.opts.cellSize) ? this.opts.cellSize[0] : this.opts.cellSize;
      const csY = Array.isArray(this.opts.cellSize) ? this.opts.cellSize[1] : this.opts.cellSize;
      gl.uniform2f(this._uPhosphor.cellSize, csX, csY);
      gl.uniform1f(this._uPhosphor.beamSpreadPx,         this.opts.beamSpreadPx);
      gl.uniform1f(this._uPhosphor.beamSpreadVerticalPx, this.opts.beamSpreadVerticalPx);
      gl.uniform1f(this._uPhosphor.dotRadius,            this.opts.dotRadius ?? 0.7);
      gl.uniform1f(this._uPhosphor.phosphorCoupling,     this.opts.phosphorCoupling ?? 0);

      // Convergence base offsets (static; per-channel UV shifts).
      const c = this.opts.convergence;
      gl.uniform2f(this._uPhosphor.convergenceR, c.r[0], c.r[1]);
      gl.uniform2f(this._uPhosphor.convergenceG, c.g[0], c.g[1]);
      gl.uniform2f(this._uPhosphor.convergenceB, c.b[0], c.b[1]);

      // Composite program.
      gl.useProgram(this._progComposite);
      gl.uniform1i(this._uComposite.phosphor, 0);
      gl.uniform1i(this._uComposite.gloss,    1);
      gl.uniform1i(this._uComposite.vignette, 2);
      gl.uniform1i(this._uComposite.bloom,    3);
      gl.uniform2f(this._uComposite.canvasSize, this.canvas.width, this.canvas.height);
      gl.uniform1f(this._uComposite.curvature,        this.opts.curvature);
      gl.uniform1f(this._uComposite.curvatureMode,    this.opts.curvatureMode === 'cylindrical' ? 1 : 0);
      gl.uniform1f(this._uComposite.bloomStrength,    this.opts.bloomStrength);
      gl.uniform1f(this._uComposite.stripeFraction,   this._stripeFraction);
      gl.uniform1f(this._uComposite.stripeMargin,     this._stripeMargin);
      gl.uniform1f(this._uComposite.opaqueBackground, this.opts.opaqueBackground ? 1 : 0);
      // Scanline geometry — depth is the trough darkening fraction;
      // cycles is the count of bright/dim cycles per stripe-UV unit
      // (vh / scanlinePeriod). Both re-uploaded when the panel mutates
      // opts; scanlineEnabled is uploaded per-frame in _renderGpu.
      gl.uniform1f(this._uComposite.scanlineDepth,    this.opts.scanlineDepth);
      gl.uniform1f(this._uComposite.scanlineCycles,   vh / Math.max(0.5, this.opts.scanlinePeriod));

      // Bloom programs — sampler binding, threshold, and texSize all
      // static. Only invoked when effects.selectiveBloom is on, but
      // there's no cost to uploading at init regardless.
      gl.useProgram(this._progBloomThresh);
      gl.uniform1i(this._uBloomThresh.phosphor,  0);
      gl.uniform1f(this._uBloomThresh.threshold, this.opts.bloomThreshold);

      // Bloom blur radius: the base kernel sigma is ~2 texels in the
      // half-res bloom texture, which gives a visibly nice halo at the
      // historical default bleedRadius of 30 source pixels. We pick 30
      // as the reference so uBlurRadius = bleedRadius / 30 — meaning
      // bleedRadius=30 → 1.0 (no scaling), bleedRadius=60 → 2.0 (twice
      // as wide), bleedRadius=15 → 0.5 (half as wide).
      const blurRadius = (this.opts.bleedRadius ?? 30) / 30;
      gl.useProgram(this._progBloomH);
      gl.uniform1i(this._uBloomH.tex, 0);
      gl.uniform2f(this._uBloomH.texSize, this._bloomW, this._bloomH);
      gl.uniform1f(this._uBloomH.blurRadius, blurRadius);

      gl.useProgram(this._progBloomV);
      gl.uniform1i(this._uBloomV.tex, 0);
      gl.uniform2f(this._uBloomV.texSize, this._bloomW, this._bloomH);
      gl.uniform1f(this._uBloomV.blurRadius, blurRadius);
    }

    _renderGpu(timeMs) {
      const gl = this._gl;
      if (!gl) return;  // raced with destroy()

      // Paint signal first (caller's callback fills the 2D canvas).
      const [vw, vh] = this.opts.viewSize;
      this._signalCtx.clearRect(0, 0, vw, vh);
      this.opts.signal(this._signalCtx, timeMs);

      // Warmup: one-shot brightness ramp, 0 → 1 over the first ~1.2 s
      // after start. The only time-driven modulator in the model.
      const warmupDur = 1200; // ms
      const tWarm = timeMs - (this._warmupStartMs || 0);
      let warmupFactor = 1.0;
      if (this.effects.warmup && tWarm < warmupDur) {
        const k = Math.max(0, Math.min(1, tWarm / warmupDur));
        warmupFactor = k * k * (3.0 - 2.0 * k); // smoothstep
      }

      this._brightness = warmupFactor;

      // Upload the 2D canvas to the signal texture. FLIP_Y accounts for
      // the difference between canvas's top-left origin and WebGL's
      // bottom-left origin, so sampling uSignal at vUv = (x, y) returns
      // the canvas pixel at (x, y) with origin top-left.
      gl.bindTexture(gl.TEXTURE_2D, this._texSignal);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, this._signalCanvas);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

      // Bind the pre-configured FBO matching current ping-pong orientation.
      const fbo = this._pingPongFlip ? this._fboPhosphorWithA : this._fboPhosphorWithB;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, vw, vh);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.useProgram(this._progPhosphor);
      gl.bindVertexArray(this._vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._texSignal);

      // Per-frame *Enabled toggles. The ?debug=1 panel mutates
      // this.effects at runtime, so these must stay dynamic. Static
      // option values (beam spread, dotRadius,
      // viewSize/cellSize, sampler bindings, base convergence) are
      // uploaded once in _uploadStaticUniforms.
      gl.uniform1f(this._uPhosphor.stripeEnabled,      this.effects.stripeProfile    ? 1 : 0);
      gl.uniform1f(this._uPhosphor.couplingEnabled,    this.effects.phosphorCoupling ? 1 : 0);
      gl.uniform1f(this._uPhosphor.persistenceEnabled, this.effects.persistence      ? 1 : 0);
      gl.uniform1f(this._uPhosphor.convergenceEnabled, this.effects.convergence      ? 1 : 0);
      gl.uniform1f(this._uPhosphor.beamSpreadEnabled,  this.effects.beamSpread       ? 1 : 0);

      // Frame-rate-independent persistence: convert the half-life to a
      // decay factor for the actual time since the last rendered frame.
      // A long gap (idle wake, tab switch) drives decay toward 0 — the
      // trail is honestly gone by the time we render again. The first
      // frame of a run has no previous frame to retain (the persistence
      // textures were just zeroed), so it shows the live signal at full
      // strength: decay 0.
      const hl = this.opts.persistenceHalfLifeMs;
      const firstFrame = this._lastRenderT == null;
      const dtMs = firstFrame ? 0 : Math.max(1, timeMs - this._lastRenderT);
      this._lastRenderT = timeMs;
      const decay = (firstFrame || hl <= 0) ? 0 : Math.pow(0.5, dtMs / hl);
      gl.uniform1f(this._uPhosphor.persistence, decay);

      // Bind persistence-prev (the texture NOT in the currently-bound FBO).
      const persistPrev = this._pingPongFlip ? this._texPersistB : this._texPersistA;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, persistPrev);

      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // Flip ping-pong orientation for next frame.
      this._pingPongFlip = !this._pingPongFlip;

      // Bloom passes (skip entirely when disabled — real CPU savings).
      // Sampler bindings, threshold, and texSize are uploaded once in
      // _uploadStaticUniforms; only the texture bindings change per pass.
      if (this.effects.selectiveBloom) {
        // 3a. Threshold: phosphor → bloomA.
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboBloomA);
        gl.viewport(0, 0, this._bloomW, this._bloomH);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(this._progBloomThresh);
        gl.bindVertexArray(this._vao);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this._texPhosphor);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        // 3b. Horizontal Gaussian: bloomA → bloomB.
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboBloomB);
        gl.useProgram(this._progBloomH);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this._texBloomA);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        // 3c. Vertical Gaussian: bloomB → bloomA.
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboBloomA);
        gl.useProgram(this._progBloomV);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this._texBloomB);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        // Final bloom output sits in _texBloomA.
      }

      // Composite pass — bind default framebuffer, sample phosphor texture.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.useProgram(this._progComposite);
      // Per-frame uniforms only. Statics (canvasSize, curvature value,
      // bloomStrength, stripeFraction/Margin, opaqueBackground, sampler
      // bindings) are uploaded once in _uploadStaticUniforms.
      gl.uniform1f(this._uComposite.curvatureEnabled, this.effects.curvature      ? 1 : 0);
      gl.uniform1f(this._uComposite.glossEnabled,     this.effects.gloss          ? 1 : 0);
      gl.uniform1f(this._uComposite.vignetteEnabled,  this.effects.vignette       ? 1 : 0);
      gl.uniform1f(this._uComposite.bloomEnabled,     this.effects.selectiveBloom ? 1 : 0);
      gl.uniform1f(this._uComposite.scanlineEnabled,  this.effects.scanlines      ? 1 : 0);
      gl.uniform1f(this._uComposite.brightness,       this._brightness ?? 1.0);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this._texPhosphor);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this._texGloss);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this._texVignette);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this._texBloomA);

      gl.bindVertexArray(this._vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      this._frameCount++;

      if (this._debugFps) {
        this._debugFpsFrames++;
        const now = performance.now();
        if (now - this._debugFpsLast >= 500) {
          const fps = Math.round(this._debugFpsFrames * 1000 / (now - this._debugFpsLast));
          this._debugFps.textContent = `fps: ${fps}`;
          this._debugFpsFrames = 0;
          this._debugFpsLast = now;
        }
      }
    }

    start() {
      this._wasStartedByUser = true;
      if (this._rafHandle != null) return;
      // Zero the persistence trail so a stop/restart (e.g. theme toggle)
      // doesn't leave the last paused frame ghosted into the next session.
      // Guarded on _gl because destroy() nulls it; start() after destroy
      // is a no-op for the clear (and the tick below will early-out too).
      if (this._gl) {
        // Clear both persistence textures by binding each FBO and
        // clearing all attachments. MUST use clearBufferfv for
        // RGBA32F attachments — `gl.clear()` on float color buffers
        // is undefined per the WebGL2 spec and produces NaN on some
        // drivers, which then propagates forever through the
        // persistence lerp (NaN * anything = NaN) and poisons every
        // subsequent frame to black.
        const gl = this._gl;
        const zeros = new Float32Array([0, 0, 0, 0]);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboPhosphorWithA);
        gl.clearBufferfv(gl.COLOR, 0, zeros);  // phosphor attachment
        gl.clearBufferfv(gl.COLOR, 1, zeros);  // persistence A
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboPhosphorWithB);
        gl.clearBufferfv(gl.COLOR, 0, zeros);  // phosphor attachment
        gl.clearBufferfv(gl.COLOR, 1, zeros);  // persistence B
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
      this._warmupStartMs = 0;  // warmup begins at timeMs = 0 since startTime
      this._startTime = performance.now();
      this._lastRenderT = null;
      if (this._reducedMotionMq && this._reducedMotionMq.matches) {
        // Single static frame — render it at t past the warmup ramp
        // (1200 ms) so a warmup-enabled consumer shows the steady-state
        // tube, not the warmupFactor=0 black of the t=0 frame.
        this._renderGpu(1200);
        return;
      }
      const tick = (now) => {
        const t = now - this._startTime;
        this._renderGpu(t);
        // stop() may have nulled _rafHandle during the frame work
        // (e.g. theme MutationObserver firing mid-tick). Don't re-queue
        // in that case — otherwise the loop keeps running past stop().
        if (this._rafHandle !== null) {
          this._rafHandle = requestAnimationFrame(tick);
        }
      };
      this._rafHandle = requestAnimationFrame(tick);
    }

    stop() {
      if (this._rafHandle != null) {
        cancelAnimationFrame(this._rafHandle);
        this._rafHandle = null;
      }
    }

    destroy() {
      this.stop();
      if (this._reducedMotionMq && this._reducedMotionHandler) {
        if (this._reducedMotionMq.removeEventListener) {
          this._reducedMotionMq.removeEventListener('change', this._reducedMotionHandler);
        } else if (this._reducedMotionMq.removeListener) {
          this._reducedMotionMq.removeListener(this._reducedMotionHandler);
        }
      }
      this._destroyGpu();
    }

    _setupReducedMotionListener() {
      if (!this.opts.respectReducedMotion) return;
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      this._reducedMotionMq = mq;
      this._reducedMotionHandler = () => {
        if (mq.matches) this.stop();
        else if (this._wasStartedByUser) this.start();
      };
      if (mq.addEventListener) mq.addEventListener('change', this._reducedMotionHandler);
      else if (mq.addListener) mq.addListener(this._reducedMotionHandler);
    }

  }

  // Effect schema — single source of truth for the built-in ?debug=1
  // overlay AND external benches (docs/tv.html). Scope axes per the
  // 2026-06-10 spec. Tube-determined options are pinned via defaults,
  // not offered here (curvatureMode: spherical; beam spread isotropic —
  // the dot lattice quantizes both axes, so no V slider).
  ShadowMask.effectSchema = [
    { title: 'phosphor',
      items: [
        { key: 'stripeProfile',    label: 'phosphor mask', scope: 'universal',
          desc: 'Triad-per-cell dot tiling. Off = raw signal, no mask.',
          params: [{ opt: 'dotRadius', min: 0.2, max: 1.5, step: 0.05, sub: 'dot radius (src-px)', scope: 'shadow-mask' }] },
        { key: 'phosphorCoupling', label: 'phosphor coupling', scope: 'universal',
          desc: 'Each dot also emits other channels at this fraction. Cross-talk cheat that softens per-dot chromatic mismatch.',
          params: [{ opt: 'phosphorCoupling', min: 0, max: 1, step: 0.05, sub: 'strength' }] },
        { key: 'convergence',      label: 'convergence', scope: 'universal',
          desc: 'Per-channel xy-offset. Delta guns fringe in 2-D — R/B shift diagonally.',
          params: [{ opt: '__convergenceSpread', min: 0, max: 1, step: 0.05, sub: 'spread (px)' }] },
        { key: 'persistence',      label: 'persistence', scope: 'universal',
          desc: 'Phosphor afterglow. Half-life of the previous frame\'s contribution, in ms — frame-rate independent.',
          params: [{ opt: 'persistenceHalfLifeMs', min: 0, max: 500, step: 5, sub: 'half-life (ms)' }] },
        { key: 'beamSpread',       label: 'beam spread', scope: 'universal',
          desc: 'Gaussian PSF blur on signal — isotropic; the dot lattice quantizes both axes the same way.',
          params: [{ opt: 'beamSpreadPx', min: 0, max: 3, step: 0.1, sub: 'radius (px)' }] },
      ] },
    { title: 'composite',
      items: [
        { key: 'selectiveBloom', label: 'selective bloom', scope: 'universal',
          desc: 'Bright-pixel halo. Threshold the phosphor, blur, add back as bloom.',
          params: [
            { opt: 'bloomThreshold', min: 0, max: 1,   step: 0.05, sub: 'threshold' },
            { opt: 'bloomStrength',  min: 0, max: 3,   step: 0.1,  sub: 'strength' },
            { opt: 'bleedRadius',    min: 0, max: 100, step: 1,    sub: 'radius (src px)' },
          ] },
        { key: 'scanlines',      label: 'horizontal scanlines', scope: 'universal',
          desc: 'Periodic dim/bright bands along Y — the beam paints rows with gaps between.',
          params: [
            { opt: 'scanlineDepth',  min: 0, max: 1,  step: 0.02, sub: 'depth' },
            { opt: 'scanlinePeriod', min: 1, max: 10, step: 0.5,  sub: 'period (px)' },
          ] },
      ] },
    { title: 'glass',
      items: [
        { key: 'curvature', label: 'curvature', scope: 'universal',
          desc: 'Spherical face curvature — the classic shadow-mask barrel dome, bowing on both axes.',
          params: [{ opt: 'curvature', min: 0, max: 0.3, step: 0.01, sub: 'amount' }] },
        { key: 'gloss',     label: 'gloss', scope: 'universal',
          desc: 'Upper-left elliptical highlight. Virtual light source. Texture-baked.' },
        { key: 'vignette',  label: 'vignette', scope: 'universal',
          desc: 'Darken corners. Bezel falloff. Texture-baked.' },
      ] },
    { title: 'modulation',
      items: [
        { key: 'warmup',    label: 'warmup', scope: 'universal',
          desc: 'One-shot brightness ramp on start. CRT tube warming up.' },
      ] },
  ];

  window.ShadowMask = ShadowMask;
})();
