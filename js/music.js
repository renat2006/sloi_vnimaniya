/* Генеративный инструментал для фона. Без слов, медленный, с низкой
   информационной плотностью: длинные аккорды, редкие ноты, реверберация.
   Ничего не повторяется дословно: тональность выбирается заново, аккорды
   идут по графу переходов, мелодия — из мотива, который то возвращается,
   то меняется, а раз в несколько минут гармония сдвигается на квинту. */

const MODES = {
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  ionian: [0, 2, 4, 5, 7, 9, 11]
};

// какие ступени могут идти следом (модальная гармония, без «функций»)
const NEXT = { 0: [3, 5, 4, 2, 6], 1: [4, 0, 3], 2: [5, 3, 0], 3: [0, 5, 4, 1], 4: [0, 5, 3], 5: [3, 0, 4, 2], 6: [0, 2, 5] };

const RHYTHMS = [
  [0, 6, 10],
  [0, 4, 8, 12],
  [2, 8, 12],
  [0, 3, 6, 10, 13],
  [0, 8],
  [4, 10, 14]
];

export const SCENES = {
  flow: {
    modes: ['aeolian', 'dorian'], wave: 'triangle', bpm: 60, chord: 32, cut: 1100, wet: 0.34,
    density: 0.5, low: 57, pluck: 'soft', sub: 0.05, voices: 4
  },
  deep: {
    modes: ['aeolian', 'dorian'], wave: 'sawtooth', bpm: 46, chord: 56, cut: 520, wet: 0.46,
    density: 0.16, low: 48, pluck: 'bow', sub: 0.11, voices: 4
  },
  light: {
    modes: ['lydian', 'ionian'], wave: 'triangle', bpm: 68, chord: 24, cut: 2200, wet: 0.4,
    density: 0.62, low: 62, pluck: 'kalimba', sub: 0.03, voices: 4
  }
};

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function makeReverb(ctx, seconds = 3.4) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const w = Math.random() * 2 - 1;
      const k = 0.12 + 0.55 * (1 - t);
      lp += (w - lp) * k;
      d[i] = lp * Math.pow(1 - t, 2.4) * (i < rate * 0.012 ? i / (rate * 0.012) : 1);
    }
  }
  return buf;
}

export class Composer {
  constructor(ctx, dest, ir, scene, opts = {}) {
    this.ctx = ctx;
    this.scene = scene;
    this.cfg = SCENES[scene] || SCENES.flow;
    this.mode = MODES[pick(this.cfg.modes)];
    this.tonic = opts.tonic == null ? Math.floor(rand(0, 12)) : opts.tonic;
    this.fill = 0;
    this.mood = 'focus';
    this.gate = 1;
    this.frozen = false;
    this.dead = false;
    this.stepDur = 60 / this.cfg.bpm / 2;
    this.stepIdx = 0;
    this.phrase = [];
    this.motif = null;
    this.deg = 0;
    this.prev = [];
    this.born = ctx.currentTime;
    this.nextKeyAt = this.born + rand(420, 620);
    this.timers = [];

    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(dest);
    this.out = out;

    const dry = ctx.createGain();
    dry.gain.value = 1;
    dry.connect(out);

    const conv = ctx.createConvolver();
    conv.buffer = ir;
    const wet = ctx.createGain();
    wet.gain.value = this.cfg.wet;
    conv.connect(wet).connect(out);
    this.send = ctx.createGain();
    this.send.gain.value = 1;
    this.send.connect(conv);

    this.padBus = ctx.createGain();
    this.padBus.gain.value = 1;
    this.padBus.connect(dry);
    this.padBus.connect(this.send);

    this.notes = ctx.createGain();
    this.notes.gain.value = 1;
    this.notes.connect(dry);
    this.notes.connect(this.send);

    // ping-pong эхо для нот
    const dl = ctx.createDelay(2);
    const dr = ctx.createDelay(2);
    dl.delayTime.value = this.stepDur * 3;
    dr.delayTime.value = this.stepDur * 4.5;
    const fb = ctx.createGain();
    fb.gain.value = 0.36;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 1900;
    const echo = ctx.createGain();
    echo.gain.value = scene === 'deep' ? 0.18 : 0.3;
    this.notes.connect(dl);
    dl.connect(tone).connect(dr);
    dr.connect(fb).connect(dl);
    dl.connect(echo);
    dr.connect(echo);
    echo.connect(dry);
    echo.connect(this.send);
    this.fx = [dl, dr, fb, tone, echo, conv, wet];

    // общий фильтр подложки, медленно «дышит»
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.Q.value = 0.5;
    filt.frequency.value = this.cfg.cut;
    filt.connect(this.padBus);
    this.filt = filt;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = rand(0.03, 0.06);
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = this.cfg.cut * 0.22;
    lfo.connect(lfoDepth).connect(filt.frequency);
    lfo.start();
    this.lfo = lfo;

    this.voices = [];
    for (let i = 0; i < this.cfg.voices; i++) {
      const g = ctx.createGain();
      g.gain.value = 0;
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (pan) {
        pan.pan.value = [-0.5, 0.4, -0.15, 0.55][i % 4];
        g.connect(pan).connect(filt);
      } else {
        g.connect(filt);
      }
      const a = ctx.createOscillator();
      const b = ctx.createOscillator();
      a.type = b.type = this.cfg.wave;
      a.detune.value = -6;
      b.detune.value = 6;
      a.connect(g);
      b.connect(g);
      a.start();
      b.start();
      this.voices.push({ a, b, g, level: [0.1, 0.075, 0.06, 0.045][i % 4] });
    }

    this.subOsc = ctx.createOscillator();
    this.subOsc.type = 'sine';
    this.sub = ctx.createGain();
    this.sub.gain.value = 0;
    this.subOsc.connect(this.sub).connect(dry);
    this.subOsc.start();

    this.nextChordAt = ctx.currentTime + 0.05;
    this.nextStepAt = ctx.currentTime + 1.2;
  }

