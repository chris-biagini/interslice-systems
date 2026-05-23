# Algorithmic Sprinkle Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace 16 hand-authored sprinkle positions in `docs/index.html` with a small runtime layout pass that distributes them deterministically into the page's empty space, avoiding the legible content (motto, logo + wordmark, CTA, footer).

**Architecture:** New `docs/sprinkles.js` runs on `DOMContentLoaded` and debounced resize. It measures DOM keepouts (`.top`, `.brand`, `.cta-wrap`, `.foot`) and `.sprinkle` bounding-circle radii, runs Mitchell's best-candidate (K=30, largest-first) seeded by `mulberry32(0x53707269)`, and writes inline `style.top` / `style.left` on each sprinkle. CSS keeps owning size, rotation, color, and flicker timing.

**Tech Stack:** Plain JS in an IIFE. No build step, no module system, no tests (per CLAUDE.md "no toolchain" property).

**Spec:** `specs/2026-05-22-sprinkle-distribution-design.md`

**Verification model:** This repo has no tests. Each task ends with a browser inspection step. Serve locally with `python3 -m http.server -d docs 8000` and visit `http://localhost:8000`. Toggle themes via DevTools: set `<html data-theme="dark">` or `data-theme="light">` on the `<html>` element; remove the attribute to fall back to OS preference. Console-driven verification uses `console.log` statements that are removed in the final task.

---

## Background

The current state, for an engineer who hasn't seen this codebase:

- `docs/index.html` contains the entire homepage with all page-specific CSS inlined in one `<style>` block. One `<script src="trinitron.js">` tag plus one inline IIFE script live at the bottom.
- 16 sprinkles are declared as inline `<svg class="sprinkle sp-XXX">` elements in the body (`docs/index.html:501-637`). Each has a per-shape selector in the `<style>` block (`docs/index.html:394-494`) that sets `top`/`left` (or `bottom`/`right`), `width`, `transform: rotate(...)`, `--glow` (rgb channels), `--flick-p` (period), and `--flick-d` (delay).
- The base `.sprinkle { position: absolute; ... }` rule lives in `docs/tokens.css:312-323` and is shared across the site. **Don't touch tokens.css** — only the per-sprinkle position properties in `docs/index.html` go away.
- `.page` in `docs/index.html:13` is `position: relative; overflow: hidden; padding: 36px 56px 28px`. Sprinkles are positioned relative to `.page`'s padding edge (CSS `position: absolute` ignores parent padding for placement, but `getBoundingClientRect()` math still works in viewport coords — we convert to `.page`-relative when computing keepouts).
- The hero canvas in dark mode (`docs/index.html:647`) is a `Trinitron` instance that *wants* sprinkles to graze its edges — it detects intersections and rasterizes them onto its phosphor signal (`docs/index.html:1369-1398`). So the keepout target is *legible content*, not the whole canvas region. Using `.brand` (logo + wordmark together) as the keepout still allows the desired phosphor-wrap effect at the canvas perimeter.
- CLAUDE.md flags JS additions as needing a high-bar justification ("CSS can't do this either, and here's why"). This case clears the bar: CSS can't read sibling elements' bounding rects, and Mitchell's needs iterative state. After this plan, `docs/sprinkles.js` becomes the second documented JS exception alongside `docs/trinitron.js`.

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `docs/sprinkles.js` | CREATE | IIFE: PRNG, geometry helpers, keepout/sprinkle measurement, Mitchell's algorithm, apply, debounced resize. |
| `docs/index.html` | MODIFY | Add `<script src="sprinkles.js">` after `<script src="trinitron.js">`. Remove `top`/`left`/`right`/`bottom` from each of the 16 `.sp-*` CSS blocks. Remove the eight zone comments (`/* ─── TOP-LEFT ─── */` etc.). |
| `CLAUDE.md` | MODIFY | "CSS-first, with one documented JS exception" section becomes "two exceptions" — add the sprinkle distribution alongside Trinitron. |
| `docs/tokens.css` | UNTOUCHED | `.sprinkle` base rule unchanged. |
| `docs/trinitron.js` | UNTOUCHED | Renderer unchanged. |

---

