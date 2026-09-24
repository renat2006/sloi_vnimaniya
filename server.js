const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT ? +process.env.PORT : 4173;
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.SLOI_DB || path.join(__dirname, 'sloi.db');
const ROOT = __dirname;

const EPOCH = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const STALE_SOFT_MS = 12000;
const STALE_MS = 25000;
const MAX_ROOMS = 64;
const MAX_PEERS = 120;
const MAX_CLIENTS = 240;
const FEED_LIMIT = 60;
const PING_MS = 10000;
const COALESCE_MS = 400;

/* ── rate-limit (token bucket per IP) ─────────────────────── */
const buckets = new Map();
const RATE = { presence: { cap: 300, per: 10000 }, cores: { cap: 12, per: 10000 }, push: { cap: 30, per: 10000 } };
function rateOk(ip, kind) {
  const key = ip + ':' + kind;
  const cfg = RATE[kind] || RATE.presence;
  let b = buckets.get(key);
  const now = Date.now();
  if (!b) { b = { tokens: cfg.cap, ts: now }; buckets.set(key, b); }
  const elapsed = now - b.ts;
  b.tokens = Math.min(cfg.cap, b.tokens + (elapsed / cfg.per) * cfg.cap);
  b.ts = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
setInterval(() => {
  const cutoff = Date.now() - 60000;
  for (const [k, b] of buckets) { if (b.ts < cutoff) buckets.delete(k); }
}, 30000);

/* ── peer key store (identity protection) ─────────────────── */
const peerKeys = new Map();

/* ── input validation ─────────────────────────────────────── */
const RE_SAFE = /^[\w\-]{1,40}$/;
const validId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 40 && RE_SAFE.test(v);
const validKey = (v) => typeof v === 'string' && v.length > 0 && v.length <= 24 && RE_SAFE.test(v);

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS cores (
    id TEXT PRIMARY KEY,
    room TEXT NOT NULL,
    author TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    capacity_ms INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    depth REAL NOT NULL,
    breaks INTEGER NOT NULL,
    transitions INTEGER NOT NULL,
    fragmentation REAL NOT NULL,
    layers TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS cores_room ON cores (room, created_at DESC);
  CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    room TEXT NOT NULL,
    kind TEXT NOT NULL,
    who TEXT NOT NULL,
    detail TEXT,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_room ON events (room, seq);
  CREATE TABLE IF NOT EXISTS kv (
    k TEXT PRIMARY KEY,
    v TEXT
  );
  CREATE TABLE IF NOT EXISTS push_subs (
    endpoint TEXT PRIMARY KEY,
    p256dh TEXT,
    auth TEXT,
    end_at INTEGER NOT NULL,
    created INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS push_subs_end ON push_subs (end_at);
`);

const qInsertCore = db.prepare(
  `INSERT OR REPLACE INTO cores
   (id, room, author, started_at, capacity_ms, duration_ms, depth, breaks, transitions, fragmentation, layers, created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
);
const qRecentCores = db.prepare(
  `SELECT id, author, started_at, capacity_ms, duration_ms, depth, breaks, transitions, fragmentation, layers
   FROM cores WHERE room = ? ORDER BY created_at DESC LIMIT ?`
);
const qInsertEvent = db.prepare(
  `INSERT INTO events (room, kind, who, detail, at) VALUES (?,?,?,?,?)`
);
const qEventsSince = db.prepare(
  `SELECT seq, kind, who, detail, at FROM events WHERE room = ? AND seq > ? ORDER BY seq LIMIT 200`
);
const qEventsTail = db.prepare(
  `SELECT seq, kind, who, detail, at FROM events WHERE room = ? ORDER BY seq DESC LIMIT ?`
);
const qTrimEvents = db.prepare(
  `DELETE FROM events WHERE room = ? AND seq <= (
     SELECT seq FROM events WHERE room = ? ORDER BY seq DESC LIMIT 1 OFFSET 400
   )`
);

/* ── push subscriptions & VAPID key store ─────────────────── */
const qGetKv = db.prepare('SELECT v FROM kv WHERE k = ?');
const qSetKv = db.prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)');
const qCountSubs = db.prepare('SELECT count(*) AS c FROM push_subs');
const qGetSub = db.prepare('SELECT endpoint FROM push_subs WHERE endpoint = ?');
const qUpsertSub = db.prepare(`
  INSERT INTO push_subs (endpoint, p256dh, auth, end_at, created)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(endpoint) DO UPDATE SET
    p256dh = excluded.p256dh,
    auth = excluded.auth,
    end_at = excluded.end_at
`);
const qDeleteSub = db.prepare('DELETE FROM push_subs WHERE endpoint = ?');
const qSelectDueSubs = db.prepare('SELECT endpoint FROM push_subs WHERE end_at <= ? LIMIT 20');

// Очистка при старте: подписки с end_at старше 1 суток
try {
  const oneDayAgo = Date.now() - 24 * 3600 * 1000;
  db.prepare('DELETE FROM push_subs WHERE end_at < ?').run(oneDayAgo);
} catch (err) {
  console.warn('cleanup stale push_subs failed:', err.message);
}

// Инициализация VAPID (генерация при первом старте, сохранение в kv)
let vapidPublicKey = qGetKv.get('vapid_public')?.v;
let vapidPrivateKeyPem = qGetKv.get('vapid_private')?.v;
let vapidPrivateKey;

if (!vapidPublicKey || !vapidPrivateKeyPem) {
  const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwkPub = kp.publicKey.export({ format: 'jwk' });
  const rawPub = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwkPub.x, 'base64url'),
    Buffer.from(jwkPub.y, 'base64url')
  ]);
  vapidPublicKey = rawPub.toString('base64url');
  vapidPrivateKeyPem = kp.privateKey.export({ type: 'pkcs8', format: 'pem' });
  qSetKv.run('vapid_public', vapidPublicKey);
  qSetKv.run('vapid_private', vapidPrivateKeyPem);
  vapidPrivateKey = kp.privateKey;
} else {
  vapidPrivateKey = crypto.createPrivateKey(vapidPrivateKeyPem);
}

