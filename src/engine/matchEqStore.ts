import type { MatchEqSpectrumSet } from '../types/mastering';
import { learnMatchEqSpectrum, type MatchEqProfile } from '../dsp/matchEq';

/**
 * What Match EQ can learn from right now: the loaded reference track's spectrum (learned when
 * the reference loads) and the active source (learned lazily, cached per source). App publishes
 * the audio; the Match EQ editors read it, so no props need threading through every rack view.
 */
export interface MatchEqLearnState {
  reference: MatchEqSpectrumSet | null;
  referenceName: string | null;
  /** True when a source track is loaded (its spectrum is learned on first use). */
  hasSource: boolean;
}

type Listener = (s: MatchEqLearnState) => void;

class MatchEqStore {
  private state: MatchEqLearnState = { reference: null, referenceName: null, hasSource: false };
  private listeners = new Set<Listener>();
  private source: { channels: Float32Array[]; sampleRate: number } | null = null;
  private sourceSpectrum: MatchEqSpectrumSet | null = null;

  getSnapshot = (): MatchEqLearnState => this.state;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  private emit(patch: Partial<MatchEqLearnState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  setReference(channels: Float32Array[] | null, sampleRate: number, name: string | null): MatchEqSpectrumSet | null {
    const spectrum = channels ? learnMatchEqSpectrum(channels, sampleRate) : null;
    this.emit({ reference: spectrum, referenceName: spectrum ? name : null });
    return spectrum;
  }

  setSource(channels: Float32Array[] | null, sampleRate: number): void {
    this.source = channels ? { channels, sampleRate } : null;
    this.sourceSpectrum = null;
    this.emit({ hasSource: Boolean(channels) });
  }

  /** Source spectrum, learned on first request and cached until the source changes. */
  getSourceSpectrum(): MatchEqSpectrumSet | null {
    if (!this.sourceSpectrum && this.source) {
      this.sourceSpectrum = learnMatchEqSpectrum(this.source.channels, this.source.sampleRate);
    }
    return this.sourceSpectrum;
  }

  /** Source + reference, or null when either is missing. */
  getProfile(): MatchEqProfile | null {
    const reference = this.state.reference;
    if (!reference) return null;
    const source = this.getSourceSpectrum();
    if (!source) return null;
    return { source, reference, ...(this.state.referenceName ? { referenceName: this.state.referenceName } : {}) };
  }
}

export const matchEqStore = new MatchEqStore();
export { MatchEqStore };
