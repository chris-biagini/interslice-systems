# Hero Trinitron Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the IS-2200 sneak-preview card with a single Trinitron display that holds the logo + the "interslice·systems" wordmark together as one phosphor image in dark mode. Light mode is unchanged.

**Architecture:** No renderer changes. The existing `.trinitron` canvas in the hero stack is renamed `.hero-screen`, its display box widens to cover both the logo and the wordmark, and its signal callback is extended to draw a substrate fill + the rasterized rotating logo (existing path) + the wordmark text (via `fillText`, three calls for the weight split). The live wordmark `<h1>` goes `color: transparent` in dark mode so it stays in the accessibility tree without painting on top of the canvas. The IS-2200 section (HTML, CSS, signal callback, init function, MCRT_* constants) is deleted entirely.

**Tech Stack:** Plain HTML + inlined CSS + inline `<script>`, plus `docs/trinitron.js` (unchanged). No build step, no module system, no tests.

**Spec:** `specs/2026-05-22-hero-trinitron-design.md`

**Verification model:** This repo has no tests (CLAUDE.md: "No tests, no linters, no package manager"). Each task ends with a browser inspection step before committing. Use `python3 -m http.server -d docs 8000` and visit `http://localhost:8000`. Toggle modes via DevTools: set `<html data-theme="dark">` or `data-theme="light">` on the `<html>` element. Remove the attribute entirely to fall back to OS preference.

**DevTools handles to verify against:**
- `window.__trinitronLogo` — the hero screen's renderer instance after Task 3+ (was the logo-only canvas instance pre-existing).
- `window.__trinitron` — currently the IS-2200; will be undefined after Task 1.

---

## Background

The current state, for an engineer who hasn't seen this codebase:

- `docs/index.html` contains the entire homepage with all page-specific CSS inlined in one `<style>` block. Two `<script>` tags at the bottom: `<script src="trinitron.js">` then an inline IIFE that boots both Trinitron consumers (`init()` for the dark-mode logo, `initMcrt()` for the IS-2200 screen).
- `docs/trinitron.js` defines a single `Trinitron` class — a phosphor-display simulation with CPU and WebGL2 backends, selected via the `renderer: 'auto' | 'cpu' | 'gpu'` option. Both current consumers use `'auto'`. **This file is untouched by this plan.**
- The dark-mode logo Trinitron renders a 200×200-source signal that contains the rotating arms+hub SVG plus an "aqua gloss" overlay (rasterized via `rasterizeFragment` from inline SVG markup at script init). Canvas alpha tracks the silhouette (`opaqueBackground: false`) so the page bg shows through outside the logo.
- The IS-2200 Trinitron renders a 1280×960-source signal containing 80-col VT323 terminal text via `ctx.fillText`. It uses `opaqueBackground: true` (default) so the canvas is an opaque rectangular CRT face.
- The hero stack is `.hero > .stack` containing (in DOM order): the `.trinitron` canvas (z-index 0, absolute, `display: none` in light mode), the `.mark` SVG (z-index 1, 168px square), the `<h1 class="wordmark">` live text ("interslice·systems"), and the `.cta-wrap` (CTA link to mirepoix.recipes).
- The `<html>.trinitron-active` class is added by JS when dark-mode is active. CSS selectors keyed on it hide the SVG dark-mode layers (`.m-dark .phosphors`, `.bleed`, `.svg-scanlines`, etc.) so the canvas paint is what's visible.
- The triple-activation pattern: every dark-mode style appears once under `:root[data-theme="dark"]` and once inside `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ... } }`. **Both copies must change together.** See CLAUDE.md "Dark-mode triple activation."

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `docs/index.html` | MODIFY | Delete IS-2200 section + CSS + JS; rename `.trinitron` → `.hero-screen`; widen the hero canvas + extend its signal callback for logo + wordmark; make live wordmark `color: transparent` in dark mode. |
| `docs/trinitron.js` | UNTOUCHED | Renderer behavior unchanged. |
| `docs/tokens.css` | UNTOUCHED | The CRT-hardware sub-palette tokens (`--crt-green`, `--crt-amber`, etc.) become unused after Task 2, but keep them — cheap to retain, may be wanted again. |
| `CLAUDE.md` | MODIFY (Task 5) | "Two consumers" section in the Trinitron renderer block becomes "One consumer (the hero screen — logo + wordmark)". |

`docs/index.html` is the only substantial change. Most edits are deletions; Task 4 is the constructive work.

---

## Task 1: Delete the IS-2200 sneak preview from HTML + JS

