import type { SynAudioEngine } from '../../engine/audioEngine';

/**
 * Codec-audition A/B player (lazy-loaded with the Platform Preview panel). A = uncompressed master
 * snippet, B = decoded codec snippet. It plays into the engine's Platform Preview bus so both are
 * heard through the selected platform's playback gain, and switching A/B keeps the position.
 */
export class SnippetPlayer {
  private buffers: { a: AudioBuffer | null; b: AudioBuffer | null } = { a: null, b: null };
  private trimDb = { a: 0, b: 0 };
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private ctx: AudioContext | null = null;
  private startedAt = 0;
  private offset = 0;
  playing: 'a' | 'b' | null = null;
  onEnded?: () => void;

  constructor(private readonly engine: SynAudioEngine) {}

  load(
    a: { channels: Float32Array[]; sampleRate: number; trimDb?: number },
    b: { channels: Float32Array[]; sampleRate: number; trimDb?: number },
  ): void {
    this.stop();
    this.buffers = {
      a: this.engine.createAudioBufferFromChannels(a.channels, a.sampleRate),
      b: this.engine.createAudioBufferFromChannels(b.channels, b.sampleRate),
    };
    this.trimDb = { a: a.trimDb ?? 0, b: b.trimDb ?? 0 };
  }

  /** Play A or B; switching while playing continues from the same snippet position. */
  play(which: 'a' | 'b'): boolean {
    const buf = this.buffers[which];
    if (!buf) return false;
    const resumeAt = this.source ? this.position() : 0;
    const bus = this.engine.acquirePlatformPreviewInput();
    if (!bus) return false;
    this.stop();
    if (!this.gain || this.ctx !== bus.ctx) {
      this.ctx = bus.ctx;
      this.gain = bus.ctx.createGain();
      this.gain.connect(bus.input);
    }
    this.gain.gain.value = Math.pow(10, this.trimDb[which] / 20);
    const src = bus.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    const offset = Math.max(0, Math.min(buf.duration - 0.02, resumeAt));
    src.onended = () => {
      if (this.source !== src) return;
      this.source = null;
      this.playing = null;
      this.onEnded?.();
    };
    src.start(0, offset);
    this.source = src;
    this.playing = which;
    this.startedAt = bus.ctx.currentTime;
    this.offset = offset;
    return true;
  }

  stop(): void {
    const src = this.source;
    this.source = null;
    this.playing = null;
    if (!src) return;
    try {
      src.onended = null;
      src.stop();
      src.disconnect();
    } catch {
      // already stopped
    }
  }

  dispose(): void {
    this.stop();
    this.engine.onMainPlay = undefined;
    try { this.gain?.disconnect(); } catch { /* ignore */ }
    this.gain = null;
    this.buffers = { a: null, b: null };
  }

  private position(): number {
    return this.ctx ? this.offset + (this.ctx.currentTime - this.startedAt) : 0;
  }
}
