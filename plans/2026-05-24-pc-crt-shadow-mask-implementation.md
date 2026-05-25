# PC-CRT Shadow-Mask Renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second CRT renderer to the hero — an idealized PC-CRT delta-triad shadow-mask — selectable via the `?crt=shadow-mask` URL parameter. Trinitron remains the default; no UI changes; same channel painters under either renderer.

**Architecture:** New peer file `docs/shadow-mask.js` exposes a `ShadowMask` class structurally cloned from `Trinitron`. The differences are: (a) a new `PHOSPHOR_FS` that does 2D hex-tiled delta-triad dot decomposition instead of 1D stripe decomposition; (b) the `COMPOSITE_FS` is slimmed (no gap-mask sampler); (c) damper-wire and gap-mask plumbing is removed throughout; (d) defaults retuned for shadow-mask character. `docs/index.html` gains a `<script src="shadow-mask.js">` tag and one URL-param branch in `createTrinitron()` to instantiate the right class.

**Tech Stack:** Plain HTML + inlined CSS + two IIFE JS files (`docs/trinitron.js`, `docs/shadow-mask.js`). No build step, no module system, no tests. WebGL2 with `EXT_color_buffer_float` and `OES_texture_float_linear`.

**Spec:** `specs/2026-05-24-pc-crt-shadow-mask-design.md`

**Verification model:** This repo has no automated tests (CLAUDE.md: "No tests, no linters, no package manager"). Each task ends with a browser inspection step before committing. Serve locally with `python3 -m http.server -d docs 8000` and visit `http://localhost:8000/`. Force dark mode by setting `<html data-theme="dark">` in DevTools. Open `?crt=shadow-mask` to exercise the new renderer once dispatch lands in Task 6.

**DevTools handles after implementation:**
- `window.__crt` — the active hero renderer (either class).
- `window.__trinitronLogo` — back-compat alias for `__crt` when Trinitron is active; `undefined` when ShadowMask is active.
- `window.__crt.effects` — runtime effect toggles (mutable; takes effect next frame).
- `window.__crt.opts` — runtime options (mutable; debug-panel sliders write here).

---

## Background

Read first if you haven't seen this codebase: `CLAUDE.md` and `specs/2026-05-24-pc-crt-shadow-mask-design.md`.

Quick orientation:

- `docs/trinitron.js` defines a single `Trinitron` class (~1550 lines). The hero (`docs/index.html` near line 2797) instantiates one in dark mode via a function `createTrinitron(layout)`. The class wraps a WebGL2 pipeline: signal canvas → upload to GPU → phosphor + persistence pass (MRT) → composite pass, plus three bloom passes.
- The hero's signal callback paints substrate + rotating logo + wordmark + CTA + laser grid + per-channel content into a source canvas at `viewSize` (~480×170). The renderer takes that canvas as the per-frame input.
- "Triple-activation dark mode" applies to CSS only; the renderer is `start()`/`stop()`-toggled from a `MutationObserver` on `data-theme` plus a `prefers-color-scheme` listener. No CSS changes in this plan.
- The current `docs/shadow-mask.js` is a 90-line *stash* of GLSL kernels extracted in the prior refactor (2026-05-24 vertical-resolution). This plan **replaces** it with a real renderer; the stashed kernels are not used (see spec § "Why this approach over the stash kernels").

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `docs/shadow-mask.js` | REPLACE | Was a 90-line GLSL kernel stash. Becomes a full peer renderer to `Trinitron`: the `ShadowMask` class with delta-triad phosphor decomposition, no damper wires, no gap mask. |
| `docs/trinitron.js` | UNCHANGED | Stays exactly as-is. |
| `docs/index.html` | MODIFY | Add `<script src="shadow-mask.js">` tag. Inside `createTrinitron()`, parse `?crt=` URL param and dispatch to `Trinitron` or `ShadowMask` with the appropriate options. Expose `window.__crt`. |
| Saved memories | MODIFY | Update `trinitron_renderer.md` and `feedback_cell_grid_is_intentional.md` to note shadow-mask.js is now a sibling renderer and `window.__crt` is the canonical handle. |

---

## Task 1: Scaffold `shadow-mask.js` as a renamed copy of `trinitron.js`

**Files:**
- Replace: `docs/shadow-mask.js`
- Modify: `docs/index.html` (add `<script src>` tag near line 1395)

This task overwrites the stash file with a verbatim copy of `trinitron.js`, renames the class and the global, and wires the script tag. The new file is loaded by every page but not yet used by any caller — Trinitron stays the active renderer at every URL.

### Steps

- [ ] **Step 1: Copy the trinitron.js content into shadow-mask.js, with two renames**

Overwrite `docs/shadow-mask.js` with the exact contents of `docs/trinitron.js`, with **only** these two textual changes:
- `class Trinitron` → `class ShadowMask`
- `window.Trinitron = Trinitron;` → `window.ShadowMask = ShadowMask;`