**Files:**
- Modify: `docs/index.html`

This task removes the `<section class="is2200-hero">` block and the associated `initMcrt()` function, `mcrtSignal()`, and `MCRT_*` constants. No CSS removal yet — orphaned CSS in Task 2. After this commit, the page has no IS-2200 card visible; the hero (logo + wordmark + CTA) is unchanged, and the footer follows immediately after the hero.

### Steps

- [ ] **Step 1: Delete the IS-2200 section**

In `docs/index.html`, find and delete the entire section starting at the `<!-- ============ IS-2200 HERO (was sneak corner card) ============ -->` comment and ending at the closing `</section>` of the `.is2200-hero` block. The deletion spans roughly lines 1078–1096. Resulting HTML between the hero and the footer:

```html
      </div>
    </div>
  </section>

  <!-- ============ FOOTER ============ -->
  <footer class="foot">
```

(The hero section's closing tags flow directly into the footer's opening comment.)

- [ ] **Step 2: Delete the IS-2200 init and signal callback from the inline `<script>`**

Inside the inline `<script>` IIFE at the bottom of `docs/index.html`, delete:

1. The entire `// IS-2200 sneak-preview screen at native VGA resolution.` comment block plus the `MCRT_VIEW_W`, `MCRT_VIEW_H`, `MCRT_CELL_SIZE`, `MCRT_PHOSPHOR_W`, `MCRT_PHOSPHOR_H`, `MCRT_CANVAS_W`, `MCRT_CANVAS_H`, `MCRT_LINE_H`, `MCRT_PAD_X`, `MCRT_PAD_Y`, `MCRT_FONT`, `MCRT_LINES` constants. (Lines ~1359–1396.)
2. The `function mcrtSignal(ctx, timeMs) { … }` definition. (Lines ~1398–1433.)
3. The `function initMcrt() { … }` definition. (Lines ~1435–1502.)

- [ ] **Step 3: Update the bottom-of-file readystate registration**

Find the block at the very end of the IIFE:

```js
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
    document.addEventListener('DOMContentLoaded', initMcrt);
  } else {
    init();
    initMcrt();
  }
```

Replace with:

```js
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
```

- [ ] **Step 4: Verify in the browser**

Run `python3 -m http.server -d docs 8000` and open `http://localhost:8000`. Then verify, in both light and dark mode (toggle `<html data-theme="dark">` in DevTools):

- No IS-2200 card visible between the hero and the footer.
- DevTools console has no errors. `window.__trinitron` is `undefined` (was the IS-2200 handle).
- Dark-mode logo still renders correctly (`window.__trinitronLogo` is the renderer instance).
- Light-mode page looks identical to before, sans card.

- [ ] **Step 5: Commit**

```bash
git add docs/index.html
git commit -m "$(cat <<'EOF'
Remove IS-2200 sneak preview (HTML + JS)

Deletes the .is2200-hero section, mcrtSignal, initMcrt, and the
MCRT_* constants. CSS for .is2200-hero / .sneak / .mcrt is now
orphaned and will be cleaned up in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Delete the IS-2200 CSS

**Files:**
- Modify: `docs/index.html`

Removes the now-orphaned CSS for the IS-2200 card. Pure deletion; no visual change.

### Steps

- [ ] **Step 1: Delete the sneak/is2200 CSS block**

In the inline `<style>` block in `docs/index.html`, find the `===================== SNEAK PREVIEW CARD =====================` comment header and delete from there through the end of the `.sneak__foot { ... }` rule, including the `:root[data-theme="dark"] .sneak__card` and the matching `@media (prefers-color-scheme: dark)` block. This spans roughly lines 237–327. The deletion includes:

- `.is2200-hero { ... }`
- `.sneak { ... }`
- `.sneak__tape { ... }`
- `.sneak__card { ... }` plus its two dark-mode filter rules (one for `[data-theme="dark"]`, one inside the media query)
- `.sneak__head { ... }`
- `.sneak__sku { ... }`
- `.sneak__sku b { ... }`
- `.sneak__foot { ... }`

After deletion, the line right above the deleted block (the `}` closing some earlier rule) flows into the `/* ===================== FOOTER ===================== */` comment.

- [ ] **Step 2: Delete the mcrt CSS block**

Further down in the same `<style>` block, find:

```css
  /* CRT canvas: fixed 640×480 display maps cleanly to 1280×960
     device pixels at 2× DPR — exactly 2 device pixels per phosphor
     cell. max-width: 100% falls back to fluid sizing on narrow viewports. */
  .mcrt__crt { … }

  /* Easter-egg power sticker on the Memphis frame. … */
  .mcrt-power { … }
  .mcrt-power[aria-pressed="false"] { … }
  .mcrt-power:hover { … }
  .mcrt-power:active { … }
