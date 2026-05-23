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

  // Phosphor fragment shader — Task 9: hotspot, cell shimmer, row shimmer,
  // beam spread. Full phosphor pass.
  // MRT: slot 0 = phosphor output, slot 1 = persistence next-frame.
  const PHOSPHOR_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSignal;
uniform sampler2D uPersistencePrev;
uniform vec2 uViewSize;
uniform vec2 uCellSize;
uniform float uPhosphorCoupling;
uniform float uPersistence;
uniform vec2 uConvergenceR;
uniform vec2 uConvergenceG;
uniform vec2 uConvergenceB;
uniform float uHotspot;
uniform float uCellShimmerAmp;
uniform float uRowShimmerAmp;
uniform uint uShimmerSeed;
uniform float uBeamSpreadPx;
uniform float uBeamSpreadVerticalPx;
uniform float uStripeEnabled;
uniform float uCouplingEnabled;
uniform float uPersistenceEnabled;
uniform float uConvergenceEnabled;
uniform float uHotspotEnabled;
uniform float uCellShimmerEnabled;
uniform float uRowShimmerEnabled;
uniform float uBeamSpreadEnabled;

layout(location = 0) out vec4 oPhosphor;
layout(location = 1) out vec4 oPersistenceNext;

// Deterministic LCG hash → [0,1].
float lcg(uint seed) {
  uint x = 1664525u * seed + 1013904223u;
  return float(x) * (1.0 / 4294967296.0);
}

// Beam spread: anisotropic 2D Gaussian via a 9-tap "plus" kernel
// (5 taps along Y, 4 additional taps along X with the center shared).
// Horizontal and vertical sigmas can differ — a real Trinitron's
// horizontal "resolution" is quantized by the aperture grille pitch
// (so horizontal blur should stay narrow to keep stripes crisp),
// while the vertical axis is bounded only by the beam's gaussian
// PSF and should typically spread further. CPU path's
// cctx.filter = blur(spreadPx) is still isotropic; the anisotropy
// is a GPU-path-only refinement of the otherwise-shared model.
vec4 sampleBeamSpread(sampler2D tex, vec2 uv, float spreadPxH, float spreadPxV) {
  // Sub-pixel-blur no-ops on both axes → skip.
  if (spreadPxH < 0.7 && spreadPxV < 0.7) return texture(tex, uv);
  float dx = spreadPxH / uViewSize.x;
  float dy = spreadPxV / uViewSize.y;
  // 1D Gaussian weights tuned for sigma ≈ tap spacing (normalized to
  // sum 1): center 0.252, ±1σ 0.226 each, ±2σ 0.148 each → sum ≈ 1.0.
  // Applied separably along each axis with the center shared gives a
  // 9-tap "plus" kernel that approximates the 2D blur. Widening dy
  // beyond dx scales the V kernel without recomputing weights — the
  // tap shape stays roughly gaussian for the sub-2px sigmas we use.
  vec4 sum = texture(tex, uv)                                * 0.252;
  sum     += texture(tex, uv + vec2(0.0, -1.0 * dy))          * 0.226;
  sum     += texture(tex, uv + vec2(0.0,  1.0 * dy))          * 0.226;
  sum     += texture(tex, uv + vec2(0.0, -2.0 * dy))          * 0.148;
  sum     += texture(tex, uv + vec2(0.0,  2.0 * dy))          * 0.148;
  sum     += texture(tex, uv + vec2(-1.0 * dx, 0.0))          * 0.226;
  sum     += texture(tex, uv + vec2( 1.0 * dx, 0.0))          * 0.226;
  sum     += texture(tex, uv + vec2(-2.0 * dx, 0.0))          * 0.148;
  sum     += texture(tex, uv + vec2( 2.0 * dx, 0.0))          * 0.148;
  // Sum of weights = 0.252 + 4*0.226 + 4*0.148 = 1.748. Normalize.
  return sum / 1.748;
}

void main() {
  vec2 dR = (uConvergenceR / uViewSize) * uConvergenceEnabled;
  vec2 dG = (uConvergenceG / uViewSize) * uConvergenceEnabled;
  vec2 dB = (uConvergenceB / uViewSize) * uConvergenceEnabled;

  float beamSpreadH = uBeamSpreadPx * uBeamSpreadEnabled;
  // Vertical sigma is at least the horizontal sigma — never let V be
  // sharper than H. When uBeamSpreadVerticalPx is 0 (default) this
  // collapses to the isotropic case.
  float beamSpreadV = max(beamSpreadH, uBeamSpreadVerticalPx * uBeamSpreadEnabled);
  float sR = sampleBeamSpread(uSignal, vUv + dR, beamSpreadH, beamSpreadV).r;
  float sG = sampleBeamSpread(uSignal, vUv + dG, beamSpreadH, beamSpreadV).g;
  float sB = sampleBeamSpread(uSignal, vUv + dB, beamSpreadH, beamSpreadV).b;
  float sA = sampleBeamSpread(uSignal, vUv, beamSpreadH, beamSpreadV).a;
  vec4 live = vec4(sR, sG, sB, sA);

  vec4 prev = texture(uPersistencePrev, vUv);
  float dr = uPersistence * uPersistenceEnabled;
  vec4 lerped = prev * dr + live * (1.0 - dr);

  // Store pre-stripe value so weights don't compound across frames.
  oPersistenceNext = lerped;

  vec2 px = vUv * uViewSize;
  int subX = int(mod(px.x, uCellSize.x));
  int subY = int(mod(px.y, uCellSize.y));

  // Stripe weights. General layout: subX=0→R primary, 1→G, 2→B,
  // anything else → gap (only coupling). Works for cs=2 (R+G, no B
  // primary — B via coupling only, matches original IS-2200 identity),
  // cs=3 (R+G+B triad, no gap — matches dark-mode logo), cs=4
  // (R+G+B+gap — proper aperture grille with darkened gap column).
  float coupling = uPhosphorCoupling * uCouplingEnabled;
  vec3 weights = vec3(coupling, coupling, coupling);
  if (subX == 0) weights.r = 1.0;
  else if (subX == 1) weights.g = 1.0;
  else if (subX == 2) weights.b = 1.0;
  // subX >= 3: stays at coupling (gap column for cs=4+)
  weights = mix(vec3(1.0), weights, uStripeEnabled);

  // Per-cell hotspot — vertically extended phosphor "dot."
  // X is narrow (only the center column of each cell gets any
  // boost) so the hotspot aligns with the phosphor stripe.
  // Y fades linearly across the cell height: full boost at the
  // center row, dropping to ~50% at the cell edges. The result
  // reads as a soft vertical streak rather than a single bright
  // pixel — matches how an aperture-grille phosphor "slot" lights
  // up along its length.
  int centerInt = int(uCellSize.x) / 2;
  int dx = abs(subX - centerInt);
  int dy = abs(subY - centerInt);
  float xMask = float(dx == 0);
  // Y falloff: 2× steeper than the cell-spanning soft version
  // (1 - dy/cellSize.y). Half the spread → drops to 0 by the cell
  // edge for small cells (cs=3,4) while still giving the center
  // row a softer streak than the single-pixel original.
  float yFall = max(0.0, 1.0 - 2.0 * float(dy) / uCellSize.y);
  float hotBoost = 1.0 + uHotspot * xMask * yFall;
  float hotMul = mix(1.0, hotBoost, uHotspotEnabled);

  // Per-cell shimmer: stable hash by cell index.
  vec2 cellCoord = floor(px / uCellSize);
  uint cellGridW = uint(uViewSize.x / uCellSize.x);
  uint cellIdx = uint(cellCoord.y) * cellGridW + uint(cellCoord.x);
  float cellShim = 1.0 + uCellShimmerAmp * (2.0 * lcg(cellIdx + uShimmerSeed) - 1.0);
  cellShim = mix(1.0, cellShim, uCellShimmerEnabled);

  // Per-row shimmer. Multiplies by a large prime to stride row seeds
  // well clear of the cell-shimmer seed domain — otherwise the row at
  // y=N hashes identically to cell (N, 0) and the two shimmers
  // correlate at the top band.
  float rowShim = 1.0 + uRowShimmerAmp * (2.0 * lcg(uint(cellCoord.y) * 4099u + uShimmerSeed) - 1.0);
  rowShim = mix(1.0, rowShim, uRowShimmerEnabled);

  float cellMod = hotMul * cellShim * rowShim;
  vec3 stripeOut = lerped.rgb * weights * cellMod;
  oPhosphor = vec4(stripeOut, lerped.a);
}`;

  const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPhosphor;
uniform sampler2D uGloss;
uniform sampler2D uVignette;
uniform sampler2D uGapMask;
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
uniform float uGapMaskEnabled;
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
  // canvas, with bleed-margin space on each side. Matches the CPU
  // path's drawImage(stripeCanvas, bleedMargin, bleedMargin, ...).
  vec2 stripeUv = (sampleUv - vec2(uStripeMargin)) / uStripeFraction;
  bool inStripe = stripeUv.x >= 0.0 && stripeUv.x <= 1.0 &&
                  stripeUv.y >= 0.0 && stripeUv.y <= 1.0;

  vec3 color = vec3(0.0);
  // Canvas alpha tracks the silhouette mask (phos.a) — sharp edge,
  // softened only by the upstream beam-spread blur on the signal.
  // When opaqueBackground=true (e.g., IS-2200 CRT screen), the
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

  vec4 gap = texture(uGapMask, vec2(sampleUv.x, 0.0));
  color *= mix(1.0, gap.r, uGapMaskEnabled);

  color *= uBrightness;

  // opaqueBackground=true → canvas is always fully opaque (IS-2200
  // CRT screen). false → alpha follows the silhouette+bloom mask
  // (logo on transparent page background).
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

  const BLOOM_BLUR_H_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexSize;
out vec4 oColor;
void main() {
  vec2 px = 1.0 / uTexSize;
  vec4 sum = texture(uTex, vUv) * 0.227027;
  sum += texture(uTex, vUv + vec2( px.x * 1.0, 0.0)) * 0.194594;
  sum += texture(uTex, vUv + vec2(-px.x * 1.0, 0.0)) * 0.194594;
  sum += texture(uTex, vUv + vec2( px.x * 2.0, 0.0)) * 0.121622;
  sum += texture(uTex, vUv + vec2(-px.x * 2.0, 0.0)) * 0.121622;
  sum += texture(uTex, vUv + vec2( px.x * 3.0, 0.0)) * 0.054054;
  sum += texture(uTex, vUv + vec2(-px.x * 3.0, 0.0)) * 0.054054;
  sum += texture(uTex, vUv + vec2( px.x * 4.0, 0.0)) * 0.016216;
  sum += texture(uTex, vUv + vec2(-px.x * 4.0, 0.0)) * 0.016216;
  oColor = sum;
}`;

  const BLOOM_BLUR_V_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexSize;
