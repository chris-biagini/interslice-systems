# Trinitron Vertical Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the Trinitron renderer to match the conceptual model of a real Trinitron at the resolution we render at: continuous vertical phosphor stripes softened by the beam's PSF, damper wires as the only intentional horizontal feature, and the per-cell hotspot + per-cell shimmer kernels (which were really a shadow-mask CRT model) removed. Also delete the CPU rendering path and orphaned IS-2200 master-mode machinery.

**Architecture:** Almost entirely deletion. The GPU phosphor shader (`PHOSPHOR_FS` in `docs/trinitron.js`) loses two kernels and four uniforms. The CPU code path (`_initCpu`, `_renderCpu` and helpers — ~300 lines) is removed entirely. The bypass-canvas / master-mode machinery (`bypassCanvas` option, `_masterOn` state, `setMasterMode`, `_bypassCanvas`, localStorage I/O, debug-panel "view CSS fallback" checkbox) is removed since its only consumer (the IS-2200) was already deleted in a prior refactor. The hero config (`docs/index.html`) drops `renderer: 'auto'`, `hotspot`, `cellShimmer`, and gets retuned values for `rowShimmer`, `damperStrength`, and `gapMaskAlpha`. A new stub file `docs/shadow-mask.js` preserves the extracted per-cell GLSL kernels for a future shadow-mask renderer brainstorm.

**Tech Stack:** Plain HTML + inlined CSS + `docs/trinitron.js` IIFE + `docs/shadow-mask.js` (new stub). No build step, no module system, no tests. WebGL2 + WebGL2 extensions `EXT_color_buffer_float` and `OES_texture_float_linear`.

**Spec:** `specs/2026-05-24-trinitron-vertical-resolution-design.md`

**Verification model:** This repo has no automated tests (CLAUDE.md: "No tests, no linters, no package manager"). Each task ends with a browser inspection step before committing. Serve locally with `python3 -m http.server -d docs 8000` and visit `http://localhost:8000`. Toggle modes via DevTools: set `<html data-theme="dark">` or `data-theme="light">` on the `<html>` element. Remove the attribute entirely to fall back to OS preference. Expose the renderer instance for inspection via `window.__trinitronLogo`; the per-effect debug panel is at `?debug=1`.

**DevTools handles:**
- `window.__trinitronLogo` — the hero screen's renderer instance.
- `window.__trinitronLogo.effects` — runtime effect toggles (mutable; takes effect next frame).
- `window.__trinitronLogo.opts` — runtime options (mutable; sliders in the debug panel write these and re-upload static uniforms).

---

## Background

Read first if you haven't seen this codebase: `CLAUDE.md` and `specs/2026-05-24-trinitron-vertical-resolution-design.md`.

Quick orientation:

- `docs/trinitron.js` defines a single `Trinitron` class. The hero (`docs/index.html` around line 2798) instantiates one in dark mode. The class has both a CPU and a GPU rendering backend, selected via the `renderer: 'auto' | 'cpu' | 'gpu'` option. The hero uses `'auto'`, which tries GPU first and falls back to CPU. **This plan deletes the CPU backend.**
- The GPU pipeline runs three main passes per frame — signal upload, phosphor + persistence (MRT), composite — plus three bloom passes. The phosphor shader (`PHOSPHOR_FS`, around lines 45-191) is where the per-cell hotspot and per-cell shimmer live.
- The hero's signal callback paints a substrate, the rotating logo, the wordmark, the CTA, the laser grid, and channel-2/3 content into a source canvas at `viewSize` (~480×170). The renderer takes that canvas as the per-frame input.
- "Triple-activation dark mode" applies to CSS only; the renderer is on/off based on the `start()` / `stop()` calls keyed off `MutationObserver` on `data-theme` + `prefers-color-scheme` listener. No CSS changes in this plan.

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `docs/trinitron.js` | MODIFY | Strip per-cell hotspot kernel, per-cell shimmer hash, CPU rendering path, bypass-canvas / master-mode machinery, stale IS-2200 comments. |
| `docs/shadow-mask.js` | CREATE | Preserve the extracted GLSL kernels from `trinitron.js` for a future shadow-mask CRT renderer. Not loaded by any HTML. |
| `docs/index.html` | MODIFY | Hero config: remove `renderer: 'auto'`, `hotspot`, `cellShimmer`; tune `rowShimmer`, add `damperStrength`, tune `gapMaskAlpha`. |
| Saved memories | MODIFY | Rewrite `feedback_cell_grid_is_intentional.md` (now obsolete); verify `feedback_gap_mask_striations.md` still applies. |

---

## Task 1: Create `docs/shadow-mask.js` stub with extracted GLSL kernels

**Files:**
- Create: `docs/shadow-mask.js`

This task preserves the per-cell hotspot kernel and per-cell shimmer hash from `PHOSPHOR_FS` in a new file, BEFORE the subsequent removal tasks delete them from `trinitron.js`. The file is checked in but not loaded by any HTML — it's a stash for the future shadow-mask renderer brainstorm.

### Steps

- [ ] **Step 1: Read the source kernels**

