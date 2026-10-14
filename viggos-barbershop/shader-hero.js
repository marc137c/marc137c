// Animert WebGL2-bakgrunn for hero-seksjonen: røyk i dyp grønn og gull (fra logoen),
// med svake, flytende barberstang-striper. Reagerer på mus/finger.
// Faller tilbake til CSS-gradienten hvis WebGL2 mangler.
(() => {
  const canvas = document.getElementById("hero-canvas");
  if (!canvas) return;
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, powerPreference: "low-power" });
  if (!gl) { canvas.remove(); return; }

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const vertexSrc = `#version 300 es
in vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }`;

  const fragmentSrc = `#version 300 es
precision highp float;
out vec4 fragColor;
uniform vec2 resolution;
uniform float time;
uniform vec2 pointer;     // 0..1, y opp
uniform float energy;     // 0..1, øker når pekeren beveger seg
uniform float light;      // 0 = mørkt tema, 1 = lyst tema

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 r = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = r * p * 2.0 + 3.1; a *= 0.5; }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  float aspect = resolution.x / resolution.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  vec2 m = (pointer - 0.5) * vec2(aspect, 1.0);
  float t = time * 0.06;

  // Pekeren drar røyken mot seg
  vec2 toM = m - p;
  float md = length(toM);
  p += toM * 0.18 * exp(-md * 3.0) * (0.4 + energy);

  // Domenevridning gir silkeaktig røyk
  vec2 q = vec2(fbm(p * 1.6 + t), fbm(p * 1.6 - t + 4.7));
  vec2 r = vec2(fbm(p * 1.4 + q * 2.2 + vec2(1.7, 9.2) + t * 1.3), fbm(p * 1.4 + q * 2.2 + vec2(8.3, 2.8) - t));
  float smoke = fbm(p * 1.2 + r * 2.0);

  // Mørkt tema: dyp grønn marmor. Lyst tema: elfenben med salviegrønn røyk.
  vec3 bg    = mix(vec3(0.043, 0.059, 0.051), vec3(0.969, 0.949, 0.910), light);
  vec3 wood  = mix(vec3(0.06, 0.20, 0.13), vec3(0.80, 0.85, 0.77), light);
  vec3 gold  = vec3(0.81, 0.65, 0.37);
  vec3 cream = vec3(0.95, 0.92, 0.88);

  vec3 col = mix(bg, wood, smoothstep(0.2, 0.7, smoke));
  col = mix(col, gold, smoothstep(0.45, 0.9, smoke * (0.6 + r.x * 0.8)) * 0.9);

  // Barberstang-striper som bølger gjennom røyken
  float s = (p.x + p.y) * 5.0 + r.y * 2.5 - time * 0.35;
  float band = fract(s / 3.0);
  vec3 stripe = band < 0.333 ? vec3(0.70, 0.23, 0.20) : band < 0.666 ? cream : vec3(0.17, 0.31, 0.54);
  float stripeMask = smoothstep(0.45, 0.85, q.y) * mix(0.38, 0.22, light);
  col = mix(col, stripe, stripeMask * smoothstep(0.2, 0.8, smoke));

  // Gyllen glød rundt pekeren
  col += gold * exp(-md * 4.5) * (0.12 + energy * 0.35) * mix(1.0, 0.45, light);

  // Vignett og litt filmkorn
  col *= 1.0 - mix(0.55, 0.16, light) * dot(uv - 0.5, uv - 0.5) * 2.2;
  col += (hash(gl_FragCoord.xy + time) - 0.5) * 0.025;

  fragColor = vec4(col, 1.0);
}`;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  let program;
  try {
    program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSrc));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSrc));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  } catch (err) {
    console.warn("Shader-bakgrunn deaktivert:", err);
    canvas.remove();
    return;
  }
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, 1, -1, -1, 1, 1, 1, -1]), gl.STATIC_DRAW);
  const pos = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(pos);
  gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

  const u = {
    resolution: gl.getUniformLocation(program, "resolution"),
    time: gl.getUniformLocation(program, "time"),
    pointer: gl.getUniformLocation(program, "pointer"),
    energy: gl.getUniformLocation(program, "energy"),
    light: gl.getUniformLocation(program, "light"),
  };

  // Lavere oppløsning holder det jevnt også på svake mobiler
  const scale = () => Math.min(window.devicePixelRatio || 1, 1.5) * 0.6;
  function resize() {
    const w = Math.max(1, Math.round(canvas.clientWidth * scale()));
    const h = Math.max(1, Math.round(canvas.clientHeight * scale()));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }

  const target = { x: 0.7, y: 0.6 };
  const ptr = { x: 0.7, y: 0.6 };
  let energy = 0;
  const hero = canvas.parentElement;
  hero.addEventListener("pointermove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = 1 - (e.clientY - rect.top) / rect.height;
    energy = Math.min(1, energy + Math.hypot(nx - target.x, ny - target.y) * 4);
    target.x = nx;
    target.y = ny;
  }, { passive: true });

  // Tema: glir mykt mellom mørkt og lyst når bryteren brukes
  const themeTarget = () => (document.documentElement.dataset.theme === "light" ? 1 : 0);
  let light = themeTarget();

  let raf = 0;
  let visible = true;
  const start = performance.now();
  function frame(now) {
    resize();
    ptr.x += (target.x - ptr.x) * 0.06;
    ptr.y += (target.y - ptr.y) * 0.06;
    energy *= 0.96;
    light += (themeTarget() - light) * (reduceMotion.matches ? 1 : 0.12);
    if (Math.abs(themeTarget() - light) < 0.002) light = themeTarget();
    gl.uniform2f(u.resolution, canvas.width, canvas.height);
    gl.uniform1f(u.time, (now - start) / 1000);
    gl.uniform2f(u.pointer, ptr.x, ptr.y);
    gl.uniform1f(u.energy, energy);
    gl.uniform1f(u.light, light);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    raf = visible && !reduceMotion.matches ? requestAnimationFrame(frame) : 0;
  }
  const play = () => { if (!raf) raf = requestAnimationFrame(frame); };

  // Stopp animasjonen når hero ikke vises – sparer batteri
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) play();
  }).observe(hero);
  reduceMotion.addEventListener("change", play);
  window.addEventListener("themechange", play);
  window.addEventListener("resize", () => { if (!raf) play(); });

  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); cancelAnimationFrame(raf); raf = 0; canvas.remove(); });

  play(); // med redusert bevegelse tegnes ett stillbilde
})();
