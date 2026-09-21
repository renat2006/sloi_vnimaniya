import { clamp, wAt, yAt, tAtVol, vesselPath } from './geom.js';

export const PAL = {
  focusLite: '#F6EACB',
  focus: '#E3D2A6',
  focusDeep: '#9C8047',
  stone: '#A9A88A',
  stoneDeep: '#5E5C46',
  drift: '#3A4552',
  driftLite: '#55677A',
  driftDeep: '#171C23',
  driftEdge: '#93C8D8',
  bone: '#E8E2D6',
  ink: '#08090B'
};

const toRGB = (c) => {
  if (c[0] === '#')
    return [
      parseInt(c.slice(1, 3), 16),
      parseInt(c.slice(3, 5), 16),
      parseInt(c.slice(5, 7), 16)
    ];
  const m = c.match(/-?\d+\.?\d*/g) || [0, 0, 0];
  return [+m[0], +m[1], +m[2]];
};

export function mix(a, b, t, alpha = 1) {
  const A = toRGB(a);
  const B = toRGB(b);
  const c = A.map((v, i) => Math.round(v + (B[i] - v) * clamp(t, 0, 1)));
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}

export function rgba(h, a) {
  const c = toRGB(h);
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

let fineTile = null;
let grainTile = null;

function fine() {
  if (fineTile) return fineTile;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  const img = x.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) {
    const s = Math.random() < 0.5 ? 0 : 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = s;
    img.data[i + 3] = Math.random() < 0.4 ? 255 * (0.2 + Math.random() * 0.6) : 0;
  }
  x.putImageData(img, 0, 0);
  fineTile = c;
  return c;
}

function grains() {
  if (grainTile) return grainTile;
  const S = 190;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d');
  for (let i = 0; i < 1500; i++) {
    const px = Math.random() * S;
    const py = Math.random() * S;
    const r = 0.45 + Math.random() * 1.15;
    const dark = Math.random() < 0.52;
    x.fillStyle = dark
      ? `rgba(0,0,0,${0.1 + Math.random() * 0.3})`
      : `rgba(255,255,255,${0.1 + Math.random() * 0.38})`;
    x.beginPath();
    x.ellipse(px, py, r, r * (0.7 + Math.random() * 0.6), Math.random() * 3, 0, 6.284);
    x.fill();
  }
  grainTile = c;
  return c;
}

function pattern(ctx, tile, key) {
  if (!ctx[key]) ctx[key] = ctx.createPattern(tile, 'repeat');
  return ctx[key];
}

const seedOf = (n) => Math.abs((Math.sin(n * 127.1) * 43758.5453) % 1);

function curveFn(g, t, seed, amp, fine) {
  const y0 = yAt(g, t);
  const wpx = Math.max(8, wAt(g, t) * g.R);
  return (x) => {
    const d = clamp((x - g.cx) / wpx, -1, 1);
    const cone = -amp * Math.pow(1 - d * d, 1.3);
    let n = Math.sin(d * 6.1 + seed * 9) * 0.8 + Math.sin(d * 2.7 - seed * 14) * 1.25;
    if (fine) n += Math.sin(d * 19.3 + seed * 5) * 0.42 + Math.sin(d * 33.7 - seed) * 0.22;
    return y0 + cone + n * amp * 0.28;
  };
}

