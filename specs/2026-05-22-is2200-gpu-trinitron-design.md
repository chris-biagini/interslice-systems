# IS-2200 GPU Trinitron Renderer — Design

**Date:** 2026-05-22
**Status:** Approved design, ready for implementation planning
**Scope:** GPU rendering path for the IS-2200 sneak-preview screen on `docs/index.html`

## Overview

The interslice-systems homepage features an "IS-2200 Recipe Router" sneak-preview widget — currently rendered by the CPU Trinitron simulation in `docs/trinitron.js`. This spec describes:

1. Promoting the widget from a corner sneak-card (~324×193 CSS px) to a hero feature (~640×480 CSS px).
2. Replacing its CPU rendering with a WebGL2 pipeline that delivers locked 120 Hz at the larger size, with room for new effects.
3. Adding a per-effect runtime toggle system and a user-facing master A/B toggle exposed as an easter-egg power-button sticker.

The IS-2200 is positioned as a **tech demo / portfolio bonus** within the page's broader marketing function. The primary brand statement (logo hero + "visit mirepoix.recipes" CTA) is preserved; the IS-2200 follows it on the page as a flex of what Interslice Systems can ostensibly ship.

**In-universe framing:** the Trinitron PVM is Interslice's shipping product. The IS-2200 Recipe Router displayed on it is a not-yet-real product whose interface is being previewed. The yellow "↳ sneak preview" tape applies to the content (the BIOS screen), not the monitor.

## Goals

- **Visual fidelity:** an inspired-by Sony PVM-20L aperture-grille CRT, idealized through affectionate exaggeration rather than metrology.
- **Resolution:** 640×480 simulated phosphor cells (canonical VGA). 80-column text rendering at VT323 20px. Graphics-mode demonstrability.
- **Performance:** locked 120 Hz on modern hardware. Significant headroom for additional effects.
- **Toggleability:** every effect individually controllable at runtime via `__trinitron.effects`. Master A/B bypasses the GPU pipeline entirely.
- **Discoverability of toggle:** the master A/B is an easter-egg power-button sticker on the Memphis frame.

## Non-goals

- Faithful PVM-20L metrology (specific phosphor color temperature, exact scanline density, real damper-wire positions).
- Modeling plastic bezel or PVM brand chrome ("PROFESSIONAL VIDEO MONITOR" badge, BNC port glyphs, etc.).
- GPU port of the dark-mode logo's rotating-arms Trinitron — stays on the CPU renderer.
- Damper wires on text-mode rendering. Possible future re-enable for graphics-mode demos.
- Static/noise effects (horizontal noise band, sync glitch). Possible future easter egg.

## Reference and aesthetic posture

Reference: **Sony PVM-20L** (late 1990s broadcast professional monitor). The PVM's broadcast/industrial vibe matches the fictional "Nordyne Defense Dynamics" brand identity better than a desktop workstation or a consumer CRT. The aperture-grille Trinitron tube is the canonical "real CRT" — every effect downstream of "the grille is RGB stripes" earns its place.

