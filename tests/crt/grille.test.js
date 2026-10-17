const GRILLE = () => bare({ beam: true, grille: true });

function lineSignal(x) {
  return (ctx) => { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 640, 480); ctx.fillStyle = '#fff'; ctx.fillRect(x, 0, 1, 480); };
}
// Share of total linear light carried by each channel near a vertical line.
function channelShares(f, cx) {
  const s = [0, 0, 0];
  for (let y = 300; y < 340; y++) for (let x = cx - 8; x <= cx + 8; x++) {
    const p = f.px(x, y); s[0] += p[0]; s[1] += p[1]; s[2] += p[2];
  }
  const t = s[0] + s[1] + s[2];
  return s.map((v) => v / t);
}
function assertBalanced(shares, label) {
  for (const v of shares) assert(v >= 0.27 && v <= 0.40, `${label}: shares ${shares.map((v) => v.toFixed(3))}`);
}
// Mean luminance in consecutive windows of exactly `period` px (fractional
// edges weighted), over a column profile averaged across rows y0..y1.
function windowMeans(f, period, y0, y1) {
  const col = new Float64Array(f.w);
  for (let x = 0; x < f.w; x++) col[x] = f.meanLum(x, y0, x + 1, y1);
  const out = [];
  for (let a = period; a + period < f.w - period; a += period) {
    const b = a + period;
    let s = 0;
    for (let x = Math.floor(a); x < Math.ceil(b); x++) s += col[x] * (Math.min(b, x + 1) - Math.max(a, x));
    out.push(s / period);
  }
  return out;
}
const cv = (v) => { const m = v.reduce((a, b) => a + b, 0) / v.length; return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) / m; };

test('grille: a 1-px white line reads white', () => {
  const crt = makeCRT({ pixelSize: [1280, 960], effects: GRILLE(), signal: lineSignal(320) });
  assertBalanced(channelShares(frameAt(crt, 0), 641), 'x=320');
});

test('grille: crosshatch lines are never single-colored', () => {
  for (const x of [100, 101, 102]) {
    const crt = makeCRT({ pixelSize: [1280, 960], effects: GRILLE(), signal: lineSignal(x) });
    assertBalanced(channelShares(frameAt(crt, 0), 2 * x + 1), `x=${x}`);
    crt.destroy();
  }
});

test('grille: no moiré at a fractional pitch', () => {
  const crt = makeCRT({ pixelSize: [1333, 1000], triadTarget: 396, effects: GRILLE(), signal: flatSignal(linearGray(0.3)) });
  const f = frameAt(crt, 0);
  const period = 1333 / crt._triads;
  assertNear(period, 3.37, 0.01, 'triad px');
  const c = cv(windowMeans(f, period, 400, 600));
  assert(c < 0.02, `triad-window CV ${(c * 100).toFixed(2)}%`);
});

test('grille: fractional-DPR widths stay even and defined', () => {
  for (const w of [800, 1000, 1200, 1500]) {
    const h = Math.round(w * 0.75);
    const crt = makeCRT({ pixelSize: [w, h], effects: GRILLE(), signal: flatSignal(linearGray(0.3)) });
    const f = frameAt(crt, 0);
    const c = cv(windowMeans(f, w / crt._triads, Math.round(h * 0.4), Math.round(h * 0.6)));
    assert(c < 0.02, `w=${w}: CV ${(c * 100).toFixed(2)}%`);
    for (let y = 10; y < h - 10; y += 37) assert(f.meanLum(0, y, w, y + 1) > 0, `w=${w}: row ${y} is black`);
    crt.destroy();
  }
});

test('grille: white stays white in SDR', () => {
  const crt = makeCRT({ pixelSize: [1280, 960], effects: GRILLE(), signal: flatSignal('#fff') });
  const f = frameAt(crt, 0);
  assert(f.meanLum(500, 400, 780, 560) >= 0.93, `mean ${f.meanLum(500, 400, 780, 560).toFixed(3)}`);
  let lo = 1e9, hi = 0;
  for (let x = 640; x < 643; x++) { const v = f.meanLum(x, 400, x + 1, 560); lo = Math.min(lo, v); hi = Math.max(hi, v); }
  assert(hi / lo <= 1.15, `triad max/min ${(hi / lo).toFixed(3)}`);
});

test('grille: midtones show the stripes', () => {
  const crt = makeCRT({ pixelSize: [1280, 960], effects: GRILLE(), signal: flatSignal(linearGray(0.15)) });
  const f = frameAt(crt, 0);
  let lo = 1e9, hi = 0;
  for (let x = 640; x < 646; x++) {
    let g = 0;
    for (let y = 400; y < 560; y++) g += f.px(x, y)[1];
    lo = Math.min(lo, g); hi = Math.max(hi, g);
  }
  assert(hi / Math.max(lo, 1e-6) >= 2, `green max/min ${(hi / Math.max(lo, 1e-6)).toFixed(2)}`);
});

test('grille: minimum triad size caps the count', () => {
  const crt = makeCRT({ pixelSize: [1200, 900], minPxPerTriad: 9, effects: GRILLE(), signal: flatSignal('#000') });
  assert(crt._triads === 133, `triads ${crt._triads}`);
});

test('grille: tiny canvas still renders', () => {
  const crt = makeCRT({ pixelSize: [160, 120], effects: GRILLE(), signal: flatSignal('#fff') });
  const f = frameAt(crt, 0);
  assert(crt._triads >= 1, `triads ${crt._triads}`);
  assert(f.meanLum(60, 40, 100, 80) > 0.2, `centre ${f.meanLum(60, 40, 100, 80)}`);
});

test('grille: resize recomputes the triad count', () => {
  const crt = makeCRT({ pixelSize: [2400, 1800], minPxPerTriad: 9, effects: GRILLE(), signal: flatSignal('#000') });
  assert(crt._triads === 266, `before ${crt._triads}`);
  crt.opts.pixelSize = [1200, 900];
  crt.resize();
  assert(crt._triads === 133, `after ${crt._triads}`);
});

test('grille: energy is preserved at any mask softness', () => {
  for (const soft of [0, 0.5, 1]) {
    const crt = makeCRT({ pixelSize: [1333, 1000], triadTarget: 396, maskSoftness: soft, effects: GRILLE(), signal: flatSignal(linearGray(0.25)) });
    assertNear(frameAt(crt, 0).meanLum(540, 380, 740, 580), 0.25, 0.25 * 0.06, `softness ${soft}`);
    crt.destroy();
  }
});
