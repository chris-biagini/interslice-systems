// CRT engine v2 — the chassis.
//
// The tube is evaluated at the display's real pixels, in linear light:
// a brightness-dependent electron beam reconstructs the signal, an
// aperture grille independent of the signal grid filters it, and glow,
// glass and color finish it. Design: specs/2026-10-17-crt-engine-v2-design.md.
//
// This file owns everything backend-independent — options, the effect
// schema, presets, sizing, the scheduler, signal sources and the bench
// API. GPU work lives in a backend (crt-webgl2.js; crt-webgpu.js adds
// HDR), which implements the small interface documented on
// CRT.backends below. Both backends receive identical uniform values
// from _uniforms(), so they can only differ in how they draw them.
(function () {
  'use strict';

  // --- Pure helpers (unit-tested; mirrored in the shaders) -------------
  const math = {
    // Grille pitch rule (Chris, 2026-10-17): the full triad count on big
    // displays, fewer/chunkier triads where a triad would drop below
    // minPxPerTriad device pixels — so the stripes stay visible.
    triadCount(outW, target, minPxPerTriad) {
      return Math.max(1, Math.min(Math.round(target), Math.floor(outW / Math.max(1e-6, minPxPerTriad))));
    },
    // Fraction of light retained after dtMs, for a half-life in ms.
    decay(dtMs, halfLifeMs) {
      if (!(halfLifeMs > 0)) return 0;
      return Math.pow(0.5, dtMs / halfLifeMs);
    },
    // sRGB transfer function, sign-mirrored so extended-range values work.
    srgbDecode(v) {
      const a = Math.abs(v);
      const l = a <= 0.04045 ? a / 12.92 : Math.pow((a + 0.055) / 1.055, 2.4);
      return Math.sign(v) * l;
    },
    srgbEncode(v) {
      const a = Math.abs(v);
      const e = a <= 0.0031308 ? 12.92 * a : 1.055 * Math.pow(a, 1 / 2.4) - 0.055;
      return Math.sign(v) * e;
    },
    // Box-filter integral of a periodic stripe: period 1, lit for `duty`
    // starting at `phase`. Returns the lit fraction of [t0, t1] — exact
    // pixel-footprint anti-aliasing, so fractional pitches can't moiré.
    stripeCoverage(t0, t1, phase, duty) {
      const I = (t) => { const u = t - phase; const f = Math.floor(u); return f * duty + Math.min(u - f, duty); };
      return (I(t1) - I(t0)) / Math.max(1e-9, t1 - t0);
    },
    // The strongest mask mix s_eff ≤ s whose stripe peak L·(1+s(1/a−1))
    // stays ≤ headroom H. SDR (H=1): bright areas bloom across the
    // stripes instead of clipping; HDR (H>1): stripes stay dark.
    maskStrengthLimit(L, H, a, s) {
      const lim = (H / Math.max(L, 1e-4) - 1) / (1 / a - 1);
      return Math.max(0, Math.min(s, lim));
    },
    // Fit transforms map a source of srcW×srcH into the dstW×dstH signal.
    // Source UV = (signalUV − offset) / scale; outside [0,1] is black.
    fitContain(srcW, srcH, dstW, dstH) {
      const ratio = (srcW / srcH) / (dstW / dstH);
      return ratio >= 1
        ? { scale: [1, 1 / ratio], offset: [0, (1 - 1 / ratio) / 2] }
        : { scale: [ratio, 1], offset: [(1 - ratio) / 2, 0] };
    },
    fitCover(srcW, srcH, dstW, dstH) {
      const ratio = (srcW / srcH) / (dstW / dstH);
      return ratio >= 1
        ? { scale: [ratio, 1], offset: [(1 - ratio) / 2, 0] }
        : { scale: [1, 1 / ratio], offset: [0, (1 - 1 / ratio) / 2] };
    },
  };
  const FIT_IDENTITY = { scale: [1, 1], offset: [0, 0] };

  // --- Defaults ---------------------------------------------------------
  // The class defaults are a restrained, healthy tube; presets (below)
  // carry bench-tuned looks. Units: beam σ in scanlines, focus and
  // convergence in signal px, damper width in output px.
  const DEFAULT_OPTS = {
    signalSize: [640, 480],
    signalColorSpace: 'srgb',          // 'srgb' | 'display-p3'
    pixelSize: null,                   // [w, h] device px; null = measure the canvas
    backend: 'webgl2',
    outputColorSpace: 'auto',          // 'auto' | 'srgb' | 'display-p3'
    signal: null,                      // (ctx, timeMs, needsRepaint) => false | other
    source: null,                      // e.g. new CRT.VideoSource(video)
    respectReducedMotion: true,
    adaptiveQuality: true,
    // phosphor
    persistenceHalfLifeMs: 58,
    // beam
    beamMin: 0.22, beamMax: 0.48, beamShape: 0.6, focusPx: 0.6,
    convergence: { r: [-0.25, 0], g: [0, 0], b: [0.25, 0] },
    // grille
    triadTarget: 560, minPxPerTriad: 3, stripeFill: 0.8, maskStrength: 1.0, maskSoftness: 0.5,
    headroom: 1.0, hdrHeadroom: 3.0,
    damperWires: [0.32, 0.68], damperStrength: 0.12, damperWidthPx: 1,
    // glow
    bloomStrength: 0.25, bloomRadius: 1.0, halationStrength: 0.06, halationRadius: 1.0,
    // color + tone
    gradeTemperature: 0.3, gradeSaturation: 1.08, shoulderStart: 0.8,
    // glass
    vignette: 0.12, cornerRadius: 0.035, curvature: 0, gloss: 0.03,
    // test hooks
    _exposure: 1,
    _backendFactory: null,
  };
  const DEFAULT_EFFECTS = {
    persistence: true,
    beam: true, convergence: true,
    grille: true, damperWires: true,
    bloom: true, halation: true,
    colorGrade: true, tone: true,
    vignette: true, tubeCorners: true, curvature: false, gloss: true,
    warmup: false,
  };
  const WARMUP_MS = 1200;

  // --- Effect schema — drives the tv.html bench ------------------------
  // Same shape as v1's (groups → items → params). scope: 'universal' (any
  // color CRT) or 'trinitron' (aperture-grille specific).
  const effectSchema = [
    { title: 'beam', items: [
      { key: 'beam', label: 'beam profile', scope: 'universal',
        desc: 'Gaussian scanlines that swell when bright and thin when dark. Off = flat rows.',
        params: [
          { opt: 'beamMin',   sub: 'σ dark',  min: 0.08, max: 0.6, step: 0.01 },
          { opt: 'beamMax',   sub: 'σ bright', min: 0.2, max: 0.9, step: 0.01 },
          { opt: 'beamShape', sub: 'shape',   min: 0.2, max: 2.0, step: 0.05 },
          { opt: 'focusPx',   sub: 'h focus', min: 0,   max: 3,   step: 0.05 },
        ] },
      { key: 'convergence', label: 'convergence', scope: 'trinitron',
        desc: 'Inline guns land R/B slightly left/right of G — a hairline fringe on vertical edges.',
        params: [{ opt: '__convergenceSpread', sub: 'spread', min: 0, max: 1.5, step: 0.05 }] },
    ] },
    { title: 'grille', items: [
      { key: 'grille', label: 'aperture grille', scope: 'trinitron',
        desc: 'Continuous R/G/B phosphor stripes, independent of the signal grid, anti-aliased per pixel.',
        params: [
          { opt: 'triadTarget',   sub: 'triads',    min: 100, max: 1200, step: 10 },
          { opt: 'minPxPerTriad', sub: 'min px',    min: 2,   max: 12,   step: 0.5 },
          { opt: 'stripeFill',    sub: 'fill',      min: 0.4, max: 1,    step: 0.01 },
          { opt: 'maskStrength',  sub: 'strength',  min: 0,   max: 1,    step: 0.01 },
          { opt: 'maskSoftness',  sub: 'softness',  min: 0,   max: 1,    step: 0.05 },
        ] },
      { key: 'damperWires', label: 'damper wires', scope: 'trinitron',
        desc: 'The two horizontal stabilizer wires — faint shadows, most visible on bright fields.',
        params: [{ opt: 'damperStrength', sub: 'darkness', min: 0, max: 0.5, step: 0.01 }] },
    ] },
    { title: 'phosphor', items: [
      { key: 'persistence', label: 'afterglow', scope: 'universal',
        desc: 'Instant attack, exponential release. Half-life in ms — frame-rate independent.',
        params: [{ opt: 'persistenceHalfLifeMs', sub: 'half-life', min: 0, max: 500, step: 5 }] },
    ] },
    { title: 'glow', items: [
      { key: 'bloom', label: 'bloom', scope: 'universal',
        desc: 'Near-field spread of bright phosphor light.',
        params: [
          { opt: 'bloomStrength', sub: 'strength', min: 0,    max: 1, step: 0.01 },
          { opt: 'bloomRadius',   sub: 'radius',   min: 0.25, max: 3, step: 0.05 },
        ] },
      { key: 'halation', label: 'halation', scope: 'universal',
        desc: 'Wide, faint haze from light scattering inside the faceplate glass.',
        params: [
          { opt: 'halationStrength', sub: 'strength', min: 0,    max: 0.3, step: 0.005 },
          { opt: 'halationRadius',   sub: 'radius',   min: 0.25, max: 3,   step: 0.05 },
        ] },
    ] },
    { title: 'color', items: [
      { key: 'colorGrade', label: 'color grade', scope: 'universal',
        desc: 'The tube\'s color character, in linear light. Saturation past 1 reaches into P3 where the display has it.',
        params: [
          { opt: 'gradeTemperature', sub: 'temp', min: -1, max: 1, step: 0.05 },
          { opt: 'gradeSaturation',  sub: 'sat',  min: 0,  max: 2, step: 0.01 },
        ] },
      { key: 'tone', label: 'soft shoulder', scope: 'universal',
        desc: 'Highlights compress smoothly instead of clipping. Off = hard clip.',
        params: [{ opt: 'shoulderStart', sub: 'knee', min: 0.5, max: 1, step: 0.01 }] },
    ] },
    { title: 'glass', items: [
      { key: 'vignette',    label: 'vignette', scope: 'universal', desc: 'Gentle falloff toward the edges.',
        params: [{ opt: 'vignette', sub: 'amount', min: 0, max: 0.5, step: 0.01 }] },
      { key: 'tubeCorners', label: 'tube corners', scope: 'universal', desc: 'Rounded raster corners.',
        params: [{ opt: 'cornerRadius', sub: 'radius', min: 0, max: 0.2, step: 0.005 }] },
      { key: 'curvature',   label: 'curvature', scope: 'trinitron', desc: 'Cylindrical face: horizontals bow, verticals stay straight. Off by default — good taste.',
        params: [{ opt: 'curvature', sub: 'amount', min: 0, max: 0.3, step: 0.01 }] },
      { key: 'gloss',       label: 'gloss', scope: 'universal', desc: 'A faint reflection on the glass.',
        params: [{ opt: 'gloss', sub: 'amount', min: 0, max: 0.15, step: 0.005 }] },
    ] },
    { title: 'modulation', items: [
      { key: 'warmup', label: 'warmup', scope: 'universal',
        desc: 'Power-on: the tube starts dim, warm and undersaturated, then settles (~1.2 s).' },
    ] },
  ];
  const PANEL_OPT_KEYS = [];
  for (const g of effectSchema) for (const it of g.items) for (const p of (it.params || [])) {
    if (!p.opt.startsWith('__')) PANEL_OPT_KEYS.push(p.opt);
  }

  const cloneOpts = (o) => Object.assign({}, o, {
    convergence: o.convergence && { r: [...o.convergence.r], g: [...o.convergence.g], b: [...o.convergence.b] },
    damperWires: o.damperWires && [...o.damperWires],
    signalSize: o.signalSize && [...o.signalSize],
    pixelSize: o.pixelSize && [...o.pixelSize],
  });

  class CRT {
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.opts = cloneOpts(Object.assign({}, DEFAULT_OPTS, opts));
      this.effects = Object.assign({}, DEFAULT_EFFECTS, opts.effects || {});
      delete this.opts.effects;
      this._baseline = this._snapshotState();

      this._quality = 0;
      this._triads = 1;
      this._outSize = [1, 1];
      this._frameCount = 0;
      this._source = this.opts.source || null;
      this._signalStale = false;

      if (!this._source) {
        const [sw, sh] = this.opts.signalSize;
        this._signalCanvas = document.createElement('canvas');
        this._signalCanvas.width = sw;
        this._signalCanvas.height = sh;
        let sctx = null;
        try { sctx = this._signalCanvas.getContext('2d', { colorSpace: this.opts.signalColorSpace }); } catch (_) { /* old engine */ }
        this._signalCtx = sctx || this._signalCanvas.getContext('2d');
        this._signalCtx.imageSmoothingEnabled = true;
        this._signalCtx.imageSmoothingQuality = 'high';
      }

      this._backend = this._makeBackend();   // throws /unavailable/i on missing capability

      // Scheduler state. _wasStartedByUser is user intent (start() sets,
      // stop() clears); _mode is what the loop is doing right now:
      // 'stopped' | 'running' | 'idle' (parked: zero work until woken).
      this._wasStartedByUser = false;
      this._mode = 'stopped';
      this._visible = true;
      this._idleAt = Infinity;
      this._rafHandle = null;
      this._startTime = performance.now();
      this._lastRenderT = null;
      this._warmupStartMs = 0;

      this._setupSizing();
      this._setupReducedMotionListener();
      this._setupVisibilityObserver();
      this._onContextLost = (e) => {
        e.preventDefault();          // required, or 'restored' never fires
        this._haltLoop();
        this._backend = null;        // GPU objects died with the context
      };
      this._onContextRestored = () => {
        this._backend = this._makeBackend();
        this._applySize(true);
        this._signalStale = true;    // blank signal texture: ask for a repaint
        this._resumeLoop();
      };
      canvas.addEventListener('webglcontextlost', this._onContextLost);
      canvas.addEventListener('webglcontextrestored', this._onContextRestored);
      if (this._source && this._source.attach) this._source.attach(this);
    }

    _makeBackend() {
      const factory = this.opts._backendFactory ||
        (CRT.backends[this.opts.backend] && CRT.backends[this.opts.backend].create);
      if (!factory) throw new Error(`CRT backend '${this.opts.backend}' unavailable`);
      const b = factory(this.canvas, { opts: this.opts, effects: this.effects, chassis: this });
      b.setSignalSize(this.opts.signalSize[0], this.opts.signalSize[1]);
      return b;
    }

    // --- Sizing ---------------------------------------------------------
    // The backing store always matches the canvas's device-pixel box, so
    // the grille is drawn 1:1 on physical pixels at any DPR.
    _setupSizing() {
      this._applySize(true);
      if (this.opts.pixelSize || typeof ResizeObserver === 'undefined') return;
      this._ro = new ResizeObserver((entries) => {
        const e = entries[entries.length - 1];
        const dp = e.devicePixelContentBoxSize && e.devicePixelContentBoxSize[0];
        this._measured = dp
          ? [dp.inlineSize, dp.blockSize]
          : [Math.round(e.contentRect.width * devicePixelRatio), Math.round(e.contentRect.height * devicePixelRatio)];
        this._applySize(false);
      });
      try { this._ro.observe(this.canvas, { box: 'device-pixel-content-box' }); }
      catch (_) { this._ro.observe(this.canvas); }
    }

    _currentPixelSize() {
      if (this.opts.pixelSize) return this.opts.pixelSize.map((v) => Math.max(1, Math.round(v)));
      if (this._measured) return this._measured.map((v) => Math.max(1, v));
      const r = this.canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      return [Math.max(1, Math.round(r.width * dpr)), Math.max(1, Math.round(r.height * dpr))];
    }

    _applySize(force) {
      const [w, h] = this._currentPixelSize();
      if (!force && w === this._outSize[0] && h === this._outSize[1]) return;
      this._outSize = [w, h];
      this._updateTriads();
      if (this._backend) this._backend.resize(w, h);
      this.requestRender();
    }

    _updateTriads() {
      this._triads = math.triadCount(this._outSize[0], this.opts.triadTarget, this.opts.minPxPerTriad);
    }

    // Public: re-measure (pixelSize callers change opts.pixelSize first).
    resize() { this._applySize(false); }

    // --- Per-frame uniforms (shared by every backend) -----------------
    _gradeGains(t) { return [1.0 + 0.03 * t, 1.0, 1.0 - 0.05 * t]; }

    _uniforms(warmK) {
      const o = this.opts, e = this.effects;
      const [sw, sh] = o.signalSize;
      const [ow, oh] = this._outSize;
      const on = (k) => (e[k] ? 1 : 0);
      const conv = e.convergence ? o.convergence : { r: [0, 0], g: [0, 0], b: [0, 0] };
      // Warmup color settle: extra warmth and undersaturation decaying
      // into the tuned grade (or neutral when the grade is off).
      const warming = e.warmup && warmK < 1;
      const baseT = e.colorGrade ? o.gradeTemperature : 0;
      const baseS = e.colorGrade ? o.gradeSaturation : 1;
      const temp = warming ? baseT + 0.5 * (1 - warmK) : baseT;
      const sat = warming ? baseS * (0.85 + 0.15 * warmK) : baseS;
      const wires = (e.damperWires && o.damperWires) ? o.damperWires.slice(0, 2) : [];
      const outputP3 = this._backend && this._backend.outputColorSpace === 'display-p3' ? 1 : 0;
      return {
        uSignalSize: [sw, sh],
        uOutSize: [ow, oh],
        uExposure: o._exposure,
        uSignalP3: o.signalColorSpace === 'display-p3' ? 1 : 0,
        uBeamEnabled: on('beam'),
        uBeamMin: o.beamMin, uBeamMax: o.beamMax, uBeamShape: o.beamShape,
        uFocusPx: o.focusPx,
        // A 1-px feature must cover at least ~one triad, or it would light
        // a single colored stripe: the horizontal beam never gets narrower.
        uTriadFloorPx: e.grille ? 0.42 * sw / this._triads : 0,
        uConvergence: [conv.r[0], conv.g[0], conv.b[0]],
        uGrilleEnabled: on('grille'),
        uTriadsAcross: this._triads,
        uStripeFill: o.stripeFill, uMaskStrength: o.maskStrength, uMaskSoftness: o.maskSoftness,
        uHeadroom: this._backend && this._backend.hdr ? o.hdrHeadroom : o.headroom,
        uBloom: e.bloom ? o.bloomStrength : 0, uBloomRadius: o.bloomRadius,
        uHalation: e.halation && this._quality < 2 ? o.halationStrength : 0, uHalationRadius: o.halationRadius,
        uDamperY: [wires[0] ?? -1, wires[1] ?? -1],
        uDamperStrength: o.damperStrength, uDamperWidthPx: o.damperWidthPx,
        uGradeGains: (e.colorGrade || warming) ? this._gradeGains(temp) : [1, 1, 1],
        uGradeSaturation: (e.colorGrade || warming) ? sat : 1,
        uWarmup: e.warmup ? warmK * warmK * (3 - 2 * warmK) : 1,
        uToneEnabled: on('tone'), uShoulderStart: o.shoulderStart,
        uVignette: e.vignette ? o.vignette : 0,
        uCornerRadius: e.tubeCorners ? o.cornerRadius : 0,
        uCurvature: e.curvature ? o.curvature : 0,
        uGloss: e.gloss ? o.gloss : 0,
        uOutputP3: outputP3,
      };
    }

    // --- One frame ------------------------------------------------------
    // Synchronous; the scheduler calls it from RAF, tests call it directly.
    // Returns whether new signal content was uploaded ("dirty").
    renderFrame(timeMs) {
      const b = this._backend;
      if (!b) return false;
      const stale = this._signalStale;
      this._signalStale = false;
      let dirty;
      if (this._source) {
        dirty = this._source.poll() || (stale && this._source.ready && this._source.ready());
        if (dirty) {
          const [sw, sh] = this.opts.signalSize;
          const fitFn = this._source.fit === 'cover' ? math.fitCover : math.fitContain;
          b.upload(this._source.element, fitFn(this._source.width, this._source.height, sw, sh));
        }
      } else {
        const painted = this.opts.signal ? this.opts.signal(this._signalCtx, timeMs, stale) : false;
        // The restore frame uploads regardless: a consumer that ignores
        // needsRepaint degrades to its last-painted canvas, never to
        // undefined GPU memory.
        dirty = painted !== false || stale || this._frameCount === 0;
        if (dirty) b.upload(this._signalCanvas, FIT_IDENTITY);
      }

      const hl = this.opts.persistenceHalfLifeMs;
      const first = this._lastRenderT == null;
      const dt = first ? 0 : Math.max(1, timeMs - this._lastRenderT);
      this._lastRenderT = timeMs;
      const decay = (first || !this.effects.persistence) ? 0 : math.decay(dt, hl);

      const tWarm = timeMs - this._warmupStartMs;
      const warmK = this.effects.warmup ? Math.max(0, Math.min(1, tWarm / WARMUP_MS)) : 1;

      b.render({ decay, uploadedThisFrame: dirty, warmup: warmK, uniforms: this._uniforms(warmK), quality: this._quality });
      this._frameCount++;
      return dirty;
    }

    readPixels() { return this._backend ? this._backend.readPixels() : null; }

    // --- Scheduler ------------------------------------------------------
    start() {
      this._wasStartedByUser = true;
      if (this._rafHandle != null) return;
      // Zero the trail so a stop/start (e.g. a theme toggle) never ghosts
      // the previous session into this one; warmup restarts.
      if (this._backend) this._backend.clearPersistence();
      this._warmupStartMs = 0;
      this._startTime = performance.now();
      this._lastRenderT = null;
      this._resumeLoop();
    }

    stop() {
      this._wasStartedByUser = false;
      this._mode = 'stopped';
      if (this._rafHandle != null) { cancelAnimationFrame(this._rafHandle); this._rafHandle = null; }
    }

    // Halt WITHOUT touching user intent (visibility, reduced motion).
    _haltLoop() {
      if (this._rafHandle != null) { cancelAnimationFrame(this._rafHandle); this._rafHandle = null; }
      if (this._mode !== 'idle') this._mode = 'stopped';
    }

    // How long to keep rendering after the signal goes static so trails
    // decay below one 8-bit LSB: log2(255) ≈ 7.994 half-lives.
    _settleTailMs() {
      if (!this.effects.persistence) return 0;
      return (this.opts.persistenceHalfLifeMs || 0) * 7.994;
    }

    // (Re)enter the loop if intent, visibility, GPU state and reduced
    // motion allow. "Wake up", not "turn on": no trail clear, no warmup.
    _resumeLoop() {
      if (this._rafHandle != null) return;
      if (!this._backend || !this._wasStartedByUser || !this._visible) return;
      if (this._reducedMotionMq && this._reducedMotionMq.matches) {
        // One static frame past the warmup ramp: the steady-state tube.
        this.renderFrame(Math.max(WARMUP_MS, performance.now() - this._startTime));
        return;
      }
      this._idleAt = performance.now() + this._settleTailMs();
      this._lastTick = null;
      const tick = (now) => {
        const t = now - this._startTime;
        const dirty = this.renderFrame(t);
        if (this._lastTick != null && dirty) this._noteFrameInterval(now - this._lastTick);
        this._lastTick = now;
        const warmingUp = this.effects.warmup && t < this._warmupStartMs + WARMUP_MS;
        if (dirty || warmingUp) this._idleAt = now + this._settleTailMs();
        if (warmingUp) {
          // Never park mid-ramp, even with a zero settle tail.
          const warmupEndsAt = this._startTime + this._warmupStartMs + WARMUP_MS;
          this._idleAt = Math.max(this._idleAt, warmupEndsAt + this._settleTailMs());
        }
        if (this._rafHandle === null) return;   // stop() ran mid-frame
        if (now >= this._idleAt) {
          this._rafHandle = null;
          this._mode = 'idle';
          return;
        }
        this._rafHandle = requestAnimationFrame(tick);
      };
      this._mode = 'running';
      this._rafHandle = requestAnimationFrame(tick);
    }

    // Adaptive quality hook (Task 8 fills this in).
    _noteFrameInterval(ms) { /* adaptive quality: see Task 8 */ }

    // Wake a parked renderer for at least one frame. No-op while the loop
    // is live or the user stopped it.
    requestRender() { this._resumeLoop(); }

    _setupVisibilityObserver() {
      if (typeof IntersectionObserver === 'undefined') return;
      this._io = new IntersectionObserver((entries) => {
        this._visible = entries[entries.length - 1].isIntersecting;
        if (this._visible) this._resumeLoop();
        else this._haltLoop();
      });
      this._io.observe(this.canvas);
    }

    _setupReducedMotionListener() {
      if (!this.opts.respectReducedMotion) return;
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      this._reducedMotionMq = mq;
      this._reducedMotionHandler = () => { if (mq.matches) this._haltLoop(); else this._resumeLoop(); };
      if (mq.addEventListener) mq.addEventListener('change', this._reducedMotionHandler);
      else if (mq.addListener) mq.addListener(this._reducedMotionHandler);
    }

    destroy() {
      this.stop();
      const mq = this._reducedMotionMq;
      if (mq && this._reducedMotionHandler) {
        if (mq.removeEventListener) mq.removeEventListener('change', this._reducedMotionHandler);
        else if (mq.removeListener) mq.removeListener(this._reducedMotionHandler);
      }
      if (this._io) { this._io.disconnect(); this._io = null; }
      if (this._ro) { this._ro.disconnect(); this._ro = null; }
      if (this._source && this._source.detach) this._source.detach();
      this.canvas.removeEventListener('webglcontextlost', this._onContextLost);
      this.canvas.removeEventListener('webglcontextrestored', this._onContextRestored);
      if (this._backend) { this._backend.destroy(); this._backend = null; }
    }

    // --- Bench API ------------------------------------------------------
    // __convergenceSpread is a synthetic scalar: X-only R/B offsets.
    readParam(opt) {
      if (opt === '__convergenceSpread') return Math.abs(this.opts.convergence?.r?.[0] ?? 0);
      return this.opts[opt] ?? 0;
    }

    writeParam(opt, v) {
      if (opt === '__convergenceSpread') this.opts.convergence = { r: [-v, 0], g: [0, 0], b: [v, 0] };
      else this.opts[opt] = v;
      if (opt === 'triadTarget' || opt === 'minPxPerTriad') this._updateTriads();
      this.requestRender();
    }

    _snapshotState() {
      const snap = { effects: { ...this.effects }, opts: {} };
      for (const k of PANEL_OPT_KEYS) if (k in this.opts) snap.opts[k] = this.opts[k];
      const c = this.opts.convergence;
      if (c) snap.opts.convergence = { r: [...c.r], g: [...c.g], b: [...c.b] };
      return snap;
    }

    // Human-readable diff vs. construction — the bench's "copy state".
    stateDiff() {
      const fmt = (n) => Number.isInteger(n) ? String(n) : String(Math.round(n * 10000) / 10000);
      const curr = this._snapshotState();
      const base = this._baseline;
      const lines = [];
      for (const k of Object.keys(curr.effects)) {
        if (curr.effects[k] !== base.effects[k]) lines.push(`  effects.${k} = ${curr.effects[k]}`);
      }
      for (const k of Object.keys(curr.opts)) {
        const cv = curr.opts[k], bv = base.opts[k];
        if (k === 'convergence') {
          const eq = bv && ['r', 'g', 'b'].every((ch) => cv[ch][0] === bv[ch][0] && cv[ch][1] === bv[ch][1]);
          if (!eq) lines.push(`  opts.convergence = { r: [${cv.r.map(fmt)}], g: [${cv.g.map(fmt)}], b: [${cv.b.map(fmt)}] }`);
        } else if (cv !== bv) {
          lines.push(typeof cv === 'string' ? `  opts.${k} = '${cv}'` : `  opts.${k} = ${fmt(cv)}`);
        }
      }
      if (!lines.length) return 'crt state: (no changes from construction)';
      return ['crt state diff (from construction):', ...lines].join('\n');
    }
  }

  CRT.math = math;
  CRT.effectSchema = effectSchema;
  CRT.DEFAULT_OPTS = DEFAULT_OPTS;
  CRT.DEFAULT_EFFECTS = DEFAULT_EFFECTS;
  // Backend registry. Each entry: { create(canvas, ctx) → backend }, where
  // backend implements: kind, hdr, outputColorSpace, resize(w,h),
  // setSignalSize(w,h), upload(source, fit), render(frame),
  // clearPersistence(), readPixels(), destroy(). create() throws an Error
  // matching /unavailable/i before mutating anything when it can't run.
  CRT.backends = {};
  CRT.presets = {};

  window.CRT = CRT;
})();
