import { Stage } from './stage.js';
import { Ambience } from './audio.js';
import {
  createSession, elapsed, switchState, sealed, metricsOf, fmt, fmtShort, HAZE_MS
} from './session.js';
import * as store from './store.js';
import * as archive from './archive.js';

const $ = (s) => document.querySelector(s);
const body = document.body;

const amb = new Ambience();
let session = null;
let focused = true;
let capacityMin = 25;
let lastCore = null;
let lastIndex = 0;
let arcMode = 'cores';
let hudAt = 0;

const stage = new Stage($('#vessel'), {
  onTick: hud,
  onFull: () => finish(true),
  onHover: showTip
});

function go(view) {
  if (view === body.dataset.view) return;
  body.dataset.view = view;
  document.querySelectorAll('[data-go]').forEach((b) =>
    b.classList.toggle('is-on', b.dataset.go === view)
  );
  if (view === 'archive') archive.mount($('#arc-body'), arcMode);
}

function toast(text, ms = 2600) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('is-on');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('is-on'), ms);
}

function begin() {
  session = createSession(capacityMin * 60000);
  focused = true;
  body.dataset.phase = 'live';
  body.dataset.drift = '0';
  $('#cap-label').textContent = `колба ${capacityMin} мин`;
  $('.state-name').textContent = 'Фокус';
  stage.setDrift(false);
  stage.attach(session);
  amb.mode('focus');
  journal();
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
  if (v) {
    const last = session.layers[session.layers.length - 2];
    amb.ping();
    if (last && last.type === 'drift') {
      const d = last.end - last.start;
      if (d > 1500) toast(`разрыв ${fmtShort(d)} · слой отложен`);
    }
    document.title = 'Слои внимания';
  } else {
    amb.rupture();
    document.title = '◦ разрыв растёт — слои внимания';
  }
  journal();
}

function journal() {
  if (!session) return;
  const list = sealed(session);
  const el = $('#journal');
  el.innerHTML = '';
  list
    .slice()
    .reverse()
    .forEach((l, i) => {
      const li = document.createElement('li');
      li.className = l.type;
      li.style.animationDelay = Math.min(i * 30, 240) + 'ms';
      li.innerHTML = `<b>${l.type === 'drift' ? 'Разрыв' : 'Фокус'}</b><span>${fmt(l.start)} → ${fmt(l.end)}</span>`;
      el.appendChild(li);
    });
}

function hud(trueMs, shownMs) {
  const now = performance.now();
  if (now - hudAt < 140) return;
  hudAt = now;
  const layers = sealed(session);
  const m = metricsOf(layers, trueMs);
  $('#ro-time').textContent = fmt(trueMs);
  $('#ro-depth').textContent = Math.round(m.depth * 100) + '%';
  $('#ro-breaks').textContent = m.breaks;
  $('#ro-strata').textContent = m.strata;
  $('#ro-longest').textContent = fmt(m.longest);
  $('#ro-frag').textContent = m.fragmentation.toFixed(2);
  amb.pour(Math.min(1.4, stage.rate * 1.1 + 0.08));
}

function showTip(p) {
  const tip = $('#tip');
  if (!p) {
    tip.classList.remove('is-on');
    return;
  }
  const l = p.layer;
  tip.textContent = `${l.type === 'drift' ? 'РАЗРЫВ' : 'ФОКУС'} · ${fmt(l.start)}–${fmt(l.end)} · ${fmtShort(l.end - l.start)}`;
  tip.style.left = p.x + 'px';
  tip.style.top = p.y + 'px';
  tip.classList.add('is-on');
}

function finish(auto) {
  if (!session || session.ended) return;
  const e = Math.min(session.capacityMs, elapsed(session));
  if (e < 5000) {
    toast('слой ещё не отложился');
    return;
  }
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
    layers
  });
  document.title = 'Слои внимания';
  body.dataset.drift = '0';
  $('.state-name').textContent = 'Керн извлечён';
  stage.setDrift(false);
  amb.mode('focus');
  amb.ping(528, 4, 0.1);
  stage.extract();
  body.dataset.phase = 'result';

  $('#lab-idx').textContent = `Керн № ${String(lastIndex).padStart(3, '0')}${auto ? ' · колба заполнена' : ' · извлечён досрочно'}`;
  $('#lab-title').textContent = fmtShort(e);
  $('#lab-sub').textContent = new Date(session.startedAt).toLocaleString('ru-RU', {
    day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit'
  });
  const rows = [
    ['Глубина фокуса', Math.round(m.depth * 100) + '%'],
    ['Разрывов', String(m.breaks)],
    ['Слоёв', String(m.strata)],
    ['Длиннейший слой', fmt(m.longest)],
    ['Потеряно', fmt(m.driftMs)],
    ['Дымка возвращения', fmt(m.residueMs)],
    ['Индекс дробления', m.fragmentation.toFixed(2)]
  ];
  $('#lab-metrics').innerHTML = rows
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
    .join('');
  $('#lab-read').textContent = archive.readingOf(m);
}

$('#begin').addEventListener('click', () => {
  amb.boot();
  begin();
});
document.querySelectorAll('.pick').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.pick').forEach((x) => x.classList.remove('is-on'));
    b.classList.add('is-on');
    capacityMin = +b.dataset.min;
  })
);
document.querySelectorAll('[data-go]').forEach((b) =>
  b.addEventListener('click', () => {
    if (b.dataset.go === 'stage' && (!session || session.ended)) {
      if (body.dataset.phase === 'result' && session) return go('stage');
      return go('intro');
    }
    go(b.dataset.go);
  })
);
$('#finish').addEventListener('click', () => finish(false));
$('#again').addEventListener('click', () => go('intro'));
$('#to-archive').addEventListener('click', () => {
  arcMode = 'cores';
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-on', t.dataset.mode === 'cores'));
  go('archive');
});
$('#png').addEventListener('click', () => {
  if (lastCore) archive.exportPNG(lastCore, lastIndex);
});
$('#sound').addEventListener('click', async (e) => {
  const on = e.currentTarget.getAttribute('aria-pressed') === 'true';
  e.currentTarget.setAttribute('aria-pressed', String(!on));
  await amb.enable(!on);
});
document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('is-on'));
    t.classList.add('is-on');
    arcMode = t.dataset.mode;
    archive.mount($('#arc-body'), arcMode);
  })
);
$('#wipe').addEventListener('click', () => {
  store.clearAll();
  archive.mount($('#arc-body'), arcMode);
  toast('собрание очищено');
});

window.addEventListener('blur', () => setFocused(false));
window.addEventListener('focus', () => setFocused(true));
document.addEventListener('visibilitychange', () =>
  setFocused(!document.hidden && document.hasFocus())
);
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

go('intro');
