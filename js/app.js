import { Stage } from './stage.js';
import { Ambience } from './audio.js';
import { Presence } from './net.js';
import {
  createSession, elapsed, switchState, lastClosedDrift, sealed, metricsOf,
  currentRunMs, fmt, fmtShort, ASK_AFTER_MS, MERGE_MS
} from './session.js';
import * as store from './store.js';
import * as archive from './archive.js';
import { native } from './native.js';
import { initUpdates } from './updates.js';

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
let listening = null;
let wakeLock = null;
let wantAwake = true;
let warnedAwake = false;
let ruptureTimer = null;
let otherTabWarned = false;
let lastPresenceStatus = 'offline';
let lastDegradedToastAt = 0;
let hadLink = false;
let linkLost = false;
let wipeTimer = null;

let tapped = false;
addEventListener('pointerdown', () => {
  tapped = true;
}, { once: true, passive: true });

const buzz = (pattern) => {
  if (native.isNative && native.haptic(pattern)) return;
  if (!tapped || !navigator.vibrate) return;
  try {
    navigator.vibrate(pattern);
  } catch {}
};

const LAYER_KIND = { focus: 0, permitted: 1, drift: 2 };
const DAY = 86400000;

function dayStats() {
  const startOfDay = (t) => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const today = startOfDay(Date.now());
  const days = new Set();
  let todayMs = 0;
  store.list().forEach((c) => {
    const d = startOfDay(c.startedAt);
    days.add(d);
    if (d === today) todayMs += Math.round((c.metrics ? c.metrics.depth : 1) * c.durationMs);
  });
  let d = days.has(today) ? today : days.has(today - DAY) ? today - DAY : null;
  let streak = 0;
  while (d !== null && days.has(d)) {
    streak++;
    d -= DAY;
  }
  return { todayMs, streak };
}

function widgetSync(result) {
  if (!native.isNative) return;
  const live = !!session && !session.ended;
  const st = {
    active: live,
    drift: live && !focused,
    live: !!cfg.notify,
    startedAt: live ? session.startedAt : 0,
    capacityMs: live ? session.capacityMs : 0,
    task: live ? session.task || '' : '',
    layers: live ? session.layers.map((l) => [LAYER_KIND[l.type] ?? 0, l.start, l.end]) : [],
    ...dayStats()
  };
  if (result) Object.assign(st, result);
  native.widget(st);
}

function updateBadgeCount(count) {
  if (typeof navigator !== 'undefined' && 'setAppBadge' in navigator) {
    try {
      if (count > 0) navigator.setAppBadge(count).catch(() => {});
      else navigator.clearAppBadge().catch(() => {});
    } catch {}
  }
}

function clearBadgeCount() {
  if (typeof navigator !== 'undefined' && 'clearAppBadge' in navigator) {
    try {
      navigator.clearAppBadge().catch(() => {});
    } catch {}
  }
}

function persistLive(elapsedMs) {
  if (!session || session.ended) return;
  const ok = store.saveLive(session, elapsedMs, ME);
  if (!ok && !otherTabWarned) {
    const existing = store.loadLive();
    if (existing && existing.owner && existing.owner !== ME && (Date.now() - (existing.savedAt || 0) < 6000)) {
      otherTabWarned = true;
      toast('Сеанс уже идёт в другой вкладке.');
    }
  }
}

store.setWriteErrorHandler(() => {
  toast('Браузер не даёт сохранять данные — сеанс не переживёт перезагрузку.', 5000);
});

