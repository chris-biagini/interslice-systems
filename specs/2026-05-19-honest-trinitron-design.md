# Honest Trinitron — Design Spec

**Date:** 2026-05-19
**Status:** Draft, awaiting review
**Scope:** Upgrade the dark-mode logo in `docs/index.html` from "stripe-mask cheats over un-quantized vector source" to "honest per-cell phosphor sampling," with a curated set of CRT-fidelity details on top.

---

## 1. Context

The current dark-mode logo renders a Trinitron-style CRT inside the logo silhouette. The implementation paints a vibrant solid base of the colored phosphor, then layers three R/G/B stripe masks on top (`docs/index.html:942-959`). The masks land on every Nth physical column, but the underlying color *signal* is vector geometry with no sampling structure — so when an output stripe-column crosses a vector color edge, that single stripe lights up bright on one side and dark on the other mid-stripe. A real Trinitron stripe is unitary at any moment.

This spec replaces that with an honest per-cell renderer and adds depth that rewards close inspection — a "tech demo" treatment in service of a portfolio piece. Treatment is gated behind JavaScript; the no-JS path keeps the current SVG implementation as graceful fallback.

## 2. Goal

The logo should reward inspection at **every** distance:

| Inspection depth | What's discoverable |
|---|---|
| Casual glance | Glowing Trinitron logo with colored halo |
| Arm's length | RGB stripes; damping wires with diffraction halos |
| Stop & stare | Slow brightness band sweeping top-to-bottom across screen and halo |
| Browser zoom 200%+ | Per-cell beam hot-spots; stripe-end shimmer; RGB beams not quite converged |
| Pause animation | Phosphor decay trail behind the rotating hub; halo color matches the cell-color it's leaking from |
| Watch the trail closely | Green decays fastest; blue lingers longest (P22 phosphor authenticity) |

Plus the *physical fiction*: the logo is shown on a rectangular Trinitron tube *behind* a slightly-translucent page-background overlay. The overlay has a logo-shaped cutout. Light from the lit cells leaks through the overlay near the cutout perimeter — so each halo point's color is determined by the actual cell-behind, not a generic glow.

## 3. Architecture

### 3.1 The "physical fiction"

```
   ┌─────────────────────────────────────────┐
   │ page background overlay (rectangular)   │
   │ ┌──────────────┐                        │
   │ │              │     cutout shaped      │
   │ │   (cutout    │     like the logo;     │
   │ │    shows     │     overlay around     │
   │ │   tube)      │     the cutout is      │
   │ │              │     slightly trans-    │
   │ └──────────────┘     lucent for the     │
   │                       first ~30px        │
   └─────────────────────────────────────────┘
                  ↑
   ┌─────────────────────────────────────────┐
   │ Trinitron tube (rectangular phosphor    │
   │ array, but only the cells inside the    │
   │ logo silhouette are lit — the rest is   │
   │ unlit phosphor / black)                 │
   └─────────────────────────────────────────┘
```

Inside the cutout: full Trinitron screen surface (stripes, scanlines, wires, glass).
Outside the cutout but within the bleed radius: light leaking through translucent overlay, color and brightness derived from the cell directly behind that point.
Outside the bleed radius: nothing — the overlay is opaque.

### 3.2 Module split

**`docs/trinitron.js`** — new file, the project's first JS. ~200-250 lines, no dependencies. Exports one class:

```js
export class Trinitron {
  constructor(canvasElement, options) { ... }
  start() { ... }
  stop() { ... }
}
```

The renderer knows nothing about the Interslice logo. It takes a `signal` callback that paints the current source onto an offscreen canvas, and an optional `silhouettePath` for the cutout shape. Anyone with a rasterizable source can use it.

**`docs/index.html`** — adds:
- One `<canvas class="trinitron">` element next to `<svg class="mark">` inside `.stack`.
- One small inline `<script type="module">` (~30-50 lines) that:
  - Pre-rasterizes the SVG arms and hub once on load (Image elements via blob URLs).
  - Constructs a `Trinitron` instance, providing a signal callback that composes the two images with the current rotation angle.
  - Calls `trinitron.start()`.
  - Toggles the `.trinitron-active` class on `<html>` on success (or never if init fails).
