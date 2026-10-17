// Minimal in-browser test harness for the CRT engine. No dependencies.
// Suites call test(name, fn); fn may be async. Results land in
// window.__results and, with ?report=1, are POSTed to /__results
// (tests/crt/run.py listens there).
(function () {
  'use strict';
  const tests = [];
  const afterEachHooks = [];

  window.test = (name, fn) => tests.push({ name, fn });
  window.afterEachTest = (fn) => afterEachHooks.push(fn);
  window.assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };
  window.assertNear = (actual, expected, tol, msg) => {
    if (!(Math.abs(actual - expected) <= tol)) {
      throw new Error(`${msg ? msg + ': ' : ''}expected ${expected} ± ${tol}, got ${actual}`);
    }
  };
  // Throw from inside a test to mark it skipped (e.g. no WebGPU adapter).
  window.skip = (msg) => { const e = new Error(msg); e.skip = true; throw e; };

  const R = window.__results = { done: false, passed: 0, failed: 0, skipped: 0, failures: [], skips: [] };
  const pageErrors = [];
  window.addEventListener('error', (e) => pageErrors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => pageErrors.push(String(e.reason)));

  const TIMEOUT_MS = 30000;
  const withTimeout = (p) => Promise.race([
    p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${TIMEOUT_MS} ms`)), TIMEOUT_MS)),
  ]);

  async function run() {
    const params = new URLSearchParams(location.search);
    const only = params.get('only');
    const out = document.getElementById('out');
    for (const t of tests) {
      if (only && !t.name.includes(only)) continue;
      let line;
      try {
        await withTimeout(Promise.resolve().then(t.fn));
        R.passed++;
        line = `PASS  ${t.name}`;
      } catch (e) {
        if (e && e.skip) { R.skipped++; R.skips.push({ name: t.name, message: e.message }); line = `SKIP  ${t.name} — ${e.message}`; }
        else { R.failed++; R.failures.push({ name: t.name, message: String(e && e.message || e) }); line = `FAIL  ${t.name} — ${e && e.message}`; }
      }
      for (const h of afterEachHooks) { try { await h(); } catch (_) { /* cleanup must not fail a test */ } }
      if (out) out.textContent += line + '\n';
    }
    if (pageErrors.length) {
      R.failed++;
      R.failures.push({ name: '(page errors)', message: pageErrors.join(' | ') });
    }
    R.done = true;
    if (out) out.textContent += `\n${R.passed} passed, ${R.failed} failed, ${R.skipped} skipped\n`;
    if (params.get('report') === '1') {
      try { await fetch('/__results', { method: 'POST', body: JSON.stringify(R) }); } catch (_) { /* runner times out */ }
    }
  }
  window.addEventListener('load', () => setTimeout(run, 0));
})();