Leave every other line — comments, shader strings, helper functions, the entire IIFE wrapper — exactly as it appears in trinitron.js. This is the "copy-shared scaffolding" architecture from the spec; the per-renderer differences come in subsequent tasks.

Verify with `diff <(sed 's/Trinitron/ShadowMask/g' docs/trinitron.js) docs/shadow-mask.js` — the diff should be empty.

- [ ] **Step 2: Add the script tag to index.html**

In `docs/index.html`, find the existing `<script src="trinitron.js">` tag (around line 1395):

```html
<script src="trinitron.js"></script>
<script src="sprinkles.js"></script>
```

Insert a `shadow-mask.js` script tag immediately after the trinitron one:

```html
<script src="trinitron.js"></script>
<script src="shadow-mask.js"></script>
<script src="sprinkles.js"></script>
```

- [ ] **Step 3: Browser verification**

Start the dev server: `python3 -m http.server -d docs 8000` (in a separate terminal; leave running across tasks).

Open `http://localhost:8000/`, force dark mode in DevTools (`<html data-theme="dark">`).

Verify:
- The hero looks identical to before. Trinitron is still rendering.
- DevTools console shows no errors.
- `window.Trinitron` and `window.ShadowMask` are both defined.
- `typeof window.ShadowMask === 'function'`.

- [ ] **Step 4: Commit**

```bash
git add docs/shadow-mask.js docs/index.html
git commit -m "$(cat <<'EOF'
Scaffold shadow-mask.js as a peer to trinitron.js

Replaces the 90-line GLSL kernel stash with a full copy of trinitron.js,
renamed to the ShadowMask class. Loaded by index.html but not yet
dispatched to; Trinitron remains the active renderer at every URL.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Remove damper-wire code from `shadow-mask.js`

**Files:**
- Modify: `docs/shadow-mask.js`

Damper wires are aperture-grille-specific (the two horizontal stabilizer strands across a Trinitron). Shadow-mask CRTs don't have them. This task removes the four touchpoints from `shadow-mask.js`.

### Steps

- [ ] **Step 1: Remove damper-wire option fields from constructor defaults**

In `docs/shadow-mask.js`, find the constructor's `Object.assign({ ... }, opts)` block (around line 398-399 — same line numbers as trinitron.js since the file is a verbatim copy). Delete these lines:

```js
        damperWires: [0.32, 0.68],
        damperStrength: 0.62,
```

Including their preceding comment block (about damper-wire fractional Y positions). Keep the comment delimiter context above and below — only the option fields and their dedicated comment go.

- [ ] **Step 2: Remove the damper-wire effect toggle**

In the `this.effects = Object.assign({ ... }, opts.effects || {})` block (around line 474), delete:

```js
        // Damper wires — Trinitron's two horizontal stabilizer strands.
        // On by default for any Trinitron sim worth the name; the
        // wires only show when opts.damperWires has positions in it
        // (default [0.32, 0.68]) and damperStrength < 1.
        damperWires: true,
```

- [ ] **Step 3: Remove the signal-canvas damper-wire stamping**

In `_renderGpu` (around line 1289-1299), delete the entire block that stamps the damper wires:

```js
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
```

And its preceding comment about damper-wire baking.

- [ ] **Step 4: Remove the damper-wire debug-panel row**

In the `GROUPS` array inside `_createDebugPanel` (around line 931-933), delete:

```js
            { key: 'damperWires',      label: 'damper wires',
              desc: 'Two horizontal stabilizer strands across the aperture grille. The Trinitron signature.',
              params: [{ opt: '__damperDarkness', min: 0, max: 1, step: 0.05, sub: 'darkness' }] },
```

- [ ] **Step 5: Remove the damper-wire synthetic-opt accessor**

In the debug-panel's `readVal` and `writeVal` helpers (around line 982-991), delete the `__damperDarkness` cases:

In `readVal`:
```js
        if (opt === '__damperDarkness')   return 1 - (this.opts.damperStrength ?? 0);
```

In `writeVal`, find the matching `__damperDarkness` write branch and remove it. (If it's inside an `else if` chain, collapse appropriately.)

- [ ] **Step 6: Browser verification**

Reload `http://localhost:8000/`. Verify Trinitron still renders correctly (the changes are only in shadow-mask.js, which isn't being instantiated yet).

In DevTools console, instantiate a ShadowMask in the canvas to sanity-check no JS errors during construction:

```js
const cv = document.querySelector('canvas.hero-screen');
const tmp = new ShadowMask(cv, {
  viewSize: [480, 170],
  canvasSize: [480, 170],
  signal: (ctx) => { ctx.fillStyle = '#fff'; ctx.fillText('TEST', 100, 50); },
});
tmp.destroy();
```