async function holdScreen(on) {
  wantAwake = on;
  if (native.isNative) {
    native.keepAwake(on);
    $('#awake-badge').classList.toggle('is-on', !!on && !!session && !session.ended);
    return;
  }
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

function syncOfflineBanner() {
  const isOffline = !navigator.onLine;
  const banner = $('#offline-banner');
  if (isOffline) {
    body.dataset.net = 'offline';
    if (banner) banner.removeAttribute('hidden');
  } else {
    delete body.dataset.net;
    if (banner) banner.setAttribute('hidden', '');
  }
}

function updateNetStatus(s = presence.status) {
  const el = $('#net-state');
  if (!el) return;
  el.dataset.status = s;
  if (presence.joined) {
    if (s === 'live') el.textContent = 'в зале · на связи';
    else if (s === 'connecting') el.textContent = 'настраиваем связь…';
    else if (s === 'degraded') el.textContent = 'связь замерла · сохраняем локально';
    else el.textContent = 'локальный режим · тихий сеанс';
    el.classList.toggle('is-live', s === 'live');
  } else {
    el.classList.remove('is-live');
    if (presence.live) el.textContent = 'зал доступен · вы не вошли';
    else el.textContent = 'локальный режим · тихий сеанс';
  }
  syncOfflineBanner();
  updateBadge();
}

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
    if (presence.joined) {
      const now = Date.now();
      if (s === 'live') {
        if (linkLost) {
          linkLost = false;
          toast('Связь восстановлена.');
        }
        hadLink = true;
      } else if (hadLink && !linkLost && (s === 'degraded' || s === 'offline')) {
        linkLost = true;
        if (now - lastDegradedToastAt > 30000) {
          lastDegradedToastAt = now;
          toast('Связь с залом замерла. Сеанс идёт и пишется локально.');
        }
      }
    } else {
      hadLink = false;
      linkLost = false;
    }
    lastPresenceStatus = s;
    updateNetStatus(s);
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
  const from = body.dataset.view;
  body.dataset.view = view;
  syncNav();
  if (from === 'stage' && view !== 'stage') {
    stage.stop();
  } else if (from !== 'stage' && view === 'stage') {
    if (session) {
      stage.run();
    }
  }
  if (from === 'archive' || from === 'room' || (from === 'stage' && view !== 'stage')) {
    amb.stopCore();
    if (listening) {
      listening.btn.textContent = listening.label;
      listening = null;
    }
  }
  if (from === 'stage' && view !== 'stage' && (!session || session.ended)) amb.leave();
  if (view === 'archive') renderArchive();
  if (view === 'room') renderRoom();
  if (view === 'ritual') {
    renderOath();
    const notifyEl = $('#notify');
    if (notifyEl) notifyEl.checked = !!cfg.notify;
  }
}

function toast(text, ms = 2800) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('is-on');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('is-on'), ms);
}

