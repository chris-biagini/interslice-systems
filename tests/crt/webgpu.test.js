// WebGPU backend (phase 2: HDR). The runner passes --enable-unsafe-webgpu,
// so headless Chromium has a SwiftShader (or, with CRT_GPU=1, real) adapter.
async function adapterOrSkip(needCanvasReadback) {
  const a = navigator.gpu && await navigator.gpu.requestAdapter();
  if (!a) skip('no WebGPU adapter');
  // Dawn's SwiftShader fallback adapter can't map a buffer copied from a
  // canvas texture ("external Instance reference no longer exists"); the
  // real GPU can. Parity runs under CRT_GPU=1.
  if (needCanvasReadback && a.info && a.info.isFallbackAdapter) skip('fallback adapter cannot read back a canvas — run with CRT_GPU=1');
}
function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.style.width = (w / devicePixelRatio) + 'px'; c.style.height = (h / devicePixelRatio) + 'px';
  document.getElementById('stage').appendChild(c);
  return c;
}
const liveGpu = [];
afterEachTest(() => { while (liveGpu.length) { const c = liveGpu.pop(); try { c.destroy(); } catch (_) {} c.canvas.remove(); } });

test('webgpu: the uniform packer covers every chassis uniform', () => {
  const crt = makeCRT({ signal: flatSignal('#000') });
  const keys = Object.keys(crt._uniforms(1));
  const missing = keys.filter((k) => !CRT.backends.webgpu.UNIFORM_KEYS.includes(k));
  assert(missing.length === 0, `unpacked: ${missing}`);
});

test('webgpu: CRT.create falls back to WebGL2 when no adapter is offered', async () => {
  const gpu = navigator.gpu;
  const origReq = gpu && gpu.requestAdapter;
  const origMM = window.matchMedia;
  if (gpu) gpu.requestAdapter = async () => null;
  window.matchMedia = (q) => (q === '(dynamic-range: high)' ? { matches: true, addEventListener() {}, removeEventListener() {} } : origMM.call(window, q));
  let crt;
  try { crt = await CRT.create(makeCanvas(320, 240), { pixelSize: [320, 240], signal: flatSignal('#000') }); }
  finally { if (gpu) gpu.requestAdapter = origReq; window.matchMedia = origMM; }
  liveGpu.push(crt);
  assert(crt._backend.kind === 'webgl2', `kind ${crt._backend.kind}`);
});

async function parity(signal, label) {
  await adapterOrSkip(true);
  const opts = { pixelSize: [640, 480], signal, effects: { warmup: false } };
  const gl = makeCRT(Object.assign({}, opts));
  const fGl = frameAt(gl, 0);
  const gpu = await CRT.create(makeCanvas(640, 480), Object.assign({}, opts, { backend: 'webgpu', _testReadback: true }));
  liveGpu.push(gpu);
  assert(gpu._backend.kind === 'webgpu', `kind ${gpu._backend.kind}`);
  gpu.renderFrame(0);
  const d = await gpu.readPixels();
  let sum = 0, max = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) {
    const e = Math.abs(d[i + c] - fGl.data[i + c]); sum += e; n++; if (e > max) max = e;
  }
  const mean = sum / n;
  assert(mean <= 3 && max <= 12, `${label}: mean |Δ| ${mean.toFixed(2)}, max ${max}`);
}

test('webgpu: SDR output matches WebGL2 on a flat field', () => parity(flatSignal(linearGray(0.3)), 'flat'));

test('webgpu: SDR output matches WebGL2 on a detailed chart', () => parity((ctx) => {
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 640, 480);
  ['#ff0', '#0ff', '#0f0', '#f0f', '#f00', '#00f', '#fff'].forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(i * 91, 0, 92, 160); });
  ctx.fillStyle = '#fff'; ctx.font = 'bold 28px sans-serif'; ctx.fillText('Mirepoix — Tonight', 30, 230);
  for (let x = 30; x < 610; x += 13) ctx.fillRect(x, 260, 1, 200);
}, 'chart'));

test('webgpu: SDR canvas is not HDR', async () => {
  await adapterOrSkip();
  const crt = await CRT.create(makeCanvas(320, 240), { backend: 'webgpu', pixelSize: [320, 240], signal: flatSignal('#000') });
  liveGpu.push(crt);
  assert(crt._backend.kind === 'webgpu' && crt._backend.hdr === false, `kind ${crt._backend.kind} hdr ${crt._backend.hdr}`);
});
