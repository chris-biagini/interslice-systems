# CRT Engine v2 — Linear Light, a True Grille, and HDR — Design

**Date:** 2026-10-17
**Status:** Approved by Chris in-session, 2026-10-17.
**Scope:** a new CRT engine (WebGL2 core + WebGPU HDR backend), `docs/tv.html` as its bench, the `/` hero's migration to it, retirement of `docs/trinitron.js` + `docs/shadow-mask.js`, `CLAUDE.md`
**Prior art:** `2026-06-11-crt-warmth-and-engine-hardening-design.md` (parent: scheduler, half-life persistence, presets, the "flaws only as punctuation" rule, and the deferred drop-in viewer this round grows out of); `2026-06-10-crt-effect-axes-and-tv-page-design.md` (effect schema, the bench)

## Intent

The CRT renderer is going onto the **Mirepoix marketing pages**, playing a demo of the app. It sits where a marketing page would put its hero video: prominent and video-sized. Its job is to stop people scrolling. They should feel the glow, the glass, and the "oh, that's a *real* TV" moment, and the content should still read clearly.

The demo itself will be a **stylized animation** of the app, a high-level view rather than a screen recording, and ideally drawn live in the page rather than shipped as a video file. That animation is a **separate, later project** (see "Out of scope"). This document covers the engine it will play on. Chris noted that page placement and animation detail both depend on what the engine turns out to be able to carry. So the engine has to be judged on its own first: how it performs at different sizes and how much detail it resolves.

**Quality bar:** super performant, super accurate, and with a wow factor prior art lacks. Accuracy serves delight. Where a true simulation would hurt legibility or look worse on common displays, we take creative license.

## The anti-goal: cartoonish

> "This should just *look like a CRT*, not bonk you over the head with giant bubbly tube distortion and things like that. We should strive to display good taste, as true aficionados of good CRTs." (Chris)

In practice:

- The reference is a **well-adjusted, good tube**: a nice consumer Trinitron or a broadcast monitor. It is not a dying TV or a movie-prop CRT.
- **Every steady-state effect must be something a healthy tube actually does.** That means the grille, the beam's shape, glow and halation, afterglow, the damper wires, and slight misconvergence. Heavy barrel curvature, strong vignetting, rolling bars, noise, chromatic smear and flicker are out.
- **The wow comes from fidelity and light, not exaggeration.** The HDR glow is the headline precisely *because it's true*: a lit phosphor really was that bright against its dark grille.
- The June rule carries over unchanged: *fix every flaw we can; only "laws of physics" flaws remain; flaws are allowed as punctuation, never as steady state.*

## The walking version, and why this round goes further

Per fleet policy, here is the simplest thing that would put a demo on a page today. Take `Trinitron.presets.tv`, feed a `<video>` into the existing `signal()` callback via `requestVideoFrameCallback`, and show it in a fixed 640×480 card. That's roughly 50 lines on top of what exists.

It falls short in four ways that matter for this use:

1. **The grille is locked to the source pixels.** In today's phosphor pass (`subX = mod(px.x, cellSize)` at signal resolution), each signal column *is* one R, G or B stripe. A 1-px white line comes out as a single colored stripe. That's visible as red/green grid lines on CH 4's crosshatch, and it's why `phosphorCoupling` (a cheat) exists. Small text and fine UI suffer most, which is exactly what an app demo contains.
2. **All light math happens in gamma-encoded space.** Beam spread, persistence and bloom blend sRGB-encoded values, so whites look flat rather than glowing.
3. **Scanlines are a fixed-depth cosine.** A real beam swells when bright and thins when dark. That brightness-dependent profile is the single strongest "real CRT" cue, and it's missing.
4. **It only looks right at one size.** Stripes are nearest-neighbor upscaled, so any non-integer scale gives uneven stripes and moiré. A responsive marketing page can't avoid non-integer scales (phones are 3×, many laptops are 1.25× or 1.5×).

The walking version stays useful as a **stopgap**. If a Mirepoix page needs something before v2 lands, it's available. It is not the deliverable.

## Evidence: the device probe (2026-10-17)

A throwaway probe page (outside the repo) was opened on Chris's two judging screens and in the browsers on nexus:

