import { Stage } from './stage.js';
import { Ambience } from './audio.js';
import { Presence } from './net.js';
import {
  createSession, elapsed, switchState, lastClosedDrift, sealed, metricsOf,
  currentRunMs, fmt, fmtShort, ASK_AFTER_MS
} from './session.js';
import * as store from './store.js';
import * as archive from './archive.js';

const $ = (s) => document.querySelector(s);
const body = document.body;
const ME = 'm' + Math.random().toString(36).slice(2, 9);

const amb = new Ambience();
let cfg = store.config();
let session = null;
let focused = true;
let capacityMin = 25;
let lastCore = null;
let lastIndex = 0;
let arcMode = 'cores';
let hudAt = 0;
let peers = [];
let wantWitness = false;
let pendingDrift = null;
let savedAt = 0;
let wakeLock = null;
let wantAwake = true;
let warnedAwake = false;
let hintTimer = null;

let tapped = false;
addEventListener('pointerdown', () => {
  tapped = true;
}, { once: true, passive: true });

const buzz = (pattern) => {
  if (!tapped || !navigator.vibrate) return;
  try {
    navigator.vibrate(pattern);
  } catch {}
};

async function holdScreen(on) {
  wantAwake = on;
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
        $('#awake-badge').classList.remove('is-on');
      });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null;
  }
  const live = !!session && !session.ended;
  $('#awake-badge').classList.toggle('is-on', !!wakeLock && live);
  if (on && !wakeLock && live && !warnedAwake) {
    warnedAwake = true;
    toast('экран удержать не вышло — его сон станет разрывом', 5000);
  }
}

const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);

const FEED_TXT = {
  join: 'вошёл в зал',
  leave: 'вышел',
  rupture: 'разрыв',
  resume: 'вернулся',
  core: 'извлёк керн'
};

const presence = new Presence({
  onPeers: (list) => {
    peers = list;
    renderWall();
    updateBadge();
    updateLiveDot();
  },
  onFeed: (list, ev) => {
    renderFeed(list);
    if (ev && ev.kind === 'core') renderShared();
  },
  onStatus: (s) => {
    const el = $('#net-state');
    const txt = {
      live: 'живой зал · на связи',
      connecting: 'переподключение…',
      offline: presence.live ? 'зал доступен · вы не вошли' : 'локальный режим · сервер не запущен'
    };
    el.textContent = txt[s] || s;
    el.classList.toggle('is-live', s === 'live');
    $('#join').textContent = presence.joined ? 'Выйти' : 'Войти';
    updateLiveDot();
  }
});

const stage = new Stage($('#vessel'), {
  onTick: hud,
  onFull: () => finish(true),
  onHover: showTip,
  onLand: (cold) => amb.landing(cold)
});

function syncNav() {
  const v = body.dataset.view;
  document.querySelectorAll('.nav [data-go]').forEach((b) =>
    b.classList.toggle('is-on', b.dataset.go === v || (v === 'method' && b.dataset.go === 'intro'))
  );
}

function go(view) {
  if (view === body.dataset.view) return;
  body.dataset.view = view;
  syncNav();
  if (view === 'archive') renderArchive();
  if (view === 'room') renderRoom();
  if (view === 'ritual') renderOath();
}

function toast(text, ms = 2800) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('is-on');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('is-on'), ms);
}

function renderCircle() {
  const box = $('#circle');
  box.innerHTML = '';
  if (!cfg.circle.length) {
    box.innerHTML = '<span class="side-note">Круг пуст — любой уход будет разрывом.</span>';
  }
  cfg.circle.forEach((name, i) => {
    const el = document.createElement('span');
    el.className = 'chip is-on';
    el.innerHTML = `<b>${esc(name)}</b><span title="убрать">×</span>`;
    el.querySelector('span').addEventListener('click', () => {
      cfg = store.setConfig({ circle: cfg.circle.filter((_, j) => j !== i) });
      renderCircle();
      renderOath();
    });
    box.appendChild(el);
  });
}

function addChip() {
  const inp = $('#chip-new');
  const v = inp.value.trim();
  if (!v || cfg.circle.includes(v) || cfg.circle.length >= 8) return;
  cfg = store.setConfig({ circle: [...cfg.circle, v] });
  inp.value = '';
  renderCircle();
  renderOath();
}

