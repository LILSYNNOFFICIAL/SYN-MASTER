/**
 * Links a whole-track peak array (what the EQ graph is given) to the audio it was measured
 * from, so the graph can recompute waveform detail at higher resolution when zoomed.
 * Keyed by the peak array's identity in a WeakMap: nothing is retained after the app drops it.
 */
import { buildPeakBlocks, PEAK_BLOCK } from './waveformView';

export interface WaveformSource {
  channels: Float32Array[];
  sampleRate: number;
  /** True when this audio already has the timeline fades applied (post render). */
  includesFades: boolean;
}

const sources = new WeakMap<object, WaveformSource>();
const blockCache = new WeakMap<Float32Array, Float32Array>();
const pending = new WeakMap<Float32Array, Promise<Float32Array>>();

export function registerWaveformSource(peaks: object | null | undefined, source: WaveformSource | null): void {
  if (!peaks || !source || !source.channels?.length) return;
  sources.set(peaks, source);
}

export function getWaveformSource(peaks: object | null | undefined): WaveformSource | null {
  return peaks ? sources.get(peaks) ?? null : null;
}

export function getCachedPeakBlocks(channels: Float32Array[]): Float32Array | null {
  return channels[0] ? blockCache.get(channels[0]) ?? null : null;
}

/** Build the block pyramid in ~0.5M-sample slices with yields so the UI never stalls. */
export function ensurePeakBlocks(channels: Float32Array[]): Promise<Float32Array> {
  const key = channels[0];
  const cached = key ? blockCache.get(key) : undefined;
  if (cached) return Promise.resolve(cached);
  const inflight = key ? pending.get(key) : undefined;
  if (inflight) return inflight;
  const n = key?.length ?? 0;
  const blocks = new Float32Array(Math.ceil(n / PEAK_BLOCK));
  const slice = 2048; // blocks per slice (= 524,288 samples)
  const job = new Promise<Float32Array>((resolve) => {
    let b = 0;
    const step = () => {
      buildPeakBlocks(channels, b, b + slice, blocks);
      b += slice;
      if (b < blocks.length) setTimeout(step, 0);
      else {
        if (key) blockCache.set(key, blocks);
        resolve(blocks);
      }
    };
    step();
  });
  if (key) pending.set(key, job);
  return job;
}
