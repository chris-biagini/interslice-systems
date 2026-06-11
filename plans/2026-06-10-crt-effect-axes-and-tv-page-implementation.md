# CRT Effect Axes + TV Dev Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Encode the universal/trinitron/shadow-mask effect axes in per-renderer schemas (with three realism default fixes), and build `docs/tv.html` — a woodgrain console-TV tuning page with channel/renderer knobs and a schema-driven parameter bench.

**Architecture:** Each renderer hoists its debug-panel metadata to a class-level `effectSchema` static tagged with scope, plus public `readParam`/`writeParam`/`stateDiff` methods; the built-in `?debug=1` overlay and the new TV bench both consume that API. `tv.html` is a self-contained page (inline CSS + one inline script, per repo convention) that swaps renderer instances on one WebGL canvas and keeps a separate 2-D canvas for bypass.

**Tech Stack:** Plain HTML/CSS/JS, WebGL2 (existing renderers, shaders untouched), inline SVG (feTurbulence woodgrain). No build step, no tests — verification is visual via Playwright MCP against `python3 -m http.server -d docs 8000`.

**Spec:** `specs/2026-06-10-crt-effect-axes-and-tv-page-design.md`

**Parallelization:** Task 0 first (baselines). Then Track A = Tasks 1–3 (renderer files + hero fix, one agent — the files mirror each other), Track B = Task 4 (tv.html shell), Track C = Task 5 (channel draw functions, delivered as code for integration) may run concurrently. Task 6 needs Tasks 1 & 4. Tasks 7–9 are sequential at the end. Subagents: Opus-tier or better (project memory).

---

### Task 0: Capture hero baseline screenshots

No file changes. Baselines must predate any renderer edit.

- [ ] **Step 0.1:** Start the local server (leave running for all tasks):

```bash
python3 -m http.server -d docs 8000
```

- [ ] **Step 0.2:** Via Playwright MCP, for each URL below: navigate, set dark mode (`document.documentElement.setAttribute('data-theme','dark')`), wait ~2 s for warmup/persistence to settle, screenshot:
  - `http://localhost:8000/` → `/tmp/crt-baseline/hero-trinitron-dark.png`
  - `http://localhost:8000/?crt=shadow-mask` → `/tmp/crt-baseline/hero-shadowmask-dark.png`
  - `http://localhost:8000/` with `data-theme="light"` → `/tmp/crt-baseline/hero-light.png`
- [ ] **Step 0.3:** Confirm zero console errors on both pages.

---

### Task 1: Trinitron schema + param API (`docs/trinitron.js`)

**Files:**
- Modify: `docs/trinitron.js` (defaults ~line 392–429; overlay ~line 789–1111; class export ~line 1586)

- [ ] **Step 1.1: Change realism defaults.** In the `opts` defaults object:

```js
// Before:
convergence: { r: [-0.5, -0.5], g: [0.0, 0.0], b: [0.5, 0.5] },
// After (inline cathodes → horizontal-only misconvergence):
convergence: { r: [-0.5, 0.0], g: [0.0, 0.0], b: [0.5, 0.0] },

// Before:
curvatureMode: 'spherical',
// After (Trinitron face is cylindrical — verticals stay straight):
curvatureMode: 'cylindrical',
```

Update the `curvatureMode` option comment to say the mode is tube-determined (cylindrical for Trinitron), still overridable by callers but no longer offered in menus.

- [ ] **Step 1.2: Add module-level `PANEL_OPT_KEYS`** (above the class, near the shader consts), moved out of the overlay:

```js
// Opts the panels snapshot for stateDiff(). curvatureMode stays listed
// even though the menu no longer offers it — console-driven changes
// should still show up in the diff.
const PANEL_OPT_KEYS = [
  'phosphorCoupling', 'persistence',
  'rowShimmer', 'beamSpreadPx', 'beamSpreadVerticalPx',
  'curvature', 'curvatureMode', 'bloomThreshold', 'bloomStrength',
  'bleedRadius', 'damperStrength', 'scanlineDepth', 'scanlinePeriod',
];
```

- [ ] **Step 1.3: Add public param API methods** to the class (place after the constructor):

```js
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
```

- [ ] **Step 1.4: Capture the baseline in the constructor.** Immediately after the `this.effects = Object.assign({...}, opts.effects || {});` block:

```js
// Baseline for stateDiff() — captured before any panel mutation.
this._baseline = this._snapshotState();
```

- [ ] **Step 1.5: Add the tagged schema static** after the class's closing brace, before `window.Trinitron = Trinitron;`:

```js
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
      { key: 'convergenceDrift', label: 'convergence drift', scope: 'universal',
        desc: 'Slow time-varying R/B shift on top of base. Mistuned-yoke wobble.' },
      { key: 'persistence',      label: 'persistence', scope: 'universal',
        desc: 'Phosphor afterglow. Previous frame lerps with new at this decay.',
        params: [{ opt: 'persistence', min: 0, max: 0.99, step: 0.01, sub: 'decay' }] },
      { key: 'perRowShimmer',    label: 'per-row shimmer', scope: 'universal',
        desc: 'Per-scanline brightness noise. The only animated micro-texture in the model (reseeds at ~30 fps).',
        params: [{ opt: 'rowShimmer', min: 0, max: 0.1, step: 0.005, sub: 'amount' }] },
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
      { key: 'breathing', label: 'breathing', scope: 'universal',
        desc: 'Slow brightness modulation. Power-supply ripple feel.' },
    ] },
];
```