```

(Lines ~536–574.) Delete the whole block, comment headers included.

- [ ] **Step 3: Verify in the browser**

Reload `http://localhost:8000` in both light and dark mode. No visual change should be observable from Task 1's state. Specifically:

- Hero stack (logo + wordmark + CTA) unchanged.
- Sprinkles all in their positions, halos and flicker working in dark mode.
- Footer unchanged, CMYK/RGBW dots flip correctly between modes.
- DevTools "Computed" panel on `<canvas class="trinitron">` shows the same dimensions and position as before.

- [ ] **Step 4: Commit**

```bash
git add docs/index.html
git commit -m "$(cat <<'EOF'
Remove IS-2200 sneak preview (CSS)

Deletes .is2200-hero, .sneak*, .mcrt__crt, and .mcrt-power* rules.
Pure cleanup of the CSS orphaned by the previous commit. No visual
change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Rename `.trinitron` canvas class to `.hero-screen`

**Files:**
- Modify: `docs/index.html`

The canvas is no longer just the logo — it's about to become the hero screen holding both logo and wordmark. The `<html>.trinitron-active` state flag stays as-is (it's a state, not a per-element class). This commit is a pure rename: same canvas, same dimensions, same behavior; only the class name changes.

### Steps

- [ ] **Step 1: Rename the CSS rule and its dark-mode display selectors**

In the inline `<style>` block, find the CSS for `.trinitron` (around lines 100–112) and rename the selector. The block becomes:

```css
  /* Trinitron canvas overlay — dark mode only. Sits behind the .mark SVG
     and the live wordmark; in dark mode the canvas paints both, so the
     SVG dark-mode layers are display:none (see triple-activation rules
     below) and the wordmark goes color:transparent in dark mode (Task 4). */
  .hero-screen {
    position: absolute;
    --svg-size: 168px;
    --canvas-to-view: calc(280 / 200);
    width:  calc(var(--svg-size) * var(--canvas-to-view));
    height: calc(var(--svg-size) * var(--canvas-to-view));
    top:    calc(var(--svg-size) * (1 - var(--canvas-to-view)) / 2);
    left: 50%;
    transform: translateX(-50%);
    pointer-events: none;
    z-index: 0;
    display: none;
  }
  .stack .mark { position: relative; z-index: 1; }
```

(Sizing values stay the same in this task — Task 4 widens them.)

Then in the two display-toggle rules just below:

```css
  :root.trinitron-active[data-theme="dark"] .hero-screen { display: block; }
  @media (prefers-color-scheme: dark) {
    :root.trinitron-active:not([data-theme="light"]) .hero-screen { display: block; }
  }
```

Note: `.trinitron-active` on `<html>` is unchanged — it's a state flag, not a per-element class.

- [ ] **Step 2: Rename the HTML class**

Find the canvas in the hero section (around line 673):

```html
<canvas class="trinitron" aria-hidden="true"></canvas>
```

Rename to:

```html
<canvas class="hero-screen" aria-hidden="true"></canvas>
```

- [ ] **Step 3: Update the JS query selector**

In the inline `<script>` IIFE, find the `init()` function (around line 1210). Change:

```js
const canvas = document.querySelector('canvas.trinitron');
```

to:

```js
const canvas = document.querySelector('canvas.hero-screen');
```

- [ ] **Step 4: Verify in the browser**

Reload `http://localhost:8000` in dark mode (set `<html data-theme="dark">` in DevTools).

- Dark-mode logo still renders. `window.__trinitronLogo` is still the renderer instance.
- DevTools "Elements" panel: the canvas now has `class="hero-screen"`.
- DevTools console: `document.querySelector('canvas.hero-screen')` returns the canvas; `document.querySelector('canvas.trinitron')` returns `null`.
- Toggle to light mode: canvas hidden, SVG light-mode logo visible, no regressions.

- [ ] **Step 5: Commit**