function renderOath() {
  const task = $('#task').value.trim() || 'начатое';
  const c = cfg.circle;
  $('#oath').textContent =
    `Если меня потянет отвлечься — я вернусь к: ${task}. ` +
    (c.length ? `Круг: ${c.join(', ')}. Всё вне круга — разрыв.` : 'Круг пуст: любой уход — разрыв.');
}

function begin() {
  const task = $('#task').value.trim();
  cfg = store.setConfig({ lastTask: task, lastMin: capacityMin });
  session = createSession(capacityMin * 60000, task);
  session.witnessed = wantWitness && presence.live;
  focused = true;
  body.dataset.phase = 'live';
  body.dataset.drift = '0';
  $('#cap-label').textContent = `колба ${capacityMin} мин`;
  $('.state-name').textContent = 'Фокус';
  $('#task-line').textContent = task ? `« ${task} »` : '';
  $('#rail-note').textContent = cfg.circle.length
    ? `Круг: ${cfg.circle.join(' · ')}`
    : 'Круг пуст — любой уход станет разрывом.';
  stage.setDrift(false);
  stage.attach(session);
  stage.targetMs = cfg.bestMs > 0 ? cfg.bestMs : null;
  sheet(false);
  amb.mode('focus');
  store.saveLive(session, 0);
  journal();
  updateBadge();
  if (session.witnessed) {
    presence.join(cfg.room, ME, { name: cfg.name, fill: 0, mode: 'focus', strata: 1 });
  }
  warnedAwake = false;
  holdScreen($('#awake').checked);
  buzz(14);
  amb.ping(396, 2, 0.08);
  clearTimeout(hintTimer);
  if (!cfg.taught) {
    hintTimer = setTimeout(() => {
      if (session && !session.ended) {
        toast('попробуйте уйти в другое приложение и вернуться — увидите, как ложится слой разрыва', 7000);
        cfg = store.setConfig({ taught: true });
      }
    }, 9000);
  }
  go('stage');
}

function setFocused(v) {
  if (!session || session.ended || v === focused) return;
  focused = v;
  const at = elapsed(session);
  switchState(session, v ? 'focus' : 'drift', at);
  stage.setDrift(!v);
  body.dataset.drift = v ? '0' : '1';
  $('.state-name').textContent = v ? 'Фокус' : 'Разрыв';
  amb.mode(v ? 'focus' : 'drift');
  presence.set({ mode: v ? 'focus' : 'drift' });
  if (v) {
    amb.ping();
    document.title = 'Слои внимания';
    const last = lastClosedDrift(session);
    if (last && last.end - last.start >= ASK_AFTER_MS) {
      pendingDrift = last;
      ask(last.end - last.start);
    }
    buzz(12);
  } else {
    amb.rupture();
    buzz([20, 70, 20]);
    document.title = '◦ разрыв растёт — слои внимания';
  }
  store.saveLive(session, at);
  journal();
}

function resume() {
  const v = store.loadLive();
  if (!v) return false;
  const gap = Math.max(0, Date.now() - v.savedAt);
  if (gap > 6 * 3600000) {
    store.dropLive();
    return false;
  }
  session = createSession(v.capacityMs, v.task);
  session.startedAt = v.startedAt;
  session.witnessed = !!v.witnessed;
  session.layers = v.layers;
  const open = session.layers[session.layers.length - 1];
  if (open.end == null) open.end = v.elapsedMs;
  session.layers.push({ type: 'drift', start: v.elapsedMs, end: null });
  const total = v.elapsedMs + gap;
  session.t0 = performance.now() - total;
  focused = false;

  capacityMin = Math.round(v.capacityMs / 60000);
  $('#cap-label').textContent = `колба ${capacityMin} мин`;
  $('#task-line').textContent = v.task ? `« ${v.task} »` : '';
  $('.state-name').textContent = 'Разрыв';
  body.dataset.phase = 'live';
  body.dataset.drift = '1';
  stage.setDrift(true);
  stage.attach(session);
  stage.targetMs = cfg.bestMs > 0 ? cfg.bestMs : null;
  journal();
  go('stage');

  if (total >= session.capacityMs) {
    finish(true);
    toast('колба заполнилась — керн извлечён');
    return true;
  }
  toast(`сеанс восстановлен · ${fmtShort(gap)} легло разрывом`);
  setTimeout(() => setFocused(!document.hidden && document.hasFocus()), 400);
  return true;
}