## Task 1: Scaffold sprinkles.js and wire script tag

**Files:**
- Create: `docs/sprinkles.js`
- Modify: `docs/index.html` (add script tag)

This task creates the file with the IIFE shell, constants, and a `mulberry32` PRNG. It wires the script into the page but does nothing visible. End-of-task state: page renders identically to before; console shows "[sprinkles] loaded" on load.

### Steps

- [ ] **Step 1: Create `docs/sprinkles.js` with the IIFE shell**

Create the file with this content:

```js
// docs/sprinkles.js
//
// Deterministically distributes Memphis sprinkles into the page's empty
// area. Reads DOM keepouts (.top, .brand, .cta-wrap, .foot) and each
// sprinkle's bounding-circle radius, then runs Mitchell's best-candidate
// algorithm with a seeded PRNG so the layout is identical for every
// visitor at the same viewport size.
//
// See specs/2026-05-22-sprinkle-distribution-design.md.

(function () {
  'use strict';

  const SEED = 0x53707269; // "Spri"
  const KEEPOUT_PAD = 16;
  const CANDIDATE_COUNT = 30;
  const KEEPOUT_SELECTORS = ['.top', '.brand', '.cta-wrap', '.foot'];
  const RESIZE_DEBOUNCE_MS = 150;

  // mulberry32: small, well-known, statistically fine for this use.
  // Returns a function that emits floats in [0, 1).
  function mulberry32(a) {
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  console.log('[sprinkles] loaded');
})();
```

- [ ] **Step 2: Add the script tag to `docs/index.html`**

Find the existing `<script src="trinitron.js"></script>` line (around `docs/index.html:1064`) and add the sprinkles script immediately after it:

```html
<script src="trinitron.js"></script>
<script src="sprinkles.js"></script>
<script>
(function () {
  'use strict';
  // ... existing inline IIFE
```

- [ ] **Step 3: Verify in browser**

Serve and open:

```
python3 -m http.server -d docs 8000
```

Visit `http://localhost:8000`. Open DevTools console. Expected:
- `[sprinkles] loaded` appears once on page load.
- No errors.
- Sprinkles render in their existing hand-authored positions (unchanged).

- [ ] **Step 4: Commit**

```bash
git add docs/sprinkles.js docs/index.html
git commit -m "$(cat <<'EOF'
Scaffold sprinkles.js with PRNG and constants

IIFE shell, mulberry32 PRNG, design constants. Wired into index.html
after trinitron.js. No layout behavior yet — sprinkles still painted
at their hand-authored CSS positions.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add geometry helpers and keepout measurement

**Files:**
- Modify: `docs/sprinkles.js`

This task adds `pointInRect`, `distToRect` (signed distance from a point to a rect — negative inside), and `rectsFromSelectors` (reads the four keepout selectors and pads them). A temporary `layout()` function logs measurements to the console for visual inspection.

### Steps

- [ ] **Step 1: Add geometry helper**

Insert after the `mulberry32` definition, before the `console.log` line:

```js
  // Signed distance from point p to axis-aligned rect r.
  // Negative if p is inside r; the magnitude is the smallest
  // distance to any edge (useful for "how far inside").
  function distToRect(p, r) {
    const dx = Math.max(r.left - p.x, 0, p.x - r.right);
    const dy = Math.max(r.top - p.y, 0, p.y - r.bottom);
    if (dx === 0 && dy === 0) {
      // Inside: return negative distance to nearest edge.
      return -Math.min(p.x - r.left, r.right - p.x, p.y - r.top, r.bottom - p.y);
    }
    return Math.hypot(dx, dy);
  }
```

- [ ] **Step 2: Add keepout measurement**

Insert after the geometry helpers:

```js
  // Read keepout selectors and return their rects in .page-relative
  // coordinates, expanded outward by KEEPOUT_PAD.
  function rectsFromSelectors(pageRect) {
    const out = [];
    for (const sel of KEEPOUT_SELECTORS) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      out.push({
        left:   r.left   - pageRect.left - KEEPOUT_PAD,
        top:    r.top    - pageRect.top  - KEEPOUT_PAD,
        right:  r.right  - pageRect.left + KEEPOUT_PAD,
        bottom: r.bottom - pageRect.top  + KEEPOUT_PAD,
      });
    }
    return out;
  }
