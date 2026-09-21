export class Ambience {
  constructor() {
    this.on = false;
    this.ctx = null;
    this.ready = false;
  }

  boot() {
    if (this.ready) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;

    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(ctx.destination);
    this.out = out;

    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.035 * w) / 1.035;
      d[i] = last * 3.2;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2100;
    bp.Q.value = 0.7;

    const hiss = ctx.createGain();
    hiss.gain.value = 0;
    src.connect(bp).connect(hiss).connect(out);
    src.start();
    this.hiss = hiss;
    this.bp = bp;

    const drone = ctx.createGain();
    drone.gain.value = 0.16;
    drone.connect(out);
    this.drone = drone;
    this.oscs = [55, 82.5, 110.3].map((f, i) => {
      const o = ctx.createOscillator();
      o.type = i === 2 ? 'sine' : 'triangle';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = i === 2 ? 0.05 : 0.11;
      o.connect(g).connect(drone);
      o.start();
      return { o, g, f };
    });

    this.ready = true;
  }

  async enable(v) {
    this.on = v;
    if (v) {
      this.boot();
      if (this.ctx && this.ctx.state === 'suspended') await this.ctx.resume();
    }
    if (!this.out) return;
    this.ramp(this.out.gain, v ? 0.5 : 0, 1.2);
  }

  ramp(param, v, t = 0.4) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(v, now + t);
  }

  pour(rate) {
    if (!this.ready) return;
    this.ramp(this.hiss.gain, Math.min(0.5, rate * 0.42), 0.25);
  }

  mode(kind) {
    if (!this.ready) return;
    const cold = kind === 'drift';
    this.ramp(this.bp.frequency, cold ? 420 : 2100, 0.9);
    this.oscs.forEach((x, i) => this.ramp(x.o.detune, cold ? (i - 1) * 36 : 0, 1.4));
    this.ramp(this.drone.gain, cold ? 0.3 : 0.16, 1.2);
  }

  ping(freq = 396, dur = 2.4, vol = 0.14) {
    if (!this.ready || !this.on) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(vol, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.connect(g).connect(this.out);
    o.start();
    o.stop(ctx.currentTime + dur + 0.1);
  }

  rupture() {
    if (!this.ready || !this.on) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(330, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(74, ctx.currentTime + 1.1);
    g.gain.setValueAtTime(0.12, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1.3);
    o.connect(g).connect(this.out);
    o.start();
    o.stop(ctx.currentTime + 1.4);
  }
}
