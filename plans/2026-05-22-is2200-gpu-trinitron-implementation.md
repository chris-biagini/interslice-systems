# IS-2200 GPU Trinitron Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the IS-2200 mcrt widget to a hero section rendering 640×480 simulated VGA via a new WebGL2 pipeline inside the existing `Trinitron` class, with per-effect runtime toggles and a master A/B bypass exposed as an easter-egg power-button sticker on the Memphis frame.

**Architecture:** Extend (not replace) `docs/trinitron.js` with a `renderer: 'cpu' | 'gpu' | 'auto'` option. The GPU path is a 3-pass WebGL2 pipeline (signal upload → phosphor pass with MRT persistence ping-pong → composite pass with bloom and glass effects). The dark-mode logo continues on the CPU renderer; only the IS-2200 mcrt opts into GPU. WebGL2 context failure falls back to CPU at the same view size (slow but functional, ~20–30 Hz).

**Tech Stack:** Plain JavaScript (no module system — `<script src>` not `type="module"`), WebGL2 (universal modern-browser support), inline HTML `<script>`, Canvas 2D for the signal-painting callback only, no build step, no dependencies.

**Spec:** `specs/2026-05-22-is2200-gpu-trinitron-design.md`

**Verification model:** This repo has no tests by design (CLAUDE.md: "No tests, no linters, no package manager"). Each task ends with a concrete browser-inspection step that confirms the new behavior before committing. The `?debug=1` URL flag (added in Task 19) makes per-effect verification much easier — many later tasks rely on it.

**Local preview:** `python3 -m http.server -d docs 8000` then visit `http://localhost:8000`. Direct `file://` open works too. Toggle dark mode via DevTools (`<html data-theme="dark">`).

---

## Background

The current state, for an engineer who hasn't seen this codebase:

- `docs/index.html` contains the entire homepage with all page-specific CSS inlined in one `<style>` block. Two `<script>` tags at the bottom: `<script src="trinitron.js">` then an inline IIFE that boots both consumers.
- `docs/trinitron.js` defines a single `Trinitron` class. It's a CPU-based phosphor-display simulation: caller paints into a small 2D canvas (the "signal"); the renderer transforms it into a simulated aperture-grille CRT every RAF tick.
- Two consumers today: the dark-mode logo (`canvas.trinitron`, 200×200 source, animated rotating SVG) and the IS-2200 sneak-preview screen (`canvas.mcrt__crt`, 252×150 source, text via `ctx.fillText`). Both call `new Trinitron(canvas, opts)` with different options.
- The IS-2200 consumer's signal callback is `mcrtSignal(ctx, timeMs)` in the inline `<script>` at the bottom of `index.html`. It paints six lines of VT323 text plus a blinking cursor into the signal canvas. After this task series it will paint ~8 lines of 80-col content into a 1280×960 signal canvas.
- The renderer's per-pixel CPU hot loop is the bottleneck at the new view size. Moving it to a fragment shader is a ~100× speedup with no architectural rework.

`window.__trinitron` is exposed on the IS-2200 instance for DevTools poking — you'll use this constantly for verification.

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `docs/trinitron.js` | MODIFY | Add `renderer` option, `effects` object, `setMasterMode`/`destroy` API, WebGL2 init, three-pass pipeline (phosphor + bloom + composite), static-texture generation, `?debug=1` overlay. |
| `docs/index.html` | MODIFY | Restructure page (new `<section class="is2200-hero">` replacing `<aside class="sneak">`), update `initMcrt` call, rewrite `mcrtSignal` for 80-col content at 1280×960, add Memphis frame CSS for the hero + power-sticker CSS, adjust sprinkles whose positions referenced the corner card. |
| `docs/tokens.css` | UNTOUCHED | No new tokens. Power sticker uses existing `--ink-*` and `--paper-*` colors. |

The total trinitron.js file size goes from ~600 lines to ~1500 lines. If it exceeds 2000 lines or becomes hard to navigate during implementation, split CPU and GPU into `trinitron-cpu.js` and `trinitron-gpu.js` with a shared API surface in `trinitron.js`. Not planned up front — wait until the file actually hurts to read.

---

## Task 1: Add `renderer` option to constructor — no behavior change

**Files:**
- Modify: `docs/trinitron.js`

This task adds the constructor option but leaves the renderer fully on the CPU path. It's a no-op refactor that lets later tasks switch on `this.opts.renderer`.

### Steps

- [ ] **Step 1: Add the option to the constructor defaults**

Open `docs/trinitron.js`. In the `Object.assign({…}, opts)` block at the top of the constructor, add `renderer: 'cpu'` to the defaults object. The full defaults block, after change:

```js
this.opts = Object.assign({
  renderer: 'cpu',     // 'cpu' | 'gpu' | 'auto' — 'auto' tries gpu, falls back to cpu
  viewSize: [200, 200],
  canvasSize: [240, 240],
  // ... rest of existing defaults unchanged
}, opts);
```

- [ ] **Step 2: Read existing tail of the constructor**

At the bottom of the constructor (just before `this._wasStartedByUser = false;`), there's existing initialization for the CPU renderer (stripe tables, persistence buffers, gap mask, etc.). All of this is CPU-only setup. Add a check that gates it on `this.opts.renderer !== 'gpu'`. The cleanest way: wrap the existing constructor-end CPU setup (everything between the `// Stripe ImageData + intermediate canvas.` comment block and `this._wasStartedByUser = false;`) in `if (this.opts.renderer !== 'gpu') { … }`.

- [ ] **Step 3: Verify the page still works**

Run `python3 -m http.server -d docs 8000` and open `http://localhost:8000`. Confirm:
- The dark-mode logo renders normally (set `<html data-theme="dark">` in DevTools).
- The IS-2200 mcrt renders normally in both light and dark mode.
- `window.__trinitron.opts.renderer === 'cpu'` in DevTools console.

No visual change should be observable. This commit is pure refactor.

- [ ] **Step 4: Commit**

```bash
git add docs/trinitron.js
git commit -m "$(cat <<'EOF'
Add renderer option to Trinitron constructor

No behavior change. The 'cpu' default keeps every consumer on the
existing CPU path. Lets later tasks switch on this.opts.renderer to
introduce the GPU pipeline.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add `effects` object — runtime toggle state, no behavior yet

**Files:**
- Modify: `docs/trinitron.js`

Adds the `effects` object with every toggle defaulting to `true`. The object exists on every Trinitron instance but doesn't influence rendering yet. Future tasks will wire individual effects to read from it.

### Steps

- [ ] **Step 1: Add the effects object to the constructor**

After the `Object.assign` defaults block, add a separate `this.effects` initialization. Place it just before the existing `const dpr = window.devicePixelRatio || 1;` line:

```js
// Per-effect runtime toggles. Mutable; setters take effect on the next
// frame. See spec § Toggle system. Defaults: every effect on.
this.effects = Object.assign({
  // Phosphor pass
  stripeProfile: true,
  phosphorCoupling: true,
  convergence: true,
  convergenceDrift: true,
  persistence: true,
  perCellHotspot: true,
  perCellShimmer: true,
  perRowShimmer: true,
  beamSpread: true,
  // Composite pass
  bleed: true,
  selectiveBloom: true,
  gapMask: true,
  phosphorBlur: true,
  // Glass
  curvature: true,
  gloss: true,
  vignette: true,
  // Slow modulators
  warmup: true,
  breathing: true,
}, opts.effects || {});
```

- [ ] **Step 2: Verify in DevTools**

Reload the page. In console:

```
window.__trinitron.effects
// Should print the full object with 18 boolean keys.
window.__trinitron.effects.bloom = false;
window.__trinitron.effects.bloom
// Should be false; no visual change yet because nothing reads it.
```

- [ ] **Step 3: Commit**

```bash
git add docs/trinitron.js
git commit -m "$(cat <<'EOF'
Add effects object scaffolding — no behavior wiring yet

Every Trinitron instance gets a mutable effects object with 18
boolean toggles defaulting to true. Future tasks wire individual
effects to read from it; today, setters are no-ops.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Add `setMasterMode()` and `destroy()` API stubs

**Files:**
- Modify: `docs/trinitron.js`

Adds two new public methods to the class. They have minimal implementations now; later tasks fill them in.

### Steps

- [ ] **Step 1: Add the methods after `stop()`**

In `docs/trinitron.js`, after the existing `stop()` method, add:

```js
// Master A/B mode. true = CRT effects on, false = bypass to raw signal.
// localStorage-persisted. Today it just tracks state; Task 15 wires
// it to actually bypass the GPU pipeline.
setMasterMode(on) {
  this._masterOn = !!on;
  try {
    localStorage.setItem(
      'interslice-systems:is2200:crt-mode',
      this._masterOn ? 'on' : 'off'
    );
  } catch (e) {
    // localStorage may be unavailable (private mode, etc.). State
    // still tracks in-memory for this session.
  }
}

// Tears down GL resources. Today a no-op for the CPU path; Task 4
// adds GL-specific cleanup.
destroy() {
  this.stop();
}
```

- [ ] **Step 2: Initialize `_masterOn` in the constructor**

In the constructor, just before `this._wasStartedByUser = false;`, read the persisted state:

```js
// Master A/B initial state. Default on. Read from localStorage so the
// user's last choice persists across reloads.
this._masterOn = true;
try {
  const stored = localStorage.getItem('interslice-systems:is2200:crt-mode');
  if (stored === 'off') this._masterOn = false;
} catch (e) {
  // Default to on if storage unavailable.
}
```

- [ ] **Step 3: Verify**

Reload the page. In DevTools:

```
window.__trinitron._masterOn         // true
window.__trinitron.setMasterMode(false);
localStorage.getItem('interslice-systems:is2200:crt-mode')  // "off"
// Reload page.
window.__trinitron._masterOn         // false
window.__trinitron.setMasterMode(true);
```

- [ ] **Step 4: Commit**

```bash
git add docs/trinitron.js
git commit -m "$(cat <<'EOF'
Add setMasterMode() and destroy() API stubs

setMasterMode tracks A/B state in-instance and persists to
localStorage. destroy() shells out to stop(). Both get real
implementations in later tasks; this commit reserves the surface area.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: WebGL2 context creation with automatic CPU fallback

**Files:**
- Modify: `docs/trinitron.js`

Sets up the GPU init pathway. If `renderer: 'gpu'` or `renderer: 'auto'`, tries `getContext('webgl2')`. On success, stashes the context. On failure with `'auto'`, falls back to CPU. With `'gpu'`, throws.

### Steps

- [ ] **Step 1: Restructure the constructor**

The constructor needs to branch: CPU init or GPU init. Wrap the existing CPU-only setup (already gated in Task 1) so the full constructor structure looks like:

```js
constructor(canvasEl, opts) {
  this.canvas = canvasEl;
  this.opts = Object.assign({/* defaults — Task 1 */}, opts);
  this.effects = Object.assign({/* defaults — Task 2 */}, opts.effects || {});

  // Try GPU init if requested.
  this._mode = null;  // 'cpu' | 'gpu' — populated by init
  if (this.opts.renderer === 'gpu' || this.opts.renderer === 'auto') {
    try {
      this._initGpu();
      this._mode = 'gpu';
    } catch (err) {
      if (this.opts.renderer === 'gpu') throw err;
      // 'auto': fall through to CPU.
      console.warn('Trinitron: WebGL2 unavailable, falling back to CPU.', err);
    }
  }

  if (this._mode === null) {
    this._initCpu();
    this._mode = 'cpu';
  }

  // Master mode + reduced-motion listener apply regardless of mode.
  this._masterOn = true;
  try {
    const stored = localStorage.getItem('interslice-systems:is2200:crt-mode');
    if (stored === 'off') this._masterOn = false;
  } catch (e) {}

  this._wasStartedByUser = false;
  this._setupReducedMotionListener();
  this._rafHandle = null;
  this._startTime = null;
}
```

This requires extracting the existing CPU constructor body into a new method `_initCpu()`. Move every line from the `const dpr = window.devicePixelRatio || 1;` line through the end of the existing constructor (everything after `this.effects = …`) into a new `_initCpu()` method — **except** the master-mode init block (which now lives in the constructor proper).

- [ ] **Step 2: Add `_initGpu()` skeleton**

Below `_initCpu()`, add:

```js
_initGpu() {
  const gl = this.canvas.getContext('webgl2', {
    alpha: true,
    antialias: false,
    preserveDrawingBuffer: false,
  });
  if (!gl) throw new Error('WebGL2 unavailable');
  this._gl = gl;

  const dpr = window.devicePixelRatio || 1;
  const [cw, ch] = this.opts.canvasSize;
  this.canvas.width = cw * dpr;
  this.canvas.height = ch * dpr;
  // No ctx.scale equivalent for WebGL — shaders work in clip space.

  // Subsequent tasks build out: programs, FBOs, textures, the
  // full-screen-triangle VAO, etc. This stub just creates the context
  // and sizes the canvas.
}

