# Honest Trinitron Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the dark-mode Interslice logo from "stripe-mask cheats over un-quantized vector source" to honest per-cell phosphor sampling, with eight inspection-reward details (persistence, convergence drift, per-cell hotspots, stripe shimmer, finite-extent halo with cell-color-accurate leakage, slow scan-band modulation, P22 per-channel decay, and damping-wire diffraction halos).

**Architecture:** Canvas-2D renderer in a new `docs/trinitron.js`, side-by-side with the existing SVG. The renderer accepts a signal callback and is source-agnostic (reusable). The page falls back to the current SVG implementation if JS is off or init fails.

**Tech Stack:** Plain JavaScript (no module system — script tag is `<script src>` not `type="module"` so `file://` preview still works), Canvas 2D API, HTML inline `<script>` glue, no build step, no dependencies.

**Spec:** `specs/2026-05-19-honest-trinitron-design.md`

**Verification model:** This repo has no tests by design (CLAUDE.md: "No tests, no linters, no package manager"). Each task ends with a concrete browser-inspection step that confirms the new behavior before committing.

**Local preview:** `python3 -m http.server -d docs 8000` then visit `http://localhost:8000`. Direct `file://` open of `docs/index.html` also works (no modules used). Toggle dark mode via DevTools by setting `<html data-theme="dark">`.

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `docs/trinitron.js` | NEW | The `Trinitron` class — source-agnostic Canvas-2D renderer. Exposes `window.Trinitron`. |
| `docs/index.html` | MODIFY | Adds `<canvas>`, `<script src="trinitron.js">`, inline boot script, CSS rules for canvas positioning + SVG-layer hiding when active. Damping-wire markup gets a halo enhancement (S3). |
| `docs/tokens.css` | UNTOUCHED | No new tokens. |
| `specs/2026-05-19-honest-trinitron-design.md` | EXISTS | Reference. |

---

## Task 1: Skeleton + canvas integration + graceful fallback

**Files:**
- Create: `docs/trinitron.js`
- Modify: `docs/index.html`

This task creates the integration scaffolding with a no-op renderer that paints a solid color. The point is to prove:
- The canvas mounts in the right place
- The class toggle (`<html class="trinitron-active">`) gates SVG layers correctly
- Removing the script (simulating JS-off) falls back to the current SVG implementation cleanly

### Steps

- [ ] **Step 1: Baseline check — what dark mode looks like now**

Open `docs/index.html` in a browser. Open DevTools, set `<html data-theme="dark">`. Note: you see the current Trinitron logo with SVG-rendered stripes, bleed halo, scanlines, wires, glass. Take a screenshot or just remember what it looks like — this is the no-JS fallback baseline.

- [ ] **Step 2: Create `docs/trinitron.js` with the minimal stub**

Create `docs/trinitron.js` with this content:

```js
(function () {
  'use strict';

  class Trinitron {
    constructor(canvasEl, opts) {
      this.canvas = canvasEl;
      this.ctx = canvasEl.getContext('2d');
      this.opts = Object.assign({
        viewSize: [200, 200],
        canvasSize: [240, 240],
        cellSize: 3,
        signal: () => {},
        respectReducedMotion: true,
      }, opts);

      const dpr = window.devicePixelRatio || 1;
      const [cw, ch] = this.opts.canvasSize;
      this.canvas.width = cw * dpr;
      this.canvas.height = ch * dpr;
      this.canvas.style.width = cw + 'px';
      this.canvas.style.height = ch + 'px';
      this.ctx.scale(dpr, dpr);

      this._rafHandle = null;
      this._startTime = null;
    }

    start() {
      if (this._rafHandle != null) return;
      this._startTime = performance.now();
      const tick = (now) => {
        this._frame(now - this._startTime);
        this._rafHandle = requestAnimationFrame(tick);
      };
      this._rafHandle = requestAnimationFrame(tick);
    }

    stop() {
      if (this._rafHandle != null) {
        cancelAnimationFrame(this._rafHandle);
        this._rafHandle = null;
      }
    }

    _frame(/* timeMs */) {
      // No-op placeholder — paint a solid magenta so we can verify the canvas
      // mounted in the right place. Subsequent tasks replace this body.
      const [cw, ch] = this.opts.canvasSize;
      this.ctx.fillStyle = 'rgba(229, 4, 127, 0.85)';
      this.ctx.fillRect(0, 0, cw, ch);
    }
  }

  window.Trinitron = Trinitron;
})();
```

- [ ] **Step 3: Add the canvas element to `docs/index.html`**

In `docs/index.html`, locate the `.stack` div in the hero (around line 585). Add a `<canvas>` element as the **first child** of `.stack` (so it renders before the SVG and therefore *below* it in z-order):

Find:
```html
    <div class="stack">
      <svg class="mark" viewBox="0 0 200 200" width="168" height="168" role="img" aria-label="Interslice mark">
```

Replace with:
```html
    <div class="stack">
      <canvas class="trinitron" width="240" height="240" aria-hidden="true"></canvas>
      <svg class="mark" viewBox="0 0 200 200" width="168" height="168" role="img" aria-label="Interslice mark">
```

- [ ] **Step 4: Add the script tag and inline boot script**

In `docs/index.html`, just before the closing `</body>` tag, add:

```html
<script src="trinitron.js"></script>
<script>
(function () {
  'use strict';

  function isDark() {
    const t = document.documentElement.dataset.theme;
    if (t === 'dark') return true;
    if (t === 'light') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function init() {
    const canvas = document.querySelector('canvas.trinitron');
    if (!canvas || !window.Trinitron) return;

    try {
      const trinitron = new window.Trinitron(canvas, {
        // signal callback is wired up in a later task
      });
      window.__trinitron = trinitron;

      if (isDark()) {
        trinitron.start();
        document.documentElement.classList.add('trinitron-active');
      }
    } catch (err) {
      // Silent fallback — page degrades to the SVG-only dark-mode implementation.
      // Don't add the .trinitron-active class.
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
</script>
</body>
```

- [ ] **Step 5: Add CSS rules for the canvas and SVG-layer gating**

In `docs/index.html`, locate the inline `<style>` block. Find the `.stack` rule (around line 86) and add canvas + activation rules **immediately after** the `.stack` block. Insert this CSS:

```css
  /* Trinitron canvas overlay — dark mode only, sits below the .mark SVG.
     Default display: none; only the two dark-mode paths reveal it. */
  .trinitron {
    position: absolute;
    /* Center over the SVG mark, which is 168×168. The canvas is 240×240
       logical, so it extends ~36px past the silhouette on each side for
       the bleed halo to live in. */
    width: 240px;
    height: 240px;
    pointer-events: none;
    z-index: 0;
    display: none;
  }
  .stack .mark { position: relative; z-index: 1; }

  /* Canonical triple-activation pattern (see CLAUDE.md): explicit dark
     OR (OS-dark AND not pinned-to-light). No light-mode rule needed —
     display: none is the default. */
  :root.trinitron-active[data-theme="dark"] .trinitron { display: block; }
  @media (prefers-color-scheme: dark) {
    :root.trinitron-active:not([data-theme="light"]) .trinitron { display: block; }
  }

  /* When canvas is active in a dark-mode path, hide the SVG layers the
     canvas replaces. Keep scanlines/wires/glass/hotspots (they overlay
     the canvas). Same triple-activation pattern. */
  :root.trinitron-active[data-theme="dark"] .mark .m-dark .bleed,
  :root.trinitron-active[data-theme="dark"] .mark .m-dark .phosphors {
    display: none;
  }
  @media (prefers-color-scheme: dark) {
    :root.trinitron-active:not([data-theme="light"]) .mark .m-dark .bleed,
    :root.trinitron-active:not([data-theme="light"]) .mark .m-dark .phosphors {
      display: none;
    }
  }
```

- [ ] **Step 6: Verify canvas appears in dark mode with magenta fill**

Reload the page. In DevTools, set `<html data-theme="dark">`. You should see a magenta square (240×240 logical) centered approximately over the logo area. The SVG bleed and phosphor stripes should be HIDDEN, but the scanlines/damping wires/glass gloss/beam hot-spots should still be VISIBLE on top of the magenta.

- [ ] **Step 7: Verify no-JS fallback**

In DevTools, go to Settings (gear icon) → Debugger → "Disable JavaScript." Reload. The magenta canvas should disappear (because `.trinitron-active` is never set), and you should see the original SVG-rendered Trinitron logo as it was before this task (cheat and all). Re-enable JavaScript.

- [ ] **Step 8: Verify light mode is untouched**

Set `<html data-theme="light">`. The canvas should be hidden (`display: none`). The light-mode print-aesthetic logo should look exactly as before.

- [ ] **Step 9: Commit**

