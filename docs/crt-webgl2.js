// CRT engine v2 — WebGL2 backend (the core path every browser gets).
//
// Passes per frame (textures are stored top-row-first, "image
// orientation"; only the screen pass flips to the GL framebuffer):
//   1. persist  (signal res, RGBA16F ping-pong): decode the source to
//               linear light, afterglow = max(live, prev × decay).
//   2. screen   (output res, default framebuffer): the tube.
// Uniform values come from the chassis (CRT#_uniforms) and are set by
// name, so this file maps values to GPU slots and nothing else.
(function () {
  'use strict';
  const CRT = window.CRT;
  if (!CRT) return;

  const VS = `#version 300 es
layout(location = 0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

  const COMMON = `#version 300 es
precision highp float;
precision highp int;
`;

  // Linear P3 → linear sRGB (D65). Rows are GLSL columns.
  const P3_TO_SRGB = `const mat3 P3_TO_SRGB = mat3(
   1.2249401, -0.0420569, -0.0196376,
  -0.2249404,  1.0420571, -0.0786361,
   0.0000001,  0.0000000,  1.0982735);`;

  const PERSIST_FS = COMMON + P3_TO_SRGB + `
uniform sampler2D uSrc;
uniform sampler2D uPrev;
uniform vec2 uSignalSize;
uniform vec2 uFitScale;
uniform vec2 uFitOffset;
uniform float uDecay;
uniform float uExposure;
uniform float uSignalP3;
out vec4 oColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uSignalSize;
  vec2 s = (uv - uFitOffset) / uFitScale;
  vec3 live = vec3(0.0);
  if (all(greaterThanEqual(s, vec2(0.0))) && all(lessThanEqual(s, vec2(1.0)))) {
    live = texture(uSrc, s).rgb;               // SRGB8_ALPHA8: hardware-decoded, linear
  }
  if (uSignalP3 > 0.5) live = P3_TO_SRGB * live;
  live = max(live, 0.0) * uExposure;
  vec3 prev = texelFetch(uPrev, ivec2(gl_FragCoord.xy), 0).rgb;
  // Phosphor: instant attack, exponential release.
  oColor = vec4(max(live, prev * uDecay), 1.0);
}`;

  const SCREEN_FS = COMMON + `
uniform sampler2D uPersist;
uniform vec2 uOutSize;
out vec4 oColor;
float enc1(float l) { float a = abs(l); return sign(l) * (a <= 0.0031308 ? 12.92 * a : 1.055 * pow(a, 1.0 / 2.4) - 0.055); }
vec3 enc(vec3 c) { return vec3(enc1(c.r), enc1(c.g), enc1(c.b)); }
void main() {
  vec2 p = vec2(gl_FragCoord.x, uOutSize.y - gl_FragCoord.y) / uOutSize;
  vec3 c = texture(uPersist, p).rgb;
  oColor = vec4(enc(clamp(c, 0.0, 1.0)), 1.0);
}`;

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('CRT shader compile failed: ' + log);
    }
    return sh;
  }

  function program(gl, fsSrc) {
    const vs = compile(gl, gl.VERTEX_SHADER, VS);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('CRT program link failed: ' + gl.getProgramInfoLog(p));
    // Uniform location cache keyed by name; samplers are tracked so the
    // generic setter skips them.
    const locs = {};
    const samplers = new Set();
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const name = info.name.replace(/\[0\]$/, '');
      locs[name] = gl.getUniformLocation(p, info.name);
      if (info.type === gl.SAMPLER_2D) samplers.add(name);
    }
    return { p, locs, samplers };
  }

  // Set every uniform the program declares from a flat {name: value} map.
  function setUniforms(gl, prog, values) {
    for (const name in prog.locs) {
      if (prog.samplers.has(name)) continue;
      const v = values[name];
      if (v === undefined) continue;
      const loc = prog.locs[name];
      if (typeof v === 'number') gl.uniform1f(loc, v);
      else if (v.length === 2) gl.uniform2fv(loc, v);
      else if (v.length === 3) gl.uniform3fv(loc, v);
      else if (v.length === 4) gl.uniform4fv(loc, v);
    }
  }

  function bindSampler(gl, prog, name, unit, tex) {
    const loc = prog.locs[name];
    if (loc === undefined) return;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
  }

  function create(canvas, { opts }) {
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 unavailable');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('WebGL2 float rendering unavailable');
    if ('unpackColorSpace' in gl) {
      try { gl.unpackColorSpace = opts.signalColorSpace === 'display-p3' ? 'display-p3' : 'srgb'; } catch (_) { /* unsupported value */ }
    }

    const progs = { persist: program(gl, PERSIST_FS), screen: program(gl, SCREEN_FS) };

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const texParams = (filter, mip) => {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    };
    const target = (w, h) => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, w, h);
      texParams(gl.LINEAR, false);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { tex, fbo, w, h };
    };
    const freeTarget = (t) => { if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); } };

    const src = { tex: gl.createTexture(), w: 0, h: 0, mip: false };
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    texParams(gl.LINEAR, false);

    let fit = { scale: [1, 1], offset: [0, 0] };
    let signal = [1, 1];
    let persist = [null, null];
    let flip = 0;

    const draw = (t, prog, w, h) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null);
      gl.viewport(0, 0, w, h);
      gl.useProgram(prog.p);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const backend = {
      kind: 'webgl2',
      hdr: false,
      outputColorSpace: 'srgb',

      resize(w, h) {
        canvas.width = w;
        canvas.height = h;
      },

      setSignalSize(w, h) {
        signal = [w, h];
        persist.forEach(freeTarget);
        persist = [target(w, h), target(w, h)];
        backend.clearPersistence();
      },

      // Source rows land top-first (no UNPACK_FLIP_Y): textures stay in
      // image orientation throughout.
      upload(source, f) {
        fit = f;
        const w = source.videoWidth || source.width;
        const h = source.videoHeight || source.height;
        if (!w || !h) return;
        const mip = w > signal[0] * 1.5 || h > signal[1] * 1.5;   // downscaling video: mipmap it
        gl.bindTexture(gl.TEXTURE_2D, src.tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
        if (mip) gl.generateMipmap(gl.TEXTURE_2D);
        if (mip !== src.mip) { texParams(gl.LINEAR, mip); src.mip = mip; }
        src.w = w; src.h = h;
      },

      render(frame) {
        const u = frame.uniforms;
        const [w, h] = signal;
        const prev = persist[flip];
        const next = persist[1 - flip];

        const P = progs.persist;
        gl.useProgram(P.p);
        setUniforms(gl, P, Object.assign({ uFitScale: fit.scale, uFitOffset: fit.offset, uDecay: frame.decay }, u));
        bindSampler(gl, P, 'uSrc', 0, src.tex);
        bindSampler(gl, P, 'uPrev', 1, prev.tex);
        draw(next, P, w, h);
        flip = 1 - flip;

        const S = progs.screen;
        gl.useProgram(S.p);
        setUniforms(gl, S, u);
        bindSampler(gl, S, 'uPersist', 0, next.tex);
        draw(null, S, canvas.width, canvas.height);
      },

      clearPersistence() {
        for (const t of persist) {
          if (!t) continue;
          gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
          gl.clearBufferfv(gl.COLOR, 0, new Float32Array([0, 0, 0, 1]));
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      },

      // Tests only: RGBA8 of the frame just drawn, top row first.
      readPixels() {
        const w = canvas.width, h = canvas.height;
        const raw = new Uint8Array(w * h * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
        const out = new Uint8Array(raw.length);
        const row = w * 4;
        for (let y = 0; y < h; y++) out.set(raw.subarray((h - 1 - y) * row, (h - y) * row), y * row);
        return out;
      },

      destroy() {
        if (gl.isContextLost()) return;
        persist.forEach(freeTarget);
        gl.deleteTexture(src.tex);
        for (const k in progs) gl.deleteProgram(progs[k].p);
        gl.deleteBuffer(vbo);
        gl.deleteVertexArray(vao);
      },
    };
    return backend;
  }

  CRT.backends.webgl2 = { create };
})();