Posture: **inspired-by with creative license.** Not reference fidelity (boring; CSS can't tell). Not maximum bodaciousness (overdoes the bloom, kills text readability). Aim for "an idealized 1990s pro CRT viewed through affectionate exaggeration of memory."

## Resolution and scaling

| Quantity | Value | Notes |
|---|---|---|
| Simulated phosphor cells | 640 × 480 | Canonical VGA. Mode 03h text + Mode 12h graphics both target this. |
| Stripe layout | cs=2 | R at column 0, G at column 1, B via phosphor coupling only. **This matches the current IS-2200 visual identity**, which is tuned around the absence of a primary-lit B column — its palette leans amber/green/cyan/magenta because pure blue would dim under this layout. Preserve the behavior in GLSL; do not "fix" it. |
| Source canvas (signal painted into) | 1280 × 960 source px | `viewSize` = phosphor cells × cellSize. |
| CSS display size | 640 × 480 CSS px | 1:1 with simulated screen at logical-CSS level. |
| Device pixels at 2× DPR | 1280 × 960 | Exactly 2 device px per phosphor cell. Clean cs=2 stripe rendering, no fractional sampling blur. |
| Total widget footprint (tight) | ~660 × 540 CSS px | Memphis frame (3 px border + 7 px cyan offset shadow) + 1.5° rotation bounding-box growth + tape margin above. |
| Total visual footprint (with halo spill) | ~740 × 620 CSS px | Halo bleed spreads ~40 px beyond the tight footprint. Plan layout grid accordingly. |

## Page layout

The IS-2200 hero replaces the current corner `<aside class="sneak">`. New structure:

```
<main class="page">
  ... sprinkles ...
  <header class="top">          // tagline unchanged
  <section class="hero">        // existing logo hero + CTA — unchanged
  <section class="is2200-hero"> // NEW — the IS-2200 demo
  <footer class="foot">         // unchanged
</main>
```

The IS-2200 hero is centered within the existing `.page` grid row that previously held `.sneak-row`. Sprinkles whose positions were tuned to the corner sneak-card (`sp-tri-2` is explicitly called out as such in `docs/index.html`) will need adjustment.

## Memphis framing

The screen is wrapped in the existing Memphis card primitive:

- 3 px solid border in `var(--ink-0)`.
- 7 px cyan offset shadow: `box-shadow: 7px 7px 0 0 var(--ink-cyan), 7px 7px 0 3px var(--stamp-ink)`.
- Yellow `↳ sneak preview` tape positioned `top: -16px; left: 50%; transform: translateX(-50%) rotate(-2deg)`. Wording preserved — the tape is on the content, not the hardware.
- Overall 1.5° rotation applied to the containing element. Free at compositor level.

The bleed halo from the GPU rendering is permitted to spill past the screen edge onto the Memphis card border — authentic to CRT phosphor bloom and visually integrates the CRT with the page.

## Effect taxonomy

### Kept from current renderer

| Effect | Notes |
|---|---|
| Aperture-grille stripe profile | cs=2; R at column 0, G at column 1, B via coupling. |
| Phosphor coupling | 0.35. Saturated colors get their brightness without disturbing gap columns. |
| Convergence (sub-pixel offsets) | Expanded from 0.15 → 0.25 px for hero scale (larger screen, chromatic fringe needs more spread to read). |
| Persistence | Per-pixel exponential decay, coefficient 0.55 (IS-2200's current value). |
| Per-cell hotspot | Manhattan-distance brightness boost at cell center. Memory-locked feature. |
| Per-cell shimmer | Stable noise per cell. Memory-locked feature. |
| Per-row shimmer | Line-to-line beam-current variation. |
| Beam spread | Pre-stripe Gaussian on the signal. |
| Bleed halo | Now spills onto the Memphis frame. |
| Gap mask | Post-composite vertical lines. Memory-locked: striations extend into the halo. |
| Phosphor blur | Final softening. |

### Cut

| Effect | Reason |
|---|---|
| Damper wires | Already disabled on the mcrt; would slice across 80-col text. Possible future re-enable for graphics-mode demos. |

### Added (high confidence)

| Effect | Implementation |
|---|---|
| Glass curvature | Slight barrel distortion via warped UV in composite pass. ~2-3% cushion at corners. |
| Glass surface gloss | Soft elliptical highlight from virtual upper-left light source. Pre-baked static texture, multiplied into composite. |
| Edge vignette | Corner darkening, ~10-15% at corners. Pre-baked static texture. |
| Selective bloom | Bright pixels bloom more than dim. Threshold → horizontal Gaussian → vertical Gaussian on half-res buffer, additive composite. |

### Added (slow-dynamic modulators)

| Effect | Implementation |
|---|---|
| Power-on warmup | 1-second fade from cold black to full brightness on first load and on every master-A/B "on" transition. Time-since-warmup-start curve as a uniform. |
| Slow convergence drift | Convergence offsets modulate via slow LFO (~0.1 Hz, ±0.05 px amplitude). Real CRT temperature drift. |
| Phosphor temperature breathing | ~0.3 Hz brightness/saturation modulation, ~2% amplitude. Subtle "the tube is alive." |

## GPU pipeline architecture

### Pass structure

| # | Pass | Estimated cost | Notes |
|---|---|---|---|
| 1 | **Signal upload** | ~50 µs | Caller paints into a 2D canvas via `ctx.fillText` etc. Uploaded as `tex_signal` via `texSubImage2D`. |
| 2 | **Phosphor** | ~0.3 ms | Inputs: `tex_signal`, `tex_persistence_prev`. Outputs: `tex_phosphor` + `tex_persistence_curr` via MRT. Does stripe profile, persistence lerp, per-channel convergence sampling (sub-pixel UV — GPU bilinear handles chromatic fringe), per-cell hotspot + shimmer, per-row shimmer, beam spread. |
| 3a | **Bloom threshold** | ~0.1 ms | Bright-pixel extraction → half-res buffer. |
| 3b | **Bloom Gaussian H** | ~0.15 ms | Separable blur at half-res. |
| 3c | **Bloom Gaussian V** | ~0.15 ms | Completes bloom. |
| 4 | **Composite** | ~0.3 ms | Inputs: `tex_phosphor`, bloom result, static glass textures (gloss, vignette, curvature LUT, gap mask). Outputs: visible canvas. Does curvature warp, gloss multiply, vignette multiply, gap mask multiply, additive bloom. |

Total estimated frame time: 0.5–1.5 ms on modern hardware. 120 Hz budget is 8.33 ms — substantial headroom.

### Resource budget

- **Persistence ping-pong:** 2 × RGBA32F at 1280×960 ≈ 20 MB.
- **Bloom intermediates:** 3 × RGBA8 at 640×480 ≈ 3.7 MB.
- **Static textures:** gloss + vignette + gap mask + curvature LUT — a few MB combined.
- **Signal canvas:** 2D canvas at 1280×960 stays on the JS heap; uploaded each frame.

### Why WebGL2

- **WebGL1:** lacks MRT in core (extension required), float textures need extension dance. Adds friction.
- **WebGL2:** MRT and float textures core. Universal modern-browser support (Chrome, Safari, Firefox).
- **WebGPU:** better long-term but support uneven (Safari recent, Firefox Nightly). Doesn't unlock anything we need.

WebGL2 is the sweet spot.

## Toggle system

### Per-effect runtime toggles

```js
window.__trinitron.effects = {
  // Phosphor pass
  stripeProfile: true,
  phosphorCoupling: true,
  convergence: true,
  convergenceDrift: true,
  persistence: true,
  perCellHotspot: true,
  perCellShimmer: true,
  perRowShimmer: true,
  beamSpread: true,

  // Composite pass
  bleed: true,
  selectiveBloom: true,
  gapMask: true,
  phosphorBlur: true,

  // Glass
  curvature: true,
  gloss: true,
  vignette: true,

  // Slow modulators
  warmup: true,
  breathing: true,
};
```

Setters take effect on the next frame. Two implementations:

- **Uniform-multiply** for within-pass effects: `finalColor += uEffectEnabled * contribution`. Free on modern GPUs (FMA, single cycle).
- **CPU pass-skipping** for whole-pass effects (bleed, selective bloom, persistence ping-pong): JS skips the draw calls. Real savings when off.

### Optional `?debug=1` overlay

Floating panel with one checkbox per effect plus an FPS readout. Default off in production; appears only when URL has `?debug=1`. Implementation: single `<div>` overlay built at construction time, hidden unless the URL flag is present.

### Master A/B toggle

Separate path from per-effect toggles. Bypasses the GPU pipeline entirely:

- **"On" (default):** GPU pipeline runs.
- **"Off":** GPU pipeline halted; signal canvas (2D, with `ctx.fillText` text + cursor) drawn directly to the visible canvas, scaled to display size.

State persisted in `localStorage` under key `interslice-systems:is2200:crt-mode` (`"on"` | `"off"`). Persists across page reloads.

### Easter-egg power sticker

- **Position:** lower-left corner of the Memphis card frame, ~12 px in from the corner (just inside the cyan offset shadow zone).
- **Visual:** ~32×32 px Memphis sticker. Hard black border (`var(--ink-0)`), small offset shadow, colored background (`var(--ink-cyan)` when on, `var(--paper-0)` when off). Single `⏻` glyph (U+23FB) centered.
- **Interaction:** click to toggle. Updates `localStorage`, dispatches a state change to the Trinitron instance.
- **Animation:** when on, a subtle 1-px colored ring pulses around the sticker at the same rate as the breathing effect (~0.3 Hz, ~2% scale amplitude). When off, sticker is dimmed (~50% opacity).
- **Reduced motion:** the sticker visual stays. The "on" transition skips the warmup curve and goes to steady state immediately.

## Fallback strategy

### WebGL2 unavailable

1. `canvas.getContext('webgl2')` returns null → log a warning, instantiate the existing CPU `Trinitron` renderer with the same config.
2. CPU renderer at 640×480 source / 1280×960 effective is heavy but functional. Estimated ~20–30 Hz on modern hardware. Acceptable as a fallback.
3. If `<canvas>` itself is unavailable (very rare): no rendering. The `.mcrt__a11y` screen-reader mirror remains for assistive tech.

### Reduced motion

`prefers-reduced-motion: reduce` → render one warmed-up, steady-state frame, no RAF loop. Preserves existing behavior.

### Tab visibility

When `document.visibilityState === 'hidden'`, stop RAF. When visible again, restart with one persistence-buffer-zeroing frame to avoid ghosting.

## Code organization

### Extend, don't split

The existing `Trinitron` class in `docs/trinitron.js` gains a `renderer: 'cpu' | 'gpu' | 'auto'` constructor option:

- `'cpu'`: existing CPU path. The dark-mode logo passes this explicitly.
- `'gpu'`: WebGL2 path. Throws if context creation fails.
- `'auto'` (default for the mcrt): tries `'gpu'`, falls back to `'cpu'` on context-creation failure.

GPU implementation lives as private methods (`_initGpu`, `_renderGpu`, `_destroyGpu`) within the same class. CPU code is untouched.

Public API additions:

- `effects` object — new, mutable.
- `setMasterMode(on: boolean)` — new, toggles GPU bypass.
- `destroy()` — new, tears down GL resources on stop or unmount.

Otherwise the public API is identical to today's. `window.__trinitron` continues to point at the IS-2200 instance for debugging.

Expected file size after implementation: ~1500 lines (current is ~600). If it exceeds ~2000 lines or becomes hard to navigate, we can split CPU and GPU into separate files (`trinitron-cpu.js`, `trinitron-gpu.js`) with shared API surface defined in `trinitron.js`. Not necessary up front.

### Consumer call-site changes

`initMcrt` in `docs/index.html` updates its call to pass `renderer: 'auto'` and a richer options object covering the new effects. The signal callback (`mcrtSignal`) is largely unchanged — it still paints into a 2D canvas; only the canvas dimensions grow from 252×150 to 1280×960, and the line content stretches to fit 80 cols.

The dark-mode logo's `Trinitron` construction passes `renderer: 'cpu'` explicitly.

## Validation

No formal test suite (project convention — see `CLAUDE.md`). Verification path:

1. **Per-effect debug panel** (`?debug=1`) — toggle each effect in isolation, confirm visual change matches the taxonomy description.
2. **Master A/B toggle** — confirm GPU bypass produces a clean "raw text" view; confirm "on" produces the full CRT effect.
3. **FPS readout** in the debug panel — confirm 120 Hz on modern hardware in CRT mode.
4. **CPU fallback** — in DevTools, override `HTMLCanvasElement.prototype.getContext` to return null for `webgl2`, confirm CPU renderer takes over and looks correct (slower but functional).
5. **Reduced motion** — set `prefers-reduced-motion: reduce` in DevTools, confirm no RAF and a steady-state frame renders.
6. **localStorage persistence** — toggle master A/B, reload page, confirm state persists.

## Open considerations (parking lot)

- **Static / noise effects** (horizontal noise band, sync glitch). Deferred. Could become a separate easter egg.
- **Damper wires on graphics mode.** Deferred. Could re-enable conditionally if a graphics-mode demo is added.
- **Dark-mode logo GPU port.** Deferred. Stays on CPU renderer.
- **Additional content modes for the IS-2200** (boot sequence, mesh-status animation, ANSI-art splash, paletted graphics demo). Out of scope for this design. Could land as follow-ups once the rendering substrate exists.
