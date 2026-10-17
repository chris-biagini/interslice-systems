#!/usr/bin/env python3
"""Run the CRT test harness in headless Chromium and report.

    python3 tests/crt/run.py [ONLY]        # ONLY filters tests by substring

Serves the repo root on a free localhost port, opens tests/crt/ in
headless /usr/bin/chromium with ?report=1, waits for the harness to POST
its results, prints them, and exits 1 on any failure (or no results).

WebGL defaults to SwiftShader (CPU, deterministic, slow: correctness
only). CRT_GPU=1 uses the real GPU via ANGLE/Vulkan instead.
Stdlib only: no toolchain.
"""
import http.server, json, os, shutil, subprocess, sys, tempfile, threading, urllib.parse

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
CHROMIUM = os.environ.get('CHROMIUM', '/usr/bin/chromium')
TIMEOUT_S = float(os.environ.get('CRT_TEST_TIMEOUT', '600'))
PAGE = os.environ.get('CRT_TEST_PAGE', 'tests/crt/index.html')

results = {}
got = threading.Event()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=REPO, **kw)

    def log_message(self, *a):
        pass

    def do_POST(self):
        if self.path == '/__results':
            n = int(self.headers.get('content-length', 0))
            results.update(json.loads(self.rfile.read(n) or b'{}'))
            self.send_response(204)
            self.end_headers()
            got.set()
        else:
            self.send_error(404)


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else ''
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    q = {'report': '1'}
    if only:
        q['only'] = only
    sep = '&' if '?' in PAGE else '?'
    url = f'http://127.0.0.1:{srv.server_port}/{PAGE}{sep}{urllib.parse.urlencode(q)}'

    gpu = os.environ.get('CRT_GPU') == '1'
    flags = (['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan']
             if gpu else ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
    profile = tempfile.mkdtemp(prefix='crt-test-')
    proc = subprocess.Popen(
        [CHROMIUM, '--headless=new', '--no-first-run', '--no-default-browser-check',
         f'--user-data-dir={profile}', '--autoplay-policy=no-user-gesture-required',
         '--window-size=1400,1100', *flags, *os.environ.get('CRT_CHROMIUM_FLAGS', '').split(), url],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        ok = got.wait(TIMEOUT_S)
    finally:
        proc.terminate()
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(profile, ignore_errors=True)
        srv.shutdown()

    if not ok:
        print(f'NO RESULTS after {TIMEOUT_S:.0f}s ({url})')
        return 1
    if 'perf' in results:
        print('perf:', json.dumps(results['perf']))
    for f in results.get('failures', []):
        print(f"FAIL  {f['name']} — {f['message']}")
    for s in results.get('skips', []):
        print(f"SKIP  {s['name']} — {s['message']}")
    print(f"{results.get('passed', 0)} passed, {results.get('failed', 0)} failed, {results.get('skipped', 0)} skipped")
    return 0 if results.get('failed', 1) == 0 and results.get('passed', 0) > 0 else 1


if __name__ == '__main__':
    sys.exit(main())
