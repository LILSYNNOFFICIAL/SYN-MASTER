/**
 * Vocal Rebalance DSP (Ozone Master Rebalance style).
 *
 * The stems are HT-Demucs separations of the SOURCE track at the session rate, made
 * mixture-consistent (vocals + bass + drums + other == source). Instead of rebuilding the
 * mix from stems (which would replace the master with model output), only the gain
 * difference is added back on top of the untouched input:
 *
 *     out[i] = in[i] + sum_s (g_s - 1) * w_s(i) * stem_s[i]
 *
 * so the original phase, transients and everything the model missed stay in place, and
 * 0 dB on every stem returns the input bit-for-bit (the processor does not touch it).
 *
 * w_s(i) is 1 at sensitivity 0. Higher sensitivity weights the gain by how much the stem
 * dominates the mix in each 256-sample hop (share^p, p = sensitivity / 50), smoothed with a
 * zero-phase one-pole (forward + backward) and linearly interpolated per sample, so bleed in
 * passages where the stem is quiet is left alone.
 *
 * Stems are looked up in a small registry keyed by a fingerprint of the stereo audio they
 * were separated from. processChainOffline only applies them when the module's own input
 * matches that fingerprint, so a rebalance placed after other processing, or on a different
 * track, is a no-op instead of a wrong mix (validation also hoists it to the head of the chain).
 */
import type { VocalRebalanceParams } from '../types/mastering.ts';

export type RebalanceStemId = 'vocals' | 'bass' | 'drums';
export const REBALANCE_STEM_IDS: RebalanceStemId[] = ['vocals', 'bass', 'drums'];

export interface RebalanceStemSet {
  /** Fingerprint of the stereo source these stems were separated from (see fingerprintStereo). */
  fingerprint: string;
  sampleRate: number;
  length: number;
  stems: Record<RebalanceStemId, [Float32Array, Float32Array]>;
}

export const VOCAL_REBALANCE_LIMITS = {
  gainMinDb: -12,
  gainMaxDb: 6,
  sensitivityMin: 0,
  sensitivityMax: 100,
  smoothingMinMs: 5,
  smoothingMaxMs: 500,
} as const;

export const DEFAULT_VOCAL_REBALANCE_PARAMS: VocalRebalanceParams = {
  vocalGainDb: 0,
  bassEnabled: false,
  bassGainDb: 0,
  drumsEnabled: false,
  drumsGainDb: 0,
  sensitivity: 30,
  smoothingMs: 40,
};

const HOP = 256;
const UNITY_EPS_DB = 1e-4;

// ---------------------------------------------------------------------------------------------
// Fingerprint + registry
// ---------------------------------------------------------------------------------------------

/**
 * Cheap, exact-bit fingerprint of a stereo buffer: length, sample rate and the raw float bits
 * of up to 4096 evenly spaced frames (FNV-1a). Mono sources are fingerprinted as (L, L), the
 * same way the renderer duplicates them.
 */
