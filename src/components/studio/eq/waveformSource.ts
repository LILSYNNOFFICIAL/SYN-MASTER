/**
 * Links a whole-track peak array (what the EQ graph is given) to the audio it was measured
 * from, so the graph can recompute waveform detail at higher resolution when zoomed.
 * Keyed by the peak array's identity in a WeakMap: nothing is retained after the app drops it.
 */
export interface WaveformSource {
  channels: Float32Array[];
  sampleRate: number;
  /** True when this audio already has the timeline fades applied (post render). */
  includesFades: boolean;
}

const sources = new WeakMap<object, WaveformSource>();

export function registerWaveformSource(peaks: object | null | undefined, source: WaveformSource | null): void {
  if (!peaks || !source || !source.channels?.length) return;
  sources.set(peaks, source);
}

export function getWaveformSource(peaks: object | null | undefined): WaveformSource | null {
  return peaks ? sources.get(peaks) ?? null : null;
}