function renderCircle(newChipName = null) {
  const box = $('#circle');
  box.innerHTML = '';
  if (!cfg.circle.length) {
    box.innerHTML = '<span class="side-note">Круг пуст — любой уход будет разрывом.</span>';
    return;
  }
  cfg.circle.forEach((name, i) => {
    const el = document.createElement('span');
    const isNew = name === newChipName;
    el.className = 'chip is-on' + (isNew ? ' chip--new' : '');
    el.innerHTML = `<b>${esc(name)}</b><button class="chip-x" type="button" aria-label="Убрать «${esc(name)}»">×</button>`;
    if (isNew) {
      const clean = () => el.classList.remove('chip--new');
      el.addEventListener('animationend', clean, { once: true });
      setTimeout(clean, 600);
    }
    el.querySelector('.chip-x').addEventListener('click', (e) => {
      e.stopPropagation();
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
  buzz(10);
  renderCircle(v);
  renderOath();
}

function renderOath() {
  const task = $('#task').value.trim() || 'начатое';
  const c = cfg.circle;
  $('#oath').textContent =
    `Если меня потянет отвлечься — я вернусь к: ${task}. ` +
    (c.length ? `Круг: ${c.join(', ')}. Всё вне круга — разрыв.` : 'Круг пуст: любой уход — разрыв.');
}

let currentPushEndpoint = null;

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function sendPushSubscribe() {
  if (!session || session.ended) return;
  if (!cfg.notify) return;
  if (native.isNative) {
    native.scheduleEnd(session.startedAt + session.capacityMs);
    return;
  }
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (!('serviceWorker' in navigator)) return;

  const endAt = session.startedAt + session.capacityMs;
  if (endAt <= Date.now()) return;

  navigator.serviceWorker.ready
    .then((reg) => {
      if (!reg?.pushManager) return null;
      return reg.pushManager.getSubscription();
    })
    .then((sub) => {
      if (!sub || !session || session.ended) return;
      currentPushEndpoint = sub.endpoint;
      const payload = {
        subscription: sub.toJSON ? sub.toJSON() : sub,
        endAt
      };
      fetch('/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(() => {});
    })
    .catch(() => {});
}

function sendPushCancel() {
  if (native.isNative) {
    native.cancelEnd();
    return;
  }
  const cancelWith = (ep) => {
    if (!ep) return;
    try {
      fetch('/push/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: ep }),
        keepalive: true
      }).catch(() => {});
    } catch {}
  };

  if (currentPushEndpoint) {
    cancelWith(currentPushEndpoint);
  } else if ('serviceWorker' in navigator) {
    navigator.serviceWorker.ready
      .then((reg) => {
        if (!reg?.pushManager) return null;
        return reg.pushManager.getSubscription();
      })
      .then((sub) => {
        if (sub?.endpoint) {
          currentPushEndpoint = sub.endpoint;
          cancelWith(sub.endpoint);
        }
      })
      .catch(() => {});
  }
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
  persistLive(0);
  journal();
  clearBadgeCount();
  updateBadge();
  if (session.witnessed) {
    presence.join(cfg.room, ME, { name: cfg.name, fill: 0, mode: 'focus', strata: 1 });
  }
  warnedAwake = false;
  holdScreen($('#awake').checked);
  amb.enter();
  buzz(14);
  amb.ping(396, 2, 0.08);
  clearTimeout(ruptureTimer);
  ruptureTimer = null;
  sendPushSubscribe();
  widgetSync();
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
    if (ruptureTimer) {
      clearTimeout(ruptureTimer);
      ruptureTimer = null;
    }
    amb.ping();
    document.title = 'Слои внимания';
    const last = lastClosedDrift(session);
    if (last && last.end - last.start >= ASK_AFTER_MS) {
      pendingDrift = last;
      ask(last.end - last.start);
    }
    buzz(12);
  } else {
    clearTimeout(ruptureTimer);
    ruptureTimer = setTimeout(() => {
      ruptureTimer = null;
      if (!focused && session && !session.ended) {
        amb.rupture();
        buzz(18);
        document.title = '◦ разрыв растёт — слои внимания';
        const breaks = session.layers.filter((l) => l.type === 'drift').length;
        updateBadgeCount(breaks);
      }
    }, MERGE_MS + 30);
  }
  persistLive(at);
  widgetSync();
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
  if (open) {
    if (open.type === 'drift') {
      open.end = null;
    } else {
      if (open.end == null) open.end = v.elapsedMs;
      session.layers.push({ type: 'drift', start: v.elapsedMs, end: null });
    }
  } else {
    session.layers.push({ type: 'drift', start: 0, end: null });
  }

  focused = false;
  const curElapsed = elapsed(session);

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

  if (curElapsed >= session.capacityMs) {
    finish(true);
    toast('колба заполнилась — керн извлечён');
    return true;
  }
  toast(`сеанс восстановлен · ${fmtShort(gap)} легло разрывом`);
  sendPushSubscribe();
  widgetSync();
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
    persistLive(elapsed(session));
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

function hud() {
  if (!session || session.ended) return;
  const now = performance.now();
  if (now - hudAt < 150) return;
  hudAt = now;

  const curElapsed = elapsed(session);
  if (curElapsed >= session.capacityMs) {
    finish(true);
    return;
  }
  const trueMs = Math.min(session.capacityMs, curElapsed);
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
    persistLive(trueMs);
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
  if (!on) return;

  if (presence.status === 'degraded' || presence.status === 'offline') {
    el.textContent = 'сеанс продолжается наедине · связь вернётся';
    return;
  }
  const liveCount = peers.filter((p) => p.status !== 'stale').length;
  if (liveCount > 1) {
    el.textContent = `при свидетелях · в зале ${liveCount}`;
  } else {
    el.textContent = 'вы одни в зале · ждём свидетелей';
  }
}

function finish(auto) {
  if (!session || session.ended) return;
  const e = Math.min(session.capacityMs, elapsed(session));
  if (e < 5000) {
    toast('слой ещё не отложился');
    return;
  }
  answer(null);
  clearTimeout(ruptureTimer);
  ruptureTimer = null;
  clearBadgeCount();
  session.ended = true;
  session.endMs = e;
  if (!(auto && document.hidden)) sendPushCancel();
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
  store.dropLive(ME);
  widgetSync({
    lastDepth: Math.round((Number(m.depth) || 0) * 100),
    lastMs: e,
    lastBreaks: Math.round(Number(m.breaks) || 0),
    lastLayers: layers.map((l) => [LAYER_KIND[l.type] ?? 0, Math.max(0, l.end - l.start)])
  });
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
  const METRIC_HINTS = {
    'Глубина фокуса': 'Доля времени в непрерывном фокусе без отвлечений',
    'В работе': 'Доля времени в фокусе и разрешённых переходах круга',
    'Разрывов': 'Количество уходов за пределы разрешённого круга',
    'Переходов в круге': 'Количество переключений на разрешённые задачи',
    'Длиннейший слой': 'Самый долгий непрерывный отрезок работы без разрывов',
    'Потеряно': 'Суммарное время отсутствия вне круга',
    'Дымка возвращения': 'Время восстановления концентрации после переключений',
    'Индекс дробления': 'Мера раздробленности внимания от 0 (монолит) до 1',
    'Свидетели': 'Проходил ли сеанс с подключением к залу присутствия'
  };
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
    .map(([k, v]) => {
      const hint = METRIC_HINTS[k];
      const titleAttr = hint ? ` title="${esc(hint)}"` : '';
      return `<div><dt${titleAttr}>${k}</dt><dd>${v}</dd></div>`;
    })
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
    const isStale = p.status === 'stale';
    const cell = document.createElement('div');
    cell.className = 'peer' + (p.id === ME ? ' is-me' : '') + (p.mode === 'drift' ? ' drift' : '');
    if (isStale) cell.dataset.status = 'stale';
    const modeTxt = isStale ? 'замер' : (p.mode === 'drift' ? 'разрыв' : p.mode === 'done' ? 'керн' : 'фокус');
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
    buzz(8);
  })
);
$('#witness').addEventListener('change', (e) => {
  buzz(8);
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
  buzz(8);
  cfg = store.setConfig({ awake: e.target.checked });
  if (session && !session.ended) holdScreen(e.target.checked);
});
$('#sound-vow').addEventListener('change', async (e) => {
  buzz(8);
  $('#sound').setAttribute('aria-pressed', String(e.target.checked));
  cfg = store.setConfig({ sound: e.target.checked });
  amb.boot();
  await amb.enable(e.target.checked);
});
$('#notify').addEventListener('change', async (e) => {
  buzz(8);
  if (e.target.checked && native.isNative) {
    if (await native.enableReminders()) {
      cfg = store.setConfig({ notify: true });
      toast('Таймер появится в шторке, а по окончании придёт сигнал.');
      if (session && !session.ended) sendPushSubscribe();
      widgetSync();
    } else {
      e.target.checked = false;
      toast('Уведомления не разрешены в настройках Android.');
    }
    return;
  }
  if (e.target.checked) {
    const hasSupport =
      'Notification' in window &&
      'serviceWorker' in navigator &&
      'PushManager' in window;
    if (!hasSupport) {
      e.target.checked = false;
      const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
      const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
      if (isIos && !isStandalone) {
        toast('На iPhone уведомления работают, когда приложение добавлено на экран «Домой».');
      } else {
        toast('Уведомления в этом браузере недоступны.');
      }
      return;
    }
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        e.target.checked = false;
        toast('Уведомления не разрешены в браузере.');
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      let sub = await registration.pushManager.getSubscription();
      if (!sub) {
        const res = await fetch('/push/key');
        if (!res.ok) throw new Error('key fetch failed');
        const data = await res.json();
        if (!data?.key) throw new Error('no key');
        sub = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(data.key)
        });
      }
      if (sub?.endpoint) currentPushEndpoint = sub.endpoint;
      cfg = store.setConfig({ notify: true });
      toast('Напомним, когда время выйдет.');
      if (session && !session.ended) sendPushSubscribe();
    } catch {
      e.target.checked = false;
      toast('Не получилось включить напоминание.');
    }
  } else {
    cfg = store.setConfig({ notify: false });
    if (session && !session.ended) sendPushCancel();
    widgetSync();
  }
});
$('#again').addEventListener('click', () => {
  amb.leave();
  stage.stop();
  go('ritual');
});
$('#to-archive').addEventListener('click', () => go('archive'));
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

