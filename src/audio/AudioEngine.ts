import {
  MAX_FLYBY_VOICES,
  approach,
  assignVoices,
  channelGains,
  clamp01,
  closingSpeed,
  distanceGain,
  dopplerRatio,
  getJetTimbre,
  selectNearest,
  stereoPan,
  type JetTimbre,
  type MixerLevels,
  type Vec3Like,
} from './audioMath';

export interface AudioFlightState {
  throttle: number; // 0..1
  afterburner: boolean;
  speed: number; // m/s (0..250)
  gLoad: number; // load factor
  stallWarning: boolean;
  pullUp: boolean; // terrain warning
  agl: number; // height above ground, m
}

/** Another aircraft that can be heard flying past. */
export interface FlybySource {
  /** Stable identity (e.g. `ai:2`, `remote:<id>`). */
  key: string;
  position: Vec3Like;
  /** World velocity, m/s; when null it is estimated from successive positions. */
  velocity: Vec3Like | null;
  throttle: number;
  jetId: string;
}

export interface FlybyListener {
  position: Vec3Like;
  /** Listener's right-hand unit vector (camera +X in world space). */
  right: Vec3Like;
  velocity: Vec3Like;
}

type AudioContextCtor = new () => AudioContext;

function getAudioContextCtor(): AudioContextCtor | null {
  const g = globalThis as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

const SMOOTH = 0.08; // setTargetAtTime time constant for continuous params
const STALL_BEEP_PERIOD = 0.25; // ~4 Hz
const PULLUP_TONE_PERIOD = 0.3;
const MASTER_MAKEUP = 1.4; // compensates the quadratic slider curve; the compressor catches peaks
const THROTTLE_TAU = 0.18;
const AB_ATTACK_TAU = 0.25;
const AB_RELEASE_TAU = 0.5;
const ZERO: Vec3Like = { x: 0, y: 0, z: 0 };

interface FlybyVoice {
  key: string | null;
  osc: OscillatorNode;
  oscFilter: BiquadFilterNode;
  noise: AudioBufferSourceNode;
  noiseFilter: BiquadFilterNode;
  gain: GainNode;
  panner: StereoPannerNode | null;
}

interface TrackedPos {
  x: number;
  y: number;
  z: number;
  t: number;
  vx: number;
  vy: number;
  vz: number;
}

interface Graph {
  ctx: AudioContext;
  master: GainNode;
  engineBus: GainNode;
  effectsBus: GainNode;
  warningsBus: GainNode;
  noise: AudioBuffer;
  whineOscs: OscillatorNode[];
  whineGain: GainNode;
  whineFilter: BiquadFilterNode;
  subOsc: OscillatorNode;
  subGain: GainNode;
  roarSrc: AudioBufferSourceNode;
  roarFilter: BiquadFilterNode;
  roarGain: GainNode;
  abSrc: AudioBufferSourceNode;
  abFilter: BiquadFilterNode;
  abGain: GainNode;
  windSrc: AudioBufferSourceNode;
  windFilter: BiquadFilterNode;
  windGain: GainNode;
  voices: FlybyVoice[];
}

export class AudioEngine {
  private graph: Graph | null = null;
  private readonly mixer: MixerLevels = { master: 0.8, engine: 1, effects: 1, warnings: 1 };
  private disposed = false;
  private stallTimer = 0;
  private pullUpTimer = 0;
  private pullUpHigh = false;
  private timbre: JetTimbre = getJetTimbre('falcon');
  private jetId = 'falcon';
  private lastCtxTime = -1;
  private throttleS = 0;
  private abS = 0;
  private warningActivity = 0;
  private warningUntil = 0; // audio-clock time until which started warning tones still ring
  private oneShots = 0;
  private readonly lastPos = new Map<string, TrackedPos>();
  private readonly seen = new Set<string>();

  constructor() {
    // No AudioContext here (autoplay policy); it is created lazily in resume().
  }

  resume(): void {
    if (this.disposed) return;
    if (!this.graph) {
      const Ctor = getAudioContextCtor();
      if (!Ctor) return;
      try {
        this.graph = this.buildGraph(new Ctor());
      } catch {
        this.graph = null;
        return;
      }
    }
    const ctx = this.graph.ctx;
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  }

  suspend(): void {
    const ctx = this.graph?.ctx;
    if (ctx && ctx.state === 'running') void ctx.suspend().catch(() => undefined);
  }

  setMasterVolume(v: number): void {
    this.setMixer({ ...this.mixer, master: v });
  }

  /** Slider levels 0..1 for master and the engine / effects / warnings channels. */
  setMixer(levels: MixerLevels): void {
    this.mixer.master = clamp01(levels.master);
    this.mixer.engine = clamp01(levels.engine);
    this.mixer.effects = clamp01(levels.effects);
    this.mixer.warnings = clamp01(levels.warnings);
    const g = this.graph;
    if (g) this.applyMixer(g, 0.05);
  }

  /** Selects the engine timbre of the jet being flown. */
  setJet(jetId: string): void {
    if (jetId === this.jetId) return;
    this.jetId = jetId;
    this.timbre = getJetTimbre(jetId);
    const g = this.graph;
    if (g) this.applyTimbreTypes(g);
  }

  /** Diagnostics: flyby voices (created / in use), one-shots still playing, tracked flyby sources. */
  get stats(): { voices: number; activeVoices: number; oneShots: number; tracked: number } {
    const v = this.graph?.voices ?? [];
    return { voices: v.length, activeVoices: v.filter((x) => x.key !== null).length, oneShots: this.oneShots, tracked: this.lastPos.size };
  }

  update(state: AudioFlightState | null, dt: number): void {
    const g = this.ready();
    if (!g) return;
    const t = g.ctx.currentTime;
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 0;
    // Smoothing follows the audio clock so it also settles while the game is paused (dt = 0).
    const real = this.lastCtxTime < 0 ? 0 : Math.min(0.1, Math.max(0, t - this.lastCtxTime));
    this.lastCtxTime = t;

    const warnTarget = (state && (state.stallWarning || state.pullUp)) || t < this.warningUntil ? 1 : 0;
    this.warningActivity = approach(this.warningActivity, warnTarget, real, warnTarget > this.warningActivity ? 0.04 : 0.35);
    this.applyMixer(g, SMOOTH);

    if (!state) {
      const fade = 0.3;
      g.whineGain.gain.setTargetAtTime(0, t, fade);
      g.subGain.gain.setTargetAtTime(0, t, fade);
      g.roarGain.gain.setTargetAtTime(0, t, fade);
      g.abGain.gain.setTargetAtTime(0, t, fade);
      g.windGain.gain.setTargetAtTime(0, t, fade);
      this.throttleS = approach(this.throttleS, 0, real, 0.3);
      this.abS = approach(this.abS, 0, real, 0.3);
      this.stallTimer = 0;
      this.pullUpTimer = 0;
      return;
    }

    const tb = this.timbre;
    const abTarget = state.afterburner ? 1 : 0;
    this.throttleS = approach(this.throttleS, clamp01(state.throttle), real, THROTTLE_TAU);
    this.abS = approach(this.abS, abTarget, real, abTarget > this.abS ? AB_ATTACK_TAU : AB_RELEASE_TAU);
    const throttle = this.throttleS;
    const ab = this.abS;
    const speedN = clamp01(state.speed / 250);

    // Turbine whine: pitch rises with throttle (plus a touch of ram effect from airspeed).
    const baseFreq = tb.whineBase + throttle * tb.whineRange + speedN * 60 + ab * 40;
    for (let i = 0; i < g.whineOscs.length; i++) {
      g.whineOscs[i]!.frequency.setTargetAtTime(baseFreq * tb.whineRatios[i]!, t, 0.25);
    }
    g.subOsc.frequency.setTargetAtTime(baseFreq / tb.subDivisor, t, 0.25);
    g.subGain.gain.setTargetAtTime(tb.subGain * (0.4 + throttle * 0.6 + ab * 0.5), t, SMOOTH);
    g.whineFilter.frequency.setTargetAtTime(tb.whineCutoff + throttle * tb.whineCutoffRange, t, SMOOTH);
    g.whineGain.gain.setTargetAtTime((0.025 + throttle * 0.05) * tb.whineGain, t, SMOOTH);

    // Broadband roar.
    g.roarFilter.frequency.setTargetAtTime(tb.roarCutoff + throttle * tb.roarCutoffRange + ab * 600, t, SMOOTH);
    g.roarGain.gain.setTargetAtTime((0.05 + throttle * 0.22 + ab * 0.08) * tb.roarGain, t, SMOOTH);

    // Afterburner deep rumble, crossfaded through the smoothed afterburner level.
    g.abFilter.frequency.setTargetAtTime(tb.abCutoff * (0.8 + ab * 0.4), t, SMOOTH);
    g.abGain.gain.setTargetAtTime(ab * tb.abGain, t, SMOOTH);

    // Wind rush: gain ~ speed², louder close to the ground, slight boost under high G.
    const low = state.agl < 30 ? 1 + (1 - Math.max(0, state.agl) / 30) * 0.8 : 1;
    const buffet = 1 + clamp01((Math.abs(state.gLoad) - 3) / 6) * 0.4;
    const windGain = Math.min(0.6, speedN * speedN * 0.35 * low * buffet);
    g.windGain.gain.setTargetAtTime(windGain, t, SMOOTH);
    g.windFilter.frequency.setTargetAtTime(400 + speedN * 1800 + (low - 1) * 600, t, SMOOTH);

    // Stall warning: repeating short beeps.
    if (state.stallWarning) {
      this.stallTimer -= step;
      if (this.stallTimer <= 0) {
        this.tone(g, g.warningsBus, 1450, 'square', 0.07, 0.12, t);
        this.stallTimer = Math.max(this.stallTimer + STALL_BEEP_PERIOD, 0.01);
      }
    } else {
      this.stallTimer = 0;
    }

    // PULL UP: alternating two-tone alarm.
    if (state.pullUp) {
      this.pullUpTimer -= step;
      if (this.pullUpTimer <= 0) {
        this.pullUpHigh = !this.pullUpHigh;
        this.tone(g, g.warningsBus, this.pullUpHigh ? 960 : 720, 'sawtooth', PULLUP_TONE_PERIOD * 0.9, 0.11, t, 2500);
        this.pullUpTimer = Math.max(this.pullUpTimer + PULLUP_TONE_PERIOD, 0.01);
      }
    } else {
      this.pullUpTimer = 0;
    }
  }

  /**
   * Spatial cues for other aircraft. Only the nearest few get a voice; voices are created once
   * and reused. Pass null (paused, menus) to fade every voice out.
   */
  updateFlybys(sources: readonly FlybySource[] | null, listener: FlybyListener | null): void {
    const g = this.ready();
    if (!g) return;
    const t = g.ctx.currentTime;

    if (!sources || !listener) {
      for (const v of g.voices) this.releaseVoice(v, t);
      this.lastPos.clear();
      return;
    }

    // Velocity estimates for sources that do not provide one; forget sources that went away.
    this.seen.clear();
    for (const s of sources) {
      this.seen.add(s.key);
      if (s.velocity) continue;
      const p = this.lastPos.get(s.key);
      if (!p) {
        this.lastPos.set(s.key, { x: s.position.x, y: s.position.y, z: s.position.z, t, vx: 0, vy: 0, vz: 0 });
      } else if (t - p.t > 1e-3) {
        const k = 1 / (t - p.t);
        p.vx += ((s.position.x - p.x) * k - p.vx) * 0.3;
        p.vy += ((s.position.y - p.y) * k - p.vy) * 0.3;
        p.vz += ((s.position.z - p.z) * k - p.vz) * 0.3;
        p.x = s.position.x;
        p.y = s.position.y;
        p.z = s.position.z;
        p.t = t;
      }
    }
    for (const key of this.lastPos.keys()) if (!this.seen.has(key)) this.lastPos.delete(key);

    const nearest = selectNearest(sources, listener.position, MAX_FLYBY_VOICES);
    while (g.voices.length < nearest.length) g.voices.push(this.createVoice(g));
    const slots = assignVoices(
      g.voices.map((v) => v.key),
      nearest.map((s) => s.key),
    );
    for (let i = 0; i < g.voices.length; i++) {
      const v = g.voices[i]!;
      const key = slots[i] ?? null;
      const src = key === null ? undefined : nearest.find((s) => s.key === key);
      if (!src) {
        this.releaseVoice(v, t);
        continue;
      }
      const fresh = v.key !== key;
      v.key = key;
      const est = this.lastPos.get(src.key);
      const vel = src.velocity ?? (est ? { x: est.vx, y: est.vy, z: est.vz } : ZERO);
      const tb = getJetTimbre(src.jetId);
      const p = src.position;
      const l = listener.position;
      const d = Math.hypot(p.x - l.x, p.y - l.y, p.z - l.z);
      const throttle = clamp01(src.throttle);
      const pitch = dopplerRatio(closingSpeed(p, vel, l, listener.velocity));
      const freq = (tb.whineBase + throttle * tb.whineRange) * pitch;
      const level = distanceGain(d) * (0.35 + 0.65 * throttle) * 0.22;
      if (fresh) {
        v.osc.type = tb.whineTypes[0];
        v.osc.frequency.cancelScheduledValues(t);
        v.osc.frequency.setValueAtTime(freq, t);
      } else {
        v.osc.frequency.setTargetAtTime(freq, t, 0.05);
      }
      v.oscFilter.frequency.setTargetAtTime((tb.whineCutoff + throttle * tb.whineCutoffRange) * Math.min(1.5, pitch), t, 0.05);
      v.noiseFilter.frequency.setTargetAtTime((tb.roarCutoff + 400 + throttle * tb.roarCutoffRange) * pitch, t, 0.05);
      v.gain.gain.setTargetAtTime(level, t, fresh ? 0.15 : 0.05);
      v.panner?.pan.setTargetAtTime(stereoPan(p, l, listener.right), t, 0.05);
    }
  }

  playGatePass(): void {
    const g = this.ready();
    if (!g) return;
    const t = g.ctx.currentTime;
    this.tone(g, g.effectsBus, 1046.5, 'triangle', 0.12, 0.25, t);
    this.tone(g, g.effectsBus, 1568, 'triangle', 0.22, 0.25, t + 0.08);
  }

  playGateMissed(): void {
    const g = this.ready();
    if (!g) return;
    this.tone(g, g.effectsBus, 110, 'sawtooth', 0.35, 0.22, g.ctx.currentTime, 600);
  }

  playCrash(): void {
    const g = this.ready();
    if (!g) return;
    const ctx = g.ctx;
    const t = ctx.currentTime;

    // Noise burst with a closing lowpass.
    const src = this.noiseSource(g);
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(6000, t);
    filt.frequency.setTargetAtTime(200, t, 0.35);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.linearRampToValueAtTime(0.9, t + 0.01);
    ng.gain.setTargetAtTime(0, t + 0.05, 0.45);
    src.connect(filt).connect(ng).connect(g.effectsBus);
    src.start(t, Math.random() * 1.5);
    src.stop(t + 2.5);
    this.track(src, ng);

    // Low boom: pitch-dropping sine.
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(90, t);
    osc.frequency.exponentialRampToValueAtTime(28, t + 1.2);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.linearRampToValueAtTime(0.9, t + 0.015);
    og.gain.setTargetAtTime(0, t + 0.05, 0.5);
    osc.connect(og).connect(g.effectsBus);
    osc.start(t);
    osc.stop(t + 2.5);
    this.track(osc, og);
  }

  playCountdownBeep(final: boolean): void {
    const g = this.ready();
    if (!g) return;
    if (final) this.tone(g, g.effectsBus, 1320, 'sine', 0.6, 0.3, g.ctx.currentTime);
    else this.tone(g, g.effectsBus, 660, 'sine', 0.18, 0.28, g.ctx.currentTime);
  }

  playLapComplete(): void {
    const g = this.ready();
    if (!g) return;
    const t = g.ctx.currentTime;
    const notes = [784, 988, 1175, 1568];
    notes.forEach((f, i) => {
      this.tone(g, g.effectsBus, f, 'triangle', i === notes.length - 1 ? 0.4 : 0.12, 0.22, t + i * 0.09);
    });
  }

  playDamage(): void {
    const g = this.ready();
    if (!g) return;
    const ctx = g.ctx;
    const t = ctx.currentTime;
    // Inharmonic partials give a metallic clang.
    const partials: ReadonlyArray<readonly [number, number]> = [
      [523, 0.12],
      [1397, 0.08],
      [2093, 0.06],
      [3271, 0.04],
    ];
    for (const [f, a] of partials) this.tone(g, g.effectsBus, f, 'square', 0.22, a, t, 3500);
    // Short high-passed noise click for the impact transient.
    const src = this.noiseSource(g);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1500;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.35, t);
    ng.gain.setTargetAtTime(0, t + 0.005, 0.03);
    src.connect(hp).connect(ng).connect(g.effectsBus);
    src.start(t, Math.random() * 1.5);
    src.stop(t + 0.25);
    this.track(src, ng);
  }

  // ---- dogfight weapons (synthesized; all on the effects bus except the warning tones) ----

  /** Gun burst: `rounds` cannon reports spaced at the rate of fire. `gain` < 1 for a distant gun. */
  playGunBurst(rounds = 1, gain = 1, interval = 0.04): void {
    const g = this.ready();
    if (!g || gain <= 0.01) return;
    const ctx = g.ctx;
    const t0 = ctx.currentTime;
    for (let i = 0; i < Math.min(rounds, 6); i++) {
      const t = t0 + i * interval;
      const src = this.noiseSource(g);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 900 + Math.random() * 300;
      bp.Q.value = 0.8;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.linearRampToValueAtTime(0.45 * gain, t + 0.003);
      env.gain.setTargetAtTime(0, t + 0.01, 0.025);
      src.connect(bp).connect(env).connect(g.effectsBus);
      src.start(t, Math.random() * 1.5);
      src.stop(t + 0.15);
      this.track(src, env);
      this.tone(g, g.effectsBus, 70, 'square', 0.06, 0.18 * gain, t, 400);
    }
  }

  /** Missile motor ignition: a rising whoosh. */
  playMissileLaunch(gain = 1): void {
    const g = this.ready();
    if (!g || gain <= 0.01) return;
    const ctx = g.ctx;
    const t = ctx.currentTime;
    const src = this.noiseSource(g);
    const filt = ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.Q.value = 1.2;
    filt.frequency.setValueAtTime(300, t);
    filt.frequency.exponentialRampToValueAtTime(2500, t + 0.6);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(0.7 * gain, t + 0.05);
    env.gain.setTargetAtTime(0, t + 0.4, 0.35);
    src.connect(filt).connect(env).connect(g.effectsBus);
    src.start(t, Math.random() * 1.5);
    src.stop(t + 2);
    this.track(src, env);
  }

  /** Flare salvo: `count` dull pops with a hiss. */
  playFlarePop(count = 2, gain = 1): void {
    const g = this.ready();
    if (!g || gain <= 0.01) return;
    const t = g.ctx.currentTime;
    for (let i = 0; i < Math.min(count, 4); i++) {
      this.tone(g, g.effectsBus, 180 - i * 20, 'triangle', 0.08, 0.3 * gain, t + i * 0.07, 900);
      const src = this.noiseSource(g);
      const hp = g.ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 3000;
      const env = g.ctx.createGain();
      env.gain.setValueAtTime(0.12 * gain, t + i * 0.07);
      env.gain.setTargetAtTime(0, t + i * 0.07 + 0.02, 0.12);
      src.connect(hp).connect(env).connect(g.effectsBus);
      src.start(t + i * 0.07, Math.random() * 1.5);
      src.stop(t + i * 0.07 + 0.8);
      this.track(src, env);
    }
  }

  /** Short bright tick confirming that our rounds hit. */
  playHitMarker(): void {
    const g = this.ready();
    if (!g) return;
    const t = g.ctx.currentTime;
    this.tone(g, g.effectsBus, 2400, 'square', 0.035, 0.08, t, 5000);
  }

  /** Missile detonation: a shorter, lighter crash. `gain` scales with distance. */
  playExplosion(gain = 1): void {
    const g = this.ready();
    if (!g || gain <= 0.01) return;
    const ctx = g.ctx;
    const t = ctx.currentTime;
    const src = this.noiseSource(g);
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(4000, t);
    filt.frequency.setTargetAtTime(250, t, 0.2);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.linearRampToValueAtTime(0.75 * gain, t + 0.01);
    ng.gain.setTargetAtTime(0, t + 0.04, 0.3);
    src.connect(filt).connect(ng).connect(g.effectsBus);
    src.start(t, Math.random() * 1.5);
    src.stop(t + 1.6);
    this.track(src, ng);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(110, t);
    osc.frequency.exponentialRampToValueAtTime(35, t + 0.8);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.linearRampToValueAtTime(0.7 * gain, t + 0.01);
    og.gain.setTargetAtTime(0, t + 0.04, 0.3);
    osc.connect(og).connect(g.effectsBus);
    osc.start(t);
    osc.stop(t + 1.6);
    this.track(osc, og);
  }

  /**
   * Seeker and missile-warning tones; call every frame (null = silence, e.g. paused or not in a
   * dogfight). lock 0..1: a growing beep while the seeker builds the lock, a steady tone at 1.
   * incoming: fast warning beeps while an enemy missile tracks us.
   */
  updateCombatTones(state: { lock: number; incomingMissile: boolean } | null, dt: number): void {
    const g = this.ready();
    const lock = state ? Math.min(Math.max(state.lock, 0), 1) : 0;
    const steady = this.ensureLockTone(g);
    if (steady && g) steady.gain.gain.setTargetAtTime(lock >= 1 ? 0.13 : 0, g.ctx.currentTime, 0.02);
    if (!g || !state) {
      this.lockBeepTimer = 0;
      this.missileWarnTimer = 0;
      return;
    }
    const t = g.ctx.currentTime;
    if (lock > 0 && lock < 1) {
      this.lockBeepTimer -= dt;
      if (this.lockBeepTimer <= 0) {
        this.tone(g, g.warningsBus, 900 + lock * 500, 'sine', 0.06, 0.07 + lock * 0.06, t);
        this.lockBeepTimer = 0.32 - lock * 0.24;
      }
    } else {
      this.lockBeepTimer = 0;
    }
    if (state.incomingMissile) {
      this.missileWarnTimer -= dt;
      if (this.missileWarnTimer <= 0) {
        this.tone(g, g.warningsBus, 2100, 'square', 0.05, 0.12, t, 4500);
        this.tone(g, g.warningsBus, 1600, 'square', 0.05, 0.12, t + 0.06, 4500);
        this.missileWarnTimer = 0.14;
      }
    } else {
      this.missileWarnTimer = 0;
    }
  }

  private lockBeepTimer = 0;
  private missileWarnTimer = 0;
  private lockTone: { ctx: AudioContext; osc: OscillatorNode; gain: GainNode } | null = null;

  /** The steady "locked" tone: one persistent oscillator per audio context, gated by its gain. */
  private ensureLockTone(g: Graph | null): { gain: GainNode } | null {
    if (!g) return this.lockTone && this.lockTone.ctx.state === 'running' ? this.lockTone : null;
    if (this.lockTone?.ctx === g.ctx) return this.lockTone;
    this.stopLockTone();
    const osc = g.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 1550;
    const gain = g.ctx.createGain();
    gain.gain.value = 0;
    osc.connect(gain).connect(g.warningsBus);
    osc.start();
    this.lockTone = { ctx: g.ctx, osc, gain };
    return this.lockTone;
  }

  private stopLockTone(): void {
    const lt = this.lockTone;
    this.lockTone = null;
    if (!lt) return;
    try {
      lt.osc.stop();
    } catch {
      /* already stopped */
    }
    lt.gain.disconnect();
  }

  dispose(): void {
    this.disposed = true;
    this.stopLockTone();
    const g = this.graph;
    this.graph = null;
    this.lastPos.clear();
    if (!g) return;
    const sources: AudioScheduledSourceNode[] = [...g.whineOscs, g.subOsc, g.roarSrc, g.abSrc, g.windSrc];
    for (const v of g.voices) sources.push(v.osc, v.noise);
    for (const node of sources) {
      try {
        node.stop();
      } catch {
        /* already stopped */
      }
    }
    g.voices.length = 0;
    void g.ctx.close().catch(() => undefined);
  }

  // ---- internals ----

  private ready(): Graph | null {
    const g = this.graph;
    return g && g.ctx.state === 'running' ? g : null;
  }

  private applyMixer(g: Graph, tau: number): void {
    const t = g.ctx.currentTime;
    const c = channelGains(this.mixer, this.warningActivity);
    g.master.gain.setTargetAtTime(c.master * MASTER_MAKEUP, t, tau);
    g.engineBus.gain.setTargetAtTime(c.engine, t, tau);
    g.effectsBus.gain.setTargetAtTime(c.effects * 0.9, t, tau);
    g.warningsBus.gain.setTargetAtTime(c.warnings, t, tau);
  }

  private applyTimbreTypes(g: Graph): void {
    const types = this.timbre.whineTypes;
    for (let i = 0; i < g.whineOscs.length; i++) g.whineOscs[i]!.type = types[i]!;
  }

  private releaseVoice(v: FlybyVoice, t: number): void {
    if (v.key === null) return;
    v.key = null;
    v.gain.gain.setTargetAtTime(0, t, 0.25);
  }

  private createVoice(g: Graph): FlybyVoice {
    const ctx = g.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 300;
    const oscFilter = ctx.createBiquadFilter();
    oscFilter.type = 'lowpass';
    oscFilter.frequency.value = 2000;
    const oscLevel = ctx.createGain();
    oscLevel.gain.value = 0.35;
    const noise = this.noiseSource(g);
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = 800;
    noiseFilter.Q.value = 0.7;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(oscFilter).connect(oscLevel).connect(gain);
    noise.connect(noiseFilter).connect(gain);
    const panner = typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null;
    if (panner) gain.connect(panner).connect(g.effectsBus);
    else gain.connect(g.effectsBus);
    osc.start(t);
    noise.start(t, Math.random() * 2);
    return { key: null, osc, oscFilter, noise, noiseFilter, gain, panner };
  }

  private buildGraph(ctx: AudioContext): Graph {
    const t = ctx.currentTime;
    const c = channelGains(this.mixer, 0);

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 4;
    comp.connect(ctx.destination);

    const master = ctx.createGain();
    master.gain.value = c.master * MASTER_MAKEUP;
    master.connect(comp);

    const bus = (v: number): GainNode => {
      const b = ctx.createGain();
      b.gain.value = v;
      b.connect(master);
      return b;
    };
    const engineBus = bus(c.engine);
    const effectsBus = bus(c.effects * 0.9);
    const warningsBus = bus(c.warnings);

    // Shared 2 s looping white-noise buffer.
    const len = Math.floor(ctx.sampleRate * 2);
    const noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    const loopNoise = (): AudioBufferSourceNode => {
      const s = ctx.createBufferSource();
      s.buffer = noise;
      s.loop = true;
      s.start(t, Math.random() * 2); // random offset decorrelates the layers
      return s;
    };

    const tb = this.timbre;

    // Turbine whine: three slightly detuned oscillators.
    const whineFilter = ctx.createBiquadFilter();
    whineFilter.type = 'lowpass';
    whineFilter.frequency.value = tb.whineCutoff;
    whineFilter.Q.value = 0.7;
    const whineGain = ctx.createGain();
    whineGain.gain.value = 0;
    whineFilter.connect(whineGain).connect(engineBus);
    const levels = [0.5, 0.5, 0.35];
    const whineOscs = tb.whineTypes.map((type, i) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = tb.whineBase * tb.whineRatios[i]!;
      const lg = ctx.createGain();
      lg.gain.value = levels[i]!;
      o.connect(lg).connect(whineFilter);
      o.start(t);
      return o;
    });

    // Sub-bass body (strongest on heavy jets).
    const subOsc = ctx.createOscillator();
    subOsc.type = 'sine';
    subOsc.frequency.value = tb.whineBase / tb.subDivisor;
    const subGain = ctx.createGain();
    subGain.gain.value = 0;
    subOsc.connect(subGain).connect(engineBus);
    subOsc.start(t);

    // Roar.
    const roarSrc = loopNoise();
    const roarFilter = ctx.createBiquadFilter();
    roarFilter.type = 'lowpass';
    roarFilter.frequency.value = tb.roarCutoff;
    roarFilter.Q.value = 0.5;
    const roarGain = ctx.createGain();
    roarGain.gain.value = 0;
    roarSrc.connect(roarFilter).connect(roarGain).connect(engineBus);

    // Afterburner rumble.
    const abSrc = loopNoise();
    const abFilter = ctx.createBiquadFilter();
    abFilter.type = 'lowpass';
    abFilter.frequency.value = tb.abCutoff;
    abFilter.Q.value = 1.2;
    const abGain = ctx.createGain();
    abGain.gain.value = 0;
    abSrc.connect(abFilter).connect(abGain).connect(engineBus);

    // Wind rush (part of the player's own flight sound → engine channel).
    const windSrc = loopNoise();
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 600;
    windFilter.Q.value = 0.8;
    const windGain = ctx.createGain();
    windGain.gain.value = 0;
    windSrc.connect(windFilter).connect(windGain).connect(engineBus);

    return {
      ctx,
      master,
      engineBus,
      effectsBus,
      warningsBus,
      noise,
      whineOscs,
      whineGain,
      whineFilter,
      subOsc,
      subGain,
      roarSrc,
      roarFilter,
      roarGain,
      abSrc,
      abFilter,
      abGain,
      windSrc,
      windFilter,
      windGain,
      voices: [],
    };
  }

  private noiseSource(g: Graph): AudioBufferSourceNode {
    const s = g.ctx.createBufferSource();
    s.buffer = g.noise;
    s.loop = true;
    return s;
  }

  /** Counts a one-shot until it ends, then disconnects its output node. */
  private track(src: AudioScheduledSourceNode, out: AudioNode): void {
    this.oneShots++;
    src.onended = () => {
      this.oneShots--;
      out.disconnect();
    };
  }

  /** One-shot enveloped oscillator with optional lowpass; disconnects itself when done. */
  private tone(
    g: Graph,
    bus: GainNode,
    freq: number,
    type: OscillatorType,
    duration: number,
    peak: number,
    start: number,
    lowpass?: number,
  ): void {
    const ctx = g.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    const env = ctx.createGain();
    const release = start + Math.max(0.01, duration - 0.04);
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(peak, start + 0.008);
    env.gain.setValueAtTime(peak, release);
    env.gain.setTargetAtTime(0, release, 0.015);
    let tail: AudioNode = osc;
    if (lowpass !== undefined) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = lowpass;
      tail = osc.connect(f);
    }
    tail.connect(env).connect(bus);
    osc.start(start);
    osc.stop(start + duration + 0.15);
    this.track(osc, env);
    if (bus === g.warningsBus) this.warningUntil = Math.max(this.warningUntil, start + duration);
  }
}