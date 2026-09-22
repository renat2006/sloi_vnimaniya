const ROOT = 55;
const CYCLE = 16;
const BREATH = 0.1;

const CHORDS = [
  { name: 'открытый', upper: [3, 4, 6], colour: [4, 6, 8] },
  { name: 'минорный', upper: [2.4, 3, 4.8], colour: [4.8, 6, 7.2] },
  { name: 'подвешенный', upper: [8 / 3, 4, 16 / 3], colour: [16 / 3, 6, 8] },
  { name: 'светлый', upper: [2.5, 3, 5], colour: [5, 6, 7.5] }
];

const SCALE = [1, 9 / 8, 4 / 3, 3 / 2, 5 / 3, 2, 9 / 4, 8 / 3];

export class Ambience {
  constructor() {
    this.on = false;
    this.ctx = null;
    this.ready = false;
    this.fill = 0;
    this.frozen = false;
    this.active = false;
    this.swell = 1;
    this.step = 0;
    this.playing = null;
    this.timer = null;
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
    soft.threshold.value = -22;
    soft.ratio.value = 5;
    soft.attack.value = 0.03;
    soft.release.value = 0.5;
    master.connect(soft).connect(ctx.destination);
    this.master = master;
    this.bus = soft;

    const breathGain = ctx.createGain();
    breathGain.gain.value = 1;
    breathGain.connect(master);
    this.breathGain = breathGain;

    const breath = ctx.createOscillator();
    breath.type = 'sine';
    breath.frequency.value = BREATH;
    const depth = ctx.createGain();
    depth.gain.value = 0.07;
    breath.connect(depth).connect(breathGain.gain);
    breath.start();

    const music = ctx.createGain();
    music.gain.value = 1;
    music.connect(breathGain);
    this.music = music;

    const air = ctx.createBiquadFilter();
    air.type = 'lowpass';
    air.frequency.value = 2200;
    air.Q.value = 0.4;
    air.connect(music);
    this.air = air;

    const sand = ctx.createGain();
    sand.gain.value = 1;
    sand.connect(master);
    this.sand = sand;

    const makeVoice = (ratio, type, level, pan) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = ROOT * ratio;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      let tail = gain;
      if (ctx.createStereoPanner) {
        const p = ctx.createStereoPanner();
        p.pan.value = pan;
        gain.connect(p);
        tail = p;
      }
      tail.connect(air);
      osc.connect(gain);
      osc.start();
      return { osc, gain, level };
    };

    this.pedal = [makeVoice(1, 'triangle', 0.15, 0), makeVoice(1.5, 'sine', 0.075, -0.2)];
    this.upper = [
      makeVoice(3, 'sine', 0.05, -0.4),
      makeVoice(4, 'sine', 0.04, 0.35),
      makeVoice(6, 'sine', 0.026, 0.15)
    ];

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
    bp.frequency.value = 900;
    bp.Q.value = 1.6;
    const hiss = ctx.createGain();
    hiss.gain.value = 0;
    src.connect(bp).connect(hiss).connect(sand);
    src.start();
    this.hiss = hiss;
    this.bp = bp;

    const src2 = ctx.createBufferSource();
    src2.buffer = buf;
    src2.loop = true;
    src2.playbackRate.value = 0.55;
    const body = ctx.createBiquadFilter();
    body.type = 'lowpass';
    body.frequency.value = 220;
    body.Q.value = 3.2;
    const bodyGain = ctx.createGain();
    bodyGain.gain.value = 0;
    src2.connect(body).connect(bodyGain).connect(sand);
    src2.start();
    this.body = body;
    this.bodyGain = bodyGain;

