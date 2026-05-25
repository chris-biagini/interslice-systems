# PC-CRT shadow-mask renderer — design

## Goal

Add a second CRT renderer to the hero — an **idealized PC-CRT delta-triad shadow-mask** — selectable via `?crt=shadow-mask` URL parameter. The Trinitron remains the default; the new renderer ships as a peer file (`docs/shadow-mask.js`) modeling the *other* major historical CRT family (computer-monitor shadow-mask, the counterpart to the arcade-Trinitron framing already established in dark mode).

The shadow-mask gets the **same idealization doctrine** the Trinitron got in the 2026-05-24 vertical-resolution refactor: the structural minimum (the dot pattern) stays visible-but-vanishingly-clean; every other cheap-electronics flaw (moire, convergence drift, geometry warp, decay variability, scanlines) is eliminated. The result is "a PC monitor designed by someone who cared, running at 85 Hz on a perfectly calibrated tube" — recognizable as shadow-mask, but not jangly.

The deliverable is dispatch + a new renderer, not UI: there is no toggle in the page, no bezel, no theme work. URL param only. UI affordances and persistence are out of scope and a follow-up if the renderer earns it.

## What changes

### Visible (dark mode, `?crt=shadow-mask`)

- The hero CRT face renders through a **delta-triad dot lattice** instead of vertical phosphor stripes. Dots are hex-tiled (every other row offset by half a triad pitch); colors rotate so any three adjacent dots form one R + one G + one B triangle (the namesake "delta triad" arrangement).
- No damper-wire shadows (those are aperture-grille only).
- No scanline banding.
- No visible convergence offset.
- Halo bleed around bright dots, gentle vignette, same character as Trinitron-mode.

### Visible (dark mode, no `crt` param)

No change. Trinitron renders, identical to main.

### Visible (light mode)

No change either way. Canvas is `display: none`; no renderer is constructed.

### Code

- New file `docs/shadow-mask.js` — a peer renderer to `docs/trinitron.js`, structurally a copy of the Trinitron renderer with the aperture-grille pieces swapped for the delta-triad pieces and the Trinitron-only pieces (damper wires, gap mask) removed.
- The existing stash file `docs/shadow-mask.js` (per the 2026-05-24 vertical-resolution refactor) is **replaced** by this real renderer. The stashed kernels are folded into the new shader where applicable (see Architecture).
- `docs/index.html`: one new block in the existing dark-mode renderer-instantiation script: parse `?crt=` from the URL, instantiate `ShadowMask` instead of `Trinitron` when value is `'shadow-mask'`. New `<script src="shadow-mask.js">` tag alongside the existing `trinitron.js` (both load on every page; only one renderer is constructed).
- DevTools handle `window.__crt` exposed as an alias for whichever renderer is active; `window.__trinitronLogo` is kept as-is for back-compat when Trinitron is the active renderer.

## Architecture

### Two peer files, copy-share scaffolding

`docs/trinitron.js` is unchanged. `docs/shadow-mask.js` is structurally a copy of it: same `class { constructor / start / stop / destroy / _initGpu / _uploadStaticUniforms / _renderGpu / _createDebugPanel ... }` shape, same WebGL2 init + extension checks, same FBO + ping-pong management, same bloom programs, same composite scaffolding, same RAF / reduced-motion / theme-observer plumbing. ~90% of the JS scaffolding is byte-for-byte identical per the pre-spec inventory.

This duplication is intentional. The codebase convention is "three similar lines is better than a premature abstraction" — until a third renderer exists, the actual shared seams are guessed, not observed. If a third CRT renderer ever lands, extracting a `crt-base.js` becomes obvious work driven by visible duplication rather than speculation.

### URL-param dispatch

In the existing inline dark-mode bootstrap script in `index.html`, before constructing the hero renderer:

```js
const useShadowMask = new URL(window.location).searchParams.get('crt') === 'shadow-mask';
const RendererClass = useShadowMask ? ShadowMask : Trinitron;
try {
  const inst = new RendererClass(canvas, options);
  window.__crt = inst;
  if (!useShadowMask) window.__trinitronLogo = inst;  // back-compat alias
  inst.start();
} catch (err) {
  // Existing fallback path: static .m-dark SVG keeps showing.
}
```

