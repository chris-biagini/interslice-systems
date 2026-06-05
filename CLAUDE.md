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

- `docs/index.html` — the entire page. All page-specific CSS is **inlined** in one `<style>` block. Three `<script src="…">` tags (`trinitron.js`, `shadow-mask.js`, `sprinkles.js`) and one inline `<script>` block at the bottom — the only JS on the site (see "CSS-first, with documented JS exceptions" below).
- `docs/trinitron.js`, `docs/shadow-mask.js` — peer WebGL2 phosphor renderers (aperture-grille Trinitron and delta-triad shadow-mask). Trinitron is the default; `?crt=shadow-mask` URL param selects the alternative (see "CRT renderers" below).
- `docs/sprinkles.js` — runtime sprinkle distribution (Mitchell's best-candidate, seeded). The second documented JS exception (see "CSS-first, with documented JS exceptions" below).
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

The one place JS *is* load-bearing is the CRT phosphor renderers — `docs/trinitron.js` and `docs/shadow-mask.js`, peer files modeling an aperture-grille Trinitron and a delta-triad shadow-mask respectively (see next section). They're physical-model simulations — per-channel RGB decomposition, per-pixel persistence, convergence fringe, halo bleed — that CSS genuinely cannot do. Don't take this as license to bolt on more JS; the bar for new scripts is "CSS can't do this either, and here's why."

The second exception is `docs/sprinkles.js` — a small (~190 line) IIFE that runs Mitchell's best-candidate algorithm on page load and on debounced resize to distribute the Memphis sprinkles into the page's empty area, avoiding the legible content (motto, logo + wordmark, CTA, footer). Like the Trinitron, this is something CSS genuinely can't do: CSS has no way to read sibling elements' computed bounding rects, and the wordmark's responsive width (`clamp()`-driven font sizing) is the whole reason hand-authored sprinkle positions were clumping into it. The script writes inline `style.top` / `style.left` on each `.sprinkle` and clears `bottom` / `right`. Everything else about the sprinkles (size, rotation, color via `--glow`, flicker timing) stays authored in CSS. Seed is fixed; distribution is deterministic per viewport. Design: `specs/2026-05-22-sprinkle-distribution-design.md`. Plan: `plans/2026-05-22-sprinkle-distribution-implementation.md`.

### CRT renderers (Trinitron + ShadowMask)

`docs/trinitron.js` (class `Trinitron`) and `docs/shadow-mask.js` (class `ShadowMask`) are peer renderers — structurally the same shape, same WebGL2 init + bloom + composite + RAF scaffolding (~90% shared by file diff), differing in the phosphor pass and a handful of defaults. Both take a `<canvas>`, an options object, and a `signal(ctx, timeMs)` callback. Both are **GPU-only** — constructor requires `EXT_color_buffer_float` and `OES_texture_float_linear`; failure throws synchronously before mutating GPU state, so callers wrap construction in `try { … } catch` and fall through to a static SVG fallback. The two-file copy-share arrangement is intentional (per the spec) until a third renderer makes shared seams observable.

Each RAF tick it:

1. Lets the callback paint into a small 2D "signal" canvas, which is uploaded to a GPU texture.
2. Runs the phosphor pass: per-channel convergence offsets, optional anisotropic beam-spread blur, then a stripe-profile multiply (R lights at subX=0, G at 1, B at 2 for `cellSize: 3`) and a persistence lerp against the previous frame's MRT slot. Outputs phosphor (slot 0) + next-frame persistence (slot 1) in one pass.
3. Auxiliary bloom passes: bright-pass extraction, horizontal blur, vertical blur into a halo texture.
4. Composite pass: stripes + halo + optional gap-mask / scanlines / glass curvature / gloss / vignette, plus optional damper-wire bands and warmup / breathing modulators.

One consumer in `docs/index.html`:

- **The hero screen** (`canvas.hero-screen`): a single bounded Trinitron display that holds both the rotating arms+hub logo and the "interslice·systems" wordmark. Signal callback paints a near-black CRT substrate, then rasterized SVG of the rotating logo, then `fillText` of the wordmark in three weight-split parts. The live `<h1>` wordmark stays in the DOM and accessibility tree but goes `color: transparent` in dark mode so it doesn't double-paint. A `MutationObserver` on `data-theme` plus a `prefers-color-scheme` listener toggles `start()` / `stop()` to drop animation cost in light mode. The canvas is sized to the `.brand` wrapper (logo + wordmark, + a 16px halo margin per side), so the screen tracks that block's live layout. The CTA (caption + `mirepoix.recipes` link + Firefox sub) is deliberately **not** in the screen: `.cta-wrap` is a sibling of `.brand` *below* the canvas, live DOM in both themes — the CMYK paper button in light mode, a magenta/cyan neon marquee in dark mode (page-specific `.cta` rules in `index.html`, triple-activation). It used to be rasterized into the signal; that whole subsystem (CTA constants, the `captureCRTTextLayout`/`paintCRTText` helpers, the `data-crt-text`/`data-crt-element` "blank the live element" convention, and the per-channel CTA interactivity gating) was removed when the screen was tightened to logo + wordmark.

The renderer is *option-driven*: same code, different look. The hero screen uses `cellSize: 3` (contiguous-triad `[R, G, B]` layout — no source-pixel gap column; aperture-grille shadows come from the `gapMask` overlay alone), opaque substrate, contained halo, `viewSize: [layout.width, layout.height]`.

The **WebGL2-unavailable fallback** is the static SVG `.m-dark` layer in the markup — the hero's `try { new (Trinitron|ShadowMask)(…) } catch` swallows the failure silently and the SVG (which is always in the DOM, hidden by CSS only when `.trinitron-active` is set on `<html>`) keeps rendering the dark-mode logo. The previously-existing CPU canvas path and `renderer: 'auto'` option have been removed; there is no software fallback inside either renderer itself.

**Renderer selection (`?crt=shadow-mask`).** Default is Trinitron. The hero's `createTrinitron(layout)` reads `?crt=` from the URL and dispatches to either class with appropriate hero options. Both expose `window.__crt` as the active-renderer handle; `window.__trinitronLogo` is a back-compat alias set *only* when Trinitron is active (so `__trinitronLogo` is `undefined` under `?crt=shadow-mask`).

**ShadowMask shader gotcha (load-bearing).** The shadow-mask phosphor pass tiles the canvas with rectangular hex-staggered cells; each cell holds a *triad* — three small round dots (R top-left, G top-right, B bottom-center) — all lit by the signal sampled once at the cell center. The cell is the spatial unit of one image pixel, like a real shadow-mask CRT where the three guns converge on a co-located R/G/B phosphor cluster. Dot size is `dotRadius` in source pixels (replaces the earlier `maskFrac` option); `phosphorCoupling` is the Trinitron cross-talk cheat ported over (each dot also emits the other two channels at this fraction, so a pure-white signal reads as white at each dot rather than one-channel-tinted).

**The signal must be sampled at the cell center**, not at the fragment's `vUv`. Per-fragment sampling lets vector edges slice triads into bright/dim halves at the source-vector boundary — the "stained glass illuminated by flashlights" effect. Trinitron's continuous-along-Y stripes don't have this problem (no discrete element boundary to violate), so per-fragment sampling is fine there.

Don't reintroduce one-color-per-cell with `colorIdx = (col - row) mod 3` and a Voronoi nearest-neighbor lookup (the architecture this replaced). That scattered R/G/B phosphors across the lattice; in uniform color regions only 1/3 of cells lit and same-color cells formed visible 45° diagonals — a chromatic "slash" on the red logo lobe. Triad-per-cell is brighter (every cell lit), reads closer to a real CRT, and is cheaper per fragment.

The GPU pipeline is a three-pass setup (signal upload → phosphor/persistence → composite) plus three auxiliary bloom passes. Trinitron's 16 effects (`stripeProfile`, `phosphorCoupling`, `convergence`, `convergenceDrift`, `persistence`, `perRowShimmer`, `beamSpread`, `damperWires`, `selectiveBloom`, `gapMask`, `scanlines`, `curvature`, `gloss`, `vignette`, `warmup`, `breathing`) are togglable at runtime via `window.__crt.effects`; ShadowMask shares the same set minus `damperWires` and `gapMask` (neither applies to a delta-triad shadow-mask). Add `?debug=1` to either URL to expose a per-effect override panel; combine as `?debug=1&crt=shadow-mask`. Design / plan history: `specs/` and `plans/` directories — Trinitron consolidation in `2026-05-22-hero-trinitron-*`, vertical-resolution refactor in `2026-05-24-trinitron-vertical-resolution-*`, ShadowMask design and implementation in `2026-05-24-pc-crt-shadow-mask-*`.

One memory entry still applies as a "leave it alone, this is the look I want" — the gap-mask striations bleeding into the Trinitron halo. The older cell-grid memory was inverted by the vertical-resolution refactor and again scoped by the ShadowMask build: don't reintroduce the dot/cell pattern into `trinitron.js` (it stays continuous vertical stripes); the dot pattern lives in `shadow-mask.js` instead.

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
- Commit coherent units, one logical change each. Use the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Don't force-push, rewrite published history, or skip hooks. Each push to `main` redeploys Pages — usually a feature, sometimes a reason to wait.

### Verifying visual changes

Type-checking and grep don't catch broken layouts. For CSS/visual edits, open the page in a browser and check both themes — toggle via `<html data-theme="dark">` / `data-theme="light">` in DevTools, and verify the OS-preference path still works by removing the attribute entirely.

For renderer edits the same rule applies, plus: open the page, check that the hero screen still looks correct, and verify the start/stop wiring on theme toggle. Check both `/` (Trinitron) and `?crt=shadow-mask` (ShadowMask). DevTools handle: `window.__crt` is the active renderer (either class); exposes `.effects` and `.opts`. Live-tune via `window.__crt.opts.X = Y; window.__crt._uploadStaticUniforms();`. `window.__trinitronLogo` is a back-compat alias, set only under `/` (the Trinitron path).
