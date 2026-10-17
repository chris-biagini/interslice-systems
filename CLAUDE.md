# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`interslice-systems` is a single-page marketing site for a fictional 1980s/90s computing brand ("Interslice Systems, a wholly owned subsidiary of Nordyne Defense Dynamics"). It exists to point visitors at `mirepoix.recipes` — the actual app being built in a separate repo. This repo is intentionally jokey/experimental; risk tolerance here is higher than a customer-facing site would normally warrant.

The maintainer (Chris) frames this as a long-term "tender of documents" repo. Today it holds one document (the homepage); more will arrive over time.

## Build, run, deploy

- **No build step.** Plain HTML + CSS, served by GitHub Pages from `docs/` on `main`. Custom domain in `docs/CNAME` → `www.interslice.systems`. Any push to `main` that touches `docs/` auto-deploys.
- **Local preview**: open `docs/index.html` directly, or `python3 -m http.server -d docs 8000` if you need an HTTP origin.
- **No tests, no linters, no package manager.** Don't introduce a build step or toolchain without checking first — the "no toolchain" property is deliberate and load-bearing.

## File layout

- `docs/index.html` — the homepage. All page-specific CSS is **inlined** in one `<style>` block. Three `<script src="…">` tags (`crt.js`, `crt-webgl2.js`, `sprinkles.js`) and one inline `<script>` block at the bottom — all the JS the homepage loads (see "CSS-first, with documented JS exceptions" below).
- `docs/crt.js` (the chassis, class `CRT`) + `docs/crt-webgl2.js` (its WebGL2 backend) — the CRT engine v2 (see "CRT engine" below).
- `docs/media/tv-sample.mp4` — 299 KB self-generated test clip for tv.html's CH 10 (ffmpeg `testsrc2`; the command is in the commit that added it).
- `docs/sprinkles.js` — runtime sprinkle distribution (Mitchell's best-candidate, seeded). The second documented JS exception (see "CSS-first, with documented JS exceptions" below).
- `docs/tv.html` — unlisted dev/tuning page ("TV service bay"): a 4:3 CRT in a woodgrain console-TV cabinet. CHANNEL knob, CH 2–10: SMPTE bars, crosshatch, Interslice test card, motion reel, dead-channel snow, CH 7 "DITHER" (the Sonic-waterfall acceptance test: 1-px-column transparency must read as hard stripes on bypass and translucent shimmer through the CRT), CH 8 "LINES" (1-px verticals that must read white + beam-swell gray bands), CH 9 "MOCK APP" (Mirepoix-flavored UI — the legibility stand-in for the demo animation), CH 10 "VIDEO" (the sample clip through the direct video path). RENDERER knob (CRT / raw bypass), a screen-size control (320–1280 CSS px), and a schema-driven parameter bench below the set. Deep-linkable via `?ch=2..10&renderer=crt|bypass&size=320|480|640|960|1280` (v1's `renderer=trinitron|shadow-mask` map to `crt`); `?res=320` swaps the 640×480 signal grid for the old 320×240 comparison grid.
- `tests/crt/` — the engine's test harness (plain HTML/JS, outside `docs/` so it never deploys): `python3 tests/crt/run.py [filter]` runs it in headless Chromium and exits nonzero on failure; `perf.html` is the real-GPU performance probe; `peek.html` renders a fixed chart for screenshots. Recipes in `tests/crt/README.md`. Same inline-CSS / single-inline-script conventions as the homepage; deliberately outside the two-media theme system (fixed dark workshop, no `tokens.css`).
- `docs/tokens.css` — the canonical design-token sheet (colors, type, semantic vars). Imported by `index.html`. Anything reusable across future documents belongs here.
- `docs/logo_CMYK*.svg`, `docs/logo_RGBW*.svg` — the two-media logo (see "Two media" below).
- `docs/CNAME` — Pages custom-domain config.

When a new document arrives, follow the same split: token-level concerns go in `tokens.css`, page-specific styles inlined in that page's own `<style>` block.

## Architecture you can't get from a quick read

### Two media, not two themes

Light and dark mode are different *physical media*, not parallel color schemes:

- **Light = ink on paper.** Logo arms are CMY (cyan / magenta / yellow); halftone wash, Memphis sprinkles with stamped offset shadows, jewel-case-manual aesthetic.
- **Dark = a Trinitron arcade cabinet at night.** RGBW phosphor inside the logo silhouette, aperture grille + scanlines + glass-gloss + perimeter bloom; sprinkles get colored phosphor halos with co-prime flicker. Lean *more* electric, not less — "bodacious neon" is the target.

Don't unify the two — light arms stay CMY, dark stays RGBW phosphor. If a design drop recolors light-mode arms to match the dark-mode phosphor, that's a regression, not a simplification.

### Dark-mode triple activation

Three layered paths, in this order:

1. Explicit dark: `<html data-theme="dark">` or `.theme-dark` subtree.
2. Pin-to-light: `<html data-theme="light">` opts out of OS preference.
3. OS preference: `@media (prefers-color-scheme: dark)` fires only when *not* pinned to light.

Almost every dark-mode rule in `index.html` therefore appears twice — once for `[data-theme="dark"]` and once inside `@media (prefers-color-scheme: dark)` gated by `:root:not([data-theme="light"])`. Don't simplify away the duplication; it's how the theme toggle survives OS preference.

### Load-bearing token quirks

- `--stamp-ink` flips with theme (`--ink-0` in light, `--paper-0` in dark) so Memphis offset shadows and sticker outlines read against either background. New offset shadows must use `var(--stamp-ink)`, not a hardcoded near-black like `#0B0E1F`.

### CSS-first, with documented JS exceptions

Effects that *look* like JS — CRT scanlines, Memphis sprinkles, theme-aware content swaps, day/night taglines, sprinkle flicker — are all CSS, using `:has()`, `prefers-color-scheme`, `data-*` attribute selectors, custom-property switches, pseudo-elements with `content:`, sibling combinators, etc. Before reaching for JS for any new behavior, exhaust the CSS toolbox first.

The one place JS *is* load-bearing is the CRT engine — `docs/crt.js` + `docs/crt-webgl2.js` (see next section). It's a physical-model simulation — electron-beam profile, aperture grille, phosphor afterglow, glass glow, all in linear light at the display's real pixels — that CSS genuinely cannot do. Don't take this as license to bolt on more JS; the bar for new scripts is "CSS can't do this either, and here's why."

The second exception is `docs/sprinkles.js` — a small (~190 line) IIFE that runs Mitchell's best-candidate algorithm on page load and on debounced resize to distribute the Memphis sprinkles into the page's empty area, avoiding the legible content (motto, logo + wordmark, CTA, footer). Like the CRT engine, this is something CSS genuinely can't do: CSS has no way to read sibling elements' computed bounding rects, and the wordmark's responsive width (`clamp()`-driven font sizing) is the whole reason hand-authored sprinkle positions were clumping into it. The script writes inline `style.top` / `style.left` on each `.sprinkle` and clears `bottom` / `right`. Everything else about the sprinkles (size, rotation, color via `--glow`, flicker timing) stays authored in CSS. Seed is fixed; distribution is deterministic per viewport. Design: `specs/2026-05-22-sprinkle-distribution-design.md`. Plan: `plans/2026-05-22-sprinkle-distribution-implementation.md`.

### CRT engine (v2)

Design: `specs/2026-10-17-crt-engine-v2-design.md` (approved; the "current" renderer design). Plan + execution ledger: `plans/2026-10-17-crt-engine-v2-implementation.md`. Purpose: the renderer for the Mirepoix marketing pages' demo — accuracy serves delight; creative license where a true sim hurts legibility. **Anti-goal (Chris): nothing cartoonish** — a well-adjusted good tube, not a bubbly prop. Every steady-state effect must be something a healthy tube does; flaws only as punctuation (the June rule stands).

**Shape.** `docs/crt.js` is the chassis — class `CRT` — owning options, effects, `CRT.effectSchema`, `CRT.presets`, `CRT.math` (pure helpers, unit-tested), sizing, the scheduler, signal sources (`CRT.VideoSource`), adaptive quality and the bench API. GPU work lives in a backend registered on `CRT.backends` (`crt-webgl2.js` today; a WebGPU/HDR backend is phase 2 of the spec). Every backend gets identical uniform values from `CRT#_uniforms()` and implements the small interface documented on `CRT.backends`. `new CRT(canvas, opts)` throws an Error matching `/unavailable/i` when WebGL2 or `EXT_color_buffer_float` is missing — callers fall back (hero → static SVG, tv.html → bypass with `BYPASS (NO WEBGL2)`).

**The structural idea:** the tube is evaluated at the **display's real pixels, not the signal's**. The signal (default 640×480, any aspect; `signal(ctx, timeMs, needsRepaint)` contract unchanged from v1, or `source: new CRT.VideoSource(video)`) is the broadcast; the grille is a separate, finer pattern on the glass. That is what keeps a 1-px white line white (v1 turned it into a single colored stripe — `phosphorCoupling` was the cheat covering for it) and what makes any size/DPR work.

Per frame (WebGL2; textures are top-row-first "image orientation", only the screen pass flips):
1. **persist** (signal res, RGBA16F ping-pong): source decoded to linear (SRGB8_ALPHA8 texture → hardware decode; P3 signals converted), afterglow = `max(live, prev × decay)` — instant attack, exponential release, `persistenceHalfLifeMs` (frame-rate independent).
2. **hbeam** (signal res, MRT): horizontal beam Gaussian (`focusPx` — the "sharper than physical" legibility cheat — floored at ~one triad so 1-px features always span R, G, B) with X-only convergence; and it precomputes the **vertical beam** per scanline sample (A = L × unit-area peak, B = −1/2σ², σ growing with brightness, σ² widened by the pixel footprint + a Nyquist fade).
3. **mask** (output width × 1): the aperture-grille profile per column — closed-form box/tent pixel-filter integrals (both tile, so energy is exact and fractional pitches can't moiré).
4. **glow**: dual-filter (Kawase) chain over the afterglow — bloom (near) + halation (far).
5. **screen** (output res): vertical beam reconstruction (4 scanlines, `A·exp(dy²·B)` — **bright lines swell, dark lines thin**), grille mixed toward flat only as far as `headroom` demands (SDR: bright light blooms across the stripes instead of clipping; HDR: stripes stay dark), damper wires, + glow, grade, warmup, vignette/gloss/corners (curvature exists, off — good taste), hue-preserving soft shoulder, linear sRGB → P3 when the drawing buffer is wide-gamut, encode.

**Grille pitch rule (Chris, 2026-10-17):** `triads = min(triadTarget, outputWidthPx / (minPxPerTriad × DPR))` — the full count on big screens, chunkier stripes on small ones so the stripes stay visible everywhere. `minPxPerTriad` is in **CSS px** (CSS px track viewing size; device px don't). Consequence to remember: at phone sizes the triad count *is* the horizontal resolution (~128 at 320 CSS px), so content authored for 640 loses small type there.

**Sizing:** the backing store always equals the canvas's device-pixel box (ResizeObserver; the device-pixel box is trusted only when it agrees with CSS × DPR — `CRT.math.devicePixelSize`), re-measured on DPR changes. `opts.pixelSize` overrides (tests, perf).

**Scheduler (performance contract, unchanged from June):** idle when static (signal returns `false`, or a paused video), content-rate when animated, halted offscreen (IntersectionObserver), one static post-warmup frame under reduced motion; `_mode: 'stopped' | 'running' | 'idle'` (tv.html's `fps: idle`). Wake paths: `requestRender()` (also called by `writeParam`), visibility, `start()`, and the video's `requestVideoFrameCallback`. `stop()` clears intent; `start()` clears the trail and restarts warmup. Context loss rebuilds the backend and asks the signal to repaint (`needsRepaint: true`). **Adaptive quality** trims only the glow chain under sustained jank — never the beam or grille.

**Performance (measured 2026-10-17, nexus integrated Radeon via headless Chromium + ANGLE/Vulkan):** 2400×1800 ≈ 9.0 ms/frame median incl. ~2.5 ms readback-sync overhead; 3840×2160 ≈ 14 ms; 60 fps. Re-measure with `CRT_GPU=1 CRT_TEST_PAGE='tests/crt/perf.html?w=2400&h=1800' python3 tests/crt/run.py` (budget 12 ms; `&off=effect,…` to profile). `gl.finish()` does **not** wait for the GPU in Chrome — the probe syncs with a 1-px `readPixels`.

**Presets + bench.** `CRT.presets.tv` (tv.html; adds warmup to the class defaults, which hold the tuned healthy-tube look) and `CRT.presets.hero` (bezel-shaped: no engine corners/vignette/gloss, no grade so the substrate keeps the page navy, electric glow). Presets are frozen; pass them straight to the constructor (it clones). The bench renders from `CRT.effectSchema` (same shape as v1's) via `readParam`/`writeParam`/`stateDiff()` ("copy state diff" → transfer into the preset). There is no built-in `?debug=1` overlay in v2 — the bench and `window.__crt` replace it.

**Two consumers.**
- **The hero screen** (`canvas.hero-screen`, `docs/index.html`): logo + wordmark (+ laser grid, halftone dots) painted into the signal at the `.brand` layout size in CSS px (`signalSize: [layout.width, layout.height]`, `triadTarget ≈ layout.width / 3`). `createTrinitron(layout)` (name kept) rebuilds on layout change; theme `MutationObserver` + `prefers-color-scheme` drive `start()`/`stop()` and the `.trinitron-active` class (CSS hook name kept). `HERO_SUBSTRATE` is the true `--navy-0`: v2's grille conserves energy, so v1's ~3× pre-brightening is gone. The CTA stays live DOM below the canvas (not in the signal). `window.__crt` is the handle; `?crt=shadow-mask` and `window.__trinitronLogo` are gone.
- **The TV service bay** (`docs/tv.html`): boots from `CRT.presets.tv`; CH 10 rebuilds the engine with a `VideoSource` (signal ↔ direct video is a construction choice; rebuilt without warmup). Channel switches play ~150 ms of snow and wake a parked engine. Static channels let the scheduler park.

**Retired with v1 (don't reintroduce):** `docs/trinitron.js` + `docs/shadow-mask.js` (deleted 2026-10-17), the peer-file copy-share convention, signal-locked `cellSize` stripes, `stripeUpscale`, the gap-mask overlay, `phosphorCoupling`, the fixed-depth cosine scanlines, gamma-space blending, and the RGBA8 afterglow. ShadowMask is not ported (its dot triads would need their own anti-aliasing design — a separate project if ever). Still cut since June: `convergenceDrift`, `perRowShimmer`, `breathing`, interlace flicker.

**Next:** phase 2 of the spec — the WebGPU backend for HDR (iPhone-confirmed 2026-10-17: a WebGPU `rgba16float` / `display-p3` / `toneMapping: extended` canvas glows above page white; WebGL2 has no route to HDR in Safari or Chrome). Then the live-drawn demo animation, as its own brainstorm → spec.

## Working conventions

### Design drops vs. direct tweaks

Chris does design work in a separate Claude session (the `frontend-design` skill) that produces self-contained HTML+CSS drops. Those land here for **integration, not redesign**:

1. Identify what's actually new in the drop vs. boilerplate.
2. Translate hardcoded colors/type into existing tokens.
3. Preserve the triple-activation theme paths and the `--stamp-ink` shadow pattern.
4. Decide what to inline vs. promote into `tokens.css` (anything reusable goes into tokens).
5. Verify both themes (toggle `data-theme="dark"` on `<html>` in DevTools).
6. Surface a diff/summary before committing.

Direct tweaks (between drops) get the same care for design-system constraints — the design system is load-bearing prior art across drops, not per-drop scaffolding.

### Commits and pushes

Standing authorization to commit and push at reasonable points without asking each time. **Caveats:**

- The Claude Code harness blocks direct pushes to `main`, and also blocks an agent from writing its own `.claude/settings.local.json` permissions. Two routes around it: (a) suggest Chris paste `! git push origin main` into his next prompt (the `!` prefix runs it as him), or (b) ask him to add the push permission to `.claude/settings.local.json` himself once. As of writing it's already there.
- Commit coherent units, one logical change each. Use a `Co-Authored-By` trailer crediting whichever Claude model is actually driving the session (e.g. `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`) — don't copy a pinned model name from an older commit.
- Don't force-push, rewrite published history, or skip hooks. Each push to `main` redeploys Pages — usually a feature, sometimes a reason to wait.

### Verifying visual changes

Type-checking and grep don't catch broken layouts. For CSS/visual edits, open the page in a browser and check both themes — toggle via `<html data-theme="dark">` / `data-theme="light">` in DevTools, and verify the OS-preference path still works by removing the attribute entirely.

For engine edits the same rule applies, plus: run `python3 tests/crt/run.py` (must be green), open the page, check that the hero screen still looks correct, and verify the start/stop wiring on theme toggle. Judge the look at DPR 2 (Playwright `deviceScaleFactor: 2`) — at DPR 1 a 640-line signal on a ≤ 1280-px screen sits at the pixel Nyquist limit, where the beam deliberately fades scanlines. Screenshot crops at **device** scale: downscaled screenshots alias the grille into false color. DevTools handle: `window.__crt` (class `CRT`); exposes `.effects`, `.opts`, `writeParam(opt, v)` (sets + repaints), `requestRender()`, `_mode`, `_triads`, `_outSize`. Uniforms are rebuilt from `opts`/`effects` every frame, so `window.__crt.opts.X = Y; window.__crt.requestRender();` is enough — the poke matters on static channels where the scheduler parks.