function ask(durMs) {
  $('#ask-dur').textContent = fmtShort(durMs);
  const box = $('#ask-chips');
  box.innerHTML = '';
  cfg.circle.forEach((name) => {
    const el = document.createElement('span');
    el.className = 'chip';
    el.innerHTML = `<b>${esc(name)}</b>`;
    el.addEventListener('click', () => answer(name));
    box.appendChild(el);
  });
  if (!cfg.circle.length) {
    box.innerHTML = '<span class="side-note">Круг пуст. Очертите его перед следующим сеансом.</span>';
  }
  $('#ask').classList.add('is-on');
}

function answer(name) {
  if (name && pendingDrift && pendingDrift.type === 'drift') {
    pendingDrift.type = 'permitted';
    amb.forgive();
    journal();
    store.saveLive(session, elapsed(session));
    toast(`слой стал каменным · ${name}`);
  }
  pendingDrift = null;
  $('#ask').classList.remove('is-on');
}

function journal() {
  if (!session) return;
  const list = sealed(session);
  const el = $('#journal');
  el.innerHTML = '';
  const label = { focus: 'Фокус', drift: 'Разрыв', permitted: 'Круг' };
  list
    .slice()
    .reverse()
    .forEach((l, i) => {
      const li = document.createElement('li');
      li.className = l.type;
      li.style.animationDelay = Math.min(i * 30, 240) + 'ms';
      li.innerHTML = `<b>${label[l.type]}</b><span>${fmt(l.start)} → ${fmt(l.end)}</span>`;
      el.appendChild(li);
    });
}

function hud(trueMs) {
  if (!session || session.ended) return;
  const now = performance.now();
  if (now - hudAt < 150) return;
  hudAt = now;
  const layers = sealed(session);
  const m = metricsOf(layers, trueMs);
  const run = currentRunMs(layers, trueMs);
  $('#ro-run').textContent = fmt(run);
  $('#ro-time').textContent = fmt(trueMs);
  $('#ro-depth').textContent = Math.round(m.depth * 100) + '%';
  $('#ro-breaks').textContent = m.breaks;
  $('#ro-frag').textContent = m.fragmentation.toFixed(2);
  amb.pour(Math.min(1.4, stage.rate * 1.1 + 0.08));
  amb.setFill(Math.min(1, trueMs / session.capacityMs));

  const best = cfg.bestMs || 0;
  if (!session.ended && best > 0) {
    if (run >= best) {
      if (stage.targetMs != null) {
        stage.targetMs = null;
        stage.targetHit = 1;
        amb.ping(660, 3.4, 0.1);
        buzz([12, 50, 12, 50, 26]);
        toast('новый длиннейший слой');
      }
    } else stage.targetMs = trueMs - run + best;
  }

  presence.set({
    fill: Math.round((trueMs / session.capacityMs) * 50) / 50,
    strata: layers.length
  });

  if (now - savedAt > 4000) {
    savedAt = now;
    store.saveLive(session, trueMs);
  }
}

function showTip(p) {
  const tip = $('#tip');
  if (!p) {
    tip.classList.remove('is-on');
    return;
  }
  const l = p.layer;
  const label = { focus: 'ФОКУС', drift: 'РАЗРЫВ', permitted: 'КРУГ' };
  tip.textContent = `${label[l.type]} · ${fmt(l.start)}–${fmt(l.end)} · ${fmtShort(l.end - l.start)}`;
  tip.style.left = p.x + 'px';
  tip.style.top = p.y + 'px';
  tip.classList.add('is-on');
}

function updateLiveDot() {
  const dot = $('#live-dot');
  const n = presence.joined ? peers.length : 0;
  dot.classList.toggle('is-on', n > 0);
  dot.title = n ? `в зале ${n}` : '';
}

