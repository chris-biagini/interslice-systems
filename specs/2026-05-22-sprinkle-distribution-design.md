# Algorithmic Sprinkle Distribution

**Date:** 2026-05-22
**Status:** Design

## Problem

The page currently carries 16 Memphis sprinkles, each absolutely positioned by hand in `docs/index.html:394-494` and grouped into eight ad-hoc "page zones" (top-left, top-right, mid-left, etc.). The result has two recurring quality problems:

1. **Clumping.** Hand-tuning by eye produces uneven density; some zones bunch up while others look thin.
2. **Content interference.** The wordmark's width is responsive (its font size uses `clamp()`), so a sprinkle that sits cleanly in a "gutter" at one viewport overlaps the wordmark at another. Hand-authored positions can't track this.

We want sprinkles automatically distributed across the page so that they:

- Stay in the same place across reloads (deterministic — no shuffling on refresh).
- Fill the empty area of the page evenly, without visible clumps.
- Avoid overlapping the legible content (motto, logo + wordmark, CTA, footer).

## Non-Goals

- **Animating sprinkles between positions.** Layout runs at load and on debounced resize; positions snap.
- **Touching anything other than `top` and `left`.** The algorithm doesn't change rotation, color (`--glow`), flicker timing, or size. Those stay authored in CSS.
- **Adding new sprinkles or removing existing ones.** Sprinkle inventory stays as it is; only their placement is automated.
- **Avoiding the hero canvas.** Sprinkles intersecting `.brand` are a feature in dark mode — the Trinitron renderer detects them and rasterizes them onto the phosphor signal (see `index.html:1369-1398`). Keepouts target *legible content*, not the whole canvas region.

## Architecture

A single new script, `docs/sprinkles.js`, sourced from `index.html` after `trinitron.js`. Roughly 80–100 lines including comments. Module-pattern IIFE, no exports.

```
docs/
├── index.html          # consumer; <script src="sprinkles.js"></script> after trinitron.js
├── sprinkles.js        # NEW — distribution algorithm
├── trinitron.js        # existing
└── tokens.css          # .sprinkle base styles unchanged
```

### Why JS

CLAUDE.md sets a high bar for new scripts ("CSS can't do this either, and here's why"). This case clears it:

- CSS can't read sibling elements' computed bounding rects, and the wordmark's responsive width is the entire motivation.
- Mitchell's best-candidate algorithm requires iterative comparison of candidates against existing placements — a state-loop CSS doesn't have primitives for.

This becomes the second documented JS exception in the repo, alongside the Trinitron renderer.

## The Algorithm

**Mitchell's best-candidate, largest-first, seeded.**

```
seed PRNG with constant 0x53707269  // "Spri"
sort sprinkles by bounding radius descending
placed = []

for each sprinkle:
    bestPosition, bestScore = null, -Infinity
    for i in 1..K candidates (K = 30):
        p = random point in .page interior, seeded
        if circle(p, sprinkle.radius) intersects any keepout: continue
        score = min(
            distance from p to each placed sprinkle (minus radii),
            distance from p to each keepout edge
        )
        if score > bestScore:
            bestPosition, bestScore = p, score
    placed.append({ sprinkle, position: bestPosition })

for each placement:
    set sprinkle.style.top, .left to position (relative to .page)
    clear .style.bottom, .style.right so authored CSS doesn't conflict
```

**Why largest-first:** the biggest sprinkles (the 168px squiggle, the 140px squiggle, the 85px bar) are the hardest to place. Reserving room for them first prevents the algorithm from painting itself into a corner by filling the page with small dots and having no large gap left.

