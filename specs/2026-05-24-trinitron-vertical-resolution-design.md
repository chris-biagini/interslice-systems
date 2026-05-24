# Trinitron vertical resolution — design

## Goal

Align the Trinitron renderer to the conceptual model of a real Trinitron at the resolution we render at: **continuous vertical phosphor stripes, softened only by the beam's gaussian PSF, with damper wires as the only intentional horizontal feature.** Strip the per-cell hotspot and per-cell shimmer kernels — both of which effectively model a *shadow-mask* CRT (RCA-style), not a Trinitron. The result is a more historically-accurate "ideal Trinitron" look, plus a modest per-fragment performance win, plus a clean handoff for a sibling shadow-mask renderer in a later cycle.

The framing is "stylized ideal": the engineering hits its theoretical extreme. Flaws that have a physical-structural reason to exist stay, but vanishingly minimized. Flaws that are artifacts of cheap-era electronics go away.

This spec also drops the CPU rendering path entirely. It's a parallel ~300-line implementation that no actual consumer relies on (it's only reached when WebGL2 init fails, which on any modern device means the device is too constrained to enjoy the result anyway). The progressive-enhancement fallback chain — semantic HTML → CSS/SVG dark-mode logo → WebGL Trinitron — already handles the WebGL2-unavailable case via the existing static SVG `.m-dark` layer. Removing the CPU path eliminates a constant divergence risk (recent example: the GPU's anisotropic beam spread that the CPU path silently doesn't honor) and shrinks `trinitron.js` significantly, which makes the *next* refactor — and the eventual shadow-mask renderer — that much simpler.

## Background: why the cell concept doesn't fit Trinitron

A real Trinitron's phosphor stripes are **continuous along Y**, broken only by 1-2 horizontal damper wires (the thin shadows at roughly ⅓ and ⅔ height). The horizontal aperture-grille pitch quantizes horizontal resolution; vertical "resolution" is *not* phosphor-quantized — it's set entirely by the electron beam's gaussian PSF, which has a vertical FWHM roughly equal to the horizontal triad pitch on a well-focused consumer set.

The current renderer carves the signal into 3×3 source-pixel "cells" and applies a per-cell hotspot (X-narrow, Y-tapered across each cell) plus per-cell brightness shimmer. This produces a 2D dot pattern — the defining visual of a shadow-mask CRT, not a Trinitron. At our hero's resolution (160 horizontal triads × 170 vertical source pixels) the source-pixel grid is already roughly square-pixel-equivalent to the beam PSF, so a true Trinitron would show no Y-axis structure at all besides the damper wires.

This spec aligns the model to the machine.

## Parameter changes

| Parameter | Current | Target | Reason |
|---|---|---|---|
| Per-cell hotspot | strength 0.24, on | **removed** | Shadow-mask feature |
| Per-cell shimmer | 0.04, on (hero) | **removed** | Shadow-mask feature |
| Per-row shimmer | 0.012 | **0.02** | Vanishing beam-current ripple; the only animated micro-texture |
| Damper wires | strength 0.62, on | **strength 0.90**, on | "Vanishing flaw" — ideal engineering almost eliminated them. (Semantics: `damperStrength` is *fraction of brightness retained* at the wire row, so higher = fainter wire.) |
| Gap mask alpha | 0.30 | **0.15** | Aperture-grille shadow at the ideal-engineering pitch |
| Stripe profile | on | unchanged | The core Trinitron decomposition |
| Phosphor coupling | 0.35 | unchanged | Brightness "cheat" — adjacent stripes still glow |
| Beam spread H / V | 0.7 / 1.4 | unchanged | Asymmetric: sharp X (grille-quantized), soft Y (PSF) |
| Persistence | 0.82 | unchanged | Phosphor afterglow |
| Convergence | off | unchanged | Ideal Trinitron has perfect convergence |
| Composite scanlines | off | unchanged | Continuous bars rule out scanline structure |
| Halo bleed (radius / intensity) | 18 / 1.2 | unchanged | Glass scattering — charming |
| Phosphor blur | 0.6 | unchanged | Glass softening — charming |

## Architecture

### Changes to `docs/trinitron.js`

**CPU path removal** (largest single change):

- Delete `_initCpu` (around line 564) and everything it sets up: `signalCanvas`, `signalCtx`, `_convR`/`_convG`/`_convB`, the stripe lookup tables (`stripeR`, `stripeG`, `stripeB`), the per-cell shimmer / hotspot tables, the CPU damper baking.
- Delete `_renderCpu` (the per-frame CPU paint path) and any CPU-only helpers it calls.
- Delete the CPU branch of the constructor (lines 543-546): the `if (this._mode === null)` fallthrough.
- Constructor becomes: try GPU init; on failure, throw. The hero's existing `try { ... } catch` at index.html:2830 catches and falls back to the static SVG dark-mode layer (existing behavior — verified that `.trinitron-active` gating means the live wordmark stays visible when the renderer doesn't start).
- Remove the `renderer` option entirely. No more `'cpu' | 'gpu' | 'auto'` — the renderer is GPU-only. Update the hero config to stop passing `renderer: 'auto'`.
- Remove the `_mode` field and any branching on it (`if (this._mode === 'gpu')` etc.) — only one mode now.

