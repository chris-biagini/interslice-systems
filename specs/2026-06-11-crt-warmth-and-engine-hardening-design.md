# CRT Warmth + Engine Hardening — Design

**Date:** 2026-06-11
**Scope:** `docs/trinitron.js`, `docs/shadow-mask.js`, `docs/tv.html`, `docs/index.html` (hero options only), `CLAUDE.md`
**Prior art:** `2026-06-10-crt-effect-axes-and-tv-page-design.md` (effect schema/axes, TV service bay), `2026-05-24-pc-crt-shadow-mask-design.md` (peer-renderer convention)

## Mission

> Maximally delightful but tastefully restrained — a tech demo that does heroic
> things to achieve what it does within a modest performance budget.

The renderers should evoke the *endearing* qualities of a CRT — phosphor glow,
low resolution, persistence, the physicality of glass — while cheating away the
qualities that are clearly flaws. The analogy: emulating a record player's
warmth without emulating the skips.

**The design rule for what survives:** *we fix every flaw we possibly can; the
only flaws that remain are the "I canna change the laws of physics" ones.* The
damper wires stay (an iconic, physically-mandatory Trinitron signature that
rewards people who recognize it). Brightness instability, convergence wobble,
and scanline noise go — those simulate a *dying* TV, not a TV.

**Corollary:** flaws are permitted as *punctuation*, never as steady state.
Dead-channel snow is a flaw; 150 ms of snow on a channel change is the charm.

This round delivers **(a) look curation** and **(b) engine hardening** in this
repo, tuned on the tv.html bench. The eventual drop-in "TV viewer" component
for stitching AI-generated video clips (continuity breaks reframed as channel
changes) is **(c)** — a design constraint kept in view here, delivered later
under its own spec, likely as the moment the shared chassis gets extracted.
All engine changes land in **both** peer renderer files, per the documented
copy-share convention (no chassis extraction this round — Approach A).

## Constraints

- **Device floor:** runs respectably on a ~2020 mid-range phone and any
  evergreen browser. Below that it degrades *gracefully* (clean fallback, no
  broken half-renders, no throws that take the page down).
- **Performance contract:** fully idle when the picture is static,
  content-rate when animated, stopped when invisible. A purely decorative
  effect must cost ~zero when it isn't visibly doing anything.
- **Shape (this round):** 320×240 signal grid, 4:3, displayed card-in-page at
  640×480. Resolution and display size stay configurable seams (they already
  are, via `viewSize`/`canvasSize`) for a future range of "render this little
  sprite in a CRT" up to "make the whole screen a CRT" — but no new scaling
  work (and no moiré mitigation for non-integer scales) happens now.
- **Aspect handling** lives at the signal layer: the signal callback owns
  fitting content to the 4:3 grid. Future viewer default is letterbox, with
  caller's-choice crop. Nothing to build this round; tv.html channels draw
  4:3 natively.
- **No toolchain.** Plain JS, two peer files, inline page script. No build
  step, no new dependencies.

## 1. The cut

Remove `convergenceDrift`, `breathing`, and `perRowShimmer` from both
renderers — entirely, not default-off:

- **Shader:** the `lcg()` hash, `uRowShimmerAmp`, `uShimmerSeed`,
  `uRowShimmerEnabled`, the `rowShim` multiply in the phosphor pass.
- **Per-frame JS:** the shimmer-seed upload, the convergence-drift R/B
  override and its `_convergenceDriftWasActive` transition handling, the
  breathing factor in the brightness computation.
- **Options:** `rowShimmer`, `shimmerSeed`; `PANEL_OPT_KEYS` entries.
- **Effects + schema:** the three keys and their schema items (debug overlay
  and bench rows disappear with them).
- **Consumers:** the `rowShimmer: 0.02` pre-seeds in tv.html's common options
  block and in both renderer branches of index.html's `createTrinitron`.

