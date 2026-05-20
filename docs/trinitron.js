(function () {
  'use strict';

  class Trinitron {
    constructor(canvasEl, opts) {
      this.canvas = canvasEl;
      this.ctx = canvasEl.getContext('2d');
      this.opts = Object.assign({
        viewSize: [200, 200],
        canvasSize: [240, 240],
        cellSize: 3,
        bleedRadius: 30,
        bleedIntensity: 1.0,
        persistence: 0.85,
        perChannelDecay: { r: 1.00, g: 0.94, b: 1.04 },
        convergence: { r: [-0.5, -0.5], g: [0.0, 0.0], b: [0.5, 0.5] },
        convergenceDriftAmplitudePx: 1.0,
        convergenceDriftPeriodSec: 60,
        hotspot: 0.15,
        shimmer: 0.04,
        shimmerSeed: 1983,
        scanBandPeriodSec: 7,
        scanBandStrength: 0.08,
        // Phosphor coupling: imperfect aperture-grille masking lets the
        // electron beam excite ADJACENT stripes a little. 0 = pure stripe
        // (one channel per pixel, dim); higher values = brighter, softer
        // phosphor with less aggressive subpixel banding.
        phosphorCoupling: 0.0,
        // Post-stripe blur (CSS px), applied when drawImage'ing the stripe
        // canvas onto the main canvas. Softens the LCD-like sharp pixel
        // edges into something more "lit phosphor through glass."
        phosphorBlurPx: 0.0,
        // Electron-beam spread, applied as an isotropic Gaussian blur on
        // the convergence canvases before sampling. A real Trinitron beam
        // has a fuzzy spot that spreads each scan line into adjacent ones;
        // without this, abrupt features (the bottom of an arm, the cap of
        // a curved edge) terminate razor-sharp mid-phosphor like an LCD.
        // Source has no stripe structure (those are synthesized in the
        // renderer), so the blur only softens object edges.
        //
        // Units are source pixels (the convergence canvases are 1:1 with
        // viewSize). 0 = digital sharp. Note: Chromium's canvas filter
        // blur no-ops below ~0.7px, so values under that have no effect.
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
      // the backing pixel buffer. Without a CSS rule sizing .trinitron the
      // canvas will render at its device-pixel dimensions on HiDPI.
      this.ctx.scale(dpr, dpr);
      this.ctx.imageSmoothingEnabled = false;

      // Offscreen signal canvas — caller paints into 200×200 logical coords.
      // willReadFrequently=true since _sample reads the whole canvas back
      // every frame.
      this.signalCanvas = document.createElement('canvas');
      this.signalCanvas.width = vw;
      this.signalCanvas.height = vh;
      this.signalCtx = this.signalCanvas.getContext('2d', { willReadFrequently: true });
      // Smoothing ON for the signal canvas — the caller's drawImage of a
      // rotated bitmap is bilinear-sampled, so AA fringe pixels at the
      // rotating hub's perimeter get smooth alpha gradients that change
      // continuously frame-to-frame. With smoothing OFF (the previous
      // setting), nearest-neighbor rotation snapped fringe pixels to
      // different source pixels each frame — visible flicker no
      // downstream sampler could remove. The output canvas keeps
      // smoothing OFF below; we want sharp phosphor stripes there.
      this.signalCtx.imageSmoothingEnabled = true;
      this.signalCtx.imageSmoothingQuality = 'high';

      // Per-channel convergence canvases — each holds the signal drawn at a
      // sub-pixel offset (browser bilinear handles the resample). The sampler
      // reads each channel from its own buffer, so convergence becomes a
      // sub-source-pixel shift baked into the bitmap rather than a
      // cell-index flip in the sampler. The previous approach
      // (`(px + rdx) * invCs | 0` in _renderStripes) quantized any sub-cell
      // offset to whole-cell shifts at one subX position only, producing
      // sharp 1-cell-wide phosphor ghosts at high-contrast edges instead of
      // a smooth chromatic fringe. Doing the shift on the source bitmap
      // also softens the per-column sampler's hard-edge zeroes: the
      // bilinear AA at the shifted edge gives the columns that used to
      // read alpha=0 a small contribution.
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

      // Cell grid — still useful for indexing per-cell shimmer noise (so
      // the shimmer pattern reads as 3×3 phosphor cells, not per-pixel
      // static). No longer used for sampling or persistence: rendering is
      // a single per-output-pixel pass that reads directly from the
      // per-channel pre-shifted source bitmaps. A real Trinitron aperture
      // grille is horizontal-only (R/G/B stripe pitch), with continuous
      // phosphor vertically — so chunking the signal into vertical
      // 3-pixel cells (as the previous sampler did) wasn't CRT-correct
      // and was producing visible 3-row "shelves" on every diagonal/curve.
      const cs = this.opts.cellSize;
      this.cellGridW = Math.floor(vw / cs);  // 66 for default (floor(200/3))
      this.cellGridH = Math.floor(vh / cs);  // 66 for default (floor(200/3))
      const cellCount = this.cellGridW * this.cellGridH;

      // Per-pixel persistence buffers. Snapshot of the previous frame's
      // smoothed (lerped, pre-modulation) per-channel values, used to
      // exponential-decay the live signal into the displayed bitmap.
      // Indexed by linear pixel index = py * vw + px.
      const pixelCount = vw * vh;
      this.prevR = new Float32Array(pixelCount);
      this.prevG = new Float32Array(pixelCount);
      this.prevB = new Float32Array(pixelCount);

      // Shimmer: stable per-cell brightness noise (computed once, never animated).
      // Derived from a small LCG seeded by shimmerSeed so the pattern is
      // deterministic across reloads.
      this.shimmerNoise = new Float32Array(cellCount);
      let lcg = this.opts.shimmerSeed >>> 0;
      const lcgNext = () => {
        lcg = (Math.imul(lcg, 1664525) + 1013904223) >>> 0;
        return lcg / 0xFFFFFFFF;  // 0..1
      };
      for (let i = 0; i < cellCount; i++) {
        // Centered noise: -1..+1, then scaled by shimmer amplitude in the render step
        this.shimmerNoise[i] = (lcgNext() * 2 - 1);
      }

      // Stripe ImageData (source-region-sized) + an intermediate canvas. We
      // putImageData onto the intermediate canvas, then drawImage it onto the
      // output. Going through an intermediate is necessary because
      // putImageData ignores compositing and always overwrites alpha — so
      // straight putImageData would erase the underlying bleed wherever a
      // stripe pixel is dark. drawImage respects alpha and source-over, so
      // dark (alpha=0) stripe pixels let the bleed show through correctly.
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
      this.bleedMargin = (cw - vw) / 2;

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
      this.prevR.fill(0); this.prevG.fill(0); this.prevB.fill(0);
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

      // 2. Bake per-channel convergence offsets into three pre-shifted
      //    copies of the signal. The renderer reads each channel from its
      //    own copy, so convergence operates at source-pixel resolution.
      this._applyConvergence(timeMs);

      // 3. Single per-output-pixel pass: read pre-shifted source, lerp
      //    against previous frame's smoothed value (persistence), apply
      //    scan-band, aperture-grille phosphor coupling, hotspot,
      //    shimmer, and scan-line dim. One loop replaces the earlier
      //    sample → persistence → modulation → render pipeline.
      this._renderPixels(timeMs);
      this.stripeCtx.putImageData(this.stripeImageData, 0, 0);

      // 4. Blur the bleed source canvas. The canvas filter blurs per channel,
      //    so a single blur produces the correct per-channel additive halo.
      this._renderBleed();

      // 5. Composite: bleed underneath, stripes on top (optionally softened).
      this.ctx.clearRect(0, 0, cw, ch);
      this.ctx.drawImage(this.bleedCanvas, 0, 0);
      const blur = this.opts.phosphorBlurPx;
      if (blur > 0) this.ctx.filter = `blur(${blur}px)`;
      this.ctx.drawImage(this.stripeCanvas, this.bleedMargin, this.bleedMargin);
      if (blur > 0) this.ctx.filter = 'none';
    }

    _applyConvergence(timeMs) {
      // Bake per-channel convergence offsets into three pre-shifted source
      // bitmaps. drawImage(signal, -dx, -dy) produces dest(X,Y) = signal(X+dx,
      // Y+dy), which matches the previous sampler's read semantics
      // ((px + dx) → cell index dx to the left): a positive convergence value
      // shifts that channel LEFT in the displayed image.
      //
      // The browser's bilinear resample at sub-pixel offsets produces a soft
      // AA fringe, so a 0.25 px convergence value renders as a 0.25-px-wide
      // color fringe at edges instead of a cell-quantized 1-stripe ghost.
      const [vw, vh] = this.opts.viewSize;
      const c = this.opts.convergence;
      const driftAmp = this.opts.convergenceDriftAmplitudePx;
      const drift = driftAmp === 0
        ? 0
        : driftAmp * Math.sin(2 * Math.PI * (timeMs / 1000) / this.opts.convergenceDriftPeriodSec);
      // Vertical drift is gentler than horizontal — beam alignment is more
      // forgiving on the long axis of the tube.
      const rdx = c.r[0] + drift;
      const rdy = c.r[1] + drift * 0.6;
      const bdx = c.b[0] - drift;
      const bdy = c.b[1] - drift * 0.6;

      this._convR.ctx.clearRect(0, 0, vw, vh);
      this._convR.ctx.drawImage(this.signalCanvas, -rdx, -rdy);
      this._convG.ctx.clearRect(0, 0, vw, vh);
      this._convG.ctx.drawImage(this.signalCanvas, -c.g[0], -c.g[1]);
      this._convB.ctx.clearRect(0, 0, vw, vh);
      this._convB.ctx.drawImage(this.signalCanvas, -bdx, -bdy);
    }

    _renderPixels(timeMs) {
      // One fused per-output-pixel pass. For each pixel:
      //   sample (alpha-premultiplied) from each channel's pre-shifted source
      //   → exponential-decay lerp against previous frame's smoothed value
      //   → snapshot smoothed into prev[] (BEFORE modulations — live signal
      //     pulses but trail doesn't)
      //   → scan-band (cosine sweep), aperture-grille coupling (per subX),
      //     scan-line dim (last cs-row), hotspot (cell center), shimmer
      //     (stable per-cell noise)
      //   → write RGBA into the stripe ImageData.
      const [vw, vh] = this.opts.viewSize;
      const cs = this.opts.cellSize;
      const cw = this.cellGridW;
      const out = this.stripeImageData.data;
      const SCAN_DIM_FACTOR = 0.7;

      // Pre-shifted source bitmaps, one per channel. Alpha-weighting per
      // channel matters: ImageData is non-premultiplied, so a half-covered
      // AA fringe reads as (R, _, _, 128) for a half-red edge — multiplying
      // by alpha/255 makes contribution proportional to actual coverage,
      // which keeps the rotating hub's perimeter smooth instead of
      // staircasing as the AA pattern shifts frame-to-frame.
      const pxR = this._convR.ctx.getImageData(0, 0, vw, vh).data;
      const pxG = this._convG.ctx.getImageData(0, 0, vw, vh).data;
      const pxB = this._convB.ctx.getImageData(0, 0, vw, vh).data;

      // Persistence: per-channel exponential decay. First-frame cost: prev
      // is zero on start(), so the image fades in over ~1/(1-dr) frames
      // (≈7 frames at dr=0.85, ~110ms at 60 Hz).
      const p = this.opts.persistence;
      const d = this.opts.perChannelDecay;
      const dr = Math.min(0.99, p * d.r);
      const dg = Math.min(0.99, p * d.g);
      const db = Math.min(0.99, p * d.b);
      const ar = 1 - dr, ag = 1 - dg, ab = 1 - db;
      const prR = this.prevR, prG = this.prevG, prB = this.prevB;

      // Scan-band: cosine envelope sweeping top-to-bottom every
      // scanBandPeriodSec. Per-row (not per-pixel) — same phase across
      // all pixels in a given y. Applied AFTER persistence snapshot so the
      // band doesn't smear into the trail (live signal pulses; trail doesn't).
      const sbStrength = this.opts.scanBandStrength;
      const sbPhase = (timeMs / 1000) / this.opts.scanBandPeriodSec;

      // Hot-loop constants.
      const hotspot = this.opts.hotspot;
      const shimmer = this.opts.shimmer;
      // Phosphor coupling — imperfect aperture-grille masking lets each
      // stripe column leak a fraction `k` of the neighboring stripes'
      // channels. For uniform interior pixels this just brightens the
      // stripe-modulated hue; at edges where the per-channel pre-shift
      // produces different alpha-weighted values, the three stripes within
      // a cell end up at different brightnesses — the aperture-grille
      // triad behavior, now operating at source-pixel resolution rather
      // than 3-pixel cell resolution.
      const k = this.opts.phosphorCoupling;
      const shim = this.shimmerNoise;
      const cellCenter = cs >> 1;
      const invCs = 1 / cs;

      let pi = 0, pix = 0;
      for (let py = 0; py < vh; py++) {
        const cyBase = (py * invCs) | 0;
        const subY = py - cyBase * cs;
        // Scan-line dim: bottom row of each cs-row cell reads as a darker
        // gap, the visible aperture-grille shadow between phosphor cells.
        const scanDim = (subY === cs - 1) ? SCAN_DIM_FACTOR : 1.0;
        const distY = subY - cellCenter;
        const aDistY = distY < 0 ? -distY : distY;
        const scanBand = 1 + sbStrength * Math.cos(2 * Math.PI * (py / vh - sbPhase));
        const rowBase = cyBase * cw;

        for (let px = 0; px < vw; px++) {
          const cxBase = (px * invCs) | 0;
          const subX = px - cxBase * cs;

          // Sample alpha-premultiplied per-channel.
          const sR_raw = pxR[pi]     * (pxR[pi + 3] / 255);
          const sG_raw = pxG[pi + 1] * (pxG[pi + 3] / 255);
          const sB_raw = pxB[pi + 2] * (pxB[pi + 3] / 255);

          // Persistence lerp + snapshot (snapshot before any modulation).
          const lerpR = prR[pix] * dr + sR_raw * ar;
          const lerpG = prG[pix] * dg + sG_raw * ag;
          const lerpB = prB[pix] * db + sB_raw * ab;
          prR[pix] = lerpR;
          prG[pix] = lerpG;
          prB[pix] = lerpB;

          // Apply scan-band — pulses the live displayed image but stays
          // out of the persistence snapshot above.
          const sR = lerpR * scanBand;
          const sG = lerpG * scanBand;
          const sB = lerpB * scanBand;

          // Hotspot — boost the cs×cs cell's exact center pixel; for
          // cs=3 the Manhattan-distance max(0, 1−d) collapses to "1 at the
          // center, 0 elsewhere," matching a Trinitron aperture-grille hole.
          const distX = subX - cellCenter;
          const aDistX = distX < 0 ? -distX : distX;
          const subDist = aDistX + aDistY;
          const hotMod = subDist > 1 ? 1 : 1 + hotspot * (1 - subDist);

          // Shimmer — stable per-cell brightness noise. Per-cell, not
          // per-pixel: per-pixel reads as static, per-cell reads as
          // phosphor brightness variation.
          const shimMod = 1 + shimmer * shim[rowBase + cxBase];
          const totalMod = scanDim * hotMod * shimMod;

          // Phosphor coupling per subX.
          let r, g, b;
          if (subX === 0)      { r = sR;     g = sG * k; b = sB * k; }
          else if (subX === 1) { r = sR * k; g = sG;     b = sB * k; }
          else                 { r = sR * k; g = sG * k; b = sB;     }

          r *= totalMod; g *= totalMod; b *= totalMod;
          out[pi]     = r > 255 ? 255 : r;
          out[pi + 1] = g > 255 ? 255 : g;
          out[pi + 2] = b > 255 ? 255 : b;
          // Graded alpha = brightest scan-banded channel — lets edge
          // pixels fade smoothly into the bleed instead of staircasing.
          const a = sR > sG ? (sR > sB ? sR : sB) : (sG > sB ? sG : sB);
          out[pi + 3] = a > 255 ? 255 : a;

          pi += 4;
          pix++;
        }
      }
    }

    _renderBleed() {
      // Filter is set once in the constructor. Visible extent of a Gaussian
      // is ~3*stdDev — keep bleedRadius ≤ (canvasSize − viewSize)/2 or the
      // tail will clip at the canvas edge.
      const [cw, ch] = this.opts.canvasSize;
      this.bleedCtx.clearRect(0, 0, cw, ch);
      this.bleedCtx.drawImage(this.signalCanvas, this.bleedMargin, this.bleedMargin);
    }
  }

  window.Trinitron = Trinitron;
})();