Both `<script src>` tags load on every page (`trinitron.js` + `shadow-mask.js`). Total JS payload roughly doubles; only one class is instantiated per page load. No dynamic imports — keeps the "no toolchain" property intact.

### Phosphor shader (the load-bearing difference)

The Trinitron's `PHOSPHOR_FS` does 1D stripe decomposition: `subX = px.x mod cellSize.x`, weights assigned by which of three columns the fragment is in, Y axis ignored.

The shadow-mask phosphor shader is genuinely 2D. Per fragment:

```glsl
vec2 px = vUv * uViewSize;

// 1. Hex-tiled cell lookup. Every other row is x-shifted by half a
//    cell width; one dot per cell.
int row = int(floor(px.y / uCellSize.y));
float rowShift = float(row & 1) * uCellSize.x * 0.5;
int col = int(floor((px.x - rowShift) / uCellSize.x));

// 2. Color of this cell's dot. (col - row) mod 3 produces the delta-
//    triad arrangement: every triangle of 3 nearby dots is one R + one
//    G + one B. Math derivation: see implementation comments.
int colorIdx = ((col - row) % 3 + 3) % 3;

// 3. Radial soft-circle falloff from the cell center. uDotRadiusFrac
//    is the dot radius as a fraction of cell width — default 0.30.
vec2 cellCenter = vec2(
  (float(col) + 0.5) * uCellSize.x + rowShift,
  (float(row) + 0.5) * uCellSize.y
);
float dist = length(px - cellCenter);
float dotRadius = uCellSize.x * uDotRadiusFrac;
float dotFalloff = smoothstep(dotRadius, dotRadius * 0.5, dist);

// 4. Only the lit channel emits. Between dots, weights = 0 → fully
//    black before bloom. No phosphor coupling: the metal mask absorbs
//    between-dot electrons cleanly. The mix() honors the stripeProfile
//    toggle the same way the Trinitron shader does: when the toggle is
//    OFF (debug-panel use only), the renderer paints the raw signal
//    everywhere — useful for debugging what the signal looks like
//    before the phosphor decomposition.
vec3 weights = vec3(0);
weights[colorIdx] = dotFalloff;
weights = mix(vec3(1.0), weights, uStripeEnabled);

// 5. Row shimmer — universal beam-current ripple, same hash as Trinitron.
float rowShim = 1.0 + uRowShimmerAmp * (2.0 * lcg(uint(row) * 4099u + uShimmerSeed) - 1.0);
rowShim = mix(1.0, rowShim, uRowShimmerEnabled);

vec3 stripeOut = lerped.rgb * weights * rowShim;
oPhosphor = vec4(stripeOut, lerped.a);
```

Reused unchanged from Trinitron's `PHOSPHOR_FS`: convergence offsets, `sampleBeamSpread` (the 9-tap Gaussian), persistence lerp, row shimmer hash, `lcg` helper. The signal upload, FBO ping-pong, and bloom programs are byte-for-byte the same code.

### Why this approach over the stash kernels

`docs/shadow-mask.js` (the stash version) contained an X-narrow per-cell hotspot kernel: at `cellSize=3` the X-narrow + Y-tapered structure happens to read as a roundish dot. At the shadow-mask's `cellSize=[6, 5]` it would read as a vertical streak. The radial-smoothstep approach above scales cleanly to any cell size and gives proper circular dots regardless. Per-cell shimmer (the stash's other kernel) is the "manufacturing variance" flaw that idealization eliminates entirely.

The stash's existence wasn't wasted — it preserved the design intent of "shadow-mask wants something different from Trinitron in the phosphor pass," which seeded this brainstorm. The kernels themselves don't survive; the lesson does.

### Composite shader

Same `COMPOSITE_FS` as Trinitron, with two omissions:

- The `uGapMask` sampler + `uGapMaskEnabled` uniform stay in the source for code symmetry, but the shadow-mask hero passes no gap mask and `effects.gapMask = false`. The phosphor pass already produces fully black between-dot regions, so no post-composite multiply is needed to enforce dot/substrate distinction. Bloom adds gentle halo (intentional, the glass keeper).
- The `uScanline*` uniforms stay in the source. The shadow-mask hero passes `scanlineDepth: 0` and `effects.scanlines = false`. (Option A doctrine: no scanline banding.)