_destroyGpu() {
  // Task 4 leaves this empty; later tasks populate it.
}
```

- [ ] **Step 3: Update `destroy()` to dispatch by mode**

Update the `destroy()` method to:

```js
destroy() {
  this.stop();
  if (this._mode === 'gpu') this._destroyGpu();
}
```

- [ ] **Step 4: Update `start()` and `stop()` for mode awareness**

The existing `start()` calls `_frame(0)` which is CPU-specific. For now, gate `_frame` calls on `this._mode === 'cpu'` so GPU mode doesn't crash trying to call a CPU-only method. In `start()`, replace the existing `tick` body with:

```js
const tick = (now) => {
  if (this._mode === 'cpu') this._frame(now - this._startTime);
  // GPU rendering hooks in later tasks.
  this._rafHandle = requestAnimationFrame(tick);
};
```

And the early single-frame call:

```js
if (this._reducedMotionMq && this._reducedMotionMq.matches) {
  if (this._mode === 'cpu') this._frame(0);
  return;
}
```

- [ ] **Step 5: Verify CPU path still works**

Reload the page. The IS-2200 (still on `renderer: 'cpu'` until we change `initMcrt`) and the dark-mode logo (always `cpu`) both render normally. Check console for the warn-message you'd expect when WebGL2 fails.

Then try `renderer: 'gpu'` ad-hoc in DevTools:

```js
// Stop current instance, create a new GPU one.
const c = document.querySelector('.mcrt__crt');
const t = new window.Trinitron(c, { renderer: 'gpu', signal: () => {} });
t._mode  // "gpu"
t._gl    // WebGL2RenderingContext object
```

Canvas should be blank (we haven't built the pipeline yet) but no errors should print.

- [ ] **Step 6: Commit**

```bash
git add docs/trinitron.js
git commit -m "$(cat <<'EOF'
Stand up WebGL2 context with automatic CPU fallback

Constructor now dispatches by renderer option. 'auto' tries WebGL2
first and falls through to CPU on context-creation failure (logs a
warning). 'gpu' throws on failure. CPU init body moved into _initCpu()
for symmetry; GPU init (_initGpu) is a stub that only creates the
context and sizes the canvas — pipeline machinery lands in later tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: GPU resource scaffolding — programs, VAO, textures, FBOs

**Files:**
- Modify: `docs/trinitron.js`

Builds out the static GL resources the pipeline needs: shader compile/link helpers, full-screen-triangle VAO, two persistence ping-pong textures (RGBA32F), the signal upload texture, one intermediate phosphor texture. No rendering yet — `_renderGpu()` will just clear the canvas to verify the resources exist without GL errors.

### Steps

- [ ] **Step 1: Add shader-compile helpers**

At the top of the IIFE (just inside `(function () { 'use strict';`), add:

```js
function compileShader(gl, type, source) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('Shader compile failed: ' + log);
  }
  return sh;
}

function linkProgram(gl, vs, fs) {
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error('Program link failed: ' + log);
  }
  return prog;
}

// Shared vertex shader: full-screen triangle that covers the viewport
// after clipping. Saves one vertex vs a quad and avoids the diagonal
// seam in some GPU drivers' interpolation. The explicit layout
// location is load-bearing — every program below relies on aPos
// being at attribute 0 (matches the VAO setup in _initGpu).
const FULLSCREEN_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;
```

- [ ] **Step 2: Expand `_initGpu()` with resource creation**

Replace the stub body of `_initGpu()` with:

```js
_initGpu() {
  const gl = this.canvas.getContext('webgl2', {
    alpha: true,
    antialias: false,
    preserveDrawingBuffer: false,
  });
  if (!gl) throw new Error('WebGL2 unavailable');
  this._gl = gl;

  const dpr = window.devicePixelRatio || 1;
  const [cw, ch] = this.opts.canvasSize;
  this.canvas.width = cw * dpr;
  this.canvas.height = ch * dpr;

  const [vw, vh] = this.opts.viewSize;

  // Float textures for persistence (no extension needed in WebGL2).
  // EXT_color_buffer_float lets us render TO float — required for MRT.
  const cbf = gl.getExtension('EXT_color_buffer_float');
  if (!cbf) throw new Error('EXT_color_buffer_float unavailable');

  // Full-screen triangle VAO.
  const tri = new Float32Array([-1, -1, 3, -1, -1, 3]);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, tri, gl.STATIC_DRAW);
  // aPos at attribute location 0. We'll bind it in linkProgram calls
  // using gl.bindAttribLocation before linking, or use layout qualifier.
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  this._vao = vao;

  // Signal texture — gets `texSubImage2D`d each frame from the 2D canvas.
  this._signalCanvas = document.createElement('canvas');
  this._signalCanvas.width = vw;
  this._signalCanvas.height = vh;
  this._signalCtx = this._signalCanvas.getContext('2d', { willReadFrequently: false });
  this._signalCtx.imageSmoothingEnabled = true;
  this._signalCtx.imageSmoothingQuality = 'high';

  this._texSignal = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, this._texSignal);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, vw, vh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // Persistence ping-pong textures (RGBA32F).
  const makeFloatTex = (w, h) => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  this._texPersistA = makeFloatTex(vw, vh);
  this._texPersistB = makeFloatTex(vw, vh);
  this._texPhosphor = makeFloatTex(vw, vh);
  this._persistFront = this._texPersistA; // read-from
  this._persistBack  = this._texPersistB; // write-to

  // FBO for the phosphor pass — MRT: COLOR_ATTACHMENT0 = phosphor,
  // COLOR_ATTACHMENT1 = persistence (back buffer). Recreated each
  // frame to swap the persistence attachment.
  this._fboPhosphor = gl.createFramebuffer();

  // Programs land in later tasks. Track them here for cleanup.
  this._programs = [];

  // Frame counter for diagnostics.
  this._frameCount = 0;
}
```

- [ ] **Step 3: Add `_destroyGpu()` cleanup**

```js
_destroyGpu() {
  const gl = this._gl;
  if (!gl) return;
  for (const p of (this._programs || [])) gl.deleteProgram(p);
  if (this._vao) gl.deleteVertexArray(this._vao);
  if (this._texSignal)   gl.deleteTexture(this._texSignal);
  if (this._texPersistA) gl.deleteTexture(this._texPersistA);
  if (this._texPersistB) gl.deleteTexture(this._texPersistB);
  if (this._texPhosphor) gl.deleteTexture(this._texPhosphor);
  if (this._fboPhosphor) gl.deleteFramebuffer(this._fboPhosphor);
  this._gl = null;
}
```

- [ ] **Step 4: Add a placeholder `_renderGpu()`**

After `_initGpu()`, add:

```js
_renderGpu(timeMs) {
  const gl = this._gl;
  // Paint signal (will be wired up after Task 18 changes mcrtSignal).
  const [vw, vh] = this.opts.viewSize;
  this._signalCtx.clearRect(0, 0, vw, vh);
  this.opts.signal(this._signalCtx, timeMs);

  // Clear the visible canvas to dark for now — the pipeline lands
  // pass-by-pass in subsequent tasks.
  gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  gl.clearColor(0.02, 0.04, 0.02, 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  this._frameCount++;
}
```

- [ ] **Step 5: Wire `_renderGpu()` into the RAF tick**

In `start()`, update the `tick` body:

```js
const tick = (now) => {
  const t = now - this._startTime;
  if (this._mode === 'cpu') this._frame(t);
  else if (this._mode === 'gpu') this._renderGpu(t);
  this._rafHandle = requestAnimationFrame(tick);
};
```

Also update the reduced-motion single-frame branch:

```js
if (this._reducedMotionMq && this._reducedMotionMq.matches) {
  if (this._mode === 'cpu') this._frame(0);
  else if (this._mode === 'gpu') this._renderGpu(0);
  return;
}
```

- [ ] **Step 6: Verify**

In DevTools, force a GPU instance:

```js
// Stop existing CPU instance, mount GPU on the same canvas.
window.__trinitron.destroy();
const c = document.querySelector('.mcrt__crt');
const t = new window.Trinitron(c, {
  renderer: 'gpu',
  viewSize: [252, 150],
  canvasSize: [504, 300],
  signal: () => {},
});
t.start();
t._frameCount  // should increment when re-evaluated
```

Visual: the IS-2200 canvas should be a uniform dark green (`0.02, 0.04, 0.02`). No GL errors in console.

- [ ] **Step 7: Commit**

```bash
git add docs/trinitron.js
git commit -m "$(cat <<'EOF'
Scaffold GPU resources — VAO, signal upload, persistence ping-pong

WebGL2 init now creates the full-screen-triangle VAO, the signal
upload texture, the two RGBA32F persistence textures (ping-pong),
the phosphor render-target texture, and the phosphor FBO. Placeholder
_renderGpu clears the canvas to dark green to prove the resources
exist and RAF dispatches correctly. Pipeline shaders land next.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Phosphor pass — minimal "signal pass-through" shader

**Files:**
- Modify: `docs/trinitron.js`

First real shader pass. The phosphor shader at this stage just samples the signal texture and writes it through. Adding to MRT slots: COLOR_ATTACHMENT0 (output) and COLOR_ATTACHMENT1 (persistence next-frame — write zeros for now).

### Steps

- [ ] **Step 1: Add the phosphor fragment shader source**

Near the top of the IIFE, after `FULLSCREEN_VS`:

```js
const PHOSPHOR_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSignal;

layout(location = 0) out vec4 oPhosphor;
layout(location = 1) out vec4 oPersistenceNext;

void main() {
  vec4 s = texture(uSignal, vUv);
  oPhosphor = s;
  oPersistenceNext = vec4(0.0);
}`;
```

- [ ] **Step 2: Compile the phosphor program in `_initGpu()`**

At the end of `_initGpu()` (before the line `this._frameCount = 0;`), add:

```js
// Phosphor program. aPos is at attribute location 0 via the
// `layout(location = 0)` qualifier in FULLSCREEN_VS, matching the
// VAO setup in Task 5.
const phVs = compileShader(gl, gl.VERTEX_SHADER, FULLSCREEN_VS);
const phFs = compileShader(gl, gl.FRAGMENT_SHADER, PHOSPHOR_FS);
this._progPhosphor = linkProgram(gl, phVs, phFs);
gl.deleteShader(phVs);
gl.deleteShader(phFs);
this._programs.push(this._progPhosphor);

// Uniform locations (cache once).
this._uPhosphor = {
  signal: gl.getUniformLocation(this._progPhosphor, 'uSignal'),
};
```

- [ ] **Step 3: Upload signal each frame**

In `_renderGpu()`, after the `signal(this._signalCtx, timeMs)` call, add:

```js
// Upload the 2D canvas to the signal texture.
gl.bindTexture(gl.TEXTURE_2D, this._texSignal);
gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, this._signalCanvas);
gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
```

The `FLIP_Y` step accounts for the difference between canvas's top-left origin and WebGL's bottom-left origin. After this upload, sampling the texture at `vUv = (x, y)` returns the canvas pixel at `(x, y)` with origin top-left, matching the signal callback's mental model.

- [ ] **Step 4: Run the phosphor pass**

Replace the clear-only body of `_renderGpu()` (between `texSubImage2D` and `this._frameCount++`) with:

```js
const [vw, vh] = this.opts.viewSize;

// Bind the phosphor FBO. Attach phosphor + persistence-back to MRT.
gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboPhosphor);
gl.framebufferTexture2D(
  gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D,
  this._texPhosphor, 0
);
gl.framebufferTexture2D(
  gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D,
  this._persistBack, 0
);
gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
gl.viewport(0, 0, vw, vh);
gl.clearColor(0, 0, 0, 0);
gl.clear(gl.COLOR_BUFFER_BIT);

gl.useProgram(this._progPhosphor);
gl.bindVertexArray(this._vao);
gl.activeTexture(gl.TEXTURE0);
gl.bindTexture(gl.TEXTURE_2D, this._texSignal);
gl.uniform1i(this._uPhosphor.signal, 0);
gl.drawArrays(gl.TRIANGLES, 0, 3);

// Swap persistence ping-pong for next frame.
const tmp = this._persistFront;
this._persistFront = this._persistBack;
this._persistBack = tmp;
```

- [ ] **Step 5: Blit the phosphor texture to the visible canvas**

For now, we need to see what the phosphor pass produced. Add a temporary "blit" using `gl.blitFramebuffer` (WebGL2 feature). After the phosphor pass body:

```js
// TEMPORARY: blit phosphor → default framebuffer for visibility.
// Task 9 replaces this with the real composite pass.
gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._fboPhosphor);
gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
gl.readBuffer(gl.COLOR_ATTACHMENT0);
gl.blitFramebuffer(
  0, 0, vw, vh,
  0, 0, this.canvas.width, this.canvas.height,
  gl.COLOR_BUFFER_BIT, gl.LINEAR
);
gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
```

- [ ] **Step 6: Verify**

In DevTools, instantiate a GPU renderer with a real signal callback:

```js
window.__trinitron.destroy();
const c = document.querySelector('.mcrt__crt');
const t = new window.Trinitron(c, {
  renderer: 'gpu',
  viewSize: [252, 150],
  canvasSize: [504, 300],
  signal: (ctx) => {
    ctx.fillStyle = '#44FF8A';
    ctx.font = '20px monospace';
    ctx.fillText('GPU PASS-THROUGH OK', 8, 32);
  },
});
t.start();
```