  start(fade = 3) {
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(this.out.gain.value, t);
    this.out.gain.linearRampToValueAtTime(1, t + fade);
    this.nextChord(t + 0.05);
  }

  stop(fade = 2) {
    if (this.dead) return;
    this.dead = true;
    this.timers.forEach(clearTimeout);
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(this.out.gain.value, t);
    this.out.gain.linearRampToValueAtTime(0, t + fade);
    setTimeout(() => this.dispose(), (fade + 0.6) * 1000 + 6000);
  }

  dispose() {
    const all = [this.lfo, this.subOsc, ...this.voices.flatMap((v) => [v.a, v.b])];
    all.forEach((o) => {
      try {
        o.stop();
        o.disconnect();
      } catch {}
    });
    [this.out, this.padBus, this.notes, this.send, this.filt, this.sub, ...this.fx, ...this.voices.map((v) => v.g)].forEach((n) => {
      try {
        n.disconnect();
      } catch {}
    });
  }

  semi(i) {
    const oct = Math.floor(i / 7);
    const pos = ((i % 7) + 7) % 7;
    return this.mode[pos] + 12 * oct;
  }

  midiOf(i, lo, hi, near) {
    const pc = (((this.tonic + this.semi(i)) % 12) + 12) % 12;
    let best = null;
    for (let x = lo; x <= hi; x++) {
      if (x % 12 !== pc) continue;
      if (best == null || (near != null && Math.abs(x - near) < Math.abs(best - near))) best = x;
    }
    return best == null ? lo : best;
  }

  // ── гармония ─────────────────────────────────────────────
  nextChord(when) {
    if (this.dead || this.frozen) return;
    if (when >= this.nextKeyAt) {
      this.tonic = (this.tonic + pick([7, 7, 5, 2])) % 12;
      this.nextKeyAt = when + rand(420, 620);
    }
    this.deg = this.stepIdx === 0 && !this.prev.length ? 0 : pick(NEXT[this.deg] || [0]);
    const r = this.deg;
    const color = pick(this.scene === 'deep' ? [r + 4, r + 2] : [r + 1, r + 6, r + 1]);
    const tones = [r, r + 2, r + 4, color];
    const lo = this.cfg.low - 10;
    const glide = this.cfg.chord * this.stepDur * 0.16;
    const span = [[0, 12], [4, 16], [8, 20], [14, 26]];
    this.chordMidi = tones.map((deg, i) => this.midiOf(deg, lo + span[i][0], lo + span[i][1], this.prev[i]));
    this.prev = this.chordMidi.slice();
    this.voices.forEach((v, i) => {
      const f = hz(this.chordMidi[i]);
      v.a.frequency.setTargetAtTime(f, when, glide);
      v.b.frequency.setTargetAtTime(f, when, glide);
    });
    const bass = this.midiOf(r, 28, 44, null);
    this.subOsc.frequency.setTargetAtTime(hz(bass), when, glide);
    this.applyLevels(when);
    this.nextChordAt = when + this.cfg.chord * this.stepDur * rand(0.85, 1.2);
  }