- [ ] **Step 1.6: Rewire `_initDebugOverlay()`.** Delete from it: the `GROUPS` array, `PANEL_OPT_KEYS`/`snapshotOpts`/`baseline`/`convergenceEq`/`fmtNum`/`buildDiff` closures, and the local `readVal`/`writeVal`. Replace:
  - copy button handler: `const text = this.stateDiff();` (rest unchanged);
  - group loop: `for (const group of this.constructor.effectSchema) {`;
  - slider init: `const initV = this.readParam(p.opt);`
  - slider input handler: `this.writeParam(p.opt, v);`
  - select branch (keep generic for future use): init `select.value = String(this.readParam(p.opt) ?? p.options[0]);`, change handler `this.writeParam(p.opt, select.value);`

  Everything else (panel chrome, collapse persistence, fps readout, checkbox wiring `this.effects[item.key] = cb.checked`) stays as is.

- [ ] **Step 1.7: Verify via Playwright MCP** on `http://localhost:8000/?debug=1` (dark mode): panel renders all four groups; **no curvature-mode select anywhere**; convergence slider reads `spread (x px)`; enable `convergence`, drag spread to 1.0 → screenshot shows red fringe on left edges / blue on right, **no vertical fringe**; "copy state diff" → clipboard/console shows `effects.convergence = true` and the X-only convergence line. Console clean.

- [ ] **Step 1.8: Commit:**

```bash
git add docs/trinitron.js
git commit -m "Hoist Trinitron effect schema with realism axes; X-only convergence, cylindrical face

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: ShadowMask schema + param API (`docs/shadow-mask.js`)

**Files:**
- Modify: `docs/shadow-mask.js` (defaults ~line 354–451; overlay ~line 776–1087; class export ~line 1509)

Same shape as Task 1; differences only where the tube differs. `curvatureMode` default is already `'spherical'` — unchanged.

- [ ] **Step 2.1: Add module-level `PANEL_OPT_KEYS`:**

```js
// Opts the panels snapshot for stateDiff(). curvatureMode and
// beamSpreadVerticalPx stay listed even though the menu no longer
// offers them — console-driven changes should still diff.
const PANEL_OPT_KEYS = [
  'dotRadius', 'phosphorCoupling', 'persistence',
  'rowShimmer', 'beamSpreadPx', 'beamSpreadVerticalPx',
  'curvature', 'curvatureMode', 'bloomThreshold', 'bloomStrength',
  'bleedRadius', 'scanlineDepth', 'scanlinePeriod',
];
```

- [ ] **Step 2.2: Add the param API methods** (after the constructor). Identical to Task 1 Step 1.3 except: no `__damperDarkness` branches; `__convergenceSpread` keeps the delta-gun 2-D write; diff strings say `shadow-mask`:

```js
readParam(opt) {
  if (opt === '__convergenceSpread') return Math.abs(this.opts.convergence?.r?.[0] ?? 0);
  return this.opts[opt] ?? 0;
}