The IS-2200 widget should show "GPU PASS-THROUGH OK" in green, no CRT effects yet, just the signal scaled up to the canvas. Confirms signal upload + minimal phosphor shader + MRT + blit all work end-to-end.

- [ ] **Step 7: Commit**

```bash
git add docs/trinitron.js
git commit -m "$(cat <<'EOF'
Write minimal phosphor shader — signal pass-through

Phosphor pass now compiles, links, and renders. Samples the uploaded
signal texture and writes it unchanged to MRT slot 0 (phosphor output).
MRT slot 1 (persistence next-frame) gets zeros — proper persistence
math lands in Task 8. A temporary blitFramebuffer copy makes the
phosphor output visible until Task 9 builds the composite pass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Phosphor pass — aperture-grille stripe profile

**Files:**
- Modify: `docs/trinitron.js`

Adds the cs=2 stripe profile. R at column 0, G at column 1, B always via coupling (= 0.35). After this task the phosphor output shows the recognizable per-channel stripe decomposition.

### Steps

- [ ] **Step 1: Replace `PHOSPHOR_FS` with the stripe-aware version**

```js
const PHOSPHOR_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSignal;
uniform vec2 uViewSize;
uniform vec2 uCellSize;
uniform float uPhosphorCoupling;
uniform float uStripeEnabled;
uniform float uCouplingEnabled;

layout(location = 0) out vec4 oPhosphor;
layout(location = 1) out vec4 oPersistenceNext;

void main() {
  vec4 s = texture(uSignal, vUv);
  vec2 px = vUv * uViewSize;
  int subX = int(mod(px.x, uCellSize.x));

  // Build per-channel weights. cs=2 layout: R at col 0, G at col 1,
  // B always via coupling (cs=2 has no column for B's primary).
  // Coupling: at the primary-lit column for any channel, all other
  // channels also emit at uPhosphorCoupling fraction.
  // Default (everything enabled): weight is coupling at non-primary
  // columns, 1.0 at the primary. When uStripeEnabled = 0, weights
  // collapse to (1,1,1) — no stripe modulation. When uCouplingEnabled
  // = 0, the coupling level collapses to 0 — strict aperture grille.
  float coupling = uPhosphorCoupling * uCouplingEnabled;
  vec3 weights = vec3(coupling, coupling, coupling);
  if (subX == 0) weights.r = 1.0;
  else if (subX == 1) weights.g = 1.0;
  // Mix with neutral when stripe disabled.
  weights = mix(vec3(1.0), weights, uStripeEnabled);

  vec3 stripeOut = s.rgb * weights;
  oPhosphor = vec4(stripeOut, s.a);
  oPersistenceNext = vec4(0.0);
}`;
```

- [ ] **Step 2: Add uniform locations and uploads**

In `_initGpu()`, extend the `_uPhosphor` cache:

```js
this._uPhosphor = {
  signal:            gl.getUniformLocation(this._progPhosphor, 'uSignal'),
  viewSize:          gl.getUniformLocation(this._progPhosphor, 'uViewSize'),
  cellSize:          gl.getUniformLocation(this._progPhosphor, 'uCellSize'),
  phosphorCoupling:  gl.getUniformLocation(this._progPhosphor, 'uPhosphorCoupling'),
  stripeEnabled:     gl.getUniformLocation(this._progPhosphor, 'uStripeEnabled'),
  couplingEnabled:   gl.getUniformLocation(this._progPhosphor, 'uCouplingEnabled'),
};
```

In `_renderGpu()`, after `gl.useProgram(this._progPhosphor);` and before `gl.drawArrays(...)`, add uniform uploads:

```js
gl.uniform2f(this._uPhosphor.viewSize, vw, vh);
gl.uniform2f(this._uPhosphor.cellSize, this.opts.cellSize, this.opts.cellSize);
gl.uniform1f(this._uPhosphor.phosphorCoupling, this.opts.phosphorCoupling || 0.35);
gl.uniform1f(this._uPhosphor.stripeEnabled,   this.effects.stripeProfile ? 1 : 0);
gl.uniform1f(this._uPhosphor.couplingEnabled, this.effects.phosphorCoupling ? 1 : 0);
```

- [ ] **Step 3: Verify**

Re-run the DevTools snippet from Task 6 Step 6. The text "GPU PASS-THROUGH OK" should now show **per-channel stripe banding** — at the per-source-pixel level you'll see alternating R/G columns. Zoom in (Cmd-+ in browser) and confirm: every pixel-column reads as one channel. Pure green text appears almost as green-only with hints of red/blue from coupling.

Then test toggles:

```js
window.__trinitron.effects.stripeProfile = false;  // back to flat color
window.__trinitron.effects.stripeProfile = true;   // back to stripes
window.__trinitron.effects.phosphorCoupling = false; // stripes harden — non-primary channels go black
window.__trinitron.effects.phosphorCoupling = true;  // back to coupling 0.35
```

- [ ] **Step 4: Commit**

```bash
git add docs/trinitron.js
git commit -m "$(cat <<'EOF'
Add aperture-grille stripe profile to phosphor shader

cs=2 layout: R lit at column 0, G at column 1, B always via coupling
(cs=2 has no column for B's primary — current visual identity is
tuned around this; see spec). Coupling defaults to 0.35. Both
stripeProfile and phosphorCoupling toggleable via __trinitron.effects.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Phosphor pass — persistence + convergence

**Files:**
- Modify: `docs/trinitron.js`

Wires per-pixel persistence (read previous frame's snapshot, lerp against live signal) and per-channel convergence offsets (chromatic edge fringe).

### Steps

- [ ] **Step 1: Update `PHOSPHOR_FS` with persistence and convergence**

```js
const PHOSPHOR_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSignal;
uniform sampler2D uPersistencePrev;
uniform vec2 uViewSize;
uniform vec2 uCellSize;
uniform float uPhosphorCoupling;
uniform float uPersistence;
uniform vec2 uConvergenceR;
uniform vec2 uConvergenceG;
uniform vec2 uConvergenceB;
uniform float uStripeEnabled;
uniform float uCouplingEnabled;
uniform float uPersistenceEnabled;
uniform float uConvergenceEnabled;

layout(location = 0) out vec4 oPhosphor;
layout(location = 1) out vec4 oPersistenceNext;

void main() {
  // Per-channel convergence: sample signal at three slightly different
  // UVs. GPU bilinear sampling produces the sub-pixel chromatic fringe
  // for free.
  vec2 dR = (uConvergenceR / uViewSize) * uConvergenceEnabled;
  vec2 dG = (uConvergenceG / uViewSize) * uConvergenceEnabled;
  vec2 dB = (uConvergenceB / uViewSize) * uConvergenceEnabled;
  float sR = texture(uSignal, vUv + dR).r;
  float sG = texture(uSignal, vUv + dG).g;
  float sB = texture(uSignal, vUv + dB).b;
  // Source alpha from unshifted G channel — the cleanest silhouette
  // mask without any chromatic offset.
  float sA = texture(uSignal, vUv).a;
  vec4 live = vec4(sR, sG, sB, sA);

  // Persistence lerp. dr = 0.55 means 55% old + 45% new (slow decay).
  vec4 prev = texture(uPersistencePrev, vUv);
  float dr = uPersistence * uPersistenceEnabled;
  vec4 lerped = prev * dr + live * (1.0 - dr);

  // Write persistence for next frame (the post-lerp value).
  oPersistenceNext = lerped;

  // Build stripe weights (same as Task 7).
  vec2 px = vUv * uViewSize;
  int subX = int(mod(px.x, uCellSize.x));
  float coupling = uPhosphorCoupling * uCouplingEnabled;
  vec3 weights = vec3(coupling, coupling, coupling);
  if (subX == 0) weights.r = 1.0;
  else if (subX == 1) weights.g = 1.0;
  weights = mix(vec3(1.0), weights, uStripeEnabled);

  vec3 stripeOut = lerped.rgb * weights;
  oPhosphor = vec4(stripeOut, lerped.a);
}`;
```

- [ ] **Step 2: Add uniform locations**

In `_initGpu()`, extend `this._uPhosphor`:

```js
this._uPhosphor = {
  signal:               gl.getUniformLocation(this._progPhosphor, 'uSignal'),
  persistencePrev:      gl.getUniformLocation(this._progPhosphor, 'uPersistencePrev'),
  viewSize:             gl.getUniformLocation(this._progPhosphor, 'uViewSize'),
  cellSize:             gl.getUniformLocation(this._progPhosphor, 'uCellSize'),
  phosphorCoupling:     gl.getUniformLocation(this._progPhosphor, 'uPhosphorCoupling'),
  persistence:          gl.getUniformLocation(this._progPhosphor, 'uPersistence'),
  convergenceR:         gl.getUniformLocation(this._progPhosphor, 'uConvergenceR'),
  convergenceG:         gl.getUniformLocation(this._progPhosphor, 'uConvergenceG'),
  convergenceB:         gl.getUniformLocation(this._progPhosphor, 'uConvergenceB'),
  stripeEnabled:        gl.getUniformLocation(this._progPhosphor, 'uStripeEnabled'),
  couplingEnabled:      gl.getUniformLocation(this._progPhosphor, 'uCouplingEnabled'),
  persistenceEnabled:   gl.getUniformLocation(this._progPhosphor, 'uPersistenceEnabled'),
  convergenceEnabled:   gl.getUniformLocation(this._progPhosphor, 'uConvergenceEnabled'),
};
```

- [ ] **Step 3: Update uniform uploads in `_renderGpu()`**

Replace the uniform-uploads block (after `gl.useProgram(this._progPhosphor)`) with:

```js
gl.uniform2f(this._uPhosphor.viewSize, vw, vh);
gl.uniform2f(this._uPhosphor.cellSize, this.opts.cellSize, this.opts.cellSize);
gl.uniform1f(this._uPhosphor.phosphorCoupling, this.opts.phosphorCoupling || 0.35);
gl.uniform1f(this._uPhosphor.persistence, this.opts.persistence || 0.55);

const c = this.opts.convergence || { r: [-0.25, -0.25], g: [0, 0], b: [0.25, 0.25] };
gl.uniform2f(this._uPhosphor.convergenceR, c.r[0], c.r[1]);
gl.uniform2f(this._uPhosphor.convergenceG, c.g[0], c.g[1]);
gl.uniform2f(this._uPhosphor.convergenceB, c.b[0], c.b[1]);

gl.uniform1f(this._uPhosphor.stripeEnabled,      this.effects.stripeProfile ? 1 : 0);
gl.uniform1f(this._uPhosphor.couplingEnabled,    this.effects.phosphorCoupling ? 1 : 0);
gl.uniform1f(this._uPhosphor.persistenceEnabled, this.effects.persistence ? 1 : 0);
gl.uniform1f(this._uPhosphor.convergenceEnabled, this.effects.convergence ? 1 : 0);

// Bind signal at texture unit 0, persistence-prev at unit 1.
gl.activeTexture(gl.TEXTURE0);
gl.bindTexture(gl.TEXTURE_2D, this._texSignal);
gl.uniform1i(this._uPhosphor.signal, 0);
gl.activeTexture(gl.TEXTURE1);
gl.bindTexture(gl.TEXTURE_2D, this._persistFront);
gl.uniform1i(this._uPhosphor.persistencePrev, 1);
```

(Remove the duplicate `gl.activeTexture(gl.TEXTURE0); gl.bindTexture(...); gl.uniform1i(...)` lines that were there from Task 6.)

- [ ] **Step 4: Verify persistence**

Use a signal callback that shows persistence visually:

```js
window.__trinitron.destroy();
const c = document.querySelector('.mcrt__crt');
const t = new window.Trinitron(c, {
  renderer: 'gpu',
  viewSize: [252, 150],
  canvasSize: [504, 300],
  cellSize: 2,
  phosphorCoupling: 0.35,
  persistence: 0.85,  // heavy persistence for visibility
  signal: (ctx, timeMs) => {
    const x = 20 + Math.sin(timeMs / 400) * 80;
    ctx.fillStyle = '#44FF8A';
    ctx.fillRect(x, 60, 40, 30);
  },
});
t.start();
```

You should see a green rectangle moving horizontally with a clear **trail** behind it — that's persistence. Toggle off:

```js
window.__trinitron.effects.persistence = false;  // trail disappears
window.__trinitron.effects.persistence = true;   // trail returns
```

For convergence, use a static signal:

```js
t.opts.signal = (ctx) => {
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(50, 40, 100, 60);
};
```

You should see colored fringes at the rectangle's edges. Toggle off:

```js
window.__trinitron.effects.convergence = false;  // fringes go away
```

- [ ] **Step 5: Commit**

