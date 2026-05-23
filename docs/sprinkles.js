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
})();