Open `docs/trinitron.js` and locate:
- The per-cell hotspot kernel: lines ~154-172 of `PHOSPHOR_FS`. Search for the comment `// Per-cell hotspot — vertically extended phosphor "dot."`
- The per-cell shimmer hash: lines ~174-179 of `PHOSPHOR_FS`. Search for `// Per-cell shimmer: stable hash by cell index.`

Note both blocks include their existing inline comments — preserve those verbatim in the stub, the comments encode design intent.

- [ ] **Step 2: Create the stub file**

Create `docs/shadow-mask.js` with the following content:

```javascript
// Shadow-mask CRT phosphor kernels — extracted stash.
//
// This file is a stash for the per-cell phosphor kernels that were
// removed from `docs/trinitron.js` during the "Trinitron vertical
// resolution" refactor (2026-05-24). It is NOT loaded by any HTML and
// is NOT a working renderer.
//
// The kernels below model a SHADOW-MASK CRT (RCA-style, with phosphor
// dots arranged in triangular triads behind a perforated metal mask)
// — not a Trinitron (which has continuous vertical phosphor stripes).
// They were originally written for `trinitron.js` and produced a
// distinctive 2D dot-grid texture; calling that "Trinitron" was a
// historical accident. They're preserved here so the future
// shadow-mask renderer brainstorm starts with the kernel code in
// hand rather than reconstructing it from git history.
//
// References:
// - Design context: `specs/2026-05-24-trinitron-vertical-resolution-design.md`
// - Shadow-mask renderer design: (TBD — separate brainstorm + spec)
//
// (No CPU-path equivalents to extract — the CPU rendering path was
// deleted entirely in the same refactor. The shadow-mask renderer,
// when built, will be GPU-only from day one.)


// ====================================================================
// GLSL fragment: per-cell hotspot
// ====================================================================
// Originally lived in PHOSPHOR_FS in trinitron.js (lines ~154-172
// pre-refactor). Depends on uniforms: uHotspot (float), uHotspotEnabled
// (float gate), uCellSize (vec2), and these local computations from
// earlier in the shader:
//   vec2 px = vUv * uViewSize;
//   int subX = int(mod(px.x, uCellSize.x));
//   int subY = int(mod(px.y, uCellSize.y));
//
// Per-cell hotspot — vertically extended phosphor "dot."
// X is narrow (only the center column of each cell gets any
// boost) so the hotspot aligns with the phosphor stripe.
// Y fades linearly across the cell height: full boost at the
// center row, dropping to ~50% at the cell edges. The result
// reads as a soft vertical streak rather than a single bright
// pixel — matches how an aperture-grille phosphor "slot" lights
// up along its length.
const HOTSPOT_KERNEL_GLSL = `
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
`;


// ====================================================================
// GLSL fragment: per-cell shimmer
// ====================================================================
// Originally lived in PHOSPHOR_FS in trinitron.js (lines ~174-179
// pre-refactor). Depends on uniforms: uCellShimmerAmp (float),
// uCellShimmerEnabled (float gate), uCellSize (vec2), uViewSize (vec2),
// uShimmerSeed (uint), the local `px = vUv * uViewSize`, and an `lcg`
// hash function (see below).
//
// Per-cell shimmer: stable hash by cell index.
const CELL_SHIMMER_KERNEL_GLSL = `
  vec2 cellCoord = floor(px / uCellSize);
  uint cellGridW = uint(uViewSize.x / uCellSize.x);
  uint cellIdx = uint(cellCoord.y) * cellGridW + uint(cellCoord.x);
  float cellShim = 1.0 + uCellShimmerAmp * (2.0 * lcg(cellIdx + uShimmerSeed) - 1.0);
  cellShim = mix(1.0, cellShim, uCellShimmerEnabled);
`;


// ====================================================================
// GLSL helper: LCG hash (also used by per-row shimmer, kept in
// trinitron.js — copied here for self-containment).
// ====================================================================
const LCG_HASH_GLSL = `
  // Deterministic LCG hash → [0,1].
  float lcg(uint seed) {
    uint x = 1664525u * seed + 1013904223u;
    return float(x) * (1.0 / 4294967296.0);
  }
`;
```

- [ ] **Step 3: Verify the stub is inert**

Run from the repo root:

```bash
grep -rn shadow-mask docs/ index.html 2>/dev/null
```

Expected: only `docs/shadow-mask.js` itself in the output, nothing else. The file is checked in but not loaded.

- [ ] **Step 4: Commit**