function sendPush(endpoint) {
  return new Promise((resolve) => {
    try {
      const url = new URL(endpoint);
      const isHttps = url.protocol === 'https:';
      const transport = isHttps ? https : http;
      const nowSec = Math.floor(Date.now() / 1000);
      const aud = url.origin;
      const exp = nowSec + 12 * 3600;
      const sub = process.env.SLOI_VAPID_SUB || 'mailto:admin@sloi.renat.site';

      const headerB64 = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
      const claimsB64 = Buffer.from(JSON.stringify({ aud, exp, sub })).toString('base64url');
      const signingInput = `${headerB64}.${claimsB64}`;
      const sigB64 = crypto.sign('sha256', Buffer.from(signingInput), {
        key: vapidPrivateKey,
        dsaEncoding: 'ieee-p1363'
      }).toString('base64url');
      const jwt = `${signingInput}.${sigB64}`;

      const req = transport.request({
        method: 'POST',
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          'Authorization': `vapid t=${jwt}, k=${vapidPublicKey}`,
          'TTL': '3600',
          'Urgency': 'high',
          'Content-Length': '0'
        },
        timeout: 8000
      }, (res) => {
        res.resume();
        if (res.statusCode !== 200 && res.statusCode !== 201 && res.statusCode !== 202 &&
            res.statusCode !== 404 && res.statusCode !== 410) {
          console.warn(`push send status ${res.statusCode} (${url.hostname})`);
        }
        resolve();
      });

      req.on('timeout', () => {
        req.destroy(new Error('timeout'));
      });

      req.on('error', (err) => {
        console.warn(`push network error (${url.hostname}): ${err.message}`);
        resolve();
      });

      req.end();
    } catch (err) {
      console.warn(`push error: ${err.message}`);
      resolve();
    }
  });
}

