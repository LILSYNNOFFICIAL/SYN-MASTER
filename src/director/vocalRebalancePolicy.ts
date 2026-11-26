/**
 * Vocal Rebalance policy for FIX ALL: measurement, objective ranges, the local Director's
 * conservative plan, and the gate every AI or local proposal passes before it is rendered.
 *
 * Rules (kept deliberately conservative):
 * - Without cached stems for the active track the module is removed: FIX ALL never starts a
 *   slow separation by itself, and a rebalance without stems would be a silent no-op.
 * - The local (deterministic) Director only proposes a vocal move when stems are cached and the
 *   measured vocal-to-music ratio sits more than 1 dB outside the objective's range; it moves
 *   at most 3 dB and only the vocal.
 * - AI proposals are clamped to -4..+3 dB vocal and +/-3 dB bass/drums, may only move the vocal
 *   TOWARD the objective range (never past its far edge), and are limited to a 1.5 dB trim when
 *   the vocal already sits in range. No detected vocal means no vocal move.
 * - The rendered pass is still judged by the unchanged objective gate (LUFS, true peak, clicks,
 *   phase, spectral balance, ...) like any other candidate.
 *
 * The ranges are an uncalibrated starting point (150 Hz high-passed RMS of the vocal stem
 * against the rest of the mix, on vocal-active 400 ms frames). Calibrate on real music before
 * tightening them.
 */
import type { MasteringObjectiveId, ProcessorModule, VocalRebalanceParams } from '../types/mastering.ts';
import { createBiquadState, designHighPass, processBiquadSample } from '../dsp/biquad.ts';
import { createProcessorModule, hoistVocalRebalance } from '../dsp/chainValidation.ts';
import { DEFAULT_VOCAL_REBALANCE_PARAMS, sanitizeVocalRebalanceParams, type RebalanceStemSet } from '../dsp/vocalRebalance.ts';
import {
  REBALANCE_AI_LIMITS,
  type VocalBalanceContext,
  type VocalBalanceMeasurement,
  type VocalBalanceRange,
} from '../ai/vocalBalancePrompt.ts';

export {
  REBALANCE_AI_LIMITS,
  summarizeVocalBalanceForPrompt,
  type VocalBalanceContext,
  type VocalBalanceMeasurement,
  type VocalBalanceRange,
} from '../ai/vocalBalancePrompt.ts';

const DEFAULT_RANGE: VocalBalanceRange = { low: -7, high: 2 };
export const VOCAL_BALANCE_RANGES: Partial<Record<MasteringObjectiveId, VocalBalanceRange>> = {
  'vocal-focused': { low: -3, high: 3 },
  pop: { low: -5, high: 2 },
  acoustic: { low: -5, high: 3 },
  'hip-hop': { low: -6, high: 2 },
  streaming: { low: -7, high: 2 },
  'commercial-loudness': { low: -7, high: 2 },
  electronic: { low: -10, high: 1 },
  cinematic: { low: -10, high: 2 },
};

export function vocalBalanceRange(objectiveId: MasteringObjectiveId | undefined): VocalBalanceRange {
  return (objectiveId && VOCAL_BALANCE_RANGES[objectiveId]) || DEFAULT_RANGE;
}

export const REBALANCE_LOCAL_LIMITS = { maxAbsDb: 3, triggerMarginDb: 1, landInsideDb: 0.5 } as const;

const FRAME_SEC = 0.4;
const toDb = (e: number) => (e > 1e-20 ? 10 * Math.log10(e) : -200);

/**
 * Measure the vocal balance from cached stems and the source mix. Returns null when no vocal is
 * present in at least 10 % of the track.
 */
export function measureVocalBalance(set: RebalanceStemSet, left: Float32Array, right: Float32Array): VocalBalanceMeasurement | null {
  const n = Math.min(set.length, left.length, right.length);
  if (n === 0) return null;
  const hp = designHighPass(150, Math.SQRT1_2, set.sampleRate);
  const st = [createBiquadState(), createBiquadState(), createBiquadState(), createBiquadState()];
  const frame = Math.max(1, Math.round(FRAME_SEC * set.sampleRate));
  const frames = Math.ceil(n / frame);
  const vE = new Float64Array(frames);
  const aE = new Float64Array(frames);
  let bassE = 0;
  let drumsE = 0;
  let mixE = 0;
  const [vl, vr] = set.stems.vocals;
  const [bl, br] = set.stems.bass;
  const [dl, dr] = set.stems.drums;
  for (let i = 0; i < n; i++) {
    const f = (i / frame) | 0;
    const v0 = processBiquadSample(vl[i], hp, st[0]);
    const v1 = processBiquadSample(vr[i], hp, st[1]);
    const a0 = processBiquadSample(left[i] - vl[i], hp, st[2]);
    const a1 = processBiquadSample(right[i] - vr[i], hp, st[3]);
    vE[f] += v0 * v0 + v1 * v1;
    aE[f] += a0 * a0 + a1 * a1;
    bassE += bl[i] * bl[i] + br[i] * br[i];
    drumsE += dl[i] * dl[i] + dr[i] * dr[i];
    mixE += left[i] * left[i] + right[i] * right[i];
  }
  let maxV = 0;
  for (let f = 0; f < frames; f++) maxV = Math.max(maxV, vE[f]);
  if (maxV <= 0) return null;
  // Active: within 30 dB of the loudest vocal frame and above about -60 dBFS RMS.
  const floor = Math.max(maxV * 1e-3, frame * 2 * 1e-6);
  let sumV = 0;
  let sumA = 0;
  let active = 0;
  for (let f = 0; f < frames; f++) {
    if (vE[f] < floor) continue;
    active++;
    sumV += vE[f];
    sumA += aE[f];
  }
  const ratio = active / frames;
  if (ratio < 0.1 || sumA <= 0) return null;
  const round1 = (x: number) => Math.round(x * 10) / 10;
  return {
    vocalToMusicDb: round1(toDb(sumV) - toDb(sumA)),
    vocalActiveRatio: Math.round(ratio * 100) / 100,
    bassToMixDb: round1(toDb(bassE) - toDb(mixE)),
    drumsToMixDb: round1(toDb(drumsE) - toDb(mixE)),
  };
}

