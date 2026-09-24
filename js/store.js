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

let writeErrorHandler = null;
let writeErrorNotified = false;

export function setWriteErrorHandler(fn) {
  writeErrorHandler = fn;
}

const write = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
    return true;
  } catch (err) {
    if (!writeErrorNotified) {
      writeErrorNotified = true;
      if (typeof writeErrorHandler === 'function') {
        try { writeErrorHandler(err); } catch {}
      }
    }
    return false;
  }
};

const NAMES = ['Наблюдатель', 'Смотритель', 'Свидетель', 'Собиратель', 'Хранитель'];

export function config() {
  const c = read(CFG, null);
  if (c && c.name) {
    return { notify: false, ...c };
  }
  const fresh = {
    name: `${NAMES[Math.floor(Math.random() * NAMES.length)]} ${Math.floor(Math.random() * 89 + 10)}`,
    circle: ['Редактор кода', 'Справочник', 'Заметки'],
    room: 'зал',
    sound: false,
    soundKind: 'flow',
    notify: false,
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

export function saveLive(session, elapsedMs, owner) {
  if (!session || session.ended) return false;
  const existing = read(LIVE, null);
  if (existing && existing.owner && owner && existing.owner !== owner) {
    const age = Date.now() - (existing.savedAt || 0);
    if (age < 6000) {
      return false;
    }
  }
  return write(LIVE, {
    owner: owner || null,
    capacityMs: session.capacityMs,
    task: session.task,
    startedAt: session.startedAt,
    witnessed: session.witnessed,
    layers: session.layers,
    notes: session.notes || [],
    elapsedMs,
    savedAt: Date.now()
  });
}

export function loadLive() {
  const v = read(LIVE, null);
  if (!v || !Array.isArray(v.layers) || !v.layers.length) return null;
  return v;
}

export function dropLive(owner) {
  try {
    if (owner) {
      const existing = read(LIVE, null);
      if (existing && existing.owner && existing.owner !== owner) {
        return;
      }
    }
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

function sanitizeStr(str, maxLen) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/[<>\x00-\x1F\x7F-\x9F]/g, '')
    .trim()
    .slice(0, maxLen);
}

export function decode(text) {
  try {
    if (!text || typeof text !== 'string') return null;
    const raw = text.trim().replace(/-/g, '+').replace(/_/g, '/');
    const s = decodeURIComponent(escape(atob(raw)));
    const p = s.split('~');
    if (p[0] !== 's1' || p.length < 8) return null;

    const capSec = +p[1];
    const durSec = +p[2];
    const startSec = +p[3];

    if (!Number.isFinite(capSec) || !Number.isFinite(durSec) || !Number.isFinite(startSec)) return null;

    const capacityMs = capSec * 1000;
    const durationMs = durSec * 1000;
    const startedAt = startSec * 1000;

    const MAX_24H_MS = 24 * 3600 * 1000;
    if (capacityMs <= 0 || capacityMs > MAX_24H_MS) return null;
    if (durationMs < 0 || durationMs > MAX_24H_MS) return null;
    if (startedAt <= 0) return null;

    const author = sanitizeStr(p[4] || 'Гость', 24) || 'Гость';
    const task = sanitizeStr(p[5] || '', 80);
    const witnessed = p[6] === '1';

    const rawLayers = p[7].split('!').filter(Boolean);
    if (!rawLayers.length || rawLayers.length > 500) return null;

    let cursor = 0;
    const layers = [];
    for (const chunk of rawLayers) {
      const parts = chunk.split('.');
      if (parts.length !== 2) return null;
      const t = +parts[0];
      const d = +parts[1];
      if (!Number.isFinite(t) || !Number.isFinite(d)) return null;
      if (t < 0 || t > 2 || d < 0) return null;
      const layerDurMs = d * 1000;
      if (cursor + layerDurMs > MAX_24H_MS) return null;
      const start = cursor;
      cursor += layerDurMs;
      layers.push({ type: TR[t] || 'focus', start, end: cursor });
    }

    if (!layers.length) return null;
    const effectiveDur = durationMs || cursor;
    if (effectiveDur > MAX_24H_MS) return null;

    return {
      id: 'g' + startedAt.toString(36) + layers.length,
      author,
      guest: true,
      task,
      witnessed,
      startedAt,
      capacityMs,
      durationMs: effectiveDur,
      layers
    };
  } catch {
    return null;
  }
}
