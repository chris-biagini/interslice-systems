# Hero Trinitron — design

## Goal

Replace the IS-2200 sneak-preview card with a single Trinitron display that holds **the logo + the "interslice·systems" wordmark together** as one phosphor image in dark mode. Light mode is unchanged.

Strategically, this also establishes the building block for a later laser-grid effect: a defined Trinitron screen field with a real edge that vector content can cross into (and re-rasterize through phosphor on entry). The laser grid is deferred to a follow-up spec.

## What changes

### Visible (dark mode)

- The hero stack (logo + wordmark) becomes a single rectangular phosphor field — a bounded Trinitron screen, edgeless (no bezel), with halo contained inside the canvas rectangle.
- The rotating colored hub still spins inside the logo; persistence smears it into a soft motion trail (as today).
- The wordmark renders as monochrome phosphor text (off-white / cream) within the same screen.
- The CTA ("Visit our new web-site! / mirepoix.recipes") stays as HTML *below* the screen on the page background — unchanged.
- The IS-2200 sneak-preview card below the hero is removed entirely.

### Visible (light mode)

No change. Logo SVG mark + live wordmark text + CTA. The Trinitron canvas is `display: none`, exactly as today.

### Code

- `.is2200-hero` section deleted. All `.sneak*`, `.mcrt*`, and `.mcrt-power*` CSS deleted. `initMcrt()`, `mcrtSignal()`, `MCRT_*` constants deleted.
- The existing `.trinitron` canvas in the hero stack is renamed `.hero-screen` (the class on `<html>` that gates dark-mode visibility stays as `.trinitron-active` — it's a state flag, not a per-element class). Its source canvas widens and lengthens to cover both logo and wordmark; its signal callback now paints both.
- The wordmark `<h1>` stays in the DOM. In dark mode its text becomes `color: transparent` so it remains in the accessibility tree but is visually painted by the canvas.

## Architecture

### One screen, one canvas

A single `<canvas class="hero-screen">` (the class is renamed from `.trinitron` to reflect the new role; the `<html>.trinitron-active` state flag is unchanged) sits absolutely positioned over the hero stack region in dark mode. Its rectangle IS the screen: an opaque dark phosphor substrate that the renderer lights up wherever the signal callback paints. Halo bleed is contained inside the canvas rectangle (no visible halo outside the screen edge — the screen has a defined edge by design).

The canvas is hidden (`display: none`) in light mode and in light-pinned theme. Same triple-activation pattern as today (`[data-theme="dark"]` + OS preference gated by `:not([data-theme="light"])`).

### Signal callback

The signal callback paints, in order, into an offscreen source canvas of `viewSize`:

1. **Substrate fill** — solid near-black over the full viewSize, deeper than the page's dark-mode `--bg`. This is the "off" CRT face. Concretely: something close to `#06070C` rather than `--ink-0` itself.
2. **Logo image** — drawn at its position inside the screen. Source = a rasterized SVG of the current rotating-hub frame (same `rasterizeFragment` flow as today's logo Trinitron; arms + hub composed inline with the hub group transformed by the current rotation angle).
3. **Wordmark text** — three separate `fillText` calls (one each for `interslice`, `·`, `systems`) so the live wordmark's weight split (`.wordmark` 700 / `.wordmark b` 500) is preserved. Uses the page's display font, sized and positioned to match the live wordmark's layout box when the canvas is overlaid.

The renderer then runs its full pipeline over this composed image: aperture-grille stripe decomposition, per-cell hotspot, persistence, convergence fringe, contained halo bleed, optional gap mask and post-blur.

Three implementation details worth nailing down up front:

- The wordmark glyphs need to **register against the live wordmark `<h1>`'s layout box** so toggling between light and dark modes doesn't shift the brand position by a pixel. The canvas overlays the same region the wordmark occupies; the signal callback `fillText`s at the same baseline. This implies the signal callback needs to read the live wordmark's computed font size + position once per RAF (or once per resize, cached otherwise) and translate those page-coordinate values into source-canvas coordinates.
- The wordmark's `letter-spacing: -0.06em` needs to be honored in canvas. Use `ctx.letterSpacing` (now widely supported), or hand-compute glyph positions if targeting older browsers. The live wordmark's tracking is part of its identity; rendering it at default spacing will look wrong.
- The hub rotation continues to use a CSS-driven rotation angle (read once per RAF and applied to the rasterized hub group), so reduced-motion preferences continue to disable rotation through the existing CSS pathway. The current logo renderer's pattern carries over directly.

### Accessibility

- Wordmark `<h1>` stays as live `interslice·systems` text in the DOM. In dark mode: `color: transparent` (still in the accessibility tree; screen readers read it).
- Logo `<svg class="mark">` keeps its `role="img"` and `aria-label="Interslice mark"`.
- Canvas keeps `aria-hidden="true"`.
- Reduced motion (`@media (prefers-reduced-motion: reduce)`) stops the hub rotation, same path as today. The screen itself can stay lit (it's just a paint, no continuous animation other than persistence which is imperceptible without motion).

### Light mode (unchanged)

- SVG logo mark (`.m-light` layer) visible.
- Wordmark `<h1>` rendered with its live `color: var(--fg)` (cream → ink).
- Canvas `display: none`.
- No regression risk because no light-mode rules change in this spec.

### Theme switching

The existing `MutationObserver` on `data-theme` + `prefers-color-scheme` media query listener already handles `start()` / `stop()` for the logo Trinitron. Same wiring carries over to the renamed canvas. Adding `.trinitron-active` to `<html>` on dark continues to gate the canvas `display: block` + hides the SVG dark-mode layers (which we're removing in implementation — see below).

## What gets simpler

The current SVG `.mark` has two layer groups: `.m-light` and `.m-dark`. The `.m-dark` group contains an *entire SVG implementation* of the dark-mode logo — phosphor sources, the bleed filter, scanlines, glass gloss, masked screen, etc. — used as a fallback for when the canvas Trinitron isn't active. In practice the canvas is always active in dark mode for any browser that can run the renderer; the SVG dark-mode layer exists for the silent-fallback case.

**This spec does not change that fallback path** (out of scope: deciding whether to drop the SVG dark-mode logo entirely). The wordmark just gets no equivalent SVG fallback — if the renderer fails to init, the wordmark stays as live cream text on dark page bg, which is a perfectly readable degradation.

## Sizing & parameters

Numbers below are starting points to tune during implementation against the compare.html harness (or by eye on the live page). The implementation plan will commit to specific values.

- **Renderer:** `'auto'` (GPU with CPU fallback), matching both current consumers.
- **Aspect ratio:** roughly 2.5:1 to 3:1, matching `logo height + wordmark height + padding` ÷ `wordmark width + padding`. Concretely around 850×320 source.
- **viewSize:** ~`[800, 280]` to start. Scales with the wordmark's `clamp(56px, 9vw, 124px)` via a CSS variable so the canvas tracks the wordmark's responsive size.
- **canvasSize:** matches viewSize × stripeUpscale exactly (no halo margin — the canvas IS the screen edge), unless we want a small internal halo allowance.
- **cellSize:** 4. Suits both the photographic logo and the chunky wordmark text. The IS-2200 used cs=4 for VT323; the logo currently uses cs=3 with a smaller view. cs=4 across the full screen gives proper [R, G, B, gap] triads everywhere.
- **stripeUpscale:** 2.
- **Substrate color:** matches the dark-mode page background closely (so any tiny gap between canvas edge and page is imperceptible) but slightly darker — the CRT face is the deepest black in the composition.
- **Persistence:** ~0.7–0.85, leaning toward the higher end so the rotating hub leaves a soft trail. The IS-2200 used 0.55; the logo uses 0.85.
- **Hotspot / cellShimmer:** 0.18–0.30 / 0.03–0.05, IS-2200-like. The wordmark text wants a slightly higher hotspot to read as crisply lit glyphs.
- **Convergence:** R [-0.25, -0.25], G [0,0], B [0.25, 0.25] — same as both current consumers.
- **Bleed radius / intensity:** start lower than the logo (which used 26 / 1.625) since the halo is now internal — anything too punchy will wash out the substrate. Maybe 18 / 1.2.
- **Bloom (if exposed in this renderer config):** light touch, threshold ~0.7.
- **Damper wires:** none for now (the IS-2200 had them off too). Could add later.

## What gets deleted

In `docs/index.html`:

- The entire `.is2200-hero` section (lines ~1078–1096).
- All CSS for `.is2200-hero`, `.sneak`, `.sneak__tape`, `.sneak__card`, `.sneak__head`, `.sneak__sku`, `.sneak__foot` (~lines 237–327, both base and dark-mode rules).
- All CSS for `.mcrt__crt`, `.mcrt-power`, `.mcrt-power[aria-pressed="false"]`, `.mcrt-power:hover`, `.mcrt-power:active` (~lines 536–574).
- In the inline `<script>`: `initMcrt()`, `mcrtSignal()`, the `MCRT_*` constants, and the `DOMContentLoaded` registration for `initMcrt`.

In CLAUDE.md:

- The "Two consumers" section under "Trinitron renderer" needs updating: the IS-2200 hero screen goes away, the dark-mode logo becomes "the hero screen (logo + wordmark)." The GPU pipeline description stays accurate; only the consumer list changes.

In `docs/tokens.css`:

- Probably nothing. The CRT-hardware sub-palette (`--crt-green`, `--crt-amber`, etc.) was used by `.mcrt`; with `.mcrt` gone, those tokens are unused. Recommend leaving them in place for now — they're cheap to keep and may be wanted again. Cleanup can be a follow-up if they're truly dead.

## Out of scope (deferred)

### Laser grid

The end-goal user told me about: a laser grid that starts as an SVG vector field outside the Trinitron screen and switches to a Trinitron-rendered version when it crosses the screen edge. This is its own design problem with its own open questions:

- What does the grid look like as an SVG outside the screen? (Wireframe? Vanishing-point perspective? Tron grid?)
- Does it animate (sweeping in, scrolling, parallax)? Is it static decor?
- What is the "crossing the threshold" transition visually — a hard cut, a melt, an edge-aligned wipe?
- Is the grid one of the new screen's signal-callback layers, or a separate canvas that composites onto the screen's substrate?
- Does the grid live on top of or behind the logo + wordmark?

These need their own brainstorm round. The screen we're building here gives that follow-up a real edge to anchor to — that's all this spec needs to deliver.

## Open knobs to tune during implementation

These are explicitly things to decide while implementing, not now:

- **Exact viewSize, canvasSize, cellSize.** Settled against the live page (and possibly compare.html). The starting values above are guesses based on the existing two consumers.
- **Wordmark font choice.** Live wordmark uses `var(--font-display)` — does that render well through `fillText` at this scale? The IS-2200 used VT323 explicitly. The hero might want VT323 too (more "CRT font" character) even if the live light-mode wordmark stays on `var(--font-display)`. Worth A/B'ing.
- **Whether to keep the SVG dark-mode logo fallback.** Out of scope here; flag for a follow-up.
- **Screen positioning relative to CTA.** With the screen sized to the wordmark + small margin, the CTA's `margin-top: 64px` below the screen may need adjustment so the layout feels balanced.
- **Substrate color match.** A small visual experiment — does the screen rectangle want to be identical to page bg (invisible edge), slightly darker (visible CRT face), or a touch warmer (warm-tube tint)?