function renderFeed(list) {
  const el = $('#feed');
  $('#feed-live').textContent = presence.joined ? `· ${peers.length} в зале` : '';
  if (!list || !list.length) {
    el.innerHTML = '<li class="feed-empty">Пока тихо.</li>';
    return;
  }
  el.innerHTML = '';
  list
    .slice(-40)
    .reverse()
    .forEach((ev, i) => {
      const li = document.createElement('li');
      li.className = ev.kind;
      li.style.animationDelay = Math.min(i * 20, 200) + 'ms';
      let txt = FEED_TXT[ev.kind] || ev.kind;
      if (ev.kind === 'core' && ev.detail) {
        try {
          const d = JSON.parse(ev.detail);
          txt += ` · ${fmtShort(d.durationMs)} · глубина ${Math.round(d.depth * 100)}%`;
        } catch {}
      }
      const time = new Date(ev.at).toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit'
      });
      li.innerHTML = `<span><b>${esc(ev.who)}</b> <i>${txt}</i></span><time>${time}</time>`;
      el.appendChild(li);
    });
}

async function renderShared() {
  const el = $('#shared');
  const cores = await presence.shared(cfg.room);
  $('#shared-count').textContent = cores.length ? `· ${cores.length}` : '';
  el.innerHTML = '';
  if (!cores.length) {
    el.innerHTML = '<p class="side-note">Пока ни одного керна при свидетелях.</p>';
    return;
  }
  cores.forEach((c) => {
    const fig = document.createElement('figure');
    const cv = document.createElement('canvas');
    const cap = document.createElement('figcaption');
    cap.textContent = c.author;
    fig.appendChild(cv);
    fig.appendChild(cap);
    el.appendChild(fig);
    archive.paintCore(cv, c, 52, 120, { pad: 3 });
  });
}

function updateBadge() {
  const el = $('#witness-badge');
  const on = session && !session.ended && session.witnessed && presence.joined;
  el.classList.toggle('is-on', !!on);
  if (on) el.textContent = `при свидетелях · в зале ${Math.max(1, peers.length)}`;
}

function finish(auto) {
  if (!session || session.ended) return;
  const e = Math.min(session.capacityMs, elapsed(session));
  if (e < 5000) {
    toast('слой ещё не отложился');
    return;
  }
  answer(null);
  session.ended = true;
  session.endMs = e;
  const layers = sealed(session);
  const m = metricsOf(layers, e);
  lastIndex = store.list().length + 1;
  lastCore = store.save({
    id: 'c' + Date.now().toString(36),
    startedAt: session.startedAt,
    capacityMs: session.capacityMs,
    durationMs: e,
    task: session.task,
    witnessed: session.witnessed,
    layers,
    metrics: m
  });
  cfg = store.config();
  store.dropLive();
  if (session.witnessed) {
    presence.publish(lastCore, cfg.name).then((ok) => {
      if (ok) toast('керн отправлен в общее собрание');
    });
  }
  document.title = 'Слои внимания';
  body.dataset.drift = '0';
  $('.state-name').textContent = 'Керн извлечён';
  stage.setDrift(false);
  stage.targetMs = null;
  amb.mode('focus');
  amb.resolve();
  buzz([30, 90, 30]);
  clearTimeout(hintTimer);
  holdScreen(false);
  $('#awake-badge').classList.remove('is-on');
  stage.extract();
  body.dataset.phase = 'result';
  presence.set({ mode: 'done', fill: e / session.capacityMs });

  $('#lab-idx').textContent =
    `Керн № ${String(lastIndex).padStart(3, '0')}${auto ? ' · колба заполнена' : ' · извлечён досрочно'}`;
  $('#lab-title').textContent = fmtShort(e);
  $('#lab-sub').textContent =
    (session.task ? `« ${session.task} » · ` : '') +
    new Date(session.startedAt).toLocaleString('ru-RU', {
      day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit'
    });
  const rows = [
    ['Глубина фокуса', Math.round(m.depth * 100) + '%'],
    ['В работе', Math.round(m.work * 100) + '%'],
    ['Разрывов', String(m.breaks)],
    ['Переходов в круге', String(m.transitions)],
    ['Длиннейший слой', fmt(m.longest)],
    ['Потеряно', fmt(m.driftMs)],
    ['Дымка возвращения', fmt(m.residueMs)],
    ['Индекс дробления', m.fragmentation.toFixed(2)],
    ['Свидетели', session.witnessed ? 'да' : 'нет']
  ];
  $('#lab-metrics').innerHTML = rows
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
    .join('');
  $('#lab-read').textContent = archive.readingOf(m);
}

