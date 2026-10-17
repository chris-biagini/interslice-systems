const CLIP = '../../docs/media/tv-sample.mp4';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function makeVideo() {
  const v = document.createElement('video');
  v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'auto';
  v.src = CLIP;
  return v;
}
const loaded = (v) => new Promise((res, rej) => {
  if (v.readyState >= 2) return res();
  v.addEventListener('loadeddata', res, { once: true });
  v.addEventListener('error', () => rej(new Error('video failed to load: ' + (v.error && v.error.message))), { once: true });
});
async function until(fn, maxMs) {
  const t0 = performance.now();
  while (!fn() && performance.now() - t0 < maxMs) await sleep(25);
  return fn();
}

test('video: 16:9 content letterboxes into a 4:3 signal', async () => {
  const v = makeVideo();
  await loaded(v);
  const crt = makeCRT({ effects: bare({ beam: true }), source: new CRT.VideoSource(v, { fit: 'contain' }) });
  const f = frameAt(crt, 0);
  assert(f.meanLum(0, 0, 640, 30) < 0.01, `top bar ${f.meanLum(0, 0, 640, 30)}`);
  assert(f.meanLum(200, 200, 440, 280) > 0.02, `centre ${f.meanLum(200, 200, 440, 280)}`);
});

test('video: nothing uploads before the first frame is ready', () => {
  const v = makeVideo();
  const src = new CRT.VideoSource(v);
  const crt = makeCRT({ effects: bare(), source: src });
  assert(src.poll() === false, 'poll before ready');
  const f = frameAt(crt, 0);
  assert(f.meanLum(0, 0, 640, 480) < 0.001, 'still black');
});

test('video: a paused video parks the renderer and play wakes it', async () => {
  const v = makeVideo();
  await loaded(v);
  const crt = makeCRT({ persistenceHalfLifeMs: 20, effects: bare(), source: new CRT.VideoSource(v) });
  await v.play();
  crt.start();
  assert(await until(() => crt._frameCount > 5, 2000), 'frames while playing');
  v.pause();
  assert(await until(() => crt._mode === 'idle', 3000), `idle after pause, mode ${crt._mode}`);
  await v.play();
  assert(await until(() => crt._mode === 'running', 2000), `running after play, mode ${crt._mode}`);
  v.pause();
});