  applyLevels(when) {
    const t = when == null ? this.ctx.currentTime : when;
    const swell = this.mood === 'drift' ? 1.6 : this.mood === 'permitted' ? 1.2 : 1;
    const steps = [0, 0, 0.18, 0.5];
    this.voices.forEach((v, i) => {
      const room = clamp((this.fill - steps[i]) / 0.18, 0, 1);
      const body = clamp(0.4 + this.fill * 0.8, 0, 1);
      const lvl = v.level * (i < 2 ? body : room) * swell * (this.frozen && this.mood !== 'drift' ? 0.85 : 1);
      v.g.gain.setTargetAtTime(lvl, t, 2.4);
    });
    this.sub.gain.setTargetAtTime(this.cfg.sub * (0.5 + this.fill * 0.6), t, 2.5);
    const cutMul = this.mood === 'drift' ? 0.22 : this.mood === 'permitted' ? 0.6 : 1;
    const cut = this.cfg.cut * cutMul * (0.75 + this.fill * 0.5);
    this.filt.frequency.setTargetAtTime(cut, t, this.mood === 'drift' ? 1 : 6);
  }

  // ── состояние сеанса ─────────────────────────────────────
  setFill(f) {
    this.fill = clamp(f, 0, 1);
    if (!this.dead) this.applyLevels();
  }

  setMood(m) {
    if (this.dead) return;
    const was = this.mood;
    this.mood = m;
    const cold = m === 'drift';
    const stone = m === 'permitted';
    const spread = cold ? 44 : stone ? 18 : 0;
    const tau = cold ? 1.2 : stone ? 5 : 20;
    const t = this.ctx.currentTime;
    this.voices.forEach((v, i) => {
      const dir = i % 2 ? -1 : 1;
      v.a.detune.setTargetAtTime(-6 + dir * spread * (1 + i * 0.1), t, tau);
      v.b.detune.setTargetAtTime(6 - dir * spread * (1 + i * 0.1), t, tau);
    });
    clearTimeout(this.gateTimer);
    if (cold) {
      this.gate = 0;
    } else if (was === 'drift') {
      this.gate = 0;
      const back = stone ? 6000 : 22000;
      this.gateTimer = setTimeout(() => {
        this.gate = 0.5;
        this.gateTimer = setTimeout(() => (this.gate = 1), back);
      }, back * 0.55);
    } else {
      this.gate = 1;
    }
    this.applyLevels();
  }

  forgive() {
    if (this.dead) return;
    const t = this.ctx.currentTime;
    this.voices.forEach((v) => {
      v.a.detune.setTargetAtTime(-6, t, 4);
      v.b.detune.setTargetAtTime(6, t, 4);
    });
    clearTimeout(this.gateTimer);
    this.gate = 1;
    this.mood = 'focus';
    this.applyLevels();
  }

  // ── ноты ─────────────────────────────────────────────────
  tick() {
    if (this.dead) return;
    const t = this.ctx.currentTime;
    if (!this.frozen && t + 0.5 >= this.nextChordAt) this.nextChord(this.nextChordAt);
    if (this.frozen) return;
    while (this.nextStepAt < t + 0.6) {
      this.step(Math.max(t + 0.02, this.nextStepAt));
      this.nextStepAt += this.stepDur;
    }
  }

  planPhrase() {
    const macro = 0.75 + 0.25 * Math.sin(((this.ctx.currentTime - this.born) / 540) * Math.PI * 2);
    const dens = clamp(this.cfg.density * (0.55 + this.fill * 0.9) * macro, 0.05, 1);
    const slots = new Array(16).fill(null);
    const roll = Math.random();
    if (roll > 0.2 + dens * 0.7) {
      this.phrase = slots;
      return;
    }
    if (!this.motif || roll > 0.55 + dens * 0.3) this.motif = this.newMotif();
    else this.motif = this.vary(this.motif);
    const fit = RHYTHMS.filter((r) => r.length <= 2 + Math.round(dens * 3));
    const rhythm = pick(fit.length ? fit : RHYTHMS);
    rhythm.forEach((pos, i) => {
      const m = this.motif[i % this.motif.length];
      slots[pos] = { d: m, vel: rand(0.55, 1) * (i === 0 ? 1 : 0.8) };
    });
    this.phrase = slots;
  }