function renderArchive() {
  archive.mount($('#arc-body'), arcMode);
  $('#experiment').innerHTML = archive.experimentLine(store.list());
}

function renderRoom() {
  renderWall();
  renderFeed(presence.feed);
  renderShared();
  renderGuests();
  renderCollective();
}

function renderWall() {
  const el = $('#wall');
  el.innerHTML = '';
  if (!presence.joined || !peers.length) {
    el.innerHTML = presence.live
      ? '<p class="wall-empty">В зале пусто. Войдите — и ваша колба встанет здесь.</p>'
      : '<p class="wall-empty">Живой зал выключен: страница отдана статикой.<br>Запустите node server.js рядом — или впишите адрес зала в js/config.js.</p>';
    return;
  }
  peers.forEach((p) => {
    const cell = document.createElement('div');
    cell.className = 'peer' + (p.id === ME ? ' is-me' : '') + (p.mode === 'drift' ? ' drift' : '');
    const modeTxt = p.mode === 'drift' ? 'разрыв' : p.mode === 'done' ? 'керн' : 'фокус';
    cell.innerHTML = `<canvas></canvas>
      <p class="peer-name">${esc(p.id === ME ? p.name + ' · вы' : p.name)}</p>
      <p class="peer-state">${modeTxt} · ${Math.round(p.fill * 100)}%</p>`;
    el.appendChild(cell);
    archive.paintPeer(cell.querySelector('canvas'), p.fill, p.mode);
  });
}

function renderGuests() {
  const el = $('#guests');
  const list = store.guests();
  el.innerHTML = '';
  list
    .slice()
    .reverse()
    .forEach((g) => {
      const row = document.createElement('div');
      row.className = 'guest';
      row.innerHTML = `<b>${esc(g.author)}</b><span>${fmtShort(g.durationMs)}</span><button>убрать</button>`;
      row.querySelector('button').addEventListener('click', () => {
        store.dropGuest(g.id);
        renderRoom();
      });
      el.appendChild(row);
    });
}

function renderCollective() {
  const cores = [...store.list(), ...store.guests()];
  const note = $('#coll-note');
  const stats = $('#coll-stats');
  const cv = $('#coll');
  if (!cores.length) {
    note.textContent = 'Пока не из чего складывать: ни одного керна.';
    cv.width = cv.height = 0;
    stats.innerHTML = '';
    return;
  }
  const authors = new Set(cores.map((c) => (c.guest ? c.author : cfg.name)));
  const coll = archive.collective(cores);
  const m = metricsOf(coll.layers, coll.durationMs);
  note.textContent = `Все керны собрания, сложенные подряд: ${cores.length} срез(ов), ${authors.size} участник(ов).`;
  archive.paintCore(cv, coll, 118, 300);
  const rows = [
    ['Общее время', fmtShort(coll.durationMs)],
    ['Фокус', Math.round(m.depth * 100) + '%'],
    ['Круг', Math.round((m.permittedMs / coll.durationMs) * 100) + '%'],
    ['Разрывы', Math.round((m.driftMs / coll.durationMs) * 100) + '%'],
    ['Дробление', m.fragmentation.toFixed(2)]
  ];
  stats.innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
}

function shareLink(core) {
  if (!core) return null;
  const code = store.encode(core, cfg.name);
  return `${location.origin}${location.pathname}#s=${code}`;
}

function takeGuest(text) {
  const raw = text.includes('#s=') ? text.split('#s=')[1] : text;
  const core = store.decode(raw);
  if (!core) {
    toast('строка не читается как керн');
    return false;
  }
  store.addGuest(core);
  toast(`принят керн · ${core.author}`);
  return true;
}

