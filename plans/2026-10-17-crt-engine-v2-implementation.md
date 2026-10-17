# CRT Engine v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a new CRT engine for the Mirepoix demo. The tube is evaluated at the display's real pixels in linear light, with a brightness-dependent beam and an aperture grille that is independent of the signal grid and anti-aliased. WebGL2 is the core backend and WebGPU adds HDR. tv.html and the `/` hero move onto it, and the v1 renderers are retired.

**Architecture:** One chassis file (`docs/crt.js`: options, effect schema, presets, scheduler, sizing, sources, bench API) drives a pluggable backend object. Phase 1 ships `docs/crt-webgl2.js`, phase 2 adds `docs/crt-webgpu.js`. The GPU pipeline runs four steps:

1. **Persist** (signal res): decode, apply max-decay afterglow, write RGBA16F.
2. **H-beam** (signal res): horizontal beam filter and convergence.
3. **Glow chain** (from the H-beam output, reduced res).
4. **Screen** (output res, straight to the canvas): vertical beam reconstruction, grille, damper shadow, glow add, grade, glass, tone, gamut, encode.

**Tech Stack:** Plain JS (IIFEs that attach to `window`), WebGL2 + GLSL ES 3.00, WebGPU + WGSL, no build step. Tests are an in-browser harness under `tests/` (outside the Pages root), driven by the Playwright MCP.

**Spec:** `specs/2026-10-17-crt-engine-v2-design.md`

## Global Constraints

- No toolchain: no package.json, no bundler, no npm deps. Engine files are plain scripts in `docs/`. Tests live in `tests/` and are never deployed.
- Signal contract unchanged: `signal(ctx, timeMs, needsRepaint)`; returning `false` means "nothing new".
- Performance contract: idle when static, content-rate when animated, halted offscreen, one static frame under reduced motion.
- Performance floor: 60 fps at full quality on nexus's integrated Radeon (Chromium) at a ~1200×900 CSS px screen at DPR 2.
- The constructor throws an Error whose message matches `/unavailable/i` when WebGL2 or float rendering (`EXT_color_buffer_float`) is missing. Callers fall back (hero to SVG, tv.html to bypass).
- Anti-goal: nothing cartoonish. Curvature defaults to 0, vignette and gloss are subtle, no steady-state flaws. Punctuation effects and interactive glass are not built.
- Grille pitch: `triads = min(triadTarget, outputWidthPx / minPxPerTriad)` (Chris, 2026-10-17).
- `docs/trinitron.js` and `docs/shadow-mask.js` are deleted once the hero is on v2. `?crt=shadow-mask` and `window.__trinitronLogo` go with them; `window.__crt` stays.
- Commits: one logical unit each, trailer per session attribution. Work on branch `crt-v2`; nothing is merged to `main` without Chris (main deploys Pages).

## Review Focus

1. **Canvas resized or moved to a different-DPR monitor mid-run.** Expect the backing to re-fit at exact device pixels and the triad count to recompute, with no stretched or blurry frame. Test in Task 1 (sizing) and Task 4 (triad recompute on resize).
2. **A very small canvas** (e.g. 160×120 CSS at DPR 1). Expect no NaN/black output, at least 1 triad, and the beam still energy-preserving. Test in Task 4.
3. **A video that isn't ready yet, or is paused.** Expect no upload of an empty frame (no black flash), and a parked renderer while paused that wakes on play. Test in Task 7.
4. **Theme toggle mid-warmup / stop-start on the hero.** Expect the trail to be cleared and warmup to restart, never a ghost of the previous session. Test in Task 11.
5. **WebGPU init failing after HDR was detected.** Expect `CRT.create` to fall back to WebGL2 on the same canvas, because no `webgpu` context is acquired before the device exists. Test in Task 12.

---

## File structure

| File | Responsibility |
|---|---|
| `docs/crt.js` | `class CRT` chassis: options/effects defaults, `CRT.effectSchema`, `CRT.presets`, `CRT.math` (pure helpers), sizing (ResizeObserver, device-pixel box), scheduler, context-loss, signal sources (`CRT.VideoSource`), bench API (`readParam`/`writeParam`/`stateDiff`/`requestRender`), adaptive quality, async `CRT.create()` factory, backend registry `CRT.backends`. |
| `docs/crt-webgl2.js` | `CRT.backends.webgl2`: GLSL programs, textures/FBOs, per-frame pass execution, readback for tests. |
| `docs/crt-webgpu.js` | (phase 2) `CRT.backends.webgpu`: WGSL port of the same passes, HDR canvas configuration. |
| `docs/tv.html` | Bench: moves to v2; RENDERER knob = CRT / bypass (+ backend positions in phase 2); new channels; size control. |
| `docs/media/tv-sample.mp4` | ≤ 400 KB self-generated 16:9 test clip (ffmpeg). |
| `docs/index.html` | Hero migration (Task 11). |
| `tests/crt/index.html`, `tests/crt/harness.js`, `tests/crt/*.test.js` | In-browser test harness + suites. |
| `tests/crt/perf.html`, `tests/crt/perf-server.py` | Real-GPU performance probe (headless Chromium with GPU → POST results). |
| `CLAUDE.md` | Renderer section rewritten around v2 (Task 11, amended Task 13). |

