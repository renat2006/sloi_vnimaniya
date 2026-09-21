export const MERGE_MS = 350;
export const HAZE_MS = 70000;

export function fmt(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
}

export function fmtShort(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин`;
  return `${Math.floor(m / 60)} ч ${String(m % 60).padStart(2, '0')}`;
}

export function createSession(capacityMs) {
  return {
    capacityMs,
    startedAt: Date.now(),
    t0: performance.now(),
    layers: [{ type: 'focus', start: 0, end: null }],
    ended: false,
    endMs: 0
  };
}

export const elapsed = (s) => (s.ended ? s.endMs : performance.now() - s.t0);

export function switchState(s, type, at) {
  const cur = s.layers[s.layers.length - 1];
  if (cur.type === type) return false;
  cur.end = at;
  if (at - cur.start < MERGE_MS && s.layers.length > 1) {
    s.layers.pop();
    const prev = s.layers[s.layers.length - 1];
    if (prev.type === type) {
      prev.end = null;
      return true;
    }
    prev.end = at;
  }
  s.layers.push({ type, start: at, end: null });
  return true;
}

export function sealed(s) {
  const e = elapsed(s);
  return s.layers
    .map((l) => ({ type: l.type, start: l.start, end: Math.min(l.end ?? e, e) }))
    .filter((l) => l.end > l.start);
}

export function metricsOf(layers, totalMs) {
  const focus = layers.filter((l) => l.type === 'focus').map((l) => l.end - l.start);
  const driftArr = layers.filter((l) => l.type === 'drift').map((l) => l.end - l.start);
  const focusMs = focus.reduce((a, b) => a + b, 0);
  const driftMs = driftArr.reduce((a, b) => a + b, 0);
  const sum = focusMs || 1;
  const hhi = focus.reduce((a, b) => a + (b / sum) ** 2, 0);
  const residue = layers
    .filter((l, i) => l.type === 'focus' && i > 0)
    .reduce((a, l) => a + Math.min(HAZE_MS, l.end - l.start), 0);
  return {
    totalMs,
    focusMs,
    driftMs,
    breaks: driftArr.length,
    strata: layers.length,
    longest: focus.length ? Math.max(...focus) : 0,
    depth: totalMs ? focusMs / totalMs : 0,
    fragmentation: focus.length ? 1 - hhi : 0,
    residueMs: residue
  };
}
