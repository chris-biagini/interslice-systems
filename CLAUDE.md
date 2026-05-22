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

- `docs/index.html` — the entire page. All page-specific CSS is **inlined** in one `<style>` block. One `<script src="trinitron.js">` tag and one inline `<script>` block at the bottom — the only JS on the site (see "CSS-first, with one documented JS exception" below).
- `docs/trinitron.js` — phosphor renderer (CPU canvas path + WebGL2 GPU path). Load-bearing for the hero screen (see "Trinitron renderer" below).
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
- The `.sneak__tape` yellow-sticker element deliberately pins to `--ink-0` directly (not `--stamp-ink`) — yellow needs dark contrast in both themes. If you spot this pattern, leave it.
- The `.mcrt` widget has a CRT-hardware sub-palette (`--crt-green`, `--crt-amber`, `--crt-screen-deep`, `--crt-bezel*`, ...) that is **theme-invariant** — phosphor green inside the widget intentionally does not flip in dark mode.

### CSS-first, with one documented JS exception

Effects that *look* like JS — CRT scanlines, Memphis sprinkles, theme-aware content swaps, day/night taglines, sprinkle flicker — are all CSS, using `:has()`, `prefers-color-scheme`, `data-*` attribute selectors, custom-property switches, pseudo-elements with `content:`, sibling combinators, etc. Before reaching for JS for any new behavior, exhaust the CSS toolbox first.

The one place JS *is* load-bearing is the Trinitron phosphor renderer (see next section). It's a physical-model simulation of an aperture-grille CRT — per-channel RGB stripe decomposition, per-pixel persistence, convergence fringe, halo bleed — that CSS genuinely cannot do. Don't take this as license to bolt on more JS; the bar for new scripts is "CSS can't do this either, and here's why."

### Trinitron renderer

`docs/trinitron.js` defines a single `Trinitron` class. It takes a `<canvas>`, an options object, and a `signal(ctx, timeMs)` callback. Each RAF tick it:

1. Lets the callback paint into a small offscreen "signal" canvas.
2. Bakes stationary damper-wire bands into the signal (optional).
3. Creates three per-channel pre-shifted copies for convergence.
4. Runs one fused per-output-pixel pass: sample → persistence lerp → multiply by stripe profile (R lights at subX=0, G at 1, B at 2 for `cellSize: 3`) → per-cell hotspot + shimmer → write.
5. Blurs the original signal into a separate canvas for the halo bleed.
6. Composites bleed under stripes, optional blur on top, optional gap mask via `source-atop`.

One consumer in `docs/index.html`:

- **The hero screen** (`canvas.hero-screen`): a single bounded Trinitron display that holds both the rotating arms+hub logo and the "interslice·systems" wordmark. Signal callback paints a near-black CRT substrate, then rasterized SVG of the rotating logo, then `fillText` of the wordmark in three weight-split parts. The live `<h1>` wordmark stays in the DOM and accessibility tree but goes `color: transparent` in dark mode so it doesn't double-paint. A `MutationObserver` on `data-theme` plus a `prefers-color-scheme` listener toggles `start()` / `stop()` to drop animation cost in light mode.

The renderer is *option-driven*: same code, different look. The hero screen runs on the **GPU path** (`renderer: 'auto'` with automatic CPU fallback on WebGL2 context failure), `cellSize: 4`, opaque substrate, contained halo, big aperture-grille mask, `viewSize: [800, 320]`.

The GPU pipeline is a three-pass setup (signal upload → phosphor/persistence → composite) plus three auxiliary bloom passes. All 18 effects are togglable at runtime via `window.__trinitronLogo.effects`. Add `?debug=1` to the URL to expose a per-effect override panel in the top-right corner. The spec and implementation plan live in `specs/2026-05-22-is2200-gpu-trinitron-design.md` and `plans/2026-05-22-is2200-gpu-trinitron-implementation.md`.

There are two memory entries about deliberate aesthetic choices in this renderer — gap-mask striations bleeding into the halo, and the per-cell hotspot/shimmer texture. Both are "leave it alone, this is the look I want" entries. Don't refactor either away as accidental.

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
- Commit coherent units, one logical change each. Use the trailer `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- Don't force-push, rewrite published history, or skip hooks. Each push to `main` redeploys Pages — usually a feature, sometimes a reason to wait.

### Verifying visual changes

Type-checking and grep don't catch broken layouts. For CSS/visual edits, open the page in a browser and check both themes — toggle via `<html data-theme="dark">` / `data-theme="light">` in DevTools, and verify the OS-preference path still works by removing the attribute entirely.

For Trinitron-renderer edits the same rule applies, plus: open the page, check that the hero screen still looks correct, and verify the start/stop wiring on theme toggle. DevTools handles: `window.__trinitronLogo` (the hero screen, GPU renderer — also exposes `.effects`).