```

- [ ] **Step 3: Add a temporary layout() that logs measurements**

Replace the `console.log('[sprinkles] loaded');` line with:

```js
  function layout() {
    const page = document.querySelector('.page');
    if (!page) return;
    const pageRect = page.getBoundingClientRect();
    const keepouts = rectsFromSelectors(pageRect);
    console.log('[sprinkles] page', { w: pageRect.width, h: pageRect.height });
    console.log('[sprinkles] keepouts', keepouts);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', layout);
  } else {
    layout();
  }
```

- [ ] **Step 4: Verify in browser**

Reload `http://localhost:8000`. Console expected output (numbers approximate, will vary by viewport):

```
[sprinkles] page { w: 1280, h: 800 }
[sprinkles] keepouts [
  { left: ..., top: ..., right: ..., bottom: ... }, // .top
  { ... }, // .brand
  { ... }, // .cta-wrap
  { ... }  // .foot
]
```

Sanity-check by eye: four rects, each plausibly placed (top one near y=0, footer near y=pageHeight, etc.). Numbers should be within the page bounds give-or-take the 16px padding.

- [ ] **Step 5: Commit**

```bash
git add docs/sprinkles.js
git commit -m "$(cat <<'EOF'
Add geometry helpers and keepout measurement to sprinkles.js

distToRect (signed distance, negative inside), pointInRect, and
rectsFromSelectors. Temporary layout() logs page + keepout rects to
the console for inspection.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Add sprinkle measurement

**Files:**
- Modify: `docs/sprinkles.js`

Add `measureSprinkles()` which returns one record per `.sprinkle` element with its DOM node and bounding-circle radius. Wire into `layout()` and log the count and a few sample radii.

### Steps

- [ ] **Step 1: Add `measureSprinkles`**

Insert after `rectsFromSelectors`:

```js
  // Read every .sprinkle element and compute its unrotated width,
  // height, and bounding-circle radius. We use getComputedStyle
  // (not getBoundingClientRect) because the rect reflects the
  // *rotated* AABB, while CSS `top`/`left` and the rotation pivot
  // both reference the *unrotated* box. The bounding circle of the
  // unrotated box is also rotation-invariant — which is what
  // Mitchell's wants for a single exclusion radius.
  function measureSprinkles() {
    const nodes = Array.from(document.querySelectorAll('.sprinkle'));
    return nodes.map((el) => {
      const cs = getComputedStyle(el);
      const w = parseFloat(cs.width)  || 0;
      const h = parseFloat(cs.height) || 0;
      const radius = Math.hypot(w, h) / 2;
      return { el, w, h, radius };
    });
  }
```

- [ ] **Step 2: Wire into `layout()` and log**

Update the `layout()` function to:

```js
  function layout() {
    const page = document.querySelector('.page');
    if (!page) return;
    const pageRect = page.getBoundingClientRect();
    const keepouts = rectsFromSelectors(pageRect);
    const sprinkles = measureSprinkles();
    console.log('[sprinkles] page', { w: pageRect.width, h: pageRect.height });
    console.log('[sprinkles] keepouts', keepouts);
    console.log('[sprinkles] count', sprinkles.length, 'radii',
      sprinkles.map(s => Math.round(s.radius)));
  }
```

- [ ] **Step 3: Verify in browser**

Reload. Console expected:

```
[sprinkles] count 16 radii [ ... 16 integers ... ]
```

Sanity checks:
- The count is exactly 16 (matches the hand-authored sprinkle inventory).
- The largest radius is ~90 (the 168×~67 `.sp-squig-1` squiggle).
- The smallest is ~10 (the 14×14 `.sp-dot-3` dot).
- A value of 0 anywhere indicates `getComputedStyle` returned no usable `width` or `height` for that sprinkle — investigate before continuing.

- [ ] **Step 4: Commit**

```bash
git add docs/sprinkles.js
git commit -m "$(cat <<'EOF'
Measure .sprinkle bounding-circle radii in sprinkles.js