```bash
git add docs/trinitron.js
git commit -m "$(cat <<'EOF'
Carry persistence between frames via MRT ping-pong + add convergence

Phosphor pass now samples the previous frame's persistence texture,
lerps against the live signal (decay coefficient = persistence
option, default 0.55), and writes the lerped value to the back
persistence texture for next frame. Per-channel convergence offsets
sample the signal at sub-pixel-shifted UVs — GPU bilinear produces
chromatic fringes at edges for free.

Both persistence and convergence toggleable via __trinitron.effects.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Phosphor pass — hotspot, cell shimmer, row shimmer, beam spread

**Files:**
- Modify: `docs/trinitron.js`

Completes the phosphor pass with the remaining four effects: per-cell Manhattan-distance hotspot, per-cell shimmer (deterministic LCG hash, no texture needed), per-row shimmer, and pre-stripe beam spread (Gaussian blur on the signal).

### Steps

- [ ] **Step 1: Extend `PHOSPHOR_FS`**

Replace `PHOSPHOR_FS` with the full version:

```js
const PHOSPHOR_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSignal;
uniform sampler2D uPersistencePrev;
uniform vec2 uViewSize;
uniform vec2 uCellSize;
uniform float uPhosphorCoupling;
uniform float uPersistence;
uniform vec2 uConvergenceR;
uniform vec2 uConvergenceG;
uniform vec2 uConvergenceB;
uniform float uHotspot;
uniform float uCellShimmerAmp;
uniform float uRowShimmerAmp;
uniform uint uShimmerSeed;
uniform float uBeamSpreadPx;
uniform float uStripeEnabled;
uniform float uCouplingEnabled;
uniform float uPersistenceEnabled;
uniform float uConvergenceEnabled;
uniform float uHotspotEnabled;
uniform float uCellShimmerEnabled;
uniform float uRowShimmerEnabled;
uniform float uBeamSpreadEnabled;

layout(location = 0) out vec4 oPhosphor;
layout(location = 1) out vec4 oPersistenceNext;

// Deterministic LCG hash → [0,1].
float lcg(uint seed) {
  uint x = 1664525u * seed + 1013904223u;
  return float(x) * (1.0 / 4294967296.0);
}

// Beam spread: cheap 5-tap Gaussian along Y at the sample UV.
// Approximate; correct sigma matches uBeamSpreadPx in source-pixel units.
vec4 sampleBeamSpread(sampler2D tex, vec2 uv, float spreadPx) {
  if (spreadPx < 0.7) return texture(tex, uv);  // sub-pixel-blur no-ops
  float dy = spreadPx / uViewSize.y;
  vec4 c0 = texture(tex, uv + vec2(0.0, -2.0 * dy)) * 0.06;
  vec4 c1 = texture(tex, uv + vec2(0.0, -1.0 * dy)) * 0.24;
  vec4 c2 = texture(tex, uv)                       * 0.40;
  vec4 c3 = texture(tex, uv + vec2(0.0,  1.0 * dy)) * 0.24;
  vec4 c4 = texture(tex, uv + vec2(0.0,  2.0 * dy)) * 0.06;
  return c0 + c1 + c2 + c3 + c4;
}

void main() {
  vec2 dR = (uConvergenceR / uViewSize) * uConvergenceEnabled;
  vec2 dG = (uConvergenceG / uViewSize) * uConvergenceEnabled;
  vec2 dB = (uConvergenceB / uViewSize) * uConvergenceEnabled;

  float beamSpread = uBeamSpreadPx * uBeamSpreadEnabled;
  float sR = sampleBeamSpread(uSignal, vUv + dR, beamSpread).r;
  float sG = sampleBeamSpread(uSignal, vUv + dG, beamSpread).g;
  float sB = sampleBeamSpread(uSignal, vUv + dB, beamSpread).b;
  float sA = sampleBeamSpread(uSignal, vUv, beamSpread).a;
  vec4 live = vec4(sR, sG, sB, sA);

  vec4 prev = texture(uPersistencePrev, vUv);
  float dr = uPersistence * uPersistenceEnabled;
  vec4 lerped = prev * dr + live * (1.0 - dr);
  oPersistenceNext = lerped;

  vec2 px = vUv * uViewSize;
  int subX = int(mod(px.x, uCellSize.x));
  int subY = int(mod(px.y, uCellSize.y));

  // Stripe weights (Task 7 math).
  float coupling = uPhosphorCoupling * uCouplingEnabled;
  vec3 weights = vec3(coupling, coupling, coupling);
  if (subX == 0) weights.r = 1.0;
  else if (subX == 1) weights.g = 1.0;
  weights = mix(vec3(1.0), weights, uStripeEnabled);

  // Per-cell hotspot: Manhattan-distance brightness boost at the cell
  // "center" (cellSize >> 1). For cs=2 that's (1,1) → only the
  // bottom-right pixel of each cell gets the boost. Distance > 1 →
  // no boost.
  int centerInt = int(uCellSize.x) / 2;
  int dx = abs(subX - centerInt);
  int dy = abs(subY - centerInt);
  int dist = dx + dy;
  float hotBoost = dist == 0 ? 1.0 + uHotspot :
                   dist == 1 ? 1.0 :
                                1.0;
  float hotMul = mix(1.0, hotBoost, uHotspotEnabled);

  // Per-cell shimmer: stable hash by cell index.
  vec2 cellCoord = floor(px / uCellSize);
  uint cellGridW = uint(uViewSize.x / uCellSize.x);
  uint cellIdx = uint(cellCoord.y) * cellGridW + uint(cellCoord.x);
  float cellShim = 1.0 + uCellShimmerAmp * (2.0 * lcg(cellIdx + uShimmerSeed) - 1.0);
  cellShim = mix(1.0, cellShim, uCellShimmerEnabled);

  // Per-row shimmer.
  float rowShim = 1.0 + uRowShimmerAmp * (2.0 * lcg(uint(cellCoord.y) + uShimmerSeed + 1u) - 1.0);
  rowShim = mix(1.0, rowShim, uRowShimmerEnabled);

  float cellMod = hotMul * cellShim * rowShim;
  vec3 stripeOut = lerped.rgb * weights * cellMod;
  oPhosphor = vec4(stripeOut, lerped.a);
}`;
```

- [ ] **Step 2: Add uniform locations and uploads**

In `_initGpu()`, extend `this._uPhosphor` with the new uniform locations:

```js
// Append to _uPhosphor:
this._uPhosphor.hotspot           = gl.getUniformLocation(this._progPhosphor, 'uHotspot');
this._uPhosphor.cellShimmerAmp    = gl.getUniformLocation(this._progPhosphor, 'uCellShimmerAmp');
this._uPhosphor.rowShimmerAmp     = gl.getUniformLocation(this._progPhosphor, 'uRowShimmerAmp');
this._uPhosphor.shimmerSeed       = gl.getUniformLocation(this._progPhosphor, 'uShimmerSeed');
this._uPhosphor.beamSpreadPx      = gl.getUniformLocation(this._progPhosphor, 'uBeamSpreadPx');
this._uPhosphor.hotspotEnabled    = gl.getUniformLocation(this._progPhosphor, 'uHotspotEnabled');
this._uPhosphor.cellShimmerEnabled = gl.getUniformLocation(this._progPhosphor, 'uCellShimmerEnabled');
this._uPhosphor.rowShimmerEnabled  = gl.getUniformLocation(this._progPhosphor, 'uRowShimmerEnabled');
this._uPhosphor.beamSpreadEnabled  = gl.getUniformLocation(this._progPhosphor, 'uBeamSpreadEnabled');
```

In `_renderGpu()`, append to the uniform uploads:

```js
gl.uniform1f(this._uPhosphor.hotspot,        this.opts.hotspot || 0.18);
gl.uniform1f(this._uPhosphor.cellShimmerAmp, this.opts.cellShimmer || 0.03);
gl.uniform1f(this._uPhosphor.rowShimmerAmp,  this.opts.rowShimmer || 0.012);
gl.uniform1ui(this._uPhosphor.shimmerSeed,   this.opts.shimmerSeed || 1983);
gl.uniform1f(this._uPhosphor.beamSpreadPx,   this.opts.beamSpreadPx || 0.4);
gl.uniform1f(this._uPhosphor.hotspotEnabled,    this.effects.perCellHotspot ? 1 : 0);
gl.uniform1f(this._uPhosphor.cellShimmerEnabled, this.effects.perCellShimmer ? 1 : 0);
gl.uniform1f(this._uPhosphor.rowShimmerEnabled,  this.effects.perRowShimmer ? 1 : 0);
gl.uniform1f(this._uPhosphor.beamSpreadEnabled,  this.effects.beamSpread ? 1 : 0);
```

- [ ] **Step 3: Verify each new effect via DevTools toggles**

Re-instantiate with the moving rectangle from Task 8. Toggle each:

```js
window.__trinitron.effects.perCellHotspot = false;  // bottom-right of each cell no longer brighter
window.__trinitron.effects.perCellHotspot = true;
window.__trinitron.effects.perCellShimmer = false;  // per-cell brightness jitter flattens
window.__trinitron.effects.perCellShimmer = true;
window.__trinitron.effects.perRowShimmer = false;
window.__trinitron.effects.perRowShimmer = true;
window.__trinitron.effects.beamSpread = false;  // edges harden (no Y blur)
window.__trinitron.effects.beamSpread = true;
```

Each toggle should produce a visible (but subtle) change. The hotspot is most visible at the per-cell scale — zoom in to confirm.

- [ ] **Step 4: Commit**

```bash
git add docs/trinitron.js
git commit -m "$(cat <<'EOF'
Add hotspot, cell shimmer, row shimmer, beam spread to phosphor pass

Phosphor pass is now feature-complete. Per-cell Manhattan-distance
hotspot, deterministic LCG-hash per-cell + per-row shimmer (no LUT
textures), and a 5-tap vertical Gaussian for beam spread on the
signal sample. All four toggleable via __trinitron.effects with
uniform-multiply pattern: free when on, free when off.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Composite pass — phosphor texture to screen

**Files:**
- Modify: `docs/trinitron.js`

Replaces the temporary blitFramebuffer with a real composite pass. The composite shader at this stage just samples the phosphor texture and writes it to the default framebuffer. Subsequent tasks layer in glass effects, bloom, and gap mask.

### Steps

- [ ] **Step 1: Add `COMPOSITE_FS` shader source**

Near the top of the IIFE, after `PHOSPHOR_FS`:

```js
const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPhosphor;
out vec4 oColor;

void main() {
  oColor = texture(uPhosphor, vUv);
}`;
```

- [ ] **Step 2: Compile the composite program in `_initGpu()`**

After the phosphor program compile block:

```js
const cmpVs = compileShader(gl, gl.VERTEX_SHADER, FULLSCREEN_VS);
const cmpFs = compileShader(gl, gl.FRAGMENT_SHADER, COMPOSITE_FS);
this._progComposite = linkProgram(gl, cmpVs, cmpFs);
gl.deleteShader(cmpVs);
gl.deleteShader(cmpFs);
this._programs.push(this._progComposite);

this._uComposite = {
  phosphor: gl.getUniformLocation(this._progComposite, 'uPhosphor'),
};
```

- [ ] **Step 3: Replace the temporary blit with the composite pass**

In `_renderGpu()`, remove the entire "TEMPORARY: blit phosphor → default framebuffer" block (the `blitFramebuffer` lines). Replace with:

```js
// Composite pass — bind default framebuffer, sample phosphor texture.
gl.bindFramebuffer(gl.FRAMEBUFFER, null);
gl.viewport(0, 0, this.canvas.width, this.canvas.height);
gl.clearColor(0, 0, 0, 0);
gl.clear(gl.COLOR_BUFFER_BIT);

gl.useProgram(this._progComposite);
gl.bindVertexArray(this._vao);
gl.activeTexture(gl.TEXTURE0);
gl.bindTexture(gl.TEXTURE_2D, this._texPhosphor);
gl.uniform1i(this._uComposite.phosphor, 0);
gl.drawArrays(gl.TRIANGLES, 0, 3);
```

- [ ] **Step 4: Verify**

Reload, re-instantiate with the test signal. The rendering should look identical to Task 9 — the composite pass is currently a pass-through. The architectural change is that we now own the output composition.

- [ ] **Step 5: Commit**