**Why Mitchell's over Bridson's:** Bridson's Poisson disk produces "truer" blue noise but assumes uniform radii. Mitchell's handles per-sprinkle radii naturally (each sprinkle's score already accounts for its own size), and at this small N (16) the visual difference is invisible.

**Per-sprinkle radius:** `sqrt(width² + height²) / 2`, computed from the sprinkle's `getBoundingClientRect()` *before* the algorithm moves it. (Half-diagonal of the AABB — the bounding-circle radius.) Mitchell's needs a single scalar exclusion distance, and the bounding circle is rotation-invariant, so it's the cleanest choice for rotated SVGs.

**The seed** is a fixed constant (`0x53707269`, ASCII "Spri"). The PRNG is `mulberry32` (~5 lines, well-known, statistically fine for this use). Distribution is identical for every visitor at the same viewport.

## Keepouts

Four DOM-derived keepout rectangles, computed from `getBoundingClientRect()` translated into `.page`-relative coordinates:

| Selector       | Rationale                                          |
|----------------|----------------------------------------------------|
| `.top`         | The motto strip across the top                     |
| `.brand`       | Logo + wordmark block as one rect                  |
| `.cta-wrap`    | CTA button + sublabel                              |
| `.foot`        | Footer copyright + CMYK swatches                   |

Each keepout is padded by 16px outward. Sprinkles can graze edges but never tuck under text.

`.brand` is the conservative choice (over wordmark-only). The Trinitron renderer already paints sprinkles intersecting the canvas as phosphor; we don't need sprinkles *inside* the logo silhouette to get that effect — sprinkles near the canvas edges already produce it.

## Resize Behavior

Debounced re-layout on `resize`, 150ms trailing.

- Same seed every time → same character of distribution.
- New viewport → new bounding rects → new keepouts → algorithm re-runs → positions adjust.
- No per-visitor randomness: refreshing the page at the same viewport produces identical output.

This is cheap: 16 sprinkles × 30 candidates × ~5 keepouts of distance math = ~2,400 operations. Sub-millisecond on any device.

## Integration Points

### `index.html`

- Add `<script src="sprinkles.js"></script>` after the existing `<script src="trinitron.js"></script>` tag.
- The 16 sprinkle `<svg class="sprinkle ...">` elements stay in the DOM exactly as today.
- The per-sprinkle CSS in `index.html:394-494` keeps everything *except* the `top`/`left`/`right`/`bottom` properties. Width, transform (rotation), `--glow`, `--flick-p`, `--flick-d` all stay.

### What gets deleted from CSS

For each of the 16 `.sp-*` selectors, remove `top: ...`, `left: ...`, `right: ...`, `bottom: ...`. Keep `width`, `transform`, `--glow`, `--flick-p`, `--flick-d`, and any class-specific fills.

The zone comments (`/* ─── TOP-LEFT ─── */` etc.) come out too — they're no longer accurate.

### What sprinkles.js writes

For each `.sprinkle`, inline:
```
element.style.top  = computedTopPx + 'px'
element.style.left = computedLeftPx + 'px'
element.style.right  = 'auto'
element.style.bottom = 'auto'
```

The `right: auto` / `bottom: auto` clears any CSS shorthand the algorithm doesn't use. (Belt-and-suspenders: we removed those properties from CSS in the previous step, but explicit clearing keeps the script robust if a future sprinkle gets authored with `right:` or `bottom:`.)

### What stays in CSS

`.sprinkle` base in `tokens.css` (position: absolute, halo filter, flicker animation). Per-sprinkle width/transform/color/timing in `index.html`.

## Module Shape

```js
// docs/sprinkles.js
(function () {
  'use strict';
  const SEED = 0x53707269;
  const KEEPOUT_PAD = 16;
  const CANDIDATE_COUNT = 30;
  const KEEPOUT_SELECTORS = ['.top', '.brand', '.cta-wrap', '.foot'];

  function mulberry32(seed) { /* 5 lines */ }
  function rectsFromSelectors(pageRect) { /* read keepouts in .page coords */ }
  function measureSprinkles() { /* read .sprinkle bounding circle radii */ }
  function pointInRect(p, r) { /* hit test */ }
  function distToRect(p, r) { /* signed distance to padded rect */ }
  function placeAll(sprinkles, keepouts, pageRect) { /* Mitchell's */ }
  function apply(placements) { /* write style.top/left, clear right/bottom */ }

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

  let resizeTimer = null;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(layout, 150);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', layout);
  } else {
    layout();
  }
  window.addEventListener('resize', onResize);
})();
```

## Edge Cases & Failure Modes

- **No solution found for a sprinkle** (every candidate intersects a keepout). The algorithm keeps the best scoring candidate even if its score is negative (i.e., it overlaps a keepout slightly). This is graceful degradation: better to nudge into a keepout than to leave the sprinkle stacked at 0,0. In practice the page is large enough that K=30 always finds a clean spot.
- **`.brand` not yet measured at first paint.** Layout runs at `DOMContentLoaded`. By that point all elements have bounding rects (fonts may still be loading, but the wordmark's CSS-controlled font sizing gives a stable rect even with font-swap). If we observe wordmark width changing post-font-load, add a `document.fonts.ready` re-layout.
- **Very narrow viewports.** The 4 keepouts together can swallow most of the page on mobile. Mitchell's still picks the least-bad spot for each sprinkle, but the result will look crowded. Acceptable tradeoff — this is a desktop-marketing page, not a mobile-first app. We can revisit with a media query that hides some sprinkles if needed.
- **Sprinkle inventory changes.** Adding/removing sprinkles changes the placement order (because of the largest-first sort) and so changes the entire distribution. That's fine — re-checking the visuals is part of adding a sprinkle anyway.

## Validation

- Both themes: light (paper) and dark (Trinitron). Toggle via `<html data-theme="dark">` in DevTools.
- Three viewport sizes: 1920×1080, 1440×900, 768×1024. Verify no sprinkle overlaps any text; verify distribution looks roughly uniform.
- Reload at each size: confirm sprinkles land in the exact same spots.
- Resize from wide to narrow: confirm sprinkles smoothly redistribute (debounced).
- DevTools `?debug=1` opens the Trinitron effects panel; orthogonal but verify sprinkles intersecting the hero canvas still rasterize as phosphor.

## Open Questions

None. All four design decisions are settled:

1. **Keepout list:** `.top`, `.brand`, `.cta-wrap`, `.foot`, padded 16px.
2. **Resize:** re-layout debounced 150ms.
3. **Seed:** fixed `0x53707269`.
4. **Algorithm:** Mitchell's best-candidate, largest-first, K=30.