const PUSH_HOSTS = /(^|\.)(googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;
let pushBusy = false;
setInterval(async () => {
  if (pushBusy) return;
  pushBusy = true;
  try {
    const now = Date.now();
    const due = qSelectDueSubs.all(now);
    if (due.length > 0) {
      for (const s of due) {
        try {
          qDeleteSub.run(s.endpoint);
        } catch {}
      }
      await Promise.allSettled(due.map((s) => sendPush(s.endpoint)));
    }
  } catch (err) {
    console.warn('push tick error:', err.message);
  } finally {
    pushBusy = false;
  }
}, 10000);

const rooms = new Map();

function room(name) {
  if (!rooms.has(name)) {
    if (rooms.size >= MAX_ROOMS) return null;
    rooms.set(name, { peers: new Map(), clients: new Set() });
  }
  return rooms.get(name);
}

function send(res, { event, id, data }) {
  try {
    if (res.writableEnded || res.destroyed) return false;
    let chunk = '';
    if (id != null) chunk += `id: ${id}\n`;
    if (event) chunk += `event: ${event}\n`;
    chunk += `data: ${JSON.stringify(data)}\n\n`;
    res.write(chunk);
    return true;
  } catch {
    return false;
  }
}

function peersOf(r) {
  return [...r.peers.values()].map((p) => ({
    id: p.id,
    name: p.name,
    fill: p.fill,
    mode: p.mode,
    strata: p.strata,
    status: p.status || 'live'
  }));
}

const coalescePending = new Map();
function pushPeers(name) {
  if (coalescePending.has(name)) return;
  coalescePending.set(name, setTimeout(() => {
    coalescePending.delete(name);
    const r = rooms.get(name);
    if (!r) return;
    const data = { peers: peersOf(r) };
    for (const res of r.clients) {
      if (!send(res, { event: 'peers', data })) r.clients.delete(res);
    }
  }, COALESCE_MS));
}
function pushPeersNow(name) {
  if (coalescePending.has(name)) {
    clearTimeout(coalescePending.get(name));
    coalescePending.delete(name);
  }
  const r = rooms.get(name);
  if (!r) return;
  const data = { peers: peersOf(r) };
  for (const res of r.clients) {
    if (!send(res, { event: 'peers', data })) r.clients.delete(res);
  }
}

function logEvent(name, kind, who, detail) {
  const at = Date.now();
  const info = qInsertEvent.run(name, kind, who, detail ?? null, at);
  const seq = Number(info.lastInsertRowid);
  const r = rooms.get(name);
  if (r) {
    const data = { seq, kind, who, detail: detail ?? null, at };
    for (const res of r.clients) {
      if (!send(res, { event: 'log', id: seq, data })) r.clients.delete(res);
    }
  }
  if (seq % 50 === 0) {
    try {
      qTrimEvents.run(name, name);
    } catch {}
  }
  return seq;
}

setInterval(() => {
  const now = Date.now();
  for (const [name, r] of rooms) {
    let changed = false;
    let gone = [];
    for (const [id, p] of r.peers) {
      const age = now - p.ts;
      if (age > STALE_MS) {
        r.peers.delete(id);
        peerKeys.delete(name + ':' + id);
        gone.push(p);
      } else if (age > STALE_SOFT_MS && p.status !== 'stale') {
        p.status = 'stale';
        changed = true;
      }
    }
    if (gone.length) {
      changed = true;
      gone.forEach((p) => logEvent(name, 'leave', p.name,
        JSON.stringify({ reason: 'timeout' })));
    }
    if (changed) pushPeers(name);
    if (!r.peers.size && !r.clients.size) rooms.delete(name);
  }
}, 4000);

const STATIC_OK = /^\/(index\.html|styles\.css|sw\.js|manifest\.webmanifest|download\/index\.html|\.well-known\/assetlinks\.json|js\/[\w.-]+\.js|icons\/[\w.-]+\.(png|svg|ico))$/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, last-event-id'
};