### Chassis ↔ backend interface (fixed here; both backends implement it)

```js
// Created by the chassis: backend = CRT.backends.webgl2.create(canvas, chassisCtx)
// Throws Error(/unavailable/i) on missing capability, before mutating anything.
{
  kind: 'webgl2' | 'webgpu',
  hdr: boolean,                                  // true only for the WebGPU extended-range canvas
  outputColorSpace: 'srgb' | 'display-p3',
  resize(outW, outH),                            // device px backing; reallocates output-res state
  setSignalSize(w, h),                           // reallocates signal-res + glow textures
  upload(source, fit),                           // source: CanvasImageSource; fit: {scale:[sx,sy], offset:[ox,oy]} in signal UV
  render(frame),                                 // frame: FrameParams (below)
  clearPersistence(),
  readPixels(),                                  // tests only: Uint8Array RGBA of the last frame, top row first
  destroy(),
}
// FrameParams (built by the chassis each frame from opts/effects/time):
{ decay, uploadedThisFrame, warmup /*0..1*/, uniforms /* flat object of every shader uniform value */, quality /*0..2*/ }
```

`uniforms` is produced by one chassis function, `CRT.prototype._uniforms()`, so both backends get identical values. The backends only map names to GPU slots.

---

## Phase 1: the v2 engine on WebGL2

### Task 0: Branch and test harness

**Files:**
- Create: `tests/crt/harness.js`, `tests/crt/index.html`, `tests/crt/README.md`

**Interfaces:**
- Produces: global `test(name, fn)` (fn may be async), `assert(cond, msg)`, `assertNear(actual, expected, tol, msg)`. `window.__results = { done: boolean, passed: n, failed: n, failures: [{name, message}] }`. The page loads `../../docs/crt.js`, `../../docs/crt-webgl2.js`, then every `*.test.js` listed in index.html. `?only=<substring>` filters tests by name.
- Produces: `tests/crt/util.js` exports globals `makeCRT(opts)` (offscreen-sized canvas appended to the body, `pixelSize` set) and `srgbToLinear(v8)`.

- [ ] **Step 1:** `git switch -c crt-v2`.
- [ ] **Step 2:** Write the harness with one sanity test (`harness: sanity` → `assert(true)`) and `util.js`.
- [ ] **Step 3:** Serve the repo root (`python3 -m http.server 8765` from the repo, in the background), open `http://127.0.0.1:8765/tests/crt/` with the Playwright MCP, and evaluate `window.__results`. Expected: `{done:true, passed:1, failed:0}`.
- [ ] **Step 4:** In README.md, record the run recipe (serve the repo root, open the URL, read `__results`; `?only=`), including that headless Playwright WebGL2 is SwiftShader: correct but slow, so it suits correctness checks, not performance.
- [ ] **Step 5:** Commit `tests: in-browser harness for CRT v2`.

### Task 1: Chassis skeleton, math, sizing, scheduler

**Files:**
- Create: `docs/crt.js`
- Test: `tests/crt/math.test.js`, `tests/crt/scheduler.test.js`

**Interfaces:**
- Produces: `class CRT { constructor(canvas, opts) }` with `opts.signalSize: [640, 480]` (the signal grid; any aspect), `opts.backend` ('webgl2' default in the sync constructor), test-only `opts._backendFactory(canvas, chassisCtx)` (lets the scheduler tests inject a fake backend), and test-only `opts._exposure` (linear gain at decode; default 1).
- Produces: `CRT.math`:
  - `triadCount(outW, target, minPxPerTriad) → integer ≥ 1`
  - `decay(dtMs, halfLifeMs) → number` (0 when halfLife ≤ 0 or on the first frame)
  - `srgbDecode(v)` / `srgbEncode(v)`, scalar and sign-mirrored for extended range
  - `stripeCoverage(t0, t1, phase, duty) → fraction in [0,1]` (the box-filter integral, below)
  - `maskStrengthLimit(L, H, a, s) → s_eff`
  - `fitContain(srcW, srcH, dstW, dstH)` / `fitCover(...)` → `{scale:[sx,sy], offset:[ox,oy]}`
- Produces: public methods `start()`, `stop()`, `requestRender()`, `destroy()`, `renderFrame(timeMs) → dirty` (synchronous, used by tests), `resize()`, `readParam(opt)`, `writeParam(opt, v)`, `stateDiff()`, plus fields `_mode`, `_frameCount`, `effects`, `opts`.
- Sizing: `opts.pixelSize: [w,h]` (device px) overrides everything. Otherwise use a ResizeObserver on the canvas with `devicePixelContentBoxSize` when supported, falling back to `round(contentRect × devicePixelRatio)`. On change, call `backend.resize` and `requestRender()`.

Box-filter integral of a periodic stripe (period 1 triad, lit for `duty` starting at `phase`):

```js
// I(t) = ∫_0^t box = floor(u)*duty + min(fract(u), duty), with u = t - phase
// coverage(t0,t1) = (I(t1) - I(t0)) / (t1 - t0)
```

