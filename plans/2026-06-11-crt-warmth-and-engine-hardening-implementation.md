# CRT Warmth + Engine Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Subagents in this project are always Opus-tier (project memory), never Haiku.

**Goal:** Make the two peer CRT renderers endearing (cut dying-TV effects, add color grade / tube corners / warmup settle, a Sonic-waterfall test channel) and efficient (time-based persistence, demand-driven idle scheduler, RGBA8 textures, context-loss recovery), per `specs/2026-06-11-crt-warmth-and-engine-hardening-design.md`.

**Architecture:** Approach A — every engine change lands twice, once per peer file (`docs/trinitron.js`, `docs/shadow-mask.js`), keeping the documented copy-share convention. Engine substrate first (Tasks 1–10), then look work (Tasks 11–14), then presets/tuning/verification (Tasks 15–17). Consumers: `docs/tv.html` (service bay + bench) and `docs/index.html` (hero, options only).

**Tech Stack:** Plain JS + WebGL2, no toolchain, no test framework (deliberate — CLAUDE.md). **Verification replaces TDD here:** every task runs `node --check` on touched `.js` files, and milestone tasks verify in a real browser via Playwright MCP against `python3 -m http.server -d docs 8000`. The chrome-devtools MCP cannot attach in this environment (profile in use) — use Playwright MCP.

**Conventions for every task:**
- Edits are given as exact replace pairs (old → new). Anchors are unique strings in the file as of commit `92401d7`.
- Commit after each task, repo style: sentence-case imperative summary, body explaining why, trailer `Co-Authored-By:` crediting the Claude model driving the session.
- Both pages must keep working after every commit (each task leaves a coherent, runnable state).

**Browser-verification harness (used by several tasks):**

```bash
# once, backgrounded; kill when done
python3 -m http.server -d docs 8000
```

Then with Playwright MCP: `browser_navigate` to `http://localhost:8000/tv.html?ch=4&renderer=trinitron`, `browser_evaluate` for console-level checks (e.g. `() => window.__crt._mode`), `browser_take_screenshot` for visuals. Check the browser console for shader compile errors after any shader edit — `browser_console_messages` must show no `[error]` entries.

---

### Task 1: Cut convergenceDrift / breathing / perRowShimmer from trinitron.js

**Files:**
- Modify: `docs/trinitron.js`

- [ ] **Step 1: Remove shimmer from the phosphor shader**

In `PHOSPHOR_FS`, delete these three uniform declarations:

```glsl
uniform float uRowShimmerAmp;
uniform uint uShimmerSeed;
```
and
```glsl
uniform float uRowShimmerEnabled;
```

Delete the `lcg` helper entirely:

```glsl
// Deterministic LCG hash → [0,1].
float lcg(uint seed) {
  uint x = 1664525u * seed + 1013904223u;
  return float(x) * (1.0 / 4294967296.0);
}
```

Replace the shimmer application at the end of `main()` (the whole block from the `// Per-row shimmer.` comment through the `oPhosphor` write):

```glsl
  // Per-row shimmer. Stable hash per source-pixel row (dividing the
  // output Y by cellSize.y undoes the integer upscale, mapping output
  // pixels back to source rows) — the only animated micro-texture in
  // the phosphor model (uShimmerSeed is uploaded per-frame in
  // _renderGpu, throttled to reseed at ~30 fps).
  uint rowIdx = uint(floor(px.y / uCellSize.y));
  // 4099u prime stride retained for hash stability — original rationale
  // (decorrelating from per-cell shimmer) is moot now that cell shimmer
  // is gone, but changing it would shift the visible shimmer pattern.
  float rowShim = 1.0 + uRowShimmerAmp * (2.0 * lcg(rowIdx * 4099u + uShimmerSeed) - 1.0);
  rowShim = mix(1.0, rowShim, uRowShimmerEnabled);

  vec3 stripeOut = lerped.rgb * weights * rowShim;
  oPhosphor = vec4(stripeOut, lerped.a);
```

with:

```glsl
  vec3 stripeOut = lerped.rgb * weights;
  oPhosphor = vec4(stripeOut, lerped.a);
```

- [ ] **Step 2: Remove the options and effect keys**

In `PANEL_OPT_KEYS`, remove `'rowShimmer',` (the list keeps everything else).

In the constructor's `opts` defaults, delete:

```js
        // Optional per-row brightness noise. 0 = off. Cheap stand-in for
        // the line-to-line beam-current fluctuation a real CRT exhibits;
        // uniform along Y within each source row.
        rowShimmer: 0.0,
        shimmerSeed: 1983,
```

In the `effects` defaults, delete the three keys and fix the count comment:

```js
        // Phosphor pass — four effects on, three off.
```
→
```js
        // Phosphor pass — four effects on, one off.
```

Delete `        convergenceDrift: false,` and `        perRowShimmer: false,`.

Replace:
```js
        // Slow modulators — both off by default; warmup is a one-shot
        // brightness ramp that callers can re-enable if they want the
        // tube-warming-up moment.
        warmup: false,
        breathing: false,
```
with:
```js
        // Slow modulator — off by default; warmup is a one-shot
        // brightness ramp that callers can re-enable if they want the
        // tube-warming-up moment.
        warmup: false,
```

- [ ] **Step 3: Remove the uniform plumbing**

In the `_uPhosphor` location map, delete these three entries:

```js
        rowShimmerAmp:        gl.getUniformLocation(this._progPhosphor, 'uRowShimmerAmp'),
        shimmerSeed:          gl.getUniformLocation(this._progPhosphor, 'uShimmerSeed'),
```
and
```js
        rowShimmerEnabled:    gl.getUniformLocation(this._progPhosphor, 'uRowShimmerEnabled'),
```

In `_uploadStaticUniforms`, delete:

```js
      gl.uniform1f(this._uPhosphor.rowShimmerAmp,    this.opts.rowShimmer);
      // shimmerSeed is uploaded per-frame in _renderGpu (derived from
      // the frame counter so the row pattern reseeds at ~30 fps).
```

Also update the method's doc comment: replace its last paragraph

```js
    // Uniforms still uploaded per frame in _renderGpu: the *Enabled
    // toggles (?debug=1 panel mutates them at runtime), brightness
    // (warmup/breathing modulate it), convergence R/B when drift
    // is active, and shimmerSeed (frame-counter-derived, so the row
    // shimmer pattern reseeds at ~30 fps instead of holding fixed).
```
with
```js
    // Uniforms still uploaded per frame in _renderGpu: the *Enabled
    // toggles (?debug=1 panel mutates them at runtime) and brightness
    // (the warmup ramp modulates it).
```

- [ ] **Step 4: Remove the per-frame work in `_renderGpu`**

Delete the breathing block and simplify the brightness assignment:

```js
      // 2. Breathing: 0.3 Hz, ±2% brightness modulation.
      let breathFactor = 1.0;
      if (this.effects.breathing) {
        breathFactor = 1.0 + 0.02 * Math.sin(timeMs * 0.0006 * Math.PI * 2.0);
      }

      this._brightness = warmupFactor * breathFactor;

      // 3. Convergence drift: 0.1 Hz, ±0.05 px on top of base convergence.
      //    R and B drift opposite; G stays stable (matches real CRT
      //    behavior where the green gun is the reference).
      this._convergenceDriftPx = 0.0;
      if (this.effects.convergenceDrift) {
        this._convergenceDriftPx = 0.05 * Math.sin(timeMs * 0.0002 * Math.PI * 2.0);
      }
```
→
```js
      this._brightness = warmupFactor;
```

Also update the intro comment above the warmup block: replace

```js
      // Slow modulators driven by time. All amplitudes are tiny so the
      // effects coexist quietly with the content. Compound multiplicatively
      // into the final brightness uniform; convergence drift modulates the
      // per-channel UV offsets.

      // 1. Warmup curve: 0 → 1 over the first ~1.2s after start.
```
with
```js
      // Warmup: one-shot brightness ramp, 0 → 1 over the first ~1.2 s
      // after start. The only time-driven modulator in the model.
```

Delete the per-frame shimmer/drift uploads:

```js
      gl.uniform1f(this._uPhosphor.rowShimmerEnabled,  this.effects.perRowShimmer    ? 1 : 0);
```
and the whole block:
```js
      // Per-row shimmer seed: throttle to ~30 fps by shifting the frame
      // counter right by 1 (one new pattern every 2 render frames). The
      // option value seeds the sequence; the frame counter advances it.
      // `>>> 0` coerces to uint32 (matches the uniform1ui type and the
      // shader's `uint uShimmerSeed`).
      const animatedSeed = (this.opts.shimmerSeed + (this._frameCount >> 1)) >>> 0;
      gl.uniform1ui(this._uPhosphor.shimmerSeed, animatedSeed);

      // Convergence drift: override base R/B per-frame while active.
      // G never drifts (it's the reference channel). On the transition
      // from active→inactive, re-upload base R/B once so the GPU isn't
      // left with the last drifted values.
      const driftActive = this.effects.convergenceDrift;
      if (driftActive) {
        const c = this.opts.convergence;
        const drift = this._convergenceDriftPx;
        gl.uniform2f(this._uPhosphor.convergenceR, c.r[0] - drift, c.r[1]);
        gl.uniform2f(this._uPhosphor.convergenceB, c.b[0] + drift, c.b[1]);
      } else if (this._convergenceDriftWasActive) {
        const c = this.opts.convergence;
        gl.uniform2f(this._uPhosphor.convergenceR, c.r[0], c.r[1]);
        gl.uniform2f(this._uPhosphor.convergenceB, c.b[0], c.b[1]);
      }
      this._convergenceDriftWasActive = driftActive;
```

Also fix the now-stale comment in `_uploadStaticUniforms` above the convergence upload — replace