    const gb = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.4), ctx.sampleRate);
    const gd = gb.getChannelData(0);
    for (let i = 0; i < gd.length; i++) gd[i] = Math.random() * 2 - 1;
    this.grainBuf = gb;
    this.nextGrainAt = ctx.currentTime + 0.1;
    this.rate = 0;
    this.res = 520;

    const grainBus = ctx.createGain();
    grainBus.gain.value = 0.34;
    grainBus.connect(sand);
    this.grainBus = grainBus;

    this.nextChordAt = ctx.currentTime + 1.5;
    this.nextNoteAt = ctx.currentTime + 7;
    this.timer = setInterval(() => this.tick(), 250);

    this.ready = true;
    this.setFill(this.fill);
    this.applyChord(0, ctx.currentTime + 0.4);
  }

  async enable(v) {
    this.on = v;
    if (v) {
      this.boot();
      if (this.ctx && this.ctx.state === 'suspended') await this.ctx.resume();
    }
    if (!this.master) return;
    this.ramp(this.master.gain, v ? 0.5 : 0, 1.6);
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

  applyChord(index, when) {
    if (!this.ready) return;
    const chord = CHORDS[index % CHORDS.length];
    this.chord = chord;
    this.upper.forEach((v, i) => {
      const ratio = chord.upper[i];
      v.osc.frequency.setTargetAtTime(ROOT * ratio, when, 2.2);
    });
  }

  enter() {
    this.boot();
    if (!this.ready) return;
    this.active = true;
    this.frozen = false;
    this._prev = null;
    this._mel = 1;
    this.step = 0;
    clearTimeout(this._melTimer);
    clearTimeout(this._leaveTimer);
    this.nextChordAt = this.ctx.currentTime + 1.2;
    this.nextNoteAt = this.ctx.currentTime + 8;
    this.applyChord(0, this.ctx.currentTime + 0.3);
    this.setFill(this.fill);
  }

  leave() {
    if (!this.ready) return;
    this.active = false;
    this.rate = 0;
    clearTimeout(this._melTimer);
    clearTimeout(this._leaveTimer);
    [...this.pedal, ...this.upper].forEach((v) => this.ramp(v.gain.gain, 0, 1.6));
    this.ramp(this.hiss.gain, 0, 1.2);
    this.ramp(this.bodyGain.gain, 0, 1.2);
    this.ramp(this.music.gain, 1, 0.5);
  }

  duck(hidden) {
    if (!this.master) return;
    clearTimeout(this._duckTimer);
    if (hidden) {
      this._duckTimer = setTimeout(() => this.ramp(this.master.gain, 0, 2.2), 1400);
    } else {
      this.ramp(this.master.gain, this.on ? 0.5 : 0, 0.7);
    }
  }

  sandBurst(dir) {
    if (!this.ready || !this.on) return;
    const t = this.ctx.currentTime;
    const n = dir < 0 ? 26 : 18;
    const span = dir < 0 ? 0.75 : 0.5;
    for (let i = 0; i < n; i++) {
      const k = i / n;
      const at = t + k * span + Math.random() * 0.03;
      const f = dir < 0 ? this.res * (1.15 - k * 0.85) : this.res * (0.3 + k * 1.0);
      this.grain(at, (dir < 0 ? 1.25 : 1.05) * (1 - k * 0.35), false, f);
    }
    this.glide(this.bp.frequency, dir < 0 ? this.res * 0.35 : this.res, dir < 0 ? 0.25 : 0.6);
  }

  tick() {
    if (!this.ready || !this.on || !this.active) return;
    const t = this.ctx.currentTime;
    if (this.frozen) return;

    if (t + 0.4 >= this.nextChordAt) {
      this.step += 1;
      this.applyChord(this.step, this.nextChordAt);
      this.nextChordAt += CYCLE;
    }

    if (this.rate > 0.03 && !this.frozenSand) {
      const per = Math.min(34, 7 + this.rate * 16);
      while (this.nextGrainAt < t + 0.3) {
        this.grain(Math.max(t, this.nextGrainAt));
        this.nextGrainAt += (1 / per) * (0.6 + Math.random() * 0.8);
      }
    } else {
      this.nextGrainAt = t + 0.1;
    }

    if (t + 0.4 >= this.nextNoteAt) {
      if (this.melodyGain > 0.01) this.note(this.nextNoteAt);
      const density = 0.35 + this.fill * 0.5;
      this.nextNoteAt += 3.2 + Math.random() * 7 * (1.35 - density);
    }
  }

  note(when) {
    const chord = this.chord || CHORDS[0];
    const pool = chord.colour;
    const oct = this.fill > 0.62 ? 2 : 1;
    const ratio = pool[Math.floor(Math.random() * pool.length)] * oct;
    const vol = 0.055 * this.melodyGain * (0.7 + Math.random() * 0.5);
    this.bell(ROOT * ratio, 4.5 + Math.random() * 2.5, vol, when - this.ctx.currentTime, true);
  }

  resonance() {
    return 480 * Math.pow(5.2, Math.min(1, this.fill));
  }

  landing(cold) {
    if (!this.ready || !this.on || !this.active) return;
    this.grain(this.ctx.currentTime + 0.01, cold ? 0.55 : 1.15, true);
  }

  grain(when, boost = 1, solid = false, freq = 0) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.grainBuf;
    src.playbackRate.value = 0.7 + Math.random() * 0.8;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq
      ? freq * (0.85 + Math.random() * 0.3)
      : this.res * (solid ? 0.4 + Math.random() * 0.45 : 0.55 + Math.random() * 1.1);
    f.Q.value = solid ? 2.5 + Math.random() * 3 : 4 + Math.random() * 6;
    const env = ctx.createGain();
    const dur = (solid ? 0.05 : 0.028) + Math.random() * 0.05;
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime((0.5 + Math.random() * 0.5) * boost, when + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0005, when + dur);
    let tail = env;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = (Math.random() - 0.5) * 1.1;
      env.connect(p);
      tail = p;
    }
    tail.connect(this.grainBus);
    src.connect(f).connect(env);
    src.start(when, Math.random() * 0.3, dur + 0.02);
    src.stop(when + dur + 0.05);
  }

  setFill(f) {
    this.fill = f;
    if (!this.ready) return;
    this.res = this.resonance();
    if (!this.frozen) this.glide(this.bp.frequency, this.res, 4);
    this.glide(this.body.frequency, 150 + f * 260, 4);
    this.glide(this.bodyGain.gain, (1 - f * 0.55) * 0.09 * Math.min(1, this.rate * 2 + 0.25), 2);
    const body = Math.min(1, 0.35 + f * 0.85);
    this.pedal.forEach((v) => this.glide(v.gain.gain, v.level * body * this.swell, 1.4));
    const steps = [0, 0.18, 0.5];
    this.upper.forEach((v, i) => {
      const room = Math.max(0, Math.min(1, (f - steps[i]) / 0.18));
      this.glide(v.gain.gain, v.level * room * (this.frozen ? 0.6 : 1), 3);
    });
  }

  get melodyGain() {
    if (this.frozen) return 0;
    return this._mel == null ? 1 : this._mel;
  }

  mode(kind) {
    if (!this.ready) return;
    const cold = kind === 'drift';
    const stone = kind === 'permitted';
    const wasCold = this._prev === 'drift';
    this._prev = kind;
    this.frozen = cold;
    this.swell = cold ? 1.85 : stone ? 1.25 : 1;

    const spread = cold ? 44 : stone ? 18 : 0;
    const tau = cold ? 1.2 : stone ? 5 : 20;
    [...this.pedal, ...this.upper].forEach((v, i) => {
      const dir = i % 2 ? -1 : 1;
      this.glide(v.osc.detune, dir * spread * (1 + i * 0.1), tau);
    });
    this.glide(this.air.frequency, cold ? 420 : stone ? 1300 : 2200, cold ? 1 : 7);
    this.glide(this.grainBus.gain, cold ? 0.55 : 0.34, 1.5);
    if (cold) {
      this.sandBurst(-1);
      this.ramp(this.bp.frequency, 420, 0.9);
      this.ramp(this.hiss.gain, 0.26, 0.9);
    } else if (wasCold) {
      this.sandBurst(1);
      this.ramp(this.bp.frequency, this.res, 0.9);
    } else {
      this.ramp(this.bp.frequency, this.res, 1.5);
    }

    clearTimeout(this._melTimer);
    if (cold) {
      this._mel = 0;
    } else if (wasCold) {
      this._mel = 0;
      const back = stone ? 6000 : 22000;
      this._melTimer = setTimeout(() => {
        this._mel = 0.5;
        this._melTimer = setTimeout(() => (this._mel = 1), back);
      }, back * 0.55);
      this.nextChordAt = this.ctx.currentTime + 2;
      this.nextNoteAt = this.ctx.currentTime + back * 0.0009;
    } else {
      this._mel = 1;
    }
    this.setFill(this.fill);
  }

  forgive() {
    if (!this.ready) return;
    [...this.pedal, ...this.upper].forEach((v) => this.glide(v.osc.detune, 0, 4));
    this.glide(this.air.frequency, 2200, 3);
    clearTimeout(this._melTimer);
    this._mel = 1;
  }

  pour(rate) {
    if (!this.ready) return;
    this.rate = rate;
    this.glide(this.hiss.gain, Math.min(0.3, 0.035 + rate * 0.16), 0.5);
    this.glide(this.bodyGain.gain, (1 - this.fill * 0.55) * 0.09 * Math.min(1, rate * 2 + 0.25), 1);
    this.glide(this.music.gain, rate > 2.2 ? 0.55 : 1, 0.9);
  }

  bell(freq, dur = 3.2, vol = 0.1, when = 0, soft = false) {
    if (!this.ready || !this.on) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + Math.max(0, when);
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(vol, t + (soft ? 0.09 : 0.012));
    out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    out.connect(this.air || this.master);
    const parts = soft ? [1, 2, 3] : [1, 2.76, 5.4];
    parts.forEach((r, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq * r;
      const g = ctx.createGain();
      g.gain.value = i === 0 ? 1 : (soft ? 0.16 : 0.28) / i;
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + dur + 0.1);
    });
  }

  ping(freq = 396, dur = 2.4, vol = 0.13) {
    if (!this.ready || !this.on) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(vol, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.connect(g).connect(this.master);
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
    o.connect(g).connect(this.master);
    o.start();
    o.stop(ctx.currentTime + 1.4);
  }

  resolve() {
    if (!this.ready) return;
    const ctx = this.ctx;
    this.frozen = true;
    this.swell = 1;
    clearTimeout(this._melTimer);
    [...this.pedal, ...this.upper].forEach((v) => this.glide(v.osc.detune, 0, 0.8));
    this.glide(this.air.frequency, 3400, 1.5);
    this.glide(this.hiss.gain, 0, 1.2);
    this.glide(this.bodyGain.gain, 0, 1.2);
    this.glide(this.music.gain, 1, 1);
    this.rate = 0;
    this.applyChord(0, ctx.currentTime + 0.1);

    const third = ctx.createOscillator();
    third.type = 'sine';
    third.frequency.value = ROOT * 5;
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0, ctx.currentTime);
    tg.gain.linearRampToValueAtTime(0.028, ctx.currentTime + 1.6);
    tg.gain.setTargetAtTime(0, ctx.currentTime + 4, 1.8);
    third.connect(tg).connect(this.air);
    third.start();
    third.stop(ctx.currentTime + 10);

    this.bell(ROOT * 4, 6, 0.1);
    this.bell(ROOT * 6, 5, 0.045, 0.3);
    this._leaveTimer = setTimeout(() => this.leave(), 6800);
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
    out.gain.value = 0.85;
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

    this.bell(ROOT * 4, 4.5, 0.085, span + 0.15);

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