export function fingerprintStereo(left: Float32Array, right: Float32Array, sampleRate: number): string {
  const n = left.length;
  const bitsL = new Uint32Array(left.buffer, left.byteOffset, n);
  const bitsR = new Uint32Array(right.buffer, right.byteOffset, right.length);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ n;
  const mix = (h: number, v: number) => Math.imul(h ^ v, 0x01000193) >>> 0;
  const probes = Math.min(n, 4096);
  for (let p = 0; p < probes; p++) {
    const i = probes === n ? p : Math.floor((p * (n - 1)) / Math.max(1, probes - 1));
    h1 = mix(h1, bitsL[i]);
    h2 = mix(h2, i < bitsR.length ? bitsR[i] : 0);
  }
  return `${n.toString(36)}-${Math.round(sampleRate).toString(36)}-${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

/** Stems resident in this realm (main thread or DSP worker). Bounded: the active track plus one. */
const registry = new Map<string, RebalanceStemSet>();
const MAX_RESIDENT_SETS = 2;
let registryVersion = 0;

export function registerRebalanceStems(set: RebalanceStemSet): void {
  validateStemSet(set);
  registry.delete(set.fingerprint);
  registry.set(set.fingerprint, set);
  while (registry.size > MAX_RESIDENT_SETS) {
    const oldest = registry.keys().next().value as string;
    registry.delete(oldest);
  }
  registryVersion++;
}

export function unregisterRebalanceStems(fingerprint?: string): void {
  if (fingerprint === undefined) registry.clear();
  else registry.delete(fingerprint);
  registryVersion++;
}

export function getRebalanceStems(fingerprint: string): RebalanceStemSet | null {
  return registry.get(fingerprint) ?? null;
}

export function getRebalanceRegistryVersion(): number {
  return registryVersion;
}

function validateStemSet(set: RebalanceStemSet): void {
  if (!set || typeof set.fingerprint !== 'string' || !set.fingerprint) throw new RangeError('Stem set needs a fingerprint.');
  if (!Number.isFinite(set.sampleRate) || set.sampleRate <= 0) throw new RangeError('Stem set needs a sample rate.');
  for (const id of REBALANCE_STEM_IDS) {
    const pair = set.stems?.[id];
    if (!pair || pair.length !== 2 || pair[0].length !== set.length || pair[1].length !== set.length) {
      throw new RangeError(`Stem "${id}" must be stereo with ${set.length} frames.`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------------------------

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** Clamp / default every field. Used by chain validation (AI, presets, saved projects). */
export function sanitizeVocalRebalanceParams(raw: unknown): VocalRebalanceParams {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_VOCAL_REBALANCE_PARAMS;
  const L = VOCAL_REBALANCE_LIMITS;
  return {
    vocalGainDb: clampNum(src.vocalGainDb, L.gainMinDb, L.gainMaxDb, d.vocalGainDb),
    bassEnabled: src.bassEnabled === true,
    bassGainDb: clampNum(src.bassGainDb, L.gainMinDb, L.gainMaxDb, d.bassGainDb),
    drumsEnabled: src.drumsEnabled === true,
    drumsGainDb: clampNum(src.drumsGainDb, L.gainMinDb, L.gainMaxDb, d.drumsGainDb),
    sensitivity: clampNum(src.sensitivity, L.sensitivityMin, L.sensitivityMax, d.sensitivity),
    smoothingMs: clampNum(src.smoothingMs, L.smoothingMinMs, L.smoothingMaxMs, d.smoothingMs),
  };
}

/** Effective dB per stem after intensity scaling; disabled bass/drums are 0 dB. */
export function effectiveStemGainsDb(p: VocalRebalanceParams, intensityScale = 1): Record<RebalanceStemId, number> {
  const s = Math.max(0, Math.min(1, intensityScale));
  return {
    vocals: p.vocalGainDb * s,
    bass: p.bassEnabled ? p.bassGainDb * s : 0,
    drums: p.drumsEnabled ? p.drumsGainDb * s : 0,
  };
}

/** True when the module would change audio (some stem away from 0 dB). */
export function rebalanceIsActive(p: VocalRebalanceParams, intensityScale = 1): boolean {
  const g = effectiveStemGainsDb(p, intensityScale);
  return REBALANCE_STEM_IDS.some((id) => Math.abs(g[id]) > UNITY_EPS_DB);
}

// ---------------------------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------------------------

export interface VocalRebalanceTelemetry {
  applied: boolean;
  /** Why nothing was applied: every gain at 0 dB, no cached stems for this audio, or a length / rate mismatch. */
  reason?: 'unity' | 'no-stems' | 'mismatch';
  stemGainsDb: Record<RebalanceStemId, number>;
}

/** Per-hop weight w (0..1) for one stem: share^p, zero-phase smoothed. Length = hops. */
export function computeStemWeights(
  stem: [Float32Array, Float32Array],
  mixL: Float32Array,
  mixR: Float32Array,
  length: number,
  sampleRate: number,
  sensitivity: number,
  smoothingMs: number,
  stemScale = 1,
): Float32Array {
  const hops = Math.max(1, Math.ceil(length / HOP));
  const w = new Float32Array(hops);
  const p = Math.max(0, sensitivity) / 50;
  for (let h = 0; h < hops; h++) {
    const a = h * HOP;
    const b = Math.min(length, a + HOP);
    let es = 0;
    let em = 0;
    for (let i = a; i < b; i++) {
      const sl = stem[0][i];
      const sr = stem[1][i];
      es += sl * sl + sr * sr;
      em += mixL[i] * mixL[i] + mixR[i] * mixR[i];
    }
    es *= stemScale * stemScale;
    const share = em > 1e-12 ? Math.min(1, es / em) : es > 1e-12 ? 1 : 0;
    w[h] = share <= 0 ? 0 : Math.pow(share, p);
  }
  const tau = (Math.max(1, smoothingMs) / 1000) * sampleRate;
  const alpha = Math.exp(-HOP / tau);
  // forward
  for (let h = 1; h < hops; h++) w[h] = alpha * w[h - 1] + (1 - alpha) * w[h];
  // backward (zero phase)
  for (let h = hops - 2; h >= 0; h--) w[h] = alpha * w[h + 1] + (1 - alpha) * w[h];
  return w;
}

/**
 * Apply the rebalance in place. `inputScale` is the module's input gain (the stems belong to
 * the unscaled input). Returns telemetry; never touches the buffers when nothing applies.
 */
export function applyVocalRebalance(
  left: Float32Array,
  right: Float32Array,
  params: VocalRebalanceParams,
  stems: RebalanceStemSet | null,
  sampleRate: number,
  intensityScale: number,
  inputScale = 1,
): VocalRebalanceTelemetry {
  const p = sanitizeVocalRebalanceParams(params);
  const gainsDb = effectiveStemGainsDb(p, intensityScale);
  const active = REBALANCE_STEM_IDS.filter((id) => Math.abs(gainsDb[id]) > UNITY_EPS_DB);
  if (active.length === 0) return { applied: false, reason: 'unity', stemGainsDb: gainsDb };
  if (!stems) return { applied: false, reason: 'no-stems', stemGainsDb: gainsDb };
  const length = left.length;
  if (stems.length !== length || Math.round(stems.sampleRate) !== Math.round(sampleRate)) {
    return { applied: false, reason: 'mismatch', stemGainsDb: gainsDb };
  }

  const useWeights = p.sensitivity > 0;
  // Weights are measured against the input mix BEFORE any stem is changed.
  const weights = useWeights
    ? active.map((id) => computeStemWeights(stems.stems[id], left, right, length, sampleRate, p.sensitivity, p.smoothingMs, inputScale))
    : null;

  for (let s = 0; s < active.length; s++) {
    const id = active[s];
    const k = (Math.pow(10, gainsDb[id] / 20) - 1) * inputScale;
    const [sl, sr] = stems.stems[id];
    if (!weights) {
      for (let i = 0; i < length; i++) {
        left[i] += k * sl[i];
        right[i] += k * sr[i];
      }
      continue;
    }
    const w = weights[s];
    const hops = w.length;
    for (let i = 0; i < length; i++) {
      // Hop centres sit at h*HOP + HOP/2; interpolate linearly between them.
      const pos = (i - HOP / 2) / HOP;
      const h0 = Math.max(0, Math.min(hops - 1, Math.floor(pos)));
      const h1 = Math.min(hops - 1, h0 + 1);
      const frac = Math.max(0, Math.min(1, pos - h0));
      const wi = w[h0] + (w[h1] - w[h0]) * frac;
      const gk = k * wi;
      left[i] += gk * sl[i];
      right[i] += gk * sr[i];
    }
  }
  return { applied: true, stemGainsDb: gainsDb };
}

// ---------------------------------------------------------------------------------------------
// Meters
// ---------------------------------------------------------------------------------------------

export const STEM_ENVELOPE_HOP_SEC = 0.05;

/** Short-term RMS (dBFS) per 50 ms hop, for the per-stem level meters (read at the playhead). */
export function computeStemEnvelopeDb(pair: [Float32Array, Float32Array], sampleRate: number): Float32Array {
  const hop = Math.max(1, Math.round(sampleRate * STEM_ENVELOPE_HOP_SEC));
  const n = pair[0].length;
  const hops = Math.max(1, Math.ceil(n / hop));
  const out = new Float32Array(hops);
  for (let h = 0; h < hops; h++) {
    const a = h * hop;
    const b = Math.min(n, a + hop);
    let e = 0;
    for (let i = a; i < b; i++) e += pair[0][i] * pair[0][i] + pair[1][i] * pair[1][i];
    const ms = e / Math.max(1, 2 * (b - a));
    out[h] = ms > 1e-12 ? 10 * Math.log10(ms) : -120;
  }
  return out;
}

/** Whole-track RMS (dBFS) of a stereo pair. */
export function stereoRmsDb(pair: [Float32Array, Float32Array]): number {
  let e = 0;
  const n = pair[0].length;
  for (let i = 0; i < n; i++) e += pair[0][i] * pair[0][i] + pair[1][i] * pair[1][i];
  const ms = e / Math.max(1, 2 * n);
  return ms > 1e-12 ? 10 * Math.log10(ms) : -120;
}