**Master-mode / bypass-canvas removal** (rides with the CPU removal):

The master-mode machinery (`bypassCanvas` option, `_masterOn` state, `setMasterMode`, `_bypassCanvas` + `_bypassCtx`, the localStorage read/write of `'interslice-systems:is2200:crt-mode'`) was IS-2200's "is the CRT power-on" toggle. The IS-2200 is gone (deleted in the hero-trinitron consolidation); the only remaining consumer is the debug-panel "view CSS fallback" checkbox, which is itself removed in the debug-panel section below.

- Delete `bypassCanvas` option from the options block.
- Delete `setMasterMode` method and all `_masterOn` / `_bypassCanvas` / `_bypassCtx` field references (around lines 1115-1145, 1490-1495).
- Delete the localStorage read at line 552 and write at line 1934.
- Clean up the stale IS-2200 references in the option comments at lines 143, 256, 287, 468, 480, 876 — they're harmless but misleading once the only consumer is gone. Single small cleanup pass during this refactor.

(Stale localStorage values on existing user devices remain inert — no migration needed.)

**Options block** (around line 350):

- Remove `hotspot` option entirely.
- Remove `cellShimmer` option entirely.
- Remove `renderer` option (per CPU-path removal above).
- Keep `cellSize` as a single integer. The GPU uniform `uCellSize` stays `[cs, cs]` for symmetry, but the shader only consumes `.x` after this refactor. Document the change in the option's comment.

**Effects toggles** (around line 492):

- Remove `perCellHotspot` from `this.effects` defaults.
- Remove `perCellShimmer` from `this.effects` defaults.
- `perRowShimmer` stays (already in defaults).

**GPU phosphor shader** (`PHOSPHOR_FS`, lines 45-191):

- Remove uniforms: `uHotspot`, `uCellShimmerAmp`, `uHotspotEnabled`, `uCellShimmerEnabled`.
- Remove the per-cell hotspot kernel (lines 154-172): `centerInt`, `dx`, `dy`, `xMask`, `yFall`, `hotBoost`, `hotMul`.
- Remove the per-cell shimmer hash (lines 174-179): `cellCoord`, `cellGridW`, `cellIdx`, `cellShim`.
- Keep the row shimmer hash (lines 181-186) — it doesn't reference cells.
- Remove the `subY = int(mod(px.y, uCellSize.y))` line (139) — unused after the kernel goes.
- The final per-fragment stripe expression collapses to: `stripeOut = lerped.rgb * weights * rowShim`. The `cellMod` intermediate disappears.

**Debug panel** (`_createDebugPanel`, `GROUPS` array around line 1292):

- Remove the `perCellHotspot` group item (label "per-cell hotspot", with its `hotspot` slider).
- Remove the `perCellShimmer` group item (label "per-cell shimmer", with its `cellShimmer` slider).
- Update `perRowShimmer`'s description to reflect that it's now the only animated micro-texture in the model. Slider range and step unchanged.
- The `damperWires` and `gapMask` rows stay unchanged in structure. No new sliders added in this refactor — if tuning the new 0.15 gap mask alpha live ends up being useful during integration, that's an ad-hoc DevTools/`window.__trinitronLogo` move, not a spec change.
- Remove the "view CSS fallback" checkbox (around line 1280).

### Hero config changes (`docs/index.html`)

Update the `new Trinitron()` call at index.html:2798:

- Remove `renderer: 'auto'` (the option no longer exists; GPU is the only path).
- Remove `hotspot: 0.24`.
- Remove `cellShimmer: 0.04`.
- Set `rowShimmer: 0.02` (was 0.012).
- Add `damperStrength: 0.90` — the hero currently has no override, so it inherits the renderer default of 0.62. This refactor adds an explicit value to the hero config. (Reminder: `damperStrength` is fraction-of-brightness-retained, so 0.90 = wire row keeps 90% brightness = very faint shadow.)
- Set `gapMaskAlpha: 0.15` (was 0.3).

The existing `try { ... } catch` wrapper at index.html:2830 stays — same fallback path, just now also catching WebGL2-unavailable as a real possibility rather than a theoretical one.

### New file: `docs/shadow-mask.js` (stub)

A stash for the per-cell phosphor kernels extracted from this refactor. **Not** loaded by `index.html`; **not** a working renderer; **not** referenced by any pipeline. Pure preservation, so the next brainstorm (shadow-mask CRT renderer) starts with the kernel code in hand rather than reconstructing it from git history.

Contents:

1. **Top-of-file header** explaining the file's purpose: stash for shadow-mask kernels extracted from trinitron.js during the "Trinitron vertical resolution" refactor (date, this spec path). Not loaded; not active. The eventual shadow-mask renderer will import or paste from here.
2. **Extracted GLSL fragments**, copied verbatim from the pre-refactor `PHOSPHOR_FS`:
   - The per-cell hotspot kernel (subX/subY, `xMask`, `yFall`, `hotMul`).
   - The per-cell shimmer hash (`cellCoord`, `cellGridW`, `cellIdx`, `cellShim`).
   - With their existing inline comments preserved — those comments are the design intent.
