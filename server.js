const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT ? +process.env.PORT : 4173;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const STALE_MS = 12000;

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

const rooms = new Map();

function room(name) {
  if (!rooms.has(name)) rooms.set(name, { peers: new Map(), clients: new Set() });
  return rooms.get(name);
}

function snapshot(r) {
  return JSON.stringify({
    peers: [...r.peers.values()].map((p) => ({
      id: p.id,
      name: p.name,
      fill: p.fill,
      mode: p.mode,
      strata: p.strata
    }))
  });
}

function broadcast(name) {
  const r = rooms.get(name);
  if (!r) return;
  const payload = `data: ${snapshot(r)}\n\n`;
  for (const res of r.clients) res.write(payload);
}

setInterval(() => {
  const now = Date.now();
  for (const [name, r] of rooms) {
    let dirty = false;
    for (const [id, p] of r.peers) {
      if (now - p.ts > STALE_MS) {
        r.peers.delete(id);
        dirty = true;
      }
    }
    if (dirty) broadcast(name);
    if (!r.peers.size && !r.clients.size) rooms.delete(name);
  }
}, 4000);

function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('нет такой страницы');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache'
    });
    res.end(buf);
  });
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type'
};

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const route = parsed.pathname;

  if (route.startsWith('/presence/') && req.method === 'OPTIONS') {
    res.writeHead(204, { ...CORS, 'access-control-max-age': '86400' });
    res.end();
    return;
  }

  if (route === '/presence/health') {
    res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }

  if (route === '/presence/stream') {
    const name = String(parsed.query.room || 'зал').slice(0, 40);
    const r = room(name);
    res.writeHead(200, {
      ...CORS,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });
    res.write(`retry: 4000\n\ndata: ${snapshot(r)}\n\n`);
    r.clients.add(res);
    const beat = setInterval(() => res.write(': beat\n\n'), 20000);
    req.on('close', () => {
      clearInterval(beat);
      r.clients.delete(res);
    });
    return;
  }

  if (route === '/presence/state' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 4000) req.destroy();
    });
    req.on('end', () => {
      try {
        const d = JSON.parse(body);
        const name = String(d.room || 'зал').slice(0, 40);
        const r = room(name);
        const id = String(d.id || '').slice(0, 40);
        if (!id) throw new Error('no id');
        if (d.bye) r.peers.delete(id);
        else
          r.peers.set(id, {
            id,
            name: String(d.name || 'Гость').slice(0, 32),
            fill: Math.max(0, Math.min(1, +d.fill || 0)),
            mode: d.mode === 'drift' ? 'drift' : d.mode === 'done' ? 'done' : 'focus',
            strata: Math.max(1, Math.min(999, +d.strata || 1)),
            ts: Date.now()
          });
        broadcast(name);
        res.writeHead(204, CORS);
        res.end();
      } catch {
        res.writeHead(400, CORS);
        res.end();
      }
    });
    return;
  }

  const rel = decodeURIComponent(route === '/' ? '/index.html' : route);
  const file = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    res.end();
    return;
  }
  sendFile(res, file);
});

server.listen(PORT, HOST, () => {
  console.log(`Слои внимания · http://localhost:${PORT}`);
  console.log('зал присутствия включён');
});