measureSprinkles() returns one record per .sprinkle with the DOM node
and a bounding-circle radius (half-diagonal of the AABB). Logged from
layout() for inspection.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Implement Mitchell's best-candidate algorithm

**Files:**
- Modify: `docs/sprinkles.js`

Add `placeAll(sprinkles, keepouts, pageRect)` which returns an array of placements `[{ el, x, y, radius }]`. No `apply` yet — log placements for inspection. Sprinkles still render at their authored CSS positions.

### Steps

- [ ] **Step 1: Add `placeAll`**

Insert after `measureSprinkles`:

```js
  // Mitchell's best-candidate, seeded mulberry32.
  // Sort sprinkles largest-first so the hardest-to-place ones get the
  // best spots. For each, sample CANDIDATE_COUNT random points in the
  // .page interior (clamped so the sprinkle's circle stays on-page),
  // reject any that intersect a keepout, and score the rest by the
  // worst-case (minimum) distance to placed sprinkles and keepout
  // edges. The candidate with the highest score wins.
  //
  // If every candidate intersects a keepout, the best-scoring one
  // (least bad) is kept — graceful degradation rather than dropping
  // the sprinkle to (0, 0).
  function placeAll(sprinkles, keepouts, pageRect) {
    const rng = mulberry32(SEED);
    const sorted = sprinkles.slice().sort((a, b) => b.radius - a.radius);
    const placed = [];
    const pageW = pageRect.width;
    const pageH = pageRect.height;

    for (const s of sorted) {
      let best = null;
      let bestScore = -Infinity;
      const minX = s.radius;
      const maxX = pageW - s.radius;
      const minY = s.radius;
      const maxY = pageH - s.radius;

      for (let i = 0; i < CANDIDATE_COUNT; i++) {
        const p = {
          x: minX + rng() * (maxX - minX),
          y: minY + rng() * (maxY - minY),
        };

        // Score: minimum signed distance to (a) any placed sprinkle's
        // edge, (b) any keepout edge. Sprinkle-vs-sprinkle uses
        // center-distance minus both radii. Keepout uses distToRect
        // minus this sprinkle's radius.
        let score = Infinity;

        for (const o of placed) {
          const d = Math.hypot(p.x - o.x, p.y - o.y) - o.radius - s.radius;
          if (d < score) score = d;
        }
        for (const k of keepouts) {
          const d = distToRect(p, k) - s.radius;
          if (d < score) score = d;
        }

        if (score > bestScore) {
          bestScore = score;
          best = p;
        }
      }

      placed.push({ el: s.el, x: best.x, y: best.y, radius: s.radius, w: s.w, h: s.h });
    }

    return placed;
  }
```

- [ ] **Step 2: Wire into `layout()` and log placements**

Update `layout()`:

```js
  function layout() {
    const page = document.querySelector('.page');
    if (!page) return;
    const pageRect = page.getBoundingClientRect();
    const keepouts = rectsFromSelectors(pageRect);
    const sprinkles = measureSprinkles();
    if (!sprinkles.length) return;
    const placements = placeAll(sprinkles, keepouts, pageRect);
    console.log('[sprinkles] placements', placements.map(p => ({
      cls: p.el.classList[1], // e.g. "sp-squig-1"
      x: Math.round(p.x),
      y: Math.round(p.y),
      r: Math.round(p.radius),
    })));
  }
```

- [ ] **Step 3: Verify in browser**

Reload. Console expected:

```
[sprinkles] placements [
  { cls: "sp-squig-1", x: ..., y: ..., r: 89 },
  { cls: "sp-squig-2", x: ..., y: ..., r: 75 },
  ...
]
```

Sanity checks:
- 16 entries.
- All `x` values in `[radius, pageWidth - radius]`; same for `y`.
- Reload twice — placements should be identical (deterministic seed).
- Resize the window and reload — placements change to fit the new viewport but are still deterministic for that viewport.

- [ ] **Step 4: Commit**