function trace(ctx, fy, x0, x1, move) {
  const steps = 44;
  for (let i = 0; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps;
    const y = fy(x);
    if (i === 0 && move) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
}

function tintOf(type, seed) {
  const k = seedOf(seed + 3);
  if (type === 'permitted') {
    return {
      deep: mix('#3F3E2C', PAL.stoneDeep, 0.25 + k * 0.5),
      mid: mix(PAL.stoneDeep, PAL.stone, 0.55 + k * 0.3),
      lite: mix(PAL.stone, '#D6D4BA', 0.14 + k * 0.3)
    };
  }
  if (type === 'drift') {
    return {
      deep: mix(PAL.driftDeep, PAL.drift, k * 0.22),
      mid: mix(PAL.driftDeep, PAL.drift, 0.55 + k * 0.3),
      lite: mix(PAL.drift, PAL.driftLite, 0.3 + k * 0.3)
    };
  }
  return {
    deep: mix('#574728', PAL.focusDeep, 0.2 + k * 0.55),
    mid: mix(PAL.focusDeep, PAL.focus, 0.58 + k * 0.32),
    lite: mix(PAL.focus, PAL.focusLite, 0.1 + k * 0.34)
  };
}

export function drawStack(ctx, g, layers, opts = {}) {
  const {
    capacityMs = 1,
    shownMs = 0,
    hazeMs = 70000,
    amp = Math.min(10, g.R * 0.05),
    grainAlpha = 1,
    live = false
  } = opts;

  if (shownMs <= 0) return;

  const xL = g.cx - g.R * 1.14;
  const xR = g.cx + g.R * 1.14;
  const topT = tAtVol(g, shownMs / capacityMs);
  const flat = g.morph > 0.85;
  const surfAmp = flat ? amp * 0.16 : amp;
  const surf = curveFn(g, topT, 0.37, surfAmp, !flat);
  const surfY = yAt(g, topT);

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
    const lowA = k === 0 ? amp * 0.2 : amp * (flat ? 0.16 : 0.78);
    const hiA = last ? surfAmp : amp * (flat ? 0.16 : 0.78);
    const low = curveFn(g, t0, seedOf(b.i + 1), lowA, false);
    const hi = last ? surf : curveFn(g, t1, seedOf(b.i + 2), hiA, false);
    const c = tintOf(b.type, b.i);

    ctx.beginPath();
    trace(ctx, hi, xL, xR, true);
    if (k === 0) {
      ctx.lineTo(xR, g.bottom + 40);
      ctx.lineTo(xL, g.bottom + 40);
    } else {
      trace(ctx, low, xR, xL, false);
    }
    ctx.closePath();

    const q = 0.4 + seedOf(b.i + 7) * 0.32;
    const grad = ctx.createLinearGradient(0, y0 - 1, 0, y1 + 1);
    grad.addColorStop(0, c.deep);
    grad.addColorStop(Math.min(0.2, q * 0.4), mix(c.deep, c.mid, 0.6));
    grad.addColorStop(q, c.mid);
    grad.addColorStop(Math.min(0.94, q + 0.3), c.lite);
    grad.addColorStop(1, mix(c.mid, c.deep, 0.42));
    ctx.fillStyle = grad;
    ctx.fill();

    const prev = k > 0 ? bands[k - 1].type : null;
    const weight = prev === 'drift' ? 1 : prev === 'permitted' ? 0.45 : 0;
    if (b.type !== 'drift' && weight > 0) {
      const span = Math.max(1, b.e - b.s);
      const hz = Math.min(1, (hazeMs * weight) / span);
      const yh = y0 + (y1 - y0) * hz;
      const haze = mix(PAL.drift, PAL.ink, 0.28);
      const hg = ctx.createLinearGradient(0, y0, 0, yh);
      hg.addColorStop(0, rgba(haze, 0.72 * weight));
      hg.addColorStop(0.32, rgba(haze, 0.34 * weight));
      hg.addColorStop(1, rgba(haze, 0));
      ctx.fillStyle = hg;
      ctx.fill();
    }

    if (k > 0) {
      ctx.save();
      ctx.beginPath();
      trace(ctx, low, xL, xR, true);
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = rgba(PAL.ink, 0.3);
      ctx.stroke();
      ctx.translate(0, -1.4);
      ctx.beginPath();
      trace(ctx, low, xL, xR, true);
      ctx.lineWidth = 1;
      ctx.strokeStyle =
        b.type === 'drift'
          ? rgba(PAL.driftEdge, 0.3)
          : b.type === 'permitted'
            ? rgba('#D6D4BA', 0.24)
            : rgba(PAL.focusLite, 0.26);
      ctx.stroke();
      ctx.restore();
    }
  });

  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = 0.5 * grainAlpha;
  ctx.fillStyle = pattern(ctx, grains(), '_pGrain');
  ctx.fillRect(xL, surfY - 30, xR - xL, g.bottom - surfY + 74);
  ctx.globalAlpha = 0.14 * grainAlpha;
  ctx.fillStyle = pattern(ctx, fine(), '_pFine');
  ctx.fillRect(xL, surfY - 30, xR - xL, g.bottom - surfY + 74);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;

  if (!flat) {
    const side = ctx.createLinearGradient(g.cx - g.R, 0, g.cx + g.R, 0);
    side.addColorStop(0, 'rgba(0,0,0,0.82)');
    side.addColorStop(0.045, 'rgba(0,0,0,0.5)');
    side.addColorStop(0.17, 'rgba(0,0,0,0.16)');
    side.addColorStop(0.38, 'rgba(255,255,255,0.045)');
    side.addColorStop(0.56, 'rgba(255,255,255,0.075)');
    side.addColorStop(0.8, 'rgba(0,0,0,0.14)');
    side.addColorStop(0.95, 'rgba(0,0,0,0.5)');
    side.addColorStop(1, 'rgba(0,0,0,0.85)');
    ctx.fillStyle = side;
    ctx.fillRect(g.cx - g.R, g.top, g.R * 2, g.h + 40);
  }

  const deep = ctx.createLinearGradient(0, g.bottom, 0, g.bottom - g.h * 0.6);
  deep.addColorStop(0, 'rgba(0,0,0,0.44)');
  deep.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = deep;
  ctx.fillRect(xL, g.bottom - g.h * 0.6, xR - xL, g.h * 0.6 + 40);

  const activeType = bands.length ? bands[bands.length - 1].type : 'focus';
  const sun = ctx.createLinearGradient(0, surfY - 2, 0, surfY + Math.min(46, g.h * 0.09));
  const sunC =
    activeType === 'drift' ? PAL.driftEdge : activeType === 'permitted' ? PAL.stone : PAL.focusLite;
  sun.addColorStop(0, rgba(sunC, 0.17));
  sun.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = sun;
  ctx.fillRect(xL, surfY - 2, xR - xL, Math.min(48, g.h * 0.09));

  ctx.restore();

  ctx.save();
  vesselPath(ctx, g, 1.2);
  ctx.clip();
  const edgeW = wAt(g, topT) * g.R;
  ctx.beginPath();
  trace(ctx, surf, g.cx - edgeW, g.cx + edgeW, true);
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = rgba(sunC, live ? 0.75 : 0.42);
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
