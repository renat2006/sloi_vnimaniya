import { endpoint } from './config.js';

const BEAT_MS = 3000;
const WATCHDOG_MS = 25000;
const BACKOFF_BASE = 1000;
const BACKOFF_MAX = 12000;
const DEGRADED_THRESHOLD = 3;

function makeKey() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16);
}

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

    this._key = makeKey();
    this._cseq = 0;
    this._lastSeq = 0;
    this._epoch = null;
    this._inflight = false;
    this._pendingPush = false;
    this._watchdog = null;
    this._reconnectTimer = null;
    this._backoff = BACKOFF_BASE;
    this._errCount = 0;
    this._seenSeqs = new Set();

    this._onOnline = () => {
      if (this.joined) this._reconnectNow();
    };
    this._onPagehide = () => {
      if (!this.joined) return;
      const body = JSON.stringify({ room: this.room, id: this.id, bye: true, key: this._key });
      try { navigator.sendBeacon(endpoint('presence/state'), body); } catch {
        try { fetch(endpoint('presence/state'), { method: 'POST', body, keepalive: true, headers: { 'content-type': 'application/json' } }); } catch {}
      }
    };
  }

  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.hooks.onStatus && this.hooks.onStatus(s);
  }

  _resetWatchdog() {
    clearTimeout(this._watchdog);
    this._watchdog = setTimeout(() => {
      if (!this.joined) return;
      this._closeEs();
      this._scheduleReconnect();
    }, WATCHDOG_MS);
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    if (!navigator.onLine) { this.setStatus('offline'); return; }
    this.setStatus(this._errCount >= DEGRADED_THRESHOLD ? 'degraded' : 'connecting');
    const jitter = 1 + (Math.random() - 0.5) * 0.6;
    const delay = Math.min(BACKOFF_MAX, this._backoff * jitter);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._backoff = Math.min(BACKOFF_MAX, this._backoff * 2);
      this._connect();
    }, delay);
  }

  _reconnectNow() {
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    this._backoff = BACKOFF_BASE;
    this._closeEs();
    this._connect();
  }

  reconnectNow() {
    if (!this.joined) return;
    this._reconnectNow();
  }

  _closeEs() {
    if (this.es) { this.es.close(); this.es = null; }
    clearTimeout(this._watchdog);
    this._watchdog = null;
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
    this._errCount = 0;
    this._backoff = BACKOFF_BASE;
    this.setStatus('connecting');
    this._connect();
    this.push();
    this.timer = setInterval(() => this.push(), BEAT_MS);
    addEventListener('online', this._onOnline);
    addEventListener('pagehide', this._onPagehide);
  }

  _connect() {
    this._closeEs();
    if (!navigator.onLine) { this.setStatus('offline'); return; }
    this.setStatus(this._errCount >= DEGRADED_THRESHOLD ? 'degraded' : 'connecting');

    let sinceParam = '';
    if (this._lastSeq > 0) sinceParam = `&since=${this._lastSeq}`;
    const url = endpoint(
      `presence/stream?room=${encodeURIComponent(this.room)}&id=${encodeURIComponent(this.id)}${sinceParam}`
    );
    const es = new EventSource(url);
    this.es = es;

    es.onopen = () => {};
    es.onerror = () => {
      if (!this.joined) return;
      this._errCount++;
      this._closeEs();
      this._scheduleReconnect();
    };
    es.addEventListener('hello', (e) => {
      this._resetWatchdog();
      try {
        const d = JSON.parse(e.data);
        const prev = this._epoch;
        this._epoch = d.epoch;
        this.setStatus('live');
        this._backoff = BACKOFF_BASE;
        this._errCount = 0;
        if (prev && prev !== d.epoch) this.push();
      } catch {}
    });
    es.addEventListener('hb', () => {
      this._resetWatchdog();
    });
    es.addEventListener('peers', (e) => {
      this._resetWatchdog();
      try {
        this.peers = JSON.parse(e.data).peers || [];
        this.setStatus('live');
        this._backoff = BACKOFF_BASE;
        this._errCount = 0;
        this.hooks.onPeers && this.hooks.onPeers(this.peers);
      } catch {}
    });
    es.addEventListener('backlog', (e) => {
      this._resetWatchdog();
      try {
        const events = JSON.parse(e.data).events || [];
        this.feed = events;
        for (const ev of events) {
          if (ev.seq != null) {
            this._seenSeqs.add(ev.seq);
            if (ev.seq > this._lastSeq) this._lastSeq = ev.seq;
          }
        }
        this.hooks.onFeed && this.hooks.onFeed(this.feed, null);
      } catch {}
    });
    es.addEventListener('log', (e) => {
      this._resetWatchdog();
      try {
        const ev = JSON.parse(e.data);
        if (ev.seq != null) {
          if (this._seenSeqs.has(ev.seq)) return;
          this._seenSeqs.add(ev.seq);
          if (ev.seq > this._lastSeq) this._lastSeq = ev.seq;
          if (this._seenSeqs.size > 200) {
            const arr = [...this._seenSeqs].sort((a, b) => a - b);
            this._seenSeqs = new Set(arr.slice(-100));
          }
        }
        this.feed = [...this.feed, ev].slice(-80);
        this.hooks.onFeed && this.hooks.onFeed(this.feed, ev);
      } catch {}
    });
    this._resetWatchdog();
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
    if (this._inflight) { this._pendingPush = true; return; }
    this._inflight = true;
    this._cseq++;
    const body = JSON.stringify({
      room: this.room, id: this.id, key: this._key, cseq: this._cseq, ...this.state
    });
    fetch(endpoint('presence/state'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true
    }).then((r) => {
      this._inflight = false;
      if (r && r.status === 403) this._key = makeKey();
      if (this._pendingPush) { this._pendingPush = false; this.push(); }
    }).catch(() => {
      this._inflight = false;
      this._errCount++;
      if (this._errCount >= DEGRADED_THRESHOLD) this.setStatus('degraded');
      if (this._pendingPush) { this._pendingPush = false; this.push(); }
    });
  }

  leave() {
    const wasJoined = this.joined;
    this.joined = false;
    this._closeEs();
    clearInterval(this.timer);
    this.timer = null;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    this._inflight = false;
    this._pendingPush = false;
    removeEventListener('online', this._onOnline);
    removeEventListener('pagehide', this._onPagehide);
    if (wasJoined) {
      fetch(endpoint('presence/state'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ room: this.room, id: this.id, key: this._key, bye: true }),
        keepalive: true
      }).catch(() => {});
    }
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
