// Test helpers shared by the CRT suites.
(function () {
  'use strict';
  const live = [];

  // A CRT on a fresh canvas at an exact device-pixel size. The canvas is
  // laid out at pixelSize / devicePixelRatio CSS px so ResizeObserver
  // agrees with pixelSize; pixelSize still wins inside the engine.
  window.makeCRT = (opts = {}) => {
    const stage = document.getElementById('stage');
    const canvas = document.createElement('canvas');
    const [w, h] = opts.pixelSize || [640, 480];
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = (w / dpr) + 'px';
    canvas.style.height = (h / dpr) + 'px';
    stage.appendChild(canvas);
    const crt = new window.CRT(canvas, Object.assign({ pixelSize: [w, h], debugOverlay: false }, opts));
    live.push(crt);
    return crt;
  };

  window.afterEachTest(() => {
    while (live.length) {
      const c = live.pop();
      try { c.destroy(); } catch (_) { /* already gone */ }
      if (c.canvas && c.canvas.parentNode) c.canvas.parentNode.removeChild(c.canvas);
    }
  });

  window.srgbToLinear = (v8) => {
    const v = v8 / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };

  // Signal painter that fills the whole frame with one CSS color.
  window.flatSignal = (css) => (ctx) => {
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  };

  // Linear-light CSS gray (exact sRGB encode of a linear value).
  window.linearGray = (l) => {
    const e = l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
    const v = Math.round(Math.max(0, Math.min(1, e)) * 255);
    return `rgb(${v},${v},${v})`;
  };

  // Render one frame at timeMs and return a reader over the output.
  //   px(x, y) → [r, g, b] linear; rows are top-first.
  window.frameAt = (crt, timeMs) => {
    crt.renderFrame(timeMs);
    const data = crt.readPixels();
    const [w, h] = crt._outSize;
    const lut = new Float32Array(256);
    for (let i = 0; i < 256; i++) lut[i] = window.srgbToLinear(i);
    return {
      w, h, data,
      px(x, y) { const i = (y * w + x) * 4; return [lut[data[i]], lut[data[i + 1]], lut[data[i + 2]]]; },
      lum(x, y) { const p = this.px(x, y); return 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]; },
      meanLum(x0, y0, x1, y1) {
        let s = 0, n = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += this.lum(x, y); n++; }
        return s / n;
      },
    };
  };
})();
