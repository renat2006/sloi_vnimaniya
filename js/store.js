const KEY = 'sloi.archive.v2';

export function list() {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function write(arr) {
  try {
    localStorage.setItem(KEY, JSON.stringify(arr.slice(-120)));
  } catch {}
}

export function save(core) {
  const arr = list();
  arr.push(core);
  write(arr);
  return core;
}

export function remove(id) {
  write(list().filter((c) => c.id !== id));
}

export function clearAll() {
  write([]);
}

export function nextIndex() {
  return list().length + 1;
}

export function seedDemo() {
  const now = Date.now();
  const day = 86400000;
  const makes = [
    { cap: 25, at: now - day * 4 + 36e5 * 10, breaks: [[0.18, 0.02], [0.44, 0.05], [0.62, 0.015], [0.81, 0.07]] },
    { cap: 50, at: now - day * 3 + 36e5 * 9, breaks: [[0.51, 0.04]] },
    { cap: 25, at: now - day * 2 + 36e5 * 16, breaks: [[0.07, 0.03], [0.13, 0.02], [0.21, 0.04], [0.33, 0.02], [0.41, 0.06], [0.55, 0.03], [0.68, 0.05], [0.79, 0.02], [0.88, 0.04]] },
    { cap: 15, at: now - day + 36e5 * 11, breaks: [] },
    { cap: 50, at: now - day + 36e5 * 20, breaks: [[0.29, 0.03], [0.66, 0.09]] }
  ];
  const out = [];
  makes.forEach((m, i) => {
    const capacityMs = m.cap * 60000;
    const layers = [];
    let cursor = 0;
    m.breaks.forEach(([p, w]) => {
      const s = p * capacityMs;
      const e = Math.min(capacityMs, s + w * capacityMs);
      if (s > cursor) layers.push({ type: 'focus', start: cursor, end: s });
      layers.push({ type: 'drift', start: s, end: e });
      cursor = e;
    });
    if (cursor < capacityMs) layers.push({ type: 'focus', start: cursor, end: capacityMs });
    out.push({
      id: `demo-${i}`,
      demo: true,
      startedAt: m.at,
      capacityMs,
      durationMs: capacityMs,
      layers
    });
  });
  const arr = list().filter((c) => !c.demo);
  write([...out, ...arr].sort((a, b) => a.startedAt - b.startedAt));
}
