const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT ? +process.env.PORT : 4173;
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.SLOI_DB || path.join(__dirname, 'sloi.db');
const ROOT = __dirname;

const STALE_MS = 12000;
const MAX_ROOMS = 64;
const MAX_PEERS = 120;
const MAX_CLIENTS = 240;
const FEED_LIMIT = 60;

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

const rooms = new Map();

function room(name) {
  if (!rooms.has(name)) {
    if (rooms.size >= MAX_ROOMS) return null;
    rooms.set(name, { peers: new Map(), clients: new Set() });
  }
  return rooms.get(name);
}

function send(res, { event, id, data }) {
  let chunk = '';
  if (id != null) chunk += `id: ${id}\n`;
  if (event) chunk += `event: ${event}\n`;
  chunk += `data: ${JSON.stringify(data)}\n\n`;
  res.write(chunk);
}

function peersOf(r) {
  return [...r.peers.values()].map((p) => ({
    id: p.id,
    name: p.name,
    fill: p.fill,
    mode: p.mode,
    strata: p.strata
  }));
}

function pushPeers(name) {
  const r = rooms.get(name);
  if (!r) return;
  const data = { peers: peersOf(r) };
  for (const res of r.clients) send(res, { event: 'peers', data });
}

function logEvent(name, kind, who, detail) {
  const at = Date.now();
  const info = qInsertEvent.run(name, kind, who, detail ?? null, at);
  const seq = Number(info.lastInsertRowid);
  const r = rooms.get(name);
  if (r) {
    const data = { seq, kind, who, detail: detail ?? null, at };
    for (const res of r.clients) send(res, { event: 'log', id: seq, data });
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
    let gone = [];
    for (const [id, p] of r.peers) {
      if (now - p.ts > STALE_MS) {
        r.peers.delete(id);
        gone.push(p);
      }
    }
    if (gone.length) {
      pushPeers(name);
      gone.forEach((p) => logEvent(name, 'leave', p.name, null));
    }
    if (!r.peers.size && !r.clients.size) rooms.delete(name);
  }
}, 4000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
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

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const route = parsed.pathname;

  if (route.startsWith('/presence/') && req.method === 'OPTIONS') {
    res.writeHead(204, { ...CORS, 'access-control-max-age': '86400' });
    res.end();
    return;
  }

  if (route === '/presence/health') {
    json(res, 200, { ok: true, rooms: rooms.size, store: 'sqlite' });
    return;
  }

  if (route === '/presence/stream') {
    const name = clean(parsed.query.room || 'зал', 40);
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
    res.write('retry: 3000\n\n');
    r.clients.add(res);

    const lastId = Number(req.headers['last-event-id'] || parsed.query.since || 0);
    if (lastId > 0) {
      for (const row of qEventsSince.all(name, lastId)) {
        send(res, { event: 'log', id: row.seq, data: row });
      }
    } else {
      const tail = qEventsTail.all(name, FEED_LIMIT).reverse();
      send(res, { event: 'backlog', data: { events: tail } });
    }
    send(res, { event: 'peers', data: { peers: peersOf(r) } });

    const beat = setInterval(() => res.write(': beat\n\n'), 20000);
    req.on('close', () => {
      clearInterval(beat);
      r.clients.delete(res);
    });
    return;
  }

  if (route === '/presence/state' && req.method === 'POST') {
    try {
      const d = JSON.parse(await readBody(req, 4000));
      const name = clean(d.room || 'зал', 40);
      const r = room(name);
      const id = clean(d.id, 40);
      if (!id || !r) return json(res, 400, { ok: false });

      if (d.bye) {
        const p = r.peers.get(id);
        r.peers.delete(id);
        pushPeers(name);
        if (p) logEvent(name, 'leave', p.name, null);
        res.writeHead(204, CORS);
        return res.end();
      }

      const prev = r.peers.get(id);
      if (!prev && r.peers.size >= MAX_PEERS) return json(res, 503, { ok: false });
      const peer = {
        id,
        name: clean(d.name || 'Гость', 32),
        fill: num(d.fill, 0, 1),
        mode: ['drift', 'done', 'focus'].includes(d.mode) ? d.mode : 'focus',
        strata: num(d.strata, 1, 999, 1),
        ts: Date.now()
      };
      r.peers.set(id, peer);
      pushPeers(name);

      if (!prev) logEvent(name, 'join', peer.name, null);
      else if (prev.mode !== peer.mode && peer.mode !== 'done') {
        logEvent(name, peer.mode === 'drift' ? 'rupture' : 'resume', peer.name, null);
      }
      res.writeHead(204, CORS);
      res.end();
    } catch {
      json(res, 400, { ok: false });
    }
    return;
  }

  if (route === '/cores' && req.method === 'POST') {
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
    const name = clean(parsed.query.room || 'зал', 40);
    const limit = num(parsed.query.limit, 1, 60, 24);
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

  const rel = decodeURIComponent(route === '/' ? '/index.html' : route);
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
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache'
    });
    res.end(buf);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Слои внимания · http://localhost:${PORT}`);
  console.log(`база: ${DB_PATH}`);
});
