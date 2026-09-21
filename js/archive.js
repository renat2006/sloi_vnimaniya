import { buildGeom } from './geom.js';
import { drawStack, PAL, rgba } from './paint.js';
import { metricsOf, fmtShort, fmt } from './session.js';
import * as store from './store.js';

const DAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

export function paintCore(canvas, core, w, h, opts = {}) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const pad = opts.pad ?? 5;
  const g = buildGeom({ cx: w / 2, top: pad, bottom: h - pad, R: (w - pad * 2) / 0.6, morph: 1 });
  drawStack(ctx, g, core.layers, {
    capacityMs: core.capacityMs,
    shownMs: core.durationMs,
    amp: 1.4,
    grainAlpha: 0.75
  });
  ctx.strokeStyle = rgba(PAL.bone, opts.frame ?? 0.16);
  ctx.lineWidth = 1;
  ctx.strokeRect(pad - 0.5, pad - 0.5, w - pad * 2 + 1, h - pad * 2 + 1);
  return ctx;
}

const dt = (ms) => new Date(ms);
const dateLine = (ms) =>
  dt(ms).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long' }) +
  ' · ' +
  dt(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

export function readingOf(m) {
  if (m.breaks === 0) return 'Монолит. Ни одной границы — порода, которую почти не встретить.';
  if (m.fragmentation < 0.25) return 'Плотная порода: крупные слои, границы читаются по одной.';
  if (m.fragmentation < 0.55) return 'Слоистая порода: внимание держалось эпизодами.';
  return 'Дроблёная порода: слои тоньше, чем время, нужное на возвращение.';
}

export function mount(root, mode) {
  const all = store.list().slice().sort((a, b) => b.startedAt - a.startedAt);
  root.innerHTML = '';
  if (!all.length) {
    root.innerHTML =
      '<div class="empty"><p>Собрание пусто. Первый керн появится здесь<br>после завершённого сеанса.</p></div>';
    return;
  }
  if (mode === 'week') mountWeek(root, all);
  else mountCores(root, all);
}

function mountCores(root, all) {
  const grid = document.createElement('div');
  grid.className = 'arc-grid';
  const total = all.length;
  all.forEach((c, i) => {
    const m = metricsOf(c.layers, c.durationMs);
    const el = document.createElement('article');
    el.className = 'card';
    el.innerHTML = `
      <canvas></canvas>
      <div class="card-info">
        <p class="card-idx">Керн № ${String(total - i).padStart(3, '0')}</p>
        <p class="card-title">${fmtShort(c.durationMs)}</p>
        <p class="card-date">${dateLine(c.startedAt)}</p>
        <div class="card-rows">
          <span>Глубина фокуса <b>${Math.round(m.depth * 100)}%</b></span>
          <span>Разрывов <b>${m.breaks}</b></span>
          <span>Слоёв <b>${m.strata}</b></span>
          <span>Дробление <b>${m.fragmentation.toFixed(2)}</b></span>
        </div>
        <button class="card-kill">Удалить</button>
      </div>`;
    grid.appendChild(el);
    paintCore(el.querySelector('canvas'), c, 92, 210);
    el.querySelector('.card-kill').addEventListener('click', () => {
      store.remove(c.id);
      mount(root, 'cores');
    });
  });
  root.appendChild(grid);
}

function mountWeek(root, all) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const wrap = document.createElement('div');
  wrap.className = 'week';
  const buckets = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    const end = d.getTime() + 86400000;
    buckets.push({ d, items: all.filter((c) => c.startedAt >= d.getTime() && c.startedAt < end) });
  }
  const maxDur = Math.max(60000, ...all.map((c) => c.durationMs));
  buckets.forEach((b) => {
    const sum = b.items.reduce((a, c) => a + c.durationMs, 0);
    const col = document.createElement('div');
    col.className = 'day';
    const isToday = b.d.getTime() === today.getTime();
    col.innerHTML = `<p class="day-name${isToday ? ' is-today' : ''}">${DAYS[b.d.getDay()]} ${String(b.d.getDate()).padStart(2, '0')}</p>
      <div class="day-stack"></div>
      <p class="day-sum">${sum ? fmtShort(sum) : '—'}</p>`;
    const stack = col.querySelector('.day-stack');
    b.items
      .slice()
      .sort((a, c) => a.startedAt - c.startedAt)
      .forEach((c) => {
        const cv = document.createElement('canvas');
        stack.appendChild(cv);
        const h = Math.max(42, Math.round(228 * (c.durationMs / maxDur)));
        paintCore(cv, c, 24, h, { pad: 3, frame: 0.12 });
      });
    wrap.appendChild(col);
  });
  root.appendChild(wrap);
}