const roundHalf = (x: number) => Math.round(x * 2) / 2;

/** Local Director plan: a small vocal-only move, or null when nothing is clearly needed. */
export function planLocalVocalRebalance(ctx: VocalBalanceContext): VocalRebalanceParams | null {
  if (!ctx.stemsCached || !ctx.measurement) return null;
  const v = ctx.measurement.vocalToMusicDb;
  const { low, high } = ctx.range;
  const L = REBALANCE_LOCAL_LIMITS;
  let gain = 0;
  if (v < low - L.triggerMarginDb) gain = Math.min(L.maxAbsDb, low + L.landInsideDb - v);
  else if (v > high + L.triggerMarginDb) gain = Math.max(-L.maxAbsDb, high - L.landInsideDb - v);
  gain = roundHalf(gain);
  if (Math.abs(gain) < 0.5) return null;
  return { ...DEFAULT_VOCAL_REBALANCE_PARAMS, vocalGainDb: gain };
}

/** Allowed vocal gain window for a measured balance (AI proposals). */
export function allowedVocalWindow(ctx: VocalBalanceContext): [number, number] {
  const A = REBALANCE_AI_LIMITS;
  if (!ctx.measurement) return [0, 0];
  const v = ctx.measurement.vocalToMusicDb;
  const { low, high } = ctx.range;
  if (v < low) return [0, Math.max(0, Math.min(A.vocalMaxDb, high - v))];
  if (v > high) return [Math.min(0, Math.max(A.vocalMinDb, low - v)), 0];
  return [Math.max(-A.inRangeTrimDb, low - v), Math.min(A.inRangeTrimDb, high - v)];
}

export interface RebalanceGateResult {
  chain: ProcessorModule[];
  notes: string[];
}

/**
 * Gate a proposed chain's Vocal Rebalance (AI or local). Chains without one are returned
 * untouched. The module is normalised (intensity / wet 100 %, no in/out gain), clamped,
 * direction-checked against the measured balance, hoisted first, or removed when it cannot help.
 */
export function gateVocalRebalanceChain(chain: ProcessorModule[], ctx: VocalBalanceContext): RebalanceGateResult {
  const idx = chain.findIndex((m) => m.type === 'vocal-rebalance');
  if (idx < 0) return { chain, notes: [] };
  const notes: string[] = [];
  const without = chain.filter((m) => m.type !== 'vocal-rebalance');
  const mod = chain[idx];
  if (!ctx.stemsCached) {
    notes.push('Vocal Rebalance skipped: no cached stems for this track (separate stems in the Vocal Rebalance panel first).');
    return { chain: without, notes };
  }
  const raw = sanitizeVocalRebalanceParams(mod.params);
  const scale = mod.enabled && !mod.bypassed ? Math.max(0, Math.min(1, mod.intensity / 100)) : 0;
  const A = REBALANCE_AI_LIMITS;
  const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
  const [vLo, vHi] = allowedVocalWindow(ctx);
  const wantVocal = raw.vocalGainDb * scale;
  const vocal = clamp(wantVocal, vLo, vHi);
  if (Math.abs(vocal - wantVocal) > 0.05) {
    notes.push(
      ctx.measurement
        ? `Vocal Rebalance: vocal move ${wantVocal.toFixed(1)} dB limited to ${vocal.toFixed(1)} dB (measured ${ctx.measurement.vocalToMusicDb} dB vs range ${ctx.range.low}..${ctx.range.high} dB).`
        : 'Vocal Rebalance: no lead vocal detected, vocal gain left at 0 dB.',
    );
  }
  const other = (enabled: boolean, db: number) => (enabled ? clamp(db * scale, -A.otherMaxAbsDb, A.otherMaxAbsDb) : 0);
  const bass = other(raw.bassEnabled, raw.bassGainDb);
  const drums = other(raw.drumsEnabled, raw.drumsGainDb);
  const params: VocalRebalanceParams = {
    ...raw,
    vocalGainDb: Math.round(vocal * 10) / 10,
    bassEnabled: Math.abs(bass) >= 0.05,
    bassGainDb: Math.round(bass * 10) / 10,
    drumsEnabled: Math.abs(drums) >= 0.05,
    drumsGainDb: Math.round(drums * 10) / 10,
  };
  if (Math.abs(params.vocalGainDb) < 0.05 && !params.bassEnabled && !params.drumsEnabled) {
    notes.push('Vocal Rebalance removed: no move is justified by the measured balance.');
    return { chain: without, notes };
  }
  const gated = createProcessorModule('vocal-rebalance', {
    id: mod.id,
    name: mod.name,
    expanded: mod.expanded,
    params,
  });
  return { chain: hoistVocalRebalance([gated, ...without]), notes };
}

/** Insert the local plan at the head of a chain (respecting the 12-stage cap). */
export function withLocalVocalRebalance(chain: ProcessorModule[], params: VocalRebalanceParams): ProcessorModule[] {
  if (chain.some((m) => m.type === 'vocal-rebalance') || chain.length >= 12) return chain;
  return [createProcessorModule('vocal-rebalance', { params }), ...chain];
}
