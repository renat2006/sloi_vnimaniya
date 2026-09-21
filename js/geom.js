export const N = 288;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

export function flaskW(t) {
  if (t <= 0) return 0.02;
  if (t < 0.085) {
    const k = t / 0.085;
    return Math.sqrt(1 - (1 - k) * (1 - k)) * 0.975 + 0.025;
  }
  if (t < 0.70) return 1;
  if (t < 0.90) return 1 - (1 - 0.17) * smooth(0.70, 0.90, t);
  return 0.17 * (1 + 0.26 * smooth(0.90, 1, t) ** 2);
}

const CORE_W = 0.3;

export function buildGeom({ cx, top, bottom, R, morph = 0 }) {
  const w = new Float64Array(N + 1);
  const cum = new Float64Array(N + 1);
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    w[i] = flaskW(t) * (1 - morph) + CORE_W * morph;
  }
  let acc = 0;
  for (let i = 1; i <= N; i++) {
    acc += ((w[i] + w[i - 1]) * 0.5) / N;
    cum[i] = acc;
  }
  return { cx, top, bottom, R, h: bottom - top, morph, w, cum, total: acc || 1 };
}

export function wAt(g, t) {
  const x = clamp(t, 0, 1) * N;
  const i = Math.floor(x);
  if (i >= N) return g.w[N];
  return g.w[i] + (g.w[i + 1] - g.w[i]) * (x - i);
}

export const yAt = (g, t) => g.bottom - clamp(t, 0, 1) * g.h;

export function tAtVol(g, v) {
  const target = clamp(v, 0, 1) * g.total;
  let lo = 0;
  let hi = N;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (g.cum[m] < target) lo = m + 1;
    else hi = m;
  }
  if (lo === 0) return 0;
  const a = g.cum[lo - 1];
  const b = g.cum[lo];
  return (lo - 1 + (b > a ? (target - a) / (b - a) : 0)) / N;
}

export function volAtT(g, t) {
  const x = clamp(t, 0, 1) * N;
  const i = Math.floor(x);
  const a = g.cum[i];
  const b = g.cum[Math.min(N, i + 1)];
  return (a + (b - a) * (x - i)) / g.total;
}

export function vesselPath(ctx, g, inset = 0) {
  ctx.beginPath();
  for (let i = 0; i <= N; i++) {
    const x = g.cx - Math.max(0.5, g.w[i] * g.R - inset);
    const y = yAt(g, i / N);
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  }
  for (let i = N; i >= 0; i--) {
    ctx.lineTo(g.cx + Math.max(0.5, g.w[i] * g.R - inset), yAt(g, i / N));
  }
  ctx.closePath();
}
