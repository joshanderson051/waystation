// ============================================================
// PORT SOLACE v2 — ui/sound.js
// Engineer H. Source of truth: DESIGN2.md section 9.
//
// Procedural WebAudio: no files. Sound.init() runs on the first user
// gesture (hud.js wires pointerdown / keydown once). Master, music and
// sfx gains persist through the settings object the HUD hands in
// (Meta.profile.settings when Meta exists). Every cue respects the toggles
// and document.hidden; the ambient bed ducks 6 dB under celebrations and
// brightens one filter notch while a panel is open.
//
// Exports (global): Sound
// ============================================================
'use strict';

const Sound = {
  ctx: null, ready: false,
  master: null, sfx: null, music: null,
  _bed: null,              // ambient nodes
  _duck: null,             // gain used for celebration ducking
  _settings: null,         // live reference to the settings object
  _save: null,             // fn(settings) persist hook
  _lastHover: 0,
  _padTimer: 0,

  // defaults when no profile settings exist yet
  DEFAULTS: { sfx: true, music: true, sfxVol: 0.8, musicVol: 0.6 },

  // Bind the persisted settings object (mutated in place) and a save hook.
  bind(settings, save) {
    this._settings = settings || {};
    for (const k of Object.keys(this.DEFAULTS)) if (this._settings[k] == null) this._settings[k] = this.DEFAULTS[k];
    this._save = typeof save === 'function' ? save : null;
    this.applySettings();
  },
  get settings() { if (!this._settings) this.bind({}); return this._settings; },

  // ---------------------------------------------------------- 1. context
  init() {
    if (this.ready) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try {
      const ctx = new AC();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.sfx = ctx.createGain();
      this.music = ctx.createGain();
      this._duck = ctx.createGain();
      this.sfx.connect(this.master);
      this.music.connect(this._duck); this._duck.connect(this.master);
      this.master.connect(ctx.destination);
      this.ready = true;
      this.applySettings();
      this.startBed();
      document.addEventListener('visibilitychange', () => this.onVisibility());
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    } catch (e) { this.ready = false; }
    return this.ready;
  },

  applySettings() {
    const s = this.settings;
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.sfx.gain.setTargetAtTime(s.sfx ? s.sfxVol : 0, t, 0.02);
    this.music.gain.setTargetAtTime((s.music && !document.hidden) ? s.musicVol : 0, t, 0.3);
  },
  set(key, value) {
    this.settings[key] = value;
    this.applySettings();
    if (this._save) this._save(this.settings);
  },
  onVisibility() {
    if (!this.ready) return;
    this.applySettings();
    if (!document.hidden && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  },

  // every cue goes through here: silently returns when not ready / muted / hidden
  _ok() { return this.ready && this.settings.sfx && !document.hidden && this.ctx.state === 'running'; },
  _now() { return this.ctx.currentTime; },

  // oscillator -> (filter) -> gain envelope -> sfx bus. Returns the gain node.
  _tone(type, f0, t0, dur, { f1, gain = 0.2, a = 0.004, r = null, filter = null, q = 1, detune = 0, out = null } = {}) {
    const ctx = this.ctx, osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = type; osc.frequency.setValueAtTime(f0, t0); if (detune) osc.detune.value = detune;
    if (f1 != null) osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    const rel = r == null ? Math.min(0.08, dur * 0.4) : r;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + a);
    g.gain.setValueAtTime(gain, Math.max(t0 + a, t0 + dur - rel));
    g.gain.linearRampToValueAtTime(0, t0 + dur);
    let head = osc;
    if (filter) { const bq = ctx.createBiquadFilter(); bq.type = filter.type || 'lowpass'; bq.frequency.setValueAtTime(filter.f0, t0); if (filter.f1) bq.frequency.exponentialRampToValueAtTime(filter.f1, t0 + dur); bq.Q.value = q; osc.connect(bq); head = bq; }
    head.connect(g); g.connect(out || this.sfx);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
    return g;
  },
  // white noise burst through a sweeping bandpass (panel open / close, warp whoosh)
  _noise(t0, dur, { f0 = 400, f1 = 2400, gain = 0.12, q = 1.2, out = null } = {}) {
    const ctx = this.ctx, n = Math.ceil(ctx.sampleRate * dur), buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = q;
    bp.frequency.setValueAtTime(f0, t0); bp.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(gain, t0 + 0.02);
    g.gain.setValueAtTime(gain, t0 + dur * 0.6); g.gain.linearRampToValueAtTime(0, t0 + dur);
    src.connect(bp); bp.connect(g); g.connect(out || this.sfx);
    src.start(t0); src.stop(t0 + dur + 0.02);
  },

  // ---------------------------------------------------------- 2. UI palette
  // very soft 2 ms tick, throttled so lists do not crackle
  hover() {
    if (!this._ok()) return;
    const now = performance.now(); if (now - this._lastHover < 40) return; this._lastHover = now;
    this._tone('square', 2400, this._now(), 0.012, { gain: 0.012, a: 0.001, r: 0.006, filter: { type: 'highpass', f0: 1200 } });
  },
  // sine blip 880 -> 1320 Hz, 60 ms
  click() { if (!this._ok()) return; this._tone('sine', 880, this._now(), 0.06, { f1: 1320, gain: 0.14, a: 0.003, r: 0.03 }); },
  // filtered noise sweep up, 180 ms
  open() { if (!this._ok()) return; this._noise(this._now(), 0.18, { f0: 300, f1: 2600, gain: 0.09 }); this.brighten(true); },
  close() { if (!this._ok()) return; this._noise(this._now(), 0.16, { f0: 2200, f1: 260, gain: 0.07 }); this.brighten(false); },
  // ascending pentatonic arpeggio of 3–6 triangle notes with a tiny bell on the last
  collect(n = 1) {
    if (!this._ok()) return;
    const t = this._now(), count = Math.max(3, Math.min(6, 3 + Math.floor(Math.log2(Math.max(1, n) / 60 + 1))));
    const scale = [0, 2, 4, 7, 9, 12, 14, 16];
    for (let i = 0; i < count; i++) {
      const f = 523.25 * Math.pow(2, scale[i] / 12);
      this._tone('triangle', f, t + i * 0.055, 0.14, { gain: 0.11, a: 0.004, r: 0.08 });
    }
    const last = 523.25 * Math.pow(2, scale[count - 1] / 12);
    this._tone('sine', last * 2, t + count * 0.055, 0.35, { gain: 0.06, a: 0.002, r: 0.3 });
    this._tone('sine', last * 3.01, t + count * 0.055, 0.25, { gain: 0.02, a: 0.002, r: 0.22 });
  },
  // major chord pad with a chime
  built() {
    if (!this._ok()) return;
    const t = this._now();
    for (const r of [0, 4, 7, 12]) this._tone('triangle', 261.63 * Math.pow(2, r / 12), t, 0.7, { gain: 0.07, a: 0.03, r: 0.45, filter: { type: 'lowpass', f0: 1800, f1: 900 } });
    this._tone('sine', 1567.98, t + 0.12, 0.6, { gain: 0.07, a: 0.002, r: 0.5 });
    this._tone('sine', 2093, t + 0.2, 0.5, { gain: 0.035, a: 0.002, r: 0.45 });
  },
  // fanfare: 4-note rising saw with a filter sweep
  rankUp() {
    if (!this._ok()) return;
    const t = this._now(), notes = [392, 523.25, 659.25, 783.99];
    notes.forEach((f, i) => {
      const t0 = t + i * 0.14, dur = i === notes.length - 1 ? 0.9 : 0.2;
      this._tone('sawtooth', f, t0, dur, { gain: 0.07, a: 0.01, r: dur * 0.5, filter: { type: 'lowpass', f0: 700, f1: 3200 }, q: 2 });
      this._tone('sawtooth', f * 0.5, t0, dur, { gain: 0.04, a: 0.01, r: dur * 0.5, filter: { type: 'lowpass', f0: 500, f1: 1600 }, detune: 6 });
    });
  },
  // two-tone low
  alert() {
    if (!this._ok()) return;
    const t = this._now();
    this._tone('square', 196, t, 0.16, { gain: 0.07, a: 0.005, r: 0.06, filter: { type: 'lowpass', f0: 900 } });
    this._tone('square', 155.56, t + 0.2, 0.22, { gain: 0.07, a: 0.005, r: 0.1, filter: { type: 'lowpass', f0: 900 } });
  },
  // short buzz
  error() {
    if (!this._ok()) return;
    this._tone('sawtooth', 110, this._now(), 0.12, { gain: 0.09, a: 0.003, r: 0.05, filter: { type: 'lowpass', f0: 600 } });
    this._tone('sawtooth', 113, this._now(), 0.12, { gain: 0.06, a: 0.003, r: 0.05, filter: { type: 'lowpass', f0: 600 } });
  },
  // riser + whoosh (sector warp, 900 ms)
  warp() {
    if (!this._ok()) return;
    const t = this._now();
    this._tone('sawtooth', 80, t, 0.75, { f1: 640, gain: 0.07, a: 0.05, r: 0.25, filter: { type: 'lowpass', f0: 300, f1: 4000 }, q: 3 });
    this._noise(t + 0.45, 0.55, { f0: 600, f1: 120, gain: 0.14, q: 0.8 });
  },
  // collect + chord
  purchase() { if (!this._ok()) return; this.collect(400); setTimeout(() => this.built(), 180); },

  // ---------------------------------------------------------- 3. ambient bed
  // hum: two detuned saws at 55 / 55.3 Hz through a low-pass at 180 Hz, −30 dB.
  // pad: three sines on an 8-bar random walk in a lydian scale, −26 dB, one
  // notch filter that brightens while a panel is open.
  startBed() {
    if (!this.ready || this._bed) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const hum = ctx.createGain(); hum.gain.value = Math.pow(10, -30 / 20);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 180; lp.Q.value = 0.7;
    const s1 = ctx.createOscillator(), s2 = ctx.createOscillator();
    s1.type = 'sawtooth'; s2.type = 'sawtooth'; s1.frequency.value = 55; s2.frequency.value = 55.3;
    s1.connect(lp); s2.connect(lp); lp.connect(hum); hum.connect(this.music);
    s1.start(t); s2.start(t);

    const pad = ctx.createGain(); pad.gain.value = Math.pow(10, -26 / 20);
    const notch = ctx.createBiquadFilter(); notch.type = 'peaking'; notch.frequency.value = 1200; notch.Q.value = 1.2; notch.gain.value = 0;
    const padLp = ctx.createBiquadFilter(); padLp.type = 'lowpass'; padLp.frequency.value = 1400;
    const voices = [0, 1, 2].map(() => { const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sine'; g.gain.value = 0.33; o.connect(g); g.connect(padLp); o.start(t); return { o, g }; });
    padLp.connect(notch); notch.connect(pad); pad.connect(this.music);

    this._bed = { hum, pad, notch, voices, step: 0 };
    this._walk();
  },
  // lydian on C3: C D E F# G A B; one bar = 2.4 s, voices move every bar, the walk restarts every 8 bars
  _walk() {
    if (!this._bed) return;
    const scale = [0, 2, 4, 6, 7, 9, 11, 12, 14, 16];
    const b = this._bed, t = this.ctx.currentTime, bar = 2.4;
    b.step = (b.step + 1) % 8;
    const base = b.step === 0 ? 130.81 : 130.81 * Math.pow(2, scale[Math.floor(Math.random() * 3)] / 12);
    b.voices.forEach((v, i) => {
      const deg = scale[Math.min(scale.length - 1, Math.floor(Math.random() * 4) + i * 2)];
      v.o.frequency.setTargetAtTime(base * Math.pow(2, deg / 12) * (i === 2 ? 2 : 1), t, bar * 0.35);
    });
    this._padTimer = setTimeout(() => this._walk(), bar * 1000);
  },
  brighten(on) {
    if (!this._bed) return;
    this._bed.notch.gain.setTargetAtTime(on ? 5 : 0, this.ctx.currentTime, 0.4);
  },
  // −6 dB under celebrations, restored after `ms`
  duck(ms = 1600) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this._duck.gain.setTargetAtTime(Math.pow(10, -6 / 20), t, 0.08);
    this._duck.gain.setTargetAtTime(1, t + ms / 1000, 0.4);
  },
};