$('#png').addEventListener('click', async () => {
  if (!lastCore) return;
  const fileName = `kern-${String(lastIndex).padStart(3, '0')}.png`;
  if (typeof navigator !== 'undefined' && navigator.canShare) {
    try {
      const res = archive.exportPNG(lastCore, lastIndex, { raw: true });
      let file = null;
      if (res instanceof File) file = res;
      else if (res instanceof Blob) file = new File([res], fileName, { type: 'image/png' });
      else if (res instanceof Promise) {
        const val = await res;
        if (val instanceof File) file = val;
        else if (val instanceof Blob) file = new File([val], fileName, { type: 'image/png' });
        else if (val instanceof HTMLCanvasElement) {
          const blob = await new Promise((r) => val.toBlob(r, 'image/png'));
          if (blob) file = new File([blob], fileName, { type: 'image/png' });
        }
      } else if (res instanceof HTMLCanvasElement) {
        const blob = await new Promise((r) => res.toBlob(r, 'image/png'));
        if (blob) file = new File([blob], fileName, { type: 'image/png' });
      }
      if (file && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Слои внимания' });
        return;
      }
      if (res) return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
  archive.exportPNG(lastCore, lastIndex);
});

$('#share').addEventListener('click', async () => {
  const link = shareLink(lastCore);
  if (!link) return;
  if (navigator.share) {
    try {
      await navigator.share({
        title: 'Слои внимания',
        text: lastCore?.task ? `Керн «${lastCore.task}»` : 'Керн сеанса внимания',
        url: link
      });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
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
  const btn = $('#wipe');
  if (wipeTimer) {
    clearTimeout(wipeTimer);
    wipeTimer = null;
    btn.textContent = 'Очистить';
    store.clearAll();
    renderArchive();
    toast('Архив очищен');
    return;
  }
  btn.textContent = 'Точно стереть? Нажмите ещё раз';
  wipeTimer = setTimeout(() => {
    wipeTimer = null;
    btn.textContent = 'Очистить';
  }, 4000);
});

$('#join').addEventListener('click', async () => {
  const btn = $('#join');
  if (presence.joined) {
    presence.leave();
    btn.textContent = 'Войти';
    btn.disabled = false;
    renderWall();
    updateBadge();
    updateNetStatus();
    return;
  }
  btn.disabled = true;
  btn.textContent = 'проверяю…';
  let ok = presence.live;
  if (!ok) {
    ok = await presence.probe();
  }
  if (!ok) {
    btn.disabled = false;
    btn.textContent = 'Войти';
    toast('Зал сейчас недоступен — сеанс пойдёт наедине.');
    return;
  }
  btn.disabled = false;
  presence.join(cfg.room, ME, {
    name: cfg.name,
    fill: session ? Math.min(1, elapsed(session) / session.capacityMs) : 0,
    mode: session && !session.ended ? (focused ? 'focus' : 'drift') : 'done',
    strata: session ? session.layers.length : 1
  });
  btn.textContent = 'Выйти';
  updateBadge();
  updateNetStatus();
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
  amb.duck(document.hidden);
  if (!document.hidden) {
    if (wantAwake && session && !session.ended) holdScreen(true);
    if (presence.joined) presence.reconnectNow();
  }
});
window.addEventListener('online', () => {
  syncOfflineBanner();
  if (presence.joined) presence.reconnectNow();
  updateNetStatus();
});
window.addEventListener('offline', () => {
  syncOfflineBanner();
  updateNetStatus('offline');
});
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($('#confirm').classList.contains('is-on')) $('#confirm').classList.remove('is-on');
  else if ($('#ask').classList.contains('is-on')) answer(null);
  else if (body.dataset.sheet === '1') sheet(false);
});
window.addEventListener('beforeunload', (e) => {
  if (session && !session.ended) {
    e.preventDefault();
    e.returnValue = '';
  }
});
window.addEventListener('pointermove', (e) => {
  body.style.setProperty('--mx', e.clientX + 'px');
  body.style.setProperty('--my', e.clientY + 'px');
});

const rightRail = document.querySelector('.rail--right');
let touchStartY = 0;
let touchStartX = 0;
let isSwipingSheet = false;

if (rightRail) {
  rightRail.addEventListener('touchstart', (e) => {
    if (body.dataset.sheet !== '1' || e.touches.length !== 1) return;
    if (rightRail.scrollTop > 0) return;
    touchStartY = e.touches[0].clientY;
    touchStartX = e.touches[0].clientX;
    isSwipingSheet = false;
  }, { passive: true });

  rightRail.addEventListener('touchmove', (e) => {
    if (body.dataset.sheet !== '1' || touchStartY === 0 || e.touches.length !== 1) return;
    if (rightRail.scrollTop > 0) {
      if (isSwipingSheet) {
        rightRail.style.transform = '';
        rightRail.style.transition = '';
        isSwipingSheet = false;
      }
      return;
    }
    const dy = e.touches[0].clientY - touchStartY;
    const dx = Math.abs(e.touches[0].clientX - touchStartX);
    if (dy > 8 && dy > dx) {
      isSwipingSheet = true;
      rightRail.style.transition = 'none';
      rightRail.style.transform = `translateY(${Math.max(0, dy)}px)`;
    }
  }, { passive: true });

  const endSwipe = (e) => {
    if (!isSwipingSheet) return;
    isSwipingSheet = false;
    const dy = (e.changedTouches && e.changedTouches[0]) ? (e.changedTouches[0].clientY - touchStartY) : 0;
    rightRail.style.transition = 'transform 0.3s var(--ease)';
    if (dy >= 60) {
      rightRail.style.transform = 'translateY(100%)';
      setTimeout(() => {
        sheet(false);
        rightRail.style.transform = '';
        rightRail.style.transition = '';
      }, 300);
    } else {
      rightRail.style.transform = '';
      setTimeout(() => {
        rightRail.style.transition = '';
      }, 300);
    }
    touchStartY = 0;
  };

  rightRail.addEventListener('touchend', endSwipe, { passive: true });
  rightRail.addEventListener('touchcancel', endSwipe, { passive: true });
}

const standalone =
  matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let installPrompt = null;

if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'updated' && hadController) {
      toast('Доступна новая версия — перезапустите приложение.', 6000);
    }
  });
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
if (cfg.notify && !native.isNative) {
  const hasSupport =
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window;
  if (!hasSupport || Notification.permission !== 'granted') {
    cfg = store.setConfig({ notify: false });
  }
}
const notifyEl = $('#notify');
if (notifyEl) notifyEl.checked = !!cfg.notify;
renderOath();
const resumed = resume();

