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
        // Sampling pipeline. 'cell' averages each cell's 3×3 source block
        // into one (R,G,B) and then synthesizes stripes from that triple —
        // simple but collapses per-stripe detail, so edge cells flicker as
        // single-hue blocks. 'beam' samples each stripe column separately
        // (one source-pixel-wide vertical slice per stripe, alpha-weighted)
        // so cellsR/G/B hold per-stripe brightness directly — proper triad
        // structure at edges, no alpha-ignoring artifact, no need to use
        // phosphorCoupling to compensate for cell-flattening brightness loss.
        samplingMode: 'cell',
        // In beam mode, pure-channel-per-column rendering produces ~1/3 the
        // average brightness of cell-mode's coupled stripes. Multiplier here
        // restores apparent brightness; tune alongside bleedIntensity.
        beamBrightnessBoost: 1.0,
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
      // willReadFrequently=true since _sampleCells reads the whole canvas
      // back every frame.
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

      // Beam-mode per-column RGB buffers — each cell stores three (R, G, B)
      // triples, one per stripe column. Layout is interleaved: cellsColR
      // [ci*3 + ch] where ch is the channel index (0=R, 1=G, 2=B). The
      // three buffers correspond to the three stripe columns (subX 0/1/2).
      //
      // The extra storage (9 floats per cell vs the 3 used by cell mode)
      // is what lets edge cells expose per-stripe brightness gradients
      // while interior cells render identically to cell mode: when all
      // three columns sample the same source color, cellsColR/G/B end up
      // equal and the existing cell-mode coupling formula in
      // _renderStripes produces the same per-stripe pattern.
      this.cellsColR = new Float32Array(cellCount * 3);
      this.cellsColG = new Float32Array(cellCount * 3);
      this.cellsColB = new Float32Array(cellCount * 3);
      this.prevColR  = new Float32Array(cellCount * 3);
      this.prevColG  = new Float32Array(cellCount * 3);
      this.prevColB  = new Float32Array(cellCount * 3);

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
      this.prevColR.fill(0); this.prevColG.fill(0); this.prevColB.fill(0);
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

      // 2. Sample cells, decay against last frame, then modulate. Beam
      //    mode swaps the sampler (per-stripe alpha-weighted) and the
      //    persistence (symmetric lerp instead of asymmetric max), but
      //    the rest of the pipeline is shared.
      if (this.opts.samplingMode === 'beam') {
        this._sampleBeams();
        this._applyPersistenceBeam();
      } else {
        this._sampleCells();
        this._applyPersistence();
      }
      this._applyCellModulations(timeMs);

      // 3. Render the aperture-grille stripes into ImageData → stripeCanvas.
      this._renderStripes(timeMs);
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

    _sampleBeams() {
      // Beam-style per-column RGB sampling: each cell has three stripe
      // columns, each column samples its cs source pixels (alpha-weighted)
      // and stores the full (R, G, B) average — three RGB triples per cell.
      //
      // Why all three channels per column instead of just the matching one?
      // The matching-channel-only version (the first beam-mode iteration)
      // gave proper edge triads but discarded interior brightness: a
      // saturated red pixel lit only the R stripe (G and B columns saw
      // red pixels but extracted G=0 and B=0). That read as harsh LCD
      // structure. Storing the full RGB lets _renderStripes reuse the
      // existing cell-mode coupling formula, which fills in the dark
      // stripes for uniform cells (interior matches cell mode exactly)
      // while keeping per-column gradients at edges (the structural fix).
      //
      // Alpha-weighting is preserved: a half-covered AA fringe pixel
      // contributes half its color value to its column's average.
      const [vw, vh] = this.opts.viewSize;
      const cs = this.opts.cellSize;
      const cw = this.cellGridW;
      const ch = this.cellGridH;
      const boost = this.opts.beamBrightnessBoost;
      const colR = this.cellsColR;
      const colG = this.cellsColG;
      const colB = this.cellsColB;

      const imgData = this.signalCtx.getImageData(0, 0, vw, vh);
      const px = imgData.data;

      for (let cy = 0; cy < ch; cy++) {
        for (let cx = 0; cx < cw; cx++) {
          // Nine accumulators: three columns × three channels.
          let r0r = 0, r0g = 0, r0b = 0;
          let g0r = 0, g0g = 0, g0b = 0;
          let b0r = 0, b0g = 0, b0b = 0;
          for (let dy = 0; dy < cs; dy++) {
            const sy = cy * cs + dy;
            const rowBase = sy * vw;
            // R stripe column (dx=0) — sample all three source channels,
            // alpha-weighted.
            let pi = (rowBase + cx * cs) * 4;
            let aw = px[pi + 3] / 255;
            r0r += px[pi]     * aw;
            r0g += px[pi + 1] * aw;
            r0b += px[pi + 2] * aw;
            // G stripe column (dx=1)
            pi = (rowBase + cx * cs + 1) * 4;
            aw = px[pi + 3] / 255;
            g0r += px[pi]     * aw;
            g0g += px[pi + 1] * aw;
            g0b += px[pi + 2] * aw;
            // B stripe column (dx=2)
            pi = (rowBase + cx * cs + 2) * 4;
            aw = px[pi + 3] / 255;
            b0r += px[pi]     * aw;
            b0g += px[pi + 1] * aw;
            b0b += px[pi + 2] * aw;
          }
          // Divide by cs (3 pixels averaged per column), apply boost,
          // store interleaved as [R, G, B] per cell in each column buffer.
          const ci3 = (cy * cw + cx) * 3;
          const inv = boost / cs;
          colR[ci3]     = r0r * inv;
          colR[ci3 + 1] = r0g * inv;
          colR[ci3 + 2] = r0b * inv;
          colG[ci3]     = g0r * inv;
          colG[ci3 + 1] = g0g * inv;
          colG[ci3 + 2] = g0b * inv;
          colB[ci3]     = b0r * inv;
          colB[ci3 + 1] = b0g * inv;
          colB[ci3 + 2] = b0b * inv;
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
      const isBeam = this.opts.samplingMode === 'beam';

      for (let cy = 0; cy < ch; cy++) {
        const mod = 1 + strength * Math.cos(2 * Math.PI * (cy / ch - phase));
        if (isBeam) {
          // Modulate all 9 values per cell (3 columns × 3 channels). The
          // band is a brightness envelope, so applying it uniformly across
          // each column's RGB preserves hue while pulsing brightness.
          const colR = this.cellsColR, colG = this.cellsColG, colB = this.cellsColB;
          for (let cx = 0; cx < cw; cx++) {
            const i3 = (cy * cw + cx) * 3;
            colR[i3] *= mod; colR[i3 + 1] *= mod; colR[i3 + 2] *= mod;
            colG[i3] *= mod; colG[i3 + 1] *= mod; colG[i3 + 2] *= mod;
            colB[i3] *= mod; colB[i3 + 1] *= mod; colB[i3 + 2] *= mod;
          }
        } else {
          for (let cx = 0; cx < cw; cx++) {
            const ci = cy * cw + cx;
            this.cellsR[ci] *= mod;
            this.cellsG[ci] *= mod;
            this.cellsB[ci] *= mod;
          }
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

    _applyPersistenceBeam() {
      // Symmetric exponential smoothing: new value = prev*decay + live*(1-decay).
      // Cell-mode persistence uses max(prev*decay, new), which preserves peaks
      // but produces asymmetric flicker — upward pulses appear instantly while
      // downward ones smooth out. For beam-style per-stripe samples we want
      // rise and fall to be smoothed equally, since the AA fringe at the disk
      // perimeter generates symmetric per-frame fluctuations rather than rare
      // bright transients we'd want to preserve.
      //
      // Each cell stores three (R, G, B) triples — one per stripe column.
      // The per-channel decay (dr/dg/db) applies to the matching channel
      // within each triple, so all three columns get the same per-channel
      // behavior. Stride-3 inner unrolled to keep the JIT happy.
      //
      // First-frame cost: prev is zero on start(), so the image fades in
      // over ~1/(1-dr) frames (≈7 frames at dr=0.85, ~110ms).
      const p = this.opts.persistence;
      const d = this.opts.perChannelDecay;
      const dr = Math.min(0.99, p * d.r);
      const dg = Math.min(0.99, p * d.g);
      const db = Math.min(0.99, p * d.b);
      const ar = 1 - dr, ag = 1 - dg, ab = 1 - db;
      const colR = this.cellsColR, colG = this.cellsColG, colB = this.cellsColB;
      const prR = this.prevColR, prG = this.prevColG, prB = this.prevColB;
      const n = colR.length;
      for (let i = 0; i < n; i += 3) {
        colR[i]     = prR[i]     * dr + colR[i]     * ar;
        colR[i + 1] = prR[i + 1] * dg + colR[i + 1] * ag;
        colR[i + 2] = prR[i + 2] * db + colR[i + 2] * ab;
        colG[i]     = prG[i]     * dr + colG[i]     * ar;
        colG[i + 1] = prG[i + 1] * dg + colG[i + 1] * ag;
        colG[i + 2] = prG[i + 2] * db + colG[i + 2] * ab;
        colB[i]     = prB[i]     * dr + colB[i]     * ar;
        colB[i + 1] = prB[i + 1] * dg + colB[i + 1] * ag;
        colB[i + 2] = prB[i + 2] * db + colB[i + 2] * ab;
      }
      prR.set(colR);
      prG.set(colG);
      prB.set(colB);
    }

    _renderStripes(timeMs) {
      const [vw, vh] = this.opts.viewSize;
      const cs = this.opts.cellSize;
      const cw = this.cellGridW;
      const ch = this.cellGridH;
      const out = this.stripeImageData.data;
      const SCAN_DIM_FACTOR = 0.7;

      // Convergence offsets in source-pixel units: static per-channel base
      // plus a slow sin drift. Vertical drift is gentler than horizontal —
      // beam alignment is more forgiving on the long axis of the tube.
      const driftAmp = this.opts.convergenceDriftAmplitudePx;
      const drift = driftAmp === 0
        ? 0
        : driftAmp * Math.sin(2 * Math.PI * (timeMs / 1000) / this.opts.convergenceDriftPeriodSec);
      const c = this.opts.convergence;
      const rdx = c.r[0] + drift;
      const rdy = c.r[1] + drift * 0.6;
      const gdx = c.g[0];
      const gdy = c.g[1];
      const bdx = c.b[0] - drift;
      const bdy = c.b[1] - drift * 0.6;

      // Hoist hot-loop reads out of the 40k-iter inner body.
      const hotspot = this.opts.hotspot;
      const shimmer = this.opts.shimmer;
      // Coupling is the same in both modes now. In cell mode it spills the
      // cell's averaged hue into adjacent stripes. In beam mode it spills
      // each stripe-column's per-channel sample into adjacent stripes —
      // for uniform interior cells the per-column buffers are equal, so
      // the result matches cell mode exactly. At edges, the per-column
      // buffers diverge and each stripe ends up with its own brightness.
      const k = this.opts.phosphorCoupling;
      const isBeam = this.opts.samplingMode === 'beam';
      const cellsR = this.cellsR, cellsG = this.cellsG, cellsB = this.cellsB;
      const colR = this.cellsColR, colG = this.cellsColG, colB = this.cellsColB;
      const shim = this.shimmerNoise;
      const cellCenter = cs >> 1;
      const invCs = 1 / cs;

      for (let py = 0; py < vh; py++) {
        const cyBase = (py * invCs) | 0;
        if (cyBase >= ch) continue;
        const subY = py - cyBase * cs;
        const scanDim = (subY === cs - 1) ? SCAN_DIM_FACTOR : 1.0;
        const distY = subY - cellCenter; const aDistY = distY < 0 ? -distY : distY;

        // Per-channel sample row index after convergence drift. Inline so
        // we can do bounds check + index once per pixel instead of via a
        // sampleCell closure (called 3× per pixel = 120k calls/frame).
        const rcy = ((py + rdy) * invCs) | 0;
        const gcy = ((py + gdy) * invCs) | 0;
        const bcy = ((py + bdy) * invCs) | 0;
        const rRow = (rcy >= 0 && rcy < ch) ? rcy * cw : -1;
        const gRow = (gcy >= 0 && gcy < ch) ? gcy * cw : -1;
        const bRow = (bcy >= 0 && bcy < ch) ? bcy * cw : -1;

        for (let px = 0; px < vw; px++) {
          const cxBase = (px * invCs) | 0;
          if (cxBase >= cw) continue;
          const subX = px - cxBase * cs;
          const oi = (py * vw + px) * 4;

          // F4 hotspot — boost the cs×cs cell's exact center pixel; for
          // cs=3 the Manhattan-distance max(0, 1−d) collapses to "1 at the
          // center, 0 elsewhere," matching a Trinitron aperture-grille hole.
          const distX = subX - cellCenter; const aDistX = distX < 0 ? -distX : distX;
          const subDist = aDistX + aDistY;
          const hotMod = subDist > 1 ? 1 : 1 + hotspot * (1 - subDist);

          // S2 shimmer — stable per-cell brightness noise.
          const ci = cyBase * cw + cxBase;
          const shimMod = 1 + shimmer * shim[ci];
          const totalMod = scanDim * hotMod * shimMod;

          // Per-channel cell sample with convergence offsets applied.
          // In beam mode, subX picks which per-column buffer to read from
          // (R-stripe column → colR, etc.); the R/G/B channels each still
          // come from the convergence-shifted cell so the chromatic fringe
          // works identically. In cell mode, all three reads hit the same
          // per-cell channel buffer.
          const rcx = ((px + rdx) * invCs) | 0;
          const gcx = ((px + gdx) * invCs) | 0;
          const bcx = ((px + bdx) * invCs) | 0;
          let sR = 0, sG = 0, sB = 0;
          if (isBeam) {
            const cells = subX === 0 ? colR : (subX === 1 ? colG : colB);
            if (rRow !== -1 && rcx >= 0 && rcx < cw) sR = cells[(rRow + rcx) * 3];
            if (gRow !== -1 && gcx >= 0 && gcx < cw) sG = cells[(gRow + gcx) * 3 + 1];
            if (bRow !== -1 && bcx >= 0 && bcx < cw) sB = cells[(bRow + bcx) * 3 + 2];
          } else {
            if (rRow !== -1 && rcx >= 0 && rcx < cw) sR = cellsR[rRow + rcx];
            if (gRow !== -1 && gcx >= 0 && gcx < cw) sG = cellsG[gRow + gcx];
            if (bRow !== -1 && bcx >= 0 && bcx < cw) sB = cellsB[bRow + bcx];
          }

          let r, g, b;
          if (subX === 0)      { r = sR;     g = sG * k; b = sB * k; }
          else if (subX === 1) { r = sR * k; g = sG;     b = sB * k; }
          else                 { r = sR * k; g = sG * k; b = sB;     }

          r *= totalMod; g *= totalMod; b *= totalMod;
          out[oi]     = r > 255 ? 255 : r;
          out[oi + 1] = g > 255 ? 255 : g;
          out[oi + 2] = b > 255 ? 255 : b;
          // Graded alpha = brightest sampled channel — lets box-filtered
          // edge cells fade smoothly into the bleed instead of staircasing.
          const a = sR > sG ? (sR > sB ? sR : sB) : (sG > sB ? sG : sB);
          out[oi + 3] = a > 255 ? 255 : a;
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