```js
      // Convergence base — R/B get overridden per-frame when drift is
      // active. On the transition back to inactive, _renderGpu re-uploads
      // the base values once to clear the drifted state.
```
with
```js
      // Convergence base offsets (static; per-channel UV shifts).
```

- [ ] **Step 5: Remove the three schema items**

In `Trinitron.effectSchema`, delete the `convergenceDrift` item:

```js
        { key: 'convergenceDrift', label: 'convergence drift', scope: 'universal',
          desc: 'Slow time-varying R/B shift on top of base. Mistuned-yoke wobble.' },
```

the `perRowShimmer` item:

```js
        { key: 'perRowShimmer',    label: 'per-row shimmer', scope: 'universal',
          desc: 'Per-scanline brightness noise. The only animated micro-texture in the model (reseeds at ~30 fps).',
          params: [{ opt: 'rowShimmer', min: 0, max: 0.1, step: 0.005, sub: 'amount' }] },
```

and the `breathing` item (the `modulation` group keeps only `warmup`):

```js
        { key: 'breathing', label: 'breathing', scope: 'universal',
          desc: 'Slow brightness modulation. Power-supply ripple feel.' },
```

- [ ] **Step 6: Syntax check**

Run: `node --check docs/trinitron.js`
Expected: no output, exit 0.

Also grep for stragglers: `grep -n "rowShim\|shimmerSeed\|breathing\|convergenceDrift\|ShimmerSeed\|RowShimmer" docs/trinitron.js`
Expected: no matches.

- [ ] **Step 7: Commit**

```bash
git add docs/trinitron.js
git commit -m "Cut convergence drift, breathing, per-row shimmer from Trinitron"
```

---

### Task 2: Same cut in shadow-mask.js

**Files:**
- Modify: `docs/shadow-mask.js`

- [ ] **Step 1: Remove shimmer from the phosphor shader**

In `PHOSPHOR_FS`, delete the declarations `uniform float uRowShimmerAmp;`, `uniform uint uShimmerSeed;`, `uniform float uRowShimmerEnabled;`, and the same `lcg` helper block as Task 1.

Replace the end of `main()`:

```glsl
  // Per-row shimmer — universal beam-current ripple, same hash as
  // Trinitron's. uShimmerSeed advances per-frame in _renderGpu.
  uint rowIdx = uint(row);
  float rowShim = 1.0 + uRowShimmerAmp * (2.0 * lcg(rowIdx * 4099u + uShimmerSeed) - 1.0);
  rowShim = mix(1.0, rowShim, uRowShimmerEnabled);

  oPhosphor = vec4(phosphor * rowShim, lerped.a);
```
with:
```glsl
  oPhosphor = vec4(phosphor, lerped.a);
```

- [ ] **Step 2: Remove options, effects, uniform plumbing, per-frame work, schema items**

Mirror Task 1 steps 2–5 exactly, with these shadow-mask-specific anchors:

