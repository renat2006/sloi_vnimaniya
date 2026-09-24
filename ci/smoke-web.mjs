import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 4599;
const B = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'sloi-'));
const srv = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SLOI_DB: join(dir, 't.db') },
  stdio: 'inherit'
});

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failed++;
};
const post = (p, body, ct = 'application/json') =>
  fetch(B + p, { method: 'POST', headers: { 'content-type': ct }, body: typeof body === 'string' ? body : JSON.stringify(body) });

try {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(B + '/presence/health')).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  check('health', (await fetch(B + '/presence/health')).status === 200);

  for (const p of ['/', '/index.html', '/styles.css', '/sw.js', '/manifest.webmanifest', '/js/app.js', '/js/native.js', '/icons/icon-192.png', '/download/']) {
    const r = await fetch(B + p);
    check(`static ${p}`, r.status === 200, String(r.status));
  }
  for (const p of ['/server.js', '/sloi.db', '/README.md', '/ci/smoke-web.mjs', '/android-app/package.json', '/.github/workflows/ci.yml']) {
    const r = await fetch(B + p);
    check(`закрыто ${p}`, r.status === 404, String(r.status));
  }

  const ctl = new AbortController();
  const events = [];
  fetch(B + '/presence/stream?room=ci&id=watcher', { signal: ctl.signal }).then(async (r) => {
    const rd = r.body.getReader(); const dec = new TextDecoder();
    try { for (;;) { const { value, done } = await rd.read(); if (done) break; events.push(dec.decode(value)); } } catch {}
  });
  await new Promise((r) => setTimeout(r, 400));
  check('presence: новый пир', (await post('/presence/state', { room: 'ci', id: 'pA', name: 'A', fill: 0.1, mode: 'focus', strata: 1, key: 'k1', cseq: 5 })).status === 204);
  check('presence: устаревший cseq игнорируется', (await post('/presence/state', { room: 'ci', id: 'pA', name: 'A', fill: 0.9, mode: 'drift', strata: 1, key: 'k1', cseq: 3 })).status === 204);
  check('presence: чужой ключ → 403', (await post('/presence/state', { room: 'ci', id: 'pA', name: 'X', fill: 0.2, mode: 'focus', strata: 1, key: 'EVIL', cseq: 9 })).status === 403);
  check('presence: sendBeacon (text/plain)', (await post('/presence/state', JSON.stringify({ room: 'ci', id: 'pB', bye: true }), 'text/plain;charset=UTF-8')).status === 204);
  await new Promise((r) => setTimeout(r, 600));
  ctl.abort();
  const all = events.join('');
  check('sse: hello с epoch', /event: hello\ndata: \{"epoch":/.test(all));
  check('sse: peers со статусом', /"status":"live"/.test(all));

  const key = await (await fetch(B + '/push/key')).json();
  check('push: публичный ключ', typeof key.key === 'string' && key.key.length > 80);
  const soon = Date.now() + 300000;
  const bad = await post('/push/subscribe', { subscription: { endpoint: 'https://169.254.169.254/x', keys: {} }, endAt: soon });
  check('push: SSRF-адрес отклонён', bad.status === 400);
  const good = await post('/push/subscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/ci', keys: { p256dh: 'a', auth: 'b' } }, endAt: soon });
  check('push: подписка принимается', good.status === 200);
  check('push: отмена', (await post('/push/cancel', { endpoint: 'https://fcm.googleapis.com/fcm/send/ci' })).status === 200);
} catch (e) {
  console.error(e);
  failed++;
} finally {
  srv.kill();
}
console.log(failed ? `\n${failed} проверок не прошло` : '\nвсе проверки прошли');
process.exit(failed ? 1 : 0);