writeParam(opt, v) {
  if (opt === '__convergenceSpread') {
    // Delta guns sit in a triangle — misconvergence fringes in 2-D.
    this.opts.convergence = { r: [-v, -v], g: [0, 0], b: [v, v] };
  } else {
    this.opts[opt] = v;
  }
  if (this._gl) this._uploadStaticUniforms();
}
```

`_snapshotState()` and `stateDiff()` are byte-identical to Step 1.3's except the two title strings: `'shadow-mask state: (no changes from construction)'` / `'shadow-mask state diff (from construction):'`.

- [ ] **Step 2.3: Capture baseline in constructor** (same one-liner as Step 1.4).

- [ ] **Step 2.4: Add the schema static** before `window.ShadowMask = ShadowMask;`:

```js
// Effect schema — single source of truth for the built-in ?debug=1
// overlay AND external benches (docs/tv.html). Scope axes per the
// 2026-06-10 spec. Tube-determined options are pinned via defaults,
// not offered here (curvatureMode: spherical; beam spread isotropic —
// the dot lattice quantizes both axes, so no V slider).
ShadowMask.effectSchema = [
  { title: 'phosphor',
    items: [
      { key: 'stripeProfile',    label: 'phosphor mask', scope: 'universal',
        desc: 'Triad-per-cell dot tiling. Off = raw signal, no mask.',
        params: [{ opt: 'dotRadius', min: 0.2, max: 1.5, step: 0.05, sub: 'dot radius (src-px)', scope: 'shadow-mask' }] },
      { key: 'phosphorCoupling', label: 'phosphor coupling', scope: 'universal',
        desc: 'Each dot also emits other channels at this fraction. Cross-talk cheat that softens per-dot chromatic mismatch.',
        params: [{ opt: 'phosphorCoupling', min: 0, max: 1, step: 0.05, sub: 'strength' }] },
      { key: 'convergence',      label: 'convergence', scope: 'universal',
        desc: 'Per-channel xy-offset. Delta guns fringe in 2-D — R/B shift diagonally.',
        params: [{ opt: '__convergenceSpread', min: 0, max: 1, step: 0.05, sub: 'spread (px)' }] },
      { key: 'convergenceDrift', label: 'convergence drift', scope: 'universal',
        desc: 'Slow time-varying R/B shift on top of base. Mistuned-yoke wobble.' },
      { key: 'persistence',      label: 'persistence', scope: 'universal',
        desc: 'Phosphor afterglow. Previous frame lerps with new at this decay.',
        params: [{ opt: 'persistence', min: 0, max: 0.99, step: 0.01, sub: 'decay' }] },
      { key: 'perRowShimmer',    label: 'per-row shimmer', scope: 'universal',
        desc: 'Per-scanline brightness noise. The only animated micro-texture in the model (reseeds at ~30 fps).',
        params: [{ opt: 'rowShimmer', min: 0, max: 0.1, step: 0.005, sub: 'amount' }] },
      { key: 'beamSpread',       label: 'beam spread', scope: 'universal',
        desc: 'Gaussian PSF blur on signal — isotropic; the dot lattice quantizes both axes the same way.',
        params: [{ opt: 'beamSpreadPx', min: 0, max: 3, step: 0.1, sub: 'radius (px)' }] },
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
      { key: 'scanlines',      label: 'horizontal scanlines', scope: 'universal',
        desc: 'Periodic dim/bright bands along Y — the beam paints rows with gaps between.',
        params: [
          { opt: 'scanlineDepth',  min: 0, max: 1,  step: 0.02, sub: 'depth' },
          { opt: 'scanlinePeriod', min: 1, max: 10, step: 0.5,  sub: 'period (px)' },
        ] },
    ] },
  { title: 'glass',
    items: [
      { key: 'curvature', label: 'curvature', scope: 'universal',
        desc: 'Spherical face curvature — the classic shadow-mask barrel dome, bowing on both axes.',
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
      { key: 'breathing', label: 'breathing', scope: 'universal',
        desc: 'Slow brightness modulation. Power-supply ripple feel.' },
    ] },
];
```

Note: `beamSpreadVerticalPx` is intentionally absent from the schema (menu curation) but still works as an opt and stays in `PANEL_OPT_KEYS`.

- [ ] **Step 2.5: Rewire `_initDebugOverlay()`** — same edits as Step 1.6.

- [ ] **Step 2.6: Verify via Playwright MCP** on `http://localhost:8000/?crt=shadow-mask&debug=1` (dark): panel has **no curvature-mode select and no beam-spread V slider**; convergence spread at 1.0 fringes **diagonally**; copy state diff works; console clean.

- [ ] **Step 2.7: Commit:**

```bash
git add docs/shadow-mask.js
git commit -m "Hoist ShadowMask effect schema with realism axes; isotropic menu, spherical face

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Hero latent convergence fix + no-regression check

**Files:**
- Modify: `docs/index.html` (~line 2047, Trinitron branch of `createTrinitron`)

- [ ] **Step 3.1:** In the `new window.Trinitron(...)` options:

```js
// Before:
convergence: { r: [-0.25, -0.25], g: [0, 0], b: [0.25, 0.25] },
// After (X-only; latent — effects.convergence is off on the hero):
convergence: { r: [-0.25, 0], g: [0, 0], b: [0.25, 0] },
```

The ShadowMask branch keeps its 2-D values — correct for delta guns.

- [ ] **Step 3.2: No-regression check.** Re-take the three Task 0 screenshots into `/tmp/crt-after/` and compare against `/tmp/crt-baseline/` (visual inspection; they must be indistinguishable — warmup/shimmer noise aside). Console clean on both URLs.

- [ ] **Step 3.3: Commit:**

```bash
git add docs/index.html
git commit -m "Make hero Trinitron convergence X-only (latent realism fix)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `docs/tv.html` — cabinet, knobs, renderer lifecycle

**Files:**
- Create: `docs/tv.html`

A complete working page with one inline snow channel; real channels arrive in Task 5, bench in Task 6. Page skeleton:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Interslice Systems — TV Service Bay</title>
<style>/* Task 4 CSS */</style>
</head>
<body>
  <main class="bay">
    <div class="tv-cabinet">
      <!-- inline SVG cabinet chrome (woodgrain body, bezel, plate) -->
      <div class="screen-cutout">
        <canvas id="crt"    width="1280" height="960"></canvas><!-- WebGL; renderer sets backing = canvasSize × DPR -->
        <canvas id="bypass" width="640"  height="480" hidden></canvas>
      </div>
      <div class="control-plate">
        <button class="knob" id="knob-channel"  aria-label="Channel selector"></button>
        <button class="knob" id="knob-renderer" aria-label="Renderer selector"></button>
        <div class="knob-readout" aria-live="polite" id="readout"></div>
      </div>
    </div>
    <section class="bench" id="bench"><!-- Task 6 --></section>
  </main>
<script src="trinitron.js"></script>
<script src="shadow-mask.js"></script>
<script>/* Task 4 JS */</script>
</body>
</html>
```

**Hard requirements** (builder has creative latitude beyond them, per spec):

- Fixed dark workshop backdrop (`#16181d`-ish); page does NOT participate in the site's two-media theme system; no `tokens.css` import.
- Screen: 640×480 CSS px, 4:3, rounded-corner CRT mask (`border-radius` ≈ 28px on `.screen-cutout`, `overflow: hidden`), inset glass shadow. Both canvases absolutely stacked to fill it; both renderers construct on `#crt` with `viewSize: [320, 240]`, `canvasSize: [640, 480]`, `stripeUpscale: 2` (the renderer sets the backing store itself — the `width`/`height` attributes above are placeholders).
- Cabinet: inline SVG + CSS. Walnut woodgrain via `feTurbulence` (`type="fractalNoise"`, `baseFrequency="0.012 0.12"` start point, displacement/color-matrix to brown tones) + linear-gradient sheen; brushed-aluminum control plate (repeating-linear-gradient); speaker grille slats; power LED (lit green when a renderer runs, amber in bypass); small "INTERSLICE" badge text.
- Knobs are real `<button>`s: click advances with wraparound; `ArrowRight`/`ArrowUp` next, `ArrowLeft`/`ArrowDown` prev; visible focus ring. Pointer line rotates via CSS `transform: rotate()` with `transition: transform 120ms` (detent feel). Position labels around each knob in SVG text — CHANNEL: `2 3 4 5 6`; RENDERER: `TRINITRON / SHADOW MASK / BYPASS`. `#readout` shows e.g. `CH 3 · TRINITRON`.

**Lifecycle JS** (complete; the contract Task 5/6 build against):

```js
(function () {
  'use strict';
  const SIGNAL_W = 320, SIGNAL_H = 240;
  const RENDERERS = ['trinitron', 'shadow-mask', 'bypass'];

  // --- Channels (Task 5 replaces this stub with the real five) -------
  function drawSnow(ctx, t, w, h) { /* see Task 5 Step 5.5 — include it here from day one */ }
  let CHANNELS = [{ num: 2, name: 'SNOW', draw: drawSnow }];

  let channelIdx = 0;
  let channelSwitchWall = 0;                  // performance.now() of last switch
  function paintChannel(ctx, t) {
    if (performance.now() - channelSwitchWall < 150) drawSnow(ctx, t, SIGNAL_W, SIGNAL_H);
    else CHANNELS[channelIdx].draw(ctx, t, SIGNAL_W, SIGNAL_H);
  }

  // --- Renderer lifecycle --------------------------------------------
  const glCanvas = document.getElementById('crt');
  const byCanvas = document.getElementById('bypass');
  const bctx = byCanvas.getContext('2d');
  const off = document.createElement('canvas');
  off.width = SIGNAL_W; off.height = SIGNAL_H;
  const octx = off.getContext('2d');

  let renderer = null;          // live Trinitron|ShadowMask or null
  let rendererIdx = 0;
  let webglOk = true;
  let bypassRaf = null, bypassStart = 0;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  // Boot presets per spec §"Boot presets" — hero-derived + TV glass.
  const TV_EFFECTS = { convergence: true, selectiveBloom: true, scanlines: true,
                       curvature: true, vignette: true, warmup: true };
  function makeRenderer(kind) {
    const common = {
      signal: paintChannel,
      viewSize: [SIGNAL_W, SIGNAL_H],
      canvasSize: [SIGNAL_W * 2, SIGNAL_H * 2],
      stripeUpscale: 2,
      opaqueBackground: true,
      phosphorCoupling: 0.35,
      persistence: 0.82,
      rowShimmer: 0.02,
      bloomStrength: 1.2,
      scanlineDepth: 0.18,
      scanlinePeriod: 2,
      curvature: 0.06,
      debugOverlay: false,
    };
    if (kind === 'trinitron') {
      return new window.Trinitron(glCanvas, Object.assign(common, {
        cellSize: 3,
        convergence: { r: [-0.25, 0], g: [0, 0], b: [0.25, 0] },
        beamSpreadPx: 0.7, beamSpreadVerticalPx: 1.4,
        damperStrength: 0.90,
        bleedRadius: 18,
        gapMaskAlpha: 0.15, gapMaskPeriod: 2,
        effects: Object.assign({ gapMask: true }, TV_EFFECTS),
      }));
    }
    return new window.ShadowMask(glCanvas, Object.assign(common, {
      cellSize: [3, 3], dotRadius: 0.7,
      convergence: { r: [-0.25, -0.25], g: [0, 0], b: [0.25, 0.25] },
      beamSpreadPx: 1.5, beamSpreadVerticalPx: 1.5,
      bleedRadius: 24, bloomThreshold: 0.3,
      effects: Object.assign({}, TV_EFFECTS),
    }));
  }

  function stopBypass() {
    if (bypassRaf != null) { cancelAnimationFrame(bypassRaf); bypassRaf = null; }
  }
  function bypassTick(now) {
    paintChannel(octx, now - bypassStart);
    bctx.imageSmoothingEnabled = false;
    bctx.drawImage(off, 0, 0, byCanvas.width, byCanvas.height);
    if (!reducedMotion.matches) bypassRaf = requestAnimationFrame(bypassTick);
  }
  function startBypass() {
    bypassStart = performance.now();
    bypassTick(bypassStart);    // reduced-motion → exactly one frame
  }

  function setRenderer(idx) {
    rendererIdx = idx;
    const kind = RENDERERS[idx];
    if (renderer) { try { renderer.destroy(); } catch (_) {} renderer = null; }
    stopBypass();
    const useBypass = kind === 'bypass' || !webglOk;
    if (!useBypass) {
      try {
        renderer = makeRenderer(kind);
        window.__crt = renderer;
        renderer.start();
      } catch (err) {
        webglOk = false;        // permanent: disable knob, fall through
        document.getElementById('knob-renderer').disabled = true;
      }
    }
    const inBypass = !renderer;
    glCanvas.hidden = inBypass;
    byCanvas.hidden = !inBypass;
    if (inBypass) startBypass();
    document.body.dataset.power = inBypass ? 'bypass' : 'on';   // LED color
    rebuildBench();             // Task 6 (no-op stub until then)
    updateReadout();
    syncUrl();
  }

  function setChannel(idx) {
    channelIdx = idx;
    channelSwitchWall = performance.now();
    updateReadout();
    syncUrl();
  }

  function rebuildBench() {}    // Task 6 replaces

  // --- Knob wiring -----------------------------------------------------
  function wireKnob(btn, count, getIdx, setIdx) {
    const step = (d) => setIdx(((getIdx() + d) % count + count) % count);
    btn.addEventListener('click', () => step(1));
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp')   { e.preventDefault(); step(1); }
      if (e.key === 'ArrowLeft'  || e.key === 'ArrowDown') { e.preventDefault(); step(-1); }
    });
  }
  // After each setIdx, rotate the knob pointer:
  //   pointerEl.style.transform = `rotate(${startDeg + idx * sweepDeg / (count - 1)}deg)`
  // CHANNEL: 5 positions over -120°..+120°. RENDERER: 3 positions over -60°..+60°.

  function updateReadout() {
    document.getElementById('readout').textContent =
      `CH ${CHANNELS[channelIdx].num} · ${RENDERERS[rendererIdx].replace('-', ' ').toUpperCase()}`;
  }

  // --- URL state ------------------------------------------------------
  function syncUrl() {
    const u = new URL(window.location);
    u.searchParams.set('ch', String(CHANNELS[channelIdx].num));
    u.searchParams.set('renderer', RENDERERS[rendererIdx]);
    history.replaceState(null, '', u);
  }
  function readUrl() {
    const u = new URL(window.location);
    const ch = parseInt(u.searchParams.get('ch'), 10);
    const ci = CHANNELS.findIndex((c) => c.num === ch);
    if (ci >= 0) channelIdx = ci;
    const ri = RENDERERS.indexOf(u.searchParams.get('renderer'));
    if (ri >= 0) rendererIdx = ri;
  }

  // --- Boot -----------------------------------------------------------
  readUrl();
  wireKnob(document.getElementById('knob-channel'),  CHANNELS.length, () => channelIdx,  setChannel);
  wireKnob(document.getElementById('knob-renderer'), RENDERERS.length, () => rendererIdx, setRenderer);
  setRenderer(rendererIdx);
  setChannel(channelIdx);
})();
```

(Knob `count` for CHANNEL must be re-read after Task 5 expands `CHANNELS` — wire with `CHANNELS.length` at boot, which Task 5's array makes 5.)

- [ ] **Step 4.1:** Write `docs/tv.html` per the skeleton + requirements + lifecycle JS above (snow stub from Task 5 Step 5.5 inlined).
- [ ] **Step 4.2: Verify via Playwright MCP** at `http://localhost:8000/tv.html`: cabinet renders (woodgrain, plate, grille, LED, badge); snow plays through the Trinitron by default; renderer knob cycles TRINITRON → SHADOW MASK → BYPASS (bypass = blocky raw noise); channel knob rotates; keyboard arrows work on focused knobs; URL gains `?ch=2&renderer=…`; reload with `?renderer=bypass` boots into bypass. Console clean.
- [ ] **Step 4.3: Commit:**

```bash
git add docs/tv.html
git commit -m "Add docs/tv.html: woodgrain console TV with channel/renderer knobs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: The five channels

**Files:**
- Modify: `docs/tv.html` (replace the `CHANNELS` stub + add draw functions in the inline script)

All draws are pure `(ctx, t, w, h)` at 320×240 logical, must fill the whole frame, and use only canvas 2D (no assets). Final array:

```js
CHANNELS = [
  { num: 2, name: 'SMPTE BARS', draw: drawSmpteBars },
  { num: 3, name: 'CROSSHATCH', draw: drawCrosshatch },
  { num: 4, name: 'TEST CARD',  draw: drawTestCard },
  { num: 5, name: 'MOTION',     draw: drawMotionReel },
  { num: 6, name: 'SNOW',       draw: drawSnow },
];
```

- [ ] **Step 5.1: SMPTE bars (ch 2)** — 75% bars / castellation strip / PLUGE-ish bottom:

```js
function drawSmpteBars(ctx, t, w, h) {
  const bw = w / 7;
  const top = ['#c0c0c0','#c0c000','#00c0c0','#00c000','#c000c0','#c00000','#0000c0'];
  const topH = Math.round(h * 0.67);
  top.forEach((c, i) => { ctx.fillStyle = c;
    ctx.fillRect(Math.round(i * bw), 0, Math.ceil(bw), topH); });
  const midH = Math.round(h * 0.08);
  const mid = ['#0000c0','#131313','#c000c0','#131313','#00c0c0','#131313','#c0c0c0'];
  mid.forEach((c, i) => { ctx.fillStyle = c;
    ctx.fillRect(Math.round(i * bw), topH, Math.ceil(bw), midH); });
  const by = topH + midH, bh = h - by, u = w / 28;
  const bot = [['#00214c', 5], ['#ffffff', 5], ['#32006a', 5], ['#131313', 5],
               ['#0d0d0d', 1.67], ['#131313', 1.67], ['#1a1a1a', 1.67], ['#131313', 3]];
  let x = 0;
  bot.forEach(([c, units]) => { ctx.fillStyle = c;
    ctx.fillRect(Math.round(x), by, Math.ceil(units * u), bh); x += units * u; });
}
```

- [ ] **Step 5.2: Convergence crosshatch (ch 3)** — the service pattern:

```js
function drawCrosshatch(ctx, t, w, h) {
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
  const step = 20;                       // 16×12 cells at 320×240
  ctx.beginPath();
  for (let x = step; x < w; x += step) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); }
  for (let y = step; y < h; y += step) { ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); }
  ctx.stroke();
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  ctx.fillStyle = '#fff';                // dots at cell centers
  for (let y = step / 2; y < h; y += step)
    for (let x = step / 2; x < w; x += step)
      ctx.fillRect(x - 1, y - 1, 2, 2);
}
```

- [ ] **Step 5.3: Interslice test card (ch 4)** — PM5544-flavored:

```js
function drawTestCard(ctx, t, w, h) {
  ctx.fillStyle = '#3a3a3a'; ctx.fillRect(0, 0, w, h);
  const step = 20;                       // background grid
  ctx.strokeStyle = '#777'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = step; x < w; x += step) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); }
  for (let y = step; y < h; y += step) { ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); }
  ctx.stroke();
  const cx = w / 2, cy = h / 2, r = h * 0.46;
  ctx.save();                            // big circle, clipped contents
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = '#e8e8e8'; ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r);
  const bars = ['#c0c000','#00c0c0','#00c000','#c000c0','#c00000','#0000c0'];
  const bw2 = (2 * r) / bars.length;
  bars.forEach((c, i) => { ctx.fillStyle = c;
    ctx.fillRect(cx - r + i * bw2, cy - r, Math.ceil(bw2), r * 0.55); });
  // frequency gratings — vertical line bundles at rising pitch
  let gx = cx - r;
  for (const pitch of [8, 6, 4, 3, 2]) {
    for (let i = 0; i < 8; i++, gx += pitch) {
      ctx.fillStyle = i % 2 ? '#111' : '#e8e8e8';
      ctx.fillRect(gx, cy + r * 0.25, pitch, r * 0.3);
    }
  }
  ctx.fillStyle = '#111';                // center text plate
  ctx.fillRect(cx - 95, cy - 26, 190, 48);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = '700 16px monospace';
  ctx.fillText('INTERSLICE SYSTEMS', cx, cy - 9);
  ctx.font = '400 11px monospace';
  ctx.fillText('· PLEASE STAND BY ·', cx, cy + 11);
  ctx.restore();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;   // circle outline
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#fff';                // corner registration marks
  for (const [mx, my] of [[10, 10], [w - 10, 10], [10, h - 10], [w - 10, h - 10]]) {
    ctx.fillRect(mx - 6, my - 1, 12, 2); ctx.fillRect(mx - 1, my - 6, 2, 12);
  }
}
```

- [ ] **Step 5.4: Motion reel placeholder (ch 5)** — deliberately trivial; the final reel is Task 9's fresh-subagent pass:

```js
// PLACEHOLDER — Task 9 replaces the body with the real motion reel.
// Contract: pure (ctx, t, w, h), fills the frame, 320×240, no assets.
function drawMotionReel(ctx, t, w, h) {
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
  const bw = 40, bh = 24;
  const bounce = (p, range) => { const m = p % (range * 2); return m < range ? m : range * 2 - m; };
  ctx.fillStyle = '#fff';
  ctx.fillRect(bounce(t * 0.08, w - bw), bounce(t * 0.05, h - bh), bw, bh);
}
```

- [ ] **Step 5.5: Dead-channel snow (ch 6)** — also the switch interstitial (already inlined in Task 4):

```js
let snowImg = null;
function drawSnow(ctx, t, w, h) {
  if (!snowImg) snowImg = ctx.createImageData(w, h);
  const u32 = new Uint32Array(snowImg.data.buffer);
  for (let i = 0; i < u32.length; i++) {
    const v = (Math.random() * 256) | 0;
    u32[i] = 0xff000000 | (v << 16) | (v << 8) | v;
  }
  ctx.putImageData(snowImg, 0, 0);
}
```

- [ ] **Step 5.6: Verify via Playwright MCP:** step the channel knob through 2→6 under TRINITRON; screenshot each; confirm bars/crosshatch/card/bouncer/snow, the ~150 ms snow blip between switches, and that BYPASS shows the same content raw. Console clean.
- [ ] **Step 5.7: Commit:**

```bash
git add docs/tv.html
git commit -m "Wire the five TV channels: bars, crosshatch, test card, motion stub, snow

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Schema-driven bench panel