Mask strength limited by headroom (unclipped stripes, brightness preserved). The stripe profile normalized to average 1 is `P/a`; mixing it with flat by `s` gives peak `L·(1 + s(1/a − 1))`; requiring peak ≤ H:

```js
s_eff = clamp(min(s, (H / max(L, 1e-4) - 1) / (1 / a - 1)), 0, s)
```

- [ ] **Step 1: Write the failing tests.**
  - `math.test.js`:
    - `triadCount(2400, 560, 3) === 560`; `triadCount(1200, 560, 9) === 133`; `triadCount(10, 560, 9) === 1`.
    - `decay(58, 58) ≈ 0.5` (±1e-9); `decay(0, 58) === 1`; `decay(10, 0) === 0`.
    - `srgbEncode(srgbDecode(0.5)) ≈ 0.5`; `srgbDecode(2.0) > 4`.
    - `stripeCoverage(0, 1, 0, 0.25) ≈ 0.25`; `stripeCoverage(0.1, 0.2, 0, 0.25) === 1`; `stripeCoverage(0.3, 0.4, 0, 0.25) === 0`; `stripeCoverage(0.2, 0.3, 0, 0.25) ≈ 0.5`.
    - `maskStrengthLimit(1, 1, 0.3, 1) === 0`; `maskStrengthLimit(0.2, 1, 0.3, 1) === 1`; `maskStrengthLimit(1, 3, 0.3, 1) > 0.8`.
    - `fitContain(1920,1080,640,480)` gives `scale[0] === 1` and `scale[1] ≈ 0.75`.
  - `scheduler.test.js` (fake backend):
    - `static signal parks`: signal returns `false` after its first paint; `start()`; wait `persistenceHalfLifeMs*8 + 200` ms; expect `_mode === 'idle'`.
    - `requestRender wakes`: from idle, `requestRender()` makes `_mode === 'running'`.
    - `stop clears intent`: after `stop()`, `requestRender()` keeps `_mode === 'stopped'`.
    - `animated never parks`: signal returns `undefined`; after 600 ms `_mode === 'running'`.
    - `needsRepaint after restore`: the fake backend's simulated restore makes the next signal call receive `needsRepaint === true`.
    - `pixelSize honored`: `opts.pixelSize [300,200]` → the fake backend's `resize` was called with `(300,200)`.
- [ ] **Step 2:** Run with `?only=math` and `?only=scheduler`. Expected: FAIL (CRT undefined).
- [ ] **Step 3:** Implement `docs/crt.js`.
  - Port the scheduler, reduced-motion, IntersectionObserver and context-loss hooks from v1 `trinitron.js:1505-1645` (same semantics; the settle tail is `halfLife × 7.994` when persistence is on).
  - Context loss is delegated: the chassis listens for `webglcontextlost`/`restored` and asks the backend factory to rebuild.
  - Effects/opts defaults are listed in Task 4/5/6 Interfaces; this task defines the objects with every key, even if no shader reads it yet.
- [ ] **Step 4:** Run both suites. Expected: all pass.
- [ ] **Step 5:** Commit `crt v2: chassis, math, sizing, scheduler`.

### Task 2: WebGL2 backend: signal upload, persistence, minimal screen pass

**Files:**
- Create: `docs/crt-webgl2.js`
- Test: `tests/crt/pipeline.test.js`

**Interfaces:**
- Consumes: the chassis↔backend interface; `CRT.math`.
- Produces: `CRT.backends.webgl2.create(canvas, ctx)`. It requires `EXT_color_buffer_float`, otherwise it throws `Error('WebGL2 float rendering unavailable')`.
- Signal texture: `SRGB8_ALPHA8` (hardware decode, so filtering happens in linear). Use `LINEAR_MIPMAP_LINEAR` plus `generateMipmap` only when the source is larger than the signal (video). Set `gl.unpackColorSpace = opts.signalColorSpace` when the property exists.
- Persist pass (signal res, RGBA16F ping-pong): sample the signal through the fit transform (black outside), then `out = max(live, prev * decay)` (instant attack, exponential release). Converting from the signal's color space to linear sRGB happens here (P3→sRGB matrix when `signalColorSpace === 'display-p3'`).
- Minimal screen pass (output res): bilinear-sample the persist texture, `srgbEncode`, write. This is replaced in Task 3.
- `readPixels()` reads the default framebuffer immediately after `render()` in the same task.

- [ ] **Step 1: Write failing tests** (real WebGL2):
  - `gray round-trips`: a flat `rgb(128,128,128)` signal; the output centre pixel is within ±3 of 128.
  - `instant attack`: black for frame t=0, white at t=16; the output at t=16 is ≥ 250.
  - `half-life release`: white through t=100, then black; at `t = 100 + halfLife` the linear output ≈ 0.5 (±0.04) after decoding.
  - `throws when float rendering missing`: stub `getExtension('EXT_color_buffer_float')` to return null; the constructor throws, message matches `/unavailable/i`.