```bash
git add docs/index.html
git commit -m "$(cat <<'EOF'
Rename .trinitron canvas class to .hero-screen

The canvas is about to grow to cover both logo and wordmark; the
old name no longer fits. The .trinitron-active state flag on <html>
stays as-is — it's a state, not a per-element class.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Expand the hero screen to hold logo + wordmark

**Files:**
- Modify: `docs/index.html`

The constructive task. After this commit, dark mode shows the logo + wordmark together inside a single Trinitron screen with an opaque substrate, halo bleed contained inside the canvas rectangle. Light mode is unchanged.

Four logical changes, all in `docs/index.html`:

1. CSS: widen the `.hero-screen` display box to cover logo + wordmark.
2. CSS: hide the live wordmark in dark mode via `color: transparent` (triple-activation pattern).
3. JS: Trinitron constructor opts use a wider `viewSize` / `canvasSize`, `opaqueBackground: true` (the default — remove the explicit `false` override), and tuned parameters for the mixed logo + text content.
4. JS: signal callback paints substrate fill + logo (existing aqua-gloss flow, positioned + sized for the bigger canvas) + wordmark text (three `fillText` calls for the weight split, with letter-spacing).

The diff is ~80–100 lines but it's a single coherent change. Splitting earlier would produce a broken intermediate state (wordmark invisible without canvas paint, or canvas paint duplicated over visible live wordmark).

### Steps

- [ ] **Step 1: Replace the `.hero-screen` CSS sizing rules**

Find the `.hero-screen` block from Task 3 (around lines 100–112) and replace with:

```css
  /* Trinitron canvas overlay — dark mode only. Sits behind .mark and
     the live wordmark and paints both as phosphor. Display box is
     sized to cover the visible region of logo + wordmark; the canvas's
     internal source coordinates (viewSize = 800×320 source px) map to
     this box. Halo bleed is contained inside the canvas rectangle —
     no visible halo outside the screen edge. */
  .hero-screen {
    position: absolute;
    /* Display width clamps with the wordmark's clamp(56px, 9vw, 124px)
       font-size: at floor the screen is 560px wide, at cap 880px wide.
       aspect-ratio keeps height tied to width for a fixed 2.5:1 face. */
    width: clamp(560px, 78vw, 880px);
    aspect-ratio: 800 / 320;
    /* Center horizontally and overlay the stack starting at the top of
       the logo. The logo at 168px + wordmark with -0.18em pull-up + a
       few px breathing fits inside ~310 display px at the wide end,
       comfortably inside our 880×352 canvas display box. */
    top: 0;
    left: 50%;
    transform: translateX(-50%);
    pointer-events: none;
    z-index: 0;
    display: none;
  }
  .stack .mark { position: relative; z-index: 1; }
```

The two `:root.trinitron-active...` display rules below are unchanged (they still target `.hero-screen`).

- [ ] **Step 2: Add the wordmark transparency rules for dark mode**

Find the `.wordmark` CSS block (around lines 205–231). Below the existing `.wordmark b { ... }` rule, add the dark-mode transparency rules. The `.wordmark`, `.wordmark i`, and `.wordmark b` selectors all explicitly set `color`, so each needs an override:

```css
  /* Dark mode: live wordmark text stays in the DOM (accessibility tree
     reads it as "interslice systems"), but its visual paint is
     suppressed — the canvas paints its own phosphor copy at the same
     layout position. Triple-activation pattern (see CLAUDE.md):
     explicit dark OR (OS-dark AND not pinned-to-light). */
  :root[data-theme="dark"] .wordmark,
  :root[data-theme="dark"] .wordmark i,
  :root[data-theme="dark"] .wordmark b {
    color: transparent;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) .wordmark,
    :root:not([data-theme="light"]) .wordmark i,
    :root:not([data-theme="light"]) .wordmark b {
      color: transparent;
    }
  }
