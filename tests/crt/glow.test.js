// 40×40 output-px white patch (20×20 signal px) centred on a black field.
const patch = (ctx) => { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 640, 480); ctx.fillStyle = '#fff'; ctx.fillRect(310, 230, 20, 20); };

test('glow: bloom lights the dark next to a bright patch', () => {
  const on = makeCRT({ pixelSize: [1280, 960], effects: bare({ beam: true, bloom: true }), signal: patch });
  const fOn = frameAt(on, 0);
  const off = makeCRT({ pixelSize: [1280, 960], effects: bare({ beam: true }), signal: patch });
  const fOff = frameAt(off, 0);
  // Patch spans output x 620..660; 6 px right of its edge.
  assert(fOn.lum(666, 480) > 0.005, `bloom on: ${fOn.lum(666, 480)}`);
  assert(fOff.lum(666, 480) <= 0.001, `bloom off: ${fOff.lum(666, 480)}`);
});

test('glow: halation reaches far', () => {
  const on = makeCRT({ pixelSize: [1280, 960], effects: bare({ beam: true, halation: true }), signal: patch });
  const off = makeCRT({ pixelSize: [1280, 960], effects: bare({ beam: true }), signal: patch });
  const a = frameAt(on, 0).lum(720, 480), b = frameAt(off, 0).lum(720, 480);
  assert(a > 0.001, `halation on, 60 px out: ${a}`);
  assert(b <= 0.0005, `halation off: ${b}`);
});

test('glow: damper wire casts a faint shadow', () => {
  const crt = makeCRT({ pixelSize: [1280, 960], damperStrength: 0.12, effects: bare({ beam: true, damperWires: true }), signal: flatSignal(linearGray(0.8)) });
  const f = frameAt(crt, 0);
  const y = Math.round(0.32 * 960);
  const wire = f.meanLum(200, y, 1080, y + 1);
  const near = (f.meanLum(200, y - 10, 1080, y - 9) + f.meanLum(200, y + 10, 1080, y + 11)) / 2;
  const r = wire / near;
  assert(r >= 1 - 0.12 - 0.05 && r <= 1 - 0.06, `wire/neighbour ${r.toFixed(3)}`);
});

test('glow: quality 2 drops halation', () => {
  const crt = makeCRT({ pixelSize: [1280, 960], effects: bare({ beam: true, halation: true }), signal: patch });
  crt._quality = 2;
  assert(frameAt(crt, 0).lum(720, 480) <= 0.0005, 'halation skipped');
});