- [ ] **Step 2:** Run `?only=pipeline`. Expected: FAIL.
- [ ] **Step 3:** Implement. One compile/link helper; a uniform-location cache keyed by name, so `render(frame)` sets `frame.uniforms` generically.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `crt v2: WebGL2 backend — linear-light persistence`.

### Task 3: The beam: horizontal filter and brightness-dependent vertical profile

**Files:**
- Modify: `docs/crt-webgl2.js`, `docs/crt.js` (opts/schema)
- Test: `tests/crt/beam.test.js`

**Interfaces:**
- Opts (defaults; final values come from tuning in Task 10):
  - `beamMin: 0.22`, `beamMax: 0.48`, `beamShape: 0.6` (all in scanline units)
  - `focusPx: 0.6` (horizontal σ in signal px, the "sharper than physical" cheat)
  - `convergence: { r: [-0.25, 0], g: [0, 0], b: [0.25, 0] }` (signal px, X only)
- Effects: `beam` (on; off = flat rows, no scanline structure), `convergence` (on).
- H-beam pass (signal res, RGBA16F): a per-channel Gaussian along x with σ_h = `max(focusPx, triadFloorPx)`, where `triadFloorPx = 0.42 × signalW / triads` (Task 4 supplies `triads`; until then use 0). Use 2.5σ support with weights computed in the shader (σ up to ~6 px means ≤ 31 taps; loop bound 32). Each channel samples at `x + convergence[c].x`.
- Screen pass, vertical reconstruction:

```glsl
// sy = output pixel centre in scanline units; rows j = floor(sy-0.5)-1 .. +2 (4 rows)
// For each row j and channel c:
//   Lc   = hbeam(x, j).c                       // linear
//   sig  = mix(beamMin, beamMax, pow(Lc, beamShape))
//   sigE = sqrt(sig*sig + pxInLines*pxInLines/12.0)   // box-filter AA of the gaussian
//   w    = exp(-0.5*dy*dy/(sigE*sigE)) / (sigE * 2.5066283)
//   sum.c += Lc * w
// Effect 'beam' off → sum = bilinear hbeam (flat rows).
```

`pxInLines` = scanline units per output pixel (signalH / outH).

- [ ] **Step 1: Write failing tests** (pixelSize 1280×960, signal 640×480, grille effect off, glow off):
  - `energy preserved`: flat linear 0.25 field; the mean decoded output over the centre 200×200 is within ±5% of 0.25.
  - `bright lines swell`: two halves at linear 0.1 and 0.9. Measure the FWHM of one scanline's vertical luminance profile (normalized to its own peak) in each half; expect bright FWHM ≥ 1.3 × dim FWHM.
  - `no vertical aliasing when lines are small`: flat 0.5 field at pixelSize 640×720 (signal 640×480 → 0.67 lines/px); the per-row mean output has a coefficient of variation < 3%.
  - `focus floor`: a 1-px vertical white line with `focusPx 0.6`; the horizontal FWHM of the output line is ≥ 1 signal px (≥ 2 output px here).
- [ ] **Step 2:** Run `?only=beam`. Expected: FAIL.
- [ ] **Step 3:** Implement the H-beam pass and the screen-pass reconstruction.
- [ ] **Step 4:** Run `?only=beam` and `?only=pipeline` (gray round-trip may need its tolerance applied over a region mean instead of a single pixel, since scanline structure now exists: the mean of the centre 64×64 within ±4 of 128). Expected: PASS.
- [ ] **Step 5:** Commit `crt v2: brightness-dependent beam profile`.

### Task 4: The aperture grille

**Files:**
- Modify: `docs/crt-webgl2.js`, `docs/crt.js`
- Test: `tests/crt/grille.test.js`

**Interfaces:**
- Opts: `triadTarget: 560`, `minPxPerTriad: 3`, `stripeFill: 0.8` (fraction of each third that is phosphor), `maskStrength: 1.0`, `maskFilter: 1.25` (footprint width in output px), `headroom: 1.0` (SDR; phase 2 raises it).
- Effect: `grille` (on).
- The chassis computes `this._triads = CRT.math.triadCount(outW, triadTarget, minPxPerTriad)` on every resize (and on `writeParam` of either input) and passes `uTriadsAcross`, plus `triadFloorPx` to the H-beam pass (Task 3 interface).
- Screen pass, per channel `c`:
  - `t = outX / triadPx`, with footprint `[t − f/2, t + f/2]`, `f = maskFilter / triadPx`.
  - `P_c = coverage(t0, t1, phase_c, duty)`, with `duty = stripeFill/3` and `phase_c = c/3 + (1 − stripeFill)/6`.
  - `a = duty`.
  - `s_eff = maskStrengthLimit(L_c, headroom, a, maskStrength)`, where `L_c` is the post-beam value.
  - `out_c = L_c * mix(1, P_c / a, s_eff)`.
  - Effect off → `out_c = L_c`.

