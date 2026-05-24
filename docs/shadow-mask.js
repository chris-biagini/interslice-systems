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