```bash
git add docs/shadow-mask.js
git commit -m "$(cat <<'EOF'
Stash extracted shadow-mask phosphor kernels in docs/shadow-mask.js

Preserves the per-cell hotspot kernel and per-cell shimmer hash from
PHOSPHOR_FS before the Trinitron vertical-resolution refactor strips
them from trinitron.js. The kernels were always shadow-mask-shaped
(2D dot grid), not Trinitron-shaped (continuous stripes); this file
is the handoff to a future shadow-mask renderer brainstorm. Not
loaded by any HTML.

See specs/2026-05-24-trinitron-vertical-resolution-design.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Remove the per-cell hotspot from `trinitron.js`

**Files:**
- Modify: `docs/trinitron.js` — `PHOSPHOR_FS` shader, options block, effects defaults, debug panel GROUPS, CPU stripe table, static-uniform upload.
- Modify: `docs/index.html` — hero config.

The per-cell hotspot lives in five places. Remove all of them in one task — this is the primary visual change (cell-dot grain on the G stripe disappears).

### Steps

- [ ] **Step 1: Remove the hotspot kernel from the GPU shader**

In `docs/trinitron.js`, locate `PHOSPHOR_FS` (around line 45). In the shader's `void main()` body:

1. Delete the uniforms `uHotspot` and `uHotspotEnabled` (around lines 57 and 67 — verify by searching `uHotspot`).
2. Delete the hotspot kernel block — the chunk starting at the comment `// Per-cell hotspot — vertically extended phosphor "dot."` through the `float hotMul = mix(1.0, hotBoost, uHotspotEnabled);` line (around lines 154-172).
3. In the final stripe expression at the bottom of `main()` (around line 188), change:

   ```glsl
   float cellMod = hotMul * cellShim * rowShim;
   vec3 stripeOut = lerped.rgb * weights * cellMod;
   ```

   to:

   ```glsl
   float cellMod = cellShim * rowShim;
   vec3 stripeOut = lerped.rgb * weights * cellMod;
   ```

   (The `cellShim` removal happens in Task 3; for now leave it in place.)

- [ ] **Step 2: Remove `hotspot` from the options block**

In the constructor's `Object.assign({...}, opts)` (around line 350), find and delete the `hotspot:` option line. Search for `hotspot:` to locate (currently at line 426 or thereabouts):

```javascript
// Beam hotspot — Manhattan-distance brightness boost at the dead-
// center pixel of each cell. With cs=3 this is the (subX=1,
// subY=1) pixel — one of every nine source pixels. Combined with
// cellShimmer, this is what produces the "dot grid" texture that
// makes the rendered image read as phosphor dots through glass.
hotspot: 0.0,
```

Delete the entire option (the multi-line comment AND the value line).

- [ ] **Step 3: Remove `perCellHotspot` from the effects defaults**

In the `this.effects = Object.assign({...}, opts.effects)` (around line 492), delete the `perCellHotspot: true,` line.

- [ ] **Step 4: Remove the hotspot uniform upload**

In `_uploadStaticUniforms` (search for `uniform1f(this._uPhosphor.hotspot` or similar; around line 1184), remove the `uHotspot` upload. Also remove the `uHotspotEnabled` upload from the per-frame uniform setter (search for `hotspotEnabled`; around line 1751 area).

The uniform location lookup in the program-link section (around line 1024) also has a `hotspot:` entry — remove that too. Search for `gl.getUniformLocation(this._progPhosphor, 'uHotspot')`.

- [ ] **Step 5: Remove the hotspot row from the debug panel**

In `_createDebugPanel`'s `GROUPS` array (around line 1292), delete the `perCellHotspot` group item:

```javascript
{ key: 'perCellHotspot',   label: 'per-cell hotspot',
  desc: 'Brightens the dead-center pixel of each cell — beam focus point.',
  params: [{ opt: 'hotspot', min: 0, max: 1.5, step: 0.05, sub: 'amount' }] },
```

- [ ] **Step 6: Remove the hotspot override from the hero config**

In `docs/index.html`, in the `new Trinitron()` call (around line 2798), delete the line:

```javascript
hotspot: 0.24,
```

- [ ] **Step 7: Manual verification — visual**

Start the dev server:

```bash
python3 -m http.server -d docs 8000
```

Open `http://localhost:8000` in a browser. In DevTools, ensure dark mode (`<html data-theme="dark">`). Compare to the pre-task hero (open `main` in another tab, or use git stash):

- The G stripe (middle column of each triad) should no longer have a bright center-row spot.
- The phosphor surface looks subtly less textured. (The cell shimmer in Task 3 will complete this.)
- No console errors. No black canvas. The logo + wordmark + CTA still render.

Visit `http://localhost:8000/?debug=1`. Confirm:

- The "per-cell hotspot" row is gone from the "phosphor" group.

- [ ] **Step 8: Commit**