function json(res, code, body) {
  res.writeHead(code, { ...CORS, 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 60000) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > limit) {
        req.destroy();
        reject(new Error('too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const clean = (v, max) => String(v ?? '').slice(0, max);
const num = (v, lo, hi, dflt = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

function clientIp(req) {
  if (req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1') {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return fwd.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '0.0.0.0';
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, 'http://localhost');
  const route = parsed.pathname;
  const query = Object.fromEntries(parsed.searchParams);

  if ((route.startsWith('/presence/') || route.startsWith('/push/') || route === '/cores') && req.method === 'OPTIONS') {
    res.writeHead(204, { ...CORS, 'access-control-max-age': '86400' });
    res.end();
    return;
  }

  if (route === '/presence/health') {
    json(res, 200, { ok: true, rooms: rooms.size, store: 'sqlite' });
    return;
  }

  if (route === '/presence/stream') {
    const name = clean(query.room || 'зал', 40);
    const r = room(name);
    if (!r || r.clients.size >= MAX_CLIENTS) {
      json(res, 503, { ok: false });
      return;
    }
    res.writeHead(200, {
      ...CORS,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      connection: 'keep-alive'
    });
    res.write('retry: 30000\n\n');
    r.clients.add(res);

    send(res, { event: 'hello', data: { epoch: EPOCH, pingMs: PING_MS, staleMs: STALE_MS } });

    const lastId = Number(req.headers['last-event-id'] || query.since || 0);
    if (lastId > 0) {
      for (const row of qEventsSince.all(name, lastId)) {
        send(res, { event: 'log', id: row.seq, data: row });
      }
    } else {
      const tail = qEventsTail.all(name, FEED_LIMIT).reverse();
      send(res, { event: 'backlog', data: { events: tail } });
    }
    send(res, { event: 'peers', data: { peers: peersOf(r) } });

    const beat = setInterval(() => {
      try {
        if (res.writableEnded || res.destroyed) { cleanup(); return; }
        res.write(': beat\n\n');
        send(res, { event: 'hb', data: '' });
      } catch { cleanup(); }
    }, PING_MS);

    const cleanup = () => {
      clearInterval(beat);
      r.clients.delete(res);
    };
    res.on('error', cleanup);
    res.on('close', cleanup);
    req.on('close', cleanup);
    return;
  }

  if (route === '/presence/state' && req.method === 'POST') {
    const ip = clientIp(req);
    if (!rateOk(ip, 'presence')) { json(res, 429, { ok: false }); return; }
    try {
      const raw = await readBody(req, 4000);
      const d = JSON.parse(raw);
      const name = clean(d.room || 'зал', 40);
      const r = room(name);
      const id = clean(d.id, 40);
      if (!id || !r || !validId(id)) return json(res, 400, { ok: false });

      /* key protection */
      const keySlot = name + ':' + id;
      const incomingKey = (typeof d.key === 'string' && validKey(d.key)) ? d.key : null;
      const storedKey = peerKeys.get(keySlot);
      if (storedKey) {
        if (incomingKey !== storedKey) return json(res, 403, { ok: false });
      } else if (incomingKey) {
        peerKeys.set(keySlot, incomingKey);
      }

      /* cseq ordering */
      const prev = r.peers.get(id);
      if (d.cseq != null && prev && prev.cseq != null) {
        if (Number(d.cseq) <= prev.cseq) {
          res.writeHead(204, CORS); return res.end();
        }
      }

      if (d.bye) {
        const p = r.peers.get(id);
        r.peers.delete(id);
        peerKeys.delete(keySlot);
        pushPeers(name);
        if (p) logEvent(name, 'leave', p.name, JSON.stringify({ reason: 'bye' }));
        res.writeHead(204, CORS);
        return res.end();
      }

      if (!prev && r.peers.size >= MAX_PEERS) return json(res, 503, { ok: false });
      const wasStale = prev && prev.status === 'stale';
      const isReturn = !prev && peerKeys.has(keySlot);
      const peer = {
        id,
        name: clean(d.name || 'Гость', 32),
        fill: num(d.fill, 0, 1),
        mode: ['drift', 'done', 'focus'].includes(d.mode) ? d.mode : 'focus',
        strata: num(d.strata, 1, 999, 1),
        status: 'live',
        ts: Date.now(),
        cseq: d.cseq != null ? Number(d.cseq) : null,
        lastBroadcastFill: prev ? prev.lastBroadcastFill : null
      };
      r.peers.set(id, peer);

      /* определяем, нужен ли бродкаст peers */
      let significant = false;
      if (!prev) {
        significant = true;
        logEvent(name, 'join', peer.name, null);
      } else if (wasStale) {
        significant = true;
        /* вернулся из stale — молча, без join */
      } else if (prev.mode !== peer.mode) {
        significant = true;
        if (peer.mode !== 'done') {
          logEvent(name, peer.mode === 'drift' ? 'rupture' : 'resume', peer.name, null);
        }
      } else if (prev.status !== peer.status) {
        significant = true;
      } else {
        const fillDelta = Math.abs(peer.fill - (prev.lastBroadcastFill ?? prev.fill));
        if (fillDelta >= 0.03) significant = true;
      }

      if (significant) {
        peer.lastBroadcastFill = peer.fill;
        pushPeers(name);
      }

      res.writeHead(204, CORS);
      res.end();
    } catch {
      json(res, 400, { ok: false });
    }
    return;
  }

  if (route === '/cores' && req.method === 'POST') {
    const ip = clientIp(req);
    if (!rateOk(ip, 'cores')) { json(res, 429, { ok: false }); return; }
    try {
      const d = JSON.parse(await readBody(req));
      const name = clean(d.room || 'зал', 40);
      const layers = Array.isArray(d.layers) ? d.layers.slice(0, 400) : null;
      if (!layers || !layers.length) return json(res, 400, { ok: false });
      const core = {
        id: clean(d.id, 64) || 'c' + Date.now().toString(36),
        author: clean(d.author || 'Гость', 32),
        started_at: num(d.startedAt, 0, 4e12),
        capacity_ms: num(d.capacityMs, 1000, 4 * 3600e3),
        duration_ms: num(d.durationMs, 1000, 4 * 3600e3),
        depth: num(d.depth, 0, 1),
        breaks: num(d.breaks, 0, 999),
        transitions: num(d.transitions, 0, 999),
        fragmentation: num(d.fragmentation, 0, 1),
        layers: JSON.stringify(
          layers.map((l) => ({
            type: ['focus', 'permitted', 'drift'].includes(l.type) ? l.type : 'focus',
            start: num(l.start, 0, 4 * 3600e3),
            end: num(l.end, 0, 4 * 3600e3)
          }))
        )
      };
      qInsertCore.run(
        core.id, name, core.author, core.started_at, core.capacity_ms, core.duration_ms,
        core.depth, core.breaks, core.transitions, core.fragmentation, core.layers, Date.now()
      );
      const seq = logEvent(name, 'core', core.author, JSON.stringify({
        id: core.id,
        durationMs: core.duration_ms,
        depth: core.depth,
        breaks: core.breaks
      }));
      json(res, 200, { ok: true, seq });
    } catch {
      json(res, 400, { ok: false });
    }
    return;
  }

  if (route === '/cores') {
    const name = clean(query.room || 'зал', 40);
    const limit = num(query.limit, 1, 60, 24);
    const rows = qRecentCores.all(name, limit).map((r) => ({
      id: r.id,
      author: r.author,
      startedAt: r.started_at,
      capacityMs: r.capacity_ms,
      durationMs: r.duration_ms,
      metrics: {
        depth: r.depth,
        breaks: r.breaks,
        transitions: r.transitions,
        fragmentation: r.fragmentation
      },
      layers: JSON.parse(r.layers)
    }));
    json(res, 200, { cores: rows });
    return;
  }

  if (route === '/push/key' && req.method === 'GET') {
    json(res, 200, { key: vapidPublicKey });
    return;
  }

  if (route === '/push/subscribe' && req.method === 'POST') {
    const ip = clientIp(req);
    if (!rateOk(ip, 'push')) { json(res, 429, { ok: false }); return; }
    try {
      const raw = await readBody(req, 8000);
      const d = JSON.parse(raw);
      const sub = d.subscription;
      const endpoint = typeof sub?.endpoint === 'string' ? sub.endpoint.trim() : '';
      if (!endpoint || endpoint.length > 500) {
        return json(res, 400, { ok: false });
      }
      try {
        const u = new URL(endpoint);
        if (u.protocol !== 'https:' || !PUSH_HOSTS.test(u.hostname)) return json(res, 400, { ok: false });
      } catch {
        return json(res, 400, { ok: false });
      }

      const now = Date.now();
      const endAt = Number(d.endAt);
      if (!Number.isFinite(endAt) || endAt <= now || endAt > now + 12 * 3600 * 1000) {
        return json(res, 400, { ok: false });
      }

      const p256dh = clean(sub.keys?.p256dh, 200);
      const auth = clean(sub.keys?.auth, 100);

      const countRow = qCountSubs.get();
      if (countRow && countRow.c >= 2000) {
        const existing = qGetSub.get(endpoint);
        if (!existing) return json(res, 503, { ok: false });
      }

      qUpsertSub.run(endpoint, p256dh, auth, endAt, now);
      json(res, 200, { ok: true });
    } catch {
      json(res, 400, { ok: false });
    }
    return;
  }

  if (route === '/push/cancel' && req.method === 'POST') {
    const ip = clientIp(req);
    if (!rateOk(ip, 'push')) { json(res, 429, { ok: false }); return; }
    try {
      const raw = await readBody(req, 2000);
      const d = JSON.parse(raw);
      const endpoint = typeof d.endpoint === 'string' ? d.endpoint.trim() : '';
      if (endpoint && endpoint.length <= 500) {
        qDeleteSub.run(endpoint);
      }
      json(res, 200, { ok: true });
    } catch {
      json(res, 400, { ok: false });
    }
    return;
  }

  if (route.startsWith('/push/')) {
    json(res, 404, { ok: false });
    return;
  }

  if (route === '/download') {
    res.writeHead(301, { location: '/download/' });
    return res.end();
  }
  let rel;
  try {
    rel = decodeURIComponent(route === '/' ? '/index.html' : route === '/download/' ? '/download/index.html' : route);
  } catch { rel = ''; }
  if (!STATIC_OK.test(rel)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('нет такой страницы');
  }
  const file = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('нет такой страницы');
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.png' ? 'public, max-age=604800' : 'no-cache',
      ...(file.endsWith('sw.js') ? { 'service-worker-allowed': '/' } : {})
    });
    res.end(buf);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Слои внимания · http://localhost:${PORT}`);
  console.log(`база: ${DB_PATH}`);
});
