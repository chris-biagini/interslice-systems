test('pipeline: gray round-trips', () => {
  const crt = makeCRT({ effects: bare(), signal: flatSignal('rgb(128,128,128)') });
  const f = frameAt(crt, 0);
  const i = ((f.h >> 1) * f.w + (f.w >> 1)) * 4;
  assertNear(f.data[i], 128, 3, 'red byte');
  assertNear(f.data[i + 1], 128, 3, 'green byte');
});

test('pipeline: afterglow has an instant attack', () => {
  let white = false;
  const crt = makeCRT({ effects: bare(), signal: (ctx) => flatSignal(white ? '#fff' : '#000')(ctx) });
  frameAt(crt, 0);
  white = true;
  const f = frameAt(crt, 16);
  assert(f.data[((f.h >> 1) * f.w + (f.w >> 1)) * 4 + 1] >= 250, 'white on the first lit frame');
});

test('pipeline: afterglow releases by half per half-life', () => {
  let white = true;
  const crt = makeCRT({ effects: bare(), persistenceHalfLifeMs: 58, signal: (ctx) => flatSignal(white ? '#fff' : '#000')(ctx) });
  for (let t = 0; t <= 100; t += 20) frameAt(crt, t);
  white = false;
  const f = frameAt(crt, 158);
  assertNear(f.lum(f.w >> 1, f.h >> 1), 0.5, 0.04, 'linear after one half-life');
});

test('pipeline: throws "unavailable" without float rendering', () => {
  const proto = WebGL2RenderingContext.prototype;
  const orig = proto.getExtension;
  proto.getExtension = function (name) { return name === 'EXT_color_buffer_float' ? null : orig.call(this, name); };
  let err = null;
  try { makeCRT({ signal: flatSignal('#000') }); } catch (e) { err = e; } finally { proto.getExtension = orig; }
  assert(err && /unavailable/i.test(err.message), `error: ${err && err.message}`);
});

test('pipeline: stop/start never ghosts the previous picture', () => {
  let white = true;
  const crt = makeCRT({ effects: bare(), persistenceHalfLifeMs: 500, signal: (ctx) => flatSignal(white ? '#fff' : '#000')(ctx) });
  for (let t = 0; t <= 64; t += 16) frameAt(crt, t);
  crt.stop();
  crt.start();
  crt.stop();                 // keep the RAF loop out of the measurement
  white = false;
  const f = frameAt(crt, 16);
  assert(f.meanLum(100, 100, 540, 380) < 0.01, `ghost ${f.meanLum(100, 100, 540, 380)}`);
});
