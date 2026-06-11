# CRT effect axes + TV dev page — design

2026-06-10. Approved by Chris in-session.

## Summary

Two deliverables:

1. **Effect-axes reorganization.** Classify every renderer effect as `universal`,
   `trinitron`, or `shadow-mask`; encode that classification in a per-renderer
   effect schema; and curate each renderer's debug menu so it only offers options
   realistic for its tube. Three realism defects get fixed (curvature mode,
   Trinitron convergence axis, shadow-mask beam-spread anisotropy exposure).
   No shader changes.
2. **`docs/tv.html`** — an unlisted dev/tuning page: a 4:3 CRT screen in a
   woodgrain console-TV cabinet with detented CHANNEL and RENDERER knobs, five
   demo-content channels, and a full parameter bench below the cabinet generated
   from the active renderer's schema.

## Goals

- Audit-and-gate: each renderer's menu offers only tube-realistic effects/params.
- Single source of truth per renderer for effect metadata (labels, descriptions,
  param ranges, scope tags) shared by the built-in `?debug=1` overlay and the
  TV bench.
- A pleasant, fast tuning loop for future Trinitron realism work.
- Zero visual change to the hero on `/` and `/?crt=shadow-mask`.

## Non-goals

- No new shader effects (moiré, doming/purity drift, etc.) — the TV page exists
  so those can be added and tuned *later*.
- No shared `crt-effects.js` module. The two-file copy-share doctrine stands;
  each renderer file carries its own curated schema.
- No responsive re-rendering of the TV screen. Fixed 1:1 CSS pixels; small
  windows scroll.

## Part 1 — Effect taxonomy

Scope axis: `universal` (any color CRT), `trinitron` (aperture-grille,
single-gun/three-cathode, cylindrical face), `shadow-mask` (delta-triad,
delta-gun, spherical face).

| Effect | Pass | Scope | Notes |
|---|---|---|---|
| `stripeProfile` | phosphor | universal *(geometry per tube)* | The phosphor structure itself. Trinitron: continuous vertical RGB stripes. ShadowMask: hex-staggered triad dots (`dotRadius` param is shadow-mask-scoped). |
| `phosphorCoupling` | phosphor | universal | Shared cross-talk cheat, not physics. Keeps resolved dots/stripes reading white. |
| `convergence` | phosphor | universal *(axis per tube)* | Trinitron's inline cathodes misconverge **horizontally only** → spread synthetic writes `r:[-v,0]`, `b:[v,0]`. Delta-gun shadow-mask fringes in 2-D → keeps diagonal `r:[-v,-v]`, `b:[v,v]`. |
| `convergenceDrift` | phosphor | universal | Thermal wobble; G is reference in both. |
| `persistence` | phosphor | universal | Phosphor afterglow. |
| `perRowShimmer` | phosphor | universal | Beam-current line noise. |
| `beamSpread` | phosphor | universal *(anisotropy is trinitron)* | H param universal. The V>H anisotropic split is the Trinitron signature (grille quantizes H; beam PSF owns V). ShadowMask is isotropic: V slider removed from its menu; `beamSpreadVerticalPx` opt kept for API parity. |
| `damperWires` | signal stamp | **trinitron** | Aperture-grille stabilizer strands. Already Trinitron-only. ✓ |
| `selectiveBloom` | composite | universal | Glass halation. |
| `gapMask` | composite | **trinitron** | Grille gap columns. Already Trinitron-only; shadow-mask's black matrix is modeled by `dotRadius` instead. ✓ |
| `scanlines` | composite | universal | Raster structure. |
| `curvature` | composite | universal *(mode per tube)* | Trinitron face is **cylindrical** (verticals stay straight — the patent); shadow-mask tube is **spherical**. Mode is tube-determined: select removed from both menus, defaults pinned per class. `opts.curvatureMode` remains functional for callers. |
| `gloss` | composite | universal | Glass highlight. |
| `vignette` | composite | universal | Bezel falloff. |
| `warmup` | modulation | universal | Turn-on brightness ramp. |
| `breathing` | modulation | universal | EHT/power-supply ripple. |

Result: Trinitron menu = 14 universal + `damperWires` + `gapMask` (16).
ShadowMask menu = 14 universal with `dotRadius` param on its phosphor mask (14).

## Part 2 — Renderer changes (`docs/trinitron.js`, `docs/shadow-mask.js`)

### Effect schema (hoisted, tagged)

The `GROUPS` array moves out of `_initDebugOverlay()` into a class-level static:
`Trinitron.effectSchema` / `ShadowMask.effectSchema`. Same group structure
(phosphor → composite → glass → modulation). Entry shape:

