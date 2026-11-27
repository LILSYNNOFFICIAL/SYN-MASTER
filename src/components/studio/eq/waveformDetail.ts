/**
 * Zoomed waveform detail (loaded on demand, outside the main bundle): a cached max-abs block
 * pyramid per track and envelope extraction for any visible window.
 */
import type { TimeView } from './waveformView';

const blockCache = new WeakMap<Float32Array, Float32Array>();
const pending = new WeakMap<Float32Array, Promise<Float32Array>>();

/** Block size of the cached max-abs pyramid used for zoomed waveform detail. */
export const PEAK_BLOCK = 256;

/** Max |L|,|R| per PEAK_BLOCK samples. Built in chunks by the caller to stay responsive. */
export function buildPeakBlocks(channels: Float32Array[], from = 0, to?: number, out?: Float32Array): Float32Array {
  const left = channels[0];
  const right = channels[1] ?? left;
  const n = left?.length ?? 0;
  const blocks = out ?? new Float32Array(Math.ceil(n / PEAK_BLOCK));
  const end = Math.min(blocks.length, to ?? blocks.length);
  for (let b = Math.max(0, from); b < end; b++) {
    const s = b * PEAK_BLOCK;
    const e = Math.min(n, s + PEAK_BLOCK);
    let m = 0;
    for (let i = s; i < e; i++) {
      const v = Math.max(Math.abs(left[i]), Math.abs(right[i]));
      if (v > m) m = v;
    }
    blocks[b] = m;
  }
  return blocks;
}

/**
 * Envelope for the visible window at full detail: uses the block pyramid when each column
 * spans at least one block, and reads raw samples when zoomed in further (a small window).
 */
export function envelopeFromSamples(
  channels: Float32Array[],
  sampleRate: number,
  view: TimeView,
  bins: number,
  blocks: Float32Array | null,
): number[] {
  const left = channels[0];
  const right = channels[1] ?? left;
  const n = left?.length ?? 0;
  const out: number[] = new Array(Math.max(0, bins)).fill(0);
  if (!n || sampleRate <= 0 || bins <= 0) return out;
  const s0 = Math.max(0, Math.floor(view.start * sampleRate));
  const s1 = Math.min(n, Math.ceil(view.end * sampleRate));
  const per = (s1 - s0) / bins;
  for (let i = 0; i < bins; i++) {
    const a = Math.floor(s0 + i * per);
    const b = Math.min(n, Math.max(a + 1, Math.floor(s0 + (i + 1) * per)));
    let m = 0;
    if (blocks && b - a >= PEAK_BLOCK * 2) {
      const ba = Math.ceil(a / PEAK_BLOCK);
      const bb = Math.floor(b / PEAK_BLOCK);
      for (let k = a; k < Math.min(b, ba * PEAK_BLOCK); k++) m = Math.max(m, Math.abs(left[k]), Math.abs(right[k]));
      for (let k = ba; k < bb; k++) if (blocks[k] > m) m = blocks[k];
      for (let k = Math.max(a, bb * PEAK_BLOCK); k < b; k++) m = Math.max(m, Math.abs(left[k]), Math.abs(right[k]));
    } else {
      for (let k = a; k < b; k++) {
        const v = Math.max(Math.abs(left[k]), Math.abs(right[k]));
        if (v > m) m = v;
      }
    }
    out[i] = Math.min(1, m);
  }
  return out;
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

const energyCache = new WeakMap<Float32Array, Float32Array>();
const energyPending = new WeakMap<Float32Array, Promise<Float32Array>>();

/** Sum of (L^2 + R^2) / 2 per PEAK_BLOCK samples (for RMS). Built in slices by the caller. */
export function buildEnergyBlocks(channels: Float32Array[], from = 0, to?: number, out?: Float32Array): Float32Array {
  const left = channels[0];
  const right = channels[1] ?? left;
  const n = left?.length ?? 0;
  const blocks = out ?? new Float32Array(Math.ceil(n / PEAK_BLOCK));
  const end = Math.min(blocks.length, to ?? blocks.length);
  for (let b = Math.max(0, from); b < end; b++) {
    const s = b * PEAK_BLOCK;
    const e = Math.min(n, s + PEAK_BLOCK);
    let sum = 0;
    for (let i = s; i < e; i++) sum += (left[i] * left[i] + right[i] * right[i]) * 0.5;
    blocks[b] = sum;
  }
  return blocks;
}

/** Energy blocks built in ~0.5M-sample slices with yields; cached per track. */
export function ensureEnergyBlocks(channels: Float32Array[]): Promise<Float32Array> {
  const key = channels[0];
  const cached = key ? energyCache.get(key) : undefined;
  if (cached) return Promise.resolve(cached);
  const inflight = key ? energyPending.get(key) : undefined;
  if (inflight) return inflight;
  const blocks = new Float32Array(Math.ceil((key?.length ?? 0) / PEAK_BLOCK));
  const job = new Promise<Float32Array>((resolve) => {
    let b = 0;
    const step = () => {
      buildEnergyBlocks(channels, b, b + 2048, blocks);
      b += 2048;
      if (b < blocks.length) setTimeout(step, 0);
      else {
        if (key) energyCache.set(key, blocks);
        resolve(blocks);
      }
    };
    step();
  });
  if (key) energyPending.set(key, job);
  return job;
}

/** RMS (0..1) per column of the visible window; uses energy blocks for wide columns. */
export function rmsFromSamples(
  channels: Float32Array[],
  sampleRate: number,
  view: TimeView,
  bins: number,
  energy: Float32Array | null,
): number[] {
  const left = channels[0];
  const right = channels[1] ?? left;
  const n = left?.length ?? 0;
  const out: number[] = new Array(Math.max(0, bins)).fill(0);
  if (!n || sampleRate <= 0 || bins <= 0) return out;
  const s0 = Math.max(0, Math.floor(view.start * sampleRate));
  const s1 = Math.min(n, Math.ceil(view.end * sampleRate));
  const per = (s1 - s0) / bins;
  const sq = (k: number) => (left[k] * left[k] + right[k] * right[k]) * 0.5;
  for (let i = 0; i < bins; i++) {
    const a = Math.floor(s0 + i * per);
    const b = Math.min(n, Math.max(a + 1, Math.floor(s0 + (i + 1) * per)));
    if (a >= n) break;
    let sum = 0;
    if (energy && b - a >= PEAK_BLOCK * 2) {
      const ba = Math.ceil(a / PEAK_BLOCK);
      const bb = Math.floor(b / PEAK_BLOCK);
      for (let k = a; k < ba * PEAK_BLOCK; k++) sum += sq(k);
      for (let k = ba; k < bb; k++) sum += energy[k];
      for (let k = bb * PEAK_BLOCK; k < b; k++) sum += sq(k);
    } else {
      for (let k = a; k < b; k++) sum += sq(k);
    }
    out[i] = Math.min(1, Math.sqrt(Math.max(0, sum) / (b - a)));
  }
  return out;
}
