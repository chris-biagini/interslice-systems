// Scheduler/sizing tests run against a fake backend, so they need no GPU.
function fakeBackend(log) {
  return (canvas, ctx) => {
    log.created = (log.created || 0) + 1;
    return {
      kind: 'fake', hdr: false, outputColorSpace: 'srgb',
      resize(w, h) { log.resize = [w, h]; },
      setSignalSize(w, h) { log.signalSize = [w, h]; },
      upload() { log.uploads = (log.uploads || 0) + 1; },
      render() { log.renders = (log.renders || 0) + 1; },
      clearPersistence() {},
      readPixels() { return new Uint8Array(4); },
      destroy() { log.destroyed = true; },
    };
  };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Poll until the renderer parks (late observer callbacks may wake it once).
async function untilIdle(crt, maxMs = 3000) {
  const t0 = performance.now();
  while (crt._mode !== 'idle' && performance.now() - t0 < maxMs) await wait(25);
  return crt._mode;
}

test('scheduler: static signal parks', async () => {
  const log = {};
  let painted = false;
  const crt = makeCRT({ _backendFactory: fakeBackend(log), persistenceHalfLifeMs: 58,
    signal: () => { if (painted) return false; painted = true; } });
  crt.start();
  await wait(58 * 8);
  assert(await untilIdle(crt) === 'idle', `mode ${crt._mode}`);
});

test('scheduler: requestRender wakes a parked renderer', async () => {
  const log = {};
  const crt = makeCRT({ _backendFactory: fakeBackend(log), persistenceHalfLifeMs: 10, signal: () => false });
  crt.start();
  assert(await untilIdle(crt) === 'idle', `parked first, mode ${crt._mode}`);
  crt.requestRender();
  assert(crt._mode === 'running', `mode ${crt._mode}`);
});

test('scheduler: stop clears user intent', async () => {
  const crt = makeCRT({ _backendFactory: fakeBackend({}), signal: () => {} });
  crt.start();
  crt.stop();
  crt.requestRender();
  assert(crt._mode === 'stopped', `mode ${crt._mode}`);
});

test('scheduler: an animated signal never parks', async () => {
  const crt = makeCRT({ _backendFactory: fakeBackend({}), persistenceHalfLifeMs: 10, signal: () => undefined });
  crt.start();
  await wait(600);
  assert(crt._mode === 'running', `mode ${crt._mode}`);
});

test('scheduler: context restore asks the signal to repaint', async () => {
  const log = {};
  const seen = [];
  const crt = makeCRT({ _backendFactory: fakeBackend(log), signal: (ctx, t, needsRepaint) => { seen.push(needsRepaint); return false; } });
  crt.renderFrame(0);
  crt.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
  crt.canvas.dispatchEvent(new Event('webglcontextrestored'));
  crt.renderFrame(16);
  assert(log.created === 2, `backend rebuilt (created ${log.created})`);
  assert(seen[seen.length - 1] === true, `needsRepaint ${seen[seen.length - 1]}`);
});

test('scheduler: pixelSize is honored', () => {
  const log = {};
  makeCRT({ _backendFactory: fakeBackend(log), pixelSize: [300, 200], signal: () => {} });
  assert(log.resize && log.resize[0] === 300 && log.resize[1] === 200, `resize ${log.resize}`);
});

test('scheduler: signalSize reaches the backend', () => {
  const log = {};
  makeCRT({ _backendFactory: fakeBackend(log), signalSize: [320, 180], signal: () => {} });
  assert(log.signalSize[0] === 320 && log.signalSize[1] === 180, `signalSize ${log.signalSize}`);
});

test('scheduler: destroy releases the backend', () => {
  const log = {};
  const crt = makeCRT({ _backendFactory: fakeBackend(log), signal: () => {} });
  crt.destroy();
  assert(log.destroyed === true);
});
