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
        silhouettePath: null,
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

      // Bleed: render cell grid as R/G/B-tinted intermediate at full canvas
      // resolution, then gaussian-blur each. We allocate three offscreen
      // canvases sized to the full canvas (so the blur kernel doesn't
      // truncate at the source region's edge).
      this.bleedRadius = this.opts.bleedRadius != null ? this.opts.bleedRadius : 30;

      // willReadFrequently=true on the bleed channel canvases since _frame
      // calls getImageData on each every frame to merge them.
      this.bleedRCanvas = document.createElement('canvas');
      this.bleedRCanvas.width = cw;
      this.bleedRCanvas.height = ch;
      this.bleedRCtx = this.bleedRCanvas.getContext('2d', { willReadFrequently: true });

      this.bleedGCanvas = document.createElement('canvas');
      this.bleedGCanvas.width = cw;
      this.bleedGCanvas.height = ch;
      this.bleedGCtx = this.bleedGCanvas.getContext('2d', { willReadFrequently: true });

      this.bleedBCanvas = document.createElement('canvas');
      this.bleedBCanvas.width = cw;
      this.bleedBCanvas.height = ch;
      this.bleedBCtx = this.bleedBCanvas.getContext('2d', { willReadFrequently: true });

      // ImageData for painting cell grids into the bleed canvases
      this.cellPaintW = this.cellGridW;
      this.cellPaintH = this.cellGridH;
      this.cellPaintImageData = this.bleedRCtx.createImageData(this.cellPaintW, this.cellPaintH);

      // Bleed merge canvas: holds the per-channel-merged RGB image at
      // canvas-logical resolution (cw × ch). We putImageData into this
      // intermediate, then drawImage onto the main output — that way the
      // main ctx's dpr scale transform is respected (putImageData would
      // ignore it and only fill the top-left cw × ch device pixels).
      this.bleedMergeCanvas = document.createElement('canvas');
      this.bleedMergeCanvas.width = cw;
      this.bleedMergeCanvas.height = ch;
      this.bleedMergeCtx = this.bleedMergeCanvas.getContext('2d');
      this.bleedMergeImageData = this.bleedMergeCtx.createImageData(cw, ch);

      // Silhouette path (for clipping the bleed). Pre-create a Path2D from
      // the SVG path string if provided. Default null = no silhouette clip.
      // Stored but not yet used; the natural blur falloff currently provides
      // the finite extent.
      this.silhouettePath = this.opts.silhouettePath
        ? new Path2D(this.opts.silhouettePath)
        : null;

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

      // 1. Capture signal
      this.signalCtx.clearRect(0, 0, vw, vh);
      this.opts.signal(this.signalCtx, timeMs);

      // 2. Sample cells
      this._sampleCells();

      // 3. Render stripes into ImageData → stripeCanvas
      this._renderStripes();
      this.stripeCtx.putImageData(this.stripeImageData, 0, 0);

      // 4. Render bleed into the three per-channel canvases
      this._renderBleed();

      // 5. Composite to output: bleed first, then stripes on top
      this.ctx.clearRect(0, 0, cw, ch);

      // Bleed: merge three per-channel blurred canvases into a single RGB
      // image. Each source canvas was painted with v in all of R/G/B
      // (grayscale) and blurred — so rPix[i], rPix[i+1], rPix[i+2] are equal
      // per pixel of the R-blur. We cherry-pick channel-by-channel to build
      // the merged result, then putImageData into an intermediate canvas
      // (which has no scale transform), and finally drawImage onto the main
      // output so the dpr scale is respected.
      const bd = this.bleedMergeImageData.data;
      const rPix = this.bleedRCtx.getImageData(0, 0, cw, ch).data;
      const gPix = this.bleedGCtx.getImageData(0, 0, cw, ch).data;
      const bPix = this.bleedBCtx.getImageData(0, 0, cw, ch).data;
      for (let i = 0; i < bd.length; i += 4) {
        bd[i]     = rPix[i];     // R from R-blur
        bd[i + 1] = gPix[i + 1]; // G from G-blur
        bd[i + 2] = bPix[i + 2]; // B from B-blur
        // Alpha = brightness of the most-lit channel at this pixel. Dark
        // (zero) bleed pixels stay transparent so the page bg shows through.
        bd[i + 3] = Math.max(rPix[i], gPix[i + 1], bPix[i + 2]);
      }
      this.bleedMergeCtx.putImageData(this.bleedMergeImageData, 0, 0);
      // drawImage respects the dpr scale on this.ctx, so the cw × ch bleed
      // image gets stretched to fill the full canvas correctly.
      this.ctx.drawImage(this.bleedMergeCanvas, 0, 0);

      // Stripes on top via drawImage (NOT putImageData — drawImage respects
      // alpha so dark stripe pixels let the bleed show through; putImageData
      // would overwrite and erase the bleed in source-region-but-unlit areas).
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

    _renderBleed() {
      const [vw, vh] = this.opts.viewSize;
      const [cw, ch] = this.opts.canvasSize;
      const margin = this.bleedMargin;
      const cellsX = this.cellGridW;
      const cellsY = this.cellGridH;

      // Paint cells into a small ImageData (cellGridW × cellGridH).
      // R-channel: store R intensity in all three channels (so the upscale
      // is a single grayscale-ish source representing R brightness).
      // Repeat for G and B.
      const paintChannel = (cells, ctx) => {
        const pd = this.cellPaintImageData.data;
        for (let i = 0, j = 0; i < cells.length; i++, j += 4) {
          const v = cells[i];
          pd[j]     = v;
          pd[j + 1] = v;
          pd[j + 2] = v;
          pd[j + 3] = 255;
        }
        // Paint into a temporary 1×1-per-cell-block area, then drawImage with
        // scaling to enlarge it across the bleed canvas.
        ctx.clearRect(0, 0, cw, ch);
        // Use a temp canvas to upscale via drawImage
        const tmp = this._bleedPaintTmp || (this._bleedPaintTmp = document.createElement('canvas'));
        if (tmp.width !== cellsX || tmp.height !== cellsY) {
          tmp.width = cellsX;
          tmp.height = cellsY;
        }
        const tmpCtx = tmp.getContext('2d');
        tmpCtx.putImageData(this.cellPaintImageData, 0, 0);
        // Smoothing ON for the upscale — that's the "blur from blocks" base.
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.filter = `blur(${Math.round(this.bleedRadius * 0.7)}px)`;
        ctx.drawImage(tmp, margin, margin, vw, vh);
        ctx.filter = 'none';
      };

      paintChannel(this.cellsR, this.bleedRCtx);
      paintChannel(this.cellsG, this.bleedGCtx);
      paintChannel(this.cellsB, this.bleedBCtx);
    }
  }

  window.Trinitron = Trinitron;
})();