```bash
git add docs/trinitron.js docs/index.html
git commit -m "$(cat <<'EOF'
Remove per-cell hotspot from Trinitron renderer

The hotspot kernel created a 2D bright-center-row texture on the G
stripe — a shadow-mask-CRT visual, not a Trinitron one. Stripping it
removes one piece of the cell-grid look without changing horizontal
phosphor structure. Kernel preserved in docs/shadow-mask.js.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Remove the per-cell shimmer from `trinitron.js`

**Files:**
- Modify: `docs/trinitron.js` — `PHOSPHOR_FS` shader, options block, effects defaults, debug panel GROUPS, CPU shimmer table (if present), static-uniform upload.
- Modify: `docs/index.html` — hero config.

Same shape as Task 2, for the per-cell shimmer. After this task the phosphor surface should look fully uniform — continuous vertical stripes, no dot grid.

### Steps

- [ ] **Step 1: Remove the per-cell shimmer hash from the GPU shader**

In `docs/trinitron.js`, locate `PHOSPHOR_FS`. In `main()`:

1. Delete the uniforms `uCellShimmerAmp` and `uCellShimmerEnabled` (around lines 58 and 68 — verify by searching).
2. Delete the per-cell shimmer block — the chunk starting at the comment `// Per-cell shimmer: stable hash by cell index.` through the `cellShim = mix(1.0, cellShim, uCellShimmerEnabled);` line (around lines 174-179).
3. Delete the `subY = int(mod(px.y, uCellSize.y));` line (around line 139). After this task the shader no longer references Y-axis cell indexing.
4. In the final stripe expression, change:

   ```glsl
   float cellMod = cellShim * rowShim;
   vec3 stripeOut = lerped.rgb * weights * cellMod;
   ```

   to:

   ```glsl
   vec3 stripeOut = lerped.rgb * weights * rowShim;
   ```

   The `cellMod` intermediate disappears.

- [ ] **Step 2: Remove `cellShimmer` from the options block**

In the constructor's options `Object.assign`, find and delete the `cellShimmer:` option (the multi-line comment + value line):

```javascript
// Per-cell brightness noise. 0 = off. Static per-cell jitter,
// intentionally reasserts the cell grid — that's what makes each
// cell read as a distinct phosphor dot rather than a flat tile.
cellShimmer: 0.0,
```

- [ ] **Step 3: Remove `perCellShimmer` from the effects defaults**

Delete the `perCellShimmer: false,` line in `this.effects` defaults.

- [ ] **Step 4: Remove the cell-shimmer uniform upload**

In `_uploadStaticUniforms`, remove the `uCellShimmerAmp` upload. In the per-frame uniform setter, remove the `uCellShimmerEnabled` upload. In the uniform-location lookup block, remove the `cellShimmerAmp:` entry.

- [ ] **Step 5: Remove the cell-shimmer row from the debug panel**

In the `GROUPS` array, delete:

```javascript
{ key: 'perCellShimmer',   label: 'per-cell shimmer',
  desc: 'Static brightness jitter per cell. Asserts the phosphor-dot grid.',
  params: [{ opt: 'cellShimmer', min: 0, max: 0.2, step: 0.01, sub: 'amount' }] },
```

- [ ] **Step 6: Update the row-shimmer description**

In the same `GROUPS` array, find the `perRowShimmer` entry. Update its `desc`:

```javascript
{ key: 'perRowShimmer',    label: 'per-row shimmer',
  desc: 'Per-scanline brightness noise. The only animated micro-texture in the model.',
  params: [{ opt: 'rowShimmer', min: 0, max: 0.1, step: 0.005, sub: 'amount' }] },
```

- [ ] **Step 7: Remove the cellShimmer override from the hero config**

In `docs/index.html`, delete the line:

```javascript
cellShimmer: 0.04,
```

- [ ] **Step 8: Manual verification — visual**

Reload `http://localhost:8000`. In dark mode, the hero phosphor surface should look fully uniform — continuous vertical stripes, no dot grid, no jitter texture in solid color regions (look at the wordmark and the substrate). This is the chief visual goal of the refactor.

Visit `?debug=1`. Confirm:

- "per-cell shimmer" row is gone.
- "per-row shimmer" description reads "Per-scanline brightness noise. The only animated micro-texture in the model."

- [ ] **Step 9: Commit**

```bash
git add docs/trinitron.js docs/index.html
git commit -m "$(cat <<'EOF'
Remove per-cell shimmer from Trinitron renderer

Static per-cell brightness jitter was the second piece of the
shadow-mask dot-grid texture. With this gone, the Trinitron's
phosphor surface is fully uniform along Y — continuous vertical
stripes with no 2D structure besides the upcoming damper wires.
Hash preserved in docs/shadow-mask.js.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Tune the remaining parameters

**Files:**
- Modify: `docs/index.html` — hero config.

After Tasks 2 + 3 the surface is uniform-strip phosphor, but the OLD damper wire strength (0.62, very visible), OLD gap mask alpha (0.30, dominant grille shadow), and OLD row shimmer (0.012, barely-there) are still in effect. This task retunes them to the "stylized ideal Trinitron" values.

### Steps

- [ ] **Step 1: Update three hero config values**

In `docs/index.html`, in the `new Trinitron()` call (around line 2798), make the following changes:

Find and change:

```javascript
rowShimmer: 0.012,
```

to:

```javascript
rowShimmer: 0.02,
```

Find:

```javascript
gapMaskAlpha: 0.3,
```

to:

```javascript
gapMaskAlpha: 0.15,
```

Add a new line (the hero currently has no override, so it inherits the default of 0.62). Place it next to the other shimmer/damper-related options for cohesion:

```javascript
damperStrength: 0.90,
```

(Reminder: `damperStrength` is fraction-of-brightness-retained at the wire row. 0.90 = wire row keeps 90% brightness = very faint wire shadow.)

- [ ] **Step 2: Manual verification — visual**

Reload `http://localhost:8000`. In dark mode, expected differences from before this task:

- **Damper wires** are now barely visible — two thin horizontal lines at ~32% and ~68% of the canvas height, just a hint. Before: clearly-visible darkening bands.
- **Aperture-grille shadow** (gap mask) is visibly thinner / lighter. Before: noticeable dark hairlines between every triad; now: gentle scaffolding.
- **Per-row shimmer** is slightly more present in solid-color regions — particularly visible in the wordmark and the substrate fill. Before: barely-perceptible; now: faintly alive.

Visit `?debug=1`. Confirm sliders read:

- "per-row shimmer" → 0.020
- "damper wires" darkness slider → ~0.10 (slider value = 1 - damperStrength; 0.90 strength = 0.10 darkness)
- "gap mask" group has no slider (alpha is texture-baked); you can verify the value by inspecting `window.__trinitronLogo.opts.gapMaskAlpha` in the console → should read `0.15`.

- [ ] **Step 3: Commit**

```bash
git add docs/index.html
git commit -m "$(cat <<'EOF'
Retune hero Trinitron for "ideal" character

Row shimmer up (0.012 → 0.02): the only animated micro-texture in
the model, slightly more present. Damper wires very faint (strength
0.90 = ~10% darkening at the wire row): a "vanishing flaw" — the
engineers minimized but couldn't eliminate them. Gap mask halved
(0.30 → 0.15): aperture-grille shadow at the ideal-engineering
pitch.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Delete the CPU rendering path

**Files:**
- Modify: `docs/trinitron.js` — delete `_initCpu`, `_renderCpu`, helpers, `renderer` option, `_mode` field, constructor CPU branch.
- Modify: `docs/index.html` — remove `renderer: 'auto'` from hero config.

The CPU path is ~300 lines of parallel implementation that no consumer relies on. The hero's existing `try { new Trinitron(...) } catch` wrapper handles the WebGL2-unavailable case by silently falling back to the static SVG dark-mode logo + live wordmark. After this task the renderer is GPU-only.

### Steps

- [ ] **Step 1: Delete `_initCpu` and its helpers**

In `docs/trinitron.js`, find `_initCpu` (around line 564). It runs from the method header through the line before `_initGpu` starts (around line 815-820 — verify by reading).

Delete the entire `_initCpu` method and everything it sets up: the CPU canvas context setup, the offscreen `signalCanvas`/`signalCtx`, the three convergence canvases (`_convR`, `_convG`, `_convB`), the stripe lookup tables (`stripeR`, `stripeG`, `stripeB`), the per-cell tables (now empty since Tasks 2+3, but verify nothing references them after deletion).

Look immediately after `_initCpu` for any CPU-only helpers that might have been hoisted there — methods named `_renderCpu`, `_paintFrameCpu`, or similar. If found, delete them too.

Search the file for `_renderCpu` and any other CPU-specific method names; delete them. Search for references to `this.signalCanvas` (the CPU-path source canvas; the GPU path uses `this._signalCanvas` with an underscore prefix) — they should only occur inside CPU code. Search for `this._convR`, `this._convG`, `this._convB`, `this.stripeR`, `this.stripeG`, `this.stripeB` — same.

- [ ] **Step 2: Delete the constructor CPU branch**

In the constructor (around line 530), find this block:

```javascript
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
```

Replace it with:

```javascript
this._initGpu();
```

If `_initGpu` throws (WebGL2 unavailable), the constructor throws; the hero's `try { ... } catch` at index.html:2830 catches and falls back to the existing SVG dark-mode layer. The `_mode` field is gone.

- [ ] **Step 3: Remove the `renderer` option**

In the options block (around line 350), find and delete:

```javascript
renderer: 'cpu',     // 'cpu' | 'gpu' | 'auto' — 'auto' tries gpu, falls back to cpu
```

- [ ] **Step 4: Remove `_mode` references**

Search the file for `this._mode` — any remaining references should be removed (they're all CPU-vs-GPU branches; with one path, the branches collapse). Likely callers: `start()`, `stop()`, possibly `setMasterMode`. Inline the GPU branch in each.

If any method branches on `this._mode === 'cpu'` to do CPU-specific cleanup, delete that branch entirely.

- [ ] **Step 5: Update hero config**

In `docs/index.html`, in the `new Trinitron()` call, delete the line:

```javascript
renderer: 'auto',
```

- [ ] **Step 6: Manual verification — visual (happy path)**

Reload `http://localhost:8000`. In dark mode, the hero should render exactly as before this task — no visual change (the CPU path wasn't being used; GPU was always the active path on any modern browser).

In the browser console, `window.__trinitronLogo._mode` should now be `undefined`. `window.__trinitronLogo._gl` should be a `WebGL2RenderingContext`.

- [ ] **Step 7: Manual verification — WebGL2-unavailable fallback**

In Chromium, open `chrome://flags`, search for "WebGL 2.0", and disable it. (In Firefox, set `webgl.disabled = true` via about:config.) Restart the browser and reload `http://localhost:8000`.