**Files:**
- Modify: `docs/tv.html` (replace `rebuildBench()` stub; add bench CSS)

- [ ] **Step 6.1: Implement `rebuildBench()`:**

```js
function rebuildBench() {
  const bench = document.getElementById('bench');
  bench.textContent = '';
  if (!renderer) {
    const note = document.createElement('p');
    note.className = 'bench-note';
    note.textContent = 'BYPASS — raw signal, no renderer active.';
    bench.appendChild(note);
    return;
  }
  const head = document.createElement('div');
  head.className = 'bench-head';
  const title = document.createElement('h2');
  title.textContent = `${RENDERERS[rendererIdx].replace('-', ' ')} parameters`;
  head.appendChild(title);
  const fps = document.createElement('span');
  fps.className = 'bench-fps';
  fps.textContent = 'fps: --';
  head.appendChild(fps);
  benchFpsEl = fps;                       // sampled by the fps meter below
  const copy = document.createElement('button');
  copy.className = 'bench-copy';
  copy.textContent = 'copy state diff';
  copy.addEventListener('click', async () => {
    const text = renderer.stateDiff();
    try { await navigator.clipboard.writeText(text); copy.textContent = 'copied'; }
    catch (_) { console.log('[tv]\n' + text); copy.textContent = 'see console'; }
    setTimeout(() => { copy.textContent = 'copy state diff'; }, 1400);
  });
  head.appendChild(copy);
  bench.appendChild(head);

  for (const group of renderer.constructor.effectSchema) {
    const fs = document.createElement('fieldset');
    fs.className = 'bench-group';
    const lg = document.createElement('legend');
    lg.textContent = group.title;
    fs.appendChild(lg);
    for (const item of group.items) {
      const block = document.createElement('div');
      block.className = 'bench-item';
      const row = document.createElement('label');
      row.className = 'bench-toggle';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!renderer.effects[item.key];
      cb.addEventListener('change', () => { renderer.effects[item.key] = cb.checked; });
      row.appendChild(cb);
      const name = document.createElement('span');
      name.textContent = item.label;
      row.appendChild(name);
      row.appendChild(makeBadge(item.scope));
      block.appendChild(row);
      const desc = document.createElement('p');
      desc.className = 'bench-desc';
      desc.textContent = item.desc;
      block.appendChild(desc);
      for (const p of (item.params || [])) {
        const prow = document.createElement('div');
        prow.className = 'bench-param';
        const sub = document.createElement('span');
        sub.textContent = p.sub;
        prow.appendChild(sub);
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = String(p.min); slider.max = String(p.max); slider.step = String(p.step);
        const val = document.createElement('output');
        const fmt = (v) => v.toFixed(Math.max(0, -Math.floor(Math.log10(p.step))));
        const init = renderer.readParam(p.opt);
        slider.value = String(init);
        val.textContent = fmt(init);
        slider.addEventListener('input', () => {
          const v = parseFloat(slider.value);
          val.textContent = fmt(v);
          renderer.writeParam(p.opt, v);
        });
        prow.appendChild(slider);
        prow.appendChild(val);
        if (p.scope && p.scope !== item.scope) prow.appendChild(makeBadge(p.scope));
        block.appendChild(prow);
      }
      fs.appendChild(block);
    }
    bench.appendChild(fs);
  }
}
function makeBadge(scope) {
  const b = document.createElement('span');
  b.className = `badge badge-${scope}`;
  b.textContent = scope;
  return b;
}
```