Future work could add a 2D dot-perforation mask if the rendered look feels insufficiently mask-y in motion; explicitly deferred from this spec.

### Option defaults — `ShadowMask` constructor vs. `Trinitron` constructor

| Option | Trinitron default | ShadowMask default | Reason |
|---|---|---|---|
| `cellSize` | `3` (single int → `[3,3]`) | `[6, 5]` (vec2) | Hex tile: wider X, shorter Y (`5 ≈ sqrt(3)/2 × 6`) for equilateral triangle adjacency |
| `dotRadiusFrac` | n/a | `0.30` | New option — dot radius as fraction of cell X |
| `phosphorCoupling` | `0` | `0` | Hero overrides Trinitron's default to `0.35`; shadow-mask hero leaves it at `0` |
| `beamSpreadVerticalPx` | `0.0` | `0.0` | Both default isotropic; Trinitron's hero overrides to asymmetric (sharp X / soft Y); shadow-mask's hero stays isotropic |
| `damperWires` | `[0.32, 0.68]` | — | Field absent from `ShadowMask` opts |
| `damperStrength` | `0.62` | — | Field absent |
| `gapMaskAlpha` | `0` | — | Field absent |
| `gapMaskPeriod` | `2` | — | Field absent |
| `curvatureMode` | `'spherical'` | `'spherical'` | Same; Trinitron's hero overrides to `'cylindrical'`; shadow-mask hero stays at the default |

### `this.effects` toggles — shadow-mask deltas

