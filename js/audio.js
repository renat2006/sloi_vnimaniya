const ROOT = 55;
const PARTIALS = [1, 1.5, 2, 3, 4, 6];
const ENTER = [0, 0.07, 0.22, 0.44, 0.68, 0.9];
const LEVEL = [0.16, 0.1, 0.075, 0.045, 0.03, 0.02];
const HAZE_TAU = 22;
const SCALE = [1, 9 / 8, 4 / 3, 3 / 2, 5 / 3, 2, 9 / 4, 8 / 3];

export class Ambience {
  constructor() {
    this.on = false;
    this.ctx = null;
    this.ready = false;
    this.fill = 0;
    this.playing = null;
  }

  boot() {
    if (this.ready) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;

    const master = ctx.createGain();
    master.gain.value = 0;
    const soft = ctx.createDynamicsCompressor();
    soft.threshold.value = -20;
    soft.ratio.value = 6;
    soft.attack.value = 0.02;
    soft.release.value = 0.4;
    master.connect(soft).connect(ctx.destination);
    this.master = master;
    this.bus = soft;

    const air = ctx.createBiquadFilter();
    air.type = 'lowpass';
    air.frequency.value = 1900;
    air.Q.value = 0.4;
    air.connect(master);
    this.air = air;

    this.voices = PARTIALS.map((ratio, i) => {
      const osc = ctx.createOscillator();
      osc.type = i < 2 ? 'triangle' : 'sine';
      osc.frequency.value = ROOT * ratio;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (pan) {
        pan.pan.value = ((i % 3) - 1) * 0.35;
        osc.connect(gain).connect(pan).connect(air);
      } else {
        osc.connect(gain).connect(air);
      }
      osc.start();
      return { osc, gain, ratio, i };
    });

    const drift = ctx.createOscillator();
    drift.type = 'sine';
    drift.frequency.value = 0.045;
    const driftAmt = ctx.createGain();
    driftAmt.gain.value = 1.6;
    drift.connect(driftAmt);
    this.voices.forEach((v) => driftAmt.connect(v.osc.detune));
    drift.start();

    const len = ctx.sampleRate * 3;
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
    src.connect(bp).connect(hiss).connect(master);
    src.start();
    this.hiss = hiss;
    this.bp = bp;

    this.ready = true;
    this.setFill(this.fill);
  }

  async enable(v) {
    this.on = v;
    if (v) {
      this.boot();
      if (this.ctx && this.ctx.state === 'suspended') await this.ctx.resume();
    }
    if (!this.master) return;
    this.ramp(this.master.gain, v ? 0.55 : 0, 1.4);
  }

