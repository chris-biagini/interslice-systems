// Fraction of a column span whose luminance is ≥ half the span's peak —
// how much of each scanline period the beam fills.
function halfMaxDuty(f, x, y0, y1) {
  let peak = 0;
  for (let y = y0; y < y1; y++) peak = Math.max(peak, f.lum(x, y));
  let n = 0;
  for (let y = y0; y < y1; y++) if (f.lum(x, y) >= 0.5 * peak) n++;
  return n / (y1 - y0);
}

test('beam: energy is preserved on a flat field', () => {
  const crt = makeCRT({ pixelSize: [1280, 960], effects: bare({ beam: true }), signal: flatSignal(linearGray(0.25)) });
  const f = frameAt(crt, 0);
  assertNear(f.meanLum(540, 380, 740, 580), 0.25, 0.25 * 0.05, 'mean linear');
});

test('beam: bright lines swell', () => {
  // 8 output px per scanline so the profile is resolvable.
  const crt = makeCRT({ signalSize: [160, 120], pixelSize: [320, 960], effects: bare({ beam: true }),
    signal: (ctx) => { ctx.fillStyle = linearGray(0.1); ctx.fillRect(0, 0, 160, 60); ctx.fillStyle = linearGray(0.9); ctx.fillRect(0, 60, 160, 60); } });
  const f = frameAt(crt, 0);
  const dim = halfMaxDuty(f, 160, 80, 400);
  const bright = halfMaxDuty(f, 160, 560, 880);
  assert(bright >= 1.3 * dim, `bright duty ${bright.toFixed(3)} vs dim ${dim.toFixed(3)}`);
});

test('beam: no vertical aliasing when scanlines are finer than pixels', () => {
  const crt = makeCRT({ pixelSize: [640, 720], effects: bare({ beam: true }), signal: flatSignal(linearGray(0.5)) });
  const f = frameAt(crt, 0);
  const rows = [];
  for (let y = 100; y < 620; y++) rows.push(f.meanLum(200, y, 440, y + 1));
  const mean = rows.reduce((a, b) => a + b, 0) / rows.length;
  const sd = Math.sqrt(rows.reduce((a, b) => a + (b - mean) ** 2, 0) / rows.length);
  assert(sd / mean < 0.03, `row CV ${(sd / mean * 100).toFixed(2)}%`);
});

test('beam: horizontal focus never collapses below a signal pixel', () => {
  const crt = makeCRT({ pixelSize: [1280, 960], focusPx: 0.6, effects: bare({ beam: true }),
    signal: (ctx) => { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 640, 480); ctx.fillStyle = '#fff'; ctx.fillRect(320, 0, 1, 480); } });
  const f = frameAt(crt, 0);
  let peak = 0;
  for (let x = 620; x < 660; x++) peak = Math.max(peak, f.meanLum(x, 400, x + 1, 560));
  let width = 0;
  for (let x = 620; x < 660; x++) if (f.meanLum(x, 400, x + 1, 560) >= 0.5 * peak) width++;
  assert(width >= 2, `FWHM ${width} output px`);
});