document.querySelectorAll('[data-go]').forEach((b) =>
  b.addEventListener('click', () => {
    const v = b.dataset.go;
    if (v === 'stage' && !session) return go('ritual');
    go(v);
  })
);
$('#to-ritual').addEventListener('click', () => go('ritual'));
$('#begin').addEventListener('click', () => {
  amb.boot();
  begin();
});
$('#task').addEventListener('input', renderOath);
$('#chip-go').addEventListener('click', addChip);
$('#chip-new').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addChip();
});
document.querySelectorAll('.pick').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.pick').forEach((x) => x.classList.remove('is-on'));
    b.classList.add('is-on');
    capacityMin = +b.dataset.min;
  })
);
$('#witness').addEventListener('change', (e) => {
  wantWitness = e.target.checked;
  if (wantWitness && !presence.live) {
    e.target.checked = false;
    wantWitness = false;
    toast('зал не отвечает');
  }
});
function askFinish() {
  if (!session || session.ended) return;
  const fill = Math.min(1, elapsed(session) / session.capacityMs);
  if (fill >= 0.6 || elapsed(session) < 30000) return finish(false);
  $('#cf-pct').textContent = Math.round(fill * 100) + '%';
  $('#confirm').classList.add('is-on');
}
$('#finish').addEventListener('click', askFinish);
$('#cf-no').addEventListener('click', () => $('#confirm').classList.remove('is-on'));
$('#cf-yes').addEventListener('click', () => {
  $('#confirm').classList.remove('is-on');
  finish(false);
});
$('#awake').addEventListener('change', (e) => {
  cfg = store.setConfig({ awake: e.target.checked });
  if (session && !session.ended) holdScreen(e.target.checked);
});
$('#sound-vow').addEventListener('change', async (e) => {
  $('#sound').setAttribute('aria-pressed', String(e.target.checked));
  cfg = store.setConfig({ sound: e.target.checked });
  amb.boot();
  await amb.enable(e.target.checked);
});
$('#again').addEventListener('click', () => go('ritual'));
$('#to-archive').addEventListener('click', () => go('archive'));
let listening = null;

function listenTo(core, btn, label) {
  const prev = listening;
  if (prev) {
    listening = null;
    amb.stopCore();
    prev.btn.textContent = prev.label;
    if (prev.btn === btn) return;
  }
  if (!core) return;
  btn.textContent = 'Остановить';
  listening = { btn, label };
  amb.playCore(core, () => {
    btn.textContent = label;
    listening = null;
  });
}

$('#listen').addEventListener('click', () => listenTo(lastCore, $('#listen'), 'Послушать керн'));

$('#arc-body').addEventListener('click', (e) => {
  const b = e.target.closest('[data-listen]');
  if (!b) return;
  const id = b.dataset.listen;
  const core = [...store.list(), ...store.guests()].find((c) => c.id === id);
  listenTo(core, b, 'Послушать');
});

$('#png').addEventListener('click', () => lastCore && archive.exportPNG(lastCore, lastIndex));
$('#share').addEventListener('click', async () => {
  const link = shareLink(lastCore);
  if (!link) return;
  try {
    await navigator.clipboard.writeText(link);
    toast('ссылка на керн скопирована');
  } catch {
    $('#ex-in').value = link;
    go('room');
    toast('ссылка в поле обмена — скопируйте вручную');
  }
});
function sheet(open) {
  body.dataset.sheet = open ? '1' : '0';
  $('#journal-toggle').textContent = open ? 'Закрыть' : 'Журнал';
}
$('#journal-toggle').addEventListener('click', () => sheet(body.dataset.sheet !== '1'));
$('#ask-out').addEventListener('click', () => answer(null));
$('#ask-skip').addEventListener('click', () => answer(null));
$('#sound').addEventListener('click', async (e) => {
  const on = e.currentTarget.getAttribute('aria-pressed') === 'true';
  e.currentTarget.setAttribute('aria-pressed', String(!on));
  $('#sound-vow').checked = !on;
  cfg = store.setConfig({ sound: !on });
  amb.boot();
  await amb.enable(!on);
});
document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('is-on'));
    t.classList.add('is-on');
    arcMode = t.dataset.mode;
    renderArchive();
  })
);
$('#wipe').addEventListener('click', () => {
  store.clearAll();
  renderArchive();
  toast('собрание очищено');
});
$('#join').addEventListener('click', async () => {
  if (presence.joined) {
    presence.leave();
    $('#join').textContent = 'Войти';
    renderWall();
    updateBadge();
    return;
  }
  if (!presence.live && !(await presence.probe())) {
    toast('зал не отвечает');
    return;
  }
  presence.join(cfg.room, ME, {
    name: cfg.name,
    fill: session ? Math.min(1, elapsed(session) / session.capacityMs) : 0,
    mode: session && !session.ended ? (focused ? 'focus' : 'drift') : 'done',
    strata: session ? session.layers.length : 1
  });
  $('#join').textContent = 'Выйти';
  updateBadge();
});
$('#ex-add').addEventListener('click', () => {
  if (takeGuest($('#ex-in').value)) {
    $('#ex-in').value = '';
    renderRoom();
  }
});
$('#ex-copy').addEventListener('click', async () => {
  const own = store.list();
  const core = lastCore || own[own.length - 1];
  const link = shareLink(core);
  if (!link) {
    toast('ещё нет ни одного керна');
    return;
  }
  try {
    await navigator.clipboard.writeText(link);
    toast('ссылка скопирована');
  } catch {
    $('#ex-in').value = link;
    toast('ссылка в поле — скопируйте вручную');
  }
});