| | iPhone 17 Pro, Safari 27 | Chromium 152, nexus | Firefox 155, nexus |
|---|---|---|---|
| WebGPU | ✅ | ⚠️ the API exists, but no GPU is available to it | ❌ none |
| HDR canvas (brighter than page white) | ✅ **confirmed by eye**: 2×, 4×, 8× white all glow above page white | ❌ | ❌ |
| HDR grille test (RGB stripes at 3× linear) | ✅ **reads as bright white with the stripes still visible** | — | — |
| WebGL2 with a P3 drawing buffer | ✅ | ✅ | ✅ |
| WebGL2 float render targets (`EXT_color_buffer_float`) | ✅ | ✅ | ✅ |
| WebGL2 float *canvas* (`drawingBufferStorage`) | ❌ | ✅ | ❌ |
| `requestAnimationFrame` rate | ~60 (on a 120 Hz panel) | 120 | ~60 (on a 120 Hz panel) |
| GPU | Apple | Ryzen 9800X3D **integrated** Radeon (radeonsi, "raphael") | hidden (Firefox anti-fingerprinting) |
| `(dynamic-range: high)` / `(color-gamut: p3)` | true / true | false / false | false / false |

The judging screens are:

- **Dell S2725QS.** 27" 4K, 120 Hz, 350 nits, sRGB, no meaningful HDR. Hyprland drives it at scale 2 in plain sRGB at 8 bits. This is the **SDR judge** and, through Chromium's integrated GPU, the **performance floor**.
- **iPhone 17 Pro.** XDR OLED, P3, DPR 3. This is the **HDR judge**.

What the evidence settles:

- **HDR requires WebGPU.** Neither Safari's nor Chrome's WebGL2 can produce brighter-than-white output (Safari has no float canvas; Chrome's has no extended tone-mapping mode). The probe's `rgba16float` + `display-p3` + `toneMapping: {mode: 'extended'}` configuration is what worked.
- **WebGL2 must be the core everyone gets.** Neither browser on Chris's desktop can run WebGPU here, and the Interslice hero already steers visitors toward Firefox.
- **Two backends are therefore earned rather than speculative.** (An earlier read in this session, that "WebGPU buys little," was right for SDR and wrong about HDR's value; the probe overturned it.)
- **Linear light and P3 are available on the core path**, because every browser tested has float render targets and a P3 drawing buffer.
- **Don't count on 120 Hz.** Safari caps page animation near 60 fps by default, and Firefox did the same here.
- **HDR headroom is unknown at runtime.** iOS changes it with brightness, Low Power Mode and ambient light, and no web API reports it. The HDR path must degrade gracefully into clipping rather than assume a fixed multiplier.

## Constraints

- **No toolchain.** Plain JS and inline/peer files, no build step, no new dependencies, as before. The one consequence: shaders are written twice, GLSL for WebGL2 and WGSL for WebGPU. There is no transpiler without a toolchain.
- **Devices:** the two judging screens above, plus evergreen browsers generally. The June device floor (respectable on a ~2020 mid-range phone; clean fallback below that) still applies.
- **Performance contract (carried over):** fully idle when static, content-rate when animated, halted when offscreen. A decorative effect costs ~zero when it isn't visibly doing anything.
- **Performance floor:** smooth on nexus's integrated GPU in Chromium at the largest size a marketing page would plausibly use (Dell at scale 2, so a ~1200 CSS px wide screen is ~2400 device px).
- **No WebGL2 at all:** the caller shows the content plain, with no tube. With Chris's blessing, there are no legacy software paths.

## Architecture

### Three layers

1. **Signal: what's on the air.** The content paints a frame at the **signal resolution**. The engine never knows whether that frame came from a live animation, a video, or a test chart.
2. **Tube: the physics.** This turns the signal into emitted light at the **display's real pixel grid**: beam, grille, phosphor afterglow, glow, glass.
3. **Output: the screen it's shown on.** It encodes that light for the display: SDR sRGB or P3, or HDR extended range.

The structural change from v1 is that **the tube is evaluated at output resolution, not signal resolution.** The signal grid and the grille grid become independent. That one change fixes defects 1 and 4 above.

### Signal layer

- **Contract unchanged:** `signal(ctx, timeMs, needsRepaint)`, returning `false` for "nothing new." The tv.html channels and a future live animation plug in as they do today.
- **Direct sources, new:** the engine also accepts a `<video>` (or another texture source) uploaded straight to a texture, with `requestVideoFrameCallback` as the frame clock. That skips the 2D-canvas hop for video.
- **Signal resolution** stays a parameter, default **640×480**, the June bench-tuned grid (~DVD/S-Video resolving power). It is a property of the *broadcast*, not the screen size.
- **Aspect-agnostic.** 4:3 and 16:9 Trinitrons both existed. The engine takes whatever aspect the signal has, and the animation project picks.
- **Color space:** the signal canvas may be created in `display-p3` (Canvas 2D supports this), so content can paint colors outside sRGB. The engine needs to know which space the signal is in to decode it correctly.

### Tube layer, in linear light

All tube math happens in **linear light**. The signal is decoded on sampling, and nothing blends gamma-encoded values.

- **Beam reconstruction.** For each output pixel, find the nearest signal scanlines and sum their contributions under a **vertical Gaussian beam profile whose width grows with that line's brightness, per channel**. Bright lines swell and nearly fill the gap; dark lines are thin with visible black between them. Horizontally, the beam is a bandwidth-limited reconstruction of the signal row. **Permitted cheat:** horizontal focus may be sharper than a physical tube's, for legibility.
- **The aperture grille.** Continuous vertical R/G/B stripes (Trinitron: no vertical structure except the damper wires). The pitch is set by two values, and both are tuned on the bench:
  - **A target triad count across the picture**, so a big screen reads as "a TV of a given size" rather than "a pixel pattern".
  - **A minimum triad size in device pixels, so the stripes stay visible everywhere** (Chris's decision, 2026-10-17). In effect, `triads = min(target, displayWidthPx / minPxPerTriad)`. A large display gets the full count. A small one (the iPhone hero at ~1200 device px) gets fewer, chunkier stripes, like a real small TV seen up close. The phone keeps the HDR "dark stripes, glowing light" look. The accepted cost is slightly softer fine detail on small screens, which the stylized animation is expected to tolerate.
  - **Anti-aliased by construction.** Each output pixel takes the grille's average over its own footprint (an analytic box-filter integral of the stripe profile), so non-integer pitches don't moiré. Because the minimum size keeps triads above a few device pixels, the grille never needs to fade away. The anti-aliasing exists for clean fractional pitches, not as an escape hatch.
- **SDR brightness strategy.** A grille throws away a large share of the light (to be measured on the bench, not assumed). In SDR, we cheat it back the way tubes effectively did: **bright regions bloom across the stripes** (the mask's darkness eases with intensity), plus a soft highlight shoulder rather than a hard clip. The stripes stay clearly visible in midtones and darks, which is where the eye looks for them.
- **Phosphor afterglow.** The half-life-in-ms model carries over, now in linear light. It needs float storage (`RGBA16F`; available everywhere tested) or it will band. Whether afterglow is stored at signal or output resolution is left to the builder: signal resolution is cheaper and, for a temporal effect, visually equivalent.
- **Glow, as two distinct phenomena.** **Bloom** is the near-field spread of bright phosphor. **Halation** is the wide, faint haze from light scattering inside the faceplate glass. Both are in linear light, at reduced resolution.
- **Kept from v1, restrained:** damper wires (visible on bright fields, as in life), slight horizontal-only misconvergence, warmup with color settle, color grade, tube corners.
- **Glass:** flat face by default. Curvature stays available but off (the June tuning chose flat; the anti-goal confirms it). Vignette and gloss are subtle at most.

### Output layer

- **SDR** (WebGL2, phase 1): a P3 drawing buffer when the display supports P3, otherwise sRGB. Final encode plus the soft shoulder above.
- **HDR** (WebGPU, phase 2): `rgba16float` / `display-p3` / `toneMapping: extended`, enabled when `(dynamic-range: high)` matches *and* the configured canvas reports `extended`. **The stripes stay at full grille darkness, and the lit phosphor is driven above page white**, as the probe's grille row showed. Because headroom is unknown, peak gain is a tunable `headroom` option (default chosen on the iPhone) with a soft roll-off into whatever the display actually clips at. Too much requested headroom must look like a slightly compressed highlight, never a hard plateau.

### Two backends, one chassis

- One JS **chassis** is shared by both backends: options and effect schema, the scheduler (idle/settle/stopped, intersection observer, reduced motion, context-loss recovery), signal handling, presets, and the bench API (`readParam`/`writeParam`/`stateDiff`/`requestRender`).
- Two **backends** implement the same passes: WebGL2 (GLSL) and WebGPU (WGSL). The chassis picks one: WebGPU when HDR is available, otherwise WebGL2. A URL/option override can force either for testing.
- **Parity:** in SDR, both backends must render the same picture. The bench gets a backend switch, and a verification step compares screenshots.

### Scheduler (carried over, extended)

The June contract stands: running, settling, idle, stopped; `false` from the signal means static; the settle tail is ~8 half-lives. **Added:** `requestVideoFrameCallback` as an alternative frame clock for video sources.

**Adaptive quality:** the engine measures frame time and steps down cost when over budget. What it may never drop is the beam and the grille, because those *are* the tube. The degradation order otherwise (halation resolution, bloom taps, afterglow resolution, …) is left to the builder.

### Punctuation candidates (opt-in only)

There are two candidate "moments": a **degauss** wobble/purity swirl on power-up, and the **power-off collapse** to a horizontal line and then a dot. Both are true CRT behavior, and both are exactly the kind of thing that turns cartoonish if overused. They ship **off by default** as explicit, callable triggers (e.g., `powerOn({degauss: true})`, `powerOff()`), never fired automatically by scroll or visibility. Whether the Mirepoix page uses either is decided with the page.

Interactive glass (a gloss highlight that follows the cursor or the phone's tilt) is a **candidate, not a commitment**. It's subject to the same taste test and is not built this round unless it survives a bench trial.

## The bench (`docs/tv.html`)

tv.html stays the tuning workbench and moves to v2. Additions:

- **Size and DPR controls**, so the screen can be rendered at arbitrary display sizes and pixel ratios. This is how the anti-aliasing and the minimum-triad-size floor get tuned.
- **New test charts:** a 1-px line/grid chart (white lines must read white), a beam-swell chart (luminance steps, so line width is visibly brightness-dependent), a small-text legibility chart, and a **sample video channel** standing in for the future animation.
- **Backend switch** (WebGL2 / WebGPU) and an **HDR headroom** control when HDR is active.
- The existing channels stay, and **CH 7's dither pass criterion still applies.**
- The cabinet presentation may need to stop being a fixed 640×480 card so it can exercise sizes. Exact UI is left to the builder.

## Distribution

Build here, where the bench lives. The Mirepoix pages consume the engine by **vendoring a copy** of the file(s). Fleet policy says shared tools eventually live in their own public repo under the `interslice-systems` org. Extraction is a **later step**, once a second real consumer shapes the API. *(My call, Claude's.)*

## Phasing

1. **Phase 1: the v2 engine on WebGL2.** Linear light, beam reconstruction, the independent anti-aliased grille, SDR brightness strategy, afterglow, bloom and halation, P3 output, the scheduler with video frame clock, adaptive quality, the bench upgrades. Every screen gets this, including the Dell. **Phase 1 ends by migrating the `/` hero to v2 and deleting the v1 renderer files.**
2. **Phase 2: the WebGPU backend + HDR.** A port of phase 1's passes to WGSL plus the HDR output path, tuned on the iPhone. Phase 1 is built so this is a translation, not a redesign: light stays in linear float with an explicit headroom parameter that is 1.0 in SDR.

## Verification

- **Grille independence:** a 1-px white vertical line and a 1-px grid read **white** through the tube, not as single-channel stripes. CH 4's crosshatch shows no red/green grid lines.
- **Beam swell:** on the beam-swell chart, bright scanlines are measurably wider than dim ones (measured from a screenshot's vertical luminance profile).
- **No moiré at fractional scales:** headless Playwright screenshots at device scale factors 1, 1.25, 1.5, 2 and 3, at several screen sizes. No beat patterns in the grille, and stripes stay visible at small display sizes (the minimum triad size holds).
- **CH 7 dither:** waterfall stripes read as translucent shimmer through the tube and as hard stripes on bypass.
- **Hero migration:** `/` in light and dark (explicit `data-theme` both ways, plus the OS-preference path) looks right on v2. Start/stop follows the theme toggle, and with WebGL2 forced unavailable the static SVG fallback shows.
- **Scheduler:** the bench reads `fps: idle` on static channels; the hero-style always-animated case is unaffected; offscreen halts; reduced motion renders one static frame.
- **Backend parity (phase 2):** WebGL2 and WebGPU SDR screenshots match within a small tolerance.
- **HDR acceptance (phase 2): on-device only.** Chris's eyes on the iPhone, plus a report POST from the bench recording backend, headroom setting and configuration. A headless browser can't judge HDR, and the spec doesn't pretend otherwise.
- **Performance:** content-rate animation on nexus's integrated GPU in Chromium at the largest intended size, measured with the bench FPS meter and a DevTools trace.

## Docs

- **CLAUDE.md:** rewrite the renderer section around v2 (and the File layout list: v1 files gone, `?crt=shadow-mask` gone). Describe the current state plainly, move the history to the specs, and note which v1 conventions (peer-file copy-share, signal-locked `cellSize`, `stripeUpscale`, the gap-mask overlay, `phosphorCoupling`) are retired.
- This spec plus its plan replace the June spec as the "current" renderer design. The June spec stays as history.

## Out of scope

- **The live demo animation** (its own brainstorm and spec once the engine shows what it can carry). Carried note for that project: author for the tube. Use flat color and bold shapes, sit on the signal grid, choose the palette for the glow, and consider a P3 signal canvas.
- **A ShadowMask port** (see Chris's decisions).
- **WebAssembly.** Nothing here is CPU-bound once video bypasses the 2D canvas. (Rive's WebAssembly-based player is a candidate for the *animation* project, not the engine.)
- **Beam-racing / rolling-scan simulation** (the motion-clarity trick): it flickers, and interlace-style flicker was rejected permanently in June.
- **Audio, composite/RF artifacts, convergence drift, shimmer, breathing:** all still out.
- **The HTML-in-Canvas proposal** (drawing live DOM into the signal): worth checking for the animation project, not depended on.

## Settled during the builder check (Claude's calls)

A fresh reviewer read this draft as a would-be builder. These answers were settled without changing what gets built; each is Claude's call, open to Chris's override:

- **Performance floor frame rate:** **60 fps at full quality** on nexus's integrated GPU at the largest intended size. 120 fps is a bonus where it's available and cheap, never a requirement (Safari caps near 60 anyway). Adaptive quality may step down above the floor size.
- **Where backend parity is checked (phase 2):** the chassis gets a URL/option override to force either backend in SDR. Parity is checked on the iPhone (both backends, same chart, by eye plus Safari screenshots). The builder also tries a throwaway headless Chromium launch with a WebGPU software fallback adapter on nexus for automated diffs. If that won't run, parity is by hand on the iPhone. No machine-config changes on nexus are made for this.
- **HDR report path:** there's no POST from the public tv.html. The bench shows its backend, HDR configuration and headroom setting **on screen**. On-device acceptance is Chris's eyes plus a screenshot. If automated capture is wanted, it uses a dev-only tailnet serve like the 2026-10-17 probe, never anything baked into `docs/`.
- **What Mirepoix vendors:** the **engine class**, plus a small video-source helper (a `<video>` upload with the `requestVideoFrameCallback` clock). The June "viewer" API (`tuneTo(clip)`, channel-change choreography, the snow minimum-frames floor) moves to the **animation project**, where its real consumer will shape it.
- **Sample content:** the legibility stand-in is a **live-drawn "mock app" channel** on the bench: cards, small text and icons painted at the signal grid, roughly like Mirepoix UI. That tests the real case with no licensing or file-size problem. The video path is tested with a **small self-generated clip** (e.g., recorded from that channel), kept tiny because anything in `docs/` publishes.
- **White-line criterion scope:** "a 1-px line reads white" applies wherever the grille is visible, at the tuned pitch. The horizontal beam is never narrower than one triad, so the "sharper focus" cheat is bounded by that floor.
- **Punctuation effects and interactive glass:** **not in phases 1–2.** They're deferred to the animation/page project, which decides whether the Mirepoix page wants them.

## Chris's decisions (2026-10-17)

- **Grille on small screens:** stripes stay visible everywhere, via the minimum triad size (see "The aperture grille").
- **File fate:**
  - v2 arrives as a **new file** in `docs/` (the builder names it).
  - `docs/tv.html` moves to it entirely. The RENDERER knob becomes v2 / bypass (plus the WebGL2/WebGPU backend switch in phase 2).
  - **At the end of phase 1, the homepage hero on `/` migrates to v2.** That covers its always-animated signal, its light/dark start/stop wiring, its `window.__crt` handle and its WebGL2-missing fallback to the static SVG.
  - Once the hero is on v2, **`docs/trinitron.js` and `docs/shadow-mask.js` are deleted**, and `?crt=shadow-mask` and `window.__trinitronLogo` go away with them.
  - **ShadowMask is not ported.** Its hex-staggered dot triads would need their own anti-aliasing design, so any return would be a separate project.