out vec4 oColor;
void main() {
  vec2 px = 1.0 / uTexSize;
  vec4 sum = texture(uTex, vUv) * 0.227027;
  sum += texture(uTex, vUv + vec2(0.0,  px.y * 1.0)) * 0.194594;
  sum += texture(uTex, vUv + vec2(0.0, -px.y * 1.0)) * 0.194594;
  sum += texture(uTex, vUv + vec2(0.0,  px.y * 2.0)) * 0.121622;
  sum += texture(uTex, vUv + vec2(0.0, -px.y * 2.0)) * 0.121622;
  sum += texture(uTex, vUv + vec2(0.0,  px.y * 3.0)) * 0.054054;
  sum += texture(uTex, vUv + vec2(0.0, -px.y * 3.0)) * 0.054054;
  sum += texture(uTex, vUv + vec2(0.0,  px.y * 4.0)) * 0.016216;
  sum += texture(uTex, vUv + vec2(0.0, -px.y * 4.0)) * 0.016216;
  oColor = sum;
}`;

  class Trinitron {
    constructor(canvasEl, opts) {
      this.canvas = canvasEl;
      this.opts = Object.assign({
        renderer: 'cpu',     // 'cpu' | 'gpu' | 'auto' — 'auto' tries gpu, falls back to cpu
        viewSize: [200, 200],
        canvasSize: [240, 240],
        // Cell pitch in source pixels. cs=3 keeps the shipped contiguous-
        // triad layout (`[R, G, B]`, no gap column) — combined with
        // `stripeUpscale > 1` and a `gapMaskAlpha` overlay, this gets the
        // visible aperture-grille look at shipped per-pixel cost. cs=6
        // uses an interleaved layout (`[R, gap, G, gap, B, gap]`) where
        // the gap is part of the source-pixel model — heavier, but the
        // gap participates in convergence and bleed.
        cellSize: 3,
        // Integer factor for stretching the stripe canvas onto the main
        // canvas via nearest-neighbor drawImage. With cs=3 and upscale=2,
        // each source pixel becomes 2 canvas pixels — that second canvas
        // pixel is what the gap mask paints over, suggesting an
        // aperture-grille wire between stripes without paying for source-
        // pixel gap columns in the hot loop.
        stripeUpscale: 1,
        // Phosphor overlap. Each lit stripe bleeds into its two adjacent
        // columns at this fraction (cyclic — the R at position 0 bleeds
        // into the gap at position 5 of the previous cell). 0 = strict
        // aperture grille (the gap is pure black). Values > 0 widen the
        // visible phosphor and narrow the visible gap, making the inter-
        // stripe shadow look thinner than a real Trinitron's. Pure-color
        // regions also gain brightness from the bleed into adjacent gaps.
        phosphorOverlap: 0,
        // Phosphor coupling (the "cheat" the shipped version used). At a
        // column where channel C is the primarily-lit one, the OTHER two
        // channels' signals also emit at this fraction. This is a
        // chromatic effect (every lit column shows all three channels'
        // signals, just emphasized differently), distinct from
        // phosphorOverlap which is geometric. Pure-color regions get
        // significantly brighter because three of every six columns show
        // the color (lit + 2 coupling) instead of just one (lit only).
        // Gap columns are unaffected — they stay pure black.
        phosphorCoupling: 0,
        // Gap mask — post-composite overlay that paints thin vertical
        // black lines on top of the stripe layer at canvas-pixel
        // positions. Lets the renderer keep cs=3 (no source-pixel gap
        // columns, shipped brightness and cost) while still showing the
        // aperture-grille gap pattern at display. 0 = no mask; 1 = pure
        // opaque black at each masked column. Mask is applied only over
        // the stripe region (not the bleed margin around it).
        gapMaskAlpha: 0,
        // Mask line spacing in canvas pixels. With stripeUpscale=2 and
        // gapMaskPeriod=2, every other canvas pixel is darkened — the
        // visible result is gap-between-every-stripe (aperture grille).
        // gapMaskPeriod=6 with stripeUpscale=2 puts one gap per triad
        // (cs=4-style between-triads gap).
        gapMaskPeriod: 2,
        bleedRadius: 30,
        bleedIntensity: 1.0,
        persistence: 0.85,
        convergence: { r: [-0.5, -0.5], g: [0.0, 0.0], b: [0.5, 0.5] },
        // Trinitron's two horizontal damper wires. Fractional Y positions
        // of the signal region. Stationary — real damper wires don't move.
        // Baked into the signal canvas before convergence so the wires
        // inherit the same chromatic fringe and bleed treatment as every
        // other feature. Set to [] to disable.
        damperWires: [0.32, 0.68],
        damperStrength: 0.62,
        // Optional per-row brightness noise. 0 = off. Cheap stand-in for
        // the line-to-line beam-current fluctuation a real CRT exhibits;
        // does not reassert the cell grid.
        rowShimmer: 0.0,
        // Per-cell brightness noise. 0 = off. Static per-cell jitter,
        // intentionally reasserts the cell grid — that's what makes each
        // cell read as a distinct phosphor dot rather than a flat tile.
        cellShimmer: 0.0,
        shimmerSeed: 1983,
        // Beam hotspot — Manhattan-distance brightness boost at the dead-
        // center pixel of each cell. With cs=3 this is the (subX=1,
        // subY=1) pixel — one of every nine source pixels. Combined with
        // cellShimmer, this is what produces the "dot grid" texture that
        // makes the rendered image read as phosphor dots through glass.
        hotspot: 0.0,
        // Post-stripe blur (CSS px) on the composite. Softens the
        // LCD-like sharp pixel edges into "lit phosphor through glass."
        phosphorBlurPx: 0.0,
        // Electron-beam spread, applied as a Gaussian blur on the
        // convergence canvases before sampling. A real Trinitron beam
        // has a fuzzy spot that spreads each scan line into adjacent ones;
        // without this, abrupt features (the bottom of an arm, the cap of
        // a curved edge) terminate razor-sharp mid-phosphor like an LCD.
        // Units are source pixels. Chromium's canvas filter blur no-ops
        // below ~0.7 px, so values under that have no effect.
        beamSpreadPx: 0.0,
        // Additional vertical-only beam spread (GPU path only). When
        // > beamSpreadPx, the kernel becomes anisotropic: horizontal
        // sigma stays at beamSpreadPx (so aperture-grille stripes stay
        // crisp), while vertical sigma widens to this value. Matches
        // how a real Trinitron divides its detail budget — quantized
        // horizontally by the grille pitch, soft-edged vertically by
        // the beam's gaussian PSF. 0 (default) = isotropic, identical
        // to beamSpreadPx on both axes. CPU path is unaffected (still
        // isotropic via canvas filter blur).
        beamSpreadVerticalPx: 0.0,
        // Barrel-distortion strength for the composite glass pass.
        // 0 = flat panel. Default 0 (CPU path doesn't use this).
        curvature: 0,
        // Curvature axis distribution. 'spherical' = generic CRT barrel
        // (warp on both axes, by r²). 'cylindrical' = Trinitron face
        // (warp X only, by x²) — verticals stay straight, horizontals
        // curve. GPU path only.
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
        // Whether the GPU path should create a sibling 2D canvas
        // for master-mode bypass rendering. Required when a UI
        // element (e.g., the IS-2200 power sticker) calls
        // setMasterMode(false). Skip when there's no toggle UI.
        bypassCanvas: true,
        // Whether the GPU path should create the ?debug=1 effect-
        // toggle overlay. Only one Trinitron per page should claim
        // it; secondary instances opt out.
        debugOverlay: true,
        // When true (default), canvas pixels are always opaque —
        // the canvas fills its parent's background and effects like
        // vignette/gap mask are visible across the entire surface.
        // When false, canvas alpha tracks the phosphor silhouette
        // (plus the bloom feather), so the canvas reads as a
        // cut-out of the page background. The IS-2200 wants opaque
        // (it's a CRT screen sitting in a card); the dark-mode logo
        // wants transparent (the logo floats on the page).
        opaqueBackground: true,
      }, opts);

      // Per-effect runtime toggles. Mutable; setters take effect on
      // the next frame. The default subset (stripeProfile, coupling,
      // persistence, hotspot, beamSpread) is the minimum that reads
      // as a CRT without piling on effects that fight each other or
      // pull focus from the content. Callers can pass any subset via
      // opts.effects to flip individual defaults.
      this.effects = Object.assign({
        // Phosphor pass — five effects on, four off.
        stripeProfile: true,
        phosphorCoupling: true,
        convergence: false,
        convergenceDrift: false,
        persistence: true,
        perCellHotspot: true,
        perCellShimmer: false,
        perRowShimmer: false,
        beamSpread: true,
        // Damper wires — Trinitron's two horizontal stabilizer strands.
        // On by default for any Trinitron sim worth the name; the
        // wires only show when opts.damperWires has positions in it
        // (default [0.32, 0.68]) and damperStrength < 1.
        damperWires: true,
        // Composite pass — both off (selectiveBloom interacts oddly
        // with the stripe profile; gapMask is broken at the current
        // sampling resolution, see commit history).
        selectiveBloom: false,
        gapMask: false,
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
        // Slow modulators — both off by default; warmup is a one-shot
        // brightness ramp that callers can re-enable if they want the
        // tube-warming-up moment.
        warmup: false,
        breathing: false,
      }, opts.effects || {});

      // Try GPU init if requested.
      this._mode = null;  // 'cpu' | 'gpu' — populated by init
      if (this.opts.renderer === 'gpu' || this.opts.renderer === 'auto') {
        try {
          this._initGpu();
          this._mode = 'gpu';
        } catch (err) {
          if (this.opts.renderer === 'gpu') throw err;
          // 'auto': fall through to CPU.
          console.warn('Trinitron: WebGL2 unavailable, falling back to CPU.', err);
        }
      }

      if (this._mode === null) {
        this._initCpu();
        this._mode = 'cpu';
      }

      // Master A/B initial state. Default on. Read from localStorage so the
      // user's last choice persists across reloads.
      this._masterOn = true;
      try {
        const stored = localStorage.getItem('interslice-systems:is2200:crt-mode');
        if (stored === 'off') this._masterOn = false;
      } catch (e) {
        // Default to on if storage unavailable.
      }

      this._wasStartedByUser = false;
      this._setupReducedMotionListener();
      this._rafHandle = null;
      this._startTime = null;
    }

    _initCpu() {
      this.ctx = this.canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const [cw, ch] = this.opts.canvasSize;
      const [vw, vh] = this.opts.viewSize;
      this.canvas.width = cw * dpr;
      this.canvas.height = ch * dpr;
      // Display size is the page's responsibility; the renderer only owns
      // the backing pixel buffer.
      this.ctx.scale(dpr, dpr);
      this.ctx.imageSmoothingEnabled = false;

      // Offscreen signal canvas — caller paints into 200×200 logical coords.
      // No willReadFrequently hint: the signal canvas is only sampled via
      // drawImage (into the convergence canvases) and is never read back
      // with getImageData. Setting the hint would push the browser to a
      // CPU-backed implementation for no benefit.
      this.signalCanvas = document.createElement('canvas');
      this.signalCanvas.width = vw;
      this.signalCanvas.height = vh;
      this.signalCtx = this.signalCanvas.getContext('2d');
      // Smoothing ON for the signal canvas — the caller's drawImage of a
      // rotated bitmap is bilinear-sampled, so AA fringe pixels at the
      // rotating hub's perimeter get smooth alpha gradients that change
      // continuously frame-to-frame. With smoothing OFF, nearest-neighbor
      // rotation snapped fringe pixels to different source pixels each
      // frame — visible flicker no downstream sampler could remove.
      this.signalCtx.imageSmoothingEnabled = true;
      this.signalCtx.imageSmoothingQuality = 'high';

      // Per-channel convergence canvases — each holds the signal drawn at
      // a sub-pixel offset (browser bilinear handles the resample). The
      // sampler reads each channel from its own buffer, so convergence
      // becomes a sub-source-pixel shift baked into the bitmap. The
      // bilinear AA at the shifted edge gives the columns that would
      // otherwise read alpha=0 a small contribution — chromatic fringe.
      const beamSpread = this.opts.beamSpreadPx;
      const makeConvCanvas = () => {
        const c = document.createElement('canvas');
        c.width = vw; c.height = vh;
        const cctx = c.getContext('2d', { willReadFrequently: true });
        cctx.imageSmoothingEnabled = true;
        cctx.imageSmoothingQuality = 'high';
        // Filter is set once and persists across drawImage calls — composes
        // with the bilinear sub-pixel resample so we get convergence shift
        // AND beam spread in a single source-canvas draw per channel.
        if (beamSpread > 0) cctx.filter = `blur(${beamSpread}px)`;
        return { canvas: c, ctx: cctx };
      };
      this._convR = makeConvCanvas();
      this._convG = makeConvCanvas();
      this._convB = makeConvCanvas();

      // Stripe intensity tables — one lookup per channel, indexed by subX.
      // For cs=6 the positions are interleaved (`[R, gap, G, gap, B, gap]`)
      // — every phosphor stripe bordered by an aperture-grille wire, the
      // physically-faithful layout. For other cs values, fall back to a
      // contiguous-triad layout with symmetric gap padding: cs=3 → [R,G,B];
      // cs=4 → [R,G,B,gap]; cs=5 → [gap,R,G,B,gap]; cs=7+ → wider symmetric
      // padding (avoid — cs=6 is the recommended layout).
      const cs = this.opts.cellSize;
      let rPos, gPos, bPos;
      if (cs === 6) {
        rPos = 0; gPos = 2; bPos = 4;
      } else {
        const leftGap = Math.max(0, (cs - 3) >> 1);
        rPos = leftGap; gPos = leftGap + 1; bPos = leftGap + 2;
      }
      this.stripeR = new Float32Array(cs);
      this.stripeG = new Float32Array(cs);
      this.stripeB = new Float32Array(cs);
      this.stripeR[rPos] = 1;
      this.stripeG[gPos] = 1;
      this.stripeB[bPos] = 1;
      // Phosphor overlap: each lit position contributes `overlap` to its
      // two cyclically-adjacent columns. Cyclic wrap matters at cs=6 —
      // the gap at position 5 sits between this cell's B and the next
      // cell's R, so it gets both B-bleed and R-bleed.
      const overlap = Math.max(0, Math.min(1, this.opts.phosphorOverlap));
      if (overlap > 0) {
        const addBleed = (arr, pos) => {
          const prev = (pos - 1 + cs) % cs;
          const next = (pos + 1) % cs;
          if (arr[prev] < overlap) arr[prev] = overlap;
          if (arr[next] < overlap) arr[next] = overlap;
        };
        addBleed(this.stripeR, rPos);
        addBleed(this.stripeG, gPos);
        addBleed(this.stripeB, bPos);
      }

      // Phosphor coupling: at columns where some channel is the primarily-
      // lit one (rPos, gPos, bPos), the OTHER two channels also emit at
      // this fraction. This is the shipped version's brightness cheat —
      // pure-color regions show their color at three columns of every
      // six (lit + 2 coupling), tripling the lit area without disturbing
      // the gap columns. Applied after overlap so it doesn't paint
      // coupling on gap columns; only the strict lit positions get the
      // cross-channel bleed.
      const coupling = Math.max(0, Math.min(1, this.opts.phosphorCoupling));
      if (coupling > 0) {
        const litPositions = [rPos, gPos, bPos];
        for (const pos of litPositions) {
          if (this.stripeR[pos] < coupling) this.stripeR[pos] = coupling;
          if (this.stripeG[pos] < coupling) this.stripeG[pos] = coupling;
          if (this.stripeB[pos] < coupling) this.stripeB[pos] = coupling;
        }
        // Restore the primary-lit channels to 1.0 (the loop above just
        // raised non-lit channels' weight to `coupling`, but if coupling
        // happens to exceed the lit channel's existing weight from a
        // weird future config we never want to lower the primary).
        this.stripeR[rPos] = 1;
        this.stripeG[gPos] = 1;
        this.stripeB[bPos] = 1;
      }

      // Damper-wire pixel rows. Computed once; stationary.
      const damperFracs = this.opts.damperWires || [];
      this.damperRows = damperFracs
        .map(f => Math.round(f * vh))
        .filter(y => y >= 0 && y < vh);
      // Wire is drawn as opaque-black-at-fillAlpha onto opaque signal
      // pixels via source-atop, which composites as
      // dest.RGB * (1 − fillAlpha). So fillAlpha = 1 − damperStrength
      // produces the desired multiplicative dim.
      this.damperOpacity = 1 - this.opts.damperStrength;

      // Per-row brightness LUT. Static — both effects baked in here would
      // otherwise be one multiply per pixel each in the hot loop; folded
      // into a single number per row, the inner loop pays for one.
      const rowShimAmp = this.opts.rowShimmer;
      const rowMod = new Float32Array(vh);
      // Single LCG drives both row shimmer (vh samples) and per-cell
      // shimmer (cellCount samples) so the seed deterministically picks a
      // single texture across both.
      let lcg = this.opts.shimmerSeed >>> 0;
      const lcgNext = () => {
        lcg = (Math.imul(lcg, 1664525) + 1013904223) >>> 0;
        return (lcg / 0xFFFFFFFF) * 2 - 1;
      };
      if (rowShimAmp > 0) {
        for (let i = 0; i < vh; i++) {
          rowMod[i] = 1 + rowShimAmp * lcgNext();
        }
      } else {
        rowMod.fill(1);
      }
      this.rowMod = rowMod;

      // Per-cell modulation LUT: combines the hotspot (a sub-cell Manhattan-
      // distance pattern, identical across every cell) and the per-cell
      // shimmer (one stable noise value per cell). The combined factor is
      // looked up by `cellShim[cellIdx] * hotLUT[subY * cs + subX]` in the
      // hot loop — two table reads and one multiply, no per-pixel
      // arithmetic. Setting either to 0 collapses its contribution to 1.0
      // so the multiply still runs but doesn't perturb.
      const cellGridW = Math.floor(vw / cs);
      const cellGridH = Math.floor(vh / cs);
      this.cellGridW = cellGridW;
      const cellCount = cellGridW * cellGridH;
      const hotspot = Math.max(0, this.opts.hotspot);
      const hotLUT = new Float32Array(cs * cs);
      if (hotspot > 0) {
        const cellCenter = cs >> 1;
        for (let sy = 0; sy < cs; sy++) {
          for (let sx = 0; sx < cs; sx++) {
            const dx = sx < cellCenter ? cellCenter - sx : sx - cellCenter;
            const dy = sy < cellCenter ? cellCenter - sy : sy - cellCenter;
            const d = dx + dy;
            hotLUT[sy * cs + sx] = d > 1 ? 1 : 1 + hotspot * (1 - d);
          }
        }
      } else {
        hotLUT.fill(1);
      }
      this.hotLUT = hotLUT;
      const cellShimAmp = Math.max(0, this.opts.cellShimmer);
      const cellShim = new Float32Array(cellCount);
      if (cellShimAmp > 0) {
        for (let i = 0; i < cellCount; i++) {
          cellShim[i] = 1 + cellShimAmp * lcgNext();
        }
      } else {
        cellShim.fill(1);
      }
      this.cellShim = cellShim;

      // Per-pixel persistence buffers. Snapshot of the previous frame's
      // smoothed (lerped, pre-stripe-profile) per-channel values, used to
      // exponential-decay the live signal into the displayed bitmap.
      // prevA persists the source-alpha (silhouette mask) — separate from
      // R/G/B because output alpha tracks silhouette coverage, not
      // phosphor brightness. Without this, dim or partially-saturated
      // pixels inside the silhouette would have low alpha and let the
      // bleed canvas paint a ghost of the underlying signal "through"
      // the phosphors.
      const pixelCount = vw * vh;
      this.prevR = new Float32Array(pixelCount);
      this.prevG = new Float32Array(pixelCount);
      this.prevB = new Float32Array(pixelCount);
      this.prevA = new Float32Array(pixelCount);

      // Stripe ImageData + intermediate canvas. putImageData ignores
      // compositing, so we go through an intermediate canvas and
      // drawImage from there — source-over with the stripe canvas's alpha
      // lets dark pixels block the bleed where appropriate.
      this.stripeImageData = this.ctx.createImageData(vw, vh);
      this.stripeCanvas = document.createElement('canvas');
      this.stripeCanvas.width = vw;
      this.stripeCanvas.height = vh;
      this.stripeCtx = this.stripeCanvas.getContext('2d');

      // Bleed canvas — the blurred displayed signal, sized to the full
      // canvas so the blur kernel's extent has room to bloom outward past
      // the signal's viewSize.
      this.bleedCanvas = document.createElement('canvas');
      this.bleedCanvas.width = cw;
      this.bleedCanvas.height = ch;
      this.bleedCtx = this.bleedCanvas.getContext('2d');

      // bleedRadius and bleedIntensity are constructor-only, so set the
      // filter once instead of toggling per frame.
      const bi = this.opts.bleedIntensity;
      this.bleedCtx.filter =
        `blur(${this.opts.bleedRadius}px)` +
        (bi !== 1 ? ` brightness(${bi})` : '');
      // The stripe canvas (vw×vh source pixels) is drawn onto the main
      // canvas at this integer scale factor via nearest-neighbor — each
      // source pixel becomes `stripeUpscale` canvas pixels. The bleed
      // signal is drawn at the same upscale so the halo stays aligned
      // with the stripe region.
      const stripeUpscale = Math.max(1, Math.floor(this.opts.stripeUpscale));
      this.stripeUpscale = stripeUpscale;
      this.stripeDestW = vw * stripeUpscale;
      this.stripeDestH = vh * stripeUpscale;
      this.bleedMargin = (cw - this.stripeDestW) / 2;

      // Gap mask — pre-baked canvas with thin black vertical lines that
      // span the FULL canvas (not just the stripe region). Painting only
      // over the stripe region created a visible dark rectangle: the
      // bleed halo extended past the stripe region into the margin at
      // full brightness, while everywhere inside the stripe region was
      // mask-darkened. The brightness jump at the boundary made the
      // mask's footprint show as an outline. Painting across the entire
      // canvas means the same darkening applies wherever the bleed is
      // visible, with no boundary discontinuity.
      //
      // Phase alignment: lines should land on the same canvas-x positions
      // as if the mask were scoped to the stripe region — i.e., starting
      // at (bleedMargin + period - 1) — so the visible aperture-grille
      // pattern stays aligned with the upscaled source pixels.
      const gapMaskAlpha = Math.max(0, Math.min(1, this.opts.gapMaskAlpha));
      if (gapMaskAlpha > 0 && stripeUpscale > 1) {
        const period = Math.max(2, Math.floor(this.opts.gapMaskPeriod));
        this.gapMaskCanvas = document.createElement('canvas');
        this.gapMaskCanvas.width = cw;
        this.gapMaskCanvas.height = ch;
        const mctx = this.gapMaskCanvas.getContext('2d');
        mctx.fillStyle = `rgba(0,0,0,${gapMaskAlpha})`;
        const phase = ((this.bleedMargin + period - 1) % period + period) % period;
        for (let dx = phase; dx < cw; dx += period) {
          mctx.fillRect(dx, 0, 1, ch);
        }
      } else {
        this.gapMaskCanvas = null;
      }
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
      // the phosphor/persistence attachments are RGBA32F.
      // Check BEFORE mutating this.* so 'auto' can cleanly fall back to CPU.
      const cbf = gl.getExtension('EXT_color_buffer_float');
      if (!cbf) throw new Error('EXT_color_buffer_float unavailable');
      // OES_texture_float_linear lets us sample RGBA32F textures with
      // LINEAR filtering in a shader. Without it, `texture(uPhosphor, ...)`
      // in the composite pass silently returns vec4(0) — no GL error,
      // just a black phosphor read — because LINEAR on a float texture
      // is "texture-incomplete" in WebGL2. The phosphor and persistence
      // textures use LINEAR (Task 9 consistency fix), so this extension
      // is load-bearing. Check before mutating this.* so 'auto' can
      // cleanly fall back to CPU.
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
      // pixels, matching the CPU path's `drawImage(stripeCanvas,
      // bleedMargin, bleedMargin, vw*stripeUpscale, vh*stripeUpscale)`.
      // When viewSize*stripeUpscale ≥ canvasSize (e.g., the IS-2200's
      // 1280-source / 640-canvas config), stripeFraction = 1 and
      // there's no margin — phosphor fills the canvas. Otherwise the
      // margin is reserved for the bleed halo.
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
      // source pixel as a sharp block — matches the CPU path's
      // imageSmoothingEnabled=false drawImage. LINEAR on this texture
      // averaged adjacent stripes and the per-cell hotspot into mush.
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
        phosphorCoupling:     gl.getUniformLocation(this._progPhosphor, 'uPhosphorCoupling'),
        persistence:          gl.getUniformLocation(this._progPhosphor, 'uPersistence'),
        convergenceR:         gl.getUniformLocation(this._progPhosphor, 'uConvergenceR'),
        convergenceG:         gl.getUniformLocation(this._progPhosphor, 'uConvergenceG'),
        convergenceB:         gl.getUniformLocation(this._progPhosphor, 'uConvergenceB'),
        stripeEnabled:        gl.getUniformLocation(this._progPhosphor, 'uStripeEnabled'),
        couplingEnabled:      gl.getUniformLocation(this._progPhosphor, 'uCouplingEnabled'),
        persistenceEnabled:   gl.getUniformLocation(this._progPhosphor, 'uPersistenceEnabled'),
        convergenceEnabled:   gl.getUniformLocation(this._progPhosphor, 'uConvergenceEnabled'),
        hotspot:              gl.getUniformLocation(this._progPhosphor, 'uHotspot'),
        cellShimmerAmp:       gl.getUniformLocation(this._progPhosphor, 'uCellShimmerAmp'),
        rowShimmerAmp:        gl.getUniformLocation(this._progPhosphor, 'uRowShimmerAmp'),
        shimmerSeed:          gl.getUniformLocation(this._progPhosphor, 'uShimmerSeed'),
        beamSpreadPx:         gl.getUniformLocation(this._progPhosphor, 'uBeamSpreadPx'),
        beamSpreadVerticalPx: gl.getUniformLocation(this._progPhosphor, 'uBeamSpreadVerticalPx'),
        hotspotEnabled:       gl.getUniformLocation(this._progPhosphor, 'uHotspotEnabled'),
        cellShimmerEnabled:   gl.getUniformLocation(this._progPhosphor, 'uCellShimmerEnabled'),
        rowShimmerEnabled:    gl.getUniformLocation(this._progPhosphor, 'uRowShimmerEnabled'),
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
        gapMask:           gl.getUniformLocation(this._progComposite, 'uGapMask'),
        canvasSize:        gl.getUniformLocation(this._progComposite, 'uCanvasSize'),
        curvature:         gl.getUniformLocation(this._progComposite, 'uCurvature'),
        curvatureEnabled:  gl.getUniformLocation(this._progComposite, 'uCurvatureEnabled'),
        glossEnabled:      gl.getUniformLocation(this._progComposite, 'uGlossEnabled'),
        vignetteEnabled:   gl.getUniformLocation(this._progComposite, 'uVignetteEnabled'),
        gapMaskEnabled:    gl.getUniformLocation(this._progComposite, 'uGapMaskEnabled'),
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
        tex:     gl.getUniformLocation(this._progBloomH, 'uTex'),
        texSize: gl.getUniformLocation(this._progBloomH, 'uTexSize'),
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
        tex:     gl.getUniformLocation(this._progBloomV, 'uTex'),
        texSize: gl.getUniformLocation(this._progBloomV, 'uTexSize'),
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

      // Bypass mode draws the signal canvas directly to the visible
      // canvas via a separate 2D context. WebGL2 already owns this.canvas,
      // so we use a hidden secondary canvas overlaid via CSS and toggle
      // between them via display:none / display:block.
      // Skipped when opts.bypassCanvas is false (e.g., for the dark-mode
      // logo, which has no master-mode toggle UI and would have its
      // bypass canvas mis-positioned by the .trinitron absolute layout).
      if (this.opts.bypassCanvas) {
        this._bypassCanvas = document.createElement('canvas');
        this._bypassCanvas.width = this.canvas.width;
        this._bypassCanvas.height = this.canvas.height;
        this._bypassCanvas.style.cssText = this.canvas.style.cssText;
        this._bypassCanvas.className = this.canvas.className;
        this._bypassCanvas.style.position = 'absolute';
        this._bypassCanvas.style.top = '0';
        this._bypassCanvas.style.left = '0';
        this._bypassCanvas.style.display = this._masterOn ? 'none' : 'block';
        this._bypassCtx = this._bypassCanvas.getContext('2d');
        this._bypassCtx.imageSmoothingEnabled = false;
        // Mount alongside the WebGL canvas. Parent must be position:relative
        // (or position:absolute/fixed) for absolute positioning to anchor
        // correctly; ensure that.
        if (this.canvas.parentElement) {
          const parent = this.canvas.parentElement;
          if (getComputedStyle(parent).position === 'static') {
            parent.style.position = 'relative';
          }
          parent.appendChild(this._bypassCanvas);
        }
      }

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
      panel.innerHTML = `<div style="font-weight:700;margin-bottom:8px;">__trinitron debug</div>`;

      // FPS readout.
      const fpsEl = document.createElement('div');
      fpsEl.style.cssText = 'margin-bottom:10px;color:#5EE2FF;';
      fpsEl.textContent = 'fps: --';
      panel.appendChild(fpsEl);
      this._debugFps = fpsEl;
      this._debugFpsLast = performance.now();
      this._debugFpsFrames = 0;

      // Baseline snapshot: capture current effects + panel-mutable opts
      // so the "copy state" button can emit a diff of "what did the user
      // change since page load." Deep-copies convergence (object) so we
      // don't alias.
      const PANEL_OPT_KEYS = [
        'phosphorCoupling', 'persistence', 'hotspot', 'cellShimmer',
        'rowShimmer', 'beamSpreadPx', 'beamSpreadVerticalPx',
        'curvature', 'curvatureMode', 'bloomThreshold', 'bloomStrength',
        'damperStrength', 'scanlineDepth', 'scanlinePeriod',
      ];
      const snapshotOpts = () => {
        const snap = {};
        for (const k of PANEL_OPT_KEYS) {
          if (k in this.opts) snap[k] = this.opts[k];
        }
        if (this.opts.convergence) {
          const c = this.opts.convergence;
          snap.convergence = {
            r: [c.r?.[0] ?? 0, c.r?.[1] ?? 0],
            g: [c.g?.[0] ?? 0, c.g?.[1] ?? 0],
            b: [c.b?.[0] ?? 0, c.b?.[1] ?? 0],
          };
        }
        return snap;
      };
      const baseline = {
        effects: { ...this.effects },
        opts: snapshotOpts(),
      };
      const convergenceEq = (a, b) => {
        if (!a || !b) return a === b;
        return a.r[0]===b.r[0] && a.r[1]===b.r[1] &&
               a.g[0]===b.g[0] && a.g[1]===b.g[1] &&
               a.b[0]===b.b[0] && a.b[1]===b.b[1];
      };
      const fmtNum = (n) => {
        if (Number.isInteger(n)) return String(n);
        return String(Math.round(n * 10000) / 10000); // strip float fuzz
      };
      const buildDiff = () => {
        const lines = [];
        for (const k of Object.keys(this.effects)) {
          if (this.effects[k] !== baseline.effects[k]) {
            lines.push(`  effects.${k} = ${this.effects[k]}`);
          }
        }
        const currOpts = snapshotOpts();
        for (const k of Object.keys(currOpts)) {
          const cv = currOpts[k];
          const bv = baseline.opts[k];
          if (k === 'convergence') {
            if (!convergenceEq(cv, bv)) {
              lines.push(`  opts.convergence = { r: [${cv.r.map(fmtNum).join(', ')}], g: [${cv.g.map(fmtNum).join(', ')}], b: [${cv.b.map(fmtNum).join(', ')}] }`);
            }
          } else if (cv !== bv) {
            if (typeof cv === 'string') lines.push(`  opts.${k} = '${cv}'`);
            else                        lines.push(`  opts.${k} = ${fmtNum(cv)}`);
          }
        }
        if (lines.length === 0) return 'trinitron state: (no changes from page load)';
        return ['trinitron state diff (from page load):', ...lines].join('\n');
      };

      // "Copy state" button. Writes the diff to clipboard; falls back
      // to console if clipboard is unavailable. Localhost is a secure
      // context so clipboard works on the dev server.
      const copyBtn = document.createElement('button');
      copyBtn.textContent = 'copy state diff';
      copyBtn.style.cssText = 'display:block;width:100%;padding:5px 6px;margin-bottom:10px;background:#222;color:#5EE2FF;border:1px solid #555;font:11px monospace;cursor:pointer;border-radius:2px;';
      copyBtn.addEventListener('click', async () => {
        const text = buildDiff();
        const restore = () => { copyBtn.textContent = 'copy state diff'; };
        try {
          await navigator.clipboard.writeText(text);
          copyBtn.textContent = 'copied to clipboard';
        } catch (err) {
          console.log('[trinitron]\n' + text);
          copyBtn.textContent = 'clipboard failed — see console';
        }
        setTimeout(restore, 1400);
      });
      panel.appendChild(copyBtn);

      // View CSS fallback toggle. Stops the renderer and removes
      // .trinitron-active from <html>, which is the single switch
      // index.html uses to gate "canvas painting" vs "static SVG
      // fallback" (canvas display:none, .mark .m-dark layers visible).
      // Same state a visitor sees if WebGL/JS fails. Note: if the
      // user toggles the theme while bypassed, the index.html
      // MutationObserver re-runs syncWithTheme() and re-adds the
      // class — re-check the box to bypass again.
      const bypassRow = document.createElement('label');
      bypassRow.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;padding:2px 0 8px;margin-bottom:8px;border-bottom:1px solid #444;';
      const bypassCb = document.createElement('input');
      bypassCb.type = 'checkbox';
      bypassCb.checked = false;
      bypassCb.addEventListener('change', () => {
        if (bypassCb.checked) {
          this.stop();
          document.documentElement.classList.remove('trinitron-active');
        } else {
          document.documentElement.classList.add('trinitron-active');
          this.start();
        }
      });
      bypassRow.appendChild(bypassCb);
      const bypassLbl = document.createElement('span');
      bypassLbl.textContent = 'view CSS fallback';
      bypassRow.appendChild(bypassLbl);
      panel.appendChild(bypassRow);

      // Captioned effect groups with inline sliders for tunable scalars.
      // Order mirrors the GPU pass order (phosphor → composite → glass);
      // "modulation" holds the slow brightness modulators. Sliders mutate
      // this.opts.<x> and re-run _uploadStaticUniforms so the change is
      // visible on the next frame.
      const GROUPS = [
        { title: 'phosphor',
          items: [
            { key: 'stripeProfile',    label: 'stripe profile',
              desc: 'RGB aperture-grille subpixel decomposition. Off = raw signal, no triad mask.' },
            { key: 'phosphorCoupling', label: 'phosphor coupling',
              desc: 'Each lit column also emits the other two channels. Brightens pure colors.',
              params: [{ opt: 'phosphorCoupling', min: 0, max: 1, step: 0.05, sub: 'strength' }] },
            { key: 'convergence',      label: 'convergence',
              desc: 'Per-channel xy-offset. R and B sample from shifted positions — edges fringe.',
              params: [{ opt: '__convergenceSpread', min: 0, max: 1, step: 0.05, sub: 'spread' }] },
            { key: 'convergenceDrift', label: 'convergence drift',
              desc: 'Slow time-varying R/B shift on top of base. Mistuned-yoke wobble.' },
            { key: 'persistence',      label: 'persistence',
              desc: 'Phosphor afterglow. Previous frame lerps with new at this decay.',
              params: [{ opt: 'persistence', min: 0, max: 0.99, step: 0.01, sub: 'decay' }] },
            { key: 'perCellHotspot',   label: 'per-cell hotspot',
              desc: 'Brightens the dead-center pixel of each cell — beam focus point.',
              params: [{ opt: 'hotspot', min: 0, max: 1.5, step: 0.05, sub: 'amount' }] },
            { key: 'perCellShimmer',   label: 'per-cell shimmer',
              desc: 'Static brightness jitter per cell. Asserts the phosphor-dot grid.',
              params: [{ opt: 'cellShimmer', min: 0, max: 0.2, step: 0.01, sub: 'amount' }] },
            { key: 'perRowShimmer',    label: 'per-row shimmer',
              desc: 'Per-scanline brightness noise. Beam-current line-to-line fluctuation.',
              params: [{ opt: 'rowShimmer', min: 0, max: 0.1, step: 0.005, sub: 'amount' }] },
            { key: 'beamSpread',       label: 'beam spread',
              desc: 'Gaussian PSF blur on signal. Softens razor edges into glowing phosphor.',
              params: [
                { opt: 'beamSpreadPx',         min: 0, max: 3, step: 0.1, sub: 'h (px)' },
                { opt: 'beamSpreadVerticalPx', min: 0, max: 3, step: 0.1, sub: 'v (px)' },
              ] },
            { key: 'damperWires',      label: 'damper wires',
              desc: 'Two horizontal stabilizer strands across the aperture grille. The Trinitron signature.',
              params: [{ opt: '__damperDarkness', min: 0, max: 1, step: 0.05, sub: 'darkness' }] },
          ] },
        { title: 'composite',
          items: [
            { key: 'selectiveBloom', label: 'selective bloom',
              desc: 'Bright-pixel halo. Threshold the phosphor, blur, add back as bloom.',
              params: [
                { opt: 'bloomThreshold', min: 0, max: 1, step: 0.05, sub: 'threshold' },
                { opt: 'bloomStrength',  min: 0, max: 3, step: 0.1,  sub: 'strength' },
              ] },
            { key: 'gapMask',        label: 'gap mask',
              desc: 'Dark vertical lines between stripes. Texture-baked; alpha fixed at init.' },
            { key: 'scanlines',      label: 'horizontal scanlines',
              desc: 'Periodic dim/bright bands along Y — the beam paints rows with gaps between.',
              params: [
                { opt: 'scanlineDepth',  min: 0, max: 1,  step: 0.02, sub: 'depth' },
                { opt: 'scanlinePeriod', min: 1, max: 10, step: 0.5,  sub: 'period (px)' },
              ] },
          ] },
        { title: 'glass',
          items: [
            { key: 'curvature', label: 'curvature',
              desc: 'CRT face curvature. Spherical = generic barrel; cylindrical = Trinitron (verticals stay straight).',
              params: [
                { opt: 'curvature', min: 0, max: 0.3, step: 0.01, sub: 'amount' },
                { opt: 'curvatureMode', kind: 'select', sub: 'mode',
                  options: ['spherical', 'cylindrical'] },
              ] },
            { key: 'gloss',     label: 'gloss',
              desc: 'Upper-left elliptical highlight. Virtual light source. Texture-baked.' },
            { key: 'vignette',  label: 'vignette',
              desc: 'Darken corners. Bezel falloff. Texture-baked.' },
          ] },
        { title: 'modulation',
          items: [
            { key: 'warmup',    label: 'warmup',
              desc: 'One-shot brightness ramp on start. CRT tube warming up.' },
            { key: 'breathing', label: 'breathing',
              desc: 'Slow brightness modulation. Power-supply ripple feel.' },
          ] },
      ];

      // Synthetic opts the panel exposes that don't map 1:1 to this.opts:
      //  __convergenceSpread → distributes to r=[-s,-s], b=[s,s], g=[0,0]
      //  __damperDarkness    → 1 - damperStrength (so the slider reads
      //                        "how dark are the wires" instead of the
      //                        existing "fraction of brightness remaining"
      //                        semantics buried in damperStrength)
      const readVal = (opt) => {
        if (opt === '__convergenceSpread') return Math.abs(this.opts.convergence?.r?.[0] ?? 0);
        if (opt === '__damperDarkness')   return 1 - (this.opts.damperStrength ?? 0);
        return this.opts[opt] ?? 0;
      };
      const writeVal = (opt, v) => {
        if (opt === '__convergenceSpread') {
          this.opts.convergence = { r: [-v, -v], g: [0, 0], b: [v, v] };
        } else if (opt === '__damperDarkness') {
          this.opts.damperStrength = 1 - v;
        } else {
          this.opts[opt] = v;
        }
        if (this._gl) this._uploadStaticUniforms();
      };
      const fmt = (v, step) => v.toFixed(Math.max(0, -Math.floor(Math.log10(step))));

      for (const group of GROUPS) {
        const head = document.createElement('div');
        head.style.cssText = 'margin-top:10px;margin-bottom:4px;color:#A99CFF;font-weight:700;font-size:10px;letter-spacing:0.06em;text-transform:uppercase;';
        head.textContent = group.title;
        panel.appendChild(head);

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
                select.value = String(this.opts[p.opt] ?? p.options[0]);
                select.addEventListener('change', () => { writeVal(p.opt, select.value); });
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
                const initV = readVal(p.opt);
                slider.value = String(initV);
                valEl.textContent = fmt(initV, p.step);
                slider.addEventListener('input', () => {
                  const v = parseFloat(slider.value);
                  valEl.textContent = fmt(v, p.step);
                  writeVal(p.opt, v);
                });
                prow.appendChild(slider);
                prow.appendChild(valEl);
              }

              block.appendChild(prow);
            }
          }

          panel.appendChild(block);
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
      if (this._texGapMask)  gl.deleteTexture(this._texGapMask);
      if (this._texBloomA) gl.deleteTexture(this._texBloomA);
      if (this._texBloomB) gl.deleteTexture(this._texBloomB);
      if (this._fboBloomA) gl.deleteFramebuffer(this._fboBloomA);
      if (this._fboBloomB) gl.deleteFramebuffer(this._fboBloomB);
      if (this._bypassCanvas && this._bypassCanvas.parentNode) {
        this._bypassCanvas.parentNode.removeChild(this._bypassCanvas);
      }
      this._bypassCanvas = null;
      this._bypassCtx = null;
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

      // GAP MASK: vertical-line pattern at twice the source resolution.
      // Period 2 canvas-px → every other column 25% dim. Tile vertically
      // via WRAP_T REPEAT (no per-row variation needed). The 4-px height
      // keeps the texture tiny.
      const gapW = vw * 2;
      const gapH = 4;
      const gapCanvas = document.createElement('canvas');
      gapCanvas.width = gapW;
      gapCanvas.height = gapH;
      const gpctx = gapCanvas.getContext('2d');
      gpctx.fillStyle = 'white';
      gpctx.fillRect(0, 0, gapW, gapH);
      gpctx.fillStyle = 'rgba(0,0,0,0.25)';
      for (let x = 1; x < gapW; x += 2) {
        gpctx.fillRect(x, 0, 1, gapH);
      }
      this._texGapMask = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this._texGapMask);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, gapCanvas);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    }

    // Upload uniforms that don't change for the lifetime of this
    // renderer — sampler unit bindings, viewSize/cellSize, the
    // base option values (phosphorCoupling, persistence, hotspot,
    // shimmer amplitudes, beam spread, bloom threshold, composite
    // geometry, opaque background flag), and the convergence base
    // (R/B get overridden per-frame when effects.convergenceDrift
    // is on; G never drifts). Called once at the end of _initGpu,
    // saving ~30 CPU→GPU command-buffer writes per frame.
    //
    // Uniforms still uploaded per frame in _renderGpu: the *Enabled
    // toggles (?debug=1 panel mutates them at runtime), brightness
    // (warmup/breathing modulate it), and convergence R/B when drift
    // is active.
    _uploadStaticUniforms() {
      const gl = this._gl;
      const [vw, vh] = this.opts.viewSize;

      // Phosphor program.
      gl.useProgram(this._progPhosphor);
      gl.uniform1i(this._uPhosphor.signal,          0);
      gl.uniform1i(this._uPhosphor.persistencePrev, 1);
      gl.uniform2f(this._uPhosphor.viewSize, vw, vh);
      gl.uniform2f(this._uPhosphor.cellSize, this.opts.cellSize, this.opts.cellSize);
      gl.uniform1f(this._uPhosphor.phosphorCoupling, this.opts.phosphorCoupling ?? 0.35);
      gl.uniform1f(this._uPhosphor.persistence,      this.opts.persistence);
      gl.uniform1f(this._uPhosphor.hotspot,          this.opts.hotspot);
      gl.uniform1f(this._uPhosphor.cellShimmerAmp,   this.opts.cellShimmer);
      gl.uniform1f(this._uPhosphor.rowShimmerAmp,    this.opts.rowShimmer);
      gl.uniform1ui(this._uPhosphor.shimmerSeed,     this.opts.shimmerSeed);
      gl.uniform1f(this._uPhosphor.beamSpreadPx,         this.opts.beamSpreadPx);
      gl.uniform1f(this._uPhosphor.beamSpreadVerticalPx, this.opts.beamSpreadVerticalPx);

      // Convergence base — R/B get overridden per-frame when drift is
      // active. On the transition back to inactive, _renderGpu re-uploads
      // the base values once to clear the drifted state.
      const c = this.opts.convergence;
      gl.uniform2f(this._uPhosphor.convergenceR, c.r[0], c.r[1]);
      gl.uniform2f(this._uPhosphor.convergenceG, c.g[0], c.g[1]);
      gl.uniform2f(this._uPhosphor.convergenceB, c.b[0], c.b[1]);

      // Composite program.
      gl.useProgram(this._progComposite);
      gl.uniform1i(this._uComposite.phosphor, 0);
      gl.uniform1i(this._uComposite.gloss,    1);
      gl.uniform1i(this._uComposite.vignette, 2);
      gl.uniform1i(this._uComposite.gapMask,  3);
      gl.uniform1i(this._uComposite.bloom,    4);
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

      gl.useProgram(this._progBloomH);
      gl.uniform1i(this._uBloomH.tex, 0);
      gl.uniform2f(this._uBloomH.texSize, this._bloomW, this._bloomH);

      gl.useProgram(this._progBloomV);
      gl.uniform1i(this._uBloomV.tex, 0);
      gl.uniform2f(this._uBloomV.texSize, this._bloomW, this._bloomH);
    }

    _renderGpu(timeMs) {
      const gl = this._gl;
      if (!gl) return;  // raced with destroy()

      // Paint signal first (caller's callback fills the 2D canvas).
      const [vw, vh] = this.opts.viewSize;
      this._signalCtx.clearRect(0, 0, vw, vh);
      this.opts.signal(this._signalCtx, timeMs);

      // Damper wires — stamp the configured horizontal rows onto the
      // signal canvas BEFORE upload, so the wires inherit convergence
      // fringe, persistence, beam spread, and bloom from the rest of
      // the pipeline. damperStrength names the fraction of substrate
      // brightness that REMAINS at the wire row (0 = fully black wire,
      // 1 = invisible) — same semantics as the CPU path.
      if (this.effects.damperWires &&
          this.opts.damperWires &&
          this.opts.damperWires.length > 0 &&
          this.opts.damperStrength < 1) {
        const fillAlpha = 1 - this.opts.damperStrength;
        this._signalCtx.fillStyle = `rgba(0,0,0,${fillAlpha})`;
        for (const frac of this.opts.damperWires) {
          const y = Math.round(frac * vh);
          if (y >= 0 && y < vh) this._signalCtx.fillRect(0, y, vw, 1);
        }
      }

      // Bypass mode only triggers if both the user toggled it off AND
      // this instance owns a bypass canvas. Instances constructed with
      // bypassCanvas:false ignore _masterOn and always render via GPU.
      if (!this._masterOn && this._bypassCanvas) {
        this._bypassCanvas.style.display = 'block';
        this.canvas.style.visibility = 'hidden';
        this._bypassCtx.clearRect(0, 0, this._bypassCanvas.width, this._bypassCanvas.height);
        this._bypassCtx.drawImage(
          this._signalCanvas,
          0, 0, vw, vh,
          0, 0, this._bypassCanvas.width, this._bypassCanvas.height
        );
        this._frameCount++;
        return;
      }

      // Master mode "on": show WebGL canvas, hide bypass (if present).
      if (this._bypassCanvas) this._bypassCanvas.style.display = 'none';
      this.canvas.style.visibility = 'visible';

      // Slow modulators driven by time. All amplitudes are tiny so the
      // effects coexist quietly with the content. Compound multiplicatively
      // into the final brightness uniform; convergence drift modulates the
      // per-channel UV offsets.

      // 1. Warmup curve: 0 → 1 over the first ~1.2s after start or since
      //    the last master-mode "on" toggle.
      const warmupDur = 1200; // ms
      const tWarm = timeMs - (this._warmupStartMs || 0);
      let warmupFactor = 1.0;
      if (this.effects.warmup && tWarm < warmupDur) {
        const k = Math.max(0, Math.min(1, tWarm / warmupDur));
        warmupFactor = k * k * (3.0 - 2.0 * k); // smoothstep
      }

      // 2. Breathing: 0.3 Hz, ±2% brightness modulation.
      let breathFactor = 1.0;
      if (this.effects.breathing) {
        breathFactor = 1.0 + 0.02 * Math.sin(timeMs * 0.0006 * Math.PI * 2.0);
      }

      this._brightness = warmupFactor * breathFactor;

      // 3. Convergence drift: 0.1 Hz, ±0.05 px on top of base convergence.
      //    R and B drift opposite; G stays stable (matches real CRT
      //    behavior where the green gun is the reference).
      this._convergenceDriftPx = 0.0;
      if (this.effects.convergenceDrift) {
        this._convergenceDriftPx = 0.05 * Math.sin(timeMs * 0.0002 * Math.PI * 2.0);
      }

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
      // option values (phosphorCoupling, persistence, hotspot, shimmer
      // amps, beam spread, viewSize/cellSize, sampler bindings, base
      // convergence) are uploaded once in _uploadStaticUniforms.
      gl.uniform1f(this._uPhosphor.stripeEnabled,      this.effects.stripeProfile    ? 1 : 0);
      gl.uniform1f(this._uPhosphor.couplingEnabled,    this.effects.phosphorCoupling ? 1 : 0);
      gl.uniform1f(this._uPhosphor.persistenceEnabled, this.effects.persistence      ? 1 : 0);
      gl.uniform1f(this._uPhosphor.convergenceEnabled, this.effects.convergence      ? 1 : 0);
      gl.uniform1f(this._uPhosphor.hotspotEnabled,     this.effects.perCellHotspot   ? 1 : 0);
      gl.uniform1f(this._uPhosphor.cellShimmerEnabled, this.effects.perCellShimmer   ? 1 : 0);
      gl.uniform1f(this._uPhosphor.rowShimmerEnabled,  this.effects.perRowShimmer    ? 1 : 0);
      gl.uniform1f(this._uPhosphor.beamSpreadEnabled,  this.effects.beamSpread       ? 1 : 0);

      // Convergence drift: override base R/B per-frame while active.
      // G never drifts (it's the reference channel). On the transition
      // from active→inactive, re-upload base R/B once so the GPU isn't
      // left with the last drifted values.
      const driftActive = this.effects.convergenceDrift;
      if (driftActive) {
        const c = this.opts.convergence;
        const drift = this._convergenceDriftPx;
        gl.uniform2f(this._uPhosphor.convergenceR, c.r[0] - drift, c.r[1]);
        gl.uniform2f(this._uPhosphor.convergenceB, c.b[0] + drift, c.b[1]);
      } else if (this._convergenceDriftWasActive) {
        const c = this.opts.convergence;
        gl.uniform2f(this._uPhosphor.convergenceR, c.r[0], c.r[1]);
        gl.uniform2f(this._uPhosphor.convergenceB, c.b[0], c.b[1]);
      }
      this._convergenceDriftWasActive = driftActive;

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
      gl.uniform1f(this._uComposite.gapMaskEnabled,   this.effects.gapMask        ? 1 : 0);
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
      gl.bindTexture(gl.TEXTURE_2D, this._texGapMask);
      gl.activeTexture(gl.TEXTURE4);
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
      if (this._mode === 'cpu') {
        this.prevR.fill(0); this.prevG.fill(0); this.prevB.fill(0); this.prevA.fill(0);
      } else if (this._mode === 'gpu' && this._gl) {
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
      if (this._reducedMotionMq && this._reducedMotionMq.matches) {
        if (this._mode === 'cpu') this._frame(0);
        else if (this._mode === 'gpu') this._renderGpu(0);
        return;
      }
      const tick = (now) => {
        const t = now - this._startTime;
        if (this._mode === 'cpu') this._frame(t);
        else if (this._mode === 'gpu') this._renderGpu(t);
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

    // Master A/B mode. true = CRT effects on, false = bypass to raw signal
    // (only effective when bypassCanvas:true at construction; the hero
    // screen passes false and ignores master mode). localStorage-persisted.
    setMasterMode(on) {
      const wasOn = this._masterOn;
      this._masterOn = !!on;
      if (this._masterOn && !wasOn) {
        // Reset warmup so the "on" transition feels like turning the tube on.
        this._warmupStartMs = performance.now() - (this._startTime || performance.now());
      }
      try {
        localStorage.setItem(
          'interslice-systems:is2200:crt-mode',
          this._masterOn ? 'on' : 'off'
        );
      } catch (e) {
        // localStorage may be unavailable (private mode, etc.). State
        // still tracks in-memory for this session.
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
      if (this._mode === 'gpu') this._destroyGpu();
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

    _frame(timeMs) {
      const [vw, vh] = this.opts.viewSize;
      const [cw, ch] = this.opts.canvasSize;

      // 1. Caller paints the displayed signal. The halo and the stripes
      //    both derive from this one bitmap — a real CRT can't selectively
      //    leak some pixels and not others.
      this.signalCtx.clearRect(0, 0, vw, vh);
      this.opts.signal(this.signalCtx, timeMs);

      // 2. Stamp damper wires onto the signal. source-atop confines the
      //    dim to opaque phosphor pixels (no wires over the surrounding
      //    glass). Baking into the signal means the wires get the same
      //    convergence fringe and bleed treatment as everything else.
      if (this.effects.damperWires && this.damperRows.length > 0 && this.damperOpacity > 0) {
        this.signalCtx.save();
        this.signalCtx.globalCompositeOperation = 'source-atop';
        this.signalCtx.fillStyle = `rgba(0,0,0,${this.damperOpacity})`;
        for (let i = 0; i < this.damperRows.length; i++) {
          this.signalCtx.fillRect(0, this.damperRows[i], vw, 1);
        }
        this.signalCtx.restore();
      }

      // 3. Bake per-channel convergence offsets into three pre-shifted
      //    copies of the signal.
      this._applyConvergence();

      // 4. Per-output-pixel pass: sample → persistence lerp + snapshot →
      //    stripe profile (geometric gap is pure black) → write.
      this._renderPixels();
      this.stripeCtx.putImageData(this.stripeImageData, 0, 0);

      // 5. Blur the bleed source canvas. The canvas filter blurs per
      //    channel, so a single blur produces the correct per-channel
      //    additive halo.
      this._renderBleed();

      // 6. Composite: bleed underneath, stripes on top (optionally
      //    softened, optionally stretched via stripeUpscale), then gap
      //    mask on top of stripes.
      this.ctx.clearRect(0, 0, cw, ch);
      this.ctx.drawImage(this.bleedCanvas, 0, 0);
      const blur = this.opts.phosphorBlurPx;
      if (blur > 0) this.ctx.filter = `blur(${blur}px)`;
      this.ctx.drawImage(
        this.stripeCanvas,
        this.bleedMargin, this.bleedMargin,
        this.stripeDestW, this.stripeDestH
      );
      if (blur > 0) this.ctx.filter = 'none';
      if (this.gapMaskCanvas) {
        // source-atop so the mask only darkens canvas pixels that already
        // have content (the bleed halo + stripes). Without this, masked
        // canvas pixels in transparent regions (the corners of the
        // canvas backing buffer where the bleed halo doesn't reach) would
        // gain alpha from the 0.5-alpha black, painting a semi-opaque
        // rectangle over the page background.
        this.ctx.globalCompositeOperation = 'source-atop';
        this.ctx.drawImage(this.gapMaskCanvas, 0, 0);
        this.ctx.globalCompositeOperation = 'source-over';
      }
    }

    _applyConvergence() {
      // Bake per-channel convergence offsets into three pre-shifted source
      // bitmaps. drawImage(signal, -dx, -dy) produces dest(X,Y) =
      // signal(X+dx, Y+dy): a positive convergence value shifts that
      // channel LEFT in the displayed image. The browser's bilinear
      // resample at sub-pixel offsets produces a soft AA fringe, so a
      // 0.25 px convergence renders as a 0.25-px-wide color fringe at
      // edges instead of a cell-quantized 1-stripe ghost.
      const [vw, vh] = this.opts.viewSize;
      const c = this.opts.convergence;
      this._convR.ctx.clearRect(0, 0, vw, vh);
      this._convR.ctx.drawImage(this.signalCanvas, -c.r[0], -c.r[1]);
      this._convG.ctx.clearRect(0, 0, vw, vh);
      this._convG.ctx.drawImage(this.signalCanvas, -c.g[0], -c.g[1]);
      this._convB.ctx.clearRect(0, 0, vw, vh);
      this._convB.ctx.drawImage(this.signalCanvas, -c.b[0], -c.b[1]);
    }

    _renderPixels() {
      // One fused per-output-pixel pass. For each pixel:
      //   sample (alpha-premultiplied) RGB from each channel's pre-shifted
      //   source + sample source alpha (unshifted G channel — the cleanest
      //   silhouette mask)
      //   → exponential-decay lerp R, G, B, AND A against previous frame
      //   → snapshot smoothed values into prev[] (pre-stripe-profile)
      //   → multiply RGB by per-channel stripe weight + per-row mod
      //   → write RGBA. Output alpha = lerpA tracks the silhouette
      //     coverage (the aperture grille mask), NOT phosphor brightness:
      //     inside the logo, gap pixels are opaque black so the bleed is
      //     blocked (no ghost of the SVG painted under the stripes);
      //     outside the logo, alpha is 0 and the bleed shines through.
      const [vw, vh] = this.opts.viewSize;
      const cs = this.opts.cellSize;
      const out = this.stripeImageData.data;

      // Alpha-weighting per channel matters: ImageData is non-premultiplied,
      // so a half-covered AA fringe reads as (R, _, _, 128) for a half-red
      // edge — multiplying by alpha/255 makes contribution proportional to
      // actual coverage, which keeps the rotating hub's perimeter smooth
      // instead of staircasing as the AA pattern shifts frame-to-frame.
      const pxR = this._convR.ctx.getImageData(0, 0, vw, vh).data;
      const pxG = this._convG.ctx.getImageData(0, 0, vw, vh).data;
      const pxB = this._convB.ctx.getImageData(0, 0, vw, vh).data;

      // Persistence: single exponential decay across channels. First-frame
      // cost: prev is zero on start(), so the image fades in over
      // ~1/(1−dr) frames (≈7 frames at dr=0.85, ~110 ms at 60 Hz).
      const dr = Math.min(0.99, this.opts.persistence);
      const ar = 1 - dr;
      const prR = this.prevR, prG = this.prevG, prB = this.prevB, prA = this.prevA;

      const stripeR = this.stripeR;
      const stripeG = this.stripeG;
      const stripeB = this.stripeB;
      const rowMod = this.rowMod;
      const hotLUT = this.hotLUT;
      const cellShim = this.cellShim;
      const cellGridW = this.cellGridW;
      const invCs = 1 / cs;

      let pi = 0, pix = 0;
      for (let py = 0; py < vh; py++) {
        const rm = rowMod[py];
        const cyBase = (py * invCs) | 0;
        const subY = py - cyBase * cs;
        const hotRowOff = subY * cs;
        const cellRowBase = cyBase * cellGridW;

        for (let px = 0; px < vw; px++) {
          const cxBase = (px * invCs) | 0;
          const subX = px - cxBase * cs;

          // Sample alpha-premultiplied RGB.
          const sR_raw = pxR[pi]     * (pxR[pi + 3] / 255);
          const sG_raw = pxG[pi + 1] * (pxG[pi + 3] / 255);
          const sB_raw = pxB[pi + 2] * (pxB[pi + 3] / 255);
          // Sample source alpha from the unshifted G channel — the
          // cleanest silhouette mask, with the AA/beam-spread edge
          // softening preserved but no chromatic offset.
          const sA = pxG[pi + 3];

          // Persistence lerp + snapshot.
          const lerpR = prR[pix] * dr + sR_raw * ar;
          const lerpG = prG[pix] * dr + sG_raw * ar;
          const lerpB = prB[pix] * dr + sB_raw * ar;
          const lerpA = prA[pix] * dr + sA     * ar;
          prR[pix] = lerpR;
          prG[pix] = lerpG;
          prB[pix] = lerpB;
          prA[pix] = lerpA;

          // Cell mod combines per-cell shimmer (one value per cell) with
          // the sub-cell hotspot pattern (boost at the cell center). Both
          // collapse to 1.0 when their amplitudes are 0, so this multiply
          // is harmless when both effects are off.
          const cellMod = hotLUT[hotRowOff + subX] * cellShim[cellRowBase + cxBase];

          // Stripe geometry: weighted contribution from each lit position
          // (with optional overlap bleeding into adjacent columns).
          const r = lerpR * stripeR[subX] * rm * cellMod;
          const g = lerpG * stripeG[subX] * rm * cellMod;
          const b = lerpB * stripeB[subX] * rm * cellMod;

          out[pi]     = r > 255 ? 255 : r;
          out[pi + 1] = g > 255 ? 255 : g;
          out[pi + 2] = b > 255 ? 255 : b;
          out[pi + 3] = lerpA > 255 ? 255 : lerpA;

          pi += 4;
          pix++;
        }
      }
    }

    _renderBleed() {
      // Filter is set once in the constructor. Visible extent of a Gaussian
      // is ~3*stdDev — keep bleedRadius ≤ (canvasSize − stripeDestW)/2 or
      // the tail will clip at the canvas edge. Signal is drawn at the
      // same upscaled size as the stripe layer so the halo stays aligned
      // around the visible silhouette.
      const [cw, ch] = this.opts.canvasSize;
      this.bleedCtx.clearRect(0, 0, cw, ch);
      this.bleedCtx.drawImage(
        this.signalCanvas,
        this.bleedMargin, this.bleedMargin,
        this.stripeDestW, this.stripeDestH
      );
    }
  }

  window.Trinitron = Trinitron;
})();
