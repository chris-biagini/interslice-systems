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
