// A live session has one writer, even while that writer is in the background.
// Web Locks are held until release/page teardown. Older browsers use a fenced
// lease; a waking tab must check it before touching the session or reminders.
export class SessionOwner {
  constructor({ locks = globalThis.navigator?.locks, storage = globalThis.localStorage,
    id, now = () => Date.now() } = {}) {
    this.locks = locks;
    this.storage = storage;
    this.id = id;
    this.now = now;
    this.key = 'sloi.session-owner.v1';
    this.held = false;
    this.unlock = null;
  }

  read() {
    try { return JSON.parse(this.storage.getItem(this.key)); } catch { return null; }
  }

  async acquire() {
    if (this.owns()) return true;
    if (this.locks) {
      return new Promise((resolve) => {
        this.locks.request(this.key, { ifAvailable: true }, async (lock) => {
          if (!lock) { resolve(false); return; }
          this.held = true;
          const untilReleased = new Promise((done) => { this.unlock = done; });
          resolve(true);
          await untilReleased;
        }).catch(() => resolve(false));
      });
    }
    const lease = this.read();
    if (lease && lease.id !== this.id && lease.until > this.now()) return false;
    try {
      this.storage.setItem(this.key, JSON.stringify({ id: this.id, until: this.now() + 20000 }));
    } catch { return false; }
    this.held = this.read()?.id === this.id;
    return this.held;
  }

  owns() {
    return this.held && (!!this.locks || this.read()?.id === this.id);
  }

  touch() {
    if (!this.owns()) return false;
    if (!this.locks) {
      try { this.storage.setItem(this.key, JSON.stringify({ id: this.id, until: this.now() + 20000 })); }
      catch { return false; }
    }
    return true;
  }

  release() {
    if (!this.locks && this.owns()) {
      try { this.storage.removeItem(this.key); } catch {}
    }
    this.held = false;
    const unlock = this.unlock;
    this.unlock = null;
    if (unlock) unlock();
  }
}