```bash
git add docs/trinitron.js
git commit -m "$(cat <<'EOF'
Add composite pass — phosphor texture to screen

Replaces the temporary blitFramebuffer with a real composite shader
that samples the phosphor texture and writes to the default
framebuffer. Visually a no-op vs Task 9; architecturally this is
where glass effects, bloom, and gap mask layer in next.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Bake static glass textures — gloss, vignette, curvature LUT, gap mask

**Files:**
- Modify: `docs/trinitron.js`

Pre-bakes the static input textures the composite pass needs. All built once at construction; sampled per-frame at near-zero cost.

### Steps

- [ ] **Step 1: Add a `_buildStaticTextures()` method**

After `_destroyGpu()` add:

```js
_buildStaticTextures() {
  const gl = this._gl;
  const [vw, vh] = this.opts.viewSize;
  const [cw, ch] = this.opts.canvasSize;

  // GLOSS: upper-left elliptical highlight on a 256×256 LUT.
  const glossCanvas = document.createElement('canvas');
  glossCanvas.width = 256;
  glossCanvas.height = 256;
  const gctx = glossCanvas.getContext('2d');
  const grad = gctx.createRadialGradient(80, 64, 0, 80, 64, 200);
  grad.addColorStop(0,   'rgba(255,255,255,0.18)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.04)');
  grad.addColorStop(1,   'rgba(255,255,255,0)');
  gctx.fillStyle = grad;
  gctx.fillRect(0, 0, 256, 256);
  this._texGloss = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, this._texGloss);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, glossCanvas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // VIGNETTE: radial darkening from center toward corners, 128×128.
  const vigCanvas = document.createElement('canvas');
  vigCanvas.width = 128;
  vigCanvas.height = 128;
  const vctx = vigCanvas.getContext('2d');
  vctx.fillStyle = 'white';
  vctx.fillRect(0, 0, 128, 128);
  const vgrad = vctx.createRadialGradient(64, 64, 40, 64, 64, 92);
  vgrad.addColorStop(0,   'rgba(0,0,0,0)');
  vgrad.addColorStop(1,   'rgba(0,0,0,0.18)');
  vctx.fillStyle = vgrad;
  vctx.fillRect(0, 0, 128, 128);
  this._texVignette = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, this._texVignette);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, vigCanvas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // GAP MASK: vertical-line pattern at canvas-pixel-pair resolution.
  // Period 2 canvas-px → every other column 50% dim. We bake at
  // 2× source resolution so the pattern aligns with the stripe upscale.
  const gapW = vw * 2;
  const gapH = 4; // tiny H — we use WRAP_T REPEAT to tile vertically
  const gapCanvas = document.createElement('canvas');
  gapCanvas.width = gapW;
  gapCanvas.height = gapH;
  const gpctx = gapCanvas.getContext('2d');
  gpctx.fillStyle = 'white';
  gpctx.fillRect(0, 0, gapW, gapH);
  gpctx.fillStyle = 'rgba(0,0,0,0.25)';
  for (let x = 1; x < gapW; x += 2) {
    gpctx.fillRect(x, 0, 1, gapH);
  }
  this._texGapMask = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, this._texGapMask);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, gapCanvas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

  // Curvature is computed inline in the shader (cheap polynomial),
  // no texture needed.
}
```

- [ ] **Step 2: Call `_buildStaticTextures()` from `_initGpu()`**

At the end of `_initGpu()` (after the programs compile), add:

```js
this._buildStaticTextures();
```

- [ ] **Step 3: Clean up the static textures in `_destroyGpu()`**

Add to `_destroyGpu()`:

```js
if (this._texGloss)    gl.deleteTexture(this._texGloss);
if (this._texVignette) gl.deleteTexture(this._texVignette);
if (this._texGapMask)  gl.deleteTexture(this._texGapMask);
```

- [ ] **Step 4: Verify textures created without errors**

Reload. In DevTools:

```js
window.__trinitron._texGloss     // WebGLTexture
window.__trinitron._texVignette  // WebGLTexture
window.__trinitron._texGapMask   // WebGLTexture
```

No visual change yet — Task 12 wires them into the composite shader.

- [ ] **Step 5: Commit**

```bash
git add docs/trinitron.js
git commit -m "$(cat <<'EOF'
Bake static glass textures — gloss, vignette, gap mask

All three pre-rendered into 2D canvases at construction time and
uploaded as GL textures. Gloss is a 256×256 elliptical highlight,
vignette is a 128×128 radial darkening LUT, gap mask is a 2vw×4 px
vertical-stripe pattern with vertical WRAP_T REPEAT. Curvature
warp is computed inline in the composite shader (no texture).
Sampling these in the composite is near-free; Task 12 wires them in.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Composite pass — wire glass effects (curvature, gloss, vignette, gap mask)

**Files:**
- Modify: `docs/trinitron.js`

Upgrades the composite shader to apply all four glass effects. Each gated by its own `effects` toggle via uniform-multiply.

### Steps

- [ ] **Step 1: Replace `COMPOSITE_FS` with the glass-aware version**

```js
const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPhosphor;
uniform sampler2D uGloss;
uniform sampler2D uVignette;
uniform sampler2D uGapMask;
uniform vec2 uCanvasSize;
uniform float uCurvature;
uniform float uCurvatureEnabled;
uniform float uGlossEnabled;
uniform float uVignetteEnabled;
uniform float uGapMaskEnabled;
out vec4 oColor;

// Barrel-distortion UV warp. cAmt=0 → identity. cAmt=0.03 → ~3%
// outward cushion at corners.
vec2 curveUv(vec2 uv, float cAmt) {
  vec2 c = uv - 0.5;
  float r2 = dot(c, c);
  vec2 warped = c * (1.0 + cAmt * r2 * 4.0);
  return warped + 0.5;
}

void main() {
  float curvAmt = uCurvature * uCurvatureEnabled;
  vec2 sampleUv = curveUv(vUv, curvAmt);

  // Outside-the-screen check after curvature — clip to black so the
  // warp doesn't sample wrapped edges.
  if (sampleUv.x < 0.0 || sampleUv.x > 1.0 ||
      sampleUv.y < 0.0 || sampleUv.y > 1.0) {
    oColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  vec4 phos = texture(uPhosphor, sampleUv);
  vec3 color = phos.rgb;

  // Gloss: additive highlight (multiplied by enabled).
  vec4 gloss = texture(uGloss, sampleUv);
  color += gloss.rgb * gloss.a * uGlossEnabled;

  // Vignette: multiplicative darkening at corners.
  // Mix toward neutral white when disabled.
  vec4 vig = texture(uVignette, sampleUv);
  float vigFactor = mix(1.0, vig.r, uVignetteEnabled);
  color *= vigFactor;

  // Gap mask: multiplicative darkening per stripe column.
  vec2 gapUv = vec2(sampleUv.x, 0.0);
  vec4 gap = texture(uGapMask, gapUv);
  float gapFactor = mix(1.0, gap.r, uGapMaskEnabled);
  color *= gapFactor;

  oColor = vec4(color, phos.a);
}`;
```

- [ ] **Step 2: Add new uniform locations**

In `_initGpu()` after the composite program compile, extend `this._uComposite`:

```js
this._uComposite = {
  phosphor:          gl.getUniformLocation(this._progComposite, 'uPhosphor'),
  gloss:             gl.getUniformLocation(this._progComposite, 'uGloss'),
  vignette:          gl.getUniformLocation(this._progComposite, 'uVignette'),
  gapMask:           gl.getUniformLocation(this._progComposite, 'uGapMask'),
  canvasSize:        gl.getUniformLocation(this._progComposite, 'uCanvasSize'),
  curvature:         gl.getUniformLocation(this._progComposite, 'uCurvature'),
  curvatureEnabled:  gl.getUniformLocation(this._progComposite, 'uCurvatureEnabled'),
  glossEnabled:      gl.getUniformLocation(this._progComposite, 'uGlossEnabled'),
  vignetteEnabled:   gl.getUniformLocation(this._progComposite, 'uVignetteEnabled'),
  gapMaskEnabled:    gl.getUniformLocation(this._progComposite, 'uGapMaskEnabled'),
};
```

- [ ] **Step 3: Bind textures + upload uniforms in the composite pass**

In `_renderGpu()`, replace the composite-pass body (after `gl.useProgram(this._progComposite);`):

```js
gl.uniform2f(this._uComposite.canvasSize, this.canvas.width, this.canvas.height);
gl.uniform1f(this._uComposite.curvature, this.opts.curvature || 0.025);
gl.uniform1f(this._uComposite.curvatureEnabled, this.effects.curvature ? 1 : 0);
gl.uniform1f(this._uComposite.glossEnabled,     this.effects.gloss ? 1 : 0);
gl.uniform1f(this._uComposite.vignetteEnabled,  this.effects.vignette ? 1 : 0);
gl.uniform1f(this._uComposite.gapMaskEnabled,   this.effects.gapMask ? 1 : 0);

gl.activeTexture(gl.TEXTURE0);
gl.bindTexture(gl.TEXTURE_2D, this._texPhosphor);
gl.uniform1i(this._uComposite.phosphor, 0);
gl.activeTexture(gl.TEXTURE1);
gl.bindTexture(gl.TEXTURE_2D, this._texGloss);
gl.uniform1i(this._uComposite.gloss, 1);
gl.activeTexture(gl.TEXTURE2);
gl.bindTexture(gl.TEXTURE_2D, this._texVignette);
gl.uniform1i(this._uComposite.vignette, 2);
gl.activeTexture(gl.TEXTURE3);
gl.bindTexture(gl.TEXTURE_2D, this._texGapMask);
gl.uniform1i(this._uComposite.gapMask, 3);
```

(Keep the existing `gl.bindVertexArray(this._vao)` and `gl.drawArrays(gl.TRIANGLES, 0, 3)` after the uniform/texture setup.)

- [ ] **Step 4: Verify each glass effect via toggle**

Reload with the white-rectangle signal. Toggle each:

```js
window.__trinitron.effects.curvature = false;  // rectangle's edges become straight (no barrel)
window.__trinitron.effects.curvature = true;   // edges bow outward slightly
window.__trinitron.effects.gloss = false;      // upper-left highlight vanishes
window.__trinitron.effects.gloss = true;
window.__trinitron.effects.vignette = false;   // corners brighten
window.__trinitron.effects.vignette = true;
window.__trinitron.effects.gapMask = false;    // vertical stripes vanish
window.__trinitron.effects.gapMask = true;
```

- [ ] **Step 5: Commit**

```bash
git add docs/trinitron.js
git commit -m "$(cat <<'EOF'
Wire glass effect samples into composite — curvature, gloss, vignette, gap mask

Composite shader now applies all four glass effects. Curvature is a
2nd-order polynomial UV warp computed inline (no texture). Gloss is
additive from the pre-baked highlight LUT. Vignette is multiplicative
toward darker at corners. Gap mask is multiplicative per stripe
column, sampled from the pre-baked vertical-line texture.

All four toggleable via __trinitron.effects with uniform-multiply or
mix-to-neutral patterns. No cost when off.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Selective bloom — threshold + separable Gaussian + additive composite

**Files:**
- Modify: `docs/trinitron.js`

Three new auxiliary passes between the phosphor and composite passes. Bright pixels (above a threshold) bloom; uniform brightness pass-through stays as-is.

### Steps

- [ ] **Step 1: Add shader sources for the three bloom passes**

Near the top of the IIFE, after `COMPOSITE_FS`:

```js
const BLOOM_THRESHOLD_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPhosphor;
uniform float uThreshold;
out vec4 oColor;
void main() {
  vec4 c = texture(uPhosphor, vUv);
  float luma = max(c.r, max(c.g, c.b));
  float overshoot = max(0.0, luma - uThreshold);
  oColor = vec4(c.rgb * overshoot, c.a);
}`;

const BLOOM_BLUR_H_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexSize;
out vec4 oColor;
void main() {
  vec2 px = 1.0 / uTexSize;
  vec4 sum = texture(uTex, vUv) * 0.227027;
  sum += texture(uTex, vUv + vec2( px.x * 1.0, 0.0)) * 0.194594;
  sum += texture(uTex, vUv + vec2(-px.x * 1.0, 0.0)) * 0.194594;
  sum += texture(uTex, vUv + vec2( px.x * 2.0, 0.0)) * 0.121622;
  sum += texture(uTex, vUv + vec2(-px.x * 2.0, 0.0)) * 0.121622;
  sum += texture(uTex, vUv + vec2( px.x * 3.0, 0.0)) * 0.054054;
  sum += texture(uTex, vUv + vec2(-px.x * 3.0, 0.0)) * 0.054054;
  sum += texture(uTex, vUv + vec2( px.x * 4.0, 0.0)) * 0.016216;
  sum += texture(uTex, vUv + vec2(-px.x * 4.0, 0.0)) * 0.016216;
  oColor = sum;
}`;

const BLOOM_BLUR_V_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexSize;
out vec4 oColor;
void main() {
  vec2 px = 1.0 / uTexSize;
  vec4 sum = texture(uTex, vUv) * 0.227027;
  sum += texture(uTex, vUv + vec2(0.0,  px.y * 1.0)) * 0.194594;
  sum += texture(uTex, vUv + vec2(0.0, -px.y * 1.0)) * 0.194594;
  sum += texture(uTex, vUv + vec2(0.0,  px.y * 2.0)) * 0.121622;
  sum += texture(uTex, vUv + vec2(0.0, -px.y * 2.0)) * 0.121622;
  sum += texture(uTex, vUv + vec2(0.0,  px.y * 3.0)) * 0.054054;
  sum += texture(uTex, vUv + vec2(0.0, -px.y * 3.0)) * 0.054054;
  sum += texture(uTex, vUv + vec2(0.0,  px.y * 4.0)) * 0.016216;
  sum += texture(uTex, vUv + vec2(0.0, -px.y * 4.0)) * 0.016216;
  oColor = sum;
}`;
```

- [ ] **Step 2: Compile programs and create half-res FBOs in `_initGpu()`**

Append to `_initGpu()` (before `_buildStaticTextures()`):

```js
// Bloom programs.
const bthVs = compileShader(gl, gl.VERTEX_SHADER, FULLSCREEN_VS);
const bthFs = compileShader(gl, gl.FRAGMENT_SHADER, BLOOM_THRESHOLD_FS);
this._progBloomThresh = linkProgram(gl, bthVs, bthFs);
gl.deleteShader(bthVs); gl.deleteShader(bthFs);
this._programs.push(this._progBloomThresh);
this._uBloomThresh = {
  phosphor:  gl.getUniformLocation(this._progBloomThresh, 'uPhosphor'),
  threshold: gl.getUniformLocation(this._progBloomThresh, 'uThreshold'),
};