```

- [ ] **Step 3: Add the wordmark constants to the inline script**

In the inline `<script>` IIFE, near the top of the closure (after `'use strict'`; alongside `ROT_PERIOD_MS` and `hubAngleDeg`), add wordmark-rendering constants. These are the canonical source-canvas geometry. The numbers are tuned for `viewSize: [800, 320]` and match the live wordmark's identity (Space Grotesk display font, the -0.06em tracking, the weight split):

```js
  // Hero screen source-canvas geometry (matches viewSize below).
  // Treat this as the canonical layout — all draws inside `signal()`
  // place content in these coordinates. The renderer takes care of
  // mapping the source canvas to the device pixel canvas.
  const HERO_VIEW_W = 800;
  const HERO_VIEW_H = 320;

  // Logo position inside the screen — centered horizontally,
  // 140 source px square, top-aligned with ~20 px breathing room.
  const HERO_LOGO_X = (HERO_VIEW_W - 140) / 2;  // 330
  const HERO_LOGO_Y = 20;
  const HERO_LOGO_SIZE = 140;

  // Wordmark — drawn below the logo. font-size is in source-canvas
  // pixels, sized so cap-height ≈ 80 px (about 20 phosphor cells with
  // cs=4, plenty for readability). Color is a near-white phosphor —
  // not pure #FFFFFF; a touch warm so it reads as lit phosphor rather
  // than backlight.
  const HERO_WORDMARK_BASELINE_Y = 270;
  const HERO_WORDMARK_FONT_PX = 110;
  const HERO_WORDMARK_FONT = '"Space Grotesk", "Hanken Grotesk", system-ui, sans-serif';
  const HERO_WORDMARK_COLOR = '#FFF6E6';
  const HERO_WORDMARK_LETTER_SPACING_PX = -6;  // ~-0.06em at 110 px

  // CRT substrate — deeper black than --bg (--navy-0 = #000926) so the
  // screen face reads as the darkest plane on the page.
  const HERO_SUBSTRATE = '#04081A';

  // Wordmark glyph parts, in document order. The middle "·" is drawn
  // separately so its margins can be tuned to match the live wordmark's
  // 0.22em-left / 0.10em-right asymmetric kerning.
  const HERO_WORDMARK_PARTS = [
    { text: 'interslice', weight: 700 },
    { text: '·',          weight: 700, marginLeftEm: 0.22, marginRightEm: 0.10 },
    { text: 'systems',    weight: 500 },
  ];
