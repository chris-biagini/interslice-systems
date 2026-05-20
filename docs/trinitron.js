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
        signal: () => {},
        respectReducedMotion: true,
      }, opts);

      const dpr = window.devicePixelRatio || 1;
      const [cw, ch] = this.opts.canvasSize;
      const [vw, vh] = this.opts.viewSize;
      this.canvas.width = cw * dpr;
      this.canvas.height = ch * dpr;
      this.canvas.style.width = cw + 'px';
      this.canvas.style.height = ch + 'px';
      this.ctx.scale(dpr, dpr);
      this.ctx.imageSmoothingEnabled = false;

      // Bleed margin = (canvasSize - viewSize) / 2 per axis
      this.bleedMargin = (cw - vw) / 2;

      // Offscreen signal canvas — caller paints into 200×200 logical coords
      this.signalCanvas = document.createElement('canvas');
      this.signalCanvas.width = vw;
      this.signalCanvas.height = vh;
      this.signalCtx = this.signalCanvas.getContext('2d');
      this.signalCtx.imageSmoothingEnabled = false;

      // Cell grid — one cell per cellSize × cellSize source-pixel block
      const cs = this.opts.cellSize;
      this.cellGridW = Math.floor(vw / cs);  // 66 for default (floor(200/3))
      this.cellGridH = Math.floor(vh / cs);  // 66 for default (floor(200/3))
      const cellCount = this.cellGridW * this.cellGridH;
      this.cellsR = new Float32Array(cellCount);
      this.cellsG = new Float32Array(cellCount);
      this.cellsB = new Float32Array(cellCount);

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

      this._rafHandle = null;
      this._startTime = null;
    }

    start() {
      if (this._rafHandle != null) return;
      this._startTime = performance.now();
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

    _frame(timeMs) {
      const [vw, vh] = this.opts.viewSize;
      const [cw, ch] = this.opts.canvasSize;

      // 1. Capture signal into the offscreen canvas
      this.signalCtx.clearRect(0, 0, vw, vh);
      this.opts.signal(this.signalCtx, timeMs);

      // 2. Sample cells (nearest-neighbor at cell center)
      this._sampleCells();

      // 3. Render RGB stripes into ImageData, then copy to the intermediate
      //    stripeCanvas so we can composite via drawImage in step 4
      this._renderStripes();
      this.stripeCtx.putImageData(this.stripeImageData, 0, 0);

      // 4. Composite to output canvas. drawImage respects alpha (unlike
      //    putImageData), so dark stripe pixels (alpha=0) let any future
      //    bleed layer show through.
      this.ctx.clearRect(0, 0, cw, ch);
      this.ctx.drawImage(this.stripeCanvas, this.bleedMargin, this.bleedMargin);
    }

    _sampleCells() {
      const [vw, vh] = this.opts.viewSize;
      const cs = this.opts.cellSize;
      const cw = this.cellGridW;
      const ch = this.cellGridH;
      const half = Math.floor(cs / 2);

      const imgData = this.signalCtx.getImageData(0, 0, vw, vh);
      const px = imgData.data;

      for (let cy = 0; cy < ch; cy++) {
        const sy = cy * cs + half;
        for (let cx = 0; cx < cw; cx++) {
          const sx = cx * cs + half;
          const pi = (sy * vw + sx) * 4;
          const ci = cy * cw + cx;
          this.cellsR[ci] = px[pi];
          this.cellsG[ci] = px[pi + 1];
          this.cellsB[ci] = px[pi + 2];
        }
      }
    }

    _renderStripes() {
      const [vw, vh] = this.opts.viewSize;
      const cs = this.opts.cellSize;
      const cw = this.cellGridW;
      const ch = this.cellGridH;
      const out = this.stripeImageData.data;

      // Scanline dim factor for the "off" row of each cell. Cell rows 0..cs-2
      // are "lit" (factor 1.0); row cs-1 is "dim" (factor 0.7) — that's the
      // single dim band per cell-row, equivalent to the existing SVG scanline
      // pattern's 1-of-3 dim rows.
      const SCAN_DIM_FACTOR = 0.7;

      for (let py = 0; py < vh; py++) {
        const cy = (py / cs) | 0;
        if (cy >= ch) continue;
        const subY = py - cy * cs;
        const scanDim = (subY === cs - 1) ? SCAN_DIM_FACTOR : 1.0;

        for (let px = 0; px < vw; px++) {
          const cx = (px / cs) | 0;
          if (cx >= cw) continue;
          const subX = px - cx * cs;
          const ci = cy * cw + cx;
          const oi = (py * vw + px) * 4;

          // Stripe assignment by sub-column: 0→R, 1→G, 2→B
          let r = 0, g = 0, b = 0;
          if (subX === 0) r = this.cellsR[ci];
          else if (subX === 1) g = this.cellsG[ci];
          else b = this.cellsB[ci];

          out[oi]     = r * scanDim;
          out[oi + 1] = g * scanDim;
          out[oi + 2] = b * scanDim;
          // Alpha=0 in dark areas so the bleed (to be added in Task 4) shows
          // through. Alpha=255 in lit areas so the sharp stripe color
          // overrides the soft bleed beneath it.
          out[oi + 3] = (r + g + b > 0) ? 255 : 0;
        }
      }
    }
  }

  window.Trinitron = Trinitron;
})();
