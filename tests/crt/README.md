# CRT engine tests

In-browser harness for `docs/crt.js` + its backends. Plain HTML/JS, no
toolchain; lives outside `docs/`, so it never deploys.

## Run

    python3 tests/crt/run.py            # whole suite
    python3 tests/crt/run.py beam       # tests whose name contains "beam"

The runner serves the repo root on a free localhost port, opens
`tests/crt/index.html?report=1` in headless `/usr/bin/chromium`, waits for
the harness to POST its results, prints failures, and exits 1 on any
failure.

- WebGL defaults to **SwiftShader** (CPU): deterministic and correct, but
  slow. Use it for correctness, never for performance numbers.
- `CRT_GPU=1` runs on the real GPU (ANGLE/Vulkan).
- `CRT_CHROMIUM_FLAGS="..."` appends Chromium flags (e.g. WebGPU experiments).

Interactive: serve the repo root (`python3 -m http.server 8765`) and open
`http://127.0.0.1:8765/tests/crt/` (add `?only=<substring>`); results print
on the page and in `window.__results`.

## Writing tests

Suites are `*.test.js` files listed in `index.html`. Use `test(name, fn)`,
`assert`, `assertNear`, `skip(msg)`; helpers in `util.js` (`makeCRT`,
`frameAt`, `flatSignal`, `linearGray`). Every CRT made with `makeCRT` is
destroyed after its test.