```js
{ key: 'beamSpread', label: 'beam spread', scope: 'universal',
  desc: 'Gaussian PSF blur on signal. Softens razor edges into glowing phosphor.',
  params: [
    { opt: 'beamSpreadPx',         min: 0, max: 3, step: 0.1, sub: 'h (px)' },
    { opt: 'beamSpreadVerticalPx', min: 0, max: 3, step: 0.1, sub: 'v (px)',
      scope: 'trinitron' },   // Trinitron schema only
  ] }
```

`scope` on a param defaults to its item's scope. Each file's schema contains
only entries that belong on that tube — the tags are documentation plus UI
badges, not a runtime filter.

### Public param API

Synthetic params (`__convergenceSpread`, `__damperDarkness`) currently live in
panel closures. They move to instance methods both panels share:

- `readParam(opt)` → current value (handles synthetics).
- `writeParam(opt, value)` → mutates `opts` (handles synthetics; Trinitron's
  `__convergenceSpread` now writes X-only) and calls `_uploadStaticUniforms()`
  when GPU state exists.
- `stateDiff()` → the "what changed since construction" text the copy-state
  button emits. Baseline snapshot moves from the overlay closure into the
  constructor (schema-driven, cheap), so the TV bench gets the button too.

Effect toggles stay direct `renderer.effects.x = bool` mutation.

### Realism default fixes

| Where | Before | After |
|---|---|---|
| `trinitron.js` `opts.curvatureMode` default | `'spherical'` | `'cylindrical'` |
| `trinitron.js` `opts.convergence` default | `{ r: [-0.5,-0.5], b: [0.5,0.5] }` | `{ r: [-0.5,0], b: [0.5,0] }` |
| Trinitron `__convergenceSpread` write | `r:[-v,-v], b:[v,v]` | `r:[-v,0], b:[v,0]` |
| Trinitron menu | curvature mode select | removed (pinned cylindrical) |
| ShadowMask menu | curvature mode select | removed (pinned spherical, already default) |
| ShadowMask menu | beam spread V slider | removed (isotropic tube) |
| `index.html` hero Trinitron `convergence` | `{ r: [-0.25,-0.25], b: [0.25,0.25] }` | `{ r: [-0.25,0], b: [0.25,0] }` (latent — `effects.convergence` is off; zero visual change) |

The built-in `?debug=1` overlay rebuilds from the schema + `readParam`/
`writeParam`/`stateDiff` with unchanged appearance apart from the removed
controls. No scope badges in the overlay (too cramped); badges are a TV-bench
feature.

## Part 3 — `docs/tv.html`

Self-contained page, repo conventions: all page CSS in one `<style>`, loads
`trinitron.js` + `shadow-mask.js`, one inline `<script>`. Renderers constructed
with `debugOverlay: false` (the bench replaces it). Fixed dark workshop
backdrop; this page doesn't participate in the site's two-media theme system.

### Screen

- Signal: `viewSize [320, 240]` (4:3). `stripeUpscale 2`, `canvasSize
  [640, 480]`, displayed at 640×480 CSS px (1 canvas px = 1 CSS px before DPR).
- Two stacked elements in the screen cutout, visibility-toggled:
  - WebGL canvas — both renderer classes take turns on it via
    destroy/reconstruct (the proven hero-resize / mirabel-swap pattern; both
    classes request `webgl2` so canvas reuse is safe).
  - 2-D canvas for BYPASS — a canvas's context type is permanent, so raw mode
    needs its own element. Channels paint an offscreen 320×240 canvas which is
    blitted 2× with `imageSmoothingEnabled = false` — the honest
    nearest-neighbor reference for what the renderers receive.
- Rounded-corner CRT mask via wrapper `border-radius` + `overflow: hidden`,
  inner shadow for glass inset.

### Cabinet

Walnut console, drawn entirely with inline SVG + CSS (feTurbulence-based
woodgrain, gradients for brushed aluminum). Required elements: veneer body,
screen bezel, brushed control plate with two knobs, power LED, speaker grille,
small "INTERSLICE" badge. Builder has creative latitude beyond that list —
"do what you can with SVGs; don't boil the ocean."

**Knobs** — each is a real `<button>` (focusable, `aria-label`, value announced
via `aria-live` caption): click advances with wraparound; arrow keys step
prev/next. Pointer line rotates via CSS transform with a fast transition
(detent feel). Position labels printed around each knob in SVG text.

- CHANNEL: 5 positions, labeled **2–6** (VHF dial).
- RENDERER: 3 positions, labeled **TRINITRON / SHADOW MASK / BYPASS**.

### Channels

