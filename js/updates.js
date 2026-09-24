import { native } from './native.js';

const LATEST = 'https://api.github.com/repos/renat2006/sloi_vnimaniya/releases/latest';
const KEY = 'sloi.update.v1';
const RECHECK = 6 * 3600 * 1000;
const SNOOZE = 24 * 3600 * 1000;
const $ = (s) => document.querySelector(s);

const parse = (v) => String(v).replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
export const isNewer = (a, b) => {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

const read = () => {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
};
const write = (patch) => {
  try { localStorage.setItem(KEY, JSON.stringify({ ...read(), ...patch })); } catch {}
};

function highlights(body) {
  const src = String(body || '');
  const at = src.search(/^#{2,3}\s*Что изменилось\s*$/m);
  const part = at >= 0 ? src.slice(at) : src;
  return part.split('\n').map((l) => l.trim()).filter((l) => /^[-*]\s+/.test(l)).slice(0, 3).map((l) => l.replace(/^[-*]\s+/, '').replace(/\*\*/g, ''));
}

export function initUpdates({ toast, busy }) {
  if (!native.isNative) return;
  const card = $('#update');
  if (!card) return;
  let info = null, release = null, running = false;

  const setProgress = (pct) => {
    $('#update-bar-wrap').hidden = false;
    $('#update-bar').style.width = `${pct}%`;
  };
  native.onUpdateProgress((pct) => setProgress(pct));

  function show(r) {
    $('#update-v').textContent = r.version;
    const list = $('#update-n');
    list.innerHTML = '';
    highlights(r.body).forEach((t) => {
      const li = document.createElement('li');
      li.textContent = t;
      list.appendChild(li);
    });
    card.hidden = false;
  }

  async function check(manual = false) {
    if (running) return;
    info = info || (await native.appInfo());
    if (!info || !info.versionName) return;
    const btn = $('#check-update');
    if (btn) btn.textContent = `Версия ${info.versionName} · проверить обновления`;
    write({ checkedAt: Date.now() });
    let data;
    try {
      const res = await fetch(LATEST, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error(String(res.status));
      data = await res.json();
    } catch {
      if (manual) toast('Не удалось проверить обновления. Нет связи с GitHub.', 4000);
      return;
    }
    const version = String(data.tag_name || '').replace(/^v/, '');
    if (!version || !isNewer(version, info.versionName)) {
      if (manual) toast('У вас последняя версия.');
      return;
    }
    const assets = data.assets || [];
    const apk = assets.find((a) => /\.apk$/i.test(a.name));
    const sums = assets.find((a) => /SHA256SUMS/i.test(a.name));
    if (!apk || !sums) return;
    release = { version, body: data.body, apk: apk.browser_download_url, sums: sums.browser_download_url };
    const st = read();
    const snoozed = st.dismissed === version && Date.now() - (st.dismissedAt || 0) < SNOOZE;
    if (!manual && (snoozed || (busy && busy()))) return;
    show(release);
  }

  $('#update-later').addEventListener('click', () => {
    if (release) write({ dismissed: release.version, dismissedAt: Date.now() });
    card.hidden = true;
  });

  $('#update-go').addEventListener('click', async () => {
    if (!release || running) return;
    const go = $('#update-go');
    running = true;
    go.disabled = true;
    go.textContent = 'Загружаю…';
    setProgress(0);
    const r = await native.installUpdate(release.apk, release.sums);
    running = false;
    go.disabled = false;
    go.textContent = 'Обновить';
    $('#update-bar-wrap').hidden = true;
    if (!r) toast('Обновление недоступно в этой версии приложения.', 5000);
    else if (r.needsPermission) toast('Разрешите установку из этого приложения и нажмите «Обновить» ещё раз.', 6000);
    else if (r.error) toast(`Не удалось обновить: ${r.error}`, 6000);
    else if (r.started) {
      go.textContent = 'Подтвердите установку';
      go.disabled = true;
      setTimeout(() => { go.textContent = 'Обновить'; go.disabled = false; }, 20000);
    }
  });

  const manualBtn = $('#check-update');
  if (manualBtn) {
    manualBtn.style.display = '';
    manualBtn.addEventListener('click', () => check(true));
  }

  setTimeout(() => check(false), 6000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - (read().checkedAt || 0) > RECHECK) check(false);
  });
}