Expected:

- Light mode: unchanged (canvas was never used).
- Dark mode: the static SVG dark-mode logo (`.m-dark` layer) is visible. The live wordmark renders as cream-colored text on the dark page background. The CTA is the regular HTML CTA. Nothing animates inside the brand box. No JS errors except an expected warning or thrown error from `_initGpu`.
- The `try { ... } catch` in `index.html` catches the throw silently; `window.__trinitronLogo` should be `undefined` in this state.

Re-enable WebGL2 before continuing.

- [ ] **Step 8: Commit**

```bash
git add docs/trinitron.js docs/index.html
git commit -m "$(cat <<'EOF'
Delete the CPU rendering path from trinitron.js

The CPU backend is a parallel implementation that no consumer
relies on — modern browsers have WebGL2 universally, and the hero's
existing try/catch silently falls back to the static SVG dark-mode
logo when GPU init fails. Removing the CPU path drops ~300 lines,
eliminates an ongoing GPU/CPU divergence risk, and simplifies every
future shader change.

The renderer is now GPU-only. The 'renderer' option, the _mode
field, and the construct-time CPU fallthrough are gone. The hero
config no longer passes renderer: 'auto'.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Delete the bypass-canvas / master-mode machinery

**Files:**
- Modify: `docs/trinitron.js` — `bypassCanvas` option, `_masterOn` state, `setMasterMode`, `_bypassCanvas`, `_bypassCtx`, localStorage I/O, debug panel "view CSS fallback" checkbox, paint-time bypass branches.

The master-mode machinery was IS-2200's "CRT power-on" toggle. The IS-2200 was deleted in the hero-trinitron consolidation; the only remaining consumer is the debug panel's "view CSS fallback" checkbox, which itself is being removed in this task.

### Steps

- [ ] **Step 1: Delete the `bypassCanvas` option**

In the options block, find and delete (around line 466-470):

```javascript
// Whether the GPU path should create a sibling 2D canvas
// for master-mode bypass rendering. Required when a UI
// element (e.g., the IS-2200 power sticker) calls
// setMasterMode(false). Skip when there's no toggle UI.
bypassCanvas: true,
```

- [ ] **Step 2: Delete the `_masterOn` field and localStorage read**

In the constructor (around lines 548-556), find:

```javascript
// Master A/B initial state. Default on. Read from localStorage so the
// user's last choice persists across reloads.
this._masterOn = true;
try {
  const stored = localStorage.getItem('interslice-systems:is2200:crt-mode');
  if (stored === 'off') this._masterOn = false;
} catch (e) {
  // Default to on if storage unavailable.
}
```

Delete the entire block.

- [ ] **Step 3: Delete `setMasterMode` method and its localStorage write**

Find `setMasterMode` (around line 1925). Delete the entire method, including its `localStorage.setItem` call.

- [ ] **Step 4: Delete bypass-canvas creation in `_initGpu`**

In `_initGpu`, find the block creating `_bypassCanvas` (around lines 1111-1140):

```javascript
// Bypass mode draws the signal canvas directly to the visible
// canvas via a separate 2D context. WebGL2 already owns this.canvas,
// so we use a hidden secondary canvas overlaid via CSS and toggle
// between them via display:none / display:block.
// Skipped when opts.bypassCanvas is false (e.g., for the dark-mode
// logo, which has no master-mode toggle UI and would have its
// bypass canvas mis-positioned by the .trinitron absolute layout).
if (this.opts.bypassCanvas) {
  this._bypassCanvas = document.createElement('canvas');
  // ... through ...
  parent.appendChild(this._bypassCanvas);
}
```

Delete the entire `if (this.opts.bypassCanvas) { ... }` block (including its comment block).

- [ ] **Step 5: Delete bypass-canvas teardown in `_destroyGpu`**

In `_destroyGpu` (around lines 1490-1495), find:

```javascript
if (this._bypassCanvas && this._bypassCanvas.parentNode) {
  this._bypassCanvas.parentNode.removeChild(this._bypassCanvas);
}
this._bypassCanvas = null;
```

Delete this block (and the corresponding `_bypassCtx = null` if present).

- [ ] **Step 6: Delete bypass branches in the per-frame paint**

In the per-frame paint (search for `!this._masterOn && this._bypassCanvas`; around line 1682), find:

```javascript
if (!this._masterOn && this._bypassCanvas) {
  this._bypassCanvas.style.display = 'block';
  // ...
  this._bypassCtx.clearRect(...)
  // ...
}
```

and (a few lines later) the `else` branch that hides the bypass canvas:

```javascript
if (this._bypassCanvas) this._bypassCanvas.style.display = 'none';
```

Delete both — the renderer always paints to the WebGL canvas, no toggle.

- [ ] **Step 7: Delete the "view CSS fallback" checkbox from the debug panel**

In `_initDebugOverlay` (search for `view CSS fallback`; around line 1283), find the row that creates the bypass checkbox:

```javascript
// ... bypassRow setup ...
bypassRow.appendChild(bypassCb);
const bypassLbl = document.createElement('span');
bypassLbl.textContent = 'view CSS fallback';
bypassRow.appendChild(bypassLbl);
panel.appendChild(bypassRow);
```

Delete the entire `bypassRow` creation block (likely a few lines above the snippet shown; trace back to where `bypassRow` is first declared).

- [ ] **Step 8: Manual verification**

Reload `http://localhost:8000`. The hero should render exactly as before — no visual change.