```

- [ ] **Step 4: Add a reusable logo offscreen canvas + replace the `signal()` function inside `init()`**

The logo needs `source-atop` for the aqua gloss to limit it to the lit phosphor. The old logo-only signal callback got this for free because the source canvas was transparent outside the silhouette. With an opaque substrate underneath, `source-atop` would no longer confine the gloss — the substrate is opaque, so the gloss would paint everywhere it has alpha.

The fix: compose the logo (arms + hub + source-atop'd aqua) into a separate transparent offscreen canvas, then blit that onto the main source canvas at the logo's position.

Inside `init()`, just before the existing `function signal(ctx, timeMs) { … }` definition (around line 1230), allocate a reusable offscreen canvas. This matches the `document.createElement('canvas')` pattern used throughout `trinitron.js`:

```js
// Reusable offscreen canvas for the logo composite. The logo's aqua
// gloss is composited onto the lit phosphor via source-atop, which
// only works when the surrounding canvas is transparent — so the
// logo is rendered into this transparent temp first, then drawn
// onto the main source canvas (which has an opaque substrate).
const logoCanvas = document.createElement('canvas');
logoCanvas.width = HERO_LOGO_SIZE;
logoCanvas.height = HERO_LOGO_SIZE;
const logoCtx = logoCanvas.getContext('2d');
```

Then find the existing `signal()` function:

```js
function signal(ctx, timeMs) {
  ctx.drawImage(armsImg, 0, 0, 200, 200);
  ctx.save();
  ctx.translate(100, 100);
  ctx.rotate(hubAngleDeg(timeMs) * Math.PI / 180);
  ctx.translate(-100, -100);
  ctx.drawImage(hubImg, 0, 0, 200, 200);
  ctx.restore();
  ctx.save();
  ctx.globalCompositeOperation = 'source-atop';
  ctx.drawImage(aquaImg, 0, 0, 200, 200);
  ctx.restore();
}
```

Replace with the version that paints the substrate, composites the logo offscreen, blits it, then paints the wordmark text:

```js
function signal(ctx, timeMs) {
  // 1. Substrate — opaque CRT face under everything.
  ctx.fillStyle = HERO_SUBSTRATE;
  ctx.fillRect(0, 0, HERO_VIEW_W, HERO_VIEW_H);

  // 2. Logo — composited in the transparent offscreen canvas
  //    (arms + rotating hub + aqua gloss via source-atop), then
  //    blitted onto the main source canvas at the logo position.
  logoCtx.clearRect(0, 0, HERO_LOGO_SIZE, HERO_LOGO_SIZE);

  // arms (static)
  logoCtx.drawImage(armsImg, 0, 0, HERO_LOGO_SIZE, HERO_LOGO_SIZE);

  // hub (rotating around its center)
  logoCtx.save();
  const hubCx = HERO_LOGO_SIZE / 2;
  const hubCy = HERO_LOGO_SIZE / 2;
  logoCtx.translate(hubCx, hubCy);
  logoCtx.rotate(hubAngleDeg(timeMs) * Math.PI / 180);
  logoCtx.translate(-hubCx, -hubCy);
  logoCtx.drawImage(hubImg, 0, 0, HERO_LOGO_SIZE, HERO_LOGO_SIZE);
  logoCtx.restore();

  // aqua gloss — source-atop confines it to wherever the lit
  // phosphor has alpha (the logoCanvas surroundings are transparent).
  logoCtx.save();
  logoCtx.globalCompositeOperation = 'source-atop';
  logoCtx.drawImage(aquaImg, 0, 0, HERO_LOGO_SIZE, HERO_LOGO_SIZE);
  logoCtx.restore();

  // blit the composed logo onto the main source canvas
  ctx.drawImage(logoCanvas, HERO_LOGO_X, HERO_LOGO_Y);

  // 3. Wordmark — three fillText calls for the weight split, with
  //    letter-spacing applied via ctx.letterSpacing (widely supported
  //    as of 2024+; on older browsers this property is silently
  //    ignored, which is a tolerable degradation — the wordmark just
  //    renders at default tracking).
  ctx.fillStyle = HERO_WORDMARK_COLOR;
  ctx.textBaseline = 'alphabetic';
  if ('letterSpacing' in ctx) {
    ctx.letterSpacing = HERO_WORDMARK_LETTER_SPACING_PX + 'px';
  }

  // Measure each part with its own weight, accumulate x as we go.
  // Start by computing the full width so we can center the wordmark
  // horizontally inside the screen.
  function partFont(part) {
    return `${part.weight} ${HERO_WORDMARK_FONT_PX}px ${HERO_WORDMARK_FONT}`;
  }
  function partWidth(part) {
    ctx.font = partFont(part);
    return ctx.measureText(part.text).width;
  }
  const emPx = HERO_WORDMARK_FONT_PX;
  let totalW = 0;
  for (const part of HERO_WORDMARK_PARTS) {
    totalW += partWidth(part);
    if (part.marginLeftEm)  totalW += part.marginLeftEm  * emPx;
    if (part.marginRightEm) totalW += part.marginRightEm * emPx;
  }

  let x = (HERO_VIEW_W - totalW) / 2;
  for (const part of HERO_WORDMARK_PARTS) {
    if (part.marginLeftEm) x += part.marginLeftEm * emPx;
    ctx.font = partFont(part);
    ctx.fillText(part.text, x, HERO_WORDMARK_BASELINE_Y);
    x += partWidth(part);
    if (part.marginRightEm) x += part.marginRightEm * emPx;
  }
}
```

- [ ] **Step 5: Update the Trinitron constructor opts in `init()`**

In `init()`, find the `new window.Trinitron(canvas, { … })` call (around lines 1246–1327). Replace the options object with the new geometry + tuned parameters:

```js
trinitron = new window.Trinitron(canvas, {
  renderer: 'auto',
  signal,
  // Source canvas covers the full hero screen — substrate + logo + wordmark.
  viewSize: [HERO_VIEW_W, HERO_VIEW_H],
  // 2× source → canvas backing, the same stripeUpscale pattern used by
  // both prior consumers. Canvas backing is 1600×640 at 1× DPR; the
  // renderer multiplies by DPR internally.
  canvasSize: [HERO_VIEW_W * 2, HERO_VIEW_H * 2],
  // cs=4 gives proper [R, G, B, gap] aperture triads at this scale.
  cellSize: 4,
  stripeUpscale: 2,
  // Opaque substrate — the canvas rectangle IS the screen face.
  // (This is the renderer's default; we list it explicitly because
  // the previous logo-only setup overrode it to false.)
  opaqueBackground: true,
  // Phosphor coupling tuned for mixed content — text wants every
  // column lit at moderate coupling so glyph edges read as phosphor
  // dots rather than razor-thin column slivers.
  phosphorCoupling: 0.35,
  // Persistence — high enough to smear the rotating hub into a soft
  // trail, low enough that the wordmark stays crisp on a stationary
  // signal (the wordmark doesn't move; persistence has nothing to
  // smear there).
  persistence: 0.82,
  // Convergence — matches both prior consumers.
  convergence: { r: [-0.25, -0.25], g: [0, 0], b: [0.25, 0.25] },
  // Beam spread in source pixels — slight softening of glyph edges
  // and arm caps. Below 0.7 px Chromium's filter blur no-ops.
  beamSpreadPx: 0.7,
  // Per-cell hotspot and shimmer — produce the dot-grid texture that
  // reads as phosphor through glass. Slightly higher hotspot than the
  // IS-2200 used because the wordmark text needs the per-cell bright
  // center to read as crisp lit glyphs.
  hotspot: 0.24,
  cellShimmer: 0.04,
  rowShimmer: 0.012,
  // Halo — contained inside the canvas rectangle (the rectangle IS
  // the screen edge). Lower intensity than the logo-only setup
  // (which used 1.625) so the substrate stays visible.
  bleedRadius: 18,
  bleedIntensity: 1.2,
  // Post-stripe blur in canvas-pixel units. Light touch.
  phosphorBlurPx: 0.6,
  // Aperture-grille gap mask — same fraction the logo used.
  gapMaskAlpha: 0.3,
  gapMaskPeriod: 2,
  // The hero screen is the only consumer left, so it claims the
  // ?debug=1 effect overlay. No bypass canvas (no power-button
  // toggle UI anymore — easter egg dropped per the spec).
  bypassCanvas: false,
  debugOverlay: true,
  // Damper wires off for now (the IS-2200 had them off too). Could
  // be a future tuning option.
  damperWires: [],
});
window.__trinitronLogo = trinitron;
```

- [ ] **Step 6: Verify in the browser**

Reload `http://localhost:8000`. Wait for the page to fully load (Space Grotesk and the rasterized SVG fragments must be ready).

