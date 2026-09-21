import { buildGeom, wAt, yAt, tAtVol, vesselPath, clamp } from './geom.js';
import { drawStack, layerAtY, PAL, rgba, mix } from './paint.js';
import { elapsed, fmt } from './session.js';

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class Stage {
  constructor(canvas, hooks = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.hooks = hooks;
    this.session = null;
    this.shown = 0;
    this.morph = 0;
    this.morphTarget = 0;
    this.morphStart = 0;
    this.drift = false;
    this.driftGlow = 0;
    this.parts = [];
    this.motes = [];
    this.hoverY = null;
    this.hovered = null;
    this.rate = 0;
    this.W = 0;
    this.H = 0;
    this.dpr = 1;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.last = performance.now();
    this.raf = null;
    this.onResize = this.resize.bind(this);
    new ResizeObserver(this.onResize).observe(canvas.parentElement);
    this.resize();
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.hoverY = e.clientY - r.top;
      this.hoverX = e.clientX - r.left;
    });
    canvas.addEventListener('pointerleave', () => {
      this.hoverY = null;
      this.hovered = null;
      hooks.onHover && hooks.onHover(null);
    });
  }

  resize() {
    const box = this.cv.parentElement;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.W = Math.max(240, box.clientWidth);
    this.H = Math.max(320, box.clientHeight);
    this.cv.width = Math.round(this.W * this.dpr);
    this.cv.height = Math.round(this.H * this.dpr);
    this.cv.style.width = this.W + 'px';
    this.cv.style.height = this.H + 'px';
  }

  attach(session) {
    this.session = session;
    this.shown = 0;
    this.morph = 0;
    this.morphTarget = 0;
    this.morphStart = 0;
    this.parts.length = 0;
    this.motes.length = 0;
    this.drift = false;
    this.run();
  }

  setDrift(v) {
    this.drift = v;
  }

  extract() {
    this.morphTarget = 1;
    this.morphStart = performance.now();
  }

  run() {
    if (this.raf) return;
    const loop = (ts) => {
      this.raf = requestAnimationFrame(loop);
      this.frame(ts);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  geom() {
    const m = this.morph;
    const flaskR = Math.min(this.W * 0.3, this.H * 0.19);
    const coreR = Math.min(this.W * 0.42, 190);
    return buildGeom({
      cx: this.W / 2,
      top: this.H * (0.085 + 0.015 * m),
      bottom: this.H * (0.935 - 0.01 * m),
      R: flaskR + (coreR - flaskR) * m,
      morph: m
    });
  }

  frame(ts) {
    const dt = Math.min(60, ts - this.last);
    this.last = ts;
    const s = this.session;
    if (!s) return;

    const cap = s.capacityMs;
    const target = Math.min(cap, elapsed(s));
    const prev = this.shown;
    this.shown += (target - this.shown) * (1 - Math.exp(-dt / 260));
    if (target - this.shown < 4) this.shown = target;
    this.rate = dt > 0 ? (this.shown - prev) / dt : 0;

    if (this.morphTarget && this.morph < 1) {
      this.morph = easeInOut(clamp((performance.now() - this.morphStart) / 2400, 0, 1));
    }
    this.driftGlow += ((this.drift ? 1 : 0) - this.driftGlow) * (1 - Math.exp(-dt / 300));

    const g = this.geom();
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);

    const layers = s.layers;
    const topT = tAtVol(g, this.shown / cap);
    const surfY = yAt(g, topT);

    const fill = clamp(this.shown / cap, 0, 1);
    this.shadow(ctx, g, fill);
    if (this.morph < 0.98) this.aura(ctx, g, fill, surfY);

    drawStack(ctx, g, layers, {
      capacityMs: cap,
      shownMs: this.shown,
      live: !s.ended,
      amp: Math.min(10, g.R * 0.05) * (1 - this.morph * 0.85)
    });

    if (this.morph < 0.995) this.glass(ctx, g, 1 - this.morph, surfY, fill);
    if (this.morph > 0.02) this.coreFrame(ctx, g, this.morph);

    if (!s.ended && this.morph === 0) {
      this.emit(dt, g, surfY);
      this.stream(ctx, g, surfY, ts);
    }
    this.particles(ctx, dt, g, surfY);
    this.scale(ctx, g, cap);
    this.marker(ctx, g, topT, cap);
    this.hover(ctx, g, layers, cap);

    this.hooks.onTick && this.hooks.onTick(target, this.shown, this.rate);
    if (!s.ended && target >= cap) {
      this.hooks.onFull && this.hooks.onFull();
    }
  }

  shadow(ctx, g, fill) {
    const y = g.bottom + 14;
    const r = g.R * 1.15;
    const grd = ctx.createRadialGradient(g.cx, y, 0, g.cx, y, r);
    grd.addColorStop(0, 'rgba(0,0,0,0.6)');
    grd.addColorStop(0.55, mix(PAL.ink, PAL.focusDeep, 0.18 * fill, 0.34));
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save();
    ctx.translate(g.cx, y);
    ctx.scale(1, 0.14);
    ctx.translate(-g.cx, -y);
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(g.cx, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  aura(ctx, g, fill, surfY) {
    if (fill > 0.02) {
      const cy = (surfY + g.bottom) / 2;
      const warm = ctx.createRadialGradient(g.cx, cy, g.R * 0.2, g.cx, cy, g.R * 2.7);
      warm.addColorStop(0, rgba(PAL.focus, 0.1 * fill + 0.02));
      warm.addColorStop(0.45, rgba(PAL.focusDeep, 0.05 * fill));
      warm.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = warm;
      ctx.fillRect(0, 0, this.W, this.H);
    }
    const a = this.driftGlow;
    if (a < 0.01) return;
    const cy = (g.top + g.bottom) / 2;
    const grd = ctx.createRadialGradient(g.cx, cy, g.R * 0.4, g.cx, cy, g.R * 3);
    grd.addColorStop(0, rgba(PAL.driftEdge, 0.15 * a));
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, this.W, this.H);
  }

  glass(ctx, g, a, surfY, fill) {
    ctx.save();
    ctx.globalAlpha = a;

    ctx.save();
    vesselPath(ctx, g, 1);
    ctx.clip();

    const body = ctx.createLinearGradient(g.cx - g.R, 0, g.cx + g.R, 0);
    body.addColorStop(0, rgba(PAL.bone, 0.05));
    body.addColorStop(0.3, rgba(PAL.bone, 0.008));
    body.addColorStop(0.7, rgba(PAL.bone, 0.014));
    body.addColorStop(1, rgba(PAL.bone, 0.058));
    ctx.fillStyle = body;
    ctx.fillRect(g.cx - g.R, g.top, g.R * 2, g.h);

    if (fill > 0.02) {
      const bounce = ctx.createRadialGradient(g.cx, surfY, g.R * 0.05, g.cx, surfY, g.R * 1.05);
      bounce.addColorStop(0, rgba(this.drift ? PAL.driftEdge : PAL.focusLite, 0.07 * a));
      bounce.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = bounce;
      ctx.fillRect(g.cx - g.R, surfY - g.R * 1.05, g.R * 2, g.R * 2.1);
    }

    const sheen = (xc, halfW, peak) => {
      const band = (y, h, mul) => {
        if (h <= 0) return;
        const hz = ctx.createLinearGradient(xc - halfW, 0, xc + halfW, 0);
        hz.addColorStop(0, rgba(PAL.bone, 0));
        hz.addColorStop(0.42, rgba(PAL.bone, peak * mul * 0.5));
        hz.addColorStop(0.5, rgba(PAL.bone, peak * mul));
        hz.addColorStop(0.58, rgba(PAL.bone, peak * mul * 0.45));
        hz.addColorStop(1, rgba(PAL.bone, 0));
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = hz;
        ctx.fillRect(xc - halfW, y, halfW * 2, h);
        ctx.restore();
      };
      const cut = clamp(surfY, g.top, g.bottom);
      band(g.top, cut - g.top, 1);
      band(cut, g.bottom - cut, 0.22);
    };
    sheen(g.cx - g.R * 0.64, g.R * 0.13, 0.17);
    sheen(g.cx + g.R * 0.52, g.R * 0.07, 0.085);

    const wall = (dir) => {
      const x0 = g.cx + dir * g.R;
      const wd = g.R * 0.075;
      const hz = ctx.createLinearGradient(x0, 0, x0 - dir * wd, 0);
      hz.addColorStop(0, rgba(PAL.bone, 0.26));
      hz.addColorStop(0.35, rgba(PAL.bone, 0.06));
      hz.addColorStop(1, rgba(PAL.bone, 0));
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = hz;
      ctx.fillRect(Math.min(x0, x0 - dir * wd), g.top, wd, g.h);
      ctx.restore();
    };
    wall(-1);
    wall(1);

    const lensY = g.bottom - g.R * 0.26;
    const lens = ctx.createRadialGradient(g.cx, lensY, 0, g.cx, lensY, g.R * 0.82);
    lens.addColorStop(0, rgba(PAL.bone, 0.055));
    lens.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = lens;
    ctx.fillRect(g.cx - g.R, lensY - g.R, g.R * 2, g.R * 2);
    ctx.restore();

    if (this.driftGlow > 0.01) {
      const rim = ctx.createLinearGradient(g.cx + g.R * 0.2, 0, g.cx + g.R, 0);
      rim.addColorStop(0, rgba(PAL.driftEdge, 0));
      rim.addColorStop(1, rgba(PAL.driftEdge, 0.32 * this.driftGlow));
      ctx.fillStyle = rim;
      ctx.fillRect(g.cx, g.top, g.R, g.h);
      const rim2 = ctx.createLinearGradient(g.cx - g.R, 0, g.cx - g.R * 0.3, 0);
      rim2.addColorStop(0, rgba(PAL.driftEdge, 0.2 * this.driftGlow));
      rim2.addColorStop(1, rgba(PAL.driftEdge, 0));
      ctx.fillStyle = rim2;
      ctx.fillRect(g.cx - g.R, g.top, g.R * 0.7, g.h);
    }
    ctx.restore();

    const k = this.driftGlow * 0.6;
    const line = ctx.createLinearGradient(0, g.top, 0, g.bottom);
    line.addColorStop(0, mix(PAL.bone, PAL.driftEdge, k, 0.5));
    line.addColorStop(0.3, mix(PAL.bone, PAL.driftEdge, k, 0.28));
    line.addColorStop(0.85, mix(PAL.bone, PAL.driftEdge, k, 0.34));
    line.addColorStop(1, mix(PAL.bone, PAL.driftEdge, k, 0.2));
    vesselPath(ctx, g, -1.4);
    ctx.lineWidth = 3;
    ctx.strokeStyle = rgba(PAL.ink, 0.72);
    ctx.stroke();

    vesselPath(ctx, g, 0);
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = line;
    ctx.stroke();

    vesselPath(ctx, g, 3.5);
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = rgba(PAL.bone, 0.07);
    ctx.stroke();

    if (fill > 0.015 && this.morph < 0.4) {
      const ew = wAt(g, tAtVol(g, fill)) * g.R;
      ctx.fillStyle = rgba(this.drift ? PAL.driftEdge : PAL.focusLite, 0.5);
      ctx.fillRect(g.cx - ew - 1, surfY - 1, 3, 2);
      ctx.fillRect(g.cx + ew - 2, surfY - 1, 3, 2);
    }

    const nw = wAt(g, 1) * g.R;
    ctx.beginPath();
    ctx.ellipse(g.cx, g.top, nw, nw * 0.26, 0, 0, Math.PI * 2);
    ctx.strokeStyle = rgba(PAL.bone, 0.34);
    ctx.lineWidth = 1.1;
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(g.cx, g.top + 2.4, nw - 2.6, (nw - 2.6) * 0.26, 0, 0, Math.PI * 2);
    ctx.strokeStyle = rgba(PAL.bone, 0.13);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  coreFrame(ctx, g, a) {
    const w = wAt(g, 0.5) * g.R;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.strokeStyle = rgba(PAL.bone, 0.26);
    ctx.lineWidth = 1;
    ctx.strokeRect(g.cx - w - 6.5, g.top - 6.5, (w + 6.5) * 2, g.h + 13);
    ctx.strokeStyle = rgba(PAL.bone, 0.1);
    ctx.strokeRect(g.cx - w - 0.5, g.top - 0.5, w * 2 + 1, g.h + 1);
    ctx.restore();
  }

  emit(dt, g, surfY) {
    if (this.reduced) return;
    const base = this.drift ? 0.006 : 0.003;
    let n = (base + Math.min(0.42, this.rate * 0.007)) * dt;
    if (this.parts.length > 220) n = 0;
    while (n > 0) {
      if (Math.random() < Math.min(1, n)) {
        const nw = wAt(g, 1) * g.R * 0.62;
        this.parts.push({
          x: g.cx + (Math.random() - 0.5) * nw * 1.5,
          y: g.top - 4 - Math.random() * 22,
          vx: (Math.random() - 0.5) * (this.drift ? 0.07 : 0.015),
          vy: 1.5 + Math.random() * (this.drift ? 3.2 : 1.5),
          s: 0.5 + Math.random() * (this.drift ? 0.9 : 0.6),
          cold: this.drift
        });
      }
      n -= 1;
    }
    if (this.motes.length < 26 && Math.random() < 0.05) {
      this.motes.push({
        x: g.cx + (Math.random() - 0.5) * g.R * 1.5,
        y: surfY - Math.random() * (surfY - g.top) * 0.9,
        vx: (Math.random() - 0.5) * 0.05,
        vy: -0.02 - Math.random() * 0.04,
        a: 0,
        life: 1,
        s: 0.5 + Math.random()
      });
    }
  }

  stream(ctx, g, surfY, ts) {
    if (this.reduced) return;
    const sway = Math.sin(ts / 700) * (this.drift ? 3.4 : 1.1);
    const w = this.drift ? 2.6 : 1.5;
    const grd = ctx.createLinearGradient(0, g.top - 30, 0, surfY);
    const c = this.drift ? PAL.driftEdge : PAL.focusLite;
    grd.addColorStop(0, rgba(c, 0));
    grd.addColorStop(0.25, rgba(c, this.drift ? 0.34 : 0.22));
    grd.addColorStop(1, rgba(c, this.drift ? 0.5 : 0.34));
    ctx.save();
    vesselPath(ctx, g, 1);
    ctx.clip();
    ctx.beginPath();
    ctx.moveTo(g.cx, g.top - 30);
    ctx.bezierCurveTo(
      g.cx + sway, g.top + g.h * 0.3,
      g.cx - sway, g.top + g.h * 0.6,
      g.cx + sway * 0.3, surfY
    );
    ctx.strokeStyle = grd;
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.restore();
  }

  particles(ctx, dt, g, surfY) {
    const k = dt / 16.6;
    ctx.save();
    vesselPath(ctx, g, 1);
    ctx.clip();
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.vy += 0.045 * k;
      p.x += p.vx * k;
      p.y += p.vy * k;
      const land = surfY - 1;
      if (p.y >= land || this.morph > 0) {
        this.parts.splice(i, 1);
        if (p.y >= land && Math.random() < 0.7) {
          const dir = Math.sign(p.x - g.cx) || 1;
          this.motes.push({
            x: p.x,
            y: land,
            vx: dir * (0.25 + Math.random() * 0.5),
            vy: -0.12 - Math.random() * 0.2,
            a: 0.8,
            life: 0.7,
            s: 0.7
          });
        }
        continue;
      }
      ctx.fillStyle = p.cold ? rgba(PAL.driftEdge, 0.66) : rgba(PAL.focusLite, 0.6);
      ctx.fillRect(p.x, p.y, p.s, p.s * 2.8);
    }
    for (let i = this.motes.length - 1; i >= 0; i--) {
      const m = this.motes[i];
      m.vy += 0.02 * k;
      m.x += m.vx * k;
      m.y += m.vy * k;
      m.life -= 0.012 * k;
      if (m.life <= 0) {
        this.motes.splice(i, 1);
        continue;
      }
      ctx.globalAlpha = Math.max(0, m.life) * 0.5;
      ctx.fillStyle = rgba(PAL.focusLite, 1);
      ctx.fillRect(m.x, m.y, m.s, m.s);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  scale(ctx, g, cap) {
    const mins = cap / 60000;
    const step = mins > 30 ? 2 : 1;
    const major = mins > 30 ? 10 : 5;
    ctx.save();
    ctx.font = '500 8.5px "IBM Plex Mono", ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    for (let m = 0; m <= mins; m += step) {
      const t = tAtVol(g, (m * 60000) / cap);
      const y = yAt(g, t);
      const x = g.cx + wAt(g, t) * g.R;
      const isMajor = m % major === 0;
      ctx.beginPath();
      ctx.moveTo(x + 7, y);
      ctx.lineTo(x + 7 + (isMajor ? 13 : 6), y);
      ctx.strokeStyle = rgba(PAL.bone, isMajor ? 0.3 : 0.14);
      ctx.lineWidth = 1;
      ctx.stroke();
      if (isMajor && m > 0) {
        ctx.fillStyle = rgba(PAL.bone, 0.38);
        ctx.fillText(String(m), x + 25, y);
      }
    }
    ctx.restore();
  }

  marker(ctx, g, topT, cap) {
    if (this.morph > 0.5) return;
    const y = yAt(g, topT);
    const x = g.cx - wAt(g, topT) * g.R;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x - 8, y);
    ctx.lineTo(x - 15, y - 3.5);
    ctx.lineTo(x - 15, y + 3.5);
    ctx.closePath();
    ctx.fillStyle = this.drift ? rgba(PAL.driftEdge, 0.85) : rgba(PAL.bone, 0.6);
    ctx.fill();
    ctx.font = '400 9px "IBM Plex Mono", ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = this.drift ? rgba(PAL.driftEdge, 0.8) : rgba(PAL.bone, 0.45);
    ctx.fillText(fmt(this.shown), x - 21, y);
    ctx.restore();
  }

  hover(ctx, g, layers, cap) {
    if (this.hoverY == null) return;
    const l = layerAtY(g, layers, cap, this.shown, this.hoverY);
    if (l !== this.hovered) {
      this.hovered = l;
      this.hooks.onHover &&
        this.hooks.onHover(
          l ? { layer: { ...l, end: l.end ?? this.shown }, x: this.hoverX, y: this.hoverY } : null
        );
    }
    if (!l) return;
    const y0 = yAt(g, tAtVol(g, l.start / cap));
    const y1 = yAt(g, tAtVol(g, Math.min(l.end ?? this.shown, this.shown) / cap));
    ctx.save();
    vesselPath(ctx, g, 1.5);
    ctx.clip();
    ctx.fillStyle = rgba(PAL.bone, 0.055);
    ctx.fillRect(g.cx - g.R, y1, g.R * 2, y0 - y1);
    ctx.restore();
  }
}
