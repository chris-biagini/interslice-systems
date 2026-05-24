# Trinitron vertical resolution — design

## Goal

Align the Trinitron renderer to the conceptual model of a real Trinitron at the resolution we render at: **continuous vertical phosphor stripes, softened only by the beam's gaussian PSF, with damper wires as the only intentional horizontal feature.** Strip the per-cell hotspot and per-cell shimmer kernels — both of which effectively model a *shadow-mask* CRT (RCA-style), not a Trinitron. The result is a more historically-accurate "ideal Trinitron" look, plus a modest per-fragment performance win, plus a clean handoff for a sibling shadow-mask renderer in a later cycle.

The framing is "stylized ideal": the engineering hits its theoretical extreme. Flaws that have a physical-structural reason to exist stay, but vanishingly minimized. Flaws that are artifacts of cheap-era electronics go away.

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

**Options block** (around line 350):

- Remove `hotspot` option entirely.
- Remove `cellShimmer` option entirely.
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

**CPU phosphor path** (`_renderCpu` and its helpers):

- Mirror the GPU changes. Remove the per-cell hotspot lookup table and the per-cell shimmer table. Per-row shimmer stays.
- Verify the CPU path's pre-computed stripe tables (`stripeR`, `stripeG`, `stripeB`) still apply unchanged — they're horizontal-only and unaffected.

**Debug panel** (`_createDebugPanel`, `GROUPS` array around line 1292):

- Remove the `perCellHotspot` group item (label "per-cell hotspot", with its `hotspot` slider).
- Remove the `perCellShimmer` group item (label "per-cell shimmer", with its `cellShimmer` slider).
- Update `perRowShimmer`'s description to reflect that it's now the only animated micro-texture in the model. Slider range and step unchanged.
- The `damperWires` and `gapMask` rows stay unchanged in structure. No new sliders added in this refactor — if tuning the new 0.15 gap mask alpha live ends up being useful during integration, that's an ad-hoc DevTools/`window.__trinitronLogo` move, not a spec change.

### Hero config changes (`docs/index.html`)

Update the `new Trinitron()` call at index.html:2798:

- Remove `hotspot: 0.24`.
- Remove `cellShimmer: 0.04`.
- Set `rowShimmer: 0.02` (was 0.012).
- Add `damperStrength: 0.90` — the hero currently has no override, so it inherits the renderer default of 0.62. This refactor adds an explicit value to the hero config. (Reminder: `damperStrength` is fraction-of-brightness-retained, so 0.90 = wire row keeps 90% brightness = very faint shadow.)
- Set `gapMaskAlpha: 0.15` (was 0.3).

### New file: `docs/shadow-mask.js` (stub)

A stash for the per-cell phosphor kernels extracted from this refactor. **Not** loaded by `index.html`; **not** a working renderer; **not** referenced by any pipeline. Pure preservation, so the next brainstorm (shadow-mask CRT renderer) starts with the kernel code in hand rather than reconstructing it from git history.

Contents:

1. **Top-of-file header** explaining the file's purpose: stash for shadow-mask kernels extracted from trinitron.js during the "Trinitron vertical resolution" refactor (date, this spec path). Not loaded; not active. The eventual shadow-mask renderer will import or paste from here.
2. **Extracted GLSL fragments**, copied verbatim from the pre-refactor `PHOSPHOR_FS`:
   - The per-cell hotspot kernel (subX/subY, `xMask`, `yFall`, `hotMul`).
   - The per-cell shimmer hash (`cellCoord`, `cellGridW`, `cellIdx`, `cellShim`).
   - With their existing inline comments preserved — those comments are the design intent.
3. **Extracted CPU-path equivalents**, if any meaningful logic exists outside the shader (verify during implementation).
4. **Pointer comments**: this spec's path, plus a placeholder for the future shadow-mask design doc.

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
3. **Channel cycle.** Step through INTERSLICE → DEMO REEL → PONG. Visual character should be consistent across channels — they share the same pipeline.
4. **Reduced motion.** Confirm `prefers-reduced-motion: reduce` still stops the hub rotation and that the phosphor surface still renders.
5. **CPU fallback.** Force `renderer: 'cpu'` in hero config; confirm the same parameter changes apply and no shader-only logic was inadvertently left in.
6. **Light mode.** No regression expected — the canvas is `display: none` in light mode.
7. **`docs/shadow-mask.js`.** File exists, contains the extracted kernels with comments, and is not referenced from any other file (`grep -r shadow-mask docs/` should match only the file itself).

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

At the hero's viewSize (~480 × 170 = 81,600 source pixels) × 60 fps, this is ~4.9M fragments/sec losing ~10 ops each. Below measurement noise on any modern GPU, but free. The CPU path sheds proportionally more, since branchy per-pixel ALU is more expensive on CPU — meaningful only on the silent-fallback case.

The shader's CPU upload path also drops uniforms (`uHotspot`, `uCellShimmerAmp`, two `*Enabled` floats), saving a few `gl.uniform*` calls per static-uniform refresh.