```bash
git add docs/trinitron.js docs/index.html
git commit -m "$(cat <<'EOF'
Scaffold trinitron.js + canvas integration with graceful fallback

Adds the canvas element, the script tag, the boot glue, and CSS rules that
gate the canvas behind a .trinitron-active class set only on successful
JS init. The Trinitron class is a stub that paints magenta; subsequent
tasks replace its _frame body.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Signal capture pipeline

**Files:**
- Modify: `docs/index.html` (the inline boot script)
- Modify: `docs/trinitron.js`

This task rasterizes the SVG arms and hub to `Image` elements once on load, then implements the per-frame signal-capture step that paints them with the current rotation. The Trinitron class paints the captured signal directly to its output canvas (no cell processing yet), so we can verify the source pipeline works end-to-end.

### Steps

- [ ] **Step 1: Extract the SVG arms and hub as standalone serializable groups**

Open `docs/index.html`. In the `<defs>` block (around line 694), the `#phosphor-arms` and `#phosphor-hub` groups already exist. We'll serialize these as SVG document strings inside the boot script. No file changes needed for this step — just confirm the IDs exist.

- [ ] **Step 2: Add SVG-to-Image rasterization helpers to the boot script**

In `docs/index.html`, find the inline boot script (added in Task 1). Replace it with:

