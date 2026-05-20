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
        silhouettePath: null,
        // Optional separate signal source for the bleed/halo. If provided,
        // the bleed reflects this canvas's content instead of the main
        // signal — useful when the displayed image has effects that you
        // *don't* want appearing in the halo (e.g., specular shines on
        // an Aqua-button treatment should not appear in the leak).
        bleedSignal: null,
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
        signal: () => {},
        respectReducedMotion: true,
      }, opts);

      const dpr = window.devicePixelRatio || 1;
      const [cw, ch] = this.opts.canvasSize;
      const [vw, vh] = this.opts.viewSize;
      this.canvas.width = cw * dpr;
      this.canvas.height = ch * dpr;
      // NOTE: display size is now CSS's job, not the renderer's. The page
      // knows where the canvas should sit and how big it should look; the
      // renderer only owns the backing pixel buffer. If you instantiate
      // Trinitron without a CSS rule sizing the canvas element, you'll get
      // the browser's default — which on HiDPI displays will be wrong
      // (the canvas will render at its device-pixel dimensions). Always
      // size .trinitron via CSS.
      this.ctx.scale(dpr, dpr);
      this.ctx.imageSmoothingEnabled = false;

      // Bleed margin = (canvasSize - viewSize) / 2 per axis
      this.bleedMargin = (cw - vw) / 2;

      // Offscreen signal canvas — caller paints into 200×200 logical coords.
      // willReadFrequently=true since _sampleCells reads the whole canvas
      // back every frame.
      this.signalCanvas = document.createElement('canvas');
      this.signalCanvas.width = vw;
      this.signalCanvas.height = vh;
      this.signalCtx = this.signalCanvas.getContext('2d', { willReadFrequently: true });
      this.signalCtx.imageSmoothingEnabled = false;

      // Cell grid — one cell per cellSize × cellSize source-pixel block
      const cs = this.opts.cellSize;
      this.cellGridW = Math.floor(vw / cs);  // 66 for default (floor(200/3))
      this.cellGridH = Math.floor(vh / cs);  // 66 for default (floor(200/3))
      const cellCount = this.cellGridW * this.cellGridH;
      this.cellsR = new Float32Array(cellCount);
      this.cellsG = new Float32Array(cellCount);
      this.cellsB = new Float32Array(cellCount);
      this.prevR = new Float32Array(cellCount);
      this.prevG = new Float32Array(cellCount);
      this.prevB = new Float32Array(cellCount);

      // Shimmer: stable per-cell brightness noise (computed once, never animated).
      // Derived from a small LCG seeded by shimmerSeed so the pattern is
      // deterministic across reloads.
      this.shimmerNoise = new Float32Array(cellCount);
      let lcg = (this.opts.shimmerSeed || 1983) >>> 0;
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

      // Bleed: blur a separate "bleed source" canvas onto the bleed
      // canvas, then drawImage onto the output. The bleed source is
      // typically the same colored phosphor that drives the cell-grid
      // sampling, but without any display-only embellishments (e.g., the
      // Aqua-button treatment), so the halo reflects the raw phosphor
      // leak — not the displayed image's specular shines.
      this.bleedRadius = this.opts.bleedRadius;

      // Bleed source canvas — the caller's bleedSignal callback (if any)
      // paints into this each frame. If no bleedSignal is provided, the
      // renderer falls back to bleeding from the main signal canvas
      // (which means any Aqua-type effects bake into the halo too).
      this.bleedSignalCanvas = document.createElement('canvas');
      this.bleedSignalCanvas.width = vw;
      this.bleedSignalCanvas.height = vh;
      this.bleedSignalCtx = this.bleedSignalCanvas.getContext('2d');
      this.bleedSignalCtx.imageSmoothingEnabled = false;

      // Bleed canvas — the blurred bleed source, full canvas size with
      // margin for the blur kernel's extent. drawImage'd onto the main
      // ctx (which has the dpr scale transform), so the bleed extends
      // across the displayed canvas region correctly.
      this.bleedCanvas = document.createElement('canvas');
      this.bleedCanvas.width = cw;
      this.bleedCanvas.height = ch;
      this.bleedCtx = this.bleedCanvas.getContext('2d');

      // Silhouette path (for clipping the bleed). Pre-create a Path2D from
      // the SVG path string if provided. Default null = no silhouette clip.
      // Stored but not yet used; the natural blur falloff currently provides
      // the finite extent.
      this.silhouettePath = this.opts.silhouettePath
        ? new Path2D(this.opts.silhouettePath)
        : null;

      this._wasStartedByUser = false;
      this._setupReducedMotionListener();
      this._rafHandle = null;
      this._startTime = null;
    }

    start() {
      this._wasStartedByUser = true;
      if (this._rafHandle != null) return;
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

      // 1. Capture the display signal — what the Trinitron shows on its
      //    phosphors, including any Aqua / specular treatments.
      this.signalCtx.clearRect(0, 0, vw, vh);
      this.opts.signal(this.signalCtx, timeMs);

      // 1b. If the caller provided a separate bleed source, paint it. This
      //     lets the halo reflect the raw colored phosphor without the
      //     display's Aqua specular shines bleeding into the leak.
      if (this.opts.bleedSignal) {
        this.bleedSignalCtx.clearRect(0, 0, vw, vh);
        this.opts.bleedSignal(this.bleedSignalCtx, timeMs);
      }

      // 2. Sample cells from the display signal
      this._sampleCells();

      // 2.5. Persistence + scan-band modulations on the cell values
      this._applyPersistence();
      this._applyCellModulations(timeMs);

      // 3. Render stripes into ImageData → stripeCanvas
      this._renderStripes(timeMs);
      this.stripeCtx.putImageData(this.stripeImageData, 0, 0);

      // 4. Compute the bleed by blurring the bleed source canvas. One blur,
      //    one drawImage — the renderer no longer needs the per-channel
      //    extraction + cherry-pick that the cell-grid bleed required.
      //    Browser's canvas filter blurs per-channel under the hood, so a
      //    single blur produces the correct per-channel falloff.
      this._renderBleed();

      // 5. Composite to output: clear, bleed underneath, stripes on top.
      this.ctx.clearRect(0, 0, cw, ch);
      this.ctx.drawImage(this.bleedCanvas, 0, 0);
      const blur = this.opts.phosphorBlurPx;
      if (blur > 0) this.ctx.filter = `blur(${blur}px)`;
      this.ctx.drawImage(this.stripeCanvas, this.bleedMargin, this.bleedMargin);
      if (blur > 0) this.ctx.filter = 'none';
    }

    _sampleCells() {
      // Box-filter downsample: each cell's value is the average of its
      // cs×cs source-pixel block (9 pixels at cs=3), not the single
      // center pixel. This anti-aliases the cell grid against slow-moving
      // content — when the hub's petal edge crosses a cell boundary by a
      // fractional pixel between frames, the box-filter average shifts
      // smoothly instead of binary-flipping the cell on/off. That
      // eliminates the "sparkle" at the rotating hub's periphery that
      // nearest-neighbor-at-center sampling produced. Box-filter is also
      // more faithful to a real Trinitron: the aperture grille samples
      // a stripe-width of the analog signal, not a single point.
      const [vw, vh] = this.opts.viewSize;
      const cs = this.opts.cellSize;
      const cw = this.cellGridW;
      const ch = this.cellGridH;
      const cellPx = cs * cs;

      const imgData = this.signalCtx.getImageData(0, 0, vw, vh);
      const px = imgData.data;

      for (let cy = 0; cy < ch; cy++) {
        for (let cx = 0; cx < cw; cx++) {
          let sR = 0, sG = 0, sB = 0;
          for (let dy = 0; dy < cs; dy++) {
            const sy = cy * cs + dy;
            for (let dx = 0; dx < cs; dx++) {
              const sx = cx * cs + dx;
              const pi = (sy * vw + sx) * 4;
              sR += px[pi];
              sG += px[pi + 1];
              sB += px[pi + 2];
            }
          }
          const ci = cy * cw + cx;
          this.cellsR[ci] = sR / cellPx;
          this.cellsG[ci] = sG / cellPx;
          this.cellsB[ci] = sB / cellPx;
        }
      }
    }

    _applyCellModulations(timeMs) {
      // N2 scan-band: a cosine envelope sweeps top-to-bottom every
      // scanBandPeriodSec. Modulates each cell's brightness uniformly
      // (so the halo derived from these cells also shows the band).
      // ORDER MATTERS: this runs *after* _applyPersistence has snapshotted
      // its prev* buffers. If we ran before, the band would smear into the
      // persistence trail and the sharp top-to-bottom sweep would dissolve
      // into a lagging vertical gradient. Live signal pulses; trail doesn't.
      const ch = this.cellGridH;
      const cw = this.cellGridW;
      const period = this.opts.scanBandPeriodSec;
      const strength = this.opts.scanBandStrength;
      const phase = (timeMs / 1000) / period;

      for (let cy = 0; cy < ch; cy++) {
        const mod = 1 + strength * Math.cos(2 * Math.PI * (cy / ch - phase));
        for (let cx = 0; cx < cw; cx++) {
          const ci = cy * cw + cx;
          this.cellsR[ci] *= mod;
          this.cellsG[ci] *= mod;
          this.cellsB[ci] *= mod;
        }
      }
    }

    _applyPersistence() {
      const p = this.opts.persistence;
      const d = this.opts.perChannelDecay;
      // Clamp at 0.99 to prevent runaway accumulation
      const dr = Math.min(0.99, p * d.r);
      const dg = Math.min(0.99, p * d.g);
      const db = Math.min(0.99, p * d.b);
      const n = this.cellsR.length;
      for (let i = 0; i < n; i++) {
        const decayedR = this.prevR[i] * dr;
        const decayedG = this.prevG[i] * dg;
        const decayedB = this.prevB[i] * db;
        if (decayedR > this.cellsR[i]) this.cellsR[i] = decayedR;
        if (decayedG > this.cellsG[i]) this.cellsG[i] = decayedG;
        if (decayedB > this.cellsB[i]) this.cellsB[i] = decayedB;
      }
      this.prevR.set(this.cellsR);
      this.prevG.set(this.cellsG);
      this.prevB.set(this.cellsB);
    }

    _renderStripes(timeMs) {
      const [vw, vh] = this.opts.viewSize;
      const cs = this.opts.cellSize;
      const cw = this.cellGridW;
      const ch = this.cellGridH;
      const out = this.stripeImageData.data;
      const SCAN_DIM_FACTOR = 0.7;

      // Convergence offsets in source-pixel units. Static base offsets per
      // channel, plus a slow sinusoidal drift.
      const driftAmp = this.opts.convergenceDriftAmplitudePx;
      const driftPhase = (timeMs / 1000) / this.opts.convergenceDriftPeriodSec;
      const drift = driftAmp * Math.sin(2 * Math.PI * driftPhase);
      const c = this.opts.convergence;
      const rdx = c.r[0] + drift;
      const rdy = c.r[1] + drift * 0.6;
      const gdx = c.g[0];
      const gdy = c.g[1];
      const bdx = c.b[0] - drift;
      const bdy = c.b[1] - drift * 0.6;

      const sampleCell = (cells, px, py, dx, dy) => {
        const cx = ((px + dx) / cs) | 0;
        const cy = ((py + dy) / cs) | 0;
        if (cx < 0 || cx >= cw || cy < 0 || cy >= ch) return 0;
        return cells[cy * cw + cx];
      };

      for (let py = 0; py < vh; py++) {
        const cyBase = (py / cs) | 0;
        if (cyBase >= ch) continue;
        const subY = py - cyBase * cs;
        const scanDim = (subY === cs - 1) ? SCAN_DIM_FACTOR : 1.0;

        for (let px = 0; px < vw; px++) {
          const cxBase = (px / cs) | 0;
          if (cxBase >= cw) continue;
          const subX = px - cxBase * cs;
          const oi = (py * vw + px) * 4;

          // F4 hotspot: the exact center pixel of each 3×3 cell gets a
          // brightness boost; every other pixel gets none. Manhattan
          // distance from (cellCenter, cellCenter) with max(0, 1 - d)
          // collapses to "1 at the center, 0 elsewhere" for cs=3 —
          // matches a Trinitron aperture-grille mask hole (bright dot in
          // the middle, dark at the edges).
          const cellCenter = cs >> 1;
          const subDist = Math.abs(subX - cellCenter) + Math.abs(subY - cellCenter);
          const hotMod = 1 + this.opts.hotspot * Math.max(0, 1 - subDist);

          // S2 shimmer: per-cell stable noise scaled by shimmer amplitude
          const ci = cyBase * cw + cxBase;
          const shimMod = 1 + this.opts.shimmer * this.shimmerNoise[ci];

          const totalMod = scanDim * hotMod * shimMod;

          // Phosphor coupling: real Trinitron aperture grilles don't
          // perfectly mask the electron beam — adjacent stripes pick up
          // some bleed. We sample all three channels every pixel and let
          // the non-dominant ones contribute at `coupling` of their cell
          // value. coupling=0 → pure stripe (one channel per pixel, dim
          // and LCD-like); coupling≈0.3 → brighter, softer, more like a
          // real lit phosphor.
          const sR = sampleCell(this.cellsR, px, py, rdx, rdy);
          const sG = sampleCell(this.cellsG, px, py, gdx, gdy);
          const sB = sampleCell(this.cellsB, px, py, bdx, bdy);
          const k = this.opts.phosphorCoupling;
          let r, g, b;
          if (subX === 0)      { r = sR;     g = sG * k; b = sB * k; }
          else if (subX === 1) { r = sR * k; g = sG;     b = sB * k; }
          else                 { r = sR * k; g = sG * k; b = sB;     }

          out[oi]     = Math.min(255, r * totalMod);
          out[oi + 1] = Math.min(255, g * totalMod);
          out[oi + 2] = Math.min(255, b * totalMod);
          // Graded alpha — proportional to the brightest sampled channel
          // (capped at 255). Was binary 0-or-255, which produced a 3px-
          // staircase silhouette edge where lit cells abruptly met
          // transparent cells, reading as a "jagged black outline" with
          // the bleed showing through. Box-filter cell sampling already
          // gives intermediate brightness for edge cells; using that
          // brightness as alpha lets the stripes fade smoothly into the
          // bleed across cell boundaries.
          out[oi + 3] = Math.min(255, Math.max(sR, sG, sB));
        }
      }
    }

    _renderBleed() {
      const [vw, vh] = this.opts.viewSize;
      const [cw, ch] = this.opts.canvasSize;
      const margin = this.bleedMargin;
      // Source: bleedSignalCanvas if the caller supplied a bleedSignal,
      // otherwise fall back to the main signal (which means any display-
      // only effects will bleed into the halo too).
      const source = this.opts.bleedSignal ? this.bleedSignalCanvas : this.signalCanvas;

      // One blur, one drawImage. The canvas filter applies the Gaussian
      // per-channel (so R bleeds out as red, G as green, B as blue —
      // exactly the per-channel additive falloff the SVG #phosphor-bleed
      // filter computes via feColorMatrix + feGaussianBlur + feBlend
      // screen-blend). brightness() boosts the result by bleedIntensity.
      //
      // bleedRadius IS the blur stdDev — visible extent is ~3*stdDev, so a
      // value of 13 reaches ~39 logical units past the silhouette. Keep
      // bleedRadius ≤ (canvasSize - viewSize)/2 or the tail will clip at
      // the canvas edge and the halo will look uneven (asymmetric).
      this.bleedCtx.clearRect(0, 0, cw, ch);
      const bi = this.opts.bleedIntensity;
      this.bleedCtx.filter =
        `blur(${this.bleedRadius}px)` +
        (bi !== 1 ? ` brightness(${bi})` : '');
      this.bleedCtx.drawImage(source, margin, margin);
      this.bleedCtx.filter = 'none';
    }
  }

  window.Trinitron = Trinitron;
})();