3. **Pointer comments**: this spec's path, plus a placeholder for the future shadow-mask design doc.

(No CPU-path equivalents to extract — the CPU path is being deleted entirely in this refactor. The shadow-mask renderer, when built, will be GPU-only from day one.)

The file is checked in to make the kernels discoverable, but it's inert until a shadow-mask renderer is built.

## Verification plan

The change is mostly removal — risk is regression on the hero's visual character, not on new functionality.

1. **Side-by-side hero compare.** Open `main` and the refactor branch in two tabs. Toggle dark mode in DevTools. Expected differences:
   - Phosphor texture: dot grain is gone; stripes look continuous vertically.
   - Wordmark / logo: subtly softer along Y (no per-cell hotspot brightening center rows). Stripes between phosphors look about the same horizontally.
   - Damper wires: barely visible vs. clearly visible.
   - Aperture-grille shadow: visibly thinner / lighter.
2. **Debug panel.** Visit `?debug=1` and confirm:
   - "per-cell hotspot" and "per-cell shimmer" rows are gone from the phosphor group.
   - "per-row shimmer" slider reads 0.02 and is functional.
   - "damper wires" slider reads ~0.10 darkness (slider semantic is `1 - damperStrength`, so strength 0.90 → darkness 0.10 = "wire is 10% darker than its row").
   - "view CSS fallback" checkbox is gone.
3. **Channel cycle.** Step through INTERSLICE → DEMO REEL → PONG. Visual character should be consistent across channels — they share the same pipeline.
4. **Reduced motion.** Confirm `prefers-reduced-motion: reduce` still stops the hub rotation and that the phosphor surface still renders.
5. **WebGL2-unavailable fallback.** Open DevTools, disable WebGL2 (Chromium: chrome://flags), reload. Expected: hero shows the static SVG dark-mode logo (`.m-dark` layer visible), wordmark renders as live cream text, page is fully functional. No console errors louder than the existing `console.warn` (which should be removed or rewritten as part of the CPU-path removal since the fallback message no longer mentions CPU).
6. **Light mode.** No regression expected — the canvas is `display: none` in light mode.
7. **`docs/shadow-mask.js`.** File exists, contains the extracted GLSL kernels with comments, and is not referenced from any other file (`grep -r shadow-mask docs/` should match only the file itself).

## Out of scope

- **Shadow-mask renderer.** Separate brainstorm + spec + plan + implementation cycle. The `shadow-mask.js` stub is the only forward-looking artifact here.
- **Subpixel rendering.** Future work. The new stripe-only architecture makes it clean to add later (fractional `subX` becomes meaningful), but no API surface is added in this spec.
- **Common-scaffolding factoring** between Trinitron and the future shadow-mask renderer. Defer until both renderers exist and the seams are obvious.
- **Light-mode changes.** Light mode doesn't use the canvas.
- **Renaming `cellSize` to `stripePeriod`.** Cascades through too much (debug panel, prior specs, saved memories) for the value added. The name stays; the Y component just becomes inert.
- **Removing the `cellSize` Y component from the GPU uniform.** It's still `[cs, cs]` for symmetry; the shader simply doesn't consume `.y` after this refactor.

## Memory updates

After implementation:

- **`feedback_cell_grid_is_intentional.md`** — obsolete. The cell-grid is gone; this memory now misleads future sessions. Rewrite or delete. Recommended rewrite: capture the new model ("Trinitron is continuous vertical stripes; the cell-grid was a shadow-mask carryover, removed [date]. See `specs/2026-05-24-trinitron-vertical-resolution-design.md`.").
- **`feedback_gap_mask_striations.md`** — verify still applies. The gap mask still covers the whole stripe region including the halo (geometry unchanged); only the alpha drops 0.30 → 0.15. Likely still accurate; reread during implementation and update only if specifics drift.

## Performance notes (not a deliverable, just expected)

The phosphor pass loses, per fragment:

- ~5 ALU ops (the hotspot computation: `centerInt`, two `abs`, `xMask`, `yFall`, `hotMul`).
- 1 LCG hash + 1 mix (the per-cell shimmer).
- ~4 enabled-branch evaluations (`uHotspotEnabled`, `uCellShimmerEnabled`, and the branches that compose them with `hotMul` and `cellShim`).
- 1 `subY` int conversion + mod.

At the hero's viewSize (~480 × 170 = 81,600 source pixels) × 60 fps, this is ~4.9M fragments/sec losing ~10 ops each. Below measurement noise on any modern GPU, but free.

The static-uniform upload path also drops four uniforms (`uHotspot`, `uCellShimmerAmp`, two `*Enabled` floats), saving a few `gl.uniform*` calls per static-uniform refresh.

The CPU-path removal is the bigger code-size win: ~300+ lines deleted from `trinitron.js`. Doesn't show up in runtime perf (the CPU path was never running for any real consumer), but it shows up immediately in maintainability — every future shader change stops needing a CPU mirror.