The hero never enabled any of the three (all default-off), so it is visually
unchanged. After the cut, the steady-state pipeline has **no** per-frame
uniform uploads except brightness during the warmup ramp — nothing varies
frame-to-frame but the signal and persistence decay. That property is what
makes the idle scheduler (§3) sound.

## 2. Time-based persistence

Replace the per-frame decay lerp with a **half-life in milliseconds**.

- Option: `persistence: 0.85` (per-frame factor) becomes
  `persistenceHalfLifeMs` (ms).
- Per rendered frame, CPU computes `decay = pow(0.5, dt / halfLifeMs)` where
  `dt` = ms since the previous *rendered* frame (clamp dt to ≥ 1 ms; large dt
  naturally drives decay → 0, which is correct after an idle gap). Upload as
  the existing `uPersistence` uniform; the shader is unchanged.
- **Conversions** (decay-per-frame `d` at 60 Hz → half-life
  `= 16.67 × ln 0.5 / ln d`):
  - TV preset and hero both pass `0.82` → **58 ms**
  - Class default `0.85` → **71 ms**
- Bench/debug slider becomes `persistenceHalfLifeMs`, range 0–500 ms, step 5.
- `stateDiff()`/`readParam`/`writeParam` track the new option name.

Trails now have identical length on 60 Hz, 120 Hz, and any future
video-frame-rate source. This is a prerequisite for §3 (the settle tail is
computed from the half-life) and for (c) (video renders at clip rate).

## 3. The scheduler (performance contract)

Each renderer gets a clearly-bounded scheduler section — duplicated per the
peer convention, written so the future viewer extraction can lift it
mechanically. Four states:

- **running** — signal is animated; render every RAF tick (the frame source
  is "RAF" today; a video-frame callback is the anticipated future source).