Same shape, with `damperWires` and `gapMask` removed (the underlying option fields don't exist). `stripeProfile` keeps its name — the toggle now governs the dot-decomposition kernel rather than the stripe kernel. All other toggles (`phosphorCoupling`, `convergence`, `convergenceDrift`, `persistence`, `perRowShimmer`, `beamSpread`, `selectiveBloom`, `scanlines`, `curvature`, `gloss`, `vignette`, `warmup`, `breathing`) keep the same names and defaults.

### Debug panel

`_createDebugPanel` is duplicated and edited per-renderer. The `GROUPS` array for `ShadowMask`:

- Removes the `damperWires` and `gapMask` rows
- Removes the `stripeProfile` description's aperture-grille language; rewrites for delta-triad
- Adds a `dotRadiusFrac` slider under the `stripeProfile` row (or as its own row — implementation choice)

Everything else (FPS counter, snapshot / diff / copy-state, the group rendering machinery) is identical code.

### Hero config for `?crt=shadow-mask`

In `index.html`, the alternative `new ShadowMask(canvas, {...})` call:

- Same `viewSize`, same `canvasSize`, same `opaqueBackground: true`, same `signal` callback
- `cellSize: [6, 5]` (explicit in the hero so the value is visible at the call site)
- *No* `damperWires` / `damperStrength` fields
- *No* `gapMaskAlpha` / `gapMaskPeriod` fields
- Same `rowShimmer: 0.02`
- Same `effects` overrides as Trinitron-mode hero, *minus* `damperWires: true` and `gapMask: true`

The signal callback is **identical** — same `paintChannel1/2/3` painters, same wordmark layout. The painters render the same content; only the display tech changes.

### What stays the same

- All HTML markup outside the renderer-instantiation script
- `docs/tokens.css`, all inline `<style>` in `index.html`
- `.m-dark` / `.m-light` SVG fallback layers (fall back if `try { new RendererClass(...) }` throws, for either renderer)
- Channel system (`CHANNEL_LABELS`, painters, channel bar UI, keyboard shortcuts, OSD plate)
- `<html class="trinitron-active">` state class (historically named, now a misnomer when shadow-mask is active; renaming deferred to a future cleanup pass to avoid CSS cascade churn)
- Sprinkle distribution, hero substrate styling, CTA, footer
- Light-mode behavior (canvas hidden + renderer stopped, regardless of which renderer would be active)
- Reduced-motion handling (each renderer owns its own listener; behavior identical)

## Verification plan

1. **Default URL.** Load `/` and confirm Trinitron renders, no visual regression vs. main branch. `window.__trinitronLogo` exposed, `window.__crt` exposed and identical reference.
2. **Shadow-mask URL.** Load `?crt=shadow-mask`. Expected: delta-triad dot pattern visible (clearly different from Trinitron stripes), no damper-wire shadows, no scanline banding, no visible convergence offset, gentle halo around bright dots. `window.__crt` exposed; `window.__trinitronLogo` is `undefined`.
3. **Channels under both renderers.** Cycle CH1 → CH2 → CH3 → back, under both URLs. All three painters work under either renderer; OSD plate shows correct label.
4. **Theme toggle.** Toggle `<html data-theme="light">` ↔ `data-theme="dark"` in DevTools under both URLs. Canvas hides/shows; renderer stops/starts.
5. **WebGL2 unavailable.** Disable WebGL2 in DevTools, reload each URL. Both fall back cleanly to `.m-dark` SVG. No louder console errors than today.
6. **Debug panel.** Open `?debug=1` and `?debug=1&crt=shadow-mask`. First shows Trinitron groups (with damper-wires + gap-mask rows). Second shows shadow-mask groups (no damper, no gap mask; new `dotRadiusFrac` slider).
7. **Reduced motion.** Set `prefers-reduced-motion: reduce` in DevTools under both URLs. Hub rotation stops; phosphor surface still renders; OSD plate still appears on channel change.
8. **Phosphor pattern correctness.** Zoom into a screenshot of the shadow-mask hero at 4×–8× scale. Verify: dots are circular (not streaks); every adjacent triangle of three dots contains one R + one G + one B; rows alternate the x-shift; cell-center placements form a clean hex lattice.

## Out of scope

- **UI toggle / power button / mode pill.** URL param is the only switch in this spec. UI affordance is a follow-up if the renderer earns it.
- **Persistence of mode choice.** No localStorage write. Each page load uses whatever the URL param says.
- **2D dot-perforation mask.** Skipped pending evidence that bloom-brightened between-dot areas need additional darkening.
- **Bezel rendering.** Spec is explicit: no page changes outside the CRT.
- **Reskinning channel content.** The channel painters paint the same signal under either renderer.
- **Class-name rename (`.trinitron-active` → `.crt-active`, `window.__trinitronLogo` → `window.__crt`).** The alias is added; the rename is deferred to avoid CSS / doc cascade churn. The alias is the load-bearing path.
- **Extracting a shared `crt-base.js`.** Defer until a third renderer makes the actual shared seams observable rather than speculative.

## Memory updates

After implementation:

- **`trinitron_renderer.md`** — update to note `docs/shadow-mask.js` is now a sibling renderer (no longer a stash), and that `window.__crt` is the canonical DevTools handle for the active renderer (regardless of class). `window.__trinitronLogo` remains as a back-compat alias when Trinitron is active.
- **`feedback_cell_grid_is_intentional.md`** — verify still applies. The Trinitron stays continuous-stripes; this spec adds a *separate* renderer that legitimately uses a dot lattice. The memory should now also mention that the dot lattice has a home — the shadow-mask renderer — so the "no dot pattern in trinitron.js" rule is still load-bearing for the Trinitron file specifically.

## Performance notes

The shadow-mask phosphor pass adds, per fragment, vs. the Trinitron pass:

- One `length()` call for radial distance
- One `smoothstep()` call for dot falloff
- Two integer divisions / mods for row + col lookup
- One float compare + shift for `row & 1`

Roughly 8–10 additional ALU ops per fragment. At the hero's viewSize (~480 × 170 = 81,600 source pixels) × 60 fps, this is ~5M fragments/sec losing ~10 ops each — well below measurement noise on any modern GPU.

The duplicated JS file roughly doubles the loaded script payload — `docs/trinitron.js` is ~76 KB uncompressed today, so the shadow-mask peer pushes total to ~150 KB. Both files gzip well; net wire cost is modest. Only one renderer is instantiated per page load, so the runtime memory cost is identical to today.
