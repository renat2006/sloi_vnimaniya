import { endpoint } from './config.js';

const BEAT_MS = 3000;

export class Presence {
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.es = null;
    this.timer = null;
    this.state = null;
    this.room = '';
    this.id = '';
    this.live = false;
    this.joined = false;
    this.status = 'offline';
    this.peers = [];
    this.feed = [];
  }

  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.hooks.onStatus && this.hooks.onStatus(s);
  }

  async probe() {
    try {
      const ctl = new AbortController();
      const kill = setTimeout(() => ctl.abort(), 2500);
      const r = await fetch(endpoint('presence/health'), { cache: 'no-store', signal: ctl.signal });
      clearTimeout(kill);
      this.live = r.ok && (await r.json()).ok === true;
    } catch {
      this.live = false;
    }
    return this.live;
  }

  join(room, id, state) {
    if (!this.live || this.joined) return;
    this.room = room;
    this.id = id;
    this.state = { ...state };
    this.joined = true;
    this.setStatus('connecting');

    const url = endpoint(
      `presence/stream?room=${encodeURIComponent(room)}&id=${encodeURIComponent(id)}`
    );
    const es = new EventSource(url);
    this.es = es;

    es.onopen = () => this.setStatus('live');
    es.onerror = () => {
      if (!this.joined) return;
      this.setStatus(es.readyState === 2 ? 'offline' : 'connecting');
    };
    es.addEventListener('peers', (e) => {
      try {
        this.peers = JSON.parse(e.data).peers || [];
        this.setStatus('live');
        this.hooks.onPeers && this.hooks.onPeers(this.peers);
      } catch {}
    });
    es.addEventListener('backlog', (e) => {
      try {
        this.feed = JSON.parse(e.data).events || [];
        this.hooks.onFeed && this.hooks.onFeed(this.feed, null);
      } catch {}
    });
    es.addEventListener('log', (e) => {
      try {
        const ev = JSON.parse(e.data);
        this.feed = [...this.feed, ev].slice(-80);
        this.hooks.onFeed && this.hooks.onFeed(this.feed, ev);
      } catch {}
    });

    this.push();
    this.timer = setInterval(() => this.push(), BEAT_MS);
  }

  set(patch) {
    if (!this.joined) return;
    const next = { ...this.state, ...patch };
    const changed = JSON.stringify(next) !== JSON.stringify(this.state);
    this.state = next;
    if (changed) this.push();
  }

  push() {
    if (!this.joined) return;
    fetch(endpoint('presence/state'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ room: this.room, id: this.id, ...this.state }),
      keepalive: true
    }).catch(() => {});
  }

  leave() {
    if (this.es) this.es.close();
    this.es = null;
    clearInterval(this.timer);
    this.timer = null;
    if (this.joined) {
      fetch(endpoint('presence/state'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ room: this.room, id: this.id, bye: true }),
        keepalive: true
      }).catch(() => {});
    }
    this.joined = false;
    this.peers = [];
    this.setStatus('offline');
    this.hooks.onPeers && this.hooks.onPeers([]);
  }

  async publish(core, author) {
    if (!this.live) return false;
    try {
      const r = await fetch(endpoint('cores'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          room: this.room || 'зал',
          id: core.id,
          author,
          startedAt: core.startedAt,
          capacityMs: core.capacityMs,
          durationMs: core.durationMs,
          depth: core.metrics.depth,
          breaks: core.metrics.breaks,
          transitions: core.metrics.transitions,
          fragmentation: core.metrics.fragmentation,
          layers: core.layers
        })
      });
      return r.ok;
    } catch {
      return false;
    }
  }

  async shared(room, limit = 18) {
    if (!this.live) return [];
    try {
      const r = await fetch(
        endpoint(`cores?room=${encodeURIComponent(room)}&limit=${limit}`),
        { cache: 'no-store' }
      );
      if (!r.ok) return [];
      return (await r.json()).cores || [];
    } catch {
      return [];
    }
  }
}
