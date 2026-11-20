export class SongAudioEngine {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private media: HTMLAudioElement;
  private objectUrl: string | null = null;
  private onEndedCallback: (() => void) | null = null;
  private playbackRate = 1;
  private sfxEnabled = true;

  constructor() {
    this.media = new Audio();
    this.media.crossOrigin = "anonymous";
    this.media.preload = "auto";
    this.media.preservesPitch = true;
    this.media.addEventListener("ended", () => {
      this.onEndedCallback?.();
    });
  }

  onEnded(cb: () => void) {
    this.onEndedCallback = cb;
  }

  private ensureGraph() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (!this.analyser) {
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.68;
      this.analyser.minDecibels = -92;
      this.analyser.maxDecibels = -12;
    }
    if (!this.sourceNode) {
      this.sourceNode = this.ctx.createMediaElementSource(this.media);
      this.sourceNode.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    }
  }

  async loadUrl(url: string): Promise<number> {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.media.pause();
    this.media.src = url;
    this.media.currentTime = 0;
    this.media.playbackRate = this.playbackRate;
    this.media.preservesPitch = true;

    return await new Promise<number>((resolve, reject) => {
      const onLoaded = () => {
        cleanup();
        resolve(Number.isFinite(this.media.duration) ? this.media.duration : 180);
      };
      const onError = () => {
        cleanup();
        reject(new Error("Could not decode audio track."));
      };
      const cleanup = () => {
        this.media.removeEventListener("loadedmetadata", onLoaded);
        this.media.removeEventListener("error", onError);
      };
      this.media.addEventListener("loadedmetadata", onLoaded);
      this.media.addEventListener("error", onError);
      this.media.load();
    });
  }

  async loadFile(file: File): Promise<number> {
    const url = URL.createObjectURL(file);
    const dur = await this.loadUrl(url);
    this.objectUrl = url;
    return dur;
  }

  async play() {
    this.ensureGraph();
    if (this.ctx && this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
    this.media.playbackRate = this.playbackRate;
    this.media.preservesPitch = true;
    await this.media.play();
  }

  pause() {
    this.media.pause();
  }

  seek(seconds: number) {
    const dur = this.duration;
    this.media.currentTime = Math.max(0, Math.min(dur || 1000, seconds));
  }

  setPlaybackRate(rate: number) {
    this.playbackRate = Math.max(0.5, Math.min(1.5, rate));
    this.media.playbackRate = this.playbackRate;
    this.media.preservesPitch = true;
  }

  getPlaybackRate(): number {
    return this.playbackRate;
  }

  setSfxEnabled(enabled: boolean) {
    this.sfxEnabled = enabled;
  }

  isSfxEnabled(): boolean {
    return this.sfxEnabled;
  }

  setVolume(vol: number) {
    this.media.volume = Math.max(0, Math.min(1, vol));
  }

  get currentTime(): number {
    const raw = this.media.currentTime || 0;
    if (!this.playing || !this.ctx) return raw;
    const hwLatency = Math.min(0.35, Math.max(0, (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0)));
    const latency = (hwLatency + 0.04) * this.playbackRate;
    return Math.max(0, raw - latency);
  }

  get duration(): number {
    return Number.isFinite(this.media.duration) ? this.media.duration : 0;
  }

  get playing(): boolean {
    return !this.media.paused && !this.media.ended;
  }

  getAnalyser(): AnalyserNode | undefined {
    return this.playing ? this.analyser ?? undefined : undefined;
  }

  /** Subtle warm chime when catching a target firefly (uniform pitch + soft micro-haptic beat resonance). */
  playCatchChime(streak: number, rhythmResonance = 0) {
    if (!this.sfxEnabled || !this.ctx || this.ctx.state !== "running") return;
    const now = this.ctx.currentTime;
    const scale = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5];
    const freq = scale[Math.min(streak, 12) % scale.length];

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(freq * 1.015, now + 0.14);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.072 + rhythmResonance * 0.014, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);

    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.26);

    // Subtle VR-controller-style sub-bass micro-thump when catching near the vocal beat
    if (rhythmResonance > 0.05) {
      const thump = this.ctx.createOscillator();
      const thumpGain = this.ctx.createGain();
      thump.type = "sine";
      thump.frequency.setValueAtTime(112, now);
      thump.frequency.exponentialRampToValueAtTime(56, now + 0.052);
      thumpGain.gain.setValueAtTime(0.0001, now);
      thumpGain.gain.linearRampToValueAtTime(0.048 * rhythmResonance, now + 0.005);
      thumpGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.068);
      thump.connect(thumpGain);
      thumpGain.connect(this.ctx.destination);
      thump.start(now);
      thump.stop(now + 0.075);
    }

    // Almost unnoticeable crystal whisper fifth harmonic when dead-on beat
    if (rhythmResonance >= 0.75) {
      const overtone = this.ctx.createOscillator();
      const overtoneGain = this.ctx.createGain();
      overtone.type = "sine";
      overtone.frequency.setValueAtTime(freq * 1.5, now);
      overtoneGain.gain.setValueAtTime(0.0001, now);
      overtoneGain.gain.linearRampToValueAtTime(0.016 * rhythmResonance, now + 0.008);
      overtoneGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
      overtone.connect(overtoneGain);
      overtoneGain.connect(this.ctx.destination);
      overtone.start(now);
      overtone.stop(now + 0.16);
    }
  }

  /** Soft muted wood tap when catching a wrong decoy (gentle, never harsh). */
  playWrongTap() {
    if (!this.sfxEnabled || !this.ctx || this.ctx.state !== "running") return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(210, now);
    osc.frequency.exponentialRampToValueAtTime(145, now + 0.12);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.055, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);

    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.16);
  }
}