**Light mode** (`<html data-theme="light">` or remove `data-theme` if OS is light):
- Logo SVG renders as the CMYK-on-paper mark, same as before.
- Wordmark "interslice·systems" renders as live cream text in Space Grotesk, same color and position as before.
- CTA below works.
- Canvas is `display: none`.

**Dark mode** (`<html data-theme="dark">`):
- A rectangular Trinitron screen sits centered in the hero, holding:
  - The rotating arms+hub logo at the top.
  - "interslice·systems" rendered as phosphor below.
- The live wordmark text is invisible (transparent), but DevTools' Accessibility tree shows the `<h1>` with text "interslice·systems".
- The CTA below the screen is unchanged, clickable.
- Sprinkles, motto, footer are all unchanged.
- In the DevTools console: `window.__trinitronLogo` is the renderer instance. `window.__trinitron` is undefined.
- Append `?debug=1` to the URL — the top-right effect-toggle overlay appears, listing all 18 effects.

**Visual judgment:** Step back from the screen — does the brand read as a single CRT-displayed image? The logo arms should still have the chromatic phosphor structure; the wordmark should read as clean white phosphor glyphs. If anything looks off (mush, illegible, wrong proportions), use the `?debug=1` overlay to isolate which effect is misbehaving and adjust the corresponding option value in Step 5. Common tweaks:

- Wordmark hard to read → `phosphorCoupling` up (more channels lit per column), or `phosphorBlurPx` down.
- Halo too aggressive, washes out the screen face → `bleedIntensity` down or `bleedRadius` down.
- Phosphor structure invisible → `cellSize` up to 5, or `gapMaskAlpha` up.
- Glyphs feel painted-on rather than lit → `hotspot` up, `cellShimmer` up slightly.

- [ ] **Step 7: Commit**

```bash
git add docs/index.html
git commit -m "$(cat <<'EOF'
Render logo + wordmark together on a single Trinitron screen

Widens the dark-mode hero canvas (now .hero-screen) to cover both the
logo and the live wordmark, and extends the signal callback to paint
a CRT substrate, the rotating logo at its position, and the
"interslice·systems" wordmark via three fillText calls (weight split,
asymmetric · margins, -6px letter-spacing). Live wordmark becomes
color: transparent in dark mode so it stays in the accessibility tree
but doesn't double-paint over the canvas.

Sets up the screen edge that the future laser-grid effect will
anchor to.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Update CLAUDE.md to reflect the single-consumer state

**Files:**
- Modify: `CLAUDE.md`

The "Trinitron renderer" section in CLAUDE.md describes the renderer as having two consumers (the dark-mode logo and the IS-2200 hero screen). After Tasks 1–4, it has one: the hero screen, which holds both logo and wordmark.

### Steps

- [ ] **Step 1: Update the "Two consumers" passage**

Open `CLAUDE.md` and find the paragraph that starts with "Two consumers in `docs/index.html`:" (in the "Trinitron renderer" section). Replace that paragraph and its bullet list with:

```markdown
One consumer in `docs/index.html`:

- **The hero screen** (`canvas.hero-screen`): a single bounded Trinitron display that holds both the rotating arms+hub logo and the "interslice·systems" wordmark. Signal callback paints a near-black CRT substrate, then rasterized SVG of the rotating logo, then `fillText` of the wordmark in three weight-split parts. The live `<h1>` wordmark stays in the DOM and accessibility tree but goes `color: transparent` in dark mode so it doesn't double-paint. A `MutationObserver` on `data-theme` plus a `prefers-color-scheme` listener toggles `start()` / `stop()` to drop animation cost in light mode.

