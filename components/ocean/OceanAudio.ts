/**
 * Procedural ambient ocean sound (Web Audio API, no audio files).
 *
 *   brown noise → low-pass   → "wash" gain  ┐
 *   pink noise  → band-pass  → "lap" gain   ├→ master → compressor → speakers
 *   pink noise  → high-pass  → "hiss" gain  ┘
 *
 * The wash breathes with the long swell, and the band-passed "lap" swells when
 * the boat drops into a trough (hull slap), driven by the same boat motion the
 * camera uses. Muted by default; the AudioContext is only created on the first
 * user gesture (browsers block audio before that).
 */

const NOISE_SECONDS = 8;

/** Fills a looping noise buffer; the tail is cross-faded into the head so the loop is seamless. */
function makeNoise(ctx: AudioContext, kind: 'brown' | 'pink'): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = NOISE_SECONDS * rate;
  const fade = Math.floor(rate * 0.5);
  const raw = new Float32Array(length + fade);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0; // prettier-ignore
  for (let i = 0; i < raw.length; i++) {
    const white = Math.random() * 2 - 1;
    if (kind === 'brown') {
      last = (last + 0.02 * white) / 1.02;
      raw[i] = last * 3.5;
    } else {
      // Paul Kellet's refined pink-noise filter.
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      b3 = 0.8665 * b3 + white * 0.3104856;
      b4 = 0.55 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.016898;
      raw[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
    }
  }
  const buffer = ctx.createBuffer(1, length, rate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    data[i] = i < fade ? raw[i] * (i / fade) + raw[length + i] * (1 - i / fade) : raw[i];
  }
  return buffer;
}

export class OceanAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private wash: GainNode | null = null;
  private washFilter: BiquadFilterNode | null = null;
  private lap: GainNode | null = null;
  private lapFilter: BiquadFilterNode | null = null;
  private sources: AudioBufferSourceNode[] = [];
  private enabled = false;
  private lastUpdate = 0;
  private suspendTimer = 0;

  get isEnabled() {
    return this.enabled;
  }

  private build(): AudioContext {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor();
    const brown = makeNoise(ctx, 'brown');
    const pink = makeNoise(ctx, 'pink');

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.ratio.value = 3;
    compressor.connect(ctx.destination);

    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(compressor);

    const source = (buffer: AudioBuffer, rate: number, offset: number) => {
      const s = ctx.createBufferSource();
      s.buffer = buffer;
      s.loop = true;
      s.playbackRate.value = rate;
      s.start(0, offset);
      this.sources.push(s);
      return s;
    };

    // Wash: the deep, slow roar of the open sea.
    const washFilter = ctx.createBiquadFilter();
    washFilter.type = 'lowpass';
    washFilter.frequency.value = 500;
    washFilter.Q.value = 0.4;
    const wash = ctx.createGain();
    wash.gain.value = 0.5;
    source(brown, 1, 0).connect(washFilter).connect(wash).connect(master);

    // Lap: water slapping against the hull.
    const lapFilter = ctx.createBiquadFilter();
    lapFilter.type = 'bandpass';
    lapFilter.frequency.value = 900;
    lapFilter.Q.value = 0.9;
    const lap = ctx.createGain();
    lap.gain.value = 0.1;
    source(pink, 0.97, 2.3).connect(lapFilter).connect(lap).connect(master);

    // Hiss: faint spray / distant breaking.
    const hissFilter = ctx.createBiquadFilter();
    hissFilter.type = 'highpass';
    hissFilter.frequency.value = 3800;
    const hiss = ctx.createGain();
    hiss.gain.value = 0.035;
    source(pink, 1.03, 5.1).connect(hissFilter).connect(hiss).connect(master);

    this.ctx = ctx;
    this.master = master;
    this.wash = wash;
    this.washFilter = washFilter;
    this.lap = lap;
    this.lapFilter = lapFilter;

    document.addEventListener('visibilitychange', this.onVisibility);
    return ctx;
  }

  private onVisibility = () => {
    if (!this.ctx || !this.enabled) return;
    if (document.hidden) void this.ctx.suspend();
    else void this.ctx.resume();
  };

  /** Must be called from a user gesture the first time (autoplay policy). */
  async setEnabled(on: boolean) {
    this.enabled = on;
    window.clearTimeout(this.suspendTimer);
    if (on) {
      const ctx = this.ctx ?? this.build();
      await ctx.resume();
      // Muted again while the output device was waking up? Then stay silent.
      if (!this.enabled || !this.master) return;
      this.master.gain.setTargetAtTime(0.55, ctx.currentTime, 0.8);
    } else if (this.ctx && this.master) {
      const ctx = this.ctx;
      const master = this.master;
      master.gain.setTargetAtTime(0, ctx.currentTime, 0.2);
      this.suspendTimer = window.setTimeout(() => {
        if (this.enabled) return;
        // Land exactly on silence so the next enable fades in from zero.
        master.gain.cancelScheduledValues(ctx.currentTime);
        master.gain.setValueAtTime(0, ctx.currentTime);
        void ctx.suspend();
      }, 900);
    }
  }

  /**
   * Couples the sound to the sea. `heave` is the boat's vertical velocity
   * (m/s, negative = falling). Throttled to ~12 updates per second.
   */
  update(time: number, heave: number) {
    if (!this.enabled || !this.ctx || !this.wash || !this.lap || !this.washFilter || !this.lapFilter) return;
    if (time - this.lastUpdate < 0.08 && time >= this.lastUpdate) return;
    this.lastUpdate = time;
    const now = this.ctx.currentTime;
    const motion = Math.min(Math.abs(heave) / 0.6, 1);
    // Wash breathes with the ~11 s swell and opens up when the boat moves.
    const breath = 0.5 + 0.5 * Math.sin((time / 11.5) * Math.PI * 2);
    this.wash.gain.setTargetAtTime(0.32 + 0.18 * breath + 0.25 * motion, now, 0.4);
    this.washFilter.frequency.setTargetAtTime(380 + 260 * breath + 420 * motion, now, 0.4);
    // Slap when the hull drops into a trough.
    const falling = Math.min(Math.max(-heave / 0.45, 0), 1);
    this.lap.gain.setTargetAtTime(0.06 + 0.5 * falling * falling, now, 0.12);
    this.lapFilter.frequency.setTargetAtTime(700 + 600 * falling, now, 0.15);
  }

  dispose() {
    window.clearTimeout(this.suspendTimer);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.sources.forEach((s) => s.stop());
    this.sources = [];
    void this.ctx?.close();
    this.ctx = null;
    this.enabled = false;
  }
}
