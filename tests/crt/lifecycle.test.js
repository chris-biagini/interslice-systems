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

async function needAdapter() {
  const a = navigator.gpu && await navigator.gpu.requestAdapter();
  if (!a) skip('no WebGPU adapter');
}
function gpuCanvas() {
  const c = document.createElement('canvas');
  c.style.width = '320px'; c.style.height = '240px';
  document.getElementById('stage').appendChild(c);
  return c;
}
const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('timeout'), ms))]);

test('lifecycle: a WebGPU pipeline that fails to build falls back to WebGL2', async () => {
  await needAdapter();
  const proto = GPUDevice.prototype;
  const orig = proto.createRenderPipelineAsync;
  proto.createRenderPipelineAsync = function () { return Promise.reject(new Error('simulated WGSL failure')); };
  let crt;
  try { crt = await CRT.create(gpuCanvas(), { backend: 'webgpu', pixelSize: [320, 240], signal: flatSignal('#000') }); }
  finally { proto.createRenderPipelineAsync = orig; }
  try { assert(crt._backend.kind === 'webgl2', `kind ${crt._backend.kind}`); }
  finally { crt.destroy(); crt.canvas.remove(); }
});

test('lifecycle: a WebGPU failure after claiming the canvas is not "WebGL2 unavailable"', async () => {
  await needAdapter();
  const proto = GPUCanvasContext.prototype;
  const orig = proto.configure;
  proto.configure = function () { throw new Error('simulated configure failure'); };
  let err = null;
  const c = gpuCanvas();
  try { await CRT.create(c, { backend: 'webgpu', pixelSize: [320, 240], signal: flatSignal('#000') }); }
  catch (e) { err = e; }
  finally { proto.configure = orig; c.remove(); }
  assert(err, 'expected a rejection');
  assert(!/unavailable/i.test(err.message), `message would latch bypass: ${err.message}`);
});

test('lifecycle: destroying a WebGPU CRT releases its device', async () => {
  await needAdapter();
  const crt = await CRT.create(gpuCanvas(), { backend: 'webgpu', pixelSize: [320, 240], signal: flatSignal('#000') });
  const dev = crt.opts._prepared.device;
  crt.destroy(); crt.canvas.remove();
  const r = await within(dev.lost.then((i) => i.reason), 1500);
  assert(r === 'destroyed', `device lost: ${r}`);
});

test('lifecycle: WebGPU device loss reports through onLost', async () => {
  await needAdapter();
  let lost = null;
  const crt = await CRT.create(gpuCanvas(), { backend: 'webgpu', pixelSize: [320, 240], signal: flatSignal('#000'), onLost: (info) => { lost = info; } });
  try {
    crt.opts._prepared.device.destroy();      // stands in for a GPU reset
    const t0 = performance.now();
    while (!lost && performance.now() - t0 < 1500) await new Promise((r) => setTimeout(r, 25));
    assert(lost, 'onLost called');
    assert(crt._backend === null, 'backend dropped');
  } finally { try { crt.destroy(); } catch (_) {} crt.canvas.remove(); }
});

async function heroFrame(query, width) {
  const f = document.createElement('iframe');
  f.style.cssText = `width:${width}px;height:800px;position:absolute;left:0;top:0;opacity:0.01`;
  f.src = '../../docs/index.html' + query;
  document.body.appendChild(f);
  const w = await new Promise((res) => f.addEventListener('load', () => res(f.contentWindow), { once: true }));
  w.document.documentElement.setAttribute('data-theme', 'dark');
  const t0 = performance.now();
  while (!(w.__crt && w.__crt._frameCount > 5) && performance.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 50));
  return { f, w };
}
const waitFor = async (fn, ms) => { const t0 = performance.now(); while (!fn() && performance.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50)); return fn(); };

test('lifecycle: a failed hero rebuild falls back to the SVG logo', async () => {
  const { f, w } = await heroFrame('?crtBackend=webgl2', 1280);
  try {
    assert(w.document.documentElement.classList.contains('trinitron-active'), 'hero active first');
    w.CRT.create = () => Promise.reject(new Error('simulated rebuild failure'));
    f.style.width = '900px';                     // layout change → rebuild
    const fellBack = await waitFor(() => !w.document.documentElement.classList.contains('trinitron-active'), 3000);
    assert(fellBack, 'class still set after the rebuild failed (SVG hidden, no engine)');
  } finally { f.remove(); }
});

test('lifecycle: the hero rebuilds after WebGPU device loss', async () => {
  const a = navigator.gpu && await navigator.gpu.requestAdapter();
  if (!a) skip('no WebGPU adapter');
  // Dawn's SwiftShader adapter loses canvas-backed devices on its own.
  if (a.info && a.info.isFallbackAdapter) skip('fallback adapter — run with CRT_GPU=1');
  const { f, w } = await heroFrame('?crtBackend=webgpu', 1280);
  try {
    const first = w.__crt;
    assert(first && first._backend.kind === 'webgpu', `backend ${first && first._backend.kind}`);
    first.opts._prepared.device.destroy();       // stands in for a GPU reset
    const rebuilt = await waitFor(() => w.__crt && w.__crt !== first && w.__crt._backend && w.__crt._mode === 'running', 4000);
    assert(rebuilt, 'no running replacement engine');
    assert(w.document.documentElement.classList.contains('trinitron-active'), 'hero active again');
  } finally { f.remove(); }
});
