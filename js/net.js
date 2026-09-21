const BEAT_MS = 3000;

export class Presence {
  constructor(onPeers) {
    this.onPeers = onPeers;
    this.es = null;
    this.timer = null;
    this.state = null;
    this.room = '';
    this.id = '';
    this.live = false;
    this.joined = false;
  }

  async probe() {
    try {
      const ctl = new AbortController();
      const kill = setTimeout(() => ctl.abort(), 1800);
      const r = await fetch('presence/health', { cache: 'no-store', signal: ctl.signal });
      clearTimeout(kill);
      if (!r.ok) return false;
      const j = await r.json();
      this.live = !!j.ok;
      return this.live;
    } catch {
      this.live = false;
      return false;
    }
  }

  join(room, id, state) {
    if (!this.live || this.joined) return;
    this.room = room;
    this.id = id;
    this.state = { ...state };
    this.joined = true;
    const url = `presence/stream?room=${encodeURIComponent(room)}&id=${encodeURIComponent(id)}`;
    this.es = new EventSource(url);
    this.es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        this.onPeers(data.peers || []);
      } catch {}
    };
    this.es.onerror = () => {
      if (this.es && this.es.readyState === 2) this.leave();
    };
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
    fetch('presence/state', {
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
      fetch('presence/state', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ room: this.room, id: this.id, bye: true }),
        keepalive: true
      }).catch(() => {});
    }
    this.joined = false;
    this.onPeers([]);
  }
}