const bhVs = compileShader(gl, gl.VERTEX_SHADER, FULLSCREEN_VS);
const bhFs = compileShader(gl, gl.FRAGMENT_SHADER, BLOOM_BLUR_H_FS);
this._progBloomH = linkProgram(gl, bhVs, bhFs);
gl.deleteShader(bhVs); gl.deleteShader(bhFs);
this._programs.push(this._progBloomH);
this._uBloomH = {
  tex:     gl.getUniformLocation(this._progBloomH, 'uTex'),
  texSize: gl.getUniformLocation(this._progBloomH, 'uTexSize'),
};

const bvVs = compileShader(gl, gl.VERTEX_SHADER, FULLSCREEN_VS);
const bvFs = compileShader(gl, gl.FRAGMENT_SHADER, BLOOM_BLUR_V_FS);
this._progBloomV = linkProgram(gl, bvVs, bvFs);
gl.deleteShader(bvVs); gl.deleteShader(bvFs);
this._programs.push(this._progBloomV);
this._uBloomV = {
  tex:     gl.getUniformLocation(this._progBloomV, 'uTex'),
  texSize: gl.getUniformLocation(this._progBloomV, 'uTexSize'),
};

// Half-res bloom textures + FBOs.
const bw = Math.max(1, vw >> 1);
const bh = Math.max(1, vh >> 1);
this._bloomW = bw; this._bloomH = bh;
const makeRGBA8Tex = (w, h) => {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
};
this._texBloomA = makeRGBA8Tex(bw, bh);
this._texBloomB = makeRGBA8Tex(bw, bh);
this._fboBloomA = gl.createFramebuffer();
gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboBloomA);
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._texBloomA, 0);
this._fboBloomB = gl.createFramebuffer();
gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboBloomB);
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._texBloomB, 0);
gl.bindFramebuffer(gl.FRAMEBUFFER, null);
```

And add to `_destroyGpu()`:

```js
if (this._texBloomA) gl.deleteTexture(this._texBloomA);
if (this._texBloomB) gl.deleteTexture(this._texBloomB);
if (this._fboBloomA) gl.deleteFramebuffer(this._fboBloomA);
if (this._fboBloomB) gl.deleteFramebuffer(this._fboBloomB);
```

- [ ] **Step 3: Run the three bloom passes in `_renderGpu()`**

In `_renderGpu()`, between the phosphor pass and the composite pass, add:

```js
// Bloom passes (skip entirely when disabled — real CPU savings).
if (this.effects.selectiveBloom) {
  // 3a. Threshold: phosphor → bloomA.
  gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboBloomA);
  gl.viewport(0, 0, this._bloomW, this._bloomH);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(this._progBloomThresh);
  gl.bindVertexArray(this._vao);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, this._texPhosphor);
  gl.uniform1i(this._uBloomThresh.phosphor, 0);
  gl.uniform1f(this._uBloomThresh.threshold, this.opts.bloomThreshold || 0.6);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // 3b. Horizontal Gaussian: bloomA → bloomB.
  gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboBloomB);
  gl.useProgram(this._progBloomH);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, this._texBloomA);
  gl.uniform1i(this._uBloomH.tex, 0);
  gl.uniform2f(this._uBloomH.texSize, this._bloomW, this._bloomH);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // 3c. Vertical Gaussian: bloomB → bloomA.
  gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboBloomA);
  gl.useProgram(this._progBloomV);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, this._texBloomB);
  gl.uniform1i(this._uBloomV.tex, 0);
  gl.uniform2f(this._uBloomV.texSize, this._bloomW, this._bloomH);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  // Final bloom output sits in _texBloomA.
}
```

- [ ] **Step 4: Extend `COMPOSITE_FS` to additively blend bloom**

Update `COMPOSITE_FS` to add a bloom uniform and additive sample:

```js
const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPhosphor;
uniform sampler2D uGloss;
uniform sampler2D uVignette;
uniform sampler2D uGapMask;
uniform sampler2D uBloom;
uniform vec2 uCanvasSize;
uniform float uCurvature;
uniform float uBloomStrength;
uniform float uCurvatureEnabled;
uniform float uGlossEnabled;
uniform float uVignetteEnabled;
uniform float uGapMaskEnabled;
uniform float uBloomEnabled;
out vec4 oColor;

vec2 curveUv(vec2 uv, float cAmt) {
  vec2 c = uv - 0.5;
  float r2 = dot(c, c);
  vec2 warped = c * (1.0 + cAmt * r2 * 4.0);
  return warped + 0.5;
}

void main() {
  float curvAmt = uCurvature * uCurvatureEnabled;
  vec2 sampleUv = curveUv(vUv, curvAmt);
  if (sampleUv.x < 0.0 || sampleUv.x > 1.0 ||
      sampleUv.y < 0.0 || sampleUv.y > 1.0) {
    oColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  vec4 phos = texture(uPhosphor, sampleUv);
  vec3 color = phos.rgb;

  vec4 bloom = texture(uBloom, sampleUv);
  color += bloom.rgb * uBloomStrength * uBloomEnabled;

  vec4 gloss = texture(uGloss, sampleUv);
  color += gloss.rgb * gloss.a * uGlossEnabled;

  vec4 vig = texture(uVignette, sampleUv);
  color *= mix(1.0, vig.r, uVignetteEnabled);

  vec4 gap = texture(uGapMask, vec2(sampleUv.x, 0.0));
  color *= mix(1.0, gap.r, uGapMaskEnabled);

  oColor = vec4(color, phos.a);
}`;
```

- [ ] **Step 5: Update composite uniform locations + uploads**

Extend `this._uComposite` with `bloom`, `bloomStrength`, `bloomEnabled`:

```js
this._uComposite.bloom         = gl.getUniformLocation(this._progComposite, 'uBloom');
this._uComposite.bloomStrength = gl.getUniformLocation(this._progComposite, 'uBloomStrength');
this._uComposite.bloomEnabled  = gl.getUniformLocation(this._progComposite, 'uBloomEnabled');
```

In the composite pass uniform-uploads block:

```js
gl.uniform1f(this._uComposite.bloomStrength, this.opts.bloomStrength || 1.0);
gl.uniform1f(this._uComposite.bloomEnabled,  this.effects.selectiveBloom ? 1 : 0);

// Bind bloom texture at unit 4 (units 0-3 already used by phosphor/gloss/vignette/gapMask).
gl.activeTexture(gl.TEXTURE4);
gl.bindTexture(gl.TEXTURE_2D, this._texBloomA);
gl.uniform1i(this._uComposite.bloom, 4);
```

- [ ] **Step 6: Verify**

Reload. Use a signal with a bright pixel (the cursor or saturated text):

```js
window.__trinitron.destroy();
const c = document.querySelector('.mcrt__crt');
const t = new window.Trinitron(c, {
  renderer: 'gpu',
  viewSize: [252, 150],
  canvasSize: [504, 300],
  cellSize: 2,
  signal: (ctx) => {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(120, 60, 16, 20);  // bright square
    ctx.fillStyle = 'rgba(68,128,68,0.4)';
    ctx.fillRect(40, 100, 60, 12);  // dim rect
  },
});
t.start();
```

The bright square should have a visible soft glow around it; the dim rect should not. Toggle:

```js
window.__trinitron.effects.selectiveBloom = false;  // bright square glow vanishes
window.__trinitron.effects.selectiveBloom = true;
```

- [ ] **Step 7: Commit**

```bash
git add docs/trinitron.js
git commit -m "$(cat <<'EOF'
Add selective bloom — threshold + separable Gaussian + additive

Three new GL passes between phosphor and composite. Threshold pass
extracts pixels above luma 0.6 into a half-res buffer. Horizontal
and vertical Gaussians (9-tap, separable) blur the extracted bright
pixels. Composite additively blends the result. Selective: dim
pixels don't bloom, bright ones do — distinct from the uniform halo.

When disabled, all three passes skip entirely via CPU pass-skipping
— real savings, not just-the-same cost.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Slow modulators — warmup, convergence drift, breathing

**Files:**
- Modify: `docs/trinitron.js`

Adds three time-based modulators driven by uniforms updated each frame on CPU. No new shaders — they just modify existing uniforms (brightness multiplier, convergence offsets).

### Steps

- [ ] **Step 1: Add a global "screen modulation" uniform to the composite shader**

Update `COMPOSITE_FS` to multiply final color by a `uBrightness` uniform:

In the `void main()` block, just before `oColor = vec4(color, phos.a);`, add:

```glsl
  color *= uBrightness;
```

And in the uniform block declarations, add:

```glsl
uniform float uBrightness;
```

In `_initGpu()`'s composite uniforms cache, add:

```js
this._uComposite.brightness = gl.getUniformLocation(this._progComposite, 'uBrightness');
```

- [ ] **Step 2: Compute modulator values each frame**

Inside `_renderGpu()`, at the top (after `const [vw, vh] = this.opts.viewSize;` and before the signal callback), add:

```js
// Slow modulators driven by time.
// All amplitudes are tiny so the effects coexist quietly with the
// content. They compound multiplicatively into the final brightness
// and convergence values uploaded to shaders.

// 1. Warmup curve: 0 → 1 over the first ~1.2s after start (or after
//    the last master-mode "on" toggle).
const warmupDur = 1200; // ms
const tWarm = timeMs - (this._warmupStartMs || 0);
let warmupFactor = 1.0;
if (this.effects.warmup && tWarm < warmupDur) {
  // Smoothstep + a touch of overshoot for "tube charging" feel.
  const k = Math.max(0, Math.min(1, tWarm / warmupDur));
  warmupFactor = k * k * (3.0 - 2.0 * k); // smoothstep
}

// 2. Breathing: 0.3 Hz, ±2% brightness modulation.
let breathFactor = 1.0;
if (this.effects.breathing) {
  breathFactor = 1.0 + 0.02 * Math.sin(timeMs * 0.0006 * Math.PI * 2.0);
}

this._brightness = warmupFactor * breathFactor;

// 3. Convergence drift: 0.1 Hz, ±0.05 px on top of base convergence.
this._convergenceDriftPx = 0.0;
if (this.effects.convergenceDrift) {
  this._convergenceDriftPx = 0.05 * Math.sin(timeMs * 0.0002 * Math.PI * 2.0);
}
```

- [ ] **Step 3: Apply drift to convergence uniforms**

In the phosphor-pass uniform-upload block, change the convergence uploads to include the drift:

```js
const c = this.opts.convergence || { r: [-0.25, -0.25], g: [0, 0], b: [0.25, 0.25] };
const drift = this._convergenceDriftPx;
gl.uniform2f(this._uPhosphor.convergenceR, c.r[0] - drift, c.r[1]);
gl.uniform2f(this._uPhosphor.convergenceG, c.g[0],         c.g[1]);
gl.uniform2f(this._uPhosphor.convergenceB, c.b[0] + drift, c.b[1]);
```

(Drift moves R and B in opposite directions, leaving G stable — matches the real-CRT behavior where the green gun is the reference.)

- [ ] **Step 4: Apply brightness to composite uniform**

In the composite pass uniform uploads, add:

```js
gl.uniform1f(this._uComposite.brightness, this._brightness);
```

- [ ] **Step 5: Initialize `_warmupStartMs`**

In `start()`, just before the existing `this._startTime = performance.now();` line, add:

```js
this._warmupStartMs = 0;  // warmup begins at timeMs = 0 since startTime
```

And in `setMasterMode(true)` (Task 3), trigger a fresh warmup by resetting:

Update `setMasterMode()`:

```js
setMasterMode(on) {
  const wasOn = this._masterOn;
  this._masterOn = !!on;
  if (this._masterOn && !wasOn) {
    // Reset warmup so the "on" transition feels like turning the tube on.
    this._warmupStartMs = performance.now() - (this._startTime || performance.now());
  }
  try {
    localStorage.setItem(
      'interslice-systems:is2200:crt-mode',
      this._masterOn ? 'on' : 'off'
    );
  } catch (e) {}
}
```

- [ ] **Step 6: Verify**

Reload. The IS-2200 should fade in over ~1.2 seconds on page load. Toggle:

```js
window.__trinitron.effects.warmup = false;  // future page loads come up instant
window.__trinitron.effects.warmup = true;
```

For breathing — easier to see with a static signal. The screen should very subtly pulse brighter/dimmer. Use a screenshot diff or just stare for 5 seconds.

For convergence drift — open the page, leave it for 30 seconds, and zoom in on a vertical edge. The chromatic fringe should subtly shift over time.

- [ ] **Step 7: Commit**

```bash
git add docs/trinitron.js
git commit -m "$(cat <<'EOF'
Add warmup, convergence drift, breathing slow modulators

All three driven by time uniforms updated each frame on CPU.
Warmup: smoothstep 0→1 over 1.2s on first load and on every
master-mode "on" toggle. Convergence drift: 0.1 Hz LFO on R and B
(green stays stable), ±0.05 px amplitude. Breathing: 0.3 Hz LFO
on overall composite brightness, ±2% amplitude.

Each toggleable via __trinitron.effects with the standard pattern.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: Master A/B mode — GPU bypass

**Files:**
- Modify: `docs/trinitron.js`

When master mode is "off", skip the entire GPU pipeline and draw the raw 2D signal canvas directly to the visible canvas (CSS-scaled).

### Steps

- [ ] **Step 1: Add a 2D rendering context for bypass**

In `_initGpu()`, after `this._signalCtx = ...`, add:

```js
// Bypass mode draws the signal canvas directly to the visible
// canvas via a separate 2D context. We create it lazily — only
// allocate when the user actually toggles off. WebGL2 context
// creation already happened on this canvas, so we can't ask for
// a 2D context on the same canvas. Instead, we use a hidden
// secondary canvas that overlays the WebGL canvas via CSS, and
// toggle their visibility.
this._bypassCanvas = document.createElement('canvas');
this._bypassCanvas.width = this.canvas.width;
this._bypassCanvas.height = this.canvas.height;
this._bypassCanvas.style.cssText = this.canvas.style.cssText;
this._bypassCanvas.style.position = 'absolute';
this._bypassCanvas.style.top = '0';
this._bypassCanvas.style.left = '0';
this._bypassCanvas.style.display = this._masterOn ? 'none' : 'block';
this._bypassCtx = this._bypassCanvas.getContext('2d');
this._bypassCtx.imageSmoothingEnabled = false;
// Caller's container is the canvas's parent (.mcrt for the IS-2200).
// We need position:relative on it for absolute positioning to work.
if (this.canvas.parentElement) {
  const parent = this.canvas.parentElement;
  if (getComputedStyle(parent).position === 'static') {
    parent.style.position = 'relative';
  }
  parent.appendChild(this._bypassCanvas);
}
```

- [ ] **Step 2: Make `_renderGpu()` branch on master mode**

At the very top of `_renderGpu()`, after the signal-paint step (so the signal canvas always reflects current content), add:

```js
if (!this._masterOn) {
  // Bypass: draw the signal canvas directly to the bypass canvas.
  this._bypassCanvas.style.display = 'block';
  this.canvas.style.visibility = 'hidden';
  this._bypassCtx.clearRect(0, 0, this._bypassCanvas.width, this._bypassCanvas.height);
  this._bypassCtx.drawImage(
    this._signalCanvas,
    0, 0, vw, vh,
    0, 0, this._bypassCanvas.width, this._bypassCanvas.height
  );
  this._frameCount++;
  return;
}

// Master mode "on": show WebGL canvas, hide bypass.
this._bypassCanvas.style.display = 'none';
this.canvas.style.visibility = 'visible';
```

- [ ] **Step 3: Clean up `_bypassCanvas` in `_destroyGpu()`**

Add to `_destroyGpu()`:

```js
if (this._bypassCanvas && this._bypassCanvas.parentNode) {
  this._bypassCanvas.parentNode.removeChild(this._bypassCanvas);
}
```

- [ ] **Step 4: Verify**

Reload. Toggle:

```js
window.__trinitron.setMasterMode(false);
// Page should show raw text/cursor — no CRT effects, no stripes,
// no glow, no curvature.
window.__trinitron.setMasterMode(true);
// CRT effects return. Also triggers a fresh warmup fade-in.
```

Reload the page after toggling off:

```js
window.__trinitron.setMasterMode(false);
location.reload();
// Page should come up with CRT off — confirms localStorage persistence.
window.__trinitron.setMasterMode(true);  // restore
```

- [ ] **Step 5: Commit**

```bash
git add docs/trinitron.js
git commit -m "$(cat <<'EOF'
Add master A/B mode — GPU bypass draws raw signal to canvas

When master mode is off, the entire GPU pipeline is skipped. A
separate overlaid 2D canvas draws the signal canvas directly, scaled
to display size with nearest-neighbor sampling. The WebGL canvas is
hidden via CSS. localStorage persists the choice across reloads
(see Task 3). Toggling back on triggers a fresh warmup fade-in
via the hook in setMasterMode.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: Easter-egg power sticker — HTML, CSS, click handler

**Files:**
- Modify: `docs/index.html`

Adds the power-button sticker to the Memphis frame markup, styles it, wires the click handler to call `setMasterMode`. Updates its visual state to reflect current mode.

### Steps

- [ ] **Step 1: Add the sticker markup**

In `docs/index.html`, locate the existing `<aside class="sneak">` block (around line 1042). Find the `<div class="sneak__card">` opening tag. Add the sticker as a child of `.sneak__card` (last child, after `<div class="sneak__foot">`):

```html
<button class="mcrt-power" type="button" aria-label="Toggle CRT effects" aria-pressed="true">⏻</button>
```

- [ ] **Step 2: Add the CSS**

In the inlined `<style>` block, add (a reasonable home: after the `.mcrt__a11y` rules, around line 452):

```css
/* Easter-egg power sticker on the Memphis frame. Toggles the CRT
   effect pipeline on/off via Trinitron.setMasterMode. */
.mcrt-power {
  position: absolute;
  left: 12px;
  bottom: 12px;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-mono);
  font-size: 14px;
  font-weight: 700;
  color: var(--ink-0);
  background: var(--ink-cyan);
  border: 2px solid var(--ink-0);
  box-shadow: 3px 3px 0 0 var(--ink-0);
  cursor: pointer;
  z-index: 5;
  transition: opacity 0.2s ease;
}
.mcrt-power[aria-pressed="false"] {
  opacity: 0.5;
  background: var(--paper-0);
}
.mcrt-power:hover { transform: translate(-1px, -1px); box-shadow: 4px 4px 0 0 var(--ink-0); }
.mcrt-power:active { transform: translate(2px, 2px); box-shadow: 1px 1px 0 0 var(--ink-0); }
```

`.sneak__card` is already `position: relative` indirectly via its box-shadow setup; if not, the styling above relies on it being a containing block. Add `position: relative;` to `.sneak__card`'s CSS rule if it's not already there.

- [ ] **Step 3: Wire the click handler in `initMcrt`**

In the inline `<script>` (bottom of `docs/index.html`), in `initMcrt`, after the `new window.Trinitron(...).start()` call, add:

```js
const powerBtn = document.querySelector('.mcrt-power');
if (powerBtn && window.__trinitron) {
  // Initial state reflects the persisted localStorage value.
  const initialOn = window.__trinitron._masterOn;
  powerBtn.setAttribute('aria-pressed', initialOn ? 'true' : 'false');

  powerBtn.addEventListener('click', () => {
    const newOn = !window.__trinitron._masterOn;
    window.__trinitron.setMasterMode(newOn);
    powerBtn.setAttribute('aria-pressed', newOn ? 'true' : 'false');
  });
}
```

(Note: `window.__trinitron` needs to point at the IS-2200 instance. Verify by finding the line in `initMcrt` that assigns it; if it doesn't exist, add `window.__trinitron = trinitron;` after the `new Trinitron(...)` call.)

- [ ] **Step 4: Verify**

Reload. The sticker appears in the lower-left of the Memphis card. Click it:
- Sticker dims (50% opacity, paper background).
- CRT effects disappear (raw text on dark green).
- Click again: sticker brightens, CRT effects return with warmup fade.
- Reload page: previous state persists.

- [ ] **Step 5: Commit**

```bash
git add docs/index.html
git commit -m "$(cat <<'EOF'
Add easter-egg power sticker — click to toggle CRT mode