```html
<script>
(function () {
  'use strict';

  function isDark() {
    const t = document.documentElement.dataset.theme;
    if (t === 'dark') return true;
    if (t === 'light') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  // Serialize a fragment (the arms or hub group) into a standalone SVG document,
  // wrap it in a blob URL, and resolve to a loaded HTMLImageElement.
  function rasterizeFragment(fragmentMarkup) {
    const doc = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">${fragmentMarkup}</svg>`;
    const blob = new Blob([doc], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
      img.src = url;
    });
  }

  // Markup for the two phosphor source groups. Kept inline so the script is
  // self-contained — and the design system explicitly uses these exact colors.
  const ARMS_MARKUP = `
    <g fill="none" stroke-width="24" stroke-linecap="round">
      <line x1="100" y1="100" x2="100"    y2="28"  stroke="#F32C09"/>
      <line x1="100" y1="100" x2="37.65"  y2="136" stroke="#019C49"/>
      <line x1="100" y1="100" x2="162.35" y2="136" stroke="#0001A0"/>
    </g>
    <circle cx="100"    cy="28"  r="24" fill="#F32C09"/>
    <circle cx="37.65"  cy="136" r="24" fill="#019C49"/>
    <circle cx="162.35" cy="136" r="24" fill="#0001A0"/>`;

  const HUB_MARKUP = `
    <path d="M 100 100 Q 114.736 88.487 134 100 A 34 34 0 0 0 117 70.555 Q 97.397 81.482 100 100 Z" fill="#E5047F"/>
    <path d="M 100 100 Q 97.397 81.482 117 70.555 A 34 34 0 0 0 83 70.555 Q 82.662 92.995 100 100 Z" fill="#F32C09"/>
    <path d="M 100 100 Q 82.662 92.995 83 70.555 A 34 34 0 0 0 66 100 Q 85.264 111.513 100 100 Z" fill="#FED105"/>
    <path d="M 100 100 Q 85.264 111.513 66 100 A 34 34 0 0 0 83 129.445 Q 102.603 118.518 100 100 Z" fill="#019C49"/>
    <path d="M 100 100 Q 102.603 118.518 83 129.445 A 34 34 0 0 0 117 129.445 Q 117.338 107.005 100 100 Z" fill="#00A8F3"/>
    <path d="M 100 100 Q 117.338 107.005 117 129.445 A 34 34 0 0 0 134 100 Q 114.736 88.487 100 100 Z" fill="#0001A0"/>`;

  // Rotation: 36 seconds for 360°, reverse direction (matches the existing
  // CSS keyframe @ docs/index.html:129 / .hub-segs CSS animation).
  const ROT_PERIOD_MS = 36 * 1000;
  function hubAngleDeg(timeMs) {
    return -(timeMs / ROT_PERIOD_MS) * 360;
  }

  async function init() {
    const canvas = document.querySelector('canvas.trinitron');
    if (!canvas || !window.Trinitron) return;

    let armsImg, hubImg;
    try {
      [armsImg, hubImg] = await Promise.all([
        rasterizeFragment(ARMS_MARKUP),
        rasterizeFragment(HUB_MARKUP),
      ]);
    } catch (err) {
      return; // Fall back to SVG implementation
    }

    function signal(ctx, timeMs) {
      // ctx is a 200×200-coordinate offscreen 2D context.
      ctx.drawImage(armsImg, 0, 0, 200, 200);
      ctx.save();
      ctx.translate(100, 100);
      ctx.rotate(hubAngleDeg(timeMs) * Math.PI / 180);
      ctx.translate(-100, -100);
      ctx.drawImage(hubImg, 0, 0, 200, 200);
      ctx.restore();
    }

    try {
      const trinitron = new window.Trinitron(canvas, { signal });
      window.__trinitron = trinitron;

      if (isDark()) {
        trinitron.start();
        document.documentElement.classList.add('trinitron-active');
      }
    } catch (err) {
      // Silent fallback
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
</script>
```

- [ ] **Step 3: Update Trinitron's `_frame` to capture and display the signal**

In `docs/trinitron.js`, replace the entire class body with this. The class now allocates a signal canvas and uses it as the render source:

```js
(function () {
  'use strict';

  class Trinitron {
    constructor(canvasEl, opts) {
      this.canvas = canvasEl;
      this.ctx = canvasEl.getContext('2d');
      this.opts = Object.assign({
        viewSize: [200, 200],
        canvasSize: [240, 240],
        cellSize: 3,
        signal: () => {},
        respectReducedMotion: true,
      }, opts);

      const dpr = window.devicePixelRatio || 1;
      const [cw, ch] = this.opts.canvasSize;
      const [vw, vh] = this.opts.viewSize;
      this.canvas.width = cw * dpr;
      this.canvas.height = ch * dpr;
      this.canvas.style.width = cw + 'px';
      this.canvas.style.height = ch + 'px';
      this.ctx.scale(dpr, dpr);
      this.ctx.imageSmoothingEnabled = false;

      // Bleed margin = (canvasSize - viewSize) / 2 per axis
      this.bleedMargin = (cw - vw) / 2;

      // Offscreen signal canvas — caller paints into 200×200 logical coords
      this.signalCanvas = document.createElement('canvas');
      this.signalCanvas.width = vw;
      this.signalCanvas.height = vh;
      this.signalCtx = this.signalCanvas.getContext('2d');
      this.signalCtx.imageSmoothingEnabled = false;

      this._rafHandle = null;
      this._startTime = null;
    }

    start() {
      if (this._rafHandle != null) return;
      this._startTime = performance.now();
      const tick = (now) => {
        this._frame(now - this._startTime);
        this._rafHandle = requestAnimationFrame(tick);
      };
      this._rafHandle = requestAnimationFrame(tick);
    }

    stop() {
      if (this._rafHandle != null) {
        cancelAnimationFrame(this._rafHandle);
        this._rafHandle = null;
      }
    }

    _frame(timeMs) {
      const [vw, vh] = this.opts.viewSize;
      const [cw, ch] = this.opts.canvasSize;

      // 1. Capture signal into the offscreen canvas
      this.signalCtx.clearRect(0, 0, vw, vh);
      this.opts.signal(this.signalCtx, timeMs);

      // 2. Paint signal directly onto output canvas (no cell processing yet).
      //    Offset by bleedMargin so the source region is centered.
      this.ctx.clearRect(0, 0, cw, ch);
      this.ctx.drawImage(this.signalCanvas, this.bleedMargin, this.bleedMargin);
    }
  }

  window.Trinitron = Trinitron;
})();
```

- [ ] **Step 4: Verify the raw signal appears via canvas, rotating**

Reload the page (with JS enabled, dark mode). You should see:
- The arms and circular tip balls (red north, green southwest, blue southeast) drawn via canvas.
- The center pinwheel rotating slowly (~36s per turn, counterclockwise).
- The scanlines, damping wires, glass gloss, and beam hot-spots still overlaying on top from the SVG.
- The canvas is 240×240 logical, so there's a transparent margin around the logo where the bleed will eventually go.

Expected gotcha: the canvas-painted logo will be **smaller** than the original 168×168 SVG. The canvas is 240×240 logical, sitting where the SVG mark used to be. Visual size is approximately correct because the SVG is also 168 within a 240-wide canvas-equivalent area; minor alignment offset is acceptable for now.

- [ ] **Step 5: Verify no-JS fallback still works**

Disable JavaScript in DevTools. Reload. Should still see the SVG-only fallback. Re-enable.

- [ ] **Step 6: Commit**

```bash
git add docs/trinitron.js docs/index.html
git commit -m "$(cat <<'EOF'
Wire up signal capture — canvas renders raw rotating logo source

Boot script rasterizes the arms + hub SVG fragments to Image elements
once on load and provides a signal(ctx, t) callback that composes them
with the current rotation. Trinitron._frame captures the signal into an
offscreen 200x200 canvas and paints it directly to the output. No cell
processing yet — this is the source pipeline working end to end.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: F1 — Honest per-cell sampling + RGB stripe rendering

**Files:**
- Modify: `docs/trinitron.js`

This task adds the core "honest Trinitron" behavior: downsample the source signal to a 67×67 cell grid (nearest-neighbor — no smoothing), then for each output pixel, light the R, G, or B stripe of its enclosing cell at the cell's sampled channel intensity. Mid-cell color transitions now snap to cell boundaries.

### Steps

- [ ] **Step 1: Add cell-grid buffers, the stripe ImageData, and an intermediate stripe canvas to the constructor**

In `docs/trinitron.js`, locate the constructor. After the `signalCanvas` setup and before `this._rafHandle = null`, add:

```js
      // Cell grid — one cell per cellSize × cellSize source-pixel block
      const cs = this.opts.cellSize;
      this.cellGridW = Math.floor(vw / cs);  // 67 for default
      this.cellGridH = Math.floor(vh / cs);  // 67 for default
      const cellCount = this.cellGridW * this.cellGridH;
      this.cellsR = new Float32Array(cellCount);
      this.cellsG = new Float32Array(cellCount);
      this.cellsB = new Float32Array(cellCount);

      // Stripe ImageData (source-region-sized) + an intermediate canvas. We
      // putImageData onto the intermediate canvas, then drawImage it onto the
      // output. Going through an intermediate is necessary because
      // putImageData ignores compositing and always overwrites alpha — so
      // straight putImageData would erase the underlying bleed wherever a
      // stripe pixel is dark. drawImage respects alpha and source-over, so
      // dark (alpha=0) stripe pixels let the bleed show through correctly.
      this.stripeImageData = this.ctx.createImageData(vw, vh);
      this.stripeCanvas = document.createElement('canvas');
      this.stripeCanvas.width = vw;
      this.stripeCanvas.height = vh;
      this.stripeCtx = this.stripeCanvas.getContext('2d');
```

- [ ] **Step 2: Replace `_frame` with the cell-sampling + stripe-render pipeline**

In `docs/trinitron.js`, replace the existing `_frame` method body with:

```js
    _frame(timeMs) {
      const [vw, vh] = this.opts.viewSize;
      const [cw, ch] = this.opts.canvasSize;

      // 1. Capture signal into the offscreen canvas
      this.signalCtx.clearRect(0, 0, vw, vh);
      this.opts.signal(this.signalCtx, timeMs);

      // 2. Sample cells (nearest-neighbor at cell center)
      this._sampleCells();

      // 3. Render RGB stripes into ImageData, then copy to the intermediate
      //    stripeCanvas so we can composite via drawImage in step 4
      this._renderStripes();
      this.stripeCtx.putImageData(this.stripeImageData, 0, 0);

      // 4. Composite to output canvas. drawImage respects alpha (unlike
      //    putImageData), so dark stripe pixels (alpha=0) let any future
      //    bleed layer show through.
      this.ctx.clearRect(0, 0, cw, ch);
      this.ctx.drawImage(this.stripeCanvas, this.bleedMargin, this.bleedMargin);
    }
```

- [ ] **Step 3: Implement `_sampleCells`**

In `docs/trinitron.js`, add this method to the class (after `_frame`):

```js
    _sampleCells() {
      const [vw, vh] = this.opts.viewSize;
      const cs = this.opts.cellSize;
      const cw = this.cellGridW;
      const ch = this.cellGridH;
      const half = Math.floor(cs / 2);

      const imgData = this.signalCtx.getImageData(0, 0, vw, vh);
      const px = imgData.data;

      for (let cy = 0; cy < ch; cy++) {
        const sy = cy * cs + half;
        for (let cx = 0; cx < cw; cx++) {
          const sx = cx * cs + half;
          const pi = (sy * vw + sx) * 4;
          const ci = cy * cw + cx;
          this.cellsR[ci] = px[pi];
          this.cellsG[ci] = px[pi + 1];
          this.cellsB[ci] = px[pi + 2];
        }
      }
    }
```

- [ ] **Step 4: Implement `_renderStripes`**

In `docs/trinitron.js`, add this method to the class (after `_sampleCells`):

```js
    _renderStripes() {
      const [vw, vh] = this.opts.viewSize;
      const cs = this.opts.cellSize;
      const cw = this.cellGridW;
      const ch = this.cellGridH;
      const out = this.stripeImageData.data;

      // Scanline dim factor for the "off" row of each cell. Cell rows 0..cs-2
      // are "lit" (factor 1.0); row cs-1 is "dim" (factor 0.7) — that's the
      // single dim band per cell-row, equivalent to the existing SVG scanline
      // pattern's 1-of-3 dim rows.
      const SCAN_DIM_FACTOR = 0.7;

      for (let py = 0; py < vh; py++) {
        const cy = (py / cs) | 0;
        if (cy >= ch) continue;
        const subY = py - cy * cs;
        const scanDim = (subY === cs - 1) ? SCAN_DIM_FACTOR : 1.0;

        for (let px = 0; px < vw; px++) {
          const cx = (px / cs) | 0;
          if (cx >= cw) continue;
          const subX = px - cx * cs;
          const ci = cy * cw + cx;
          const oi = (py * vw + px) * 4;

          // Stripe assignment by sub-column: 0→R, 1→G, 2→B
          let r = 0, g = 0, b = 0;
          if (subX === 0) r = this.cellsR[ci];
          else if (subX === 1) g = this.cellsG[ci];
          else b = this.cellsB[ci];

          out[oi]     = r * scanDim;
          out[oi + 1] = g * scanDim;
          out[oi + 2] = b * scanDim;
          // Alpha=0 in dark areas so the bleed (to be added in Task 4) shows
          // through. Alpha=255 in lit areas so the sharp stripe color
          // overrides the soft bleed beneath it.
          out[oi + 3] = (r + g + b > 0) ? 255 : 0;
        }
      }
    }
```

- [ ] **Step 5: Hide the SVG scanline pattern (it's now in the canvas)**

The stripe render bakes a scanline-dim row per cell, so the SVG scanline overlay would double up. Hide it when canvas is active.

In `docs/index.html`, find the CSS block added in Task 1 with the `.trinitron-active` rules. Add the SVG scanline-hiding rules. Find:

```css
  /* When canvas is active in dark mode, hide the SVG layers the canvas
     replaces. Keep scanlines/wires/glass/hotspots (they overlay the canvas). */
  :root.trinitron-active[data-theme="dark"] .mark .m-dark .bleed,
  :root.trinitron-active[data-theme="dark"] .mark .m-dark .phosphors {
    display: none;
  }
```

The SVG scanlines are a `<rect>` filled with `url(#scanlines)` inside the masked group. Give it a class so we can target it. In `docs/index.html` find:

```html
            <!-- 2c. scanlines — fainter horizontal dim bands -->
            <rect x="0" y="0" width="200" height="200" fill="url(#scanlines)"/>
```

Replace with:

```html
            <!-- 2c. scanlines — fainter horizontal dim bands. Hidden when canvas
                 is active because the canvas bakes scanlines into the stripe render. -->
            <rect class="svg-scanlines" x="0" y="0" width="200" height="200" fill="url(#scanlines)"/>
```

Then extend the existing CSS rule to include `.svg-scanlines`. Update the rule to:

```css
  :root.trinitron-active[data-theme="dark"] .mark .m-dark .bleed,
  :root.trinitron-active[data-theme="dark"] .mark .m-dark .phosphors,
  :root.trinitron-active[data-theme="dark"] .mark .m-dark .svg-scanlines {
    display: none;
  }
  @media (prefers-color-scheme: dark) {
    :root.trinitron-active:not([data-theme="light"]) .mark .m-dark .bleed,
    :root.trinitron-active:not([data-theme="light"]) .mark .m-dark .phosphors,
    :root.trinitron-active:not([data-theme="light"]) .mark .m-dark .svg-scanlines {
      display: none;
    }
  }
```

- [ ] **Step 6: Verify cell-quantized stripes appear**

Reload (dark mode). You should see:
- The logo rendered as RGB stripes (every 3rd column lit per channel).
- Mid-image color transitions (e.g., the yellow→green segment edge in the hub) should snap to cell boundaries — no half-yellow-half-green stripes.
- Overall brightness is lower than Task 2 (each pixel now lights one channel, not all three). This is correct — the next tasks add hotspot and persistence brightness back, and the bleed adds the halo.

- [ ] **Step 7: Zoom-in verification of the cheat-removal**

In your browser, zoom to 400-500% (Ctrl/Cmd-+). Inspect the rotating hub area, specifically the boundary between the yellow petal and the green petal. Confirm: the color transition happens AT a cell boundary, not mid-stripe. Adjacent cells have different colors, but no single stripe shows "half yellow, half green" within its height.

- [ ] **Step 8: Verify no-JS fallback unchanged**

Disable JS, reload. Original SVG version with the cheat intact.

- [ ] **Step 9: Commit**

```bash
git add docs/trinitron.js docs/index.html
git commit -m "$(cat <<'EOF'
F1: honest per-cell sampling + RGB stripe rendering

Replace the stripe-mask cheat with nearest-neighbor downsample to a 67x67
cell grid, then per-output-pixel RGB stripe assignment. Mid-cell color
transitions snap to cell boundaries the way a real Trinitron phosphor
stripe does — it can only be uniformly lit at any moment.

The canvas now also bakes the scanline dim into the stripe render (one
dim row per cell-row), so the SVG scanline pattern is hidden when the
canvas is active to avoid double-dimming.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: N1 — Finite-extent bleed with per-channel additive blur

**Files:**
- Modify: `docs/trinitron.js`

This task implements the halo: take the cell grid (which represents the *signal* being displayed on the phosphor screen behind), upscale it to canvas resolution as three R/G/B-tinted layers, gaussian-blur each independently, composite with `globalCompositeOperation = 'lighter'` (additive), and clip to the area outside the silhouette but within bleedRadius. The result is a halo whose color at any point matches the cell directly behind that point.

### Steps

- [ ] **Step 1: Add bleed-related buffers to the constructor**

In `docs/trinitron.js`, in the constructor after the cell-grid setup, add:

```js
      // Bleed: render cell grid as R/G/B-tinted intermediate at full canvas
      // resolution, then gaussian-blur each. We allocate three offscreen
      // canvases sized to the full canvas (so the blur kernel doesn't
      // truncate at the source region's edge).
      this.bleedRadius = this.opts.bleedRadius != null ? this.opts.bleedRadius : 30;

      this.bleedRCanvas = document.createElement('canvas');
      this.bleedRCanvas.width = cw;
      this.bleedRCanvas.height = ch;
      this.bleedRCtx = this.bleedRCanvas.getContext('2d');

      this.bleedGCanvas = document.createElement('canvas');
      this.bleedGCanvas.width = cw;
      this.bleedGCanvas.height = ch;
      this.bleedGCtx = this.bleedGCanvas.getContext('2d');

      this.bleedBCanvas = document.createElement('canvas');
      this.bleedBCanvas.width = cw;
      this.bleedBCanvas.height = ch;
      this.bleedBCtx = this.bleedBCanvas.getContext('2d');

      // ImageData for painting cell grids into the bleed canvases
      this.cellPaintW = this.cellGridW;
      this.cellPaintH = this.cellGridH;
      this.cellPaintImageData = this.bleedRCtx.createImageData(this.cellPaintW, this.cellPaintH);

      // Silhouette path (for clipping the bleed). Pre-create a Path2D from
      // the SVG path string if provided. Default null = no silhouette clip.
      this.silhouettePath = this.opts.silhouettePath
        ? new Path2D(this.opts.silhouettePath)
        : null;
```

- [ ] **Step 2: Add the silhouette path option default**

In `docs/trinitron.js`, in the constructor's `Object.assign` defaults block, add `bleedRadius` and `silhouettePath`:

Find:
```js
      this.opts = Object.assign({
        viewSize: [200, 200],
        canvasSize: [240, 240],
        cellSize: 3,
        signal: () => {},
        respectReducedMotion: true,
      }, opts);
```

Replace with:
```js
      this.opts = Object.assign({
        viewSize: [200, 200],
        canvasSize: [240, 240],
        cellSize: 3,
        bleedRadius: 30,
        silhouettePath: null,
        signal: () => {},
        respectReducedMotion: true,
      }, opts);
```

- [ ] **Step 3: Add `_renderBleed` method**

In `docs/trinitron.js`, add this method to the class after `_renderStripes`:

```js
    _renderBleed() {
      const [vw, vh] = this.opts.viewSize;
      const [cw, ch] = this.opts.canvasSize;
      const margin = this.bleedMargin;
      const cellsX = this.cellGridW;
      const cellsY = this.cellGridH;

      // Paint cells into a small ImageData (cellGridW × cellGridH).
      // R-channel: store R intensity in all three channels (so the upscale
      // is a single grayscale-ish source representing R brightness).
      // Repeat for G and B.
      const paintChannel = (cells, ctx) => {
        const pd = this.cellPaintImageData.data;
        for (let i = 0, j = 0; i < cells.length; i++, j += 4) {
          const v = cells[i];
          pd[j]     = v;
          pd[j + 1] = v;
          pd[j + 2] = v;
          pd[j + 3] = 255;
        }
        // Paint into a temporary 1×1-per-cell-block area, then drawImage with
        // scaling to enlarge it across the bleed canvas.
        ctx.clearRect(0, 0, cw, ch);
        // Use a temp canvas to upscale via drawImage
        const tmp = this._bleedPaintTmp || (this._bleedPaintTmp = document.createElement('canvas'));
        if (tmp.width !== cellsX || tmp.height !== cellsY) {
          tmp.width = cellsX;
          tmp.height = cellsY;
        }
        const tmpCtx = tmp.getContext('2d');
        tmpCtx.putImageData(this.cellPaintImageData, 0, 0);
        // Smoothing ON for the upscale — that's the "blur from blocks" base.
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.filter = `blur(${Math.round(this.bleedRadius * 0.7)}px)`;
        ctx.drawImage(tmp, margin, margin, vw, vh);
        ctx.filter = 'none';
      };

      paintChannel(this.cellsR, this.bleedRCtx);
      paintChannel(this.cellsG, this.bleedGCtx);
      paintChannel(this.cellsB, this.bleedBCtx);

      // Composite into output: each channel's blurred image tints to R/G/B
      // (via globalCompositeOperation = 'multiply' against a solid red/green/blue),
      // and the three results combine with 'lighter' (additive).
      //
      // Simpler approach: copy the grayscale blur straight into the output's
      // appropriate channel via getImageData/putImageData. Three passes, then
      // a single composite. We'll do that in the composite step.
    }
```

- [ ] **Step 4: Update `_frame` to compose stripes + bleed**

In `docs/trinitron.js`, replace the `_frame` body to insert the bleed step:

```js
    _frame(timeMs) {
      const [vw, vh] = this.opts.viewSize;
      const [cw, ch] = this.opts.canvasSize;

      // 1. Capture signal
      this.signalCtx.clearRect(0, 0, vw, vh);
      this.opts.signal(this.signalCtx, timeMs);

      // 2. Sample cells
      this._sampleCells();

      // 3. Render stripes into ImageData → stripeCanvas
      this._renderStripes();
      this.stripeCtx.putImageData(this.stripeImageData, 0, 0);

      // 4. Render bleed into the three per-channel canvases
      this._renderBleed();

      // 5. Composite to output: bleed first, then stripes on top
      this.ctx.clearRect(0, 0, cw, ch);

      // Bleed: merge three per-channel blurred canvases into a single RGB
      // image and paint it onto the output. Each source canvas was painted
      // with v in all of R/G/B (grayscale) and blurred — so rPix[i],
      // rPix[i+1], rPix[i+2] are equal per pixel of the R-blur. We
      // cherry-pick channel-by-channel to build the merged result.
      const bleedImg = this.ctx.createImageData(cw, ch);
      const bd = bleedImg.data;
      const rPix = this.bleedRCtx.getImageData(0, 0, cw, ch).data;
      const gPix = this.bleedGCtx.getImageData(0, 0, cw, ch).data;
      const bPix = this.bleedBCtx.getImageData(0, 0, cw, ch).data;
      for (let i = 0; i < bd.length; i += 4) {
        bd[i]     = rPix[i];     // R from R-blur
        bd[i + 1] = gPix[i + 1]; // G from G-blur
        bd[i + 2] = bPix[i + 2]; // B from B-blur
        // Alpha = brightness of the most-lit channel at this pixel. Dark
        // (zero) bleed pixels stay transparent so the page bg shows through.
        bd[i + 3] = Math.max(rPix[i], gPix[i + 1], bPix[i + 2]);
      }
      this.ctx.putImageData(bleedImg, 0, 0);

      // Stripes on top via drawImage (NOT putImageData — drawImage respects
      // alpha so dark stripe pixels let the bleed show through; putImageData
      // would overwrite and erase the bleed in source-region-but-unlit areas).
      this.ctx.drawImage(this.stripeCanvas, this.bleedMargin, this.bleedMargin);
    }
```

- [ ] **Step 5: Pass the silhouette path from the boot script**

In `docs/index.html` boot script, in the call to `new window.Trinitron(...)`, add the silhouette path:

Find:
```js
      const trinitron = new window.Trinitron(canvas, { signal });
```

Replace with:
```js
      // SVG silhouette path: same shape as #logo-mask in the SVG defs.
      // Compose three thick stroke paths (arms) + three balls + the pinwheel
      // outer hexagon, expressed as a single path commands string.
      // For now, use a single union approximated as the bounding boxes;
      // refine later if needed.
      const SILHOUETTE_PATH =
        'M 100 28 m -24 0 a 24 24 0 1 0 48 0 a 24 24 0 1 0 -48 0 ' +
        'M 37.65 136 m -24 0 a 24 24 0 1 0 48 0 a 24 24 0 1 0 -48 0 ' +
        'M 162.35 136 m -24 0 a 24 24 0 1 0 48 0 a 24 24 0 1 0 -48 0 ' +
        'M 100 100 m -34 0 a 34 34 0 1 0 68 0 a 34 34 0 1 0 -68 0';

      const trinitron = new window.Trinitron(canvas, {
        signal,
        silhouettePath: SILHOUETTE_PATH,
      });
```

- [ ] **Step 6: Verify the halo appears around the logo**

Reload. In dark mode, you should now see:
- The logo rendered with RGB stripes (from Task 3, unchanged).
- A soft colored halo around each lit area: red glow around the red lobe, green around the green lobe, blue around the blue lobe, and rainbow-cycling colors around the rotating hub.
- The halo extends ~30px past the silhouette edges and fades out.

The halo color at any point should approximately match the *closest lit cell's* color — that's the "light leaking through translucent overlay" fiction working.

- [ ] **Step 7: Hide the SVG `phosphor-bleed` filter (already done in Task 1)**

The CSS in Task 1 hides `.m-dark .bleed`. Confirm by toggling JS off — the old SVG halo should appear (cheat tail and all). JS on — the canvas halo replaces it.

- [ ] **Step 8: Commit**

```bash
git add docs/trinitron.js docs/index.html
git commit -m "$(cat <<'EOF'
N1: translucent-overlay light-leak halo

Render cell-grid as three R/G/B-tinted layers, gaussian-blur each
independently via canvas filter, and composite per-channel into the
output. Halo color at any point matches the cell-behind-it because the
halo *is* the cell grid, blurred — so as the hub rotates, the halo color
in its vicinity changes in lockstep.

The bleed has finite extent because the source cell grid is zero outside
the logo's source-region cells, and the blur naturally drops to zero
within the canvas's bleed margin (~30 SVG units).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: F2 — Phosphor persistence

**Files:**
- Modify: `docs/trinitron.js`

This task adds the previous-frame buffer. Each frame's cells are max-blended with the previous frame's cells, scaled by a persistence factor (default 0.85). The visible result is a decay trail behind the rotating hub edges — invisible at speed, but apparent when you pause the animation.

### Steps

- [ ] **Step 1: Add persistence buffers and the `persistence` option default**

In `docs/trinitron.js`, in the constructor's `Object.assign` defaults block, add:

Find:
```js
        bleedRadius: 30,
        silhouettePath: null,
```

Replace with:
```js
        bleedRadius: 30,
        silhouettePath: null,
        persistence: 0.85,
```

In the constructor, after the cell-grid Float32Arrays, add the persistence buffers:

```js
      this.prevR = new Float32Array(cellCount);
      this.prevG = new Float32Array(cellCount);
      this.prevB = new Float32Array(cellCount);
```

- [ ] **Step 2: Add `_applyPersistence` method**

In `docs/trinitron.js`, add this method after `_sampleCells`:

```js
    _applyPersistence() {
      const p = this.opts.persistence;
      const n = this.cellsR.length;
      for (let i = 0; i < n; i++) {
        // Max-blend new frame with decayed previous frame.
        // Where new > prev*decay, the new frame wins (fresh phosphor).
        // Where new < prev*decay, the previous frame's decay shows through.
        const decayedR = this.prevR[i] * p;
        const decayedG = this.prevG[i] * p;
        const decayedB = this.prevB[i] * p;
        if (decayedR > this.cellsR[i]) this.cellsR[i] = decayedR;
        if (decayedG > this.cellsG[i]) this.cellsG[i] = decayedG;
        if (decayedB > this.cellsB[i]) this.cellsB[i] = decayedB;
      }
      // Store for next frame
      this.prevR.set(this.cellsR);
      this.prevG.set(this.cellsG);
      this.prevB.set(this.cellsB);
    }
```

- [ ] **Step 3: Wire `_applyPersistence` into `_frame`**

In `docs/trinitron.js`, in `_frame`, add the persistence step between cell sampling and stripe rendering:

```js
      // 2. Sample cells
      this._sampleCells();

      // 2.5. Apply persistence (max-blend with decayed previous frame)
      this._applyPersistence();

      // 3. Render stripes (covers source region)
      this._renderStripes();
```

- [ ] **Step 4: Verify persistence trail appears**

Reload. In dark mode, find the rotating hub. The motion is subtle (36s rotation = 10°/second), so the trail is faint. To make it more obvious:
- In DevTools, set `<html data-theme="dark">` and check the rotating petals at the hub.
- You should see a faint colored ghost trailing the leading edge of each rotating petal (especially the magenta and cyan ones, which contrast most).

- [ ] **Step 5: Pause animation to confirm decay**

In DevTools, find the `.hub-segs` rule (or use the `Animations` panel) and pause the rotation. The hub should "settle" — the trail should fade out within ~1-2 seconds as the persistence decay multiplies down to invisibility.

Alternatively, evaluate in the console: `document.querySelectorAll('.hub-segs').forEach(el => el.style.animationPlayState = 'paused')`. Watch the trail decay. To resume: same selector with `''`.

- [ ] **Step 6: Commit**

```bash
git add docs/trinitron.js
git commit -m "$(cat <<'EOF'
F2: phosphor persistence — decay trail behind rotating hub

Each frame max-blends with the previous frame's cells multiplied by a
persistence factor (default 0.85). Where the new signal is brighter, it
wins; where the previous frame's decayed value is brighter, the decay
shows through. Visible as a faint trail behind rotating petal edges,
most apparent when animation is paused.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: N3 — P22 per-channel decay

**Files:**
- Modify: `docs/trinitron.js`

This task extends F2 with per-channel persistence multipliers. Real P22 CRT phosphors have different decay rates: green fastest, red medium, blue slowest. Encoded as `{r: 1.00, g: 0.94, b: 1.04}` multipliers on the base persistence factor.

### Steps

- [ ] **Step 1: Add `perChannelDecay` option default**

In `docs/trinitron.js`, in the constructor's `Object.assign` defaults block, add:

Find:
```js
        persistence: 0.85,
```

Replace with:
```js
        persistence: 0.85,
        perChannelDecay: { r: 1.00, g: 0.94, b: 1.04 },
```

- [ ] **Step 2: Update `_applyPersistence` to use per-channel decay**

In `docs/trinitron.js`, replace the entire `_applyPersistence` method body:

```js
    _applyPersistence() {
      const p = this.opts.persistence;
      const d = this.opts.perChannelDecay;
      // Clamp at 0.99 to prevent runaway accumulation
      const dr = Math.min(0.99, p * d.r);
      const dg = Math.min(0.99, p * d.g);
      const db = Math.min(0.99, p * d.b);
      const n = this.cellsR.length;
      for (let i = 0; i < n; i++) {
        const decayedR = this.prevR[i] * dr;
        const decayedG = this.prevG[i] * dg;
        const decayedB = this.prevB[i] * db;
        if (decayedR > this.cellsR[i]) this.cellsR[i] = decayedR;
        if (decayedG > this.cellsG[i]) this.cellsG[i] = decayedG;
        if (decayedB > this.cellsB[i]) this.cellsB[i] = decayedB;
      }
      this.prevR.set(this.cellsR);
      this.prevG.set(this.cellsG);
      this.prevB.set(this.cellsB);
    }
```

- [ ] **Step 3: Verify subtle color asymmetry in the trail**

Reload. Pause the rotation (as in Task 5 Step 5). Watch the hub trail decay closely. You should notice:
- The green component fades fastest (the petals show less green ghost behind their motion).
- The blue component lingers longest (the cyan/blue petals leave more visible trail).
- The asymmetry is *subtle* — this is a P22 phosphor faithfulness detail, not a flashy effect.

If you can't see the asymmetry at default settings, temporarily bump `persistence` to 0.95 in the boot script (or in DevTools via `window.__trinitron.opts.persistence = 0.95`). Then the per-channel difference becomes more obvious.

- [ ] **Step 4: Commit**

```bash
git add docs/trinitron.js
git commit -m "$(cat <<'EOF'
N3: P22 per-channel persistence

Multiplies the base persistence factor (0.85) by per-channel decay rates
(r: 1.00, g: 0.94, b: 1.04, clamped to <0.99). Green fades fastest, blue
lingers longest — authentic P22 phosphor behavior.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: F3 — RGB convergence drift

**Files:**
- Modify: `docs/trinitron.js`

This task adds slight sub-pixel R/G/B beam misalignment. Static offsets per channel, plus a slow sinusoidal drift. Manifest as colored fringing on stripe edges: zoom in and you'll see a hair of red on one side, blue on the other.

### Steps

- [ ] **Step 1: Add convergence option defaults**

In `docs/trinitron.js`, in the constructor's `Object.assign` defaults block, add:

Find:
```js
        perChannelDecay: { r: 1.00, g: 0.94, b: 1.04 },
```

Replace with:
```js
        perChannelDecay: { r: 1.00, g: 0.94, b: 1.04 },
        convergence: { r: [-0.5, -0.5], g: [0.0, 0.0], b: [0.5, 0.5] },
        convergenceDriftAmplitudePx: 1.0,
        convergenceDriftPeriodSec: 60,
```

(Note: spec mentions `±0.15px` but that's invisible at our resolution. Bumped to `±0.5px` static + `±1.0px` drift = visible fringing.)

- [ ] **Step 2: Update `_renderStripes` to take a time argument and apply convergence**

In `docs/trinitron.js`, replace the `_renderStripes` method body:

```js
    _renderStripes(timeMs) {
      const [vw, vh] = this.opts.viewSize;
      const cs = this.opts.cellSize;
      const cw = this.cellGridW;
      const ch = this.cellGridH;
      const out = this.stripeImageData.data;
      const SCAN_DIM_FACTOR = 0.7;

      // Convergence offsets in source-pixel units. Static base offsets per
      // channel, plus a slow sinusoidal drift.
      const driftAmp = this.opts.convergenceDriftAmplitudePx;
      const driftPhase = (timeMs / 1000) / this.opts.convergenceDriftPeriodSec;
      const drift = driftAmp * Math.sin(2 * Math.PI * driftPhase);
      const c = this.opts.convergence;
      const rdx = c.r[0] + drift;
      const rdy = c.r[1] + drift * 0.6;
      const gdx = c.g[0];
      const gdy = c.g[1];
      const bdx = c.b[0] - drift;
      const bdy = c.b[1] - drift * 0.6;

      const sampleCell = (cells, px, py, dx, dy) => {
        const cx = ((px + dx) / cs) | 0;
        const cy = ((py + dy) / cs) | 0;
        if (cx < 0 || cx >= cw || cy < 0 || cy >= ch) return 0;
        return cells[cy * cw + cx];
      };

      for (let py = 0; py < vh; py++) {
        const cyBase = (py / cs) | 0;
        if (cyBase >= ch) continue;
        const subY = py - cyBase * cs;
        const scanDim = (subY === cs - 1) ? SCAN_DIM_FACTOR : 1.0;

        for (let px = 0; px < vw; px++) {
          const cxBase = (px / cs) | 0;
          if (cxBase >= cw) continue;
          const subX = px - cxBase * cs;
          const oi = (py * vw + px) * 4;

          let r = 0, g = 0, b = 0;
          if (subX === 0) r = sampleCell(this.cellsR, px, py, rdx, rdy);
          else if (subX === 1) g = sampleCell(this.cellsG, px, py, gdx, gdy);
          else b = sampleCell(this.cellsB, px, py, bdx, bdy);

          out[oi]     = r * scanDim;
          out[oi + 1] = g * scanDim;
          out[oi + 2] = b * scanDim;
          // Conditional alpha — see Task 3 Step 4 commentary. Dark pixels
          // need alpha=0 so the bleed shows through; lit pixels need
          // alpha=255 so the sharp stripe overrides the soft bleed.
          out[oi + 3] = (r + g + b > 0) ? 255 : 0;
        }
      }
    }
```

- [ ] **Step 3: Pass `timeMs` to `_renderStripes` from `_frame`**

In `docs/trinitron.js`, in `_frame`, update the call:

Find:
```js
      // 3. Render stripes (covers source region)
      this._renderStripes();
```

Replace with:
```js
      // 3. Render stripes (covers source region)
      this._renderStripes(timeMs);
```

- [ ] **Step 4: Verify convergence fringing**

Reload. Zoom browser to 400-500%. Inspect any sharp edge — e.g., the boundary between the red arm and the black background. You should see:
- A hair of red on one side of the edge.
- A hair of blue on the opposite side.
- The green is centered.

- [ ] **Step 5: Verify drift over time**

Stay zoomed in. Watch a particular edge for 60+ seconds. The red/blue fringe positions should slowly shift back and forth (sinusoidal drift, ±1 device pixel over 60s period).

- [ ] **Step 6: Commit**

```bash
git add docs/trinitron.js
git commit -m "$(cat <<'EOF'
F3: RGB convergence drift

Each channel samples its cell with a sub-pixel offset (-0.5, 0, +0.5
static for R, G, B), with an additional ±1px sinusoidal drift on a 60s
period. Visible as colored fringing at sharp edges when zoomed in,
slowly shifting position over time. The signature 'real CRT photograph'
look.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: F4 + S2 — Per-cell hotspot + stripe-end shimmer

**Files:**
- Modify: `docs/trinitron.js`

This task adds two related per-cell brightness modulations:
- **F4 hotspot**: each cell's center pixel is +15% brighter than its corners (electron-beam dwell).
- **S2 shimmer**: each cell has a stable ±4% brightness offset derived from deterministic noise (phosphor coating non-uniformity).

### Steps

- [ ] **Step 1: Add hotspot and shimmer option defaults**

In `docs/trinitron.js`, in the constructor's `Object.assign` defaults block, add:

Find:
```js
        convergence: { r: [-0.5, -0.5], g: [0.0, 0.0], b: [0.5, 0.5] },
        convergenceDriftAmplitudePx: 1.0,
        convergenceDriftPeriodSec: 60,
```

Replace with:
```js
        convergence: { r: [-0.5, -0.5], g: [0.0, 0.0], b: [0.5, 0.5] },
        convergenceDriftAmplitudePx: 1.0,
        convergenceDriftPeriodSec: 60,
        hotspot: 0.15,
        shimmer: 0.04,
        shimmerSeed: 1983,
```

- [ ] **Step 2: Precompute the shimmer noise array in the constructor**

In `docs/trinitron.js`, after the persistence buffers, add:

```js
      // Shimmer: stable per-cell brightness noise (computed once, never animated).
      // Derived from a small LCG seeded by shimmerSeed so the pattern is
      // deterministic across reloads.
      this.shimmerNoise = new Float32Array(cellCount);
      let lcg = (this.opts.shimmerSeed || 1983) >>> 0;
      const lcgNext = () => {
        lcg = (Math.imul(lcg, 1664525) + 1013904223) >>> 0;
        return lcg / 0xFFFFFFFF;  // 0..1
      };
      for (let i = 0; i < cellCount; i++) {
        // Centered noise: -1..+1, then scaled by shimmer amplitude in the render step
        this.shimmerNoise[i] = (lcgNext() * 2 - 1);
      }
```

- [ ] **Step 3: Apply hotspot + shimmer in `_renderStripes`**

In `docs/trinitron.js`, modify the inner loop of `_renderStripes` to apply the hotspot multiplier (based on sub-cell position) and the shimmer multiplier (based on cell index). Replace the inner loop body:

Find:
```js
        for (let px = 0; px < vw; px++) {
          const cxBase = (px / cs) | 0;
          if (cxBase >= cw) continue;
          const subX = px - cxBase * cs;
          const oi = (py * vw + px) * 4;

          let r = 0, g = 0, b = 0;
          if (subX === 0) r = sampleCell(this.cellsR, px, py, rdx, rdy);
          else if (subX === 1) g = sampleCell(this.cellsG, px, py, gdx, gdy);
          else b = sampleCell(this.cellsB, px, py, bdx, bdy);

          out[oi]     = r * scanDim;
          out[oi + 1] = g * scanDim;
          out[oi + 2] = b * scanDim;
          out[oi + 3] = 255;
        }
```

Replace with:
```js
        for (let px = 0; px < vw; px++) {
          const cxBase = (px / cs) | 0;
          if (cxBase >= cw) continue;
          const subX = px - cxBase * cs;
          const oi = (py * vw + px) * 4;

          // F4 hotspot: cell-center pixel is brighter. Cell center is
          // (cs/2 | 0, cs/2 | 0) within the cell; "in the row of the center"
          // gets a small boost; "the exact center pixel" gets the full boost.
          const cellCenter = cs >> 1;
          const subDist = Math.abs(subX - cellCenter) + Math.abs(subY - cellCenter);
          const hotMod = 1 + this.opts.hotspot * Math.max(0, 1 - subDist);

          // S2 shimmer: per-cell stable noise scaled by shimmer amplitude
          const ci = cyBase * cw + cxBase;
          const shimMod = 1 + this.opts.shimmer * this.shimmerNoise[ci];

          const totalMod = scanDim * hotMod * shimMod;

          let r = 0, g = 0, b = 0;
          if (subX === 0) r = sampleCell(this.cellsR, px, py, rdx, rdy);
          else if (subX === 1) g = sampleCell(this.cellsG, px, py, gdx, gdy);
          else b = sampleCell(this.cellsB, px, py, bdx, bdy);

          out[oi]     = Math.min(255, r * totalMod);
          out[oi + 1] = Math.min(255, g * totalMod);
          out[oi + 2] = Math.min(255, b * totalMod);
          // Conditional alpha — keep the bleed-show-through behavior from Task 3.
          out[oi + 3] = (r + g + b > 0) ? 255 : 0;
        }
```

- [ ] **Step 4: Verify hotspot at high zoom**

Reload. Zoom browser to 600-800%. Inspect any lit area. Each cell (each 3-pixel-wide stripe block) should show a slightly brighter middle row compared to its top and bottom rows. The effect is subtle.

- [ ] **Step 5: Verify shimmer pattern is stable across reloads**

Stay zoomed in on a stationary lit area (e.g., the red arm's stem). Reload the page multiple times. The pattern of slightly-hotter and slightly-cooler cells should be identical each reload (deterministic LCG seeded by `shimmerSeed`).

- [ ] **Step 6: Commit**

```bash
git add docs/trinitron.js
git commit -m "$(cat <<'EOF'
F4 + S2: per-cell hotspot and stripe-end shimmer

F4: each cell's center pixel gets a +15% brightness boost (electron-beam
dwell time peaks at the cell center).

S2: each cell has a stable +/-4% brightness offset derived from an LCG
seeded by shimmerSeed (default 1983 — vintage). Phosphor coating non-
uniformity. Pattern is deterministic across reloads.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: N2 — Slow scan-band brightness modulation

**Files:**
- Modify: `docs/trinitron.js`

This task adds the iconic "rolling scan band" — a slow horizontal brightness sweep that takes 7 seconds to traverse the screen from top to bottom. Visible both inside the screen and in the surrounding halo (because the halo color derives from the cell-behind, which is modulated by the scan).

### Steps

- [ ] **Step 1: Add scan-band option defaults**

In `docs/trinitron.js`, in the constructor's `Object.assign` defaults block, add:

Find:
```js
        hotspot: 0.15,
        shimmer: 0.04,
        shimmerSeed: 1983,
```

Replace with:
```js
        hotspot: 0.15,
        shimmer: 0.04,
        shimmerSeed: 1983,
        scanBandPeriodSec: 7,
        scanBandStrength: 0.08,
```

- [ ] **Step 2: Add `_applyCellModulations` method**

In `docs/trinitron.js`, add this method after `_sampleCells`:

```js
    _applyCellModulations(timeMs) {
      // N2 scan-band: a cosine envelope sweeps top-to-bottom every
      // scanBandPeriodSec. Modulates each cell's brightness uniformly
      // (so the halo derived from these cells also shows the band).
      const ch = this.cellGridH;
      const cw = this.cellGridW;
      const period = this.opts.scanBandPeriodSec;
      const strength = this.opts.scanBandStrength;
      const phase = (timeMs / 1000) / period;

      for (let cy = 0; cy < ch; cy++) {
        const mod = 1 + strength * Math.cos(2 * Math.PI * (cy / ch - phase));
        for (let cx = 0; cx < cw; cx++) {
          const ci = cy * cw + cx;
          this.cellsR[ci] *= mod;
          this.cellsG[ci] *= mod;
          this.cellsB[ci] *= mod;
        }
      }
    }
```

- [ ] **Step 3: Wire `_applyCellModulations` into `_frame`**

In `docs/trinitron.js`, in `_frame`, add the modulation step **after** persistence (so the scan-band modulates the post-persistence cells, including any trail):

Find:
```js
      // 2.5. Apply persistence (max-blend with decayed previous frame)
      this._applyPersistence();

      // 3. Render stripes (covers source region)
      this._renderStripes(timeMs);
```

Replace with:
```js
      // 2.5. Apply persistence (max-blend with decayed previous frame)
      this._applyPersistence();

      // 2.7. Apply cell modulations (N2 scan-band — affects both stripes and bleed)
      this._applyCellModulations(timeMs);

      // 3. Render stripes (covers source region)
      this._renderStripes(timeMs);
```

- [ ] **Step 4: Verify scan-band appears in both screen and halo**

Reload. Watch the logo for 10-15 seconds. You should see:
- A faint horizontal brightness band slowly sweeping from top to bottom.
- The band is visible *both* inside the logo (where the stripes brighten) *and* in the colored halo around it (the halo's intensity rides along).
- One full top-to-bottom sweep takes ~7 seconds.

- [ ] **Step 5: Commit**

```bash
git add docs/trinitron.js
git commit -m "$(cat <<'EOF'
N2: slow scan-band brightness modulation

Cosine envelope sweeps top-to-bottom every 7 seconds, modulating cell
brightness by ±8%. Applied to the cell grid before stripe and bleed
render, so the band is visible both inside the screen and in the
surrounding halo — because the halo color derives from the cells, which
are themselves modulated.

The iconic 'CRT filmed by a camera that's not quite synced to the
refresh rate' look. Rotation itself stays coherent (phase, not amplitude).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: S3 — Damping-wire diffraction halos (SVG only)

**Files:**
- Modify: `docs/index.html`

This task enhances the existing damping wires in the SVG with proper diffraction halos. No JS involvement — pure SVG.

### Steps

- [ ] **Step 1: Find the existing damping-wire markup**

In `docs/index.html`, find the two `<line>` elements at approximately lines 984-985:

```html
            <line x1="0" y1="52"  x2="200" y2="52"  stroke="#000000" stroke-width="1" opacity="0.62"/>
            <line x1="0" y1="136" x2="200" y2="136" stroke="#000000" stroke-width="1" opacity="0.62"/>
```

- [ ] **Step 2: Replace each wire with a 3-layer group (outer cyan glow + dim wire + inner bright core)**

Replace the two lines with:

```html
            <!-- 2d. Trinitron damping wires — barely-there horizontal
                 stabilizer shadows, the Trinitron tell. Each wire is now
                 three layers: a faint cyan diffraction halo, the existing
                 dim wire line, and a bright sub-pixel-thin specular core. -->
            <g class="damping-wire">
              <line x1="0" y1="52" x2="200" y2="52" stroke="#5EE2FF" stroke-width="3"   opacity="0.18"/>
              <line x1="0" y1="52" x2="200" y2="52" stroke="#000000" stroke-width="1"   opacity="0.62"/>
              <line x1="0" y1="52" x2="200" y2="52" stroke="#FFFFFF" stroke-width="0.4" opacity="0.5"/>
            </g>
            <g class="damping-wire">
              <line x1="0" y1="136" x2="200" y2="136" stroke="#5EE2FF" stroke-width="3"   opacity="0.18"/>
              <line x1="0" y1="136" x2="200" y2="136" stroke="#000000" stroke-width="1"   opacity="0.62"/>
              <line x1="0" y1="136" x2="200" y2="136" stroke="#FFFFFF" stroke-width="0.4" opacity="0.5"/>
            </g>
```

- [ ] **Step 3: Verify wire halos at moderate zoom**

Reload. In dark mode, zoom to 200%. Inspect either damping wire (the one tangent to the red ball at y=52, or the one through the green/blue ball centers at y=136). You should see:
- A faint cyan halo extending ±1 device pixel from the wire's centerline.
- The original dim wire still visible inside.
- A sub-pixel-thin bright white specular core right at the wire's center.

- [ ] **Step 4: Verify both themes**

Toggle to light mode — the wires should be completely hidden (light-mode CRT is hidden by `.m-light/.m-dark` mechanism).

Toggle back to dark mode — wires + halos visible.

Disable JS — wire halos should still be visible (this is pure SVG, no JS dependency).

- [ ] **Step 5: Commit**

```bash
git add docs/index.html
git commit -m "$(cat <<'EOF'
S3: damping-wire diffraction halos

Each damping wire is now a 3-layer group: a faint cyan diffraction halo
(stroke-width 3, opacity 0.18), the existing dim wire (unchanged), and a
sub-pixel-thin bright white specular core (stroke-width 0.4, opacity 0.5).
Pure SVG, no JS — works in the no-JS fallback path too.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Accessibility & theme-toggle wiring

**Files:**
- Modify: `docs/trinitron.js`
- Modify: `docs/index.html` (boot script)

This task adds:
- `prefers-reduced-motion: reduce` handling — pauses the renderer and freezes on the current frame
- `prefers-color-scheme` listener — pauses canvas when light mode is preferred
- Robust error fallback — if init fails, `.trinitron-active` is never set and the SVG fallback shows

### Steps

- [ ] **Step 1: Add reduced-motion listener to `Trinitron`**

In `docs/trinitron.js`, add this method to the class (after `stop`):

```js
    _setupReducedMotionListener() {
      if (!this.opts.respectReducedMotion) return;
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      this._reducedMotionMq = mq;
      this._reducedMotionHandler = () => {
        if (mq.matches) this.stop();
        else if (this._wasStartedByUser) this.start();
      };
      // Handle both modern API (addEventListener) and legacy (addListener)
      if (mq.addEventListener) mq.addEventListener('change', this._reducedMotionHandler);
      else if (mq.addListener) mq.addListener(this._reducedMotionHandler);
    }
```

In the constructor, after the buffer setup and before `this._rafHandle = null`, add:

```js
      this._setupReducedMotionListener();
```

- [ ] **Step 2: Modify `start` to respect reduced-motion + paint one static frame**

In `docs/trinitron.js`, replace the `start` method body:

```js
    start() {
      this._wasStartedByUser = true;
      if (this._rafHandle != null) return;
      this._startTime = performance.now();
      // If reduced motion is requested, paint one frame and stop — no rAF loop.
      if (this._reducedMotionMq && this._reducedMotionMq.matches) {
        this._frame(0);
        return;
      }
      const tick = (now) => {
        this._frame(now - this._startTime);
        this._rafHandle = requestAnimationFrame(tick);
      };
      this._rafHandle = requestAnimationFrame(tick);
    }
```

- [ ] **Step 3: Add prefers-color-scheme listener to the boot script**

In `docs/index.html`, in the inline boot script, replace the `init` function. Find:

```js
    try {
      const trinitron = new window.Trinitron(canvas, {
        signal,
        silhouettePath: SILHOUETTE_PATH,
      });
      window.__trinitron = trinitron;

      if (isDark()) {
        trinitron.start();
        document.documentElement.classList.add('trinitron-active');
      }
    } catch (err) {
      // Silent fallback
    }
  }
```

Replace with:

```js
    let trinitron;
    try {
      trinitron = new window.Trinitron(canvas, {
        signal,
        silhouettePath: SILHOUETTE_PATH,
      });
      window.__trinitron = trinitron;
    } catch (err) {
      return; // Silent fallback to SVG
    }

    function syncWithTheme() {
      if (isDark()) {
        trinitron.start();
        document.documentElement.classList.add('trinitron-active');
      } else {
        trinitron.stop();
        document.documentElement.classList.remove('trinitron-active');
      }
    }

    syncWithTheme();

    // Re-sync when OS preference changes
    const colorMq = window.matchMedia('(prefers-color-scheme: dark)');
    const colorHandler = () => syncWithTheme();
    if (colorMq.addEventListener) colorMq.addEventListener('change', colorHandler);
    else if (colorMq.addListener) colorMq.addListener(colorHandler);

    // Re-sync when data-theme changes (manual toggle via DevTools or future UI)
    const themeObserver = new MutationObserver(syncWithTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
  }
```

- [ ] **Step 4: Verify reduced-motion path**

In DevTools, find "Rendering" panel → "Emulate CSS media feature prefers-reduced-motion" → set to "reduce". Reload.

The canvas should paint ONE frame (a static logo with no rotation visible, no scan band moving). The rAF loop should not be running — open the Performance panel and confirm no per-frame paints.

Toggle back to "no preference" — animation should resume on next page reload.

- [ ] **Step 5: Verify theme-toggle wiring**

In DevTools console, evaluate:
```js
document.documentElement.dataset.theme = 'light';
```
The canvas should immediately stop and disappear (CSS `display: none`). The light-mode SVG logo should be visible.

```js
document.documentElement.dataset.theme = 'dark';
```
Canvas should reappear and start animating again.

```js
delete document.documentElement.dataset.theme;
```
The page should pick the theme from OS preference. Toggle the DevTools "Emulate CSS prefers-color-scheme" between light and dark — the canvas should track.

- [ ] **Step 6: Verify error-fallback path**

Temporarily break trinitron.js: in `docs/trinitron.js`, near the top of the constructor (just inside the function), add `throw new Error('test');`. Reload. The page should fall back to the SVG-only rendering (no canvas, original SVG bleed visible).

Remove the test throw. Reload. Canvas should resume.

- [ ] **Step 7: Commit**

```bash
git add docs/trinitron.js docs/index.html
git commit -m "$(cat <<'EOF'
Accessibility + theme-toggle wiring

- prefers-reduced-motion: reduce → renderer paints one static frame and
  stops; toggle off resumes animation
- prefers-color-scheme change → canvas starts/stops in sync with the
  preferred theme
- data-theme attribute change (MutationObserver) → same wiring works
  for manual / future-UI toggles
- Construction errors → page silently degrades to SVG fallback;
  .trinitron-active is never set

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Cross-browser verification

**Files:** None (pure manual verification)

This task runs through the 15-item by-eye verification list from the spec, in each of Chrome, Firefox, and Safari. Any deviations get noted; critical ones get fixed; cosmetic ones get logged as future work.

Test in this order: Chrome (most coverage), Firefox (second-most), Safari (most-likely-to-surprise).

### Steps

- [ ] **Step 1: Chrome — run the spec's 15-item verification checklist**

Open `docs/index.html` in Chrome (or via `python3 -m http.server -d docs 8000`). Run through each item from the spec (`specs/2026-05-19-honest-trinitron-design.md`, section 11):

1. Static check — logo + halo visible, no console errors
2. Stripe honesty — yellow→green edge snaps to cell boundaries (zoom 400%+)
3. Persistence — pause animation, see trail decay over ~5 frames
4. Convergence drift — RGB fringing on arm edges, slowly shifts (60s)
5. Per-cell hotspot — slight brighter center pixel per cell (zoom 800%+)
6. Stripe shimmer — stable cell brightness variation across reloads
7. Damping wire halos — cyan halo + white core (zoom 200%+)
8. Bleed — halo color matches lit cell behind, rotates with hub
9. Scan band — slow vertical brightness sweep visible in screen AND halo
10. Per-channel decay — green fades fastest, blue lingers (pause + watch)
11. Reduced motion — canvas paints one frame, stops
12. No-JS fallback — disable JS, original SVG version visible
13. Light mode — canvas hidden, print-aesthetic logo visible
14. OS-preference path — clear data-theme, toggle OS dark/light, canvas tracks
15. Tab inactive — switch tabs 30s, return, animation picks up without glitches

For each item, mark PASS or note what's wrong.

- [ ] **Step 2: Firefox — same 15-item checklist**

Open in Firefox. Repeat the checklist. Two known potential differences:
- Canvas `filter: blur()` may render slightly differently. Should still produce a halo, possibly slightly softer or sharper.
- `imageSmoothingQuality: 'high'` is supported but Firefox's default smoothing may differ.

Note any visual divergence; if minor (e.g., halo is 10% softer), log for future tuning. If major (e.g., no halo at all), fix before declaring complete.

- [ ] **Step 3: Safari — same 15-item checklist**

Open in Safari. Safari has historically been the strictest about canvas-filter support; verify the bleed renders. Two specific things to check:
- `globalCompositeOperation` behavior with `lighter` — should give additive R+G+B compositing.
- `Path2D` constructor with the silhouette path string — should accept it.

- [ ] **Step 4: Document any cross-browser issues found**

If anything failed in Firefox or Safari, decide:
- Critical (canvas doesn't render at all, errors thrown): FIX before merging. Likely a `filter` syntax or `Path2D` issue.
- Cosmetic (halo slightly softer/sharper, fringing slightly different shade): LOG in the spec's "Risks & known unknowns" section as a footnote.

For critical fixes, make them now as separate commits.

- [ ] **Step 5: Performance spot-check**

In Chrome DevTools Performance panel, record 5 seconds of the dark-mode page. Verify:
- No per-frame work exceeds ~2ms.
- No garbage-collection pauses tied to the renderer.
- Frame rate holds at 60fps (or your display's refresh rate).

If per-frame work exceeds 5ms on a modern machine, that's worth investigating — likely the `getImageData` + `putImageData` in `_renderBleed`. Could be optimized by caching the ImageData reads, but only if it's actually a problem.

- [ ] **Step 6: Commit any fixes from Step 4**

If you made fixes:
```bash
git add docs/trinitron.js docs/index.html
git commit -m "$(cat <<'EOF'
Cross-browser fixes for honest Trinitron

- [list specific fixes]

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

If no fixes needed, no commit — just declare the task done.

---

## Completion checklist

Before considering this plan complete, confirm:

- [ ] All 9 spec features (F1–F4, S2, S3, N1–N3) are implemented
- [ ] No-JS fallback works (SVG-only version visible when JS is off)
- [ ] Light mode is untouched (canvas hidden, original SVG visible)
- [ ] Reduced motion is honored (renderer stops on `reduce`)
- [ ] Theme toggle wiring works (canvas starts/stops with `data-theme` and OS preference)
- [ ] Cross-browser tested in Chrome, Firefox, and Safari
- [ ] No console errors on page load
- [ ] All changes committed; working tree clean

When all boxes are checked, the implementation is done. Consider pushing to GitHub Pages and verifying the live deploy at `https://www.interslice.systems/`.