- Inline CSS rules:
  - `.trinitron` canvas positioned absolutely over the logo area, sized larger than the silhouette for bleed room.
  - Light-mode and OS-light-preference hide the canvas.
  - When `.trinitron-active`, hide the SVG's `.bleed` group and `.phosphors` group.

**`docs/tokens.css`** — untouched. No new tokens needed; the phosphor palette already lives in the SVG paths.

### 3.3 DOM/CSS layering (dark mode, JS active)

```
.stack
├── <canvas class="trinitron">      z-index: 1; ~240×240 logical
│   └── (drawn by JS: phosphor + bleed)
└── <svg class="mark">              z-index: 2; transparent where not painted
    └── m-dark layer
        ├── .bleed (SVG)            display: none  (canvas does this now)
        ├── masked screen group:
        │   ├── .phosphors (SVG)    display: none  (canvas does this now)
        │   ├── .hotspots (SVG)     visible — beam-center washes
        │   ├── scanlines pattern   visible — overlays canvas
        │   ├── damping wires       visible (+ S3 halo additions)
        │   └── glass gloss         visible
```

The SVG's screen-surface artifacts (scanlines, wires, glass, beam hot-spots) overlay the canvas's phosphor work. The canvas's halo extends past the silhouette into pixels where the SVG paints nothing, so the halo is visible.

## 4. Renderer API

```js
new Trinitron(canvasElement, {
  // Geometry
  viewSize: [200, 200],         // logical SVG-unit dimensions of the source signal that `signal()` paints
  canvasSize: [240, 240],       // logical SVG-unit dimensions of the canvas (= viewSize + 2*bleedRadius rounded)
                                // The source signal region is centered inside the canvas; bleedRadius units of
                                // canvas margin on each side host the halo. Cells outside the source region
                                // are zero-padded (= unlit phosphors behind the opaque overlay).
  cellSize: 3,                  // SVG units per RGB triad cell. Source signal sampled to a viewSize/cellSize
                                // grid (67×67 for default values).

  // Bleed (N1)
  bleedRadius: 30,              // SVG units; halo decays to zero by this distance
  bleedFalloff: 'physical',     // 'physical' = inverse-square-ish, with finite zero at bleedRadius
  silhouettePath: 'M…',         // SVG path string; bleed is clipped to silhouette + bleedRadius

  // Scan & persistence (F2, N2, N3)
  scanBandPeriodSec: 7,         // top-to-bottom sweep duration
  scanBandStrength: 0.08,       // ±brightness amplitude of the scan band
  persistence: 0.85,            // per-frame retention (0=none, 1=infinite)
  perChannelDecay: {            // P22 phosphor decay (multiplies persistence per channel; result clamped to <0.99)
    r: 1.00,                    // medium decay  → effective retention 0.85
    g: 0.94,                    // fastest decay → effective retention 0.80
    b: 1.04,                    // slowest decay → effective retention 0.88 (clamped from 0.884)
  },

  // Convergence drift (F3)
  convergence: {
    r: [-0.15, -0.15],          // sub-px offset of the R channel
    g: [ 0.00,  0.00],
    b: [+0.15, +0.15],
  },
  convergenceDriftAmplitudePx: 0.30,
  convergenceDriftPeriodSec: 60,

  // Per-cell details (F4, S2)
  hotspot: 0.15,                // per-cell center brightness boost
  shimmer: 0.04,                // ±brightness noise amplitude (stable, not animated)
  shimmerSeed: 1983,            // for deterministic shimmer pattern

  // Signal — caller paints current source onto offscreenCtx
  signal: (offscreenCtx, timeMs) => {
    // page-specific: arms + rotated hub
  },

  // Accessibility
  respectReducedMotion: true,   // default true; if reduced motion, render one static frame and stop
})
```

`start()` begins a `requestAnimationFrame` loop. `stop()` cancels it and freezes the canvas on its last frame. The renderer listens for `prefers-reduced-motion` changes and automatically pauses/resumes.