- **settling** — signal reported static; keep rendering on RAF until trails
  decay below one 8-bit LSB **and** warmup has completed, then go idle. The
  tail length is deterministic: `persistenceHalfLifeMs × log2(255)` ≈ 8
  half-lives (~470 ms at the TV's 58 ms).
- **idle** — zero work: no RAF, no signal paint, no upload, no draw. The
  canvas keeps displaying its last composited frame.
- **stopped** — canvas not intersecting the viewport (new
  IntersectionObserver, threshold 0), or reduced-motion (existing behavior
  preserved: render exactly one static frame at t past the warmup ramp).
  Hidden tabs already cost nothing because all frames ride RAF.

**Dirty signaling.** The `signal(ctx, t)` callback may return `false`,
meaning "nothing new was painted; skip this frame." Returning `undefined` or
anything truthy means animated — so **existing callbacks get status-quo
behavior with no changes** (the hero's rotating logo runs every frame, as
now). When the callback returns `false`, the renderer skips the signal upload
and the render, and (re)starts the settle countdown.

**External pokes.** New public `requestRender()`: schedules a render (and a
settle re-evaluation) from idle. `writeParam()` calls it internally; the
tv.html bench calls it after direct `renderer.effects[...]` checkbox
mutations. Without this, sliders/toggles wouldn't repaint a static picture.

**State transitions on visibility:** offscreen → `stopped` (cancel RAF);
back onscreen → one render, then `settling` (re-idles if static). Reduced
motion continues to override everything (one static frame, no loop).

**tv.html integration:** channels gain `static: true/false` flags (bars,
crosshatch, test card: static; motion reel, snow, dither: animated). The
`paintChannel` wrapper returns `false` when the current channel is static,
it has already painted once since the last channel/renderer change, and no
snow interstitial is active. The bench FPS meter learns a third reading:
`fps: idle` — the visible proof of the contract.

## 4. Texture downgrade + robustness

- **RGBA32F → RGBA8** for the persistence ping-pong pair and the phosphor MRT
  target. Every stored value is bounded [0,1] (signal ≤ 1, lerp of bounded
  values, stripe weights ≤ 1), so nothing real is lost. Memory for the three
  320×240 buffers drops 4× (~3.7 MB → ~0.9 MB).
- **8-bit fade-to-black bias:** in 8-bit, a decaying trail can stick when
  `prev × decay` rounds back to `prev` (the bottom few grey levels never
  reach zero). Fix in the phosphor shader's persistence write: subtract half
  an LSB (`0.5/255`), clamped at 0. Cost to live signal: ≤ 0.2 % brightness,
  invisible.
- **Delete both extension requirements** (`EXT_color_buffer_float`,
  `OES_texture_float_linear`) and their constructor throws. Any WebGL2
  context now runs the full pipeline. RGBA8 is renderable and
  linear-filterable unconditionally in WebGL2.
- **Degradation ladder is binary:** full pipeline on WebGL2, otherwise the
  constructor throws `'WebGL2 unavailable'` as today and the caller falls
  back (hero → static SVG, tv.html → bypass with honest readout). No tiered
  effect-dropping — the full pipeline is now cheap enough for the floor.
- **Context-loss handling (new):** `webglcontextlost` → `preventDefault()`,
  stop the loop, mark GPU state dead; `webglcontextrestored` → re-run GPU
  init (programs, textures, FBOs, static uniforms) and resume the prior
  scheduler state. A mid-session GPU hiccup currently leaves a dead black
  canvas; a good web citizen recovers.

## 5. Phosphor color grade (new effect: `colorGrade`)

Composite-pass effect, scope `universal`, both renderers. Two restrained
knobs, no 3×3 matrix:

- `gradeTemperature` ∈ [-1, +1], default ≈ **+0.3** (slightly warm). Maps to
  RGB gains, e.g. `vec3(1.0 + 0.03t, 1.0, 1.0 − 0.05t)` (implementation may
  retune the mapping on the bench; the knob stays a single scalar).
- `gradeSaturation` ∈ [0, 2], default ≈ **1.08**. Luma-preserving:
  `mix(vec3(dot(color, LUMA)), color, s)`.

**Pipeline position matters:** the grade applies to *emitted* light — after
phosphor + bloom + scanlines, **before** gloss (a reflection on the glass in
front of the phosphor must not be tinted by the tube's color character) and
before vignette/gap-mask/brightness. Defaults are starting points; final
values come from the bench. Schema item lands in the `composite` group with
both params; `PANEL_OPT_KEYS` and `stateDiff()` pick them up.

## 6. Tube-corner rounding (new effect: `tubeCorners`)

The raster gets real CRT corners, owned by the engine instead of page CSS:

- Rounded-rect SDF evaluated on the post-curvature glass UV in the composite
  pass; outside → transparent (same convention as the existing curvature
  out-of-bounds), with a ~1-canvas-px smoothstep edge.
- Param: `cornerRadius` as a fraction of the canvas's short side, range
  0–0.2, default tuned on the bench (~0.06 expected).
- Because it masks `sampleUv`, bloom, gloss, vignette, and curvature all
  respect the true tube silhouette automatically.
- Schema item in the `glass` group, scope `universal`. tv.html keeps its CSS
  cutout (that's the bezel's shape); the engine now owns the *picture's*
  shape. This is the seam that lets the future viewer drop onto any page
  without recreating cabinet CSS.

## 7. Warmup color settle

The existing 1.2 s warmup brightness ramp gains a color dimension: the tube
starts slightly dim, warm-shifted, and undersaturated, then settles into the
tuned grade. Implemented as ramp-time modulation of the §5 uniforms (e.g.,
extra temperature `+0.5·(1−k)` and saturation scaled `0.85+0.15k`, where `k`
is the existing smoothstep ramp) — uploaded only during ramp frames, zero
cost afterward. The scheduler treats an active warmup as "animated" (§3
settling waits for it). No new effect key: this rides the existing `warmup`
toggle; if `colorGrade` is disabled, warmup modulates from neutral.

## 8. CH 7 — DITHER (the Sonic waterfall test)

New tv.html channel, dial number 7, animated. This is the acceptance test
for "some low-res images look *better* on a CRT":

- **The waterfall:** a Genesis-flavored side-scrolling scene (parallax
  checker-tiled hills) with a waterfall drawn the way the Mega Drive faked
  transparency: alternating **1-px vertical columns** of waterfall color and
  background, scrolling downward.
- **Supporting patterns:** 2×2 checkerboard dither ramps (the other classic
  transparency), stair-step diagonals, and a row of small sprites with
  single-pixel detail.
- **Pass criterion (stated, verifiable):** on the raw **bypass** the
  waterfall reads as hard stripes; through either renderer it reads as
  translucent shimmer; diagonals smooth rather than jag; sprites gain
  solidity rather than mush. If it fails, retune `beamSpreadPx` /
  `phosphorCoupling` / `scanlineDepth` until it passes — the channel exists
  so this is a repeatable judgment, not a hope.
- **Dial change:** the CHANNEL dial gains a sixth painted position — ticks
  re-spaced from 60° to 48° increments across the same −120°…+120° sweep,
  numbers 2–7. Knob angle math in `setChannel` updates to match.

Related principle, recorded for (c): the 320×240 signal canvas is the *real
pixel grid*. Whatever is drawn into it — including future high-res AI video,
and including content with fake "AI pixelation" — is honestly resampled onto
that grid before the phosphor sees it. The warmth comes from never presenting
that grid as sharp square pixels: the beam spread does what real tubes did.

## 9. Presets, tuning, and verification

- **Implementation order:** engine substrate first (§1–§4), then look work
  (§5–§8), then tuning. Tuning afterglow before the units change is wasted
  work.
- **Presets:** the final tuned TV look is captured as a static template on
  each class — `Trinitron.presets.tv`, `ShadowMask.presets.tv` (frozen
  options objects; callers clone via `Object.assign({}, presets.tv, …)`).
  tv.html's `makeRenderer` boots from them, so the tuned look lives in the
  renderer files and a future viewer imports the same object. Hero options
  stay bespoke in `index.html` (only the persistence value converts: `0.82`
  → `persistenceHalfLifeMs: 58`, plus the rowShimmer pre-seed removal).
- **Tuning session:** on the bench, channel by channel (including CH 7's
  pass criterion), both renderers, ending with "copy state diff" →
  transferred into the presets.
- **Verification:** Playwright screenshots of both renderers × both pages
  (`tv.html` channels 2–7; hero `/` and `/?crt=shadow-mask`, light + dark);
  bench FPS meter showing `idle` on static channels and content-rate on
  animated ones; reduced-motion still renders the single post-warmup frame;
  bypass unaffected.
- **CLAUDE.md:** update the effect inventory (−3 cut, +2 new: Trinitron
  16 → 15, ShadowMask 14 → 13), persistence units, the scheduler/idle
  contract, presets, and the CH 7 dial.

## Out of scope (this round)

- The drop-in viewer component, its API (`tuneTo(clip)`), and video-element
  signal sources (`requestVideoFrameCallback` is the anticipated frame
  source; the §3 scheduler is shaped to accept it).
- Chassis extraction / de-duplicating the peer files (Approach B — deferred
  to the viewer spec, when a real consumer shapes the seam).
- Channel-change choreography beyond the existing 150 ms snow interstitial.
- Non-integer display scaling and its moiré mitigation; resolution changes;
  fullscreen/sprite-scale usage.
- Audio. Interlace flicker is rejected permanently, not deferred (30 Hz
  flicker is the record-skip of this medium).

## Risks

- **8-bit trail posterization:** visible banding in long decays. Mitigated by
  the half-LSB bias; verified on CH 5/CH 7 motion. Escape hatch if banding is
  objectionable: opportunistic RGBA16F when `EXT_color_buffer_float` is
  present (kept out of scope unless the bench proves it necessary —
  single-path RGBA8 is the goal).
- **Peer-file drift:** every engine change lands twice. Bounded by the bench
  (schema-driven UI shows divergence immediately) and the verification
  matrix.
- **Scheduler regressions on the hero:** the hero must behave exactly as
  before (always-animated). Guarded by the back-compat dirty contract
  (`undefined` = animated) and hero screenshot checks.