export function exportPNG(core, index) {
  const W = 680;
  const H = 1120;
  const cv = document.createElement('canvas');
  const dpr = 2;
  cv.width = W * dpr;
  cv.height = H * dpr;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = PAL.ink;
  ctx.fillRect(0, 0, W, H);

  const inner = document.createElement('canvas');
  paintCore(inner, core, 150, 800, { pad: 0, frame: 0 });
  ctx.drawImage(inner, 96, 180, 150, 800);
  ctx.strokeStyle = rgba(PAL.bone, 0.2);
  ctx.lineWidth = 1;
  ctx.strokeRect(89.5, 173.5, 163, 813);

  const m = metricsOf(core.layers, core.durationMs);
  const mono = (s, size, a, x, y, ls = 0) => {
    ctx.font = `400 ${size}px "IBM Plex Mono", monospace`;
    ctx.fillStyle = rgba(PAL.bone, a);
    if (!ls) { ctx.fillText(s, x, y); return; }
    let cx = x;
    for (const ch of s) { ctx.fillText(ch, cx, y); cx += ctx.measureText(ch).width + ls; }
  };
  mono('СЛОИ ВНИМАНИЯ', 11, 0.5, 96, 92, 3.4);
  ctx.font = '300 54px "Cormorant Garamond", Georgia, serif';
  ctx.fillStyle = PAL.bone;
  ctx.fillText(`Керн № ${String(index).padStart(3, '0')}`, 300, 236);
  mono(dateLine(core.startedAt).toUpperCase(), 11, 0.42, 302, 268, 1.6);

  const rows = [
    ['ДЛИТЕЛЬНОСТЬ', fmt(core.durationMs)],
    ['ГЛУБИНА ФОКУСА', Math.round(m.depth * 100) + '%'],
    ['РАЗРЫВОВ', String(m.breaks)],
    ['СЛОЁВ', String(m.strata)],
    ['ДЛИННЕЙШИЙ СЛОЙ', fmt(m.longest)],
    ['ИНДЕКС ДРОБЛЕНИЯ', m.fragmentation.toFixed(2)],
    ['ДЫМКА ВОЗВРАЩЕНИЯ', fmt(m.residueMs)]
  ];
  let y = 330;
  rows.forEach(([k, v]) => {
    ctx.strokeStyle = rgba(PAL.bone, 0.1);
    ctx.beginPath();
    ctx.moveTo(302, y + 14);
    ctx.lineTo(W - 96, y + 14);
    ctx.stroke();
    mono(k, 9.5, 0.4, 302, y, 1.8);
    ctx.font = '400 13px "IBM Plex Mono", monospace';
    ctx.fillStyle = rgba(PAL.bone, 0.9);
    ctx.textAlign = 'right';
    ctx.fillText(v, W - 96, y + 1);
    ctx.textAlign = 'left';
    y += 44;
  });

  ctx.font = 'italic 300 19px "Cormorant Garamond", Georgia, serif';
  ctx.fillStyle = rgba(PAL.bone, 0.7);
  wrapText(ctx, readingOf(m), 302, y + 34, W - 398, 26);
  mono('ЛОКАЛЬНАЯ ЗАПИСЬ · ДАННЫЕ НЕ ПОКИДАЛИ БРАУЗЕР', 9, 0.3, 96, H - 64, 2);

  const a = document.createElement('a');
  a.download = `kern-${String(index).padStart(3, '0')}.png`;
  a.href = cv.toDataURL('image/png');
  a.click();
}

function wrapText(ctx, text, x, y, maxW, lh) {
  const words = text.split(' ');
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, y);
      y += lh;
      line = w;
    } else line = test;
  }
  ctx.fillText(line, x, y);
}
