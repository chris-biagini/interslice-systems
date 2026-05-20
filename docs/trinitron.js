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
      this.canvas.width = cw * dpr;
      this.canvas.height = ch * dpr;
      this.canvas.style.width = cw + 'px';
      this.canvas.style.height = ch + 'px';
      this.ctx.scale(dpr, dpr);

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

    _frame(/* timeMs */) {
      // No-op placeholder — paint a solid magenta so we can verify the canvas
      // mounted in the right place. Subsequent tasks replace this body.
      const [cw, ch] = this.opts.canvasSize;
      this.ctx.fillStyle = 'rgba(229, 4, 127, 0.85)';
      this.ctx.fillRect(0, 0, cw, ch);
    }
  }

  window.Trinitron = Trinitron;
})();