- [ ] **Step 1: Write failing tests:**
  - `white line reads white`: black signal, 1-px white column at x=320, pixelSize 1280×960. Sum each channel's linear energy over a ±8 output-px window around the line on 40 rows; each channel's share of the total is in [0.27, 0.40].
  - `crosshatch not colored`: the same with a 1-px column at each of x = 100, 101, 102 (three separate renders); every render passes the share test above.
  - `no moiré at fractional pitch`: flat 0.3 field at pixelSize 1333×1000 with `triadTarget` chosen so that `triadPx ≈ 3.37`. The per-triad-window mean luminance across the width has a CV < 2%.
  - `fractional DPR sizes`: for pixelSize widths 800, 1000, 1200, 1500 at 4:3, each passes the CV < 2% check and has no NaN or zero-sum rows.
  - `white stays white in SDR`: flat linear 1.0 → mean decoded output ≥ 0.93, and max/min across one triad ≤ 1.15 (mask eased).
  - `midtones show stripes`: flat linear 0.15 → max/min of the green channel across a triad ≥ 2.
  - `triad floor`: pixelSize 1200×900, `minPxPerTriad 9` → the chassis reports `_triads === 133`.
  - `tiny canvas`: pixelSize 160×120 renders, has no NaN (all output bytes defined; the centre is non-black for a white signal), and `_triads ≥ 1`.
  - `resize recomputes`: pixelSize changes 2400→1200 with `minPxPerTriad 9` → `_triads` changes 266→133.