A 32×32 Memphis-style sticker (cyan background, hard black border,
offset shadow, ⏻ glyph) anchored to the lower-left corner of the
sneak card frame. Click toggles Trinitron's master mode via
setMasterMode. ARIA pressed-state mirrors current mode. localStorage
persistence handled by setMasterMode.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: Promote IS-2200 from sneak corner to hero section

**Files:**
- Modify: `docs/index.html`

Restructures the page so the IS-2200 becomes its own section between the existing logo hero and the footer. Updates CSS — the Memphis framing primitive stays, but positioning + sizing change.

### Steps

- [ ] **Step 1: Move the `<aside class="sneak">` block into a new `<section class="is2200-hero">`**

Locate the existing `<div class="sneak-row">` (~line 1041) and the `</section>` that closes the logo hero just above it. The new structure:

```html
<!-- ============ HERO: LOGO + WORDMARK + CTA ============ -->
<section class="hero">
  <!-- ... existing logo hero content unchanged ... -->
</section>

<!-- ============ IS-2200 HERO (was sneak corner card) ============ -->
<section class="is2200-hero">
  <aside class="sneak" aria-label="IS-2200 Recipe Router — sneak preview">
    <span class="sneak__tape">↳ sneak preview</span>
    <div class="sneak__card">
      <div class="sneak__head">
        <span class="sneak__sku"><b>IS-2200</b>Recipe Router</span>
      </div>
      <div class="mcrt">
        <canvas class="mcrt__crt" aria-hidden="true"></canvas>
        <div class="mcrt__a11y"></div>
      </div>
      <div class="sneak__foot">
        <!-- existing foot content -->
      </div>
      <button class="mcrt-power" type="button" aria-label="Toggle CRT effects" aria-pressed="true">⏻</button>
    </div>
  </aside>
</section>
```

Delete the old `<div class="sneak-row">` wrapper (it was the corner-positioning hack).

- [ ] **Step 2: Add the `.is2200-hero` CSS rule**

In the inlined `<style>` block, near where `.sneak-row` was defined (~line 238), replace `.sneak-row { ... }` with:

```css
.is2200-hero {
  display: flex;
  justify-content: center;
  padding: 32px 0 24px;
  position: relative;
  z-index: 3;
}
```

- [ ] **Step 3: Resize the `.sneak` element**

Change the existing `.sneak` rule:

```css
.sneak {
  position: relative;
  width: 660px;            /* was 352px */
  transform: rotate(1.5deg);
}
```

- [ ] **Step 4: Update sprinkle positions**

In `docs/index.html`, find the `.sp-tri-2` sprinkle CSS rule (~line 528). The existing comment in the code states `sp-tri-2` is *the only* sprinkle whose position references the corner sneak card. With the hero promotion, the sneak no longer hugs the right edge, so:

```css
.sp-tri-2 {
  top: 18%;
  right: clamp(180px, 22vw, 360px);  /* was: right: clamp(440px, ...) on narrow viewports */
  width: 26px; height: 24px;
  color: var(--ink-yellow);
  transform: rotate(15deg);
}
```

Also delete or update the multi-line CSS comment above the rule (the one describing the corner-collision avoidance math) — its content is no longer accurate.

- [ ] **Step 5: Verify**

Reload. The page should now show the IS-2200 widget centered below the existing logo hero, much larger than before. The mcrt is still rendering the *original* content (252×150 source) — Task 18 expands it to 1280×960. Page tagline + logo hero + IS-2200 hero + footer should stack vertically. No sprinkle should overlap the IS-2200 widget.

- [ ] **Step 6: Commit**