- `PANEL_OPT_KEYS`: remove `'rowShimmer',`.
- `opts`: delete the `rowShimmer: 0.0,` block (its comment reads `// Optional per-row brightness noise. 0 = off. Cheap stand-in for` …) and `shimmerSeed: 1983,`.
- `effects`: delete `convergenceDrift: false,`, `perRowShimmer: false,`, `breathing: false,`; same comment fixes as Task 1 (`four effects on, three off` → `four effects on, one off`; the `// Slow modulators — both off…` block → singular, keeping only `warmup: false,`).
- `_uPhosphor`: delete the `rowShimmerAmp`, `shimmerSeed`, `rowShimmerEnabled` entries.
- `_uploadStaticUniforms`: delete `gl.uniform1f(this._uPhosphor.rowShimmerAmp,    this.opts.rowShimmer);` and the two-line `// shimmerSeed is uploaded per-frame…` comment; same doc-comment rewrite as Task 1 Step 3; same convergence-comment rewrite as Task 1 Step 4.
- `_renderGpu`: delete the breathing block + `this._brightness = warmupFactor * breathFactor;` → `this._brightness = warmupFactor;`, the convergence-drift block, the `rowShimmerEnabled` upload, the `animatedSeed` block, and the drift-override block — identical content to Task 1 Step 4 (shadow-mask has the same code).
- `ShadowMask.effectSchema`: delete the `convergenceDrift`, `perRowShimmer`, and `breathing` items (same shape as Task 1 Step 5; shadow-mask's `perRowShimmer` item also has the `rowShimmer` param row).

- [ ] **Step 3: Syntax check**

Run: `node --check docs/shadow-mask.js && grep -n "rowShim\|shimmerSeed\|breathing\|convergenceDrift" docs/shadow-mask.js`
Expected: clean check, no grep matches.

- [ ] **Step 4: Commit**

```bash
git add docs/shadow-mask.js
git commit -m "Cut convergence drift, breathing, per-row shimmer from ShadowMask"
```

---

### Task 3: Remove the rowShimmer pre-seeds from both consumers

**Files:**
- Modify: `docs/tv.html`
- Modify: `docs/index.html`

- [ ] **Step 1: tv.html**

In `makeRenderer`'s `common` object, delete:

```js
      rowShimmer: 0.02,         // pre-seeded bench value — perRowShimmer effect is off by default, matching the hero
```

- [ ] **Step 2: index.html**

In `createTrinitron`, delete `            rowShimmer: 0.02,` from **both** branches (the `new window.ShadowMask(…)` options and the `new window.Trinitron(…)` options).

- [ ] **Step 3: Browser smoke test**

Start the server, then with Playwright MCP:
- `http://localhost:8000/tv.html?ch=4&renderer=trinitron` → screenshot shows the test card through the Trinitron, console has no errors, the bench has **no** "per-row shimmer", "convergence drift", or "breathing" rows.
- Flip RENDERER knob (click it) → shadow-mask renders, same absences.
- `http://localhost:8000/` with dark mode (`browser_evaluate`: `() => document.documentElement.setAttribute('data-theme','dark')`) → hero renders, no console errors.

- [ ] **Step 4: Commit**

```bash
git add docs/tv.html docs/index.html
git commit -m "Drop rowShimmer pre-seeds from tv.html and hero options"
```

---

### Task 4: Time-based persistence in trinitron.js

**Files:**
- Modify: `docs/trinitron.js`

- [ ] **Step 1: Replace the option**

In `opts` defaults, replace:

```js
        persistence: 0.85,
```
with:
```js
        // Phosphor afterglow half-life in ms. Frame-rate independent:
        // each rendered frame converts this to a per-frame decay via
        // pow(0.5, dt / halfLife), so trails are the same length at
        // 60 Hz, 120 Hz, or any video frame rate. 71 ms ≈ the old
        // 0.85-per-frame decay at 60 Hz.
        persistenceHalfLifeMs: 71,
```

In `PANEL_OPT_KEYS`, replace `'persistence',` with `'persistenceHalfLifeMs',`.

- [ ] **Step 2: Move the upload from static to per-frame**

In `_uploadStaticUniforms`, delete:

```js
      gl.uniform1f(this._uPhosphor.persistence,      this.opts.persistence);
```

In `_renderGpu`, right after the per-frame `*Enabled` toggle uploads (after the `beamSpreadEnabled` line), add:

```js
      // Frame-rate-independent persistence: convert the half-life to a
      // decay factor for the actual time since the last rendered frame.
      // A long gap (idle wake, tab switch) drives decay toward 0 — the
      // trail is honestly gone by the time we render again.
      const hl = this.opts.persistenceHalfLifeMs;
      const dtMs = this._lastRenderT == null ? 16.7 : Math.max(1, timeMs - this._lastRenderT);
      this._lastRenderT = timeMs;
      const decay = hl > 0 ? Math.pow(0.5, dtMs / hl) : 0;
      gl.uniform1f(this._uPhosphor.persistence, decay);
```

- [ ] **Step 3: Track the timestamp**

In the constructor, immediately **after** `this._startTime = null;` (placement matters: Task 9 later uses the `this._wasStartedByUser … this._startTime = null;` block as a replace anchor, so don't insert inside it), add:

```js
      this._lastRenderT = null;
```

In `start()`, next to `this._startTime = performance.now();`, add:

```js
      this._lastRenderT = null;
```

- [ ] **Step 4: Update the schema item**

Replace the `persistence` schema item's desc/params:

```js
        { key: 'persistence',      label: 'persistence', scope: 'universal',
          desc: 'Phosphor afterglow. Previous frame lerps with new at this decay.',
          params: [{ opt: 'persistence', min: 0, max: 0.99, step: 0.01, sub: 'decay' }] },
```
→
```js
        { key: 'persistence',      label: 'persistence', scope: 'universal',
          desc: 'Phosphor afterglow. Half-life of the previous frame\'s contribution, in ms — frame-rate independent.',
          params: [{ opt: 'persistenceHalfLifeMs', min: 0, max: 500, step: 5, sub: 'half-life (ms)' }] },
```

- [ ] **Step 5: Verify and commit**

Run: `node --check docs/trinitron.js && grep -n "opts.persistence\b\|'persistence'," docs/trinitron.js`
Expected: clean check; grep shows no remaining reads of the old option (the `persistence` *effect key* and `persistenceEnabled` uniform remain — those are correct).

```bash
git add docs/trinitron.js
git commit -m "Make Trinitron persistence a frame-rate-independent half-life"
```

---

### Task 5: Time-based persistence in shadow-mask.js

**Files:**
- Modify: `docs/shadow-mask.js`

- [ ] **Step 1: Apply Task 4 to shadow-mask.js**

Identical changes, shadow-mask anchors: `opts` has `persistence: 0.85,` (same replacement, same comment); `PANEL_OPT_KEYS` swap; `_uploadStaticUniforms` delete `gl.uniform1f(this._uPhosphor.persistence,      this.opts.persistence);`; `_renderGpu` gets the same dt/decay block after the `beamSpreadEnabled` upload; constructor + `start()` get `this._lastRenderT = null;`; the schema `persistence` item gets the same desc/params replacement.

- [ ] **Step 2: Verify and commit**

Run: `node --check docs/shadow-mask.js`
Expected: clean.

```bash
git add docs/shadow-mask.js
git commit -m "Make ShadowMask persistence a frame-rate-independent half-life"
```

---

### Task 6: Convert consumer persistence values

**Files:**
- Modify: `docs/tv.html`
- Modify: `docs/index.html`

- [ ] **Step 1: tv.html** — in `makeRenderer`'s `common`, replace `      persistence: 0.82,` with `      persistenceHalfLifeMs: 58,   // ≈ the old 0.82/frame at 60 Hz`

- [ ] **Step 2: index.html** — in both `createTrinitron` branches, replace `            persistence: 0.82,` with `            persistenceHalfLifeMs: 58,`

- [ ] **Step 3: Browser verify**

On `tv.html?ch=5&renderer=trinitron` (motion reel): trails look like before (starfield streaks leave brief afterglow). Bench shows "half-life (ms)" slider at 58; dragging to 400 produces long smears, 0 kills trails. Hero dark mode: rotating logo unchanged. No console errors.

- [ ] **Step 4: Commit**

```bash
git add docs/tv.html docs/index.html
git commit -m "Convert consumers to persistenceHalfLifeMs (0.82/frame -> 58 ms)"
```

---

### Task 7: RGBA8 frame textures + extension-requirement removal in trinitron.js

**Files:**
- Modify: `docs/trinitron.js`

- [ ] **Step 1: Delete the extension gates**

In `_initGpu`, delete both blocks (keeping `this._gl = gl;`):

```js
      // Float textures for persistence (no extension needed in WebGL2).
      // EXT_color_buffer_float lets us render TO float — required because
      // the phosphor/persistence attachments are RGBA32F. Check (and
      // throw) BEFORE mutating this.* so the constructor leaves no
      // half-initialized GPU state behind on failure.
      const cbf = gl.getExtension('EXT_color_buffer_float');
      if (!cbf) throw new Error('EXT_color_buffer_float unavailable');
      // OES_texture_float_linear lets us sample RGBA32F textures with
      // LINEAR filtering in a shader. Without it, `texture(uPhosphor, ...)`
      // in the composite pass silently returns vec4(0) — no GL error,
      // just a black phosphor read — because LINEAR on a float texture
      // is "texture-incomplete" in WebGL2. The phosphor and persistence
      // textures use LINEAR (Task 9 consistency fix), so this extension
      // is load-bearing. Same throw-before-mutate discipline as above.
      const tfl = gl.getExtension('OES_texture_float_linear');
      if (!tfl) throw new Error('OES_texture_float_linear unavailable');
```

(The `if (!gl) throw new Error('WebGL2 unavailable');` stays — it's the binary degradation gate, and tv.html's `/unavailable/i` fallback latch matches it.)

- [ ] **Step 2: Switch the frame textures to RGBA8**

Replace the texture factory (comment included):

```js
      // Persistence ping-pong textures (RGBA32F). Persistence textures
      // are LINEAR so convergence-shifted reads in the phosphor pass
      // produce chromatic-fringe blending consistent with the signal
      // sample. The phosphor output texture is NEAREST so the composite
      // pass's upscale (canvas backing ≫ viewSize) tiles each phosphor
      // source pixel as a sharp block; LINEAR on this texture averaged
      // adjacent stripes into mush.
      const makeFloatTex = (w, h, filter) => {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
      };
      this._texPersistA = makeFloatTex(vw, vh, gl.LINEAR);
      this._texPersistB = makeFloatTex(vw, vh, gl.LINEAR);
      this._texPhosphor = makeFloatTex(vw, vh, gl.NEAREST);
```
with:
```js
      // Persistence ping-pong + phosphor textures (RGBA8 — every stored
      // value is bounded [0,1], so 8 bits suffice and no float-render
      // extensions are needed; any WebGL2 context runs the full
      // pipeline). Persistence textures are LINEAR so convergence-
      // shifted reads blend consistently with the signal sample. The
      // phosphor output texture is NEAREST so the composite upscale
      // tiles each source pixel as a sharp block; LINEAR here averaged
      // adjacent stripes into mush. The shader subtracts a half-LSB
      // fade bias so 8-bit trails always reach zero.
      const makeFrameTex = (w, h, filter) => {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
      };
      this._texPersistA = makeFrameTex(vw, vh, gl.LINEAR);
      this._texPersistB = makeFrameTex(vw, vh, gl.LINEAR);
      this._texPhosphor = makeFrameTex(vw, vh, gl.NEAREST);
```

- [ ] **Step 3: Half-LSB fade bias in the shader**

In `PHOSPHOR_FS`, replace:

```glsl
  // Store pre-stripe value so weights don't compound across frames.
  oPersistenceNext = lerped;
```
with:
```glsl
  // Store pre-stripe value so weights don't compound across frames.
  // Half-LSB fade bias: in 8-bit, prev*decay can round back to prev at
  // the bottom few grey levels and a trail would never reach zero.
  // Subtracting 0.5/255 guarantees termination; cost to live signal is
  // ≤0.2% brightness — invisible.
  oPersistenceNext = max(lerped - 0.5 / 255.0, vec4(0.0));
```

- [ ] **Step 4: Update the `start()` clear comment**

Replace the comment inside `start()`:

```js
        // Clear both persistence textures by binding each FBO and
        // clearing all attachments. MUST use clearBufferfv for
        // RGBA32F attachments — `gl.clear()` on float color buffers
        // is undefined per the WebGL2 spec and produces NaN on some
        // drivers, which then propagates forever through the
        // persistence lerp (NaN * anything = NaN) and poisons every
        // subsequent frame to black.
```
with:
```js
        // Clear both persistence textures by binding each FBO and
        // clearing all attachments. clearBufferfv is also correct for
        // normalized RGBA8 attachments (values clamp to [0,1]).
```

(The code itself is unchanged.)

- [ ] **Step 5: Verify and commit**

Run: `node --check docs/trinitron.js && grep -n "RGBA32F\|EXT_color_buffer_float\|OES_texture_float_linear\|makeFloatTex" docs/trinitron.js`
Expected: clean check, no matches.

Browser: `tv.html?ch=5&renderer=trinitron` — picture identical to before (motion reel, trails, bloom), no console errors.

```bash
git add docs/trinitron.js
git commit -m "Trinitron frame textures to RGBA8; drop float-render extension gates"
```

---

### Task 8: RGBA8 in shadow-mask.js

**Files:**
- Modify: `docs/shadow-mask.js`

- [ ] **Step 1: Apply Task 7 to shadow-mask.js**

Identical edits at the same anchors (extension blocks, `makeFloatTex` → `makeFrameTex` with the same replacement comment, `oPersistenceNext = lerped;` → biased write — note shadow-mask has no `// Store pre-stripe…` comment line, the anchor is just `  oPersistenceNext = lerped;` — and the `start()` comment).

- [ ] **Step 2: Verify and commit**

Run: `node --check docs/shadow-mask.js && grep -n "RGBA32F\|EXT_color_buffer_float\|OES_texture_float_linear" docs/shadow-mask.js`
Expected: clean.

Browser: `tv.html?ch=5&renderer=shadow-mask` renders as before; hero `/?crt=shadow-mask` dark mode renders; no console errors.

```bash
git add docs/shadow-mask.js
git commit -m "ShadowMask frame textures to RGBA8; drop float-render extension gates"
```

---

### Task 9: Demand-driven scheduler in trinitron.js

The performance contract (spec §3): running at content rate while the signal is animated, a ~8-half-life settle tail when it goes static, fully parked (zero work) when idle, halted when offscreen, reduced-motion unchanged. Signal callbacks may return `false` = "nothing new painted"; `undefined`/truthy = animated (full back-compat — the hero changes nothing).

**Files:**
- Modify: `docs/trinitron.js`

- [ ] **Step 1: Dirty contract in `_renderGpu`**

Replace:

```js
    _renderGpu(timeMs) {
      const gl = this._gl;
      if (!gl) return;  // raced with destroy()

      // Paint signal first (caller's callback fills the 2D canvas).
      const [vw, vh] = this.opts.viewSize;
      this._signalCtx.clearRect(0, 0, vw, vh);
      this.opts.signal(this._signalCtx, timeMs);
```
with:
```js
    _renderGpu(timeMs) {
      const gl = this._gl;
      if (!gl) return false;  // raced with destroy()

      // Paint signal first (caller's callback fills the 2D canvas).
      // The callback may return false — "nothing new painted" — in
      // which case the GPU keeps sampling the previous signal texture
      // and this frame only advances persistence decay. undefined or
      // truthy (every pre-contract callback) means animated.
      const [vw, vh] = this.opts.viewSize;
      this._signalCtx.clearRect(0, 0, vw, vh);
      const painted = this.opts.signal(this._signalCtx, timeMs);
      const dirty = painted !== false;
```

Wrap the damper-wire stamping **and** the signal upload in the dirty gate. The damper block currently begins `if (this.effects.damperWires &&` — change its condition to `if (dirty && this.effects.damperWires &&` (rest unchanged). Then replace:

```js
      // Upload the 2D canvas to the signal texture. FLIP_Y accounts for
```
…through…
```js
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
```
with:
```js
      if (dirty) {
        // Upload the 2D canvas to the signal texture. FLIP_Y accounts
        // for canvas's top-left vs WebGL's bottom-left origin.
        gl.bindTexture(gl.TEXTURE_2D, this._texSignal);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, this._signalCanvas);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      }
```

At the very end of `_renderGpu` (after the `_debugFps` block), add:

```js
      return dirty;
```

- [ ] **Step 2: Scheduler state in the constructor**

Replace:

```js
      this._wasStartedByUser = false;
      this._setupReducedMotionListener();
      this._rafHandle = null;
      this._startTime = null;
```
with:
```js
      // Scheduler state. _wasStartedByUser is user intent (start() sets,
      // stop() clears); _mode is what the loop is doing right now:
      //   'stopped' — halted (never started, stop()ed, offscreen, RM)
      //   'running' — RAF loop live
      //   'idle'    — parked: signal static + trails settled; zero work
      //               until requestRender(), a visibility change, or
      //               start() wakes it.
      this._wasStartedByUser = false;
      this._mode = 'stopped';
      this._visible = true;
      this._idleAt = Infinity;
      this._setupReducedMotionListener();
      this._setupVisibilityObserver();
      this._rafHandle = null;
      this._startTime = null;
```

(Note: `this._lastRenderT = null;` was added by Task 4 and stays.)

- [ ] **Step 3: Replace start/stop with the scheduler**

Replace the entire existing `start()` and `stop()` methods with:

```js
    start() {
      this._wasStartedByUser = true;
      if (this._rafHandle != null) return;
      // Zero the persistence trail so a stop/restart (e.g. theme toggle)
      // doesn't leave the last session's frame ghosted into this one.
      // clearBufferfv is also correct for normalized RGBA8 attachments.
      // Guarded on _gl because destroy() nulls it.
      if (this._gl) {
        const gl = this._gl;
        const zeros = new Float32Array([0, 0, 0, 0]);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboPhosphorWithA);
        gl.clearBufferfv(gl.COLOR, 0, zeros);
        gl.clearBufferfv(gl.COLOR, 1, zeros);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this._fboPhosphorWithB);
        gl.clearBufferfv(gl.COLOR, 0, zeros);
        gl.clearBufferfv(gl.COLOR, 1, zeros);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
      this._warmupStartMs = 0;  // warmup begins at timeMs = 0 since startTime
      this._startTime = performance.now();
      this._lastRenderT = null;
      this._resumeLoop();
    }

    stop() {
      this._wasStartedByUser = false;
      this._mode = 'stopped';
      if (this._rafHandle != null) {
        cancelAnimationFrame(this._rafHandle);
        this._rafHandle = null;
      }
    }

    // Cancel the frame loop WITHOUT touching user intent — used by the
    // visibility observer and reduced-motion handler, so a renderer
    // hidden by scroll or RM resumes when conditions allow.
    _haltLoop() {
      if (this._rafHandle != null) {
        cancelAnimationFrame(this._rafHandle);
        this._rafHandle = null;
      }
      if (this._mode !== 'idle') this._mode = 'stopped';
    }

    // Settle tail: how long to keep rendering after the signal goes
    // static so persistence trails decay below one 8-bit LSB.
    // log2(255) ≈ 7.994 half-lives; zero when persistence is off.
    _settleTailMs() {
      if (!this.effects.persistence) return 0;
      return (this.opts.persistenceHalfLifeMs || 0) * 7.994;
    }

    // (Re)enter the frame loop if user intent, visibility, GPU state,
    // and reduced-motion all allow. Unlike start(), never clears the
    // persistence trail or re-triggers warmup — this is "wake up",
    // not "turn on".
    _resumeLoop() {
      if (this._rafHandle != null) return;
      if (!this._gl || !this._wasStartedByUser || !this._visible) return;
      if (this._reducedMotionMq && this._reducedMotionMq.matches) {
        // Single static frame at t past the warmup ramp (1200 ms) so a
        // warmup-enabled consumer shows the steady-state tube.
        this._renderGpu(Math.max(1200, performance.now() - this._startTime));
        return;
      }
      this._idleAt = performance.now() + this._settleTailMs();
      const tick = (now) => {
        const t = now - this._startTime;
        const dirty = this._renderGpu(t);
        // A fresh signal frame or an active warmup ramp resets the idle
        // deadline; otherwise the deadline set by the last dirty frame
        // stands, and the loop parks itself once trails have settled.
        const warmingUp = this.effects.warmup && t < (this._warmupStartMs || 0) + 1200;
        if (dirty || warmingUp) this._idleAt = now + this._settleTailMs();
        // stop() may have nulled _rafHandle during the frame work
        // (e.g. theme MutationObserver firing mid-tick). Don't re-queue.
        if (this._rafHandle === null) return;
        if (now >= this._idleAt) {
          this._rafHandle = null;
          this._mode = 'idle';   // parked: zero work until woken
          return;
        }
        this._rafHandle = requestAnimationFrame(tick);
      };
      this._mode = 'running';
      this._rafHandle = requestAnimationFrame(tick);
    }

    // Public poke: wake a parked renderer for at least one frame —
    // param changes on a static picture, channel switches, etc.
    // No-op while the loop is already live (or stopped by the user).
    requestRender() {
      this._resumeLoop();
    }

    _setupVisibilityObserver() {
      if (typeof IntersectionObserver === 'undefined') return;
      // A decorative effect nobody can see should cost nothing: halt
      // offscreen, resume on re-entry (idle/settle logic re-applies).
      this._io = new IntersectionObserver((entries) => {
        this._visible = entries[entries.length - 1].isIntersecting;
        if (this._visible) this._resumeLoop();
        else this._haltLoop();
      });
      this._io.observe(this.canvas);
    }
```

- [ ] **Step 4: Rewire reduced-motion and destroy**

In `_setupReducedMotionListener`, replace:

```js
      this._reducedMotionHandler = () => {
        if (mq.matches) this.stop();
        else if (this._wasStartedByUser) this.start();
      };
```
with:
```js
      this._reducedMotionHandler = () => {
        // Halt/resume without clearing user intent; _resumeLoop's RM
        // branch renders the single static frame on re-entry.
        if (mq.matches) this._haltLoop();
        else this._resumeLoop();
      };
```

In `destroy()`, after the reduced-motion teardown block, add:

```js
      if (this._io) { this._io.disconnect(); this._io = null; }
```

- [ ] **Step 5: Pokes from the param API and debug overlay**

In `writeParam`, replace:

```js
      if (this._gl) this._uploadStaticUniforms();
```
with:
```js
      if (this._gl) this._uploadStaticUniforms();
      this.requestRender();   // repaint even when parked on a static picture
```

In `_initDebugOverlay`, replace the checkbox handler:

```js
          cb.addEventListener('change', () => { this.effects[item.key] = cb.checked; });
```
with:
```js
          cb.addEventListener('change', () => { this.effects[item.key] = cb.checked; this.requestRender(); });
```

(Sliders already poke via `writeParam`.)

- [ ] **Step 6: Verify and commit**

Run: `node --check docs/trinitron.js`
Expected: clean.

Browser (`tv.html?renderer=trinitron`):
- `ch=5` (motion): `browser_evaluate` `() => window.__crt._mode` → `"running"`.
- `ch=4` (test card): tv.html doesn't yet return `false` (Task 11), so mode stays `"running"` — expected at this stage.
- Hero dark mode: logo rotates as before; toggling `data-theme` light/dark stops/starts as before.

```bash
git add docs/trinitron.js
git commit -m "Add demand-driven scheduler to Trinitron (dirty contract, idle, IO)"
```

---

### Task 10: Scheduler in shadow-mask.js

**Files:**
- Modify: `docs/shadow-mask.js`

- [ ] **Step 1: Apply Task 9 to shadow-mask.js**

Identical changes with one difference: shadow-mask has **no damper-wire block**, so Step 1's dirty gate only wraps the signal-texture upload (same replace pair). All other steps (constructor state, start/stop/_haltLoop/_settleTailMs/_resumeLoop/requestRender/_setupVisibilityObserver, RM handler, destroy, writeParam + overlay pokes, `return dirty;`) are the same code at the same anchors.

- [ ] **Step 2: Verify and commit**

Run: `node --check docs/shadow-mask.js`
Expected: clean. Browser: `tv.html?ch=5&renderer=shadow-mask` runs; hero `/?crt=shadow-mask` unaffected.

```bash
git add docs/shadow-mask.js
git commit -m "Add demand-driven scheduler to ShadowMask (dirty contract, idle, IO)"
```

---

### Task 11: Scheduler integration in tv.html

**Files:**
- Modify: `docs/tv.html`

- [ ] **Step 1: Static flags on the channels**

Replace the `CHANNELS` array:

```js
  const CHANNELS = [
    { num: 2, name: 'SMPTE BARS', draw: drawSmpteBars },
    { num: 3, name: 'CROSSHATCH', draw: drawCrosshatch },
    { num: 4, name: 'TEST CARD',  draw: drawTestCard },
    { num: 5, name: 'MOTION',     draw: drawMotionReel },
    { num: 6, name: 'SNOW',       draw: drawSnow },
  ];
```
with:
```js
  // static: true → one frame then the wrapper reports "nothing new"
  // and the renderer's scheduler parks itself (fps: idle on the bench).
  const CHANNELS = [
    { num: 2, name: 'SMPTE BARS', draw: drawSmpteBars, static: true },
    { num: 3, name: 'CROSSHATCH', draw: drawCrosshatch, static: true },
    { num: 4, name: 'TEST CARD',  draw: drawTestCard,  static: true },
    { num: 5, name: 'MOTION',     draw: drawMotionReel, static: false },
    { num: 6, name: 'SNOW',       draw: drawSnow,       static: false },
  ];
```

- [ ] **Step 2: Dirty-aware paintChannel**

Replace:

```js
  let channelIdx = 0;
  let channelSwitchWall = -Infinity;          // performance.now() of last switch (-Infinity = no interstitial pending)
  function paintChannel(ctx, t) {
    if (performance.now() - channelSwitchWall < 150) drawSnow(ctx, t, SIGNAL_W, SIGNAL_H);
    else CHANNELS[channelIdx].draw(ctx, t, SIGNAL_W, SIGNAL_H);
  }
```
with:
```js
  let channelIdx = 0;
  let channelSwitchWall = -Infinity;          // performance.now() of last switch (-Infinity = no interstitial pending)
  let staticPainted = false;                  // current static channel already delivered its one frame
  function paintChannel(ctx, t) {
    if (performance.now() - channelSwitchWall < 150) {
      staticPainted = false;                  // snow ends with one fresh paint of the channel
      drawSnow(ctx, t, SIGNAL_W, SIGNAL_H);
      return true;
    }
    const ch = CHANNELS[channelIdx];
    if (ch.static && staticPainted) return false;   // scheduler contract: nothing new
    ch.draw(ctx, t, SIGNAL_W, SIGNAL_H);
    staticPainted = !!ch.static;
    return true;
  }
```

- [ ] **Step 3: Wake on channel/renderer changes**

In `setRenderer`, immediately after `    rendererIdx = idx;`, add:

```js
    staticPainted = false;      // new output device needs a fresh paint
```

In `setChannel`, replace:

```js
  function setChannel(idx) {
    channelIdx = idx;
    if (reducedMotion.matches) {
      // no snow interstitial; repaint exactly one frame of the new channel
      channelSwitchWall = -Infinity;
      if (renderer) renderer.start();
      else startBypass();
    } else {
      channelSwitchWall = performance.now();
    }
```
with:
```js
  function setChannel(idx) {
    channelIdx = idx;
    staticPainted = false;
    if (reducedMotion.matches) {
      // no snow interstitial; repaint exactly one frame of the new channel
      channelSwitchWall = -Infinity;
      if (renderer) renderer.start();
      else { stopBypass(); startBypass(); }
    } else {
      channelSwitchWall = performance.now();
      // wake a parked renderer (or bypass loop) for the interstitial
      if (renderer) renderer.requestRender();
      else { stopBypass(); startBypass(); }
    }
```

- [ ] **Step 4: Bypass parks on static channels**

Replace `bypassTick`:

```js
  function bypassTick(now) {
    paintChannel(octx, now - bypassStart);
    bctx.imageSmoothingEnabled = false;
    bctx.drawImage(off, 0, 0, byCanvas.width, byCanvas.height);
    if (!reducedMotion.matches) bypassRaf = requestAnimationFrame(bypassTick);
  }
```
with:
```js
  function bypassTick(now) {
    const dirty = paintChannel(octx, now - bypassStart);
    if (dirty) {
      bctx.imageSmoothingEnabled = false;
      bctx.drawImage(off, 0, 0, byCanvas.width, byCanvas.height);
    }
    // Bypass has no persistence to settle: park as soon as the channel
    // reports static (snow interstitials always report dirty; the wake
    // path is setChannel/setRenderer restarting the loop).
    if (!reducedMotion.matches && dirty) bypassRaf = requestAnimationFrame(bypassTick);
    else bypassRaf = null;
  }
```

- [ ] **Step 5: Bench learns "idle" and pokes on toggles**

In the bench FPS `setInterval`, replace:

```js
    if (dt > 0) benchFpsEl.textContent = `fps: ${Math.round(delta * 1000 / dt)}`;
```
with:
```js
    if (dt > 0) {
      // _mode is a deliberate cross-file private read, like _frameCount.
      benchFpsEl.textContent = renderer._mode === 'idle'
        ? 'fps: idle'
        : `fps: ${Math.round(delta * 1000 / dt)}`;
    }
```

In `rebuildBench`, replace the checkbox handler:

```js
        cb.addEventListener('change', () => { renderer.effects[item.key] = cb.checked; });
```
with:
```js
        cb.addEventListener('change', () => { renderer.effects[item.key] = cb.checked; renderer.requestRender(); });
```

- [ ] **Step 6: Browser verify the contract end-to-end**

On `tv.html?ch=4&renderer=trinitron` (static test card):
- Wait ~2 s after load (warmup 1.2 s + settle ~0.5 s); `browser_evaluate` `() => window.__crt._mode` → `"idle"`; bench reads `fps: idle`.
- Click the CHANNEL knob (→ ch 5 motion): snow burst plays, then mode → `"running"`, fps ≈ display rate.
- Click around back to ch 4: snow, one repaint, parks again.
- Drag a bench slider while idle → picture updates (single repaint, then idle).
- Toggle a bench checkbox while idle → same.
- Renderer knob → shadow-mask: same idle behavior on ch 4.
- Renderer knob → bypass on ch 4: paints once; `browser_evaluate` `() => window.__bypassRaf === undefined` is not directly readable — instead verify by screenshot that the picture is present and CPU is quiet (no continuous repaint: take two screenshots 1 s apart, identical).
- Hero `/` dark: still animates continuously (rotating logo = always dirty).

- [ ] **Step 7: Commit**

```bash
git add docs/tv.html
git commit -m "Wire tv.html to the scheduler: static channels park, knobs wake"
```

---

### Task 12: Context-loss recovery in both renderers

**Files:**
- Modify: `docs/trinitron.js`
- Modify: `docs/shadow-mask.js`

- [ ] **Step 1: Guard the debug overlay against rebuild**

In both files, at the top of `_initDebugOverlay`, after the `if (!this.opts.debugOverlay) return;` line, add:

```js
      if (this._debugPanel) return;   // context-restore re-runs _initGpu
```

- [ ] **Step 2: Listeners in the constructor (both files)**

In both constructors, immediately after `this._setupVisibilityObserver();`, add:

```js
      // Context-loss recovery: a GPU reset/driver hiccup currently
      // means a permanently dead canvas. Stop cleanly on loss, rebuild
      // all GPU state and resume on restore. preventDefault() is
      // required or the restored event never fires.
      this._onContextLost = (e) => {
        e.preventDefault();
        this._haltLoop();
        this._gl = null;
      };
      this._onContextRestored = () => {
        this._initGpu();
        this._resumeLoop();
      };
      this.canvas.addEventListener('webglcontextlost', this._onContextLost);
      this.canvas.addEventListener('webglcontextrestored', this._onContextRestored);
```

- [ ] **Step 3: Teardown in destroy() (both files)**

In both `destroy()` methods, after the `_io` disconnect line added in Tasks 9/10, add:

```js
      this.canvas.removeEventListener('webglcontextlost', this._onContextLost);
      this.canvas.removeEventListener('webglcontextrestored', this._onContextRestored);
```

- [ ] **Step 4: Verify and commit**

Run: `node --check docs/trinitron.js && node --check docs/shadow-mask.js`

Browser, on `tv.html?ch=5&renderer=trinitron`, simulate loss/restore via `browser_evaluate`:

```js
() => {
  const gl = document.getElementById('crt').getContext('webgl2');
  const ext = gl.getExtension('WEBGL_lose_context');
  ext.loseContext();
  setTimeout(() => ext.restoreContext(), 500);
  return 'ok';
}
```

Expected: picture blanks, then comes back within a second and keeps animating; console shows no uncaught errors.

```bash
git add docs/trinitron.js docs/shadow-mask.js
git commit -m "Recover from WebGL context loss in both renderers"
```

---

### Task 13: Color grade + warmup color settle in trinitron.js

**Files:**
- Modify: `docs/trinitron.js`

- [ ] **Step 1: Composite shader**

In `COMPOSITE_FS`, after `uniform float uScanlineDepth;`, add:

```glsl
uniform vec3 uGradeGains;           // white-point RGB gains (CPU-computed from temperature)
uniform float uGradeSaturation;     // luma-preserving saturation
uniform float uGradeEnabled;
```

After the closing brace of the `if (inStripe) { … }` block and before `  vec4 gloss = texture(uGloss, sampleUv);`, insert:

```glsl
  // Phosphor color grade — the tube's color character, applied to
  // emitted light only. Gloss (a reflection on the glass in front of
  // the phosphor) and vignette/gap-mask (glass/bezel) come after and
  // are not tinted by it.
  float gradeLuma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  vec3 graded = mix(vec3(gradeLuma), color, uGradeSaturation) * uGradeGains;
  color = mix(color, graded, uGradeEnabled);
```

- [ ] **Step 2: Options, effect key, schema**

In `opts` defaults, after `bloomStrength: 1.0,`, add:

```js
        // Phosphor color grade — the tube's color character. Temperature
        // ∈ [-1, 1] maps to RGB white-point gains (positive = warm);
        // saturation is a luma-preserving lift. Applied to emitted
        // light only, before the glass gloss. Defaults tuned on the
        // tv.html bench; the colorGrade effect is off unless a caller
        // (e.g. presets.tv) opts in.
        gradeTemperature: 0.3,
        gradeSaturation: 1.08,
```

In `effects` defaults, after `gapMask: false,`, add:

```js
        // Color grade — off by default; the TV preset opts in.
        colorGrade: false,
```

In `PANEL_OPT_KEYS`, after `'bleedRadius',`, add `'gradeTemperature', 'gradeSaturation',`.

In the schema's `composite` group, after the `scanlines` item, add:

```js
        { key: 'colorGrade', label: 'color grade', scope: 'universal',
          desc: 'The tube\'s color character — warm white point + saturation lift on emitted light. Warmup settles into it.',
          params: [
            { opt: 'gradeTemperature', min: -1, max: 1, step: 0.05, sub: 'temperature' },
            { opt: 'gradeSaturation',  min: 0,  max: 2, step: 0.02, sub: 'saturation' },
          ] },
```

- [ ] **Step 3: Uniform plumbing**

In the `_uComposite` assignments (next to the `scanlineDepth` line), add:

```js
      this._uComposite.gradeGains       = gl.getUniformLocation(this._progComposite, 'uGradeGains');
      this._uComposite.gradeSaturation  = gl.getUniformLocation(this._progComposite, 'uGradeSaturation');
      this._uComposite.gradeEnabled     = gl.getUniformLocation(this._progComposite, 'uGradeEnabled');
```

Add a helper method right after `writeParam` (before `_snapshotState`):

```js
    // Temperature → RGB white-point gains. Positive warms (R up, B
    // down); the 3%/5% asymmetry keeps perceived brightness roughly
    // flat across the slider.
    _gradeGains(t) {
      return [1.0 + 0.03 * t, 1.0, 1.0 - 0.05 * t];
    }
```

In `_uploadStaticUniforms`, after the `scanlineCycles` upload, add:

```js
      const gains = this._gradeGains(this.opts.gradeTemperature ?? 0);
      gl.uniform3f(this._uComposite.gradeGains, gains[0], gains[1], gains[2]);
      gl.uniform1f(this._uComposite.gradeSaturation, this.opts.gradeSaturation ?? 1);
```

- [ ] **Step 4: Warmup color settle in `_renderGpu`**

Replace the warmup block (as it stands after Task 1):

```js
      // Warmup: one-shot brightness ramp, 0 → 1 over the first ~1.2 s
      // after start. The only time-driven modulator in the model.
      const warmupDur = 1200; // ms
      const tWarm = timeMs - (this._warmupStartMs || 0);
      let warmupFactor = 1.0;
      if (this.effects.warmup && tWarm < warmupDur) {
        const k = Math.max(0, Math.min(1, tWarm / warmupDur));
        warmupFactor = k * k * (3.0 - 2.0 * k); // smoothstep
      }

      this._brightness = warmupFactor;
```
with:
```js
      // Warmup: brightness ramp + color settle over the first ~1.2 s
      // after start — the tube starts dim, warm-shifted, and under-
      // saturated, then settles into the tuned grade (or neutral when
      // colorGrade is off). The only time-driven modulator in the model.
      const warmupDur = 1200; // ms
      const tWarm = timeMs - (this._warmupStartMs || 0);
      let warmupFactor = 1.0;
      let warmupColorActive = false;
      if (this.effects.warmup && tWarm < warmupDur) {
        warmupColorActive = true;
        const k = Math.max(0, Math.min(1, tWarm / warmupDur));
        warmupFactor = k * k * (3.0 - 2.0 * k); // smoothstep
      }

      this._brightness = warmupFactor;
      this._warmupColorActive = warmupColorActive;
```

In the composite per-frame section, after the `brightness` upload, add:

```js
      gl.uniform1f(this._uComposite.gradeEnabled,
        (this.effects.colorGrade || this._warmupColorActive) ? 1 : 0);
      if (this._warmupColorActive) {
        // Ramp-time grade modulation: extra warmth and undersaturation
        // that decay to the tuned base as warmupFactor → 1. Uploaded
        // only during the ramp, plus one restore frame at its end.
        const baseT = this.effects.colorGrade ? (this.opts.gradeTemperature ?? 0) : 0;
        const baseS = this.effects.colorGrade ? (this.opts.gradeSaturation ?? 1) : 1;
        const g = this._gradeGains(baseT + 0.5 * (1 - this._brightness));
        gl.uniform3f(this._uComposite.gradeGains, g[0], g[1], g[2]);
        gl.uniform1f(this._uComposite.gradeSaturation, baseS * (0.85 + 0.15 * this._brightness));
        this._gradeNeedsRestore = true;
      } else if (this._gradeNeedsRestore) {
        const g = this._gradeGains(this.opts.gradeTemperature ?? 0);
        gl.uniform3f(this._uComposite.gradeGains, g[0], g[1], g[2]);
        gl.uniform1f(this._uComposite.gradeSaturation, this.opts.gradeSaturation ?? 1);
        this._gradeNeedsRestore = false;
      }
```

- [ ] **Step 5: Verify and commit**

Run: `node --check docs/trinitron.js`

Browser (`tv.html?ch=4&renderer=trinitron`): bench shows a "color grade" row with temperature/saturation sliders; toggling it on visibly warms the test card; with warmup re-triggered (switch channels in reduced-motion off) the first second looks warmer/softer and settles. No shader errors in console.

```bash
git add docs/trinitron.js
git commit -m "Add phosphor color grade + warmup color settle to Trinitron"
```

---

### Task 14: Color grade + warmup settle in shadow-mask.js

**Files:**
- Modify: `docs/shadow-mask.js`

- [ ] **Step 1: Apply Task 13 to shadow-mask.js**

Identical edits, with these anchor differences: the `_uComposite` additions go next to its `scanlineDepth` line; the `effects` insertion point is after `selectiveBloom: false,` (shadow-mask has no `gapMask` key) — use:

```js
        // Color grade — off by default; the TV preset opts in.
        colorGrade: false,
```

The `opts` insertion point is after `bloomStrength: 1.0,`; `PANEL_OPT_KEYS` gains the same two keys after `'bleedRadius',`; the schema `composite` group gains the same `colorGrade` item after its `scanlines` item; `_gradeGains` goes after `writeParam`; the warmup block replacement and composite per-frame additions are identical (shadow-mask's post-Task-2 warmup block has the same shape).

- [ ] **Step 2: Verify and commit**

Run: `node --check docs/shadow-mask.js`
Browser: `tv.html?ch=4&renderer=shadow-mask` — same grade behavior.

```bash
git add docs/shadow-mask.js
git commit -m "Add phosphor color grade + warmup color settle to ShadowMask"
```

---

### Task 15: Tube-corner rounding in both renderers

**Files:**
- Modify: `docs/trinitron.js`
- Modify: `docs/shadow-mask.js`

- [ ] **Step 1: Composite shader (identical in both files)**

In `COMPOSITE_FS`, after the grade uniforms added in Tasks 13/14, add:

```glsl
uniform float uCornerRadius;        // fraction of the canvas's short side
uniform float uCornersEnabled;
```

Replace the final assignment block:

```glsl
  // opaqueBackground=true → canvas is always fully opaque (e.g.,
  // a CRT face filling its card). false → alpha follows the
  // silhouette+bloom mask (e.g., a logo on transparent page bg).
  float finalAlpha = mix(alpha, 1.0, uOpaqueBackground);
  oColor = vec4(color, finalAlpha);
```
with:
```glsl
  // opaqueBackground=true → canvas is always fully opaque (e.g.,
  // a CRT face filling its card). false → alpha follows the
  // silhouette+bloom mask (e.g., a logo on transparent page bg).
  float finalAlpha = mix(alpha, 1.0, uOpaqueBackground);

  // Tube corners: rounded-rect mask on the glass UV, so the raster
  // itself — and the bloom/gloss/vignette riding on it — has CRT
  // corners. ~1-px smoothstep edge; outside fades to transparent like
  // the curvature out-of-bounds region.
  if (uCornersEnabled > 0.5 && uCornerRadius > 0.0) {
    vec2 pPx = (sampleUv - 0.5) * uCanvasSize;
    float r = uCornerRadius * min(uCanvasSize.x, uCanvasSize.y);
    vec2 halfSize = 0.5 * uCanvasSize - vec2(r);
    float d = length(max(abs(pPx) - halfSize, vec2(0.0))) - r;
    float cornerMask = 1.0 - smoothstep(-1.0, 0.5, d);
    color *= cornerMask;
    finalAlpha *= cornerMask;
  }
  oColor = vec4(color, finalAlpha);
```

- [ ] **Step 2: Options, effect key, plumbing, schema (both files)**

`opts` (after the grade options): 

```js
        // Tube-corner radius as a fraction of the canvas's short side.
        // Engine-owned raster silhouette — page CSS keeps shaping the
        // bezel, but the picture's own corners live here so bloom/
        // gloss/vignette respect the true tube shape.
        cornerRadius: 0.06,
```

`effects` (in the glass cluster, after `vignette: false,`):

```js
        // Tube corners — off by default; the TV preset opts in.
        tubeCorners: false,
```

`_uComposite` additions:

```js
      this._uComposite.cornerRadius     = gl.getUniformLocation(this._progComposite, 'uCornerRadius');
      this._uComposite.cornersEnabled   = gl.getUniformLocation(this._progComposite, 'uCornersEnabled');
```

`_uploadStaticUniforms` (after the grade uploads):

```js
      gl.uniform1f(this._uComposite.cornerRadius, this.opts.cornerRadius ?? 0);
```

`_renderGpu` composite per-frame toggles (next to `gapMaskEnabled` in trinitron, next to `vignetteEnabled` in shadow-mask):

```js
      gl.uniform1f(this._uComposite.cornersEnabled,   this.effects.tubeCorners    ? 1 : 0);
```

`PANEL_OPT_KEYS`: add `'cornerRadius',` after the grade keys.

Schema `glass` group, after the `vignette` item (both files):

```js
        { key: 'tubeCorners', label: 'tube corners', scope: 'universal',
          desc: 'Rounded-rect mask on the raster itself — the picture gets CRT corners; bloom and glass effects respect them.',
          params: [{ opt: 'cornerRadius', min: 0, max: 0.2, step: 0.005, sub: 'radius (frac)' }] },
```

- [ ] **Step 3: Verify and commit**

Run: `node --check docs/trinitron.js && node --check docs/shadow-mask.js`

Browser: on both renderers, enable "tube corners" on the bench → all four raster corners round off smoothly (screenshot); slider 0 → square, 0.2 → very round. With curvature on, corners follow the warped face.

```bash
git add docs/trinitron.js docs/shadow-mask.js
git commit -m "Add engine-owned tube-corner rounding to both renderers"
```

---

### Task 16: CH 7 DITHER (the Sonic waterfall test) + six-position dial

**Files:**
- Modify: `docs/tv.html`

- [ ] **Step 1: Add the channel painter**

Insert after the `drawSnow` function (before the `CHANNELS` array):

```js
  // CH 7 — DITHER ("the Sonic waterfall test", spec §8). Transparency
  // and gradients faked the way 16-bit hardware did: alternating 1-px
  // vertical columns, checker dithers, stair-steps, single-pixel sprite
  // detail. Pass criterion: hard stripes on bypass; translucent shimmer
  // through either renderer. Static layers prerender once into function-
  // static canvases — per-frame work is ~a dozen drawImages plus the
  // foam checker.
  function drawDither(ctx, t, w, h) {
    let S = drawDither._S;
    if (!S) {
      S = drawDither._S = {};
      const make = (mw, mh, paint) => {
        const c = document.createElement('canvas');
        c.width = mw; c.height = mh;
        paint(c.getContext('2d'));
        return c;
      };
      const horizon = Math.round(h * 0.42);
      S.horizon = horizon;
      // Hill tiles: one sine period wide, filled to the bottom, with a
      // 4-px checker AA band along the crest (the Genesis edge-dither).
      const hillTile = (col, amp, base, period) => make(period, h, (c) => {
        c.fillStyle = col;
        for (let x = 0; x < period; x++) {
          const y = Math.round(base - amp * (0.6 + 0.4 * Math.sin(x * 2 * Math.PI / period)));
          c.fillRect(x, y, 1, h - y);
          for (let dy = -4; dy < 0; dy++) {
            if (((x + dy) & 1) === 0) c.fillRect(x, y + dy, 1, 1);
          }
        }
      });
      S.hillFar  = hillTile('#1d5a34', 14, horizon + 8,  90);
      S.hillNear = hillTile('#2e8048', 20, horizon + 26, 130);
      // Waterfall tile: one 26-px scroll period. Even columns water,
      // odd columns transparent — the scene shows through 50/50, the
      // Mega Drive transparency trick this channel exists to test.
      S.fallW = Math.round(w * 0.18);
      S.fall = make(S.fallW, 26, (c) => {
        for (let x = 0; x < S.fallW; x += 2) {
          for (let y = 0; y < 26; y++) {
            c.fillStyle = y < 7 ? '#bfe4ff' : y < 16 ? '#5aa0e8' : '#3a78cc';
            c.fillRect(x, y, 1, 1);
          }
        }
      });
      // Static panel: checker dither ramps (25/50/75% mixes), a 2×2
      // Bayer ordered-dither gradient bar, stair-step diagonals, label.
      S.panel = make(w, h, (c) => {
        const cA = '#e83048', cB = '#f8e858';
        [[1, 4], [1, 2], [3, 4]].forEach(([n, d], i) => {
          const y0 = 14 + i * 18;
          c.fillStyle = cB; c.fillRect(w - 96, y0, 84, 14);
          c.fillStyle = cA;
          for (let y = 0; y < 14; y++)
            for (let x = 0; x < 84; x++)
              if (((x + y) % d) < n) c.fillRect(w - 96 + x, y0 + y, 1, 1);
        });
        const bayer = [0, 2, 3, 1];               // 2×2 ordered dither
        for (let x = 0; x < 84; x++) {
          for (let y = 0; y < 10; y++) {
            const lvl = (x / 84) * 5 - 1;          // -1..4 across the bar
            const th = bayer[(x & 1) + 2 * (y & 1)];
            c.fillStyle = lvl > th ? '#35e0ff' : '#06101c';
            c.fillRect(w - 96 + x, 72 + y, 1, 1);
          }
        }
        c.fillStyle = '#ffffff';                   // stair-step diagonals
        for (const [run, i] of [[1, 0], [2, 1], [3, 2]]) {
          const x0 = w - 96, y0 = 102 + i * 18;
          for (let k = 0; k < 84; k++) c.fillRect(x0 + k, y0 + 13 - (((k / run) | 0) % 14), 1, 1);
        }
        c.font = '8px monospace'; c.fillStyle = '#cfe0ff';
        c.fillText('DITHER LAB // CH-7', 8, 10);
      });
      // 8×8 two-frame sprite with single-pixel eye detail.
      const rows = [
        '..3333..',
        '.355553.',
        '35777753',
        '35717753',
        '35777753',
        '.355553.',
        '.3....3.',
        '3......3',
      ];
      const cols = { 1: '#0a0a14', 3: '#143c8c', 5: '#2e78dc', 7: '#8cc8ff' };
      S.sprite = [0, 1].map((f) => make(8, 8, (c) => {
        rows.forEach((row, y) => {
          for (let x = 0; x < 8; x++) {
            const ch = row[(f === 1 && y >= 6) ? 7 - x : x];   // frame 2 mirrors the legs
            if (ch !== '.') { c.fillStyle = cols[ch]; c.fillRect(x, y, 1, 1); }
          }
        });
      }));
    }
    const fract = x => x - Math.floor(x);
    const horizon = S.horizon;
    const g = ctx.createLinearGradient(0, 0, 0, horizon);          // sky
    g.addColorStop(0, '#1c2c74'); g.addColorStop(1, '#3e68b8');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, horizon);
    ctx.fillStyle = '#3e68b8'; ctx.fillRect(0, horizon, w, h - horizon);
    for (const [tile, speed] of [[S.hillFar, 0.010], [S.hillNear, 0.022]]) {
      const off = Math.round(t * speed) % tile.width;              // parallax hills
      for (let x = -off; x < w; x += tile.width) ctx.drawImage(tile, x, 0);
    }
    ctx.fillStyle = '#7a5a30'; ctx.fillRect(0, h - 32, w, 32);     // ground
    const wx = Math.round(w * 0.16), wy0 = horizon - 14, wy1 = h - 26;
    const scroll = Math.round(t * 0.12) % 26;                      // the waterfall
    ctx.save();
    ctx.beginPath(); ctx.rect(wx, wy0, S.fallW, wy1 - wy0); ctx.clip();
    for (let y = wy0 - 26 + scroll; y < wy1; y += 26) ctx.drawImage(S.fall, wx, y);
    ctx.restore();
    ctx.fillStyle = '#e8f4ff';                                     // animated foam checker
    const ph = (t * 0.02) | 0;
    for (let x = wx - 2; x < wx + S.fallW + 2; x++)
      for (let y = wy1; y < wy1 + 5; y++)
        if (((x + y + ph) & 1) === 0) ctx.fillRect(x, y, 1, 1);
    ctx.drawImage(S.panel, 0, 0);                                  // static patterns
    for (let i = 0; i < 3; i++) {                                  // marching sprites, 1:1 px
      const sx = Math.round(fract(t * 0.00006 + i / 3) * (w + 16)) - 8;
      ctx.drawImage(S.sprite[(((t / 240) | 0) + i) % 2], sx, h - 41);
    }
  }
```

- [ ] **Step 2: Register the channel**

In the `CHANNELS` array (post-Task-11 form), add after the SNOW entry:

```js
    { num: 7, name: 'DITHER',     draw: drawDither,     static: false },
```

- [ ] **Step 3: Re-space the CHANNEL dial to six positions**

Replace the dial's tick lines and numbers (the block between `<!-- ticks at -120,-60,0,60,120 deg (r 46->53 about 101,90) -->` and `<text class="dial-caption"`):

```html
              <!-- ticks at -120,-72,-24,24,72,120 deg (r 46->53 about 101,90) -->
              <line x1="61.2"  y1="113"   x2="55.1"  y2="116.5"/>
              <line x1="57.3"  y1="75.8"  x2="50.6"  y2="73.6"/>
              <line x1="82.3"  y1="48"    x2="79.4"  y2="41.6"/>
              <line x1="119.7" y1="48"    x2="122.6" y2="41.6"/>
              <line x1="144.7" y1="75.8"  x2="151.4" y2="73.6"/>
              <line x1="140.8" y1="113"   x2="146.9" y2="116.5"/>
              <!-- VHF numbers, r=67 -->
              <text x="43"    y="123.5" font-size="13" text-anchor="middle" dy=".35em">2</text>
              <text x="37.3"  y="69.3"  font-size="13" text-anchor="middle" dy=".35em">3</text>
              <text x="73.8"  y="28.8"  font-size="13" text-anchor="middle" dy=".35em">4</text>
              <text x="128.2" y="28.8"  font-size="13" text-anchor="middle" dy=".35em">5</text>
              <text x="164.7" y="69.3"  font-size="13" text-anchor="middle" dy=".35em">6</text>
              <text x="159"   y="123.5" font-size="13" text-anchor="middle" dy=".35em">7</text>
```

- [ ] **Step 4: Update the knob angle math**

In `setChannel`, replace:

```js
    // CHANNEL: dial paints positions 2–6 over -120°..+120°; point at the
    // painted position for this channel's number.
    knobChannel.style.setProperty('--angle', (-120 + (CHANNELS[channelIdx].num - 2) * 60) + 'deg');
```
with:
```js
    // CHANNEL: dial paints positions 2–7 over -120°..+120° (48° steps);
    // point at the painted position for this channel's number.
    knobChannel.style.setProperty('--angle', (-120 + (CHANNELS[channelIdx].num - 2) * 48) + 'deg');
```

- [ ] **Step 5: Verify the pass criterion and commit**

Browser:
- `tv.html?ch=7&renderer=bypass` → screenshot: waterfall reads as **hard vertical stripes**; checker swatches read as patterns.
- `tv.html?ch=7&renderer=trinitron` → screenshot: waterfall reads as **translucent shimmer** over the hills; swatches read as blended mid-colors; diagonals smooth. (If it fails, that's Task 17's tuning job — record the screenshot either way.)
- Knob clicks cycle through six positions; pointer lands on each painted number; `?ch=7` round-trips through the URL.

```bash
git add docs/tv.html
git commit -m "Add CH 7 DITHER (Sonic waterfall test) and six-position dial"
```

---

### Task 17: Presets on both classes; tv.html boots from them

**Files:**
- Modify: `docs/trinitron.js`
- Modify: `docs/shadow-mask.js`
- Modify: `docs/tv.html`

- [ ] **Step 1: Trinitron preset**

In `docs/trinitron.js`, after the `Trinitron.effectSchema = [ … ];` statement and before `window.Trinitron = Trinitron;`, add:

```js
  // Named option presets — the export surface for consumers beyond this
  // repo. `tv` is the tuned "endearing TV" look from the 2026-06-11
  // spec, retuned on the tv.html bench; tv.html boots from it. Frozen
  // shallowly: clone `convergence` and `effects` before passing to the
  // constructor if you intend to mutate them.
  Trinitron.presets = {
    tv: Object.freeze({
      cellSize: 3,
      stripeUpscale: 2,
      opaqueBackground: true,
      phosphorCoupling: 0.35,
      persistenceHalfLifeMs: 58,
      convergence: { r: [-0.25, 0], g: [0, 0], b: [0.25, 0] },
      beamSpreadPx: 0.7,
      beamSpreadVerticalPx: 1.4,
      damperStrength: 0.90,
      bleedRadius: 18,
      bloomStrength: 1.2,
      bloomThreshold: 0.6,
      scanlineDepth: 0.18,
      scanlinePeriod: 2,
      curvature: 0.06,
      cornerRadius: 0.06,
      gradeTemperature: 0.3,
      gradeSaturation: 1.08,
      gapMaskAlpha: 0.15,
      gapMaskPeriod: 2,
      effects: Object.freeze({
        convergence: true, selectiveBloom: true, scanlines: true,
        curvature: true, vignette: true, warmup: true,
        gapMask: true, colorGrade: true, tubeCorners: true,
      }),
    }),
  };
```

- [ ] **Step 2: ShadowMask preset**

In `docs/shadow-mask.js`, same position relative to its schema/export:

```js
  // Named option presets — see Trinitron.presets for the convention.
  ShadowMask.presets = {
    tv: Object.freeze({
      cellSize: [3, 3],
      dotRadius: 0.7,
      stripeUpscale: 2,
      opaqueBackground: true,
      phosphorCoupling: 0.35,
      persistenceHalfLifeMs: 58,
      convergence: { r: [-0.25, -0.25], g: [0, 0], b: [0.25, 0.25] },
      beamSpreadPx: 1.5,
      beamSpreadVerticalPx: 1.5,
      bleedRadius: 24,
      bloomStrength: 1.2,
      bloomThreshold: 0.3,
      scanlineDepth: 0.18,
      scanlinePeriod: 2,
      curvature: 0.06,
      cornerRadius: 0.06,
      gradeTemperature: 0.3,
      gradeSaturation: 1.08,
      effects: Object.freeze({
        convergence: true, selectiveBloom: true, scanlines: true,
        curvature: true, vignette: true, warmup: true,
        colorGrade: true, tubeCorners: true,
      }),
    }),
  };
```

- [ ] **Step 3: tv.html boots from the presets**

Replace the whole `TV_EFFECTS` + `makeRenderer` block:

```js
  // Boot presets — hero-derived + TV glass. Starting points; the bench
  // below exists to retune them.
  const TV_EFFECTS = { convergence: true, selectiveBloom: true, scanlines: true,
                       curvature: true, vignette: true, warmup: true };
  function makeRenderer(kind) {
    const common = {
      signal: paintChannel,
      viewSize: [SIGNAL_W, SIGNAL_H],
      canvasSize: [SIGNAL_W * 2, SIGNAL_H * 2],
      stripeUpscale: 2,
      opaqueBackground: true,
      phosphorCoupling: 0.35,
      persistenceHalfLifeMs: 58,   // ≈ the old 0.82/frame at 60 Hz
      bloomStrength: 1.2,
      scanlineDepth: 0.18,
      scanlinePeriod: 2,
      curvature: 0.06,
      debugOverlay: false,
    };
    if (kind === 'trinitron') {
      return new window.Trinitron(glCanvas, Object.assign(common, {
        cellSize: 3,
        convergence: { r: [-0.25, 0], g: [0, 0], b: [0.25, 0] },
        beamSpreadPx: 0.7, beamSpreadVerticalPx: 1.4,
        damperStrength: 0.90,
        bleedRadius: 18,
        gapMaskAlpha: 0.15, gapMaskPeriod: 2,
        effects: Object.assign({ gapMask: true }, TV_EFFECTS),
      }));
    }
    return new window.ShadowMask(glCanvas, Object.assign(common, {
      cellSize: [3, 3], dotRadius: 0.7,
      convergence: { r: [-0.25, -0.25], g: [0, 0], b: [0.25, 0.25] },
      beamSpreadPx: 1.5, beamSpreadVerticalPx: 1.5,
      bleedRadius: 24, bloomThreshold: 0.3,
      effects: Object.assign({}, TV_EFFECTS),
    }));
  }
```
with:
```js
  // Boot from the classes' own tuned `tv` presets — the bench exists to
  // retune them, and "copy state diff" output gets transferred back
  // into the preset objects in the renderer files. The frozen preset's
  // convergence/effects are cloned so bench mutations never write into
  // the shared template.
  function makeRenderer(kind) {
    const Cls = kind === 'trinitron' ? window.Trinitron : window.ShadowMask;
    const P = Cls.presets.tv;
    return new Cls(glCanvas, Object.assign({}, P, {
      signal: paintChannel,
      viewSize: [SIGNAL_W, SIGNAL_H],
      canvasSize: [SIGNAL_W * 2, SIGNAL_H * 2],
      debugOverlay: false,
      convergence: {
        r: [...P.convergence.r], g: [...P.convergence.g], b: [...P.convergence.b],
      },
      effects: Object.assign({}, P.effects),
    }));
  }
```

(Note: this turns `colorGrade`, `tubeCorners`, and the trinitron `bloomThreshold: 0.6` on for the TV — that's the intended new boot look. Task 6's `persistenceHalfLifeMs: 58` line in `common` is superseded by this block.)

- [ ] **Step 4: Verify and commit**

Run: `node --check docs/trinitron.js && node --check docs/shadow-mask.js`

Browser: tv.html boots both renderers with rounded corners, warm grade, and all prior glass effects; "copy state diff" on an untouched boot reports "(no changes from construction)"; hero unaffected.

```bash
git add docs/trinitron.js docs/shadow-mask.js docs/tv.html
git commit -m "Add presets.tv to both renderers; boot tv.html from them"
```

---

### Task 18: Bench tuning session (human-in-the-loop)

**Files:**
- Modify: `docs/trinitron.js` (preset values)
- Modify: `docs/shadow-mask.js` (preset values)

This task is interactive — Chris drives the look; the executor assists and transfers numbers.

- [ ] **Step 1: Set up** — serve `docs/`, open `tv.html` in Chris's browser (not just Playwright). Capture baseline Playwright screenshots of every channel (2–7) × both renderers for before/after comparison.

- [ ] **Step 2: Tune** — Chris adjusts bench sliders per channel, focusing on: grade temperature/saturation (test card + motion reel), beam spread + coupling against the **CH 7 pass criterion** (waterfall must shimmer, not stripe), persistence half-life feel on motion, corner radius, scanline depth. Both renderers.

- [ ] **Step 3: Transfer** — for each renderer, click "copy state diff" and translate every reported `opts.X = Y` / `effects.X = Y` into the corresponding `presets.tv` value in the renderer file. Reload tv.html and confirm "copy state diff" reports no changes from construction.

- [ ] **Step 4: Hero check** — with Chris, decide whether the hero should adopt `colorGrade`/`tubeCorners` (spec default: hero stays bespoke and unchanged; only adopt if Chris asks). Verify hero `/` and `/?crt=shadow-mask` in dark mode look unchanged (or as newly approved).

- [ ] **Step 5: Commit**

```bash
git add docs/trinitron.js docs/shadow-mask.js
git commit -m "Capture bench-tuned values into presets.tv"
```

---

### Task 19: Final verification matrix + CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Run the full matrix (Playwright MCP + one manual pass)**

| Check | Where | Expected |
|---|---|---|
| Static channels park | tv.html ch 2/3/4, both renderers | `__crt._mode === 'idle'`, bench `fps: idle`, two screenshots 1 s apart identical |
| Animated channels run | ch 5/6/7, both renderers | mode `running`, fps ≈ display rate |
| Snow interstitial | every knob click | ~150 ms snow, then new channel |
| CH 7 pass criterion | ch 7: bypass vs both renderers | stripes on bypass; shimmer through renderers |
| Idle wake | bench slider + checkbox while idle | single repaint, re-parks |
| Offscreen halt | scroll tv.html so the set leaves the viewport | mode leaves `running` (evaluate `__crt._mode`) |
| Reduced motion | emulate via Playwright (`browser_evaluate` can't set media; use `--force-prefers-reduced-motion` note or DevTools manual check by Chris) | exactly one static post-warmup frame per channel change |
| Context loss | lose/restore script from Task 12 | recovers, keeps running |
| Hero | `/` and `/?crt=shadow-mask`, light + dark + OS-pref path | identical to pre-project (modulo Task 18 decisions); theme toggle starts/stops |
| Fallback latch | tv.html with WebGL2 blocked (Chrome `--disable-webgl2` or `about:config`) — manual, best-effort | bypass + `BYPASS (NO WEBGL2)` readout, knob disabled |
| Console | every page above | zero errors |

- [ ] **Step 2: Update CLAUDE.md**

In the CRT renderers section: effect inventory (Trinitron 15: replace the old 16-list — minus `convergenceDrift`/`perRowShimmer`/`breathing`, plus `colorGrade`/`tubeCorners`; ShadowMask shares minus `damperWires`/`gapMask`); persistence is `persistenceHalfLifeMs` (frame-rate-independent); the scheduler contract (dirty-signal return, idle/settle, IntersectionObserver, `requestRender()`); RGBA8 (no float-extension requirement; WebGL2-only gate remains); context-loss recovery; `presets.tv` as the boot/export surface; tv.html: six channels (CH 7 DITHER + pass criterion), dial 48° steps. Update the spec/plan history pointer list with `2026-06-11-crt-warmth-and-engine-hardening-*`.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "Document warmth + engine hardening round in CLAUDE.md"
```

Then surface the full diff summary to Chris and (with his go-ahead, per standing authorization) push.
