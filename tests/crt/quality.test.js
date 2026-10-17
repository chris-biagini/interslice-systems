function feed(crt, ms, n) { for (let i = 0; i < n; i++) crt._noteFrameInterval(ms); }

test('quality: sustained slow frames step quality down', () => {
  const crt = makeCRT({ _backendFactory: () => ({ kind: 'fake', hdr: false, outputColorSpace: 'srgb', resize() {}, setSignalSize() {}, upload() {}, render() {}, clearPersistence() {}, readPixels() {}, destroy() {} }), signal: () => {} });
  feed(crt, 16.7, 30);           // learn the display's base interval
  feed(crt, 33.4, 60);           // sustained 2× → one step down
  assert(crt._quality === 1, `quality ${crt._quality}`);
});

test('quality: a brief hitch does not step down', () => {
  const crt = makeCRT({ _backendFactory: () => ({ kind: 'fake', hdr: false, outputColorSpace: 'srgb', resize() {}, setSignalSize() {}, upload() {}, render() {}, clearPersistence() {}, readPixels() {}, destroy() {} }), signal: () => {} });
  feed(crt, 16.7, 30);
  feed(crt, 50, 5);
  feed(crt, 16.7, 100);
  assert(crt._quality === 0, `quality ${crt._quality}`);
});

test('quality: recovers after a long smooth stretch', () => {
  const crt = makeCRT({ _backendFactory: () => ({ kind: 'fake', hdr: false, outputColorSpace: 'srgb', resize() {}, setSignalSize() {}, upload() {}, render() {}, clearPersistence() {}, readPixels() {}, destroy() {} }), signal: () => {} });
  feed(crt, 16.7, 30);
  feed(crt, 33.4, 60);
  feed(crt, 16.7, 700);
  assert(crt._quality === 0, `quality ${crt._quality}`);
});

test('quality: adaptiveQuality false pins full quality', () => {
  const crt = makeCRT({ adaptiveQuality: false, _backendFactory: () => ({ kind: 'fake', hdr: false, outputColorSpace: 'srgb', resize() {}, setSignalSize() {}, upload() {}, render() {}, clearPersistence() {}, readPixels() {}, destroy() {} }), signal: () => {} });
  feed(crt, 16.7, 30);
  feed(crt, 40, 100);
  assert(crt._quality === 0, `quality ${crt._quality}`);
});