Plus a small fps meter (module scope): `let benchFpsEl = null;` and a 500 ms `setInterval` that, while `renderer` exists, reads frame counts (`renderer._frameCount` delta) into `benchFpsEl.textContent`.

- [ ] **Step 6.2: Bench CSS** — fieldsets in `grid-template-columns: repeat(auto-fill, minmax(280px, 1fr))`, max-width ~960px centered; monospace; badge colors: `universal` gray, `trinitron` cyan, `shadow-mask` magenta (hardcoded hex — no tokens.css on this page).
- [ ] **Step 6.3: Verify via Playwright MCP:** TRINITRON bench shows damper wires + gap mask rows with `trinitron` badges and no curvature-mode select; SHADOW MASK bench shows dot-radius with `shadow-mask` badge, no V slider; toggling `scanlines` / dragging `persistence` visibly changes the screen (screenshot delta); BYPASS collapses bench to the note; copy-state-diff reflects a slider change. Console clean.
- [ ] **Step 6.4: Commit:**

```bash
git add docs/tv.html
git commit -m "Add schema-driven parameter bench with scope badges to tv.html

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: CLAUDE.md update

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 7.1:** In **File layout**, add after the `sprinkles.js` bullet:

```markdown
- `docs/tv.html` — unlisted dev/tuning page ("TV service bay"): a 4:3 CRT in a woodgrain console-TV cabinet. CHANNEL knob (five demo reels: SMPTE bars, convergence crosshatch, Interslice test card, motion reel, snow) and RENDERER knob (Trinitron / ShadowMask / raw bypass), with a schema-driven parameter bench below. Deep-linkable via `?ch=2..6&renderer=trinitron|shadow-mask|bypass`.
```

- [ ] **Step 7.2:** Replace the stale **MIRABEL playback test** consumer bullet (the page was deleted in `d7b95f1`) with a **TV service bay** bullet describing tv.html as the second consumer: fixed `viewSize [320,240]` / `canvasSize [640,480]` / `stripeUpscale 2`, renderer swap by destroy/reconstruct on one WebGL canvas, separate 2-D bypass canvas (context types are permanent), `debugOverlay: false`, permanent bypass + disabled knob when WebGL2/extensions are missing.

- [ ] **Step 7.3:** In the **CRT renderers** section, document the new API and axes:

```markdown
**Effect schema + axes.** Each renderer exposes a class-level `effectSchema`
static (groups → items → params) with `scope: 'universal' | 'trinitron' |
'shadow-mask'` tags — the realism axes from
`specs/2026-06-10-crt-effect-axes-and-tv-page-design.md`. The built-in
`?debug=1` overlay and the tv.html bench both render from it; param access
goes through `readParam(opt)` / `writeParam(opt, value)` (which handle the
`__convergenceSpread` / `__damperDarkness` synthetics) and `stateDiff()`
(diff vs. construction-time baseline). Tube-determined options are pinned by
defaults, not offered in menus: Trinitron is cylindrical-faced with X-only
convergence spread and anisotropic beam spread; ShadowMask is
spherical-faced, isotropic, with 2-D convergence spread.
```

  Also update the "16 effects … minus damperWires and gapMask" sentence to mention the menus are schema-curated.

- [ ] **Step 7.4: Commit:**

```bash
git add CLAUDE.md
git commit -m "Document tv.html, effect schema/axes API; drop stale mirabel section

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Full verification sweep