```bash
git add docs/index.html
git commit -m "$(cat <<'EOF'
Promote IS-2200 from sneak corner to hero section

New <section class="is2200-hero"> sits between the existing logo
hero and the footer. The <aside class="sneak"> markup moves
inside it. .sneak grows to 660px wide; the 1.5° rotation and
yellow sneak-preview tape are preserved. Adjusts sp-tri-2 to
no longer reference the corner-card position.

The mcrt canvas still renders at the old 252×150 source size —
Task 18 expands to 1280×960 (640×480 VGA at cs=2).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 18: Update mcrtSignal and initMcrt for 80-col VGA at 1280×960

**Files:**
- Modify: `docs/index.html`

Updates the signal callback to paint 80-col content at VGA resolution, and updates `initMcrt` to construct with the new dimensions + `renderer: 'auto'`. This is where the IS-2200's content visually upgrades.

### Steps

- [ ] **Step 1: Update the `MCRT_VIEW_*` and content constants**

In the inline `<script>` of `docs/index.html`, find the constants block (~line 1315). Replace with:

```js
// IS-2200 sneak-preview screen at native VGA resolution.
// Source canvas = phosphor cells × cellSize. At 640×480 cells with
// cs=2 the source canvas is 1280×960.
const MCRT_PHOSPHOR_W = 640;
const MCRT_PHOSPHOR_H = 480;
const MCRT_CELL_SIZE = 2;
const MCRT_VIEW_W = MCRT_PHOSPHOR_W * MCRT_CELL_SIZE;  // 1280
const MCRT_VIEW_H = MCRT_PHOSPHOR_H * MCRT_CELL_SIZE;  // 960
const MCRT_LINE_H = 48;   // VT323 40px gives ~16px advance × cellSize 2 = 32 ≈ 38; 48 for line gap
const MCRT_PAD_X = 32;
const MCRT_PAD_Y = 48;
const MCRT_FONT = '40px "VT323", "JetBrains Mono", monospace';
const MCRT_LINES = [
  { text: 'IS-2200 · BIOS v2.4 · POWER-ON SELF TEST OK · 14 NODES MESHED · UP 384D', color: '#FF6CB4' },
  { text: '(c) 1983-2026 interslice systems · a wholly-owned subsidiary of NDD', color: 'rgba(68,255,138,0.75)' },
  { text: '', color: '#000000' },  // blank line
  { text: 'mesh status ............................. 14 nodes / 14 expected (100%)', color: 'rgba(68,255,138,0.75)' },
  { text: 'median latency .......................... 0.4 ms          peak: 1.2 ms', color: 'rgba(68,255,138,0.75)' },
  { text: 'phosphor temp ........................... 41 C            persistence OK', color: 'rgba(68,255,138,0.75)' },
  { text: '', color: '#000000' },  // blank line
  { text: 'mirepoix@is-2200:~$ mesh status --verbose --since 24h', color: '#5EE2FF', promptLen: 19 },
  { text: 'RX OK · 4 / 14 nodes · cowabunga · uptime 384d · last reset 2026-01-12', color: '#44FF8A' },
];
```

The font is 40px because we doubled the canvas dimensions (252→1280 wide, ~5×), so we need correspondingly larger text. VT323 at 40px with 80 chars at ~16px advance = ~1280 px — fills the screen exactly.

- [ ] **Step 2: Update `mcrtSignal` to handle blank lines**

Replace `mcrtSignal` with:

```js
function mcrtSignal(ctx, timeMs) {
  ctx.clearRect(0, 0, MCRT_VIEW_W, MCRT_VIEW_H);
  ctx.font = MCRT_FONT;
  ctx.textBaseline = 'top';

  for (let i = 0; i < MCRT_LINES.length; i++) {
    const line = MCRT_LINES[i];
    if (!line.text) continue;
    const y = MCRT_PAD_Y + i * MCRT_LINE_H;
    if (line.promptLen) {
      const prefix = line.text.slice(0, line.promptLen);
      ctx.fillStyle = '#FED105';
      ctx.fillText(prefix, MCRT_PAD_X, y);
      ctx.fillStyle = line.color;
      ctx.fillText(line.text.slice(line.promptLen),
        MCRT_PAD_X + ctx.measureText(prefix).width, y);
    } else {
      ctx.fillStyle = line.color;
      ctx.fillText(line.text, MCRT_PAD_X, y);
    }
  }

  // Cursor at the end of the last non-empty line. Larger block for
  // VGA scale.
  if ((timeMs % 1100) < 550) {
    let lastIdx = MCRT_LINES.length - 1;
    while (lastIdx >= 0 && !MCRT_LINES[lastIdx].text) lastIdx--;
    if (lastIdx >= 0) {
      const last = MCRT_LINES[lastIdx];
      const cursorX = MCRT_PAD_X + ctx.measureText(last.text).width + 4;
      const cursorY = MCRT_PAD_Y + lastIdx * MCRT_LINE_H;
      ctx.fillStyle = '#44FF8A';
      ctx.fillRect(cursorX, cursorY, 18, 36);
    }
  }
}
```

- [ ] **Step 3: Update the `initMcrt` construction**

Replace the `new window.Trinitron(canvas, {...})` block in `initMcrt` with:

```js
new window.Trinitron(canvas, {
  renderer: 'auto',  // try GPU, fall back to CPU
  signal: mcrtSignal,
  viewSize: [MCRT_VIEW_W, MCRT_VIEW_H],
  canvasSize: [MCRT_VIEW_W, MCRT_VIEW_H],
  cellSize: MCRT_CELL_SIZE,
  phosphorCoupling: 0.35,
  persistence: 0.55,
  convergence: { r: [-0.25, -0.25], g: [0, 0], b: [0.25, 0.25] },
  beamSpreadPx: 0.4,
  hotspot: 0.18,
  cellShimmer: 0.03,
  rowShimmer: 0.012,
  curvature: 0.025,
  bloomThreshold: 0.6,
  bloomStrength: 0.9,
  damperWires: [],  // disabled for text mode
}).start();
```

Note: `canvasSize` and `viewSize` are the same now (no stripeUpscale — the GPU handles sampling natively). Display size in CSS is controlled by `width: 100%` on `.mcrt__crt`.

- [ ] **Step 4: Update `.mcrt__crt` CSS for the new aspect ratio**

In the inlined `<style>`, find the `.mcrt__crt` rule. Change to:

```css
.mcrt__crt {
  display: block;
  width: 640px;
  height: 480px;
  max-width: 100%;
  aspect-ratio: 4 / 3;
}
```

(Fixed 640×480 is the canonical size — on 2× DPR displays this maps to exactly 1280×960 device pixels = exactly 2 device pixels per phosphor cell, matching the spec's clean-sampling target. `max-width: 100%` falls back to fluid sizing on viewports too narrow for 640 px, accepting some sub-pixel sampling on those rare cases. The `aspect-ratio` rule reserves layout space before the canvas is sized.)

- [ ] **Step 5: Verify**

Reload. The IS-2200 widget should now show:
- 80-column text rendered through the full GPU pipeline.
- Real VGA-scale phosphor density (640×480 cells visible at 2× DPR).
- All effects (stripes, persistence, convergence, glass, bloom, modulators) applying.
- Click the power sticker to bypass and see the raw text.

If the rendering looks broken (no text visible, or wildly distorted): check the browser console for GL errors, and verify `__trinitron._mode === 'gpu'`.

- [ ] **Step 6: Commit**

```bash
git add docs/index.html
git commit -m "$(cat <<'EOF'
Render IS-2200 at native VGA — 640×480 phosphor cells, 80-col text

mcrt signal callback now paints 8 lines of 80-col VT323 40px content
into a 1280×960 source canvas (640×480 phosphor cells × cs=2). Adds
blank-line handling, larger cursor (18×36), and period-correct BIOS
content matching the design spec.

initMcrt switches to renderer: 'auto' — GPU pipeline with CPU
fallback. canvasSize and viewSize are now identical (no stripeUpscale
needed; GPU samples natively). Display size scales via CSS
aspect-ratio 4/3.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 19: `?debug=1` effect-toggle overlay

**Files:**
- Modify: `docs/trinitron.js`

Adds a floating debug panel that lets you toggle every effect via checkboxes and shows a live FPS counter. Activated only when `?debug=1` is in the URL.

### Steps

- [ ] **Step 1: Add `_initDebugOverlay()` method**

After `_buildStaticTextures()` in `docs/trinitron.js`, add:

```js
_initDebugOverlay() {
  // Only build the panel when ?debug=1 is in the URL.
  const params = new URLSearchParams(location.search);
  if (params.get('debug') !== '1') return;

  const panel = document.createElement('div');
  panel.style.cssText = `
    position: fixed; top: 12px; right: 12px; z-index: 9999;
    background: rgba(0,0,0,0.85); color: #fff;
    font: 11px/1.4 monospace; padding: 12px 14px;
    border: 1px solid #555; border-radius: 4px;
    max-width: 240px; max-height: 80vh; overflow: auto;
  `;
  panel.innerHTML = `<div style="font-weight:700;margin-bottom:8px;">__trinitron debug</div>`;

  // FPS readout.
  const fpsEl = document.createElement('div');
  fpsEl.style.cssText = 'margin-bottom:10px;color:#5EE2FF;';
  fpsEl.textContent = 'fps: --';
  panel.appendChild(fpsEl);
  this._debugFps = fpsEl;
  this._debugFpsLast = performance.now();
  this._debugFpsFrames = 0;

  // Effect checkboxes.
  const keys = Object.keys(this.effects);
  for (const key of keys) {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;padding:2px 0;';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!this.effects[key];
    cb.addEventListener('change', () => { this.effects[key] = cb.checked; });
    row.appendChild(cb);
    const lbl = document.createElement('span');
    lbl.textContent = key;
    row.appendChild(lbl);
    panel.appendChild(row);
  }

  document.body.appendChild(panel);
  this._debugPanel = panel;
}
```

- [ ] **Step 2: Call from `_initGpu()`**

At the end of `_initGpu()` (after `_buildStaticTextures()`):

```js
this._initDebugOverlay();
```

- [ ] **Step 3: Update FPS counter each frame**

In `_renderGpu()`, at the end (after `this._frameCount++`):

```js
if (this._debugFps) {
  this._debugFpsFrames++;
  const now = performance.now();
  if (now - this._debugFpsLast >= 500) {
    const fps = Math.round(this._debugFpsFrames * 1000 / (now - this._debugFpsLast));
    this._debugFps.textContent = `fps: ${fps}`;
    this._debugFpsFrames = 0;
    this._debugFpsLast = now;
  }
}
```

- [ ] **Step 4: Remove panel in `_destroyGpu()`**

```js
if (this._debugPanel && this._debugPanel.parentNode) {
  this._debugPanel.parentNode.removeChild(this._debugPanel);
}
```

- [ ] **Step 5: Verify**

Visit `http://localhost:8000/?debug=1`. A panel appears top-right with 18 checkboxes and an FPS counter. Toggle each checkbox; the corresponding effect should turn on/off live.

On a normal page load (no `?debug=1`), the panel must not appear.

- [ ] **Step 6: Commit**

```bash
git add docs/trinitron.js
git commit -m "$(cat <<'EOF'
Add ?debug=1 effect-toggle overlay

Floating top-right panel with one checkbox per effect plus a live
FPS counter. Activated only when ?debug=1 is in the URL — production
visitors never see it. Toggles wire directly to __trinitron.effects.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 20: Final validation pass

**Files:**
- None modified — this task is verification only.

Walks through every entry in the spec's "Validation" section. If any check fails, file a follow-up issue (or make a small fix and commit separately); the plan ends with a confirmed-working state.

### Steps

- [ ] **Step 1: Per-effect debug panel walkthrough**

Open `http://localhost:8000/?debug=1`. For each of the 18 effects in the panel, uncheck and observe a visible change. Document any effect whose toggle produces no apparent change — it likely indicates a wiring bug. Common failure modes:
- Uniform location not retrieved in `_initGpu`.
- Uniform not uploaded in `_renderGpu`.
- Shader doesn't actually reference the `uXEnabled` uniform.

- [ ] **Step 2: Master A/B sanity check**

Click the power sticker. The CRT effects should disappear cleanly — no flash, no stale frame, no GL errors. Click again; warmup fade-in plays.

- [ ] **Step 3: FPS verification**

In the debug panel, confirm the FPS counter reads at or near the display refresh rate (60 on most monitors, 120 on high-refresh). If significantly below: examine the GL pipeline's frame-time cost in DevTools Performance panel.

- [ ] **Step 4: CPU fallback verification**

In DevTools, run:

```js
// Override getContext to fail for webgl2.
const origGet = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
  if (type === 'webgl2') return null;
  return origGet.call(this, type, ...rest);
};
location.reload();
```

After reload, `__trinitron._mode` should be `'cpu'`. The IS-2200 should still render (slowly — expect ~20-30 Hz) with the CPU-path effects. Restore by removing the override (or just close and reopen the tab).

- [ ] **Step 5: Reduced-motion verification**

In DevTools rendering panel, set "Emulate CSS media feature prefers-reduced-motion" to "reduce". Reload. The mcrt should render one steady-state frame (no animation, no breathing, no cursor blink), and `__trinitron._rafHandle` should be `null`.

- [ ] **Step 6: localStorage persistence**

Toggle power sticker off. Reload. The page should come up with effects off, sticker dimmed. Toggle on; reload; the page comes up with effects on. Confirm `localStorage.getItem('interslice-systems:is2200:crt-mode')` matches.

- [ ] **Step 7: Both themes work**

In DevTools console: `document.documentElement.setAttribute('data-theme', 'dark')` — IS-2200 still renders. `document.documentElement.setAttribute('data-theme', 'light')` — still renders. `document.documentElement.removeAttribute('data-theme')` — still renders, defaults follow OS preference. The IS-2200 is theme-invariant by design.

- [ ] **Step 8: Dark-mode logo still works**

In dark mode, confirm the existing logo hero (top of page, rotating arms) still renders correctly. It should be running on the CPU path (`renderer: 'cpu'` explicitly in its construction — verify if needed). The GPU port should not have affected it.

- [ ] **Step 9: Update CLAUDE.md to mention the GPU path**

In `CLAUDE.md`, find the "Trinitron renderer" section (added when the project's pure-CSS convention was relaxed for the original trinitron.js). Add a paragraph noting that the IS-2200 now uses the GPU path, the dark-mode logo stays on CPU, and the master A/B toggle is the easter-egg sticker. Be brief — link to the spec.

- [ ] **Step 10: Final commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
Document IS-2200 GPU rendering in CLAUDE.md

After the GPU Trinitron port, the IS-2200 widget uses the WebGL2
pipeline while the dark-mode logo stays on the CPU renderer.
Master A/B toggle is the lower-left easter-egg power sticker on
the Memphis frame.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final notes for the implementing engineer

- **No formal tests in this repo by design.** Every "verify" step uses the running page in a browser. The `?debug=1` overlay is your best friend.
- **Frequent commits.** Each task ends in a commit; if you find yourself working for more than ~30 minutes without committing, you've probably skipped a verification step.
- **CPU code is untouched.** If you find yourself modifying CPU-path code, stop — the CPU renderer is shared with the dark-mode logo and must keep working.
- **Don't optimize prematurely.** The GPU budget is generous. Profile only if FPS drops below display refresh rate.
- **The cs=2 layout's B-via-coupling-only behavior is deliberate.** It's load-bearing for the IS-2200's visual identity. Don't add a primary-B column.