function quickStart(min) {
  if (session && !session.ended) {
    go('stage');
    return;
  }
  capacityMin = [2, 15, 25, 50].includes(min) ? min : 25;
  $('#task').value = cfg.lastTask || '';
  begin();
}

function openTarget(target, arg) {
  if (target === 'stage') go(session ? 'stage' : 'ritual');
  else if (target === 'start') quickStart(+(arg && arg.min));
  else if (target === 'finish') {
    if (session && !session.ended) {
      go('stage');
      finish(false);
    } else go(session ? 'stage' : 'ritual');
  } else if (target === 'guest') {
    if (takeGuest(arg)) {
      go('room');
      renderRoom();
    }
  } else if (['ritual', 'archive', 'room', 'method'].includes(target)) go(target);
}

const wanted = new URLSearchParams(location.search).get('go');
if (wanted) {
  openTarget(wanted, Object.fromEntries(new URLSearchParams(location.search)));
  history.replaceState(null, '', location.pathname);
}
native.onOpen(openTarget);
initUpdates({ toast, busy: () => !!session && !session.ended });
native.onBack(() => {
  const v = body.dataset.view;
  if (body.dataset.sheet === '1') sheet(false);
  else if (v === 'stage' && session && !session.ended) native.minimize();
  else if (v !== 'intro') go('intro');
  else native.minimize();
});
if (native.isNative) $('#android-link')?.remove();
{
  const pin = $('#pin-widget');
  if (pin && native.isNative) {
    pin.style.display = '';
    pin.addEventListener('click', async () => {
      const ok = await native.pinWidget();
      if (!ok) toast('Добавьте виджет вручную: долгое нажатие на экране → Виджеты → Слои внимания.', 5000);
    });
  }
  const tile = $('#add-tile');
  if (tile && native.isNative) {
    tile.style.display = '';
    tile.addEventListener('click', async () => {
      const r = await native.addTile();
      if (!r || r.supported === false) toast('Плитку можно добавить вручную: шторка → карандаш → «Слои внимания».', 5000);
      else if (r.result === 1) toast('Плитка уже в быстрых настройках.');
      else if (r.result === 2) toast('Плитка добавлена в быстрые настройки.');
    });
  }
  const notifyLabel = $('#notify')?.closest('.switch')?.querySelector('.sw-txt');
  if (notifyLabel && native.isNative) {
    notifyLabel.innerHTML = 'Уведомления сеанса<i>таймер в шторке и сигнал, когда время выйдет</i>';
  }
}
widgetSync();

if (location.hash.startsWith('#s=')) {
  const ok = takeGuest(location.hash.slice(3));
  history.replaceState(null, '', location.pathname);
  if (ok) {
    go('room');
    renderRoom();
  }
}

function setRoomTab(tab) {
  body.dataset.roomtab = tab;
  document.querySelectorAll('[data-roomtab]').forEach((b) => {
    const sel = b.dataset.roomtab === tab;
    b.setAttribute('aria-selected', String(sel));
  });
}
document.querySelectorAll('[data-roomtab]').forEach((b) => {
  b.addEventListener('click', () => {
    setRoomTab(b.dataset.roomtab);
  });
});
setRoomTab('presence');
syncOfflineBanner();
updateNetStatus();

presence.probe().then((live) => {
  updateNetStatus(live ? 'offline' : 'offline');
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