In the console: `window.__trinitronLogo.setMasterMode` should be `undefined`. `window.__trinitronLogo._bypassCanvas` should be `undefined`. `window.__trinitronLogo._masterOn` should be `undefined`.

Visit `?debug=1`. Confirm:

- The "view CSS fallback" checkbox at the top of the panel is gone.
- The rest of the panel still works.

- [ ] **Step 9: Commit**

```bash
git add docs/trinitron.js
git commit -m "$(cat <<'EOF'
Delete bypass-canvas + master-mode machinery from trinitron.js

The bypassCanvas option, _masterOn state, setMasterMode method,
_bypassCanvas / _bypassCtx fields, and the localStorage I/O of
'interslice-systems:is2200:crt-mode' were IS-2200's CRT-power-on
toggle. The IS-2200 was deleted in the hero-trinitron consolidation;
the only remaining consumer was the debug panel's "view CSS
fallback" checkbox, removed in the same commit. Stale localStorage
values on user devices remain inert.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Clean up stale IS-2200 references in comments

**Files:**
- Modify: `docs/trinitron.js` — comment-only cleanup at lines 143, 256, 287, 468 (deleted in Task 6), 480, 876.

Small finishing pass. After the renderer is genuinely Trinitron-and-only-Trinitron, the option comments and shader comments referencing the IS-2200 are misleading to future readers. Update them.

### Steps

- [ ] **Step 1: Find remaining IS-2200 references**

Run from the repo root:

```bash
grep -n -E "IS-?2200|is2200" docs/trinitron.js
```

You'll get a handful of comment lines. The ones at line 468 (the `bypassCanvas` comment) and line 552 (the localStorage read) are already removed in Task 6 — verify they don't show up.

- [ ] **Step 2: Rewrite each reference**

For each remaining hit, replace the IS-2200 reference with a generic phrase or remove it:

- Line ~143 (inside `PHOSPHOR_FS`): the comment `// matches original IS-2200 identity` — replace with `// matches the original 2-stripe identity` or drop the parenthetical entirely.
- Line ~256 (inside `COMPOSITE_FS`): `(e.g., IS-2200 CRT screen)` — replace with `(the default for any opaque CRT face)`.
- Line ~287: `(IS-2200 CRT screen)` — replace with `(any opaque CRT face)`.
- Line ~480: `The IS-2200 wants opaque` — replace with `Opaque is the default` or rewrite the surrounding two-line example.
- Line ~876: `(e.g., the IS-2200's 1280-source / 640-canvas config)` — replace with `(when source dimensions exceed canvas dimensions, e.g. for a large signal painted onto a small display)`.

Line numbers will have drifted from the original spec due to Tasks 2-6 deletions. Use grep to locate, read surrounding context, and rewrite each one carefully.

- [ ] **Step 3: Verify no IS-2200 references remain**

```bash
grep -n -E "IS-?2200|is2200" docs/trinitron.js
```

Expected: no output.

Also check `docs/tokens.css` (the only other file likely to mention it):

```bash
grep -n -E "IS-?2200|is2200" docs/tokens.css
```

If a reference remains there, decide whether it's still meaningful (it might refer to a token historically used for the IS-2200 that's still relevant for other things) — if not, drop the parenthetical.

- [ ] **Step 4: Visual check**

Reload `http://localhost:8000`. Confirm no behavior change. (Comment-only changes — no runtime effect.)

- [ ] **Step 5: Commit**

```bash
git add docs/trinitron.js docs/tokens.css
git commit -m "$(cat <<'EOF'
Drop stale IS-2200 references from trinitron.js comments

The IS-2200 was deleted in the hero-trinitron consolidation; the
machinery it depended on was deleted in the preceding commit. The
remaining mentions in shader and option comments were misleading
to future readers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Update saved memories

**Files:**
- Modify: `/home/chris/.claude/projects/-home-chris-Projects-interslice-systems/memory/feedback_cell_grid_is_intentional.md`
- Verify (and possibly modify): `/home/chris/.claude/projects/-home-chris-Projects-interslice-systems/memory/feedback_gap_mask_striations.md`

The cell-grid memory becomes actively misleading after this refactor (it tells future sessions to defend the dot grain — which is gone). The gap-mask memory may still apply (the gap mask is unchanged in geometry, only its alpha dropped) but should be re-read with the new alpha value to verify the description still fits.

### Steps

- [ ] **Step 1: Read both memory files**

```bash
cat ~/.claude/projects/-home-chris-Projects-interslice-systems/memory/feedback_cell_grid_is_intentional.md
cat ~/.claude/projects/-home-chris-Projects-interslice-systems/memory/feedback_gap_mask_striations.md
```

- [ ] **Step 2: Rewrite the cell-grid memory**

Replace the content of `feedback_cell_grid_is_intentional.md` with:

```markdown
---
name: Trinitron is continuous stripes, not cell-grid
description: The per-cell hotspot + per-cell shimmer that asserted a phosphor-dot grid were a shadow-mask CRT visual, not a Trinitron one — removed 2026-05-24
type: feedback
---

