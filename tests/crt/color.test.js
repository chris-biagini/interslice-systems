const ramp = (ctx) => {
  const g = ctx.createLinearGradient(0, 0, 640, 0);
  g.addColorStop(0, '#000'); g.addColorStop(1, '#fff');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 640, 480);
};
function rampColumns(f) {
  const v = [];
  for (let x = 0; x < f.w; x++) v.push(f.data[(240 * f.w + x) * 4 + 1]);
  return v;
}

test('color: the soft shoulder never hard-clips', () => {
  // Linear 0 → 2× white. Hard clip pins the top half at 255.
  const crt = makeCRT({ pixelSize: [640, 480], _exposure: 4.0, effects: bare({ tone: true }), signal: ramp });
  const v = rampColumns(frameAt(crt, 0));
  for (let x = 1; x < v.length; x++) assert(v[x] >= v[x - 1], `not monotonic at x=${x}: ${v[x - 1]} → ${v[x]}`);
  const pinned = v.filter((b) => b === 255).length;
  assert(pinned <= v.length * 0.05, `${pinned} of ${v.length} columns pinned at 255`);
});

test('color: without the shoulder, highlights clip (control)', () => {
  const crt = makeCRT({ pixelSize: [640, 480], _exposure: 4.0, effects: bare(), signal: ramp });
  const v = rampColumns(frameAt(crt, 0));
  assert(v.filter((b) => b === 255).length > v.length * 0.3, 'hard clip pins many columns');
});

test('color: tube corners are dark', () => {
  const crt = makeCRT({ pixelSize: [1280, 960], effects: bare({ tubeCorners: true }), signal: flatSignal('#fff') });
  const f = frameAt(crt, 0);
  assert(f.lum(1, 1) < 0.001, `corner ${f.lum(1, 1)}`);
  assert(f.lum(640, 480) > 0.9, `centre ${f.lum(640, 480)}`);
});

test('color: warmup ramps up from dark', () => {
  const crt = makeCRT({ effects: bare({ warmup: true }), signal: flatSignal('#fff') });
  const dark = frameAt(crt, 0).meanLum(200, 150, 440, 330);
  const lit = frameAt(crt, 1500).meanLum(200, 150, 440, 330);
  assert(dark < 0.1 * lit, `t=0 ${dark.toFixed(4)} vs t=1500 ${lit.toFixed(4)}`);
});

test('color: positive temperature warms the picture', () => {
  const crt = makeCRT({ gradeTemperature: 1, effects: bare({ colorGrade: true }), signal: flatSignal(linearGray(0.3)) });
  const p = frameAt(crt, 0).px(320, 240);
  assert(p[0] > p[2], `R ${p[0].toFixed(4)} vs B ${p[2].toFixed(4)}`);
});

test('color: P3 output is selected on wide-gamut displays', () => {
  const orig = window.matchMedia;
  window.matchMedia = (q) => (q === '(color-gamut: p3)' ? { matches: true, addEventListener() {}, removeEventListener() {} } : orig.call(window, q));
  let crt;
  try { crt = makeCRT({ signal: flatSignal('#000') }); } finally { window.matchMedia = orig; }
  assert(crt._backend.outputColorSpace === 'display-p3', `output ${crt._backend.outputColorSpace}`);
});

test('color: curvature bows the raster edges to black', () => {
  const crt = makeCRT({ pixelSize: [1280, 960], curvature: 0.2, effects: bare({ curvature: true }), signal: flatSignal('#fff') });
  const f = frameAt(crt, 0);
  assert(f.lum(2, 480) < 0.01, `edge ${f.lum(2, 480)}`);
  assert(f.lum(640, 480) > 0.9, 'centre still lit');
});
