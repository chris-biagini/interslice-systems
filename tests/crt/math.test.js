const M = () => window.CRT.math;

test('math: triadCount uses the target when the display is large', () => {
  assert(M().triadCount(2400, 560, 3) === 560);
});
test('math: triadCount enforces the minimum triad size', () => {
  assert(M().triadCount(1200, 560, 9) === 133);
});
test('math: triadCount never drops below one triad', () => {
  assert(M().triadCount(10, 560, 9) === 1);
});

test('math: decay is one half after one half-life', () => {
  assertNear(M().decay(58, 58), 0.5, 1e-9);
});
test('math: decay over zero time keeps everything', () => {
  assert(M().decay(0, 58) === 1);
});
test('math: zero half-life means no afterglow', () => {
  assert(M().decay(10, 0) === 0);
});

test('math: srgb encode inverts decode', () => {
  assertNear(M().srgbEncode(M().srgbDecode(0.5)), 0.5, 1e-9);
});
test('math: srgb decode extends past 1.0', () => {
  assert(M().srgbDecode(2.0) > 4);
});

test('math: stripeCoverage over a whole period equals the duty', () => {
  assertNear(M().stripeCoverage(0, 1, 0, 0.25), 0.25, 1e-9);
});
test('math: stripeCoverage fully inside the stripe is 1', () => {
  assertNear(M().stripeCoverage(0.1, 0.2, 0, 0.25), 1, 1e-9);
});
test('math: stripeCoverage fully outside the stripe is 0', () => {
  assertNear(M().stripeCoverage(0.3, 0.4, 0, 0.25), 0, 1e-9);
});
test('math: stripeCoverage straddling the edge is fractional', () => {
  assertNear(M().stripeCoverage(0.2, 0.3, 0, 0.25), 0.5, 1e-9);
});

test('math: mask strength vanishes for full white in SDR', () => {
  assert(M().maskStrengthLimit(1, 1, 0.3, 1) === 0);
});
test('math: mask strength is full for dark values', () => {
  assert(M().maskStrengthLimit(0.2, 1, 0.3, 1) === 1);
});
test('math: HDR headroom keeps most mask strength at white', () => {
  assert(M().maskStrengthLimit(1, 3, 0.3, 1) > 0.8);
});

test('math: fitContain letterboxes 16:9 into 4:3', () => {
  const f = M().fitContain(1920, 1080, 640, 480);
  assert(f.scale[0] === 1, `scale x ${f.scale[0]}`);
  assertNear(f.scale[1], 0.75, 1e-9);
  assertNear(f.offset[1], 0.125, 1e-9);
});
test('math: fitCover crops 16:9 into 4:3', () => {
  const f = M().fitCover(1920, 1080, 640, 480);
  assert(f.scale[1] === 1, `scale y ${f.scale[1]}`);
  assert(f.scale[0] > 1);
});
