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
    resizeTimer = setTimeout(layout, RESIZE_DEBOUNCE_MS);
  }

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
})();