  newMotif() {
    const n = 3 + Math.floor(Math.random() * 3);
    let d = pick([0, 2, 4, 7]);
    const out = [d];
    for (let i = 1; i < n; i++) {
      d += pick([-2, -1, -1, 1, 1, 2, 0]);
      out.push(d);
    }
    return out;
  }

  vary(m) {
    const c = m.slice();
    const i = Math.floor(Math.random() * c.length);
    const r = Math.random();
    if (r < 0.4) c[i] += pick([-1, 1]);
    else if (r < 0.7) return c.map((x) => x + pick([-1, 1, 2]));
    else if (c.length > 3) c.splice(i, 1);
    else c.push(c[c.length - 1] + pick([-1, 1]));
    return c;
  }

  step(when) {
    const k = this.stepIdx % 16;
    this.stepIdx++;
    if (k === 0) this.planPhrase();
    const ev = this.phrase[k];
    if (!ev || this.gate < 0.05 || !this.chordMidi) return;
    const octave = this.fill > 0.62 ? 12 : 0;
    const base = this.cfg.low + 12;
    const midi = this.midiOf(this.deg + ev.d, base, base + 24, base + 6) + octave;
    this.note(midi, when + rand(-0.02, 0.03), ev.vel * this.gate);
  }

  note(midi, when, vel = 1, opts = {}) {
    if (this.dead) return;
    const ctx = this.ctx;
    const kind = opts.kind || this.cfg.pluck;
    const f = hz(midi);
    const g = ctx.createGain();
    const peak = 0.075 * vel * (opts.gain || 1);
    const atk = kind === 'bow' ? 0.7 : kind === 'soft' ? 0.05 : 0.006;
    const dur = opts.dur || (kind === 'bow' ? 7 : kind === 'soft' ? 5 : 3.2);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) {
      pan.pan.value = rand(-0.55, 0.55);
      g.connect(pan).connect(this.notes);
    } else {
      g.connect(this.notes);
    }
    const parts =
      kind === 'kalimba'
        ? [[1, 'sine', 1], [4.01, 'sine', 0.22], [9.2, 'sine', 0.05]]
        : kind === 'bow'
        ? [[1, 'triangle', 1], [2, 'sine', 0.3]]
        : [[1, 'sine', 1], [2, 'triangle', 0.22], [3, 'sine', 0.07]];
    let left = parts.length;
    parts.forEach(([r, type, lv]) => {
      const o = ctx.createOscillator();
      const og = ctx.createGain();
      o.type = type;
      o.frequency.value = f * r;
      og.gain.value = lv;
      o.connect(og).connect(g);
      o.onended = () => {
        try {
          o.disconnect();
          og.disconnect();
        } catch {}
        if (--left === 0) {
          try {
            g.disconnect();
            if (pan) pan.disconnect();
          } catch {}
        }
      };
      o.start(when);
      o.stop(when + dur + 0.1);
    });
  }

  // завершающий оборот: открытый аккорд и три ноты вверх
  settle() {
    if (this.dead) return;
    this.frozen = true;
    this.mood = 'focus';
    const t = this.ctx.currentTime;
    this.voices.forEach((v) => {
      v.a.detune.setTargetAtTime(-6, t, 0.8);
      v.b.detune.setTargetAtTime(6, t, 0.8);
    });
    this.deg = 0;
    const lo = this.cfg.low - 10;
    const span = [[0, 12], [4, 16], [8, 20], [14, 26]];
    const tones = [0, 4, 7, 9];
    this.voices.forEach((v, i) => {
      const f = hz(this.midiOf(tones[i], lo + span[i][0], lo + span[i][1], this.prev[i]));
      v.a.frequency.setTargetAtTime(f, t, 1.4);
      v.b.frequency.setTargetAtTime(f, t, 1.4);
    });
    this.subOsc.frequency.setTargetAtTime(hz(this.midiOf(0, 28, 44, null)), t, 1.4);
    this.applyLevels();
    const base = this.cfg.low + 12;
    [0, 2, 4].forEach((d, i) => {
      this.note(this.midiOf(d, base + 6, base + 30, null), t + 0.5 + i * 0.7, 0.9, { kind: 'soft', dur: 6, gain: 0.9 });
    });
  }
}