```bash
git add docs/sprinkles.js
git commit -m "$(cat <<'EOF'
Implement Mitchell's best-candidate placement in sprinkles.js

placeAll() runs the seeded algorithm: largest-first, K=30 candidates,
score = min distance to placed sprinkles + keepout edges. Logs the
placements but doesn't apply them yet — sprinkles still render at
their authored CSS positions.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Apply placements (visible change)

**Files:**
- Modify: `docs/sprinkles.js`

Add `apply()` which writes `style.top`, `style.left`, and clears `style.bottom` / `style.right` on each sprinkle. Wire into `layout()`. This is the first commit where the page visibly changes — sprinkles move from their authored positions to algorithm-determined positions. The authored CSS top/left/right/bottom values still exist but are now overridden by inline styles.

The sprinkle's CSS `top`/`left` references the *unrotated* top-left corner of the SVG. The placement gives us the desired center. We use the stored unrotated `w` and `h` (from `measureSprinkles` in Task 3) to convert center → top-left. The visual AABB's center equals the unrotated element's center (rotation pivots around the center), so anchoring by `(p.x - w/2, p.y - h/2)` lands the rotated sprinkle visually centered on `(p.x, p.y)`.

### Steps

- [ ] **Step 1: Add `apply`**

Insert after `placeAll`:

```js
  // Write inline style.top / style.left to each placed sprinkle.
  // Placement positions are sprinkle centers (in .page coords); we
  // subtract the *unrotated* half-width / half-height (captured in
  // measureSprinkles via getComputedStyle) to get the top-left
  // corner CSS expects. Clears bottom/right so any leftover authored
  // shorthand doesn't fight the inline values.
  function apply(placements) {
    for (const p of placements) {
      p.el.style.top    = (p.y - p.h / 2) + 'px';
      p.el.style.left   = (p.x - p.w / 2) + 'px';
      p.el.style.bottom = 'auto';
      p.el.style.right  = 'auto';
    }
  }
```

- [ ] **Step 2: Wire into `layout()`**

Replace the placement-logging block with:

```js
  function layout() {
    const page = document.querySelector('.page');
    if (!page) return;
    const pageRect = page.getBoundingClientRect();
    const keepouts = rectsFromSelectors(pageRect);
    const sprinkles = measureSprinkles();
    if (!sprinkles.length) return;
    const placements = placeAll(sprinkles, keepouts, pageRect);
    apply(placements);
  }
```

(The earlier `console.log` lines are removed in this step.)

- [ ] **Step 3: Verify in browser — light mode**

Reload `http://localhost:8000`. In DevTools, set `<html data-theme="light">`.

Expected:
- All 16 sprinkles visible.
- No sprinkle overlaps the motto text in the top-right.
- No sprinkle overlaps the logo + wordmark.
- No sprinkle overlaps the CTA button or sublabel.
- No sprinkle overlaps the footer copyright line or CMYK swatches.
- No two sprinkles are visibly stacked or touching.
- Sprinkles roughly fill the empty area between content blocks; no large blank zones, no clumps.

- [ ] **Step 4: Verify in browser — dark mode**

Set `<html data-theme="dark">`.