Expected: no console errors. (The construction may produce a black canvas; we're only checking that nothing throws.)

- [ ] **Step 7: Commit**

```bash
git add docs/shadow-mask.js
git commit -m "$(cat <<'EOF'
Strip damper-wire code from shadow-mask.js

Damper wires are aperture-grille-specific. Removed from options, effects,
signal-canvas stamping, debug panel, and synthetic-opt accessor.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Remove gap-mask code from `shadow-mask.js` and slim `COMPOSITE_FS`

**Files:**
- Modify: `docs/shadow-mask.js`

The shadow-mask's phosphor pass already produces fully black between-dot regions (weights = 0 there), so the post-composite gap-mask multiply isn't needed. This task removes all gap-mask code and slims the composite shader.

### Steps

- [ ] **Step 1: Remove gap-mask option fields**

In the constructor's options `Object.assign({ ... }, opts)` (around lines 369-382), delete:

```js
        gapMaskAlpha: 0,
        // (and its comment about period semantics)
        gapMaskPeriod: 2,
```

Delete the surrounding comments about gap-mask too.

- [ ] **Step 2: Remove the gap-mask effect toggle**

In `this.effects = Object.assign({ ... }, ...)` (around line 482), delete:

```js
        gapMask: false,
```

Keep the surrounding comment context (`selectiveBloom` and the comment header above `selectiveBloom`) intact.

- [ ] **Step 3: Slim `COMPOSITE_FS` — remove gap-mask sampler and multiply**

In the `COMPOSITE_FS` shader string (around line 165 onward), make these GLSL-source edits:

Remove the uniform declaration:
```glsl
uniform sampler2D uGapMask;
```

Remove the enabled flag:
```glsl
uniform float uGapMaskEnabled;
```

Find the gap-mask sample + multiply lines inside `main()`. They look roughly like:
```glsl
  vec4 gapMaskColor = texture(uGapMask, vec2(sampleUv.x, 0.0));
  vec3 maskedColor = mix(stripeColor, stripeColor * gapMaskColor.rgb, uGapMaskEnabled);
```

(Exact variable names may differ — search for `uGapMask` in the shader source.) Delete those lines and update any downstream reference to `maskedColor` to use the un-masked `stripeColor` directly.

- [ ] **Step 4: Remove gap-mask uniform-location cache entries**

In the `this._uComposite = { ... }` block (around line 689-712), delete:

```js
        gapMask:           gl.getUniformLocation(this._progComposite, 'uGapMask'),
        gapMaskEnabled:    gl.getUniformLocation(this._progComposite, 'uGapMaskEnabled'),
```

- [ ] **Step 5: Remove `_texGapMask` construction**

In `_initGpu` (around lines 1154-1186), delete the entire block that creates the `_texGapMask` texture. It begins with `// GAP MASK: vertical-line pattern at twice the source resolution.` and ends after the `gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);` call.

Also remove the `this._texGapMask = gl.createTexture();` declaration and any `this._texGapMask` references in `_destroyGpu` (search for `_texGapMask` in the whole file).

- [ ] **Step 6: Remove gap-mask uniform uploads (static and per-frame)**

In `_uploadStaticUniforms`, find and delete:
```js
      gl.uniform1i(this._uComposite.gapMask,  3);
```

In the per-frame upload section of `_renderGpu`, find and delete:
```js
      gl.uniform1f(this._uComposite.gapMaskEnabled,   this.effects.gapMask        ? 1 : 0);
```

Find and delete any `gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this._texGapMask);` in the composite-pass binding block.

- [ ] **Step 7: Remove the gap-mask debug-panel row**

In the `GROUPS` array (around line 944), delete:

```js
            { key: 'gapMask',        label: 'gap mask',
              desc: 'Dark vertical lines between stripes. Texture-baked; alpha fixed at init.' },
```

- [ ] **Step 8: Browser verification**

Reload the page. Verify Trinitron still renders. In DevTools console, repeat the test construction from Task 2 Step 6 — should still construct without errors.

Also check that the COMPOSITE_FS shader compiles cleanly: open `?debug=1` (in default URL, so Trinitron's debug panel shows). No compile errors. Then in the console, try compiling ShadowMask's composite shader by constructing-and-destroying a ShadowMask instance per Task 2 Step 6. No compile errors expected.

- [ ] **Step 9: Commit**

```bash
git add docs/shadow-mask.js
git commit -m "$(cat <<'EOF'
Strip gap-mask code from shadow-mask.js, slim COMPOSITE_FS

The delta-triad phosphor pass produces fully black between-dot regions
already; the post-composite gap-mask multiply isn't needed. Removes
options, effects, uniforms, texture generation, sampler binding, and
debug-panel row, plus the gap-mask block from COMPOSITE_FS.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Replace `PHOSPHOR_FS` with the delta-triad shader and add `dotRadiusFrac` plumbing

**Files:**
- Modify: `docs/shadow-mask.js`

This is the load-bearing task. Replaces the 1D stripe decomposition with 2D hex-tiled delta-triad dot rendering. Also drops `phosphorCoupling` from the shadow-mask shader (between-dot is fully black; no coupling).

### Steps

- [ ] **Step 1: Replace the entire `PHOSPHOR_FS` shader string**

In `docs/shadow-mask.js`, find the `const PHOSPHOR_FS = \`#version 300 es ... \`;` declaration (starts around line 45). Replace the ENTIRE string content (from `#version 300 es` to the closing backtick) with:

```glsl
#version 300 es
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
uniform float uRowShimmerAmp;
uniform uint uShimmerSeed;
uniform float uBeamSpreadPx;
uniform float uBeamSpreadVerticalPx;
uniform float uDotRadiusFrac;
uniform float uStripeEnabled;
uniform float uPersistenceEnabled;
uniform float uConvergenceEnabled;
uniform float uRowShimmerEnabled;
uniform float uBeamSpreadEnabled;

layout(location = 0) out vec4 oPhosphor;
layout(location = 1) out vec4 oPersistenceNext;

// Deterministic LCG hash → [0,1].
float lcg(uint seed) {
  uint x = 1664525u * seed + 1013904223u;
  return float(x) * (1.0 / 4294967296.0);
}

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
  vec2 dR = (uConvergenceR / uViewSize) * uConvergenceEnabled;
  vec2 dG = (uConvergenceG / uViewSize) * uConvergenceEnabled;
  vec2 dB = (uConvergenceB / uViewSize) * uConvergenceEnabled;

  float beamSpreadH = uBeamSpreadPx * uBeamSpreadEnabled;
  float beamSpreadV = max(beamSpreadH, uBeamSpreadVerticalPx * uBeamSpreadEnabled);
  float sR = sampleBeamSpread(uSignal, vUv + dR, beamSpreadH, beamSpreadV).r;
  float sG = sampleBeamSpread(uSignal, vUv + dG, beamSpreadH, beamSpreadV).g;
  float sB = sampleBeamSpread(uSignal, vUv + dB, beamSpreadH, beamSpreadV).b;
  float sA = sampleBeamSpread(uSignal, vUv, beamSpreadH, beamSpreadV).a;
  vec4 live = vec4(sR, sG, sB, sA);

  vec4 prev = texture(uPersistencePrev, vUv);
  float dr = uPersistence * uPersistenceEnabled;
  vec4 lerped = prev * dr + live * (1.0 - dr);

  oPersistenceNext = lerped;

  vec2 px = vUv * uViewSize;

  // Delta-triad hex tile lookup. Every other row is x-shifted by half
  // a cell width; one dot per cell.
  int row = int(floor(px.y / uCellSize.y));
  float rowShift = float(row & 1) * uCellSize.x * 0.5;
  int col = int(floor((px.x - rowShift) / uCellSize.x));

  // (col - row) mod 3 produces the delta-triad arrangement: every
  // triangle of 3 nearby dots is one R + one G + one B. The +3-then-mod
  // dance is GLSL int mod's negative-result safety net.
  int colorIdx = ((col - row) % 3 + 3) % 3;

  // Radial soft-circle falloff from the cell center.
  vec2 cellCenter = vec2(
    (float(col) + 0.5) * uCellSize.x + rowShift,
    (float(row) + 0.5) * uCellSize.y
  );
  float dist = length(px - cellCenter);
  float dotRadius = uCellSize.x * uDotRadiusFrac;
  float dotFalloff = smoothstep(dotRadius, dotRadius * 0.5, dist);

  // Only the lit channel emits — between dots, weights = 0 → fully
  // black before bloom. No phosphor coupling: the metal mask absorbs
  // between-dot electrons cleanly. mix() honors the stripeProfile
  // toggle: OFF (debug-panel only) paints the raw signal everywhere.
  vec3 weights = vec3(0);
  weights[colorIdx] = dotFalloff;
  weights = mix(vec3(1.0), weights, uStripeEnabled);

  // Per-row shimmer — universal beam-current ripple, same hash as
  // Trinitron's. uShimmerSeed advances per-frame in _renderGpu.
  uint rowIdx = uint(row);
  float rowShim = 1.0 + uRowShimmerAmp * (2.0 * lcg(rowIdx * 4099u + uShimmerSeed) - 1.0);
  rowShim = mix(1.0, rowShim, uRowShimmerEnabled);

  vec3 stripeOut = lerped.rgb * weights * rowShim;
  oPhosphor = vec4(stripeOut, lerped.a);
}
```

Two things to notice vs. the Trinitron shader:
- The `uPhosphorCoupling` and `uCouplingEnabled` uniforms are GONE. No phosphor coupling on shadow-mask.
- The new `uDotRadiusFrac` uniform — set externally via opts, default 0.30.

- [ ] **Step 2: Remove `phosphorCoupling`/`couplingEnabled` from the uniform-location cache**

In `_initGpu` (around line 658-678), find `this._uPhosphor = { ... }` and delete the two entries:

```js
        phosphorCoupling:     gl.getUniformLocation(this._progPhosphor, 'uPhosphorCoupling'),
        couplingEnabled:      gl.getUniformLocation(this._progPhosphor, 'uCouplingEnabled'),
```

Add the new entry for `dotRadiusFrac`:

```js
        dotRadiusFrac:        gl.getUniformLocation(this._progPhosphor, 'uDotRadiusFrac'),
```

- [ ] **Step 3: Remove `phosphorCoupling` from static-uniform upload, add `dotRadiusFrac`**

In `_uploadStaticUniforms` (around line 1202), find and delete:

```js
      gl.uniform1f(this._uPhosphor.phosphorCoupling, this.opts.phosphorCoupling ?? 0.35);
```

Add nearby (e.g., after the `beamSpreadVerticalPx` upload):

```js
      gl.uniform1f(this._uPhosphor.dotRadiusFrac,        this.opts.dotRadiusFrac ?? 0.30);
```

- [ ] **Step 4: Remove `couplingEnabled` from per-frame upload**

In the per-frame upload section of `_renderGpu` (around line 1357-1362), find and delete:

```js
      gl.uniform1f(this._uPhosphor.couplingEnabled,    this.effects.phosphorCoupling ? 1 : 0);
```

- [ ] **Step 5: Remove `phosphorCoupling` option from constructor defaults**

In the constructor's `Object.assign({...}, opts)` (around lines 359-368), delete the entire `phosphorCoupling: 0,` line plus its preceding comment block.

Add a new option field for `dotRadiusFrac` nearby (e.g., after `cellSize`):

```js
        // Dot radius as a fraction of cell width. 0.30 is a balanced
        // default — dots are clearly visible without dominating the
        // cell. Bigger = more filled / less between-dot substrate;
        // smaller = sparser dot lattice.
        dotRadiusFrac: 0.30,
```

- [ ] **Step 6: Remove `phosphorCoupling` from effect toggles**

In `this.effects = Object.assign({...}, opts.effects || {})` (around line 464), delete:

```js
        phosphorCoupling: true,
```

- [ ] **Step 7: Browser verification**

Reload the page. Verify Trinitron still renders correctly at default URL (no changes to trinitron.js).

In DevTools console, do a real visual test by manually instantiating ShadowMask on the canvas (this requires stopping the existing Trinitron first):

```js
window.__trinitronLogo.stop();
const cv = document.querySelector('canvas.hero-screen');
const layout = { width: 480, height: 170 };  // approximate
const sm = new ShadowMask(cv, {
  viewSize:   [layout.width, layout.height],
  canvasSize: [layout.width * 2, layout.height * 2],
  cellSize: [6, 5],
  signal: (ctx) => {
    ctx.fillStyle = '#08081a';
    ctx.fillRect(0, 0, layout.width, layout.height);
    ctx.fillStyle = '#fff';
    ctx.font = '40px sans-serif';
    ctx.fillText('TEST', 100, 100);
  },
  opaqueBackground: true,
});
sm.start();
```

Expected: dot pattern visible on the canvas, "TEST" rendered as colored dots. No console errors.

After verifying, clean up: `sm.destroy(); location.reload();`

- [ ] **Step 8: Commit**

```bash
git add docs/shadow-mask.js
git commit -m "$(cat <<'EOF'
Replace PHOSPHOR_FS with delta-triad shader, wire dotRadiusFrac

Hex-tiled delta-triad lookup: every other row x-shifted by half a cell
width; (col - row) mod 3 produces the R/G/B triangle arrangement.
Radial smoothstep falloff from each cell center. No phosphor coupling.
Adds dotRadiusFrac option (default 0.30) and matching uniform.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Update `ShadowMask` constructor defaults and debug-panel `GROUPS`

**Files:**
- Modify: `docs/shadow-mask.js`

The renderer-level option defaults now reflect shadow-mask conventions. Also rewrites the debug-panel `GROUPS` array to drop Trinitron-specific language and add the new `dotRadiusFrac` slider.

### Steps

- [ ] **Step 1: Change `cellSize` default to `[6, 5]`**

In the constructor's options block, find:

```js
        cellSize: 3,
```

Replace with:

```js
        // Hex-tile dimensions: cellSize.x is the horizontal pitch
        // between adjacent dots in a row; cellSize.y is the row
        // pitch. 5 ≈ sqrt(3)/2 × 6 gives equilateral triangle
        // adjacency between dots — the visual character of the
        // delta-triad reference image.
        cellSize: [6, 5],
```

Note: this changes the type from `number` to `[number, number]`. Verify that any internal code reading `this.opts.cellSize` handles array indexing rather than scalar. Specifically, `_uploadStaticUniforms` already does:

```js
      gl.uniform2f(this._uPhosphor.cellSize, this.opts.cellSize, this.opts.cellSize);
```

That call passes the *scalar* value twice. Change it to use array components:

```js
      const csX = Array.isArray(this.opts.cellSize) ? this.opts.cellSize[0] : this.opts.cellSize;
      const csY = Array.isArray(this.opts.cellSize) ? this.opts.cellSize[1] : this.opts.cellSize;
      gl.uniform2f(this._uPhosphor.cellSize, csX, csY);
```

(The Array.isArray check keeps the renderer tolerant of either shape — callers can pass a single number or a vec2.)

- [ ] **Step 2: Update the `stripeProfile` debug-panel description and add `dotRadiusFrac` param**

In `_createDebugPanel`'s `GROUPS` array, find the `stripeProfile` row (around line 909-910):

```js
            { key: 'stripeProfile',    label: 'stripe profile',
              desc: 'RGB aperture-grille subpixel decomposition. Off = raw signal, no triad mask.' },
```

Replace with:

```js
            { key: 'stripeProfile',    label: 'phosphor mask',
              desc: 'Delta-triad dot decomposition. Off = raw signal, no dot mask.',
              params: [{ opt: 'dotRadiusFrac', min: 0.10, max: 0.50, step: 0.02, sub: 'dot radius (frac)' }] },
```

- [ ] **Step 3: Remove the `phosphorCoupling` debug-panel row**

In the `GROUPS` array, find the `phosphorCoupling` row (around line 911-913):

```js
            { key: 'phosphorCoupling', label: 'phosphor coupling',
              desc: 'Each lit column also emits the other two channels. Brightens pure colors.',
              params: [{ opt: 'phosphorCoupling', min: 0, max: 1, step: 0.05, sub: 'strength' }] },
```

Delete it entirely.

- [ ] **Step 4: Browser verification**

Reload the page. Default URL still renders Trinitron correctly.

Repeat the console-instantiation test from Task 4 Step 7 (without explicit `cellSize` this time — the default `[6, 5]` should kick in):

```js
window.__trinitronLogo.stop();
const cv = document.querySelector('canvas.hero-screen');
const sm = new ShadowMask(cv, {
  viewSize:   [480, 170],
  canvasSize: [960, 340],
  signal: (ctx) => {
    ctx.fillStyle = '#08081a';
    ctx.fillRect(0, 0, 480, 170);
    ctx.fillStyle = '#fff';
    ctx.font = '40px sans-serif';
    ctx.fillText('TEST', 100, 100);
  },
  opaqueBackground: true,
});
sm.start();
```

Expected: delta-triad dot pattern using `[6, 5]` cell size by default. Then `sm.destroy(); location.reload();`.

- [ ] **Step 5: Commit**

```bash
git add docs/shadow-mask.js
git commit -m "$(cat <<'EOF'
Retune ShadowMask defaults + rewrite debug panel for delta-triad

cellSize defaults to [6, 5] (hex-tile pitch). Renderer accepts either a
scalar or a vec2 for cellSize. Debug panel relabels stripeProfile as
"phosphor mask" with the new dotRadiusFrac slider, drops the obsolete
phosphorCoupling row.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Wire URL-param dispatch and add ShadowMask hero config in `index.html`

**Files:**
- Modify: `docs/index.html`

This task lights up the new dispatch path. After this task, visiting `?crt=shadow-mask` constructs `ShadowMask` instead of `Trinitron`.

### Steps

- [ ] **Step 1: Add URL-param parsing and class dispatch in `createTrinitron`**

In `docs/index.html`, locate the `createTrinitron(layout)` function (around line 2786). The current body starts with the `try { trinitron = new window.Trinitron(canvas, {...}); }` block (around line 2797).

Replace that `try` block with branched construction:

```js
      const useShadowMask = new URL(window.location).searchParams.get('crt') === 'shadow-mask';

      try {
        if (useShadowMask) {
          trinitron = new window.ShadowMask(canvas, {
            signal,
            viewSize:   [layout.width, layout.height],
            canvasSize: [layout.width * 2, layout.height * 2],
            cellSize: [6, 5],
            stripeUpscale: 2,
            opaqueBackground: true,
            persistence: 0.82,
            convergence: { r: [-0.25, -0.25], g: [0, 0], b: [0.25, 0.25] },
            beamSpreadPx: 0.7,
            // Isotropic on shadow-mask (no aperture-grille horizontal-
            // quantization tradeoff). Leave V == H by not overriding.
            rowShimmer: 0.02,
            bleedRadius: 18,
            bloomStrength: 1.2,
            dotRadiusFrac: 0.30,
            debugOverlay: true,
          });
        } else {
          trinitron = new window.Trinitron(canvas, {
            signal,
            viewSize:   [layout.width, layout.height],
            canvasSize: [layout.width * 2, layout.height * 2],
            cellSize: 3,
            stripeUpscale: 2,
            opaqueBackground: true,
            phosphorCoupling: 0.35,
            persistence: 0.82,
            convergence: { r: [-0.25, -0.25], g: [0, 0], b: [0.25, 0.25] },
            beamSpreadPx: 0.7,
            beamSpreadVerticalPx: 1.4,
            rowShimmer: 0.02,
            damperStrength: 0.90,
            bleedRadius: 18,
            bloomStrength: 1.2,
            gapMaskAlpha: 0.15,
            gapMaskPeriod: 2,
            effects: { gapMask: true },
            debugOverlay: true,
          });
        }
        window.__crt = trinitron;
        if (!useShadowMask) window.__trinitronLogo = trinitron;
        if (wasRunning && isDark()) trinitron.start();
      } catch (err) {
        // Silent fallback — SVG dark-mode logo remains as the static fallback.
      }
```

Notes for the engineer:
- The existing `trinitron` variable name is kept as the local handle for back-compat with the outer scope (the `syncWithTheme()` function calls `trinitron.start()` / `.stop()`). It now holds whichever class instance is active.
- The Trinitron branch is the original config unchanged. Verify by comparing against the pre-edit content; only the `try` wrapper structure and the `useShadowMask`/`window.__crt`/conditional `window.__trinitronLogo` lines should be added.

- [ ] **Step 2: Browser verification — default URL**

Reload `http://localhost:8000/` in dark mode. Expected:
- Trinitron renders, looks identical to before this task.
- DevTools console: no errors.
- `window.__crt === window.__trinitronLogo` → true.
- `window.__crt instanceof window.Trinitron` → true.

- [ ] **Step 3: Browser verification — shadow-mask URL**

Visit `http://localhost:8000/?crt=shadow-mask` in dark mode. Expected:
- Delta-triad dot pattern visible across the hero (clearly different from Trinitron stripes).
- No damper-wire shadows.
- No scanline banding.
- The wordmark "interslice·systems" is legible through the dot lattice.
- The CTA, logo, channel-2/3 painters all work.
- DevTools console: no errors.
- `window.__crt` defined; `window.__crt instanceof window.ShadowMask` → true.
- `window.__trinitronLogo` is `undefined`.

- [ ] **Step 4: Browser verification — channel cycling**

On both URLs, click the prev/next buttons (or press arrow keys) to cycle CH1 → CH2 → CH3 → back. All three channels render correctly under either renderer. The OSD plate appears on each change with the correct label.

- [ ] **Step 5: Browser verification — theme toggle**

On both URLs, in DevTools set `<html data-theme="light">` then back to `data-theme="dark"`. The canvas hides/shows; renderer stops/starts. No visual regression.

- [ ] **Step 6: Browser verification — debug panel**

Visit `?debug=1` (Trinitron + debug panel). Verify the debug panel shows the existing Trinitron groups (with damper-wires and gap-mask rows).

Visit `?debug=1&crt=shadow-mask`. Verify the debug panel shows:
- No "damper wires" row
- No "gap mask" row
- No "phosphor coupling" row
- The "phosphor mask" row (renamed from "stripe profile") with a `dot radius (frac)` slider

Drag the dot radius slider from 0.10 to 0.50; the dots visibly grow/shrink. After verifying, leave it at 0.30 (the default).

- [ ] **Step 7: Commit**

```bash
git add docs/index.html
git commit -m "$(cat <<'EOF'
Dispatch to ShadowMask renderer on ?crt=shadow-mask

createTrinitron now branches on the URL param. Both renderers expose
window.__crt; window.__trinitronLogo stays as a back-compat alias when
Trinitron is the active renderer. The ShadowMask hero config matches
the Trinitron's where applicable, with shadow-mask-specific options
(cellSize [6,5], dotRadiusFrac 0.30) and no damper/gap-mask fields.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Update saved memories

**Files:**
- Modify: `/home/chris/.claude/projects/-home-chris-Projects-interslice-systems/memory/trinitron_renderer.md`
- Modify: `/home/chris/.claude/projects/-home-chris-Projects-interslice-systems/memory/feedback_cell_grid_is_intentional.md`

### Steps

- [ ] **Step 1: Update `trinitron_renderer.md`**

Read the current file content. Update to note:
- `docs/shadow-mask.js` is now a sibling renderer (no longer a stash). It implements `class ShadowMask`, exposing `window.ShadowMask`.
- Selecting between renderers: `?crt=shadow-mask` URL param dispatches to `ShadowMask`; absence (or any other value) keeps `Trinitron` as the default.
- `window.__crt` is the canonical DevTools handle for the active renderer (regardless of class). `window.__trinitronLogo` is a back-compat alias when Trinitron is active; `undefined` when ShadowMask is active.

Preserve any existing content that's still accurate (the Trinitron-specific renderer description doesn't go away — it just gains a sibling).

- [ ] **Step 2: Update `feedback_cell_grid_is_intentional.md`**

Read the current file content. The memory should now mention:
- The dot-grid pattern is intentional, but **only for the shadow-mask renderer** (`docs/shadow-mask.js`).
- The Trinitron renderer (`docs/trinitron.js`) stays continuous-stripes; the rule against reintroducing a cell-grid texture into Trinitron still applies.

If the existing memory was phrased as a blanket rule against any dot pattern in the codebase, rewrite to scope it to the Trinitron file specifically.

- [ ] **Step 3: No commit needed**

Memory files live in `~/.claude/`, not the project repo.

---

## Task 8: End-to-end verification per spec

**Files:** None modified — manual verification only.

Execute the spec's `## Verification plan` top to bottom. This task is a single pass through all eight verification items; if any fail, file a new task to fix and re-verify.

### Steps

- [ ] **Step 1: Run all eight items from `specs/2026-05-24-pc-crt-shadow-mask-design.md` § "Verification plan"**

Specifically:

1. **Default URL.** Load `/` and confirm Trinitron renders, no visual regression vs. main branch. `window.__trinitronLogo` exposed, `window.__crt` exposed and identical reference.
2. **Shadow-mask URL.** Load `?crt=shadow-mask`. Delta-triad dot pattern visible, no damper-wire shadows, no scanline banding, no visible convergence offset, gentle halo around bright dots. `window.__crt` exposed; `window.__trinitronLogo` is `undefined`.
3. **Channels under both renderers.** Cycle CH1 → CH2 → CH3 → back, under both URLs. All three painters work under either renderer; OSD plate shows correct label.
4. **Theme toggle.** Toggle `<html data-theme="light">` ↔ `data-theme="dark"` in DevTools under both URLs. Canvas hides/shows; renderer stops/starts.
5. **WebGL2 unavailable.** Disable WebGL2 in DevTools, reload each URL. Both fall back cleanly to `.m-dark` SVG. No console errors louder than today.
6. **Debug panel.** Open `?debug=1` and `?debug=1&crt=shadow-mask`. First shows Trinitron groups; second shows shadow-mask groups (no damper, no gap mask, no phosphor-coupling row; new `dot radius (frac)` slider).
7. **Reduced motion.** Set `prefers-reduced-motion: reduce` in DevTools under both URLs. Hub rotation stops; phosphor surface still renders; OSD plate still appears on channel change.
8. **Phosphor pattern correctness.** Zoom into a screenshot of the shadow-mask hero at 4×–8× scale. Verify: dots are circular (not streaks); every adjacent triangle of three dots contains one R + one G + one B; rows alternate the x-shift; cell-center placements form a clean hex lattice.

- [ ] **Step 2: If everything passes — leave for Chris to push to main**

The harness blocks direct pushes to main. After verification, report completion to Chris with a list of the commits made; he'll push or request changes.

- [ ] **Step 3: If anything fails — file a new task**

For each failure, write a follow-up task describing the symptom and proposed root-cause investigation. Don't paper over by tweaking values — root-cause first.

---

## Self-review

**1. Spec coverage:**

- `?crt=shadow-mask` URL dispatch → Task 6
- Peer renderer `docs/shadow-mask.js` → Tasks 1-5
- `class ShadowMask` with same shape as `Trinitron` → Task 1
- Delta-triad phosphor shader → Task 4
- `cellSize: [6, 5]`, `dotRadiusFrac: 0.30` → Tasks 4, 5
- No damper-wire code → Task 2
- No gap-mask code → Task 3
- No phosphor coupling on shadow-mask → Task 4
- Composite shader slimmed (no gap-mask sampler) → Task 3
- Debug panel updated → Tasks 3 (removal), 5 (new slider + relabel)
- `window.__crt` alias → Task 6
- Same channel painters under both renderers → Task 6 (signal callback is `signal`, the existing one)
- Reduced-motion identical behavior → No new code (each renderer owns `_setupReducedMotionListener` from the Task 1 copy)
- SVG fallback works under either renderer → No new code (`try { new Class() } catch` handles both)
- Memory updates → Task 7
- End-to-end verification → Task 8

All spec sections covered.

**2. Placeholder scan:** No TBD / TODO / "see implementation" / "add appropriate error handling" / pseudo-code-only steps. All code blocks contain runnable code or exact shader text.

**3. Type consistency:**
- `cellSize` changes from scalar `3` to vec2 `[6, 5]` in shadow-mask.js; Task 5 Step 1 explicitly handles the `_uploadStaticUniforms` adjustment to read array components.
- `dotRadiusFrac` introduced in Task 4 Step 1 (shader uniform), Task 4 Step 2 (uniform-location cache), Task 4 Step 3 (static-uniform upload), Task 4 Step 5 (constructor default), Task 5 Step 2 (debug-panel slider). Consistent name throughout.
- `useShadowMask` local in Task 6 Step 1 is used twice in the same block; consistent.
- `window.__crt` introduced in Task 6 Step 1; referenced in Task 6 Steps 2-3 verification; named in Task 7 memory updates. Consistent.

No type inconsistencies found.

---

## Execution handoff

After completing all eight tasks, the new renderer is live behind a URL param. Chris will push to main when satisfied; pushing triggers GitHub Pages deploy.