## 5. Per-frame signal flow

Per `requestAnimationFrame`:

1. **Signal capture** — Caller's `signal(offscreenCtx, t)` paints the current source onto a `viewSize`-sized offscreen canvas (coordinate system: `0,0` at the signal region's top-left, `viewSize` at bottom-right; `signal()` does not need to know about the bleed margin). For Interslice: arms drawn once; hub drawn with `rotate(t * (360/36000))` around `(100, 100)`.
2. **Cell sampling** — Downsample the signal canvas to a `cellSize`-grid working canvas (67×67 for `200/3`). `imageSmoothingEnabled = false` → nearest-neighbor → honest sampling at cell centers.
3. **Cell post-processing** — For each cell, apply: hotspot (+brightness at center), shimmer (stable per-cell noise), scan-band modulation (`cos(2π * (cy/cellH - t/scanBandPeriodSec))` scaled by `scanBandStrength`).
4. **Persistence blend** — Sample the previous frame's main canvas (at full resolution) and blend with this frame's freshly-computed cell grid, per-channel: `new[c] = max(this_frame[c], prev[c] * persistence * perChannelDecay[c])`.
5. **Stripe rendering** — Allocate output `ImageData`. For each cell `(cx, cy)` and each output cell-row `(0..cellSize-1)`:
   - Column `0`: R intensity from cell, with R-convergence offset → write to R channel
   - Column `1`: G intensity from cell, with G-convergence offset → write to G channel
   - Column `2`: B intensity from cell, with B-convergence offset → write to B channel
   - Apply scanline dim to rows that are dim-rows in the cell-row pattern.
6. **Bleed rendering** — Take the cell grid (pre-stripe, post-persistence), enlarge to canvas-cell-grid dimensions (`canvasSize / cellSize`, e.g. 80×80) with zero-padding outside the source region, gaussian-blur with kernel-radius scaled by `bleedRadius`, paint onto canvas *outside* the silhouette path. Clip to `silhouette + bleedRadius` so the bleed has finite extent. Per-channel additive (the cool R+G=Y effect at petal boundaries is preserved by blurring R/G/B independently then summing via canvas `globalCompositeOperation = 'lighter'`).
7. **Composite** — `putImageData` the stripe output to the main canvas, replacing the inside-silhouette area; bleed remains outside.

## 6. Feature details

### F1 — Honest per-cell sampling
Step 2 of signal flow. `cellSize: 3`, nearest-neighbor downsample to a 67×67 working grid. Each cell becomes one RGB triad; mid-cell color transitions snap to cell boundaries. **This is the fix for the cheat.**

### F2 — Phosphor persistence
Step 4 of signal flow. Per-frame retention 0.85, modified per-channel by N3 decay rates. New frame "wins" if its channel intensity exceeds the decayed previous; otherwise the decay shows through. Result: visible phosphor trail behind rotating hub edges, more pronounced when animation is paused.

### F3 — RGB convergence drift
Step 5 of signal flow. Static base offsets per channel (±0.15px). Additional slow sine drift at ±0.30px over 60s period. Manifest as fringing: rotating petal edges show a hair of red on one side, blue on the other.

### F4 — Per-cell beam-dwell hotspot
Step 3 of signal flow. Each cell gets a +15% brightness boost at its center pixel relative to its corners. Implementation: brightness multiplier baked into the stripe-render lookup based on row/column position within the cell.

### S2 — Stripe-end shimmer
Step 3 of signal flow. Each cell has a stable ±4% brightness offset derived from a deterministic noise function (cell-index seeded). Not animated — the noise pattern is fixed; same cells stay slightly hotter/colder forever. Visible at zoom.

### S3 — Damping-wire diffraction halos
SVG-only enhancement to existing wires at `docs/index.html:984-985`. Each wire becomes a small group:
- Outer faint cyan glow: `stroke-width="3", stroke="#5EE2FF", opacity="0.18"`
- Existing dim wire line (unchanged): `stroke-width="1", stroke="#000000", opacity="0.62"`
- Inner bright white line: `stroke-width="0.4", stroke="#FFFFFF", opacity="0.5"`
Stacked back-to-front in that order. No JS involvement.