The renderer is *option-driven*: same code, different look. The hero screen runs on the **GPU path** (`renderer: 'auto'` with automatic CPU fallback on WebGL2 context failure), `cellSize: 4`, opaque substrate, contained halo, big aperture-grille mask, `viewSize: [800, 320]`.

The GPU pipeline is a three-pass setup (signal upload → phosphor/persistence → composite) plus three auxiliary bloom passes. All 18 effects are togglable at runtime via `window.__trinitronLogo.effects`. Add `?debug=1` to the URL to expose a per-effect override panel in the top-right corner.
```

- [ ] **Step 2: Remove the master A/B toggle paragraph**

Just below the passage you replaced in Step 1, there's a paragraph beginning "The master A/B toggle (GPU on vs. raw signal bypass) is wired to a lower-left easter-egg power-button sticker on the Memphis frame; clicking it calls `setMasterMode()`." Delete this paragraph — the power button no longer exists in the DOM after Task 1.

The spec and implementation plan references in the next paragraph stay (they're historical pointers and worth keeping).

- [ ] **Step 3: Update the verification handles paragraph**

Further down in the section ("For Trinitron-renderer edits the same rule applies, plus: …"), there's a sentence listing the two DevTools handles. Update it from:

```
DevTools handles: `window.__trinitronLogo` (dark-mode logo, CPU renderer) and `window.__trinitron` (IS-2200, GPU renderer — also exposes `.effects` and `.setMasterMode()`).
```

to:

```
DevTools handles: `window.__trinitronLogo` (the hero screen, GPU renderer — also exposes `.effects`).
```

- [ ] **Step 4: Verify**

Re-read the updated section of CLAUDE.md top to bottom — does it accurately describe the post-implementation state? In particular:

- No references to two consumers, the IS-2200, the sneak preview, the power button, or the CPU path being the active renderer.
- The `?debug=1` debug overlay is still mentioned (it works on the hero screen now).
- The "memory entries about deliberate aesthetic choices" paragraph at the end of the section is unchanged (gap-mask striations + per-cell hotspot — those design choices still apply to the hero screen).

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
Update CLAUDE.md for the single hero-screen consumer

The Trinitron renderer no longer powers two consumers (logo + IS-2200);
it powers one (the hero screen, which holds logo + wordmark). Drop
the master A/B toggle paragraph — the power-button easter egg is gone.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Post-implementation: Open knobs from the spec

The spec listed several knobs explicitly deferred to implementation. Most of them are handled inline in Task 4 Step 6's "visual judgment" verification. The remaining ones are worth a brief note for the implementer:

- **Wordmark font A/B (Space Grotesk vs VT323):** Task 4 commits to Space Grotesk (matching the live wordmark for identity continuity). If after seeing the result you want to try VT323 — the chunkier 8-bit terminal feel — change `HERO_WORDMARK_FONT` to `'"VT323", "JetBrains Mono", monospace'` and bump `HERO_WORDMARK_FONT_PX` (VT323 reads small at the same point size). Worth A/B'ing in a separate commit.
- **Substrate color match:** committed to `#04081A` (slightly darker than `--bg`'s `#000926`). If the screen edge reads too hard against the page bg, try `#000926` (identical to bg — invisible edge) or warmer values like `#0A0612` (warm-tube tint). Easy one-line swap.
- **Screen positioning relative to CTA:** the spec flagged `.hero .cta-wrap { margin-top: 64px; }` as possibly needing adjustment. After Task 4, eyeball the gap between the screen bottom and the CTA. If the CTA feels too close (the screen's halo bleed may visually extend toward it), bump that margin to 80–96px.

These are all single-value tweaks in `docs/index.html`. Make each one its own commit if you do them.

---

## Out of scope (from the spec)

- **Laser grid effect.** Deferred to a follow-up brainstorm + spec + plan. The hero screen built here gives that follow-up a real screen edge to anchor to — that's all this plan needs to deliver.
- **Removing the SVG `.m-dark` fallback layer.** The spec explicitly leaves the SVG-only dark-mode fallback in place (used if the renderer fails to init). Wordmark gets no equivalent fallback — it just stays as live cream text on dark bg, which is a fine degradation.
- **Cleaning up unused `--crt-*` tokens.** Spec recommends leaving them in place.
