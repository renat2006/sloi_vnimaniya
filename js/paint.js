import { clamp, wAt, yAt, tAtVol, vesselPath } from './geom.js';

export const PAL = {
  focus: '#E9DFC7',
  focusDeep: '#A8966F',
  drift: '#3A4552',
  driftDeep: '#1D2229',
  driftEdge: '#8FC4D2',
  bone: '#E8E2D6',
  ink: '#08090B'
};

const hex = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16)
];

export function mix(a, b, t, alpha = 1) {
  const A = hex(a);
  const B = hex(b);
  const c = A.map((v, i) => Math.round(v + (B[i] - v) * clamp(t, 0, 1)));
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}

export function rgba(h, a) {
  const c = hex(h);
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

let grainTile = null;
function grain() {
  if (grainTile) return grainTile;
  const c = document.createElement('canvas');
  c.width = c.height = 140;
  const x = c.getContext('2d');
  const img = x.createImageData(140, 140);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random();
    const s = v < 0.5 ? 0 : 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = s;
    img.data[i + 3] = Math.random() < 0.35 ? 255 * (0.25 + Math.random() * 0.55) : 0;
  }
  x.putImageData(img, 0, 0);
  grainTile = c;
  return c;
}

const seedOf = (n) => (Math.sin(n * 127.1) * 43758.5453) % 1;

function curveFn(g, t, seed, amp) {
  const y0 = yAt(g, t);
  const wpx = Math.max(8, wAt(g, t) * g.R);
  return (x) => {
    const d = clamp((x - g.cx) / wpx, -1, 1);
    const cone = -amp * Math.pow(1 - d * d, 1.3);
    const n = Math.sin(d * 6.1 + seed * 9) * 0.8 + Math.sin(d * 2.7 - seed * 14) * 1.25;
    return y0 + cone + n * amp * 0.28;
  };
}

