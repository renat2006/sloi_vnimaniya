export const MERGE_MS = 350;
export const HAZE_MS = 70000;
export const ASK_AFTER_MS = 8000;

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

export function createSession(capacityMs, task) {
  return {
    capacityMs,
    task: task || '',
    startedAt: Date.now(),
    t0: performance.now(),
    layers: [{ type: 'focus', start: 0, end: null }],
    witnessed: false,
    notes: [],
    ended: false,
    endMs: 0
  };
}

export const elapsed = (s) => (s.ended ? s.endMs : Math.max(0, Date.now() - s.startedAt));

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

export function lastClosedDrift(s) {
  for (let i = s.layers.length - 1; i >= 0; i--) {
    const l = s.layers[i];
    if (l.end == null) continue;
    if (l.type === 'drift') return l;
    if (l.type === 'permitted') return null;
  }
  return null;
}

export function sealed(s) {
  const e = elapsed(s);
  return s.layers
    .map((l) => (l.why
      ? { type: l.type, start: l.start, end: Math.min(l.end ?? e, e), why: l.why }
      : { type: l.type, start: l.start, end: Math.min(l.end ?? e, e) }))
    .filter((l) => l.end > l.start);
}

export function metricsOf(layers, totalMs) {
  const dur = (l) => l.end - l.start;
  const by = (t) => layers.filter((l) => l.type === t);
  const focusMs = by('focus').reduce((a, l) => a + dur(l), 0);
  const permittedMs = by('permitted').reduce((a, l) => a + dur(l), 0);
  const driftMs = by('drift').reduce((a, l) => a + dur(l), 0);

  const runs = [];
  let acc = 0;
  for (const l of layers) {
    if (l.type === 'drift') {
      if (acc > 0) runs.push(acc);
      acc = 0;
    } else acc += dur(l);
  }
  if (acc > 0) runs.push(acc);
  const F = runs.reduce((a, b) => a + b, 0) || 1;
  const hhi = runs.reduce((a, b) => a + (b / F) ** 2, 0);

  let residue = 0;
  layers.forEach((l, i) => {
    const prev = layers[i - 1];
    if (!prev || l.type === 'drift') return;
    if (prev.type === 'drift') residue += Math.min(HAZE_MS, dur(l));
    else if (prev.type === 'permitted') residue += Math.min(HAZE_MS, dur(l)) * 0.45;
  });

  return {
    totalMs,
    focusMs,
    permittedMs,
    driftMs,
    breaks: by('drift').length,
    transitions: by('permitted').length,
    strata: layers.length,
    longest: runs.length ? Math.max(...runs) : 0,
    depth: totalMs ? focusMs / totalMs : 0,
    work: totalMs ? (focusMs + permittedMs) / totalMs : 0,
    fragmentation: runs.length ? 1 - hhi : 0,
    residueMs: residue
  };
}

export function currentRunMs(layers, nowMs) {
  let acc = 0;
  for (const l of layers) {
    const end = l.end ?? nowMs;
    if (l.type === 'drift') acc = 0;
    else acc += end - l.start;
  }
  return acc;
}