The Trinitron renderer's phosphor is continuous vertical stripes — there is no 2D cell-grid texture. The per-cell hotspot kernel + per-cell shimmer that used to create a phosphor-dot grain were a shadow-mask CRT visual (RCA-style triangular phosphor triads), not a Trinitron one. They were removed in the 2026-05-24 vertical-resolution refactor.

**Why:** At the resolution we render (160 horizontal triads × 170 source rows on the hero), the source-pixel grid is already roughly square-pixel-equivalent to a real Trinitron's beam PSF, so any 2D structure is asserting something that wouldn't exist on a physical Trinitron. The "stylized ideal" framing chose continuous stripes + asymmetric beam spread (sharp X, soft Y) + vanishingly-faint damper wires as the only intentional vertical features.

**How to apply:** Do not reintroduce per-cell hotspot, per-cell shimmer, or any other Y-axis quantization to the Trinitron's phosphor model. The extracted kernels are preserved in `docs/shadow-mask.js` for a future shadow-mask renderer brainstorm — they belong THERE, not in `trinitron.js`. See `specs/2026-05-24-trinitron-vertical-resolution-design.md` and `plans/2026-05-24-trinitron-vertical-resolution-implementation.md` for the full rationale.
```

- [ ] **Step 3: Verify the gap-mask memory**

Re-read `feedback_gap_mask_striations.md`. The memory describes the gap mask covering the whole stripe region INCLUDING the halo bleed (intentional aesthetic). After this refactor:

- Gap-mask geometry is **unchanged** (still covers the full stripe region — the texture-baking code is untouched).
- Gap-mask alpha is **0.15 instead of 0.30** (halved).

The "striations bleed into the halo" observation should still hold — the geometry didn't change. The description text in the memory may not need an update unless it specifically cites the old alpha value.

If the memory text references the old 0.30 value, update it to 0.15 (and note the change). If not, leave the memory untouched and just confirm it's still accurate.

- [ ] **Step 4: Verify MEMORY.md index lines still point at the right files**

Re-read `MEMORY.md` and confirm the entries for the two updated memories still describe them accurately. Update the one-line hooks if the rewrites changed the gist.

For `feedback_cell_grid_is_intentional.md` the hook was:
```
- [Cell grid is intentional](feedback_cell_grid_is_intentional.md) — Per-cell hotspot + shimmer make the phosphor-dot texture; do NOT remove them as "grid artifacts"
```

Replace with:
```
- [Trinitron is continuous stripes](feedback_cell_grid_is_intentional.md) — Per-cell hotspot + shimmer were shadow-mask carryovers; removed in the vertical-resolution refactor
```

(Filename stays the same so old references don't break; the human-readable label changes.)

- [ ] **Step 5: No commit needed**

Memory files live outside the repo. Nothing to commit. (The MEMORY.md update is also outside the repo.)

---

## Self-review checklist (for the engineer)

Before declaring the refactor complete, sanity-check:

- [ ] `grep -n -E "hotspot|cellShimmer|_masterOn|setMasterMode|_bypassCanvas|_initCpu|_renderCpu|renderer:|_mode" docs/trinitron.js` returns no hits in code (comments may exist in shadow-mask.js — that's expected).
- [ ] `grep -n -E "hotspot|cellShimmer|renderer:" docs/index.html` returns no hits in the hero `new Trinitron()` call.
- [ ] `grep -rn shadow-mask docs/` returns only `docs/shadow-mask.js` itself.
- [ ] Hero renders correctly in dark mode (continuous stripes, faint damper wires, thin gap mask, alive-feeling row shimmer in solid colors).
- [ ] Hero renders correctly in light mode (unchanged from main).
- [ ] `?debug=1` panel shows: no "per-cell hotspot", no "per-cell shimmer", no "view CSS fallback". "per-row shimmer" reads 0.020, "damper wires" darkness reads ~0.10.
- [ ] Channel cycle (INTERSLICE → DEMO REEL → PONG) works and looks consistent across channels.
- [ ] With WebGL2 disabled, the hero shows the static SVG dark-mode fallback + live wordmark; no JS errors louder than a single thrown error in the console.
- [ ] No CSS or HTML changes beyond the hero config block in `index.html`.
- [ ] All 7 commits land cleanly (1 stub, 1 hotspot, 1 shimmer, 1 retune, 1 CPU removal, 1 master-mode removal, 1 IS-2200 comment cleanup). Memory updates are local-machine only and have no commit.

If anything fails, fix it in a follow-up commit on the same branch rather than amending. Don't push to `main` (the harness blocks it anyway). Standing authorization is to commit and merge to main when the refactor is verified end-to-end.