### N1 — Translucent-overlay light-leak halo
Step 6 of signal flow. Replaces the current SVG `phosphor-bleed` filter (which has an infinite Gaussian tail). Properties:
- **Color-accurate per point**: at any halo pixel, its color = the cell-behind-it's color, blurred. The blur kernel ensures cells near the silhouette boundary contribute most strongly; cells far inside contribute via blur tail.
- **Finite extent**: clipped to `silhouette + bleedRadius` (default 30 SVG units ≈ 25 device px at 168 logical px display). Hard cutoff, not Gaussian fade — implements the "overlay opacity goes to 100% past 30px" fiction.
- **Per-channel additive**: R, G, B blurred independently then composited with `globalCompositeOperation = 'lighter'`. Preserves the R+G=Y arithmetic at petal boundaries.
- **Falloff curve**: `intensity = max(0, 1 - (d/bleedRadius)²)` — inverse-square-ish, ramps smoothly to zero.

### N2 — Slow scan-band brightness modulation
Step 3 of signal flow. A cosine envelope sweeps top-to-bottom every `scanBandPeriodSec` (default 7s). Each cell's brightness is multiplied by `1 + scanBandStrength * cos(2π * (cy / gridHeight - t / scanBandPeriodSec))`. The band is visible both inside the screen (cells brighten/dim) and in the halo (because the halo color comes from the cell, the modulation rides along).

The band does **not** rotate the hub — only brightness, not phase. The hub's rotation stays coherent.

### N3 — P22 per-channel persistence
Modifies F2. Standard P22 CRT phosphor coating has G fastest decay, R medium, B slowest. Encoded as per-channel multipliers on the persistence retention: `r: 1.00, g: 0.94, b: 1.04` (B is then clamped to keep total ≤ 0.99 to avoid runaway). Effect: rotating hub's trailing edge has a hair of blue ghost; leading edge has a hair of red shadow.

## 7. Performance budget

- **Target**: <2ms/frame on a 2020 MacBook Air at DPR=2, with 336×336 working area and 67×67 cell grid.
- **Hot path**: per-frame `ImageData` build is ~36k pixel writes (67×67 cells × 9 pixels per cell). Bleed is a separate `ImageData` of similar scale, blurred. Both well under 1ms in modern V8.
- **Allocation discipline**: working canvases and `ImageData` buffers allocated once at init; reused each frame.
- **Tab-hidden**: `requestAnimationFrame` doesn't fire when tab is hidden — automatic pause.

## 8. Accessibility & fallbacks

- **`prefers-reduced-motion: reduce`**: renderer runs one frame at `t=0` (no scan-band motion, no persistence buildup, hub at start rotation) and stops. A media-query listener handles toggle without reload.
- **No JS / JS errors / canvas unsupported**: page falls back to existing SVG dark-mode Trinitron. The `.trinitron-active` class is only added on successful `Trinitron.start()`, so failure is silently graceful.
- **`<canvas>` element**: `aria-hidden="true"`. The SVG already carries `role="img"` and `aria-label="Interslice mark"` for assistive tech.
- **Theme toggle / OS preference**: the renderer respects the same triple-activation paths (explicit `data-theme`, OS preference, light-pin). When light mode is active, the canvas is hidden by CSS and `Trinitron.stop()` is called via a `prefers-color-scheme` listener.
- **DPR**: canvas backing-store is `canvasSize * devicePixelRatio`, CSS size is `canvasSize`. Crisp on HiDPI.

## 9. Out of scope

- S1 (edge vignette) and G1 (cylindrical curvature) — dropped after the "screen-behind-cutout" reframe; the screen surface is mostly hidden under the overlay.
- M1 (NTSC 30Hz flicker) — too subtle at our scale.
- Easter eggs — power-on warm-up, click-to-degauss, hover-pause-rotation: all add scope and interaction that pulls focus from the CTA.
- Light-mode changes — light is print, not a CRT. Untouched.
- Theme-toggle UI — preserved as-is.
- Touching `tokens.css`.

