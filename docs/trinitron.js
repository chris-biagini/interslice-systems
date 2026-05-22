(function () {
  'use strict';

  class Trinitron {
    constructor(canvasEl, opts) {
      this.canvas = canvasEl;
      this.ctx = canvasEl.getContext('2d');
      this.opts = Object.assign({
        viewSize: [200, 200],
        canvasSize: [240, 240],
        // Cell pitch in source pixels. cs=3 keeps the shipped contiguous-
        // triad layout (`[R, G, B]`, no gap column) — combined with
        // `stripeUpscale > 1` and a `gapMaskAlpha` overlay, this gets the
        // visible aperture-grille look at shipped per-pixel cost. cs=6
        // uses an interleaved layout (`[R, gap, G, gap, B, gap]`) where
        // the gap is part of the source-pixel model — heavier, but the
        // gap participates in convergence and bleed.
        cellSize: 3,
        // Integer factor for stretching the stripe canvas onto the main
        // canvas via nearest-neighbor drawImage. With cs=3 and upscale=2,
        // each source pixel becomes 2 canvas pixels — that second canvas
        // pixel is what the gap mask paints over, suggesting an
        // aperture-grille wire between stripes without paying for source-
        // pixel gap columns in the hot loop.
        stripeUpscale: 1,
        // Phosphor overlap. Each lit stripe bleeds into its two adjacent
        // columns at this fraction (cyclic — the R at position 0 bleeds
        // into the gap at position 5 of the previous cell). 0 = strict
        // aperture grille (the gap is pure black). Values > 0 widen the
        // visible phosphor and narrow the visible gap, making the inter-
        // stripe shadow look thinner than a real Trinitron's. Pure-color
        // regions also gain brightness from the bleed into adjacent gaps.
        phosphorOverlap: 0,
        // Phosphor coupling (the "cheat" the shipped version used). At a
        // column where channel C is the primarily-lit one, the OTHER two
        // channels' signals also emit at this fraction. This is a
        // chromatic effect (every lit column shows all three channels'
        // signals, just emphasized differently), distinct from
        // phosphorOverlap which is geometric. Pure-color regions get
        // significantly brighter because three of every six columns show
        // the color (lit + 2 coupling) instead of just one (lit only).
        // Gap columns are unaffected — they stay pure black.
        phosphorCoupling: 0,
        // Gap mask — post-composite overlay that paints thin vertical
        // black lines on top of the stripe layer at canvas-pixel
        // positions. Lets the renderer keep cs=3 (no source-pixel gap
        // columns, shipped brightness and cost) while still showing the
        // aperture-grille gap pattern at display. 0 = no mask; 1 = pure
        // opaque black at each masked column. Mask is applied only over
        // the stripe region (not the bleed margin around it).
        gapMaskAlpha: 0,
        // Mask line spacing in canvas pixels. With stripeUpscale=2 and
        // gapMaskPeriod=2, every other canvas pixel is darkened — the
        // visible result is gap-between-every-stripe (aperture grille).
        // gapMaskPeriod=6 with stripeUpscale=2 puts one gap per triad
        // (cs=4-style between-triads gap).
        gapMaskPeriod: 2,
        bleedRadius: 30,
        bleedIntensity: 1.0,
        persistence: 0.85,
        convergence: { r: [-0.5, -0.5], g: [0.0, 0.0], b: [0.5, 0.5] },
        // Trinitron's two horizontal damper wires. Fractional Y positions
        // of the signal region. Stationary — real damper wires don't move.
        // Baked into the signal canvas before convergence so the wires
        // inherit the same chromatic fringe and bleed treatment as every
        // other feature. Set to [] to disable.
        damperWires: [0.32, 0.68],
        damperStrength: 0.62,
        // Optional per-row brightness noise. 0 = off. Cheap stand-in for
        // the line-to-line beam-current fluctuation a real CRT exhibits;
        // does not reassert the cell grid.
        rowShimmer: 0.0,
        // Per-cell brightness noise. 0 = off. Static per-cell jitter,
        // intentionally reasserts the cell grid — that's what makes each
        // cell read as a distinct phosphor dot rather than a flat tile.
        cellShimmer: 0.0,
        shimmerSeed: 1983,
        // Beam hotspot — Manhattan-distance brightness boost at the dead-
        // center pixel of each cell. With cs=3 this is the (subX=1,
        // subY=1) pixel — one of every nine source pixels. Combined with
        // cellShimmer, this is what produces the "dot grid" texture that
        // makes the rendered image read as phosphor dots through glass.
        hotspot: 0.0,
        // Post-stripe blur (CSS px) on the composite. Softens the
        // LCD-like sharp pixel edges into "lit phosphor through glass."
        phosphorBlurPx: 0.0,
        // Electron-beam spread, applied as an isotropic Gaussian blur on
        // the convergence canvases before sampling. A real Trinitron beam
        // has a fuzzy spot that spreads each scan line into adjacent ones;
        // without this, abrupt features (the bottom of an arm, the cap of
        // a curved edge) terminate razor-sharp mid-phosphor like an LCD.
        // Units are source pixels. Chromium's canvas filter blur no-ops
        // below ~0.7 px, so values under that have no effect.
        beamSpreadPx: 0.0,
        signal: () => {},
        respectReducedMotion: true,
      }, opts);

      const dpr = window.devicePixelRatio || 1;
      const [cw, ch] = this.opts.canvasSize;
      const [vw, vh] = this.opts.viewSize;
      this.canvas.width = cw * dpr;
      this.canvas.height = ch * dpr;
      // Display size is the page's responsibility; the renderer only owns
      // the backing pixel buffer.
      this.ctx.scale(dpr, dpr);
      this.ctx.imageSmoothingEnabled = false;

      // Offscreen signal canvas — caller paints into 200×200 logical coords.
      // willReadFrequently=true since _renderPixels reads each convergence
      // canvas back every frame.
      this.signalCanvas = document.createElement('canvas');
      this.signalCanvas.width = vw;
      this.signalCanvas.height = vh;
      this.signalCtx = this.signalCanvas.getContext('2d', { willReadFrequently: true });
      // Smoothing ON for the signal canvas — the caller's drawImage of a
      // rotated bitmap is bilinear-sampled, so AA fringe pixels at the
      // rotating hub's perimeter get smooth alpha gradients that change
      // continuously frame-to-frame. With smoothing OFF, nearest-neighbor
      // rotation snapped fringe pixels to different source pixels each
      // frame — visible flicker no downstream sampler could remove.
      this.signalCtx.imageSmoothingEnabled = true;
      this.signalCtx.imageSmoothingQuality = 'high';

      // Per-channel convergence canvases — each holds the signal drawn at
      // a sub-pixel offset (browser bilinear handles the resample). The
      // sampler reads each channel from its own buffer, so convergence
      // becomes a sub-source-pixel shift baked into the bitmap. The
      // bilinear AA at the shifted edge gives the columns that would
      // otherwise read alpha=0 a small contribution — chromatic fringe.
      const beamSpread = this.opts.beamSpreadPx;
      const makeConvCanvas = () => {
        const c = document.createElement('canvas');
        c.width = vw; c.height = vh;
        const cctx = c.getContext('2d', { willReadFrequently: true });
        cctx.imageSmoothingEnabled = true;
        cctx.imageSmoothingQuality = 'high';
        // Filter is set once and persists across drawImage calls — composes
        // with the bilinear sub-pixel resample so we get convergence shift
        // AND beam spread in a single source-canvas draw per channel.
        if (beamSpread > 0) cctx.filter = `blur(${beamSpread}px)`;
        return { canvas: c, ctx: cctx };
      };
      this._convR = makeConvCanvas();
      this._convG = makeConvCanvas();
      this._convB = makeConvCanvas();

      // Stripe intensity tables — one lookup per channel, indexed by subX.
      // For cs=6 the positions are interleaved (`[R, gap, G, gap, B, gap]`)
      // — every phosphor stripe bordered by an aperture-grille wire, the
      // physically-faithful layout. For other cs values, fall back to a
      // contiguous-triad layout with symmetric gap padding: cs=3 → [R,G,B];
      // cs=4 → [R,G,B,gap]; cs=5 → [gap,R,G,B,gap]; cs=7+ → wider symmetric
      // padding (avoid — cs=6 is the recommended layout).
      const cs = this.opts.cellSize;
      let rPos, gPos, bPos;
      if (cs === 6) {
        rPos = 0; gPos = 2; bPos = 4;
      } else {
        const leftGap = Math.max(0, (cs - 3) >> 1);
        rPos = leftGap; gPos = leftGap + 1; bPos = leftGap + 2;
      }
      this.stripeR = new Float32Array(cs);
      this.stripeG = new Float32Array(cs);
      this.stripeB = new Float32Array(cs);
      this.stripeR[rPos] = 1;
      this.stripeG[gPos] = 1;
      this.stripeB[bPos] = 1;
      // Phosphor overlap: each lit position contributes `overlap` to its
      // two cyclically-adjacent columns. Cyclic wrap matters at cs=6 —
      // the gap at position 5 sits between this cell's B and the next
      // cell's R, so it gets both B-bleed and R-bleed.
      const overlap = Math.max(0, Math.min(1, this.opts.phosphorOverlap));
      if (overlap > 0) {
        const addBleed = (arr, pos) => {
          const prev = (pos - 1 + cs) % cs;
          const next = (pos + 1) % cs;
          if (arr[prev] < overlap) arr[prev] = overlap;
          if (arr[next] < overlap) arr[next] = overlap;
        };
        addBleed(this.stripeR, rPos);
        addBleed(this.stripeG, gPos);
        addBleed(this.stripeB, bPos);
      }

      // Phosphor coupling: at columns where some channel is the primarily-
      // lit one (rPos, gPos, bPos), the OTHER two channels also emit at
      // this fraction. This is the shipped version's brightness cheat —
      // pure-color regions show their color at three columns of every
      // six (lit + 2 coupling), tripling the lit area without disturbing
      // the gap columns. Applied after overlap so it doesn't paint
      // coupling on gap columns; only the strict lit positions get the
      // cross-channel bleed.
      const coupling = Math.max(0, Math.min(1, this.opts.phosphorCoupling));
      if (coupling > 0) {
        const litPositions = [rPos, gPos, bPos];
        for (const pos of litPositions) {
          if (this.stripeR[pos] < coupling) this.stripeR[pos] = coupling;
          if (this.stripeG[pos] < coupling) this.stripeG[pos] = coupling;
          if (this.stripeB[pos] < coupling) this.stripeB[pos] = coupling;
        }
        // Restore the primary-lit channels to 1.0 (the loop above just
        // raised non-lit channels' weight to `coupling`, but if coupling
        // happens to exceed the lit channel's existing weight from a
        // weird future config we never want to lower the primary).
        this.stripeR[rPos] = 1;
        this.stripeG[gPos] = 1;
        this.stripeB[bPos] = 1;
      }

      // Damper-wire pixel rows. Computed once; stationary.
      const damperFracs = this.opts.damperWires || [];
      this.damperRows = damperFracs
        .map(f => Math.round(f * vh))
        .filter(y => y >= 0 && y < vh);
      // Wire is drawn as opaque-black-at-fillAlpha onto opaque signal
      // pixels via source-atop, which composites as
      // dest.RGB * (1 − fillAlpha). So fillAlpha = 1 − damperStrength
      // produces the desired multiplicative dim.
      this.damperOpacity = 1 - this.opts.damperStrength;

      // Per-row brightness LUT. Static — both effects baked in here would
      // otherwise be one multiply per pixel each in the hot loop; folded
      // into a single number per row, the inner loop pays for one.
      const rowShimAmp = this.opts.rowShimmer;
      const rowMod = new Float32Array(vh);
      // Single LCG drives both row shimmer (vh samples) and per-cell
      // shimmer (cellCount samples) so the seed deterministically picks a
      // single texture across both.
      let lcg = this.opts.shimmerSeed >>> 0;
      const lcgNext = () => {
        lcg = (Math.imul(lcg, 1664525) + 1013904223) >>> 0;
        return (lcg / 0xFFFFFFFF) * 2 - 1;
      };
      if (rowShimAmp > 0) {
        for (let i = 0; i < vh; i++) {
          rowMod[i] = 1 + rowShimAmp * lcgNext();
        }
      } else {
        rowMod.fill(1);
      }
      this.rowMod = rowMod;

      // Per-cell modulation LUT: combines the hotspot (a sub-cell Manhattan-
      // distance pattern, identical across every cell) and the per-cell
      // shimmer (one stable noise value per cell). The combined factor is
      // looked up by `cellShim[cellIdx] * hotLUT[subY * cs + subX]` in the
      // hot loop — two table reads and one multiply, no per-pixel
      // arithmetic. Setting either to 0 collapses its contribution to 1.0
      // so the multiply still runs but doesn't perturb.
      const cellGridW = Math.floor(vw / cs);
      const cellGridH = Math.floor(vh / cs);
      this.cellGridW = cellGridW;
      const cellCount = cellGridW * cellGridH;
      const hotspot = Math.max(0, this.opts.hotspot);
      const hotLUT = new Float32Array(cs * cs);
      if (hotspot > 0) {
        const cellCenter = cs >> 1;
        for (let sy = 0; sy < cs; sy++) {
          for (let sx = 0; sx < cs; sx++) {
            const dx = sx < cellCenter ? cellCenter - sx : sx - cellCenter;
            const dy = sy < cellCenter ? cellCenter - sy : sy - cellCenter;
            const d = dx + dy;
            hotLUT[sy * cs + sx] = d > 1 ? 1 : 1 + hotspot * (1 - d);
          }
        }
      } else {
        hotLUT.fill(1);
      }
      this.hotLUT = hotLUT;
      const cellShimAmp = Math.max(0, this.opts.cellShimmer);
      const cellShim = new Float32Array(cellCount);
      if (cellShimAmp > 0) {
        for (let i = 0; i < cellCount; i++) {
          cellShim[i] = 1 + cellShimAmp * lcgNext();
        }
      } else {
        cellShim.fill(1);
      }
      this.cellShim = cellShim;

      // Per-pixel persistence buffers. Snapshot of the previous frame's
      // smoothed (lerped, pre-stripe-profile) per-channel values, used to
      // exponential-decay the live signal into the displayed bitmap.
      // prevA persists the source-alpha (silhouette mask) — separate from
      // R/G/B because output alpha tracks silhouette coverage, not
      // phosphor brightness. Without this, dim or partially-saturated
      // pixels inside the silhouette would have low alpha and let the
      // bleed canvas paint a ghost of the underlying signal "through"
      // the phosphors.
      const pixelCount = vw * vh;
      this.prevR = new Float32Array(pixelCount);
      this.prevG = new Float32Array(pixelCount);
      this.prevB = new Float32Array(pixelCount);
      this.prevA = new Float32Array(pixelCount);

      // Stripe ImageData + intermediate canvas. putImageData ignores
      // compositing, so we go through an intermediate canvas and
      // drawImage from there — source-over with the stripe canvas's alpha
      // lets dark pixels block the bleed where appropriate.
      this.stripeImageData = this.ctx.createImageData(vw, vh);
      this.stripeCanvas = document.createElement('canvas');
      this.stripeCanvas.width = vw;
      this.stripeCanvas.height = vh;
      this.stripeCtx = this.stripeCanvas.getContext('2d');

      // Bleed canvas — the blurred displayed signal, sized to the full
      // canvas so the blur kernel's extent has room to bloom outward past
      // the signal's viewSize.
      this.bleedCanvas = document.createElement('canvas');
      this.bleedCanvas.width = cw;
      this.bleedCanvas.height = ch;
      this.bleedCtx = this.bleedCanvas.getContext('2d');

      // bleedRadius and bleedIntensity are constructor-only, so set the
      // filter once instead of toggling per frame.
      const bi = this.opts.bleedIntensity;
      this.bleedCtx.filter =
        `blur(${this.opts.bleedRadius}px)` +
        (bi !== 1 ? ` brightness(${bi})` : '');
      // The stripe canvas (vw×vh source pixels) is drawn onto the main
      // canvas at this integer scale factor via nearest-neighbor — each
      // source pixel becomes `stripeUpscale` canvas pixels. The bleed
      // signal is drawn at the same upscale so the halo stays aligned
      // with the stripe region.
      const stripeUpscale = Math.max(1, Math.floor(this.opts.stripeUpscale));
      this.stripeUpscale = stripeUpscale;
      this.stripeDestW = vw * stripeUpscale;
      this.stripeDestH = vh * stripeUpscale;
      this.bleedMargin = (cw - this.stripeDestW) / 2;

      // Gap mask — pre-baked canvas with thin black vertical lines that
      // span the FULL canvas (not just the stripe region). Painting only
      // over the stripe region created a visible dark rectangle: the
      // bleed halo extended past the stripe region into the margin at
      // full brightness, while everywhere inside the stripe region was
      // mask-darkened. The brightness jump at the boundary made the
      // mask's footprint show as an outline. Painting across the entire
      // canvas means the same darkening applies wherever the bleed is
      // visible, with no boundary discontinuity.
      //
      // Phase alignment: lines should land on the same canvas-x positions
      // as if the mask were scoped to the stripe region — i.e., starting
      // at (bleedMargin + period - 1) — so the visible aperture-grille
      // pattern stays aligned with the upscaled source pixels.
      const gapMaskAlpha = Math.max(0, Math.min(1, this.opts.gapMaskAlpha));
      if (gapMaskAlpha > 0 && stripeUpscale > 1) {
        const period = Math.max(2, Math.floor(this.opts.gapMaskPeriod));
        this.gapMaskCanvas = document.createElement('canvas');
        this.gapMaskCanvas.width = cw;
        this.gapMaskCanvas.height = ch;
        const mctx = this.gapMaskCanvas.getContext('2d');
        mctx.fillStyle = `rgba(0,0,0,${gapMaskAlpha})`;
        const phase = ((this.bleedMargin + period - 1) % period + period) % period;
        for (let dx = phase; dx < cw; dx += period) {
          mctx.fillRect(dx, 0, 1, ch);
        }
      } else {
        this.gapMaskCanvas = null;
      }

      this._wasStartedByUser = false;
      this._setupReducedMotionListener();
      this._rafHandle = null;
      this._startTime = null;
    }

    start() {
      this._wasStartedByUser = true;
      if (this._rafHandle != null) return;
      // Zero the persistence trail so a stop/restart (e.g. theme toggle)
      // doesn't leave the last paused frame ghosted into the next session.
      this.prevR.fill(0); this.prevG.fill(0); this.prevB.fill(0); this.prevA.fill(0);
      this._startTime = performance.now();
      if (this._reducedMotionMq && this._reducedMotionMq.matches) {
        this._frame(0);
        return;
      }
      const tick = (now) => {
        this._frame(now - this._startTime);
        this._rafHandle = requestAnimationFrame(tick);
      };
      this._rafHandle = requestAnimationFrame(tick);
    }

    stop() {
      if (this._rafHandle != null) {
        cancelAnimationFrame(this._rafHandle);
        this._rafHandle = null;
      }
    }

    _setupReducedMotionListener() {
      if (!this.opts.respectReducedMotion) return;
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      this._reducedMotionMq = mq;
      this._reducedMotionHandler = () => {
        if (mq.matches) this.stop();
        else if (this._wasStartedByUser) this.start();
      };
      if (mq.addEventListener) mq.addEventListener('change', this._reducedMotionHandler);
      else if (mq.addListener) mq.addListener(this._reducedMotionHandler);
    }

    _frame(timeMs) {
      const [vw, vh] = this.opts.viewSize;
      const [cw, ch] = this.opts.canvasSize;

      // 1. Caller paints the displayed signal. The halo and the stripes
      //    both derive from this one bitmap — a real CRT can't selectively
      //    leak some pixels and not others.
      this.signalCtx.clearRect(0, 0, vw, vh);
      this.opts.signal(this.signalCtx, timeMs);

      // 2. Stamp damper wires onto the signal. source-atop confines the
      //    dim to opaque phosphor pixels (no wires over the surrounding
      //    glass). Baking into the signal means the wires get the same
      //    convergence fringe and bleed treatment as everything else.
      if (this.damperRows.length > 0 && this.damperOpacity > 0) {
        this.signalCtx.save();
        this.signalCtx.globalCompositeOperation = 'source-atop';
        this.signalCtx.fillStyle = `rgba(0,0,0,${this.damperOpacity})`;
        for (let i = 0; i < this.damperRows.length; i++) {
          this.signalCtx.fillRect(0, this.damperRows[i], vw, 1);
        }
        this.signalCtx.restore();
      }

      // 3. Bake per-channel convergence offsets into three pre-shifted
      //    copies of the signal.
      this._applyConvergence();

      // 4. Per-output-pixel pass: sample → persistence lerp + snapshot →
      //    stripe profile (geometric gap is pure black) → write.
      this._renderPixels();
      this.stripeCtx.putImageData(this.stripeImageData, 0, 0);

      // 5. Blur the bleed source canvas. The canvas filter blurs per
      //    channel, so a single blur produces the correct per-channel
      //    additive halo.
      this._renderBleed();

      // 6. Composite: bleed underneath, stripes on top (optionally
      //    softened, optionally stretched via stripeUpscale), then gap
      //    mask on top of stripes.
      this.ctx.clearRect(0, 0, cw, ch);
      this.ctx.drawImage(this.bleedCanvas, 0, 0);
      const blur = this.opts.phosphorBlurPx;
      if (blur > 0) this.ctx.filter = `blur(${blur}px)`;
      this.ctx.drawImage(
        this.stripeCanvas,
        this.bleedMargin, this.bleedMargin,
        this.stripeDestW, this.stripeDestH
      );
      if (blur > 0) this.ctx.filter = 'none';
      if (this.gapMaskCanvas) {
        // source-atop so the mask only darkens canvas pixels that already
        // have content (the bleed halo + stripes). Without this, masked
        // canvas pixels in transparent regions (the corners of the
        // canvas backing buffer where the bleed halo doesn't reach) would
        // gain alpha from the 0.5-alpha black, painting a semi-opaque
        // rectangle over the page background.
        this.ctx.globalCompositeOperation = 'source-atop';
        this.ctx.drawImage(this.gapMaskCanvas, 0, 0);
        this.ctx.globalCompositeOperation = 'source-over';
      }
    }

    _applyConvergence() {
      // Bake per-channel convergence offsets into three pre-shifted source
      // bitmaps. drawImage(signal, -dx, -dy) produces dest(X,Y) =
      // signal(X+dx, Y+dy): a positive convergence value shifts that
      // channel LEFT in the displayed image. The browser's bilinear
      // resample at sub-pixel offsets produces a soft AA fringe, so a
      // 0.25 px convergence renders as a 0.25-px-wide color fringe at
      // edges instead of a cell-quantized 1-stripe ghost.
      const [vw, vh] = this.opts.viewSize;
      const c = this.opts.convergence;
      this._convR.ctx.clearRect(0, 0, vw, vh);
      this._convR.ctx.drawImage(this.signalCanvas, -c.r[0], -c.r[1]);
      this._convG.ctx.clearRect(0, 0, vw, vh);
      this._convG.ctx.drawImage(this.signalCanvas, -c.g[0], -c.g[1]);
      this._convB.ctx.clearRect(0, 0, vw, vh);
      this._convB.ctx.drawImage(this.signalCanvas, -c.b[0], -c.b[1]);
    }

    _renderPixels() {
      // One fused per-output-pixel pass. For each pixel:
      //   sample (alpha-premultiplied) RGB from each channel's pre-shifted
      //   source + sample source alpha (unshifted G channel — the cleanest
      //   silhouette mask)
      //   → exponential-decay lerp R, G, B, AND A against previous frame
      //   → snapshot smoothed values into prev[] (pre-stripe-profile)
      //   → multiply RGB by per-channel stripe weight + per-row mod
      //   → write RGBA. Output alpha = lerpA tracks the silhouette
      //     coverage (the aperture grille mask), NOT phosphor brightness:
      //     inside the logo, gap pixels are opaque black so the bleed is
      //     blocked (no ghost of the SVG painted under the stripes);
      //     outside the logo, alpha is 0 and the bleed shines through.
      const [vw, vh] = this.opts.viewSize;
      const cs = this.opts.cellSize;
      const out = this.stripeImageData.data;

      // Alpha-weighting per channel matters: ImageData is non-premultiplied,
      // so a half-covered AA fringe reads as (R, _, _, 128) for a half-red
      // edge — multiplying by alpha/255 makes contribution proportional to
      // actual coverage, which keeps the rotating hub's perimeter smooth
      // instead of staircasing as the AA pattern shifts frame-to-frame.
      const pxR = this._convR.ctx.getImageData(0, 0, vw, vh).data;
      const pxG = this._convG.ctx.getImageData(0, 0, vw, vh).data;
      const pxB = this._convB.ctx.getImageData(0, 0, vw, vh).data;

      // Persistence: single exponential decay across channels. First-frame
      // cost: prev is zero on start(), so the image fades in over
      // ~1/(1−dr) frames (≈7 frames at dr=0.85, ~110 ms at 60 Hz).
      const dr = Math.min(0.99, this.opts.persistence);
      const ar = 1 - dr;
      const prR = this.prevR, prG = this.prevG, prB = this.prevB, prA = this.prevA;

      const stripeR = this.stripeR;
      const stripeG = this.stripeG;
      const stripeB = this.stripeB;
      const rowMod = this.rowMod;
      const hotLUT = this.hotLUT;
      const cellShim = this.cellShim;
      const cellGridW = this.cellGridW;
      const invCs = 1 / cs;

      let pi = 0, pix = 0;
      for (let py = 0; py < vh; py++) {
        const rm = rowMod[py];
        const cyBase = (py * invCs) | 0;
        const subY = py - cyBase * cs;
        const hotRowOff = subY * cs;
        const cellRowBase = cyBase * cellGridW;

        for (let px = 0; px < vw; px++) {
          const cxBase = (px * invCs) | 0;
          const subX = px - cxBase * cs;

          // Sample alpha-premultiplied RGB.
          const sR_raw = pxR[pi]     * (pxR[pi + 3] / 255);
          const sG_raw = pxG[pi + 1] * (pxG[pi + 3] / 255);
          const sB_raw = pxB[pi + 2] * (pxB[pi + 3] / 255);
          // Sample source alpha from the unshifted G channel — the
          // cleanest silhouette mask, with the AA/beam-spread edge
          // softening preserved but no chromatic offset.
          const sA = pxG[pi + 3];

          // Persistence lerp + snapshot.
          const lerpR = prR[pix] * dr + sR_raw * ar;
          const lerpG = prG[pix] * dr + sG_raw * ar;
          const lerpB = prB[pix] * dr + sB_raw * ar;
          const lerpA = prA[pix] * dr + sA     * ar;
          prR[pix] = lerpR;
          prG[pix] = lerpG;
          prB[pix] = lerpB;
          prA[pix] = lerpA;

          // Cell mod combines per-cell shimmer (one value per cell) with
          // the sub-cell hotspot pattern (boost at the cell center). Both
          // collapse to 1.0 when their amplitudes are 0, so this multiply
          // is harmless when both effects are off.
          const cellMod = hotLUT[hotRowOff + subX] * cellShim[cellRowBase + cxBase];

          // Stripe geometry: weighted contribution from each lit position
          // (with optional overlap bleeding into adjacent columns).
          const r = lerpR * stripeR[subX] * rm * cellMod;
          const g = lerpG * stripeG[subX] * rm * cellMod;
          const b = lerpB * stripeB[subX] * rm * cellMod;

          out[pi]     = r > 255 ? 255 : r;
          out[pi + 1] = g > 255 ? 255 : g;
          out[pi + 2] = b > 255 ? 255 : b;
          out[pi + 3] = lerpA > 255 ? 255 : lerpA;

          pi += 4;
          pix++;
        }
      }
    }

    _renderBleed() {
      // Filter is set once in the constructor. Visible extent of a Gaussian
      // is ~3*stdDev — keep bleedRadius ≤ (canvasSize − stripeDestW)/2 or
      // the tail will clip at the canvas edge. Signal is drawn at the
      // same upscaled size as the stripe layer so the halo stays aligned
      // around the visible silhouette.
      const [cw, ch] = this.opts.canvasSize;
      this.bleedCtx.clearRect(0, 0, cw, ch);
      this.bleedCtx.drawImage(
        this.signalCanvas,
        this.bleedMargin, this.bleedMargin,
        this.stripeDestW, this.stripeDestH
      );
    }
  }

  window.Trinitron = Trinitron;
})();
