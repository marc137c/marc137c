// Gyllent partikkel-snøfall over hele siden.
// Eget lerret som ikke tar imot klikk. Tilpasser seg lyst/mørkt tema,
// gir litt dybde når man scroller, og står stille ved «redusert bevegelse».
(() => {
  const canvas = document.createElement("canvas");
  canvas.id = "gold-snow";
  canvas.setAttribute("aria-hidden", "true");
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const isLight = () => document.documentElement.dataset.theme === "light";

  // Ferdigtegnet glødende gullprikk, gjenbrukes for hver partikkel (raskt)
  function makeSprite(core, glow) {
    const s = document.createElement("canvas");
    s.width = s.height = 64;
    const g = s.getContext("2d");
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, core);
    grad.addColorStop(0.18, core);
    grad.addColorStop(0.42, glow);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return s;
  }
  const SPRITES = {
    dark: makeSprite("rgba(255, 240, 200, 1)", "rgba(222, 180, 95, .35)"),
    light: makeSprite("rgba(196, 146, 52, 1)", "rgba(214, 168, 76, .2)"),
  };

  let W = 0, H = 0, dpr = 1, flakes = [];
  const rand = (a, b) => a + Math.random() * (b - a);

  function makeFlake(top = false) {
    const depth = Math.random(); // 0 = langt bak, 1 = nær
    return {
      x: rand(0, W),
      y: top ? rand(-40, -5) : rand(0, H),
      r: 0.9 + depth * 2.1,                  // radius på kjernen
      vy: 0.1 + depth * 0.32,                // fallhastighet (rolig)
      sway: rand(0.2, 0.9) * (0.4 + depth),  // sideveis vugging
      phase: rand(0, Math.PI * 2),
      spin: rand(0.004, 0.012),
      twinkle: rand(0.015, 0.04),
      alpha: 0.2 + depth * 0.4,
      depth,
    };
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Antall tilpasses skjermstørrelsen: luftig på mobil, fyldig på store skjermer
    const target = Math.round(Math.min(80, Math.max(18, (W * H) / 20000)));
    while (flakes.length < target) flakes.push(makeFlake());
    flakes.length = target;
  }

  let lastScroll = window.scrollY;
  let t = 0;

  function draw(step = 1) {
    ctx.clearRect(0, 0, W, H);
    const light = isLight();
    const sprite = light ? SPRITES.light : SPRITES.dark;
    ctx.globalCompositeOperation = light ? "source-over" : "lighter";

    // Litt dybde: nære partikler flytter seg mer når man scroller
    const scrollDelta = window.scrollY - lastScroll;
    lastScroll = window.scrollY;
    t += step;

    for (const f of flakes) {
      f.y += f.vy * step - scrollDelta * (0.06 + f.depth * 0.18);
      f.phase += f.spin * step;
      const x = f.x + Math.sin(f.phase) * f.sway * 12;
      if (f.y > H + 20) Object.assign(f, makeFlake(true));
      else if (f.y < -40) f.y = H + 10;
      if (x < -20) f.x += W + 40; else if (x > W + 20) f.x -= W + 40;

      const shimmer = 0.65 + 0.35 * Math.sin(t * f.twinkle + f.phase * 3);
      ctx.globalAlpha = Math.min(1, f.alpha * shimmer * (light ? 2.3 : 1));
      const size = f.r * (light ? 6 : 7); // sprite inkluderer gløden rundt kjernen
      ctx.drawImage(sprite, x - size / 2, f.y - size / 2, size, size);
    }
    ctx.globalAlpha = 1;
  }

  let raf = 0, last = 0;
  function loop(now) {
    const step = last ? Math.min((now - last) / 16.67, 3) : 1; // jevn fart uansett skjermfrekvens
    last = now;
    draw(step);
    raf = requestAnimationFrame(loop);
  }
  function start() {
    cancelAnimationFrame(raf);
    last = 0;
    if (reduceMotion.matches) draw(0); // stillestående gullstøv i stedet for fall
    else raf = requestAnimationFrame(loop);
  }

  resize();
  start();
  window.addEventListener("resize", () => { resize(); if (reduceMotion.matches) draw(0); });
  reduceMotion.addEventListener("change", start);
  window.addEventListener("themechange", () => { if (reduceMotion.matches) draw(0); });
})();