Expected:
- All sprinkles visible with their phosphor glow.
- Same distribution as light mode (algorithm runs once at load — theme doesn't affect placement).
- Sprinkles intersecting the hero canvas edge get the Trinitron "wrap onto phosphor" effect (this was working before; verify it still works).

- [ ] **Step 5: Verify determinism**

Reload the page 3 times in dark mode. Sprinkles should land in exactly the same spots each time.

- [ ] **Step 6: Commit**

```bash
git add docs/sprinkles.js
git commit -m "$(cat <<'EOF'
Apply algorithmic placements to sprinkles at runtime

apply() writes inline style.top/left (center → top-left of AABB) and
clears bottom/right. Sprinkles now distribute via Mitchell's at load;
the authored CSS positions are now dead but still present and being
overridden — removed in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Remove dead authored positions from CSS

**Files:**
- Modify: `docs/index.html`

The inline styles from Task 5 override the authored CSS positions. Now delete the dead CSS: remove `top`/`left`/`right`/`bottom` from each of the 16 `.sp-*` blocks (`docs/index.html:394-494`). Keep everything else: `width`, `height` (where set), `transform: rotate(...)`, `--glow`, `--flick-p`, `--flick-d`, the per-class fill rules, the `overflow: visible` on `.sp-cross`, the comments that explain `--glow`-less sprinkles like `.sp-check`. Also remove the eight zone comments (`/* ─── TOP-LEFT ─── */` etc.) — they're no longer accurate.

Update the `MEMPHIS SPRINKLES` header comment to reflect the new reality: positions come from `docs/sprinkles.js`.

### Steps

- [ ] **Step 1: Update the section header comment**

Find the `/* ===================== MEMPHIS SPRINKLES =====================` block at `docs/index.html:385-393` and replace its body with:

```css
  /* ===================== MEMPHIS SPRINKLES =====================
     Position is set at runtime by docs/sprinkles.js (Mitchell's
     best-candidate, deterministic per viewport). This block only
     authors per-sprinkle shape: width, rotation, --glow channel
     (rgb, for the phosphor halo), --flick-p / --flick-d (co-prime
     flicker period + delay — negative delays start each sprinkle
     mid-cycle), and any class-specific fills.

     The .sprinkle base class (position: absolute, the shared halo
     filter, the gated flicker animation) lives in tokens.css. */
```

- [ ] **Step 2: Remove zone comments and position properties from each `.sp-*` block**

Walk through `docs/index.html:394-494` and apply these edits to each of the 16 blocks. The exact pattern: delete the `/* ─── ZONE ─── */` comment line above each group, and delete any `top: ...;`, `left: ...;`, `right: ...;`, `bottom: ...;` declaration inside each `.sp-*` rule. Keep `width`, `height`, `transform`, `--glow`, `--flick-p`, `--flick-d`, `border`, `color`, `overflow`, and any class-specific fills.

The 16 blocks (selector → keep-list after edit):

| Selector | Keep |
|---|---|
| `.sp-squig-1` | `width: 168px; transform: rotate(-16deg); --glow: 229 4 127; --flick-p: 5.2s; --flick-d: -0.4s;` |
| `.sp-check` | `width: 36px; height: 36px; border: 2px solid var(--border); transform: rotate(-14deg); --flick-p: 5.9s; --flick-d: -1.5s;` (plus the `--glow`-less comment) |
| `.sp-dot-2` | `width: 18px; --glow: 243 44 9; --flick-p: 6.4s; --flick-d: -2.8s;` |
| `.sp-tri-1` | `width: 48px; transform: rotate(-26deg); --glow: 254 209 5; --flick-p: 4.9s; --flick-d: -1.3s;` |
| `.sp-stripe` | `width: 68px; transform: rotate(20deg); --glow: 229 4 127; --flick-p: 5.0s; --flick-d: -1.1s;` |
| `.sp-dot-3` | `width: 14px; --glow: 229 4 127; --flick-p: 5.5s; --flick-d: -3.2s;` |
| `.sp-dot-1` | `width: 33px; --glow: 0 168 243; --flick-p: 5.8s; --flick-d: -0.9s;` (plus the offset-shadow comment) |
| `.sp-bar-1` | `width: 85px; transform: rotate(-32deg); --glow: 229 4 127; --flick-p: 5.4s; --flick-d: -0.6s;` (plus the offset-shadow comment) |
| `.sp-ring` | `width: 44px; --glow: 254 209 5; --flick-p: 7.0s; --flick-d: -1.7s;` |
| `.sp-bar-2` | `width: 64px; transform: rotate(32deg); --glow: 0 1 160; --flick-p: 6.9s; --flick-d: -3.9s;` |
| `.sp-squig-2` | `width: 140px; transform: rotate(22deg); --glow: 0 168 243; --flick-p: 6.7s; --flick-d: -2.1s;` |
| `.sp-arc` | `width: 82px; transform: rotate(-34deg); --glow: 0 1 160; --flick-p: 6.1s; --flick-d: -2.5s;` |
| `.sp-reg` | `width: 32px; height: 32px; --glow: 254 209 5; --flick-p: 5.6s; --flick-d: -2.4s;` |
| `.sp-cross` | `width: 30px; height: 30px; transform: rotate(8deg); overflow: visible; --glow: 0 168 243; --flick-p: 6.5s; --flick-d: -3.4s;` (plus the overflow comment) |
| `.sp-tri-2` | `width: 26px; height: 24px; color: var(--ink-yellow); transform: rotate(15deg); --glow: 1 156 73; --flick-p: 7.3s; --flick-d: -3.6s;` (drop the `top: 18%; right: clamp(...)` plus its inline comment) |

Note `.sp-tri-2`'s authored position used a `clamp()` corner-avoidance trick. The new algorithm replaces that entirely.

- [ ] **Step 3: Verify in browser**

Reload. Expected:
- Page renders identically to after Task 5 (inline styles unchanged; CSS positions just removed dead code).
- No new sprinkle clumping or movement.
- DevTools "Computed" tab on any sprinkle should show `top` and `left` coming from the `element.style` inline source, not a CSS file.

- [ ] **Step 4: Commit**

```bash
git add docs/index.html
git commit -m "$(cat <<'EOF'
Delete dead authored sprinkle positions from CSS

Positions now come from sprinkles.js inline styles; the CSS top/left/
right/bottom values were being overridden. Removes the eight zone
comments and updates the MEMPHIS SPRINKLES header to point at the
new runtime layout.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Add debounced resize handling

**Files:**
- Modify: `docs/sprinkles.js`

Re-layout on viewport resize, debounced 150ms. Same seed → resize produces a new but stable distribution.

### Steps

- [ ] **Step 1: Add the resize handler**

Replace the `if (document.readyState === 'loading') { ... } else { layout(); }` block at the end of the IIFE with:

```js
  let resizeTimer = null;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(layout, RESIZE_DEBOUNCE_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', layout);
  } else {
    layout();
  }
  window.addEventListener('resize', onResize);
```

- [ ] **Step 2: Verify resize behavior**

Reload `http://localhost:8000`. Resize the browser window: drag from wide to narrow, then back. Expected:
- Sprinkles redistribute after a ~150ms pause following resize.
- No layout thrash during the drag itself (debounce should swallow the high-frequency resize events).
- After resize stops, sprinkles land in a new sensible distribution for that viewport.
- Returning to the original viewport size should produce identical placements to the initial load.

- [ ] **Step 3: Commit**

```bash
git add docs/sprinkles.js
git commit -m "$(cat <<'EOF'
Re-layout sprinkles on debounced resize

window.resize → setTimeout(layout, 150ms) trailing debounce. Same
seed across re-layouts, so a resize gives a new stable distribution
for the new viewport, and returning to the original viewport reverts
to the original placement.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Handle font-load layout shift

**Files:**
- Modify: `docs/sprinkles.js`

The wordmark uses a custom font (`var(--font-display)`). If the font loads after `DOMContentLoaded`, the wordmark's bounding rect will shift and the keepout used by the initial layout will be stale. Re-run layout after `document.fonts.ready`.

This is conservative — on a font cache hit it's a no-op second layout pass, but it costs less than a millisecond and protects against the first-paint case.

### Steps

- [ ] **Step 1: Add `fonts.ready` re-layout**

In the readystate block at the bottom of the IIFE, add a `fonts.ready` handler:

```js
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', layout);
  } else {
    layout();
  }
  window.addEventListener('resize', onResize);

  // Wordmark width depends on a custom font. Re-layout once fonts
  // settle so sprinkles avoid the post-font-load wordmark, not the
  // pre-font-load fallback.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(layout);
  }