window.addEventListener('blur', () => setFocused(false));
window.addEventListener('focus', () => setFocused(true));
document.addEventListener('visibilitychange', () => {
  setFocused(!document.hidden && document.hasFocus());
  if (!document.hidden && wantAwake && session && !session.ended) holdScreen(true);
});
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($('#confirm').classList.contains('is-on')) $('#confirm').classList.remove('is-on');
  else if ($('#ask').classList.contains('is-on')) answer(null);
  else if (body.dataset.sheet === '1') sheet(false);
});
window.addEventListener('beforeunload', (e) => {
  presence.leave();
  if (session && !session.ended) {
    e.preventDefault();
    e.returnValue = '';
  }
});
window.addEventListener('pointermove', (e) => {
  body.style.setProperty('--mx', e.clientX + 'px');
  body.style.setProperty('--my', e.clientY + 'px');
});

const standalone =
  matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let installPrompt = null;

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  if (!standalone) $('#install').hidden = false;
});

window.addEventListener('appinstalled', () => {
  installPrompt = null;
  $('#install').hidden = true;
  toast('приложение установлено — запускайте с домашнего экрана');
});

$('#install').addEventListener('click', async () => {
  if (installPrompt) {
    installPrompt.prompt();
    const res = await installPrompt.userChoice;
    if (res.outcome === 'accepted') $('#install').hidden = true;
    installPrompt = null;
    return;
  }
  toast('в Safari: «Поделиться» → «На экран „Домой“»', 5000);
});

if (!standalone && /iphone|ipad|ipod/i.test(navigator.userAgent)) {
  $('#install').hidden = false;
}

syncNav();
renderCircle();
$('#task').value = cfg.lastTask || '';
if (cfg.lastMin) {
  const pick = [...document.querySelectorAll('.pick')].find((b) => +b.dataset.min === cfg.lastMin);
  if (pick) {
    document.querySelectorAll('.pick').forEach((x) => x.classList.remove('is-on'));
    pick.classList.add('is-on');
    capacityMin = cfg.lastMin;
  }
}
$('#awake').checked = cfg.awake !== false;
$('#sound-vow').checked = !!cfg.sound;
$('#sound').setAttribute('aria-pressed', String(!!cfg.sound));
renderOath();
const resumed = resume();

const wanted = new URLSearchParams(location.search).get('go');
if (wanted && ['ritual', 'archive', 'room', 'method'].includes(wanted)) {
  go(wanted);
  history.replaceState(null, '', location.pathname);
}

if (location.hash.startsWith('#s=')) {
  const ok = takeGuest(location.hash.slice(3));
  history.replaceState(null, '', location.pathname);
  if (ok) {
    go('room');
    renderRoom();
  }
}

presence.probe().then((live) => {
  const el = $('#net-state');
  el.textContent = live ? 'зал доступен · вы не вошли' : 'локальный режим · сервер не запущен';
  el.classList.toggle('is-live', false);
  $('#witness-note').textContent = live
    ? 'передаются имя, доля заполнения и состояние; готовый керн ложится в общее собрание'
    : 'сервер не запущен — сеанс будет одиноким';
  if (live && resumed && session && !session.ended && session.witnessed) {
    presence.join(cfg.room, ME, {
      name: cfg.name,
      fill: Math.min(1, elapsed(session) / session.capacityMs),
      mode: focused ? 'focus' : 'drift',
      strata: session.layers.length
    });
  }
  if (live && body.dataset.view === 'room') renderShared();
});
