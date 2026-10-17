// Final-review fixes: lifecycle behavior the earlier suites didn't reach.

test('lifecycle: copy-state diff includes hdrHeadroom', () => {
  const crt = makeCRT({ signal: flatSignal('#000') });
  crt.writeParam('hdrHeadroom', 4);
  assert(/opts\.hdrHeadroom = 4/.test(crt.stateDiff()), crt.stateDiff());
});

// The real sizing path: no pixelSize, so the engine's ResizeObserver fits
// the backing store. Sampled inside the same frame, after the engine's
// observer ran (observers fire in creation order) — before the fix the
// resized canvas was blank until the next animation frame.
test('lifecycle: a CSS resize never shows a blank frame', async () => {
  const stage = document.getElementById('stage');
  const c = document.createElement('canvas');
  c.style.width = '320px'; c.style.height = '240px';
  stage.appendChild(c);
  const crt = new CRT(c, { effects: bare(), signal: flatSignal('#fff') });
  try {
    crt.start();
    await new Promise((r) => setTimeout(r, 300));
    const lum = await new Promise((res) => {
      const ro = new ResizeObserver(() => {
        ro.disconnect();
        const d = crt.readPixels();
        let s = 0; for (let i = 1; i < d.length; i += 4) s += d[i];
        res(s / (d.length / 4));
      });
      ro.observe(c);
      requestAnimationFrame(() => { c.style.width = '400px'; c.style.height = '300px'; });
    });
    assert(crt._outSize[0] === Math.round(400 * devicePixelRatio), `fitted ${crt._outSize}`);
    assert(lum > 200, `in-frame level after resize ${lum.toFixed(1)}`);
  } finally { crt.destroy(); c.remove(); }
});