  ramp(param, v, t = 0.4) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(v, now + t);
  }

  glide(param, v, tau) {
    if (!this.ctx) return;
    param.cancelScheduledValues(this.ctx.currentTime);
    param.setTargetAtTime(v, this.ctx.currentTime, tau);
  }

  setFill(f) {
    this.fill = f;
    if (!this.ready) return;
    this.voices.forEach((v) => {
      const room = (f - ENTER[v.i]) / 0.12;
      const target = LEVEL[v.i] * Math.max(0, Math.min(1, room));
      this.glide(v.gain.gain, target, 2.5);
    });
  }

  mode(kind) {
    if (!this.ready) return;
    const cold = kind === 'drift';
    const stone = kind === 'permitted';
    const spread = cold ? 46 : stone ? 20 : 0;
    const tau = cold ? 1.2 : stone ? 5 : HAZE_TAU;
    this.voices.forEach((v) => {
      const dir = v.i % 2 ? -1 : 1;
      this.glide(v.osc.detune, dir * spread * (1 + v.i * 0.12), tau);
    });
    this.glide(this.air.frequency, cold ? 380 : stone ? 1200 : 1900, cold ? 1 : 6);
    this.glide(this.bp.frequency, cold ? 420 : 2100, 1);
  }

  forgive() {
    if (!this.ready) return;
    this.voices.forEach((v) => this.glide(v.osc.detune, 0, 4));
    this.glide(this.air.frequency, 1900, 3);
  }

  pour(rate) {
    if (!this.ready) return;
    this.glide(this.hiss.gain, Math.min(0.42, rate * 0.3), 0.4);
  }

  bell(freq, dur = 3.2, vol = 0.12, when = 0) {
    if (!this.ready || !this.on) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + when;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(vol, t + 0.012);
    out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    out.connect(this.master);
    [1, 2.76, 5.4].forEach((r, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq * r;
      const g = ctx.createGain();
      g.gain.value = i === 0 ? 1 : 0.28 / i;
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + dur + 0.1);
    });
  }

  ping(freq = 396, dur = 2.6, vol = 0.1) {
    this.bell(freq, dur, vol);
  }

  rupture() {
    if (!this.ready || !this.on) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(ROOT * 3, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(ROOT * 0.92, ctx.currentTime + 1.3);
    g.gain.setValueAtTime(0.1, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1.5);
    o.connect(g).connect(this.master);
    o.start();
    o.stop(ctx.currentTime + 1.6);
  }

  resolve() {
    if (!this.ready) return;
    const ctx = this.ctx;
    this.voices.forEach((v) => this.glide(v.osc.detune, 0, 0.8));
    this.glide(this.air.frequency, 3200, 1.5);
    this.glide(this.hiss.gain, 0, 1.2);

    const third = ctx.createOscillator();
    third.type = 'sine';
    third.frequency.value = ROOT * 5;
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0, ctx.currentTime);
    tg.gain.linearRampToValueAtTime(0.03, ctx.currentTime + 1.4);
    tg.gain.setTargetAtTime(0, ctx.currentTime + 3.5, 1.6);
    third.connect(tg).connect(this.air);
    third.start();
    third.stop(ctx.currentTime + 9);

    this.bell(ROOT * 4, 5.5, 0.11);
    this.bell(ROOT * 6, 4.5, 0.05, 0.28);
    this.voices.forEach((v) => {
      if (v.i > 0) this.glide(v.gain.gain, LEVEL[v.i] * 1.25, 1.2);
    });
    setTimeout(() => this.setFill(this.fill), 4000);
  }

  stopCore() {
    if (this.playing) {
      try {
        this.playing.stop();
      } catch {}
      this.playing = null;
    }
  }

  async playCore(core, onDone) {
    this.boot();
    if (!this.ctx) return 0;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.stopCore();

    const ctx = this.ctx;
    const total = Math.max(1, core.durationMs);
    const span = Math.min(28, Math.max(11, (total / 60000) * 1.15 + 8));
    const t0 = ctx.currentTime + 0.12;

    const out = ctx.createGain();
    out.gain.value = 0.0001;
    out.gain.setTargetAtTime(this.on ? 0.85 : 0.85, t0, 0.2);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 4200;
    out.connect(lp).connect(this.bus || ctx.destination);

    const nodes = [];
    const layers = core.layers.filter((l) => l.end > l.start);

    layers.forEach((l, idx) => {
      const at = t0 + (l.start / total) * span;
      const dur = Math.max(0.35, ((l.end - l.start) / total) * span);
      const depth = l.start / total;
      const step = SCALE[Math.min(SCALE.length - 1, Math.round(depth * (SCALE.length - 1)))];
      const base = ROOT * 2 * step;

      const ratios = l.type === 'drift' ? [1, 1.5] : l.type === 'permitted' ? [1, 1.5, 2] : [1, 1.5, 2, 3];
      const det = l.type === 'drift' ? 44 : l.type === 'permitted' ? 16 : 0;
      const vol = l.type === 'drift' ? 0.07 : l.type === 'permitted' ? 0.06 : 0.075;

      const g = ctx.createGain();
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(vol, at + Math.min(0.5, dur * 0.3));
      g.gain.setValueAtTime(vol, at + dur * 0.75);
      g.gain.linearRampToValueAtTime(0, at + dur);
      g.connect(out);
      nodes.push(g);

      ratios.forEach((r, i) => {
        const o = ctx.createOscillator();
        o.type = l.type === 'drift' ? 'sawtooth' : i < 2 ? 'triangle' : 'sine';
        o.frequency.value = base * r;
        o.detune.value = (i % 2 ? -1 : 1) * det;
        const vg = ctx.createGain();
        vg.gain.value = 1 / (i + 1.6);
        o.connect(vg).connect(g);
        o.start(at);
        o.stop(at + dur + 0.12);
        nodes.push(o);
      });

      if (idx > 0) this.bell(base * 2, Math.min(2.2, dur + 0.6), 0.05, at - ctx.currentTime);
    });

    this.bell(ROOT * 4, 4.5, 0.09, span + 0.15);

    const stop = () => {
      nodes.forEach((n) => {
        try {
          n.stop ? n.stop() : n.disconnect();
        } catch {}
      });
      try {
        out.disconnect();
      } catch {}
    };
    const timer = setTimeout(() => {
      this.playing = null;
      onDone && onDone();
    }, (span + 4.6) * 1000);
    this.playing = {
      stop: () => {
        clearTimeout(timer);
        out.gain.setTargetAtTime(0, ctx.currentTime, 0.08);
        setTimeout(stop, 400);
        onDone && onDone();
      }
    };
    return span;
  }
}