function trace(ctx, fy, x0, x1, move) {
  const steps = 34;
  for (let i = 0; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps;
    const y = fy(x);
    if (i === 0 && move) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
}

export function drawStack(ctx, g, layers, opts = {}) {
  const {
    capacityMs = 1,
    shownMs = 0,
    hazeMs = 70000,
    amp = Math.min(10, g.R * 0.05),
    grainAlpha = 0.16,
    live = false
  } = opts;

  if (shownMs <= 0) return;

  const xL = g.cx - g.R * 1.12;
  const xR = g.cx + g.R * 1.12;
  const topT = tAtVol(g, shownMs / capacityMs);
  const flat = g.morph > 0.85;
  const surfAmp = flat ? amp * 0.15 : amp;
  const surf = curveFn(g, topT, 0.37, surfAmp);

  ctx.save();
  vesselPath(ctx, g, 1.2);
  ctx.clip();

  ctx.beginPath();
  trace(ctx, surf, xL, xR, true);
  ctx.lineTo(xR, g.bottom + 40);
  ctx.lineTo(xL, g.bottom + 40);
  ctx.closePath();
  ctx.clip();

  const bands = [];
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    const s = l.start;
    const e = Math.min(l.end ?? shownMs, shownMs);
    if (e <= s) continue;
    bands.push({ ...l, s, e, i });
  }

  bands.forEach((b, k) => {
    const t0 = tAtVol(g, b.s / capacityMs);
    const t1 = tAtVol(g, b.e / capacityMs);
    const y0 = yAt(g, t0);
    const y1 = yAt(g, t1);
    const last = k === bands.length - 1;
    const lowA = k === 0 ? amp * 0.2 : amp * (flat ? 0.15 : 0.8);
    const hiA = last ? surfAmp : amp * (flat ? 0.15 : 0.8);
    const low = curveFn(g, t0, seedOf(b.i + 1), lowA);
    const hi = last ? surf : curveFn(g, t1, seedOf(b.i + 2), hiA);

    ctx.beginPath();
    trace(ctx, hi, xL, xR, true);
    if (k === 0) {
      ctx.lineTo(xR, g.bottom + 40);
      ctx.lineTo(xL, g.bottom + 40);
    } else {
      trace(ctx, low, xR, xL, false);
    }
    ctx.closePath();

    const grad = ctx.createLinearGradient(0, y0 - 2, 0, y1 + 2);
    if (b.type === 'drift') {
      grad.addColorStop(0, PAL.driftDeep);
      grad.addColorStop(0.45, PAL.drift);
      grad.addColorStop(1, mix(PAL.drift, PAL.driftEdge, 0.22));
    } else {
      grad.addColorStop(0, PAL.focusDeep);
      grad.addColorStop(0.55, mix(PAL.focusDeep, PAL.focus, 0.72));
      grad.addColorStop(1, PAL.focus);
    }
    ctx.fillStyle = grad;
    ctx.fill();

    if (b.type === 'focus' && k > 0) {
      const span = Math.max(1, b.e - b.s);
      const hz = Math.min(1, hazeMs / span);
      const yh = y0 + (y1 - y0) * hz;
      const hg = ctx.createLinearGradient(0, y0, 0, yh);
      hg.addColorStop(0, rgba(PAL.drift, 0.82));
      hg.addColorStop(0.35, rgba(PAL.drift, 0.4));
      hg.addColorStop(1, rgba(PAL.drift, 0));
      ctx.fillStyle = hg;
      ctx.fill();
    }

    ctx.save();
    ctx.beginPath();
    trace(ctx, low, xL, xR, true);
    ctx.lineWidth = 1;
    ctx.strokeStyle =
      b.type === 'drift' ? rgba(PAL.driftEdge, 0.5) : rgba(PAL.ink, 0.42);
    ctx.stroke();
    ctx.restore();
  });

  const gt = grain();
  const pat = ctx.createPattern(gt, 'repeat');
  ctx.globalAlpha = grainAlpha;
  ctx.globalCompositeOperation = 'overlay';
  ctx.fillStyle = pat;
  ctx.fillRect(xL, yAt(g, topT) - 30, xR - xL, g.bottom - yAt(g, topT) + 70);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;

  if (!flat) {
    const side = ctx.createLinearGradient(g.cx - g.R, 0, g.cx + g.R, 0);
    side.addColorStop(0, 'rgba(0,0,0,0.5)');
    side.addColorStop(0.26, 'rgba(0,0,0,0.05)');
    side.addColorStop(0.5, 'rgba(255,255,255,0.05)');
    side.addColorStop(0.76, 'rgba(0,0,0,0.08)');
    side.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = side;
    ctx.fillRect(g.cx - g.R, g.top, g.R * 2, g.h + 40);
  }

  const deep = ctx.createLinearGradient(0, g.bottom, 0, g.bottom - g.h * 0.55);
  deep.addColorStop(0, 'rgba(0,0,0,0.42)');
  deep.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = deep;
  ctx.fillRect(xL, g.bottom - g.h * 0.55, xR - xL, g.h * 0.55 + 40);

  ctx.restore();

  const activeType = bands.length ? bands[bands.length - 1].type : 'focus';
  ctx.save();
  vesselPath(ctx, g, 1.2);
  ctx.clip();
  ctx.beginPath();
  trace(ctx, surf, g.cx - wAt(g, topT) * g.R, g.cx + wAt(g, topT) * g.R, true);
  ctx.lineWidth = 1.1;
  ctx.strokeStyle =
    activeType === 'drift'
      ? rgba(PAL.driftEdge, live ? 0.75 : 0.4)
      : rgba(PAL.focus, live ? 0.6 : 0.3);
  ctx.stroke();
  ctx.restore();
}

export function layerAtY(g, layers, capacityMs, shownMs, y) {
  const t = clamp((g.bottom - y) / g.h, 0, 1);
  const i = Math.floor(t * (g.cum.length - 1));
  const at = (g.cum[i] / g.total) * capacityMs;
  if (at > shownMs) return null;
  for (const l of layers) {
    const e = l.end ?? shownMs;
    if (at >= l.start && at <= e) return l;
  }
  return null;
}
