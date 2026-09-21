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
