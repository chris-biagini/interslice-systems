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

  // Phosphor fragment shader — beam spread, stripe profile.
  // Full phosphor pass.
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
uniform float uBeamSpreadPx;
uniform float uBeamSpreadVerticalPx;
uniform float uStripeEnabled;
uniform float uCouplingEnabled;
uniform float uPersistenceEnabled;
uniform float uConvergenceEnabled;
uniform float uBeamSpreadEnabled;

layout(location = 0) out vec4 oPhosphor;
layout(location = 1) out vec4 oPersistenceNext;

// Beam spread: anisotropic 2D Gaussian via a 9-tap "plus" kernel
// (5 taps along Y, 4 additional taps along X with the center shared).
// Horizontal and vertical sigmas can differ — a real Trinitron's
// horizontal "resolution" is quantized by the aperture grille pitch
// (so horizontal blur should stay narrow to keep stripes crisp),
// while the vertical axis is bounded only by the beam's gaussian
// PSF and should typically spread further. Setting beamSpreadVerticalPx
// equal to beamSpreadPx collapses to the isotropic case.
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
  // Half-LSB fade bias: in 8-bit, prev*decay can round back to prev at
  // the bottom few grey levels and a trail would never reach zero.
  // Subtracting 0.5/255 guarantees termination; cost to the persisted
  // tail is 0.2% per frame — invisible.
  oPersistenceNext = max(lerped - 0.5 / 255.0, vec4(0.0));

  vec2 px = vUv * uViewSize;
  int subX = int(mod(px.x, uCellSize.x));

  // Stripe weights. General layout: subX=0→R primary, 1→G, 2→B,
  // anything else → gap (only coupling). Works for cs=2 (R+G, no B
  // primary — B via coupling only, the original 2-stripe identity),
  // cs=3 (R+G+B triad, no gap — the hero screen's contiguous-triad
  // layout), cs=4 (R+G+B+gap — proper aperture grille with darkened
  // gap column).
  float coupling = uPhosphorCoupling * uCouplingEnabled;
  vec3 weights = vec3(coupling, coupling, coupling);
  if (subX == 0) weights.r = 1.0;
  else if (subX == 1) weights.g = 1.0;
  else if (subX == 2) weights.b = 1.0;
  // subX >= 3: stays at coupling (gap column for cs=4+)
  weights = mix(vec3(1.0), weights, uStripeEnabled);

  vec3 stripeOut = lerped.rgb * weights;
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
uniform vec3 uGradeGains;           // white-point RGB gains (CPU-computed from temperature)
uniform float uGradeSaturation;     // luma-preserving saturation
uniform float uGradeEnabled;
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

  // Phosphor color grade — the tube's color character, applied to
  // emitted light only. Gloss (a reflection on the glass in front of
  // the phosphor) and vignette/gap-mask (glass/bezel) come after and
  // are not tinted by it.
  // NB: high saturation extrapolates components negative / above 1.
  // That is safe ONLY because every later op (gloss add, vignette/
  // gap/brightness multiplies) is channel-uniform, so out-of-range
  // values clamp at output without hue shift. If a PER-CHANNEL op is
  // ever inserted after this, add max(graded, 0.0).
  float gradeLuma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  vec3 graded = mix(vec3(gradeLuma), color, uGradeSaturation) * uGradeGains;
  color = mix(color, graded, uGradeEnabled);

  vec4 gloss = texture(uGloss, sampleUv);
  color += vec3(gloss.a) * uGlossEnabled;

  vec4 vig = texture(uVignette, sampleUv);
  color *= mix(1.0, vig.r, uVignetteEnabled);

  vec4 gap = texture(uGapMask, vec2(sampleUv.x, 0.0));
  color *= mix(1.0, gap.r, uGapMaskEnabled);

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

  // Opts the panels snapshot for stateDiff(). curvatureMode stays listed
  // even though the menu no longer offers it — console-driven changes
  // should still show up in the diff.
  const PANEL_OPT_KEYS = [
    'phosphorCoupling', 'persistenceHalfLifeMs',
    'beamSpreadPx', 'beamSpreadVerticalPx',
    'curvature', 'curvatureMode', 'bloomThreshold', 'bloomStrength',
    'bleedRadius', 'gradeTemperature', 'gradeSaturation', 'damperStrength', 'scanlineDepth', 'scanlinePeriod',
  ];

  class Trinitron {
    constructor(canvasEl, opts) {
      this.canvas = canvasEl;
      this.opts = Object.assign({
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
        // X-only misconvergence — inline cathodes land R/B left/right
        // of G, never above/below, so the fringe sits on vertical edges
        // where a real Trinitron shows it.
        convergence: { r: [-0.5, 0.0], g: [0.0, 0.0], b: [0.5, 0.0] },
        // Trinitron's two horizontal damper wires. Fractional Y positions
        // of the signal region. Stationary — real damper wires don't move.
        // Baked into the signal canvas before convergence so the wires
        // inherit the same chromatic fringe and bleed treatment as every
        // other feature. Set to [] to disable.
        damperWires: [0.32, 0.68],
        damperStrength: 0.62,
        // Electron-beam spread, applied as a Gaussian blur on the
        // convergence canvases before sampling. A real Trinitron beam
        // has a fuzzy spot that spreads each scan line into adjacent ones;
        // without this, abrupt features (the bottom of an arm, the cap of
        // a curved edge) terminate razor-sharp mid-phosphor like an LCD.
        // Units are source pixels. Chromium's canvas filter blur no-ops
        // below ~0.7 px, so values under that have no effect.
        beamSpreadPx: 0.0,
        // Additional vertical-only beam spread. When > beamSpreadPx,
        // the kernel becomes anisotropic: horizontal sigma stays at
        // beamSpreadPx (so aperture-grille stripes stay crisp), while
        // vertical sigma widens to this value. Matches how a real
        // Trinitron divides its detail budget — quantized horizontally
        // by the grille pitch, soft-edged vertically by the beam's
        // gaussian PSF. 0 (default) = isotropic, identical to
        // beamSpreadPx on both axes.
        beamSpreadVerticalPx: 0.0,
        // Barrel-distortion strength for the composite glass pass.
        // 0 = flat panel.
        curvature: 0,
        // Curvature axis distribution — tube-determined, not a menu
        // option. A Trinitron face is cylindrical (warp X only, by x²):
        // verticals stay straight, horizontals bow. Callers can still
        // override to 'spherical' (generic r² barrel on both axes), but
        // the ?debug=1 panel no longer offers the choice.
        curvatureMode: 'cylindrical',
        // Horizontal scanlines (GPU composite pass). scanlineDepth = 0
        // means flat brightness; 1 means troughs go to black.
        // scanlinePeriod = source pixels per bright/dim cycle, so on a
        // vh=320 hero with period=2 you get 160 scanlines.
        scanlineDepth: 0.18,
        scanlinePeriod: 2,
        bloomThreshold: 0.6,
        bloomStrength: 1.0,
        // Phosphor color grade — the tube's color character. Temperature
        // ∈ [-1, 1] maps to RGB white-point gains (positive = warm);
        // saturation is a luma-preserving lift. Applied to emitted
        // light only, before the glass gloss. Defaults tuned on the
        // tv.html bench; the colorGrade effect is off unless a caller
        // (e.g. presets.tv) opts in.
        gradeTemperature: 0.3,
        gradeSaturation: 1.08,
        signal: () => {},
        respectReducedMotion: true,
        // Whether the GPU path should create the ?debug=1 effect-
        // toggle overlay. Only one Trinitron per page should claim
        // it; secondary instances opt out.
        debugOverlay: true,
        // When true (default), canvas pixels are always opaque —
        // the canvas fills its parent's background and effects like
        // vignette/gap mask are visible across the entire surface.
        // When false, canvas alpha tracks the phosphor silhouette
        // (plus the bloom feather), so the canvas reads as a
        // cut-out of the page background. The hero screen wants
        // opaque (it's a bounded CRT face); a free-floating logo
        // sim would want transparent.
        opaqueBackground: true,
      }, opts);

      // Per-effect runtime toggles. Mutable; setters take effect on
      // the next frame. The default subset (stripeProfile, coupling,
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
        // Damper wires — Trinitron's two horizontal stabilizer strands.
        // On by default for any Trinitron sim worth the name; the
        // wires only show when opts.damperWires has positions in it
        // (default [0.32, 0.68]) and damperStrength < 1.
        damperWires: true,
        // Composite pass — both off by default. selectiveBloom interacts
        // oddly with the stripe profile, so callers opt in. gapMask is
        // off because it's only meaningful when gapMaskAlpha > 0 and the
        // caller has sized canvasSize so the stripe region (or close to
        // it) fills the canvas — otherwise the period drifts off the
        // stripe grid in the bleed margin. The hero opts in.
        selectiveBloom: false,
        gapMask: false,
        // Color grade — off by default; the TV preset opts in.
        colorGrade: false,
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

      // Scheduler state. _wasStartedByUser is user intent (start() sets,
      // stop() clears); _mode is what the loop is doing right now:
      //   'stopped' — halted (never started, stop()ed, offscreen, RM)
      //   'running' — RAF loop live
      //   'idle'    — parked: signal static + trails settled; zero work
      //               until requestRender(), a visibility change, or
      //               start() wakes it.
      //               (tv.html's bench reads _mode to show "fps: idle".)
      this._wasStartedByUser = false;
      this._mode = 'stopped';
      this._visible = true;
      this._idleAt = Infinity;
      this._signalStale = false;   // set on context restore: ask the callback to repaint
      this._setupReducedMotionListener();
      this._setupVisibilityObserver();
      // Context-loss recovery: a GPU reset/driver hiccup currently
      // means a permanently dead canvas. Stop cleanly on loss, rebuild
      // all GPU state and resume on restore. preventDefault() is
      // required or the restored event never fires.
      this._onContextLost = (e) => {
        e.preventDefault();
        this._haltLoop();
        this._gl = null;
      };
      this._onContextRestored = () => {
        this._initGpu();
        // The rebuilt signal texture is blank; ask the callback to
        // repaint even if it memoizes ("nothing new" returns).
        this._signalStale = true;
        this._resumeLoop();
      };
      this.canvas.addEventListener('webglcontextlost', this._onContextLost);
      this.canvas.addEventListener('webglcontextrestored', this._onContextRestored);
      this._rafHandle = null;
      this._startTime = null;
      this._lastRenderT = null;
    }

    // --- Panel/bench param API ------------------------------------------
    // Shared by the built-in ?debug=1 overlay and external benches
    // (docs/tv.html). Synthetic params (double-underscore) translate
    // UI-friendly scalars into structured opts:
    //   __convergenceSpread → X-ONLY r/b offsets (inline-cathode Trinitron
    //                         misconverges horizontally; see spec
    //                         2026-06-10-crt-effect-axes-and-tv-page-design.md)
    //   __damperDarkness    → 1 - damperStrength
    readParam(opt) {
      if (opt === '__convergenceSpread') return Math.abs(this.opts.convergence?.r?.[0] ?? 0);
      if (opt === '__damperDarkness')   return 1 - (this.opts.damperStrength ?? 0);
      return this.opts[opt] ?? 0;
    }

    writeParam(opt, v) {
      if (opt === '__convergenceSpread') {
        this.opts.convergence = { r: [-v, 0], g: [0, 0], b: [v, 0] };
      } else if (opt === '__damperDarkness') {
        this.opts.damperStrength = 1 - v;
      } else {
        this.opts[opt] = v;
      }
      if (this._gl) this._uploadStaticUniforms();
      this.requestRender();   // repaint even when parked on a static picture
    }

    // Temperature → RGB white-point gains. Positive warms (R up, B
    // down); the 3%/5% asymmetry keeps perceived brightness roughly
    // flat across the slider.
    _gradeGains(t) {
      return [1.0 + 0.03 * t, 1.0, 1.0 - 0.05 * t];
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
      if (!lines.length) return 'trinitron state: (no changes from construction)';
      return ['trinitron state diff (from construction):', ...lines].join('\n');
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

      // Persistence ping-pong + phosphor textures (RGBA8 — every stored
      // value is bounded [0,1], so 8 bits suffice and no float-render
      // extensions are needed; any WebGL2 context runs the full
      // pipeline). Persistence textures are LINEAR so convergence-
      // shifted reads blend consistently with the signal sample. The
      // phosphor output texture is NEAREST so the composite upscale
      // tiles each source pixel as a sharp block; LINEAR here averaged
      // adjacent stripes into mush. The shader subtracts a half-LSB
      // fade bias so 8-bit trails always reach zero.
      const makeFrameTex = (w, h, filter) => {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
      };
      this._texPersistA = makeFrameTex(vw, vh, gl.LINEAR);
      this._texPersistB = makeFrameTex(vw, vh, gl.LINEAR);
      this._texPhosphor = makeFrameTex(vw, vh, gl.NEAREST);

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
      this._uComposite.gradeGains       = gl.getUniformLocation(this._progComposite, 'uGradeGains');
      this._uComposite.gradeSaturation  = gl.getUniformLocation(this._progComposite, 'uGradeSaturation');
      this._uComposite.gradeEnabled     = gl.getUniformLocation(this._progComposite, 'uGradeEnabled');

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
      if (this._debugPanel) return;   // context-restore re-runs _initGpu
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
      titleEl.textContent = '__trinitron debug';
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
          console.log('[trinitron]\n' + text);
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
          cb.addEventListener('change', () => { this.effects[item.key] = cb.checked; this.requestRender(); });
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
      if (this._texGapMask)  gl.deleteTexture(this._texGapMask);
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

      // GAP MASK: vertical-line pattern at twice the source resolution.
      // Period N canvas-px → one in N columns darkened by gapMaskAlpha.
      // Tile vertically via WRAP_T REPEAT (no per-row variation needed).
      // The 4-px height keeps the texture tiny.
      //
      // Offset is `period - 1` (the last column of each period bucket),
      // preserving the historical hero behavior at period=2 (darken
      // every x=1, 3, 5...). Comments in the option block describe the
      // intent at larger periods (e.g., period=6 with stripeUpscale=2
      // puts roughly one dark column per RGB triad).
      const period = Math.max(1, Math.floor(this.opts.gapMaskPeriod || 2));
      const offset = period - 1;
      const alpha = Math.max(0, Math.min(1, this.opts.gapMaskAlpha || 0));
      const gapW = vw * 2;
      const gapH = 4;
      const gapCanvas = document.createElement('canvas');
      gapCanvas.width = gapW;
      gapCanvas.height = gapH;
      const gpctx = gapCanvas.getContext('2d');
      gpctx.fillStyle = 'white';
      gpctx.fillRect(0, 0, gapW, gapH);
      gpctx.fillStyle = `rgba(0,0,0,${alpha})`;
      for (let x = offset; x < gapW; x += period) {
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
    // base option values (phosphorCoupling, beam spread,
    // bloom threshold, composite geometry, opaque background flag),
    // and the convergence base offsets. Called once at the end of
    // _initGpu, saving ~30 CPU→GPU command-buffer writes per frame.
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
      gl.uniform2f(this._uPhosphor.cellSize, this.opts.cellSize, this.opts.cellSize);
      gl.uniform1f(this._uPhosphor.phosphorCoupling, this.opts.phosphorCoupling ?? 0.35);
      gl.uniform1f(this._uPhosphor.beamSpreadPx,         this.opts.beamSpreadPx);
      gl.uniform1f(this._uPhosphor.beamSpreadVerticalPx, this.opts.beamSpreadVerticalPx);

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
      const gains = this._gradeGains(this.opts.gradeTemperature ?? 0);
      gl.uniform3f(this._uComposite.gradeGains, gains[0], gains[1], gains[2]);
      gl.uniform1f(this._uComposite.gradeSaturation, this.opts.gradeSaturation ?? 1);

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
      if (!gl) return false;  // raced with destroy()

      // Paint signal first (caller's callback fills the 2D canvas).
      // The callback may return false — "nothing new painted" — in
      // which case the GPU keeps sampling the previous signal texture
      // and this frame only advances persistence decay. undefined or
      // truthy (every pre-contract callback) means animated.
      // The callback's third parameter asks for a forced repaint (see
      // needsRepaint below).
      const [vw, vh] = this.opts.viewSize;
      this._signalCtx.clearRect(0, 0, vw, vh);
      // Third argument: "needsRepaint" — true when the GPU-side signal
      // texture is blank (context restore) and a memoizing callback
      // must repaint rather than report "nothing new". The restore
      // frame also forces the upload below regardless of the callback's
      // answer: a consumer that ignores the ask degrades to a defined
      // black frame instead of leaving undefined GPU memory on screen.
      const painted = this.opts.signal(this._signalCtx, timeMs, this._signalStale);
      const forcedUpload = this._signalStale;
      this._signalStale = false;
      const dirty = painted !== false || forcedUpload;

      // Damper wires — stamp the configured horizontal rows onto the
      // signal canvas BEFORE upload, so the wires inherit convergence
      // fringe, persistence, beam spread, and bloom from the rest of
      // the pipeline. damperStrength names the fraction of substrate
      // brightness that REMAINS at the wire row (0 = fully black wire,
      // 1 = invisible).
      if (dirty && this.effects.damperWires &&
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

      // Warmup: brightness ramp + color settle over the first ~1.2 s
      // after start — the tube starts dim, warm-shifted, and under-
      // saturated, then settles into the tuned grade (or neutral when
      // colorGrade is off). The only time-driven modulator in the model.
      const warmupDur = 1200; // ms
      const tWarm = timeMs - (this._warmupStartMs || 0);
      let warmupFactor = 1.0;
      let warmupColorActive = false;
      if (this.effects.warmup && tWarm < warmupDur) {
        warmupColorActive = true;
        const k = Math.max(0, Math.min(1, tWarm / warmupDur));
        warmupFactor = k * k * (3.0 - 2.0 * k); // smoothstep
      }

      this._brightness = warmupFactor;
      this._warmupColorActive = warmupColorActive;

      if (dirty) {
        // Upload the 2D canvas to the signal texture. FLIP_Y accounts
        // for canvas's top-left vs WebGL's bottom-left origin.
        gl.bindTexture(gl.TEXTURE_2D, this._texSignal);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, this._signalCanvas);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      }

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
      // option values (phosphorCoupling, beam spread,
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
      gl.uniform1f(this._uComposite.gapMaskEnabled,   this.effects.gapMask        ? 1 : 0);
      gl.uniform1f(this._uComposite.bloomEnabled,     this.effects.selectiveBloom ? 1 : 0);
      gl.uniform1f(this._uComposite.scanlineEnabled,  this.effects.scanlines      ? 1 : 0);
      gl.uniform1f(this._uComposite.brightness,       this._brightness ?? 1.0);
      gl.uniform1f(this._uComposite.gradeEnabled,
        (this.effects.colorGrade || this._warmupColorActive) ? 1 : 0);
      if (this._warmupColorActive) {
        // Ramp-time grade modulation: extra warmth and undersaturation
        // that decay to the tuned base as warmupFactor → 1. Uploaded
        // only during the ramp, plus one restore frame at its end.
        const baseT = this.effects.colorGrade ? (this.opts.gradeTemperature ?? 0) : 0;
        const baseS = this.effects.colorGrade ? (this.opts.gradeSaturation ?? 1) : 1;
        const g = this._gradeGains(baseT + 0.5 * (1 - this._brightness));
        gl.uniform3f(this._uComposite.gradeGains, g[0], g[1], g[2]);
        gl.uniform1f(this._uComposite.gradeSaturation, baseS * (0.85 + 0.15 * this._brightness));
        this._gradeNeedsRestore = true;
      } else if (this._gradeNeedsRestore) {
        const g = this._gradeGains(this.opts.gradeTemperature ?? 0);
        gl.uniform3f(this._uComposite.gradeGains, g[0], g[1], g[2]);
        gl.uniform1f(this._uComposite.gradeSaturation, this.opts.gradeSaturation ?? 1);
        this._gradeNeedsRestore = false;
      }

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

      return dirty;
    }

    start() {
      this._wasStartedByUser = true;
      if (this._rafHandle != null) return;
      // Zero the persistence trail so a stop/restart (e.g. theme toggle)
      // doesn't leave the last session's frame ghosted into this one.
      // clearBufferfv is also correct for normalized RGBA8 attachments.
      // Guarded on _gl because destroy() nulls it.
      if (this._gl) {
        const gl = this._gl;
        const zeros = new Float32Array([0, 0, 0, 0]);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboPhosphorWithA);
        gl.clearBufferfv(gl.COLOR, 0, zeros);
        gl.clearBufferfv(gl.COLOR, 1, zeros);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboPhosphorWithB);
        gl.clearBufferfv(gl.COLOR, 0, zeros);
        gl.clearBufferfv(gl.COLOR, 1, zeros);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
      this._warmupStartMs = 0;  // warmup begins at timeMs = 0 since startTime
      this._startTime = performance.now();
      this._lastRenderT = null;
      this._resumeLoop();
    }

    stop() {
      this._wasStartedByUser = false;
      this._mode = 'stopped';
      if (this._rafHandle != null) {
        cancelAnimationFrame(this._rafHandle);
        this._rafHandle = null;
      }
    }

    // Cancel the frame loop WITHOUT touching user intent — used by the
    // visibility observer and reduced-motion handler, so a renderer
    // hidden by scroll or RM resumes when conditions allow.
    _haltLoop() {
      if (this._rafHandle != null) {
        cancelAnimationFrame(this._rafHandle);
        this._rafHandle = null;
      }
      if (this._mode !== 'idle') this._mode = 'stopped';
    }

    // Settle tail: how long to keep rendering after the signal goes
    // static so persistence trails decay below one 8-bit LSB.
    // log2(255) ≈ 7.994 half-lives; zero when persistence is off.
    _settleTailMs() {
      if (!this.effects.persistence) return 0;
      return (this.opts.persistenceHalfLifeMs || 0) * 7.994;
    }

    // (Re)enter the frame loop if user intent, visibility, GPU state,
    // and reduced-motion all allow. Unlike start(), never clears the
    // persistence trail or re-triggers warmup — this is "wake up",
    // not "turn on".
    _resumeLoop() {
      if (this._rafHandle != null) return;
      if (!this._gl || !this._wasStartedByUser || !this._visible) return;
      if (this._reducedMotionMq && this._reducedMotionMq.matches) {
        // Single static frame at t past the warmup ramp (1200 ms) so a
        // warmup-enabled consumer shows the steady-state tube.
        this._renderGpu(Math.max(1200, performance.now() - this._startTime));
        return;
      }
      this._idleAt = performance.now() + this._settleTailMs();
      const tick = (now) => {
        const t = now - this._startTime;
        const dirty = this._renderGpu(t);
        // A fresh signal frame or an active warmup ramp resets the idle
        // deadline; otherwise the deadline set by the last dirty frame
        // stands, and the loop parks itself once trails have settled.
        const warmingUp = this.effects.warmup && t < (this._warmupStartMs || 0) + 1200;
        if (dirty || warmingUp) this._idleAt = now + this._settleTailMs();
        if (warmingUp) {
          // Never park mid-ramp: even with a zero settle tail
          // (persistence off), hold the deadline past warmup's end so
          // the brightness/color settle completes before parking.
          const warmupEndsAt = this._startTime + (this._warmupStartMs || 0) + 1200;
          this._idleAt = Math.max(this._idleAt, warmupEndsAt + this._settleTailMs());
        }
        // stop() may have nulled _rafHandle during the frame work
        // (e.g. theme MutationObserver firing mid-tick). Don't re-queue.
        if (this._rafHandle === null) return;
        if (now >= this._idleAt) {
          this._rafHandle = null;
          this._mode = 'idle';   // parked: zero work until woken
          if (this._debugFps) this._debugFps.textContent = 'fps: idle';
          return;
        }
        this._rafHandle = requestAnimationFrame(tick);
      };
      this._mode = 'running';
      this._rafHandle = requestAnimationFrame(tick);
    }

    // Public poke: wake a parked renderer for at least one frame —
    // param changes on a static picture, channel switches, etc.
    // No-op while the loop is already live (or stopped by the user).
    requestRender() {
      this._resumeLoop();
    }

    _setupVisibilityObserver() {
      if (typeof IntersectionObserver === 'undefined') return;
      // A decorative effect nobody can see should cost nothing: halt
      // offscreen, resume on re-entry (idle/settle logic re-applies).
      this._io = new IntersectionObserver((entries) => {
        this._visible = entries[entries.length - 1].isIntersecting;
        if (this._visible) this._resumeLoop();
        else this._haltLoop();
      });
      this._io.observe(this.canvas);
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
      if (this._io) { this._io.disconnect(); this._io = null; }
      this.canvas.removeEventListener('webglcontextlost', this._onContextLost);
      this.canvas.removeEventListener('webglcontextrestored', this._onContextRestored);
      this._destroyGpu();
    }

    _setupReducedMotionListener() {
      if (!this.opts.respectReducedMotion) return;
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      this._reducedMotionMq = mq;
      this._reducedMotionHandler = () => {
        // Halt/resume without clearing user intent; _resumeLoop's RM
        // branch renders the single static frame on re-entry.
        if (mq.matches) this._haltLoop();
        else this._resumeLoop();
      };
      if (mq.addEventListener) mq.addEventListener('change', this._reducedMotionHandler);
      else if (mq.addListener) mq.addListener(this._reducedMotionHandler);
    }

  }

  // Effect schema — single source of truth for the built-in ?debug=1
  // overlay AND external benches (docs/tv.html). `scope` classifies each
  // effect along the realism axes from the 2026-06-10 spec:
  //   'universal'   — any color CRT
  //   'trinitron'   — aperture-grille-specific (this tube)
  // Params inherit their item's scope unless tagged themselves.
  // Tube-determined options are pinned via defaults, not offered here
  // (curvatureMode: cylindrical — verticals stay straight).
  Trinitron.effectSchema = [
    { title: 'phosphor',
      items: [
        { key: 'stripeProfile',    label: 'stripe profile', scope: 'universal',
          desc: 'RGB aperture-grille subpixel decomposition. Off = raw signal, no triad mask.' },
        { key: 'phosphorCoupling', label: 'phosphor coupling', scope: 'universal',
          desc: 'Each lit column also emits the other two channels. Brightens pure colors.',
          params: [{ opt: 'phosphorCoupling', min: 0, max: 1, step: 0.05, sub: 'strength' }] },
        { key: 'convergence',      label: 'convergence', scope: 'universal',
          desc: 'Horizontal R/B gun offset. Inline cathodes misconverge along X only — edges fringe left/right.',
          params: [{ opt: '__convergenceSpread', min: 0, max: 1, step: 0.05, sub: 'spread (x px)' }] },
        { key: 'persistence',      label: 'persistence', scope: 'universal',
          desc: 'Phosphor afterglow. Half-life of the previous frame\'s contribution, in ms — frame-rate independent.',
          params: [{ opt: 'persistenceHalfLifeMs', min: 0, max: 500, step: 5, sub: 'half-life (ms)' }] },
        { key: 'beamSpread',       label: 'beam spread', scope: 'universal',
          desc: 'Gaussian PSF blur on signal. V > H is the Trinitron split: the grille quantizes X, the beam owns Y.',
          params: [
            { opt: 'beamSpreadPx',         min: 0, max: 3, step: 0.1, sub: 'h (px)' },
            { opt: 'beamSpreadVerticalPx', min: 0, max: 3, step: 0.1, sub: 'v (px)', scope: 'trinitron' },
          ] },
        { key: 'damperWires',      label: 'damper wires', scope: 'trinitron',
          desc: 'Two horizontal stabilizer strands across the aperture grille. The Trinitron signature.',
          params: [{ opt: '__damperDarkness', min: 0, max: 1, step: 0.05, sub: 'darkness' }] },
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
        { key: 'gapMask',        label: 'gap mask', scope: 'trinitron',
          desc: 'Dark vertical lines between stripes — the aperture-grille shadow. Texture-baked; alpha fixed at init.' },
        { key: 'scanlines',      label: 'horizontal scanlines', scope: 'universal',
          desc: 'Periodic dim/bright bands along Y — the beam paints rows with gaps between.',
          params: [
            { opt: 'scanlineDepth',  min: 0, max: 1,  step: 0.02, sub: 'depth' },
            { opt: 'scanlinePeriod', min: 1, max: 10, step: 0.5,  sub: 'period (px)' },
          ] },
        { key: 'colorGrade', label: 'color grade', scope: 'universal',
          desc: 'The tube\'s color character — warm white point + saturation lift on emitted light. Warmup settles into it.',
          params: [
            { opt: 'gradeTemperature', min: -1, max: 1, step: 0.05, sub: 'temperature' },
            { opt: 'gradeSaturation',  min: 0,  max: 2, step: 0.02, sub: 'saturation' },
          ] },
      ] },
    { title: 'glass',
      items: [
        { key: 'curvature', label: 'curvature', scope: 'universal',
          desc: 'Cylindrical face curvature — verticals stay straight, horizontals bow (the Trinitron patent geometry).',
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

  window.Trinitron = Trinitron;
})();