## 10. Risks & known unknowns

- **Browser variance in `imageSmoothingEnabled = false`**: nearest-neighbor behavior is well-supported but some browsers may still do partial smoothing. Verify in Chrome, Firefox, Safari.
- **`ctx.getImageData` performance on cross-origin / tainted canvas**: not an issue since all source images are same-origin (blob URLs from inline SVG).
- **Mobile GPU rasterization of frequent `putImageData`**: should be fine at our size; if perf is poor on low-end Android, reduce DPR clamp or skip persistence on `connection.saveData`.
- **Moiré with device pixels at certain zoom levels**: this is *authentic*. We don't try to fight it.
- **SVG rasterization of the source**: the arms and hub need to be serialized to a blob URL and loaded into `Image` elements before the renderer can start. This is async and adds a small first-paint delay. Mitigation: while waiting, the SVG fallback is visible (it's already rendered); when canvas is ready, the swap is instant.
- **Future use of `<foreignObject>` in the mark SVG** to embed the canvas — investigated but rejected; foreignObject inside SVG has fiddly cross-browser behavior. Side-by-side DOM siblings with z-index is simpler.

## 11. Verification

This is visual work in a no-tests repo. Verification is by-eye, in this order:

1. **Static check**: load page, dark mode. Logo appears with halo. No console errors.
2. **Stripe honesty**: zoom browser to 400%+ and inspect a yellow→green segment edge in the hub. Color transitions should snap to cell boundaries, not happen mid-stripe.
3. **Persistence**: pause animation via DevTools (or set `animation-play-state: paused` on `.hub-segs`). Observe phosphor trail behind hub edges. Trail should fade within ~5 frames.
4. **Convergence drift**: zoom to 400%+. Inspect arm edges. Red should fringe one side, blue the other. Watch for ~60s — the fringing should slowly shift.
5. **Per-cell hotspot**: zoom to 800%+. Each cell should show a slightly brighter center pixel.
6. **Stripe shimmer**: zoom to 800%+. Cells should have visible brightness variation; pattern should be stable across reloads (deterministic seed).
7. **Damping wire halos**: zoom to 200%+. Wires should have a faint cyan halo and a brighter inner core.
8. **Bleed**: inspect halo near red lobe — should be red-tinted. Near blue lobe — blue. Inspect halo around rotating hub center — should cycle colors as the petals turn underneath.
9. **Scan band**: watch for 5-10s. A faint horizontal brightness band should sweep top-to-bottom. The band should be visible *both* inside the screen and in the surrounding halo.
10. **Per-channel decay**: pause animation again; watch hub trail closely. Green should fade fastest, blue slowest.
11. **Reduced motion**: toggle OS-level reduced motion. Canvas should freeze on a static frame; no scan band, no persistence buildup.
12. **No-JS fallback**: disable JS in DevTools, reload. Should see current SVG-based dark-mode Trinitron (cheat and all). No errors.
13. **Light mode**: toggle to light. Canvas hidden; print-aesthetic logo as-is.
14. **OS-preference path**: clear `data-theme`, toggle OS dark/light. Canvas comes and goes appropriately.
15. **Tab inactive**: switch tabs for 30s, return. Animation should pick up without glitches.

## 12. Implementation order suggestion

Not prescriptive — the plan will refine — but the natural order:

1. Skeleton: new file, canvas element, gated class toggle, no-op renderer that proves the integration. Verify fallback still works.
2. F1: per-cell sampling + stripe render at full brightness. Verify mid-stripe cheat is gone.
3. N1: bleed with finite extent and additive per-channel. Replace SVG bleed.
4. F2 + N3: persistence with per-channel decay.
5. F3: convergence drift.
6. F4 + S2: per-cell hotspot and shimmer.
7. N2: scan-band modulation.
8. S3: SVG-only damping-wire halo enhancement.
9. Accessibility & fallback polish.
10. Cross-browser pass.