Each channel is a pure `draw(ctx, t, w, h)` at 320×240 logical size. The active
renderer's `signal` callback (or the bypass RAF loop) delegates to the current
channel. On channel change, the dispatcher paints white-noise snow for ~150 ms
before the new channel (knob-clunk interstitial).

| Ch | Content | Exercises |
|---|---|---|
| 2 | SMPTE color bars (static) | stripe/triad structure, coupling, gap mask |
| 3 | Convergence crosshatch — white grid + center dots on black | convergence, drift, beam spread (the real service pattern) |
| 4 | Interslice test card — PM5544-style circle card, "INTERSLICE SYSTEMS · PLEASE STAND BY" | edges, curvature, gloss, overall geometry |
| 5 | Motion reel — **placeholder**: bouncing white rectangle. Final pass: a fresh subagent goes ham after everything else lands. | persistence, bloom, drift |
| 6 | Dead-channel snow (white noise) | per-row shimmer, phosphor lattice |

### Bench panel (below cabinet)

Generated from `activeRenderer.constructor.effectSchema`:

- Groups as fieldsets (phosphor / composite / glass / modulation) in a
  responsive grid.
- Per effect: checkbox (writes `effects[key]`), label, scope badge
  (`universal` / `trinitron` / `shadow-mask`), description line.
- Per param: slider (or select) with live value, via `readParam`/`writeParam`.
- Header row: fps readout + "copy state diff" button (calls `stateDiff()`).
- Rebuilt on renderer knob change. In BYPASS, bench collapses to a "no
  renderer active — raw signal" note.

### Boot presets (starting points — this page exists to retune them)

Both renderers boot from hero-derived values plus TV-appropriate glass:
coupling 0.35, persistence 0.82, rowShimmer 0.02, bloomStrength 1.2.
Trinitron: convergence `r:[-0.25,0], b:[0.25,0]` **enabled** (consumer-TV
misconvergence), beamSpread 0.7/1.4, damperStrength 0.90, bleedRadius 18,
gapMaskAlpha 0.15 / period 2 with `gapMask: true`. ShadowMask: convergence
0.25 2-D enabled, beamSpread 1.5 isotropic, bleedRadius 24, bloomThreshold 0.3,
dotRadius 0.7. Both: `selectiveBloom`, `scanlines` (depth 0.18, period 2),
`curvature` (≈0.06; cylindrical/spherical via class defaults), `vignette`,
`warmup` **on**; `gloss`, `breathing` off.

### State, fallback, motion

- URL params `?ch=2..6&renderer=trinitron|shadow-mask|bypass`, synced via
  `replaceState` on knob change — deep-linkable for screenshots/sharing.
- WebGL2 or float-extension failure (constructor throws): permanent BYPASS,
  renderer knob disabled — the mirabel pattern.
- `prefers-reduced-motion`: renderers already render a single frame; the
  bypass loop does the same (one static frame, no RAF).

## File inventory

- `docs/trinitron.js` — schema hoist + tags, `readParam`/`writeParam`/
  `stateDiff`, overlay rebuilt from schema, curvature/convergence defaults,
  X-only spread. Shaders untouched.
- `docs/shadow-mask.js` — same hoist/API, menu curation (no mode select, no V
  slider). Shaders untouched.
- `docs/index.html` — hero Trinitron convergence values → X-only (latent).
- `docs/tv.html` — new.
- `CLAUDE.md` — document tv.html + schema API; remove stale mirabel.html
  section (page deleted in `d7b95f1`).

## Verification

Local server (`python3 -m http.server -d docs`), Playwright:

1. Hero no-regression: `/` and `/?crt=shadow-mask`, dark + light, before/after
   screenshots compared visually; console clean.
2. tv.html: screenshot all 3 renderer positions × channels 2/3/6; flip a few
   bench toggles and confirm visible deltas; knob keyboard operation; console
   clean.
3. `?debug=1` overlay on `/` still renders and tunes (spot-check sliders).

## Implementation sequencing

Parallel subagent tracks after plan approval (Opus-tier or better, per project
memory):

- **Track A** — renderer refactors (both files together; they mirror).
- **Track B** — tv.html cabinet/page shell, built against the schema API
  contract in this spec.
- **Track C** — channel draw functions, delivered as snippets; integrated into
  tv.html by the main agent (keeps page-JS single-block convention).

Then: main-agent integration, visual verification, hero-regression check,
commits per coherent unit. Last: **go-ham motion reel** — a fresh subagent
receives only the channel contract (`draw(ctx, t, w, h)`, 320×240, channel 5
slot) and full creative license; reviewed and committed separately.