- [ ] **Step 2:** Run `?only=grille`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run all suites. Expected: PASS. (Task 3's energy test runs with the grille off; add `energy preserved with grille` here: flat 0.25 with the grille on, mean within ±6%.)
- [ ] **Step 5:** Commit `crt v2: anti-aliased aperture grille with headroom-limited mask`.

### Task 5: Glow, damper wires

**Files:**
- Modify: `docs/crt-webgl2.js`, `docs/crt.js`
- Test: `tests/crt/glow.test.js`

**Interfaces:**
- Opts: `bloomStrength: 0.25`, `bloomRadius: 1.0`, `halationStrength: 0.06`, `halationRadius: 1.0`, `damperWires: [0.32, 0.68]` (fractions of height), `damperStrength: 0.12` (fraction of light removed under a wire), `damperWidthPx: 1` (output px).
- Effects: `bloom` (on), `halation` (on), `damperWires` (on).
- Glow chain from the H-beam texture:
  - Downsample with a dual-filter (Kawase) chain to 1/2, 1/4, 1/8, 1/16 of signal res (RGBA16F).
  - Upsample back. Bloom = the 1/2 level after upsampling from 1/4; halation = the 1/16 level upsampled.
  - Radius params scale the dual-filter sample offsets.
  - At `quality ≥ 1` the chain starts at 1/4; at `quality 2` halation is skipped.
- Glow is added **after** the grille (it's light in the glass, unmasked): `out += bloom·bloomStrength + halation·halationStrength`.
- Damper wires are a multiplicative shadow `1 − damperStrength · coverage(row footprint, wire line)` at `y = frac × outH`, AA'd over the output pixel's footprint.

- [ ] **Step 1: Write failing tests:**
  - `bloom lights the dark`: black field with a 40×40 white patch; a pixel 6 output px outside the patch edge is > 0 (decoded linear > 0.005) with bloom on, and ≤ 0.001 with bloom and halation off.
  - `halation is wide`: the same patch; a pixel 60 px away is > 0 with halation on and ≈ 0 with it off.
  - `damper wire shadow`: flat linear 0.8 field; the mean of the output row at `round(0.32·outH)` is between (1 − damperStrength − 0.05) and (1 − damperStrength/2) times the mean of the rows ±10 away.
  - `quality 2 skips halation`: with `_quality = 2`, the halation-only far-pixel test reads ≈ 0.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run all suites. Expected: PASS (earlier suites set bloom/halation off where they measure exact energy).
- [ ] **Step 5:** Commit `crt v2: bloom, halation, damper wires`.

### Task 6: Color, glass, warmup

**Files:**
- Modify: `docs/crt-webgl2.js`, `docs/crt.js`
- Test: `tests/crt/color.test.js`

**Interfaces:**
- Opts:
  - Grade: `gradeTemperature: 0.3`, `gradeSaturation: 1.08`. Same gains mapping as v1, `[1 + 0.03t, 1, 1 − 0.05t]`, applied in linear.
  - Tone: `shoulderStart: 0.8` (SDR soft knee: values above it compress smoothly toward 1).
  - Glass: `vignette: 0.12`, `cornerRadius: 0.035`, `curvature: 0`, `gloss: 0.03`.
  - Output: `outputColorSpace: 'auto'` ('auto' = `display-p3` when `matchMedia('(color-gamut: p3)')` and `drawingBufferColorSpace` is assignable; else `srgb`).
- Effects: `colorGrade`, `vignette`, `tubeCorners`, `curvature` (off), `gloss`, `warmup`.
- Order in the screen pass:
  1. Beam.
  2. Grille.
  3. Damper wires.
  4. + glow.
  5. Grade (saturation may push outside sRGB; kept signed).
  6. × warmup brightness (v1's smoothstep over 1200 ms; the color settle reuses v1's math: extra temperature `0.5(1−k)`, saturation × `(0.85 + 0.15k)`).
  7. Vignette.
  8. + gloss. The analytic soft highlight is an ellipse at (0.3, 0.2) UV, Gaussian falloff, added in linear.
  9. Corners SDF mask.
  10. Tone shoulder applied to `max(rgb)`, preserving hue (headroom-aware: the knee scales with `headroom`).
  11. Linear sRGB → linear P3 matrix if the output is P3.
  12. Clamp ≥ 0.
  13. sRGB encode.
- Curvature: cylindrical X warp of the screen-pass UV, v1 formula (`trinitron.js:179-192`), off by default.

- [ ] **Step 1: Write failing tests:**
  - `shoulder never hard-clips`: a horizontal sRGB ramp 0→255 with `_exposure: 2` (linear 0→2), with grille, glow and beam off. The decoded output is monotonic non-decreasing along x, and the last 10% of the ramp still varies (max − min > 0.01).
  - `corners are dark`: output pixel (1,1) is 0 with `tubeCorners` on.
  - `warmup ramps`: `renderFrame(0)` mean < 0.1 × `renderFrame(1500)` mean on a flat white field (after `start()` resets the warmup origin).
  - `grade warm`: with temperature 1 on a flat gray field, mean R > mean B.
  - `p3 output selected when available`: stub `matchMedia('(color-gamut: p3)')` → matches; the backend reports `outputColorSpace === 'display-p3'`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run all suites. Expected: PASS.
- [ ] **Step 5:** Commit `crt v2: color grade, P3 output, soft shoulder, glass, warmup`.

### Task 7: Video source

**Files:**
- Modify: `docs/crt.js`, `docs/crt-webgl2.js`
- Create: `docs/media/tv-sample.mp4`
- Test: `tests/crt/video.test.js`

**Interfaces:**
- Produces: `new CRT.VideoSource(videoEl, { fit: 'contain' | 'cover' })`, passed as `opts.source` (mutually exclusive with `opts.signal`). It implements:
  - `attach(crt)`: registers `requestVideoFrameCallback` (falling back to a `timeupdate`/RAF poll where rVFC is missing). Each new frame sets `pending` and calls `crt.requestRender()`.
  - `poll() → boolean`: true once per new frame, and only when `readyState ≥ 2`.
  - `element`, `width`, `height` (`videoWidth`/`videoHeight`).
  - `detach()`.
- The chassis: when `opts.source` is set, a frame is dirty iff `source.poll()`, the upload uses `source.element` with `fit = CRT.math.fitContain|fitCover(...)`, and no 2D canvas is involved.
- Clip: generated with ffmpeg as a 6 s, 854×480, 30 fps H.264 (yuv420p, `+faststart`) of `testsrc2` with a bold `drawtext` caption, ≤ 400 KB. Record the exact command in the commit message.

- [ ] **Step 1:** Generate the clip into `docs/media/` and check its size (`stat -c %s` ≤ 409600).
- [ ] **Step 2: Write failing tests:**
  - `letterbox`: video loaded, `fit: 'contain'`, one forced frame; the top 30 output rows are black (decoded < 0.01) and the centre is non-black.
  - `not ready means no upload`: before `loadeddata`, `poll()` is false and the output stays black (no garbage).
  - `paused parks`: after play → pause, the renderer reaches `_mode === 'idle'` within the settle tail + 300 ms; `play()` returns it to `running`.
- [ ] **Step 3:** Run. Expected: FAIL.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** Run all suites. Expected: PASS.
- [ ] **Step 6:** Commit `crt v2: direct video source with rVFC clock`.

### Task 8: Adaptive quality and the real-GPU performance check

**Files:**
- Modify: `docs/crt.js`
- Create: `tests/crt/perf.html`, `tests/crt/perf-server.py`
- Test: `tests/crt/quality.test.js`

**Interfaces:**
- `_quality` ∈ {0, 1, 2}. While running and dirty, the chassis keeps an EMA of the RAF interval.
  - If the EMA exceeds `1.35 × the display's base interval` (measured over the first 30 frames) for 45 consecutive frames, step down a level.
  - Step back up after 600 frames under `1.05×`.
  - `opts.adaptiveQuality: true`.
  - Never touch the beam or grille.
- Perf page: renders an animated chart (moving bars + small text) at a fixed `pixelSize` from `?w=&h=`, warms up for 2 s, measures for 5 s, and POSTs `{fps, p95FrameMs, quality, renderer, w, h}` to `perf-server.py` (localhost only, writes JSON to a scratch path given as argv).

- [ ] **Step 1: Write failing test** `steps down under slow frames`: drive the EMA with injected intervals (test hook `_noteFrameInterval(ms)`); 45 intervals at 2× base → `_quality === 1`.
- [ ] **Step 2:** Run. Expected: FAIL. Implement. Run. Expected: PASS.
- [ ] **Step 3:** Run the perf page in headless Chromium **with the GPU**. Launch `/usr/bin/chromium --headless=new --enable-gpu --ignore-gpu-blocklist --use-angle=vulkan --user-data-dir=<scratch> "http://127.0.0.1:8765/tests/crt/perf.html?w=2400&h=1800"` in the background, wait for the POST, then kill it. Confirm the reported renderer string is the Radeon iGPU (not SwiftShader). If Vulkan fails, try `--use-angle=gl`.
- [ ] **Step 4:** Expected: `fps ≥ 58` and `quality === 0` at 2400×1800. If it misses, profile (the screen pass dominates; reduce the H-beam σ cap or glow taps) and rerun until it passes. Record the numbers in the commit message.
- [ ] **Step 5:** Commit `crt v2: adaptive quality; perf probe (iGPU 2400×1800: <fps>)`.

### Task 9: tv.html on v2

**Files:**
- Modify: `docs/tv.html`

**Interfaces:**
- Consumes: `CRT`, `CRT.presets.tv`, `CRT.effectSchema` (groups → items → params; same shape as v1's, so the bench builder is reused), `CRT.VideoSource`.
- RENDERER knob positions: `crt`, `bypass` (URL `renderer=crt|bypass`; old `trinitron`/`shadow-mask` values map to `crt`).
- New channels, with the dial respaced to 9 positions over the same −120°…+120° sweep (30° steps, numbers 2–10):
  - **CH 8 LINES** (static): 1-px white verticals at 3 phases, a 1-px grid, and a beam-swell step chart (8 horizontal bands, linear 0.05→1.0).
  - **CH 9 MOCK APP** (animated, gentle): Mirepoix-like cards, a recipe title in bold, 11–13 px body text, ingredient checkboxes, an icon row. A slow list scroll plus a checkbox tick every 2 s. Painted at the signal grid.
  - **CH 10 VIDEO**: `docs/media/tv-sample.mp4` via `CRT.VideoSource`, muted, looped, `playsinline`.
- Size control in the bench header: screen CSS width 320 / 480 / 640 / 960 / 1280. The cabinet scales with a `--screen-w` custom property, and the canvas's CSS size follows (the engine re-fits by itself).
- Remove the `trinitron.js`/`shadow-mask.js` script tags from tv.html (the hero still loads them until Task 11).

- [ ] **Step 1:** Implement the migration and the channels.
- [ ] **Step 2: Verify** with Playwright MCP screenshots of every channel at 640 and 1280 widths:
  - **CH 4:** crosshatch lines read white/grey, not red/green.
  - **CH 7:** the waterfall reads as translucent shimmer through the CRT and as hard stripes on bypass.
  - **CH 8:** the beam-swell bands visibly thicken from dim to bright.
  - **Idle meter:** reads `fps: idle` on CH 2/3/4/8 and a number on CH 5/6/7/9/10.
  - **Fallback:** forcing a WebGL2 failure (`?renderer=crt` with a `getContext` stub injected via evaluate before load) lands on bypass with the honest readout.
- [ ] **Step 3:** Commit `tv.html: move the bench to CRT v2; LINES, MOCK APP, VIDEO channels; size control`.

### Task 10: Tuning pass

**Files:**
- Modify: `docs/crt.js` (`CRT.presets.tv`)

- [ ] **Step 1:** On the bench, tune channel by channel at 640 and 1280 widths (and 400 for phone-like): beam min/max/shape, focus, triad target and min size, stripe fill, glow, damper, grade. The look target is the spec's anti-goal: a good tube, restrained, glowing. Judge from screenshots at device scale 2.
- [ ] **Step 2:** Re-run the full test suite (presets must not break tests; the tests pin their own opts).
- [ ] **Step 3:** Transfer the values via "copy state diff" into `CRT.presets.tv`, with a dated comment.
- [ ] **Step 4:** Commit `crt v2: first tuning pass of presets.tv`.

### Task 11: Hero migration, v1 retirement, docs

**Files:**
- Modify: `docs/index.html`, `CLAUDE.md`
- Delete: `docs/trinitron.js`, `docs/shadow-mask.js`

**Interfaces:**
- `CRT.presets.hero`: an opaque substrate, `triadTarget = round(layout.width / 3)` (set by the caller), and a softer beam (the logo is not a TV picture). Tuned against the v1 hero screenshots.
- `createTrinitron(layout)` keeps its name and flow but constructs `new CRT(canvas, {...presets.hero, signal, signalSize:[layout.width, layout.height]})`. `window.__crt` is set. The `?crt=` branch and `__trinitronLogo` are removed, and the `.trinitron-active` class hook is kept (CSS depends on it).

- [ ] **Step 1:** Take baseline screenshots of the v1 hero (`/` dark, explicit `data-theme="dark"`, 1280×800 at DPR 2) for comparison.
- [ ] **Step 2:** Migrate and tune `presets.hero`.
- [ ] **Step 3: Verify:**
  - `/` light, dark (explicit), and dark via OS preference (`emulateMedia colorScheme: dark`, no attribute).
  - The theme toggle starts and stops the engine (`__crt._mode` goes `running` ↔ `stopped`).
  - Toggling twice in under 1.2 s restarts warmup with no ghost frame (Review Focus 4): add a harness test `stop/start clears trail`, where white → `stop()` → `start()` → black signal → `renderFrame(16)` decodes < 0.01.
  - WebGL2 forced unavailable → the static SVG shows.
  - The full test suite passes.
- [ ] **Step 4:** `git rm docs/trinitron.js docs/shadow-mask.js`; grep `docs/` for `Trinitron(`, `ShadowMask`, `__trinitronLogo` and `crt=shadow-mask`; expect no matches.
- [ ] **Step 5:** Rewrite CLAUDE.md's file layout and "CRT renderers" sections around v2: chassis/backends, the pipeline, the grille rule, the scheduler, tests/ and the perf probe, retired v1 conventions. History stays in `specs/`.
- [ ] **Step 6:** Commit in two units: `hero: migrate to CRT v2; retire v1 renderers`, then `CLAUDE.md: document CRT v2`.

## Phase 2: WebGPU backend + HDR

### Task 12: WebGPU backend and `CRT.create`

**Files:**
- Create: `docs/crt-webgpu.js`
- Modify: `docs/crt.js`
- Test: `tests/crt/webgpu.test.js`

**Interfaces:**
- `CRT.create(canvas, opts) → Promise<CRT>` (async factory). With `opts.backend: 'auto' | 'webgl2' | 'webgpu'` (default 'auto'):
  - 'auto' tries WebGPU only when `matchMedia('(dynamic-range: high)')` matches and `navigator.gpu` exists.
  - It acquires the adapter and device **before** calling `getContext('webgpu')`. On any failure it constructs WebGL2 on the same canvas.
  - The URL override `?crtBackend=webgl2|webgpu` wins.
- `CRT.backends.webgpu.createAsync(canvas, ctx)`:
  - WGSL ports of the persist, H-beam, glow-chain and screen passes. Uniforms come from `_uniforms()` packed into one uniform buffer in a fixed order, which is declared once in `crt-webgpu.js` and asserted against the key list at init.
  - Canvas config: `format: 'rgba16float'`, `colorSpace: 'display-p3'`, `toneMapping: {mode: 'extended'}`, `alphaMode: 'opaque'`. `hdr` = `getConfiguration().toneMapping.mode === 'extended'`.
  - Usage includes `COPY_SRC` when `opts._testReadback`.
- HDR: when `backend.hdr`, the chassis sets `uniforms.headroom = opts.hdrHeadroom` (default 3.0, tuned on the iPhone). The shoulder becomes a soft roll-off toward `headroom`, so stripes keep full mask strength up to `headroom` (the Task 4 formula with `H = headroom`).

- [ ] **Step 1: Write failing tests** (skipped with a visible "SKIP: no WebGPU adapter" when `requestAdapter()` is null):
  - `parity`: for CH 8-like and flat-field signals at 640×480 pixelSize, the WebGL2 and WebGPU (SDR, headroom 1) readbacks differ by ≤ 3/255 mean absolute and ≤ 12/255 max.
  - `fallback`: stub `requestAdapter` → null; `await CRT.create(..., {backend:'auto'})` with `(dynamic-range: high)` stubbed true yields `backend.kind === 'webgl2'`.
- [ ] **Step 2:** Find a headless WebGPU adapter on nexus. Launch `/usr/bin/chromium --headless=new --enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan` (try with and without `--use-webgpu-adapter=swiftshader`) against `tests/crt/?only=webgpu`, POSTing results through `perf-server.py`. Record which flags give an adapter. If none do, parity is verified by hand on the iPhone (Task 13) and this is recorded in the commit.
- [ ] **Step 3:** Implement. Run. Expected: `fallback` PASS everywhere; `parity` PASS where an adapter exists.
- [ ] **Step 4:** Commit `crt v2: WebGPU backend with HDR extended-range output`.

### Task 13: Bench and hero use HDR

**Files:**
- Modify: `docs/tv.html`, `docs/index.html`, `CLAUDE.md`

**Interfaces:**
- tv.html: RENDERER knob positions `crt` (auto via `CRT.create`), `crt-gl`, `crt-gpu`, `bypass`. The readout shows the active backend and `HDR ×<headroom>` or `SDR`. An `hdrHeadroom` slider appears in the bench when `backend.hdr`.
- Hero: `createTrinitron` switches to `await CRT.create(...)`, so iPhones get HDR phosphor in dark mode. The existing `try/catch` → SVG fallback stays.

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** Verify on nexus: `crt` resolves to WebGL2 (no adapter here), and the full suite and screenshots are unchanged.
- [ ] **Step 3:** Serve the branch over the tailnet (`tailscale serve --bg --https=18765 http://127.0.0.1:8765`) for Chris's iPhone check of tv.html (CH 4, 8, 9, 10) and `/` in dark mode. The readout should say `HDR`. Remove the mapping afterwards.
- [ ] **Step 4:** CLAUDE.md: add the backend selection, HDR, and `CRT.create` notes.
- [ ] **Step 5:** Commit `tv.html + hero: HDR via CRT.create`; push branch `crt-v2` (not main).

---

## Handoff

The branch `crt-v2` is pushed to origin. Merging to `main` deploys Pages (including the hero change), so it waits for Chris. On-device HDR acceptance (Task 13, Step 3) is Chris's eyes.