```

- [ ] **Step 2: Verify**

Hard-reload (DevTools → Network tab → "Disable cache" enabled, then Ctrl+Shift+R) and observe sprinkles. Expected:
- Sprinkles may briefly land at one set of positions, then shift slightly once the display font loads.
- The shift is small (just enough to track the wordmark's new width) and is visible only on the first uncached load.
- On a warm cache reload, no visible shift.

- [ ] **Step 3: Commit**

```bash
git add docs/sprinkles.js
git commit -m "$(cat <<'EOF'
Re-layout sprinkles after document.fonts.ready

The wordmark uses a custom display font; pre-font-load measurements
of .brand are too narrow. A second layout pass after fonts settle
keeps sprinkles aligned with the actual rendered wordmark width.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Cross-viewport validation

**Files:**
- None modified

A pure verification task. No code changes — just confirm the implementation holds up at the viewport sizes that matter. If something looks wrong, file a follow-up note (don't fix inline unless trivial).

### Steps

- [ ] **Step 1: Verify at 1920×1080**

DevTools → device toolbar → "Responsive" → set to 1920×1080. Reload. Check:
- All 16 sprinkles visible.
- No sprinkle overlaps motto, logo, wordmark, CTA, or footer.
- Distribution looks even — no clumps, no dead zones.
- Both light and dark mode look clean (toggle `<html data-theme>`).

- [ ] **Step 2: Verify at 1440×900**

Set to 1440×900. Same checks.

- [ ] **Step 3: Verify at 1024×768**

Set to 1024×768. Same checks. At this size the keepouts swallow most of the page, so distribution will look tighter — still no overlap with text is the bar.

- [ ] **Step 4: Verify at 768×1024 (portrait tablet)**

Set to 768×1024. Same checks. This is the tightest case; clumping near the edges is acceptable, text overlap is not.

- [ ] **Step 5: Verify reload determinism at each size**

At each viewport above, reload 3 times. Sprinkle positions should be byte-identical across reloads.

- [ ] **Step 6: No commit needed**

This task produces no diff. If issues were found, address them with a focused follow-up commit.

---

## Task 10: Update CLAUDE.md to document the second JS exception

**Files:**
- Modify: `CLAUDE.md`

The "CSS-first, with one documented JS exception" section in CLAUDE.md singles out `docs/trinitron.js` as the only JS in the repo. Sprinkles.js becomes the second exception and deserves the same treatment.

### Steps

- [ ] **Step 1: Update the "CSS-first" section**

In `CLAUDE.md`, find the section titled `### CSS-first, with one documented JS exception`. Update the heading to:

```markdown
### CSS-first, with documented JS exceptions
```

After the existing Trinitron paragraph (ending "...here's why."), append a new paragraph for sprinkles:

```markdown
The second exception is `docs/sprinkles.js` — a small (~120 line) IIFE that runs Mitchell's best-candidate algorithm on page load and on debounced resize to distribute the Memphis sprinkles into the page's empty area, avoiding the legible content (motto, logo + wordmark, CTA, footer). Like the Trinitron, this is something CSS genuinely can't do: CSS has no way to read sibling elements' computed bounding rects, and the wordmark's responsive width (`clamp()`-driven font sizing) is the whole reason hand-authored sprinkle positions were clumping into it. The script writes inline `style.top` / `style.left` on each `.sprinkle` and clears `bottom` / `right`. Everything else about the sprinkles (size, rotation, color via `--glow`, flicker timing) stays authored in CSS. Seed is fixed; distribution is deterministic per viewport. Design: `specs/2026-05-22-sprinkle-distribution-design.md`. Plan: `plans/2026-05-22-sprinkle-distribution-implementation.md`.
```

- [ ] **Step 2: Update the "File layout" section**

Find the bullet for `docs/trinitron.js` in the `## File layout` section and add a sibling bullet for the new file:

```markdown
- `docs/sprinkles.js` — runtime sprinkle distribution (Mitchell's best-candidate, seeded). The second documented JS exception (see "CSS-first, with documented JS exceptions" below).
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
Document sprinkles.js as the second JS exception in CLAUDE.md

CSS-first section now lists two exceptions: the Trinitron renderer
and the new sprinkle distribution script. File layout gets a bullet
for the new file with a pointer to the design/plan docs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final State

After all tasks:
- `docs/sprinkles.js` (~120 lines): IIFE with PRNG, geometry helpers, keepout/sprinkle measurement, Mitchell's algorithm, apply, debounced resize, fonts-ready re-layout.
- `docs/index.html`: script tag added; 16 sprinkle CSS blocks no longer carry positions; zone comments removed; header comment updated to point at sprinkles.js.
- `CLAUDE.md`: documents two JS exceptions instead of one; file layout lists `docs/sprinkles.js`.
- `docs/tokens.css`, `docs/trinitron.js`: unchanged.
- All 16 sprinkles distribute deterministically into the page's empty area, avoid legible content, redistribute on resize, and don't shuffle on reload.
