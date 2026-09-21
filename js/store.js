const KEY = 'sloi.archive.v3';
const CFG = 'sloi.config.v1';
const GUEST = 'sloi.guests.v1';
const LIVE = 'sloi.live.v1';

const read = (k, fallback) => {
  try {
    const raw = localStorage.getItem(k);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};
const write = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
};

const NAMES = ['Наблюдатель', 'Смотритель', 'Свидетель', 'Собиратель', 'Хранитель'];

export function config() {
  const c = read(CFG, null);
  if (c && c.name) return c;
  const fresh = {
    name: `${NAMES[Math.floor(Math.random() * NAMES.length)]} ${Math.floor(Math.random() * 89 + 10)}`,
    circle: ['Редактор кода', 'Справочник', 'Заметки'],
    room: 'зал',
    sound: false,
    bestMs: 0
  };
  write(CFG, fresh);
  return fresh;
}

export function setConfig(patch) {
  const next = { ...config(), ...patch };
  write(CFG, next);
  return next;
}

export function list() {
  const arr = read(KEY, []);
  return Array.isArray(arr) ? arr : [];
}

export function save(core) {
  const arr = list();
  arr.push(core);
  write(KEY, arr.slice(-160));
  const c = config();
  if (core.metrics && core.metrics.longest > (c.bestMs || 0)) setConfig({ bestMs: core.metrics.longest });
  return core;
}

export function remove(id) {
  write(KEY, list().filter((c) => c.id !== id));
}

export function clearAll() {
  write(KEY, []);
}

export function saveLive(session, elapsedMs) {
  write(LIVE, {
    capacityMs: session.capacityMs,
    task: session.task,
    startedAt: session.startedAt,
    witnessed: session.witnessed,
    layers: session.layers,
    elapsedMs,
    savedAt: Date.now()
  });
}

export function loadLive() {
  const v = read(LIVE, null);
  if (!v || !Array.isArray(v.layers) || !v.layers.length) return null;
  return v;
}

export function dropLive() {
  try {
    localStorage.removeItem(LIVE);
  } catch {}
}

export function guests() {
  const arr = read(GUEST, []);
  return Array.isArray(arr) ? arr : [];
}

export function addGuest(core) {
  const arr = guests().filter((c) => c.id !== core.id);
  arr.push(core);
  write(GUEST, arr.slice(-60));
  return core;
}

export function dropGuest(id) {
  write(GUEST, guests().filter((c) => c.id !== id));
}

const T = { focus: 0, permitted: 1, drift: 2 };
const TR = ['focus', 'permitted', 'drift'];

export function encode(core, author) {
  const body = [
    Math.round(core.capacityMs / 1000),
    Math.round(core.durationMs / 1000),
    Math.round(core.startedAt / 1000),
    (author || '').replace(/[|~]/g, ' '),
    (core.task || '').replace(/[|~]/g, ' '),
    core.witnessed ? 1 : 0,
    core.layers
      .map((l) => `${T[l.type]}.${Math.round((l.end - l.start) / 1000)}`)
      .join('!')
  ].join('~');
  return btoa(unescape(encodeURIComponent('s1~' + body)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function decode(text) {
  try {
    const raw = text.trim().replace(/-/g, '+').replace(/_/g, '/');
    const s = decodeURIComponent(escape(atob(raw)));
    const p = s.split('~');
    if (p[0] !== 's1') return null;
    const capacityMs = +p[1] * 1000;
    const durationMs = +p[2] * 1000;
    const startedAt = +p[3] * 1000;
    const author = p[4] || 'Гость';
    const task = p[5] || '';
    const witnessed = p[6] === '1';
    let cursor = 0;
    const layers = p[7]
      .split('!')
      .filter(Boolean)
      .map((chunk) => {
        const [t, d] = chunk.split('.');
        const start = cursor;
        cursor += +d * 1000;
        return { type: TR[+t] || 'focus', start, end: cursor };
      });
    if (!layers.length) return null;
    return {
      id: 'g' + startedAt.toString(36) + layers.length,
      author,
      guest: true,
      task,
      witnessed,
      startedAt,
      capacityMs,
      durationMs: durationMs || cursor,
      layers
    };
  } catch {
    return null;
  }
}