No file changes (fix-ups excepted).

- [ ] **Step 8.1:** Hero: `/` and `/?crt=shadow-mask`, dark + light + OS-preference path (no `data-theme` attribute), vs. Task 0 baselines. `?debug=1` overlay spot-check on both.
- [ ] **Step 8.2:** tv.html matrix: 3 renderer positions × channels 2, 3, 6 screenshots; keyboard knob operation; `?ch=4&renderer=shadow-mask` deep link; bench toggle spot-checks; fps ≥ ~55 on the default view.
- [ ] **Step 8.3:** Console clean everywhere. Fix anything found; amend nothing — fixes are new commits.

---

### Task 9: Go-ham motion reel (fresh subagent)

**Files:**
- Modify: `docs/tv.html` (body of `drawMotionReel` only)

- [ ] **Step 9.1:** Dispatch a **fresh** subagent (Opus-tier+) whose prompt contains ONLY: the channel contract (pure `drawMotionReel(ctx, t, w, h)` at 320×240, fills frame, canvas-2D only, no assets, no new globals beyond function-scope statics, ~60 fps budget on the 2-D signal canvas), where to edit, and creative license: *"This plays through a simulated Trinitron on a 1978 woodgrain console. Show off — make a demo-scene-worthy reel (multiple scenes welcome: starfield, plasma, bouncing Interslice wordmark, vector tunnel — your call). Go ham."* The subagent must NOT read the rest of the repo (keeps the fun out of main context and the reel unbiased).
- [ ] **Step 9.2:** Review the diff (contract compliance, no stray edits), verify ch 5 under all three renderer positions via Playwright MCP, check fps.
- [ ] **Step 9.3: Commit:**

```bash
git add docs/tv.html
git commit -m "Replace motion-reel placeholder with the real reel (ch 5)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Post-plan notes

- Push to `main` after Task 3 and again after Task 8/9 (each push redeploys Pages; tv.html is unlisted so mid-stream deploys are harmless).
- The boot presets in Task 4 are starting points — the page exists to retune them; expect a follow-up tuning commit driven by Chris using the bench.
