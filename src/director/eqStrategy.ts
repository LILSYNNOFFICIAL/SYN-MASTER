/**
 * Rule-based EQ choices for the fallback Director: which EQ subtype, slope and channel a
 * measured problem calls for. Every rule is gated on a measurement (and, where it matters, the
 * objective); with no evidence the band keeps the legacy fields so it renders exactly as before.
 * The verification loop still renders, re-measures and judges every chain these bands go into.
 *
 *  - Rumble: legacy Flat 12 dB/oct high-pass unless rumble is measured, then Flat 18/24 dB/oct.
 *  - Mono bass: a Side-channel Flat high-pass when the low end is measurably out of phase.
 *  - Mud: Proportional Q bells (gentle when the cut is small, tighter as refinement deepens it).
 *  - Tilt: Baxandall shelves for broad slope-driven tilt moves; Analog (legacy) for corrective
 *    and reference-matched shelves.
 *  - Harshness / sibilance: Dynamic EQ type, soft knee and channel chosen from the measured
 *    resonance frequency, sibilant-region energy and stereo correlation.
 */
import type { AudioAnalysis, DynamicEQBand, EQBand, EQSlope, ResolvedObjectiveTarget } from '../types/mastering';
import { computeRegionEnergyDb } from './analyzeIntelligence';

/** Objectives that ask for minimal, phase-gentle processing. */
export function isGentleObjective(objective: Pick<ResolvedObjectiveTarget, 'id'>): boolean {
  return objective.id === 'transparent' || objective.id === 'dynamic' || objective.id === 'acoustic';
}

/** Phase correlation at or above this means the content is centre-dominant (vocals, kick, bass). */
export const CENTRED_CORRELATION = 0.8;
/** Infrasonic (16-30 Hz) energy within this many dB of the 60-250 Hz bass region counts as rumble. */
export const RUMBLE_INFRA_VS_BASS_DB = -8;
/** Sub (20-60 Hz) above bass by more than this counts as measured sub rumble. */
export const RUMBLE_SUB_EXCESS_DB = 4.5;
/** Low-end correlation below this calls for mono bass. */
export const MONO_BASS_CORRELATION = 0.72;
/** Sibilant region (5-10 kHz) within this many dB of the midrange counts as sibilant. */
export const SIBILANCE_VS_MID_DB = -2.5;

export interface RumbleEvidence {
  measured: boolean;
  infraVsBassDb: number | null;
  subExcessDb: number;
  dcOffset: number;
  reasons: string[];
}

export function measureRumble(analysis: AudioAnalysis): RumbleEvidence {
  const infra = computeRegionEnergyDb(analysis, 16, 30);
  const bass = computeRegionEnergyDb(analysis, 60, 250);
  const infraVsBassDb = infra !== null && bass !== null ? infra - bass : null;
  const subExcessDb = analysis.zoneEnergyDb.sub - analysis.zoneEnergyDb.bass;
  const reasons: string[] = [];
  if (infraVsBassDb !== null && infraVsBassDb > RUMBLE_INFRA_VS_BASS_DB) {
    reasons.push(`16-30 Hz is ${infraVsBassDb.toFixed(1)} dB vs 60-250 Hz (rumble above ${RUMBLE_INFRA_VS_BASS_DB} dB)`);
  }
  if (subExcessDb > RUMBLE_SUB_EXCESS_DB) reasons.push(`Sub exceeds Bass by ${subExcessDb.toFixed(1)} dB`);
  if (analysis.dcOffset >= 0.004) reasons.push(`DC offset ${(analysis.dcOffset * 100).toFixed(2)}%`);
  return { measured: reasons.length > 0, infraVsBassDb, subExcessDb, dcOffset: analysis.dcOffset, reasons };
}

/**
 * The rumble high-pass. Without measured rumble it is the legacy band (Flat 12 dB/oct, no new
 * fields, bit-identical). With measured rumble it becomes an explicit Flat 24 dB/oct
 * (18 dB/oct for gentle objectives, which keep phase shift low).
 */
export function planRumbleHighPass(
  analysis: AudioAnalysis,
  objective: Pick<ResolvedObjectiveTarget, 'id'>,
  id = 'b1',
): { band: EQBand; evidence: RumbleEvidence; summary: string } {
  const freq = isGentleObjective(objective) ? 24 : 28;
  const evidence = measureRumble(analysis);
  if (!evidence.measured) {
    return {
      band: { id, enabled: true, shape: 'highpass', freq, gain: 0, q: 0.71 },
      evidence,
      summary: `Flat 12 dB/oct high-pass @ ${freq} Hz (headroom safety)`,
    };
  }
  const slope: EQSlope = isGentleObjective(objective) ? 18 : 24;
  return {
    band: { id, enabled: true, shape: 'highpass', subtype: 'flat', slope, freq, gain: 0, q: 0.71 },
    evidence,
    summary: `Flat ${slope} dB/oct high-pass @ ${freq} Hz for measured rumble (${evidence.reasons[0]})`,
  };
}

/**
 * Mono bass as a Side-channel low cut: removes stereo (side) energy below the crossover while
 * leaving the mid (mono) low end untouched. Only when the low end is measurably decorrelated.
 */
export function planSideLowCut(analysis: AudioAnalysis, id = 'b-side-lc'): { band: EQBand; summary: string } | null {
  if (!(analysis.lowEndCorrelation < MONO_BASS_CORRELATION)) return null;
  const severe = analysis.lowEndCorrelation < 0.5;
  const freq = severe ? 115 : 90;
  const slope: EQSlope = severe ? 24 : 12;
  return {
    band: { id, enabled: true, shape: 'highpass', subtype: 'flat', slope, channel: 'side', freq, gain: 0, q: 0.71 },
    summary: `Side-channel Flat ${slope} dB/oct low cut @ ${freq} Hz (low-end correlation ${analysis.lowEndCorrelation.toFixed(2)}, limit ${MONO_BASS_CORRELATION})`,
  };
}

/**
 * Proportional Q base for a mud bell: chosen so the effective Q at the planned cut matches the
 * constant-Q width the Director used before (Q 1.4 at about -1.5 dB), while deeper refinement
 * cuts automatically tighten toward the measured build-up instead of scooping the midrange.
 */
export const MUD_PROPORTIONAL_Q = 1.8;
/** Proportional Q base for a refinement low-mid bell (effective Q ~1.2 at a -0.75 dB step). */
export const REFINE_MUD_PROPORTIONAL_Q = 1.6;

export function mudBell(id: string, freq: number, gain: number, q = MUD_PROPORTIONAL_Q): EQBand {
  return { id, enabled: true, shape: 'bell', subtype: 'proportional', freq, gain, q };
}

export function channelForCentredContent(analysis: AudioAnalysis): 'mid' | 'stereo' {
  return analysis.phaseCorrelation >= CENTRED_CORRELATION ? 'mid' : 'stereo';
}

export type DynamicHighBandKind = 'sibilance' | 'resonance';

export interface DynamicHighBandPlan {
  kind: DynamicHighBandKind;
  band: DynamicEQBand;
  summary: string;
  evidence: string[];
}

/**
 * Dynamic EQ band for a measured isolated upper resonance (2-12 kHz, >= 6 dB). When that
 * resonance sits in the sibilant range (4.5-10 kHz) AND the 5-10 kHz region is measurably hot,
 * the band becomes a de-esser: a dynamic high shelf keyed by a custom side-chain at the
 * sibilant frequency, fast attack, short lookahead. Otherwise it is a constant-Q bell on the
 * resonance. Both get a soft knee; centre-dominant material is processed on the Mid channel so
 * the side image keeps its air.
 */
export function planDynamicHighBand(
  analysis: AudioAnalysis,
  resonance: { freqHz: number; excessDb: number },
): DynamicHighBandPlan {
  const channel = channelForCentredContent(analysis);
  const sibilantRegion = computeRegionEnergyDb(analysis, 5000, 10000);
  const midRegion = computeRegionEnergyDb(analysis, 500, 2000);
  const sibilanceVsMid = sibilantRegion !== null && midRegion !== null ? sibilantRegion - midRegion : null;
  const maxCutDb = Number(Math.max(-5.5, -Math.min(4.5, resonance.excessDb * 0.45)).toFixed(1));
  const thresholdDb = Math.round(Math.max(-32, Math.min(-14, analysis.rmsDb + 1)));
  const channelNote = channel === 'mid' ? `Mid channel (correlation ${analysis.phaseCorrelation.toFixed(2)} ≥ ${CENTRED_CORRELATION})` : 'Stereo';
  const sibilant =
    resonance.freqHz >= 4500 && resonance.freqHz <= 10000 && sibilanceVsMid !== null && sibilanceVsMid > SIBILANCE_VS_MID_DB;
  if (sibilant) {
    const shelfHz = Math.round(Math.max(4000, resonance.freqHz * 0.8));
    return {
      kind: 'sibilance',
      band: {
        id: 'd1',
        enabled: true,
        type: 'high-shelf',
        freq: shelfHz,
        q: 0.71,
        thresholdDb,
        maxCutDb,
        attackMs: 2,
        releaseMs: 70,
        kneeDb: 4,
        channel,
        sidechain: { mode: 'custom', freq: resonance.freqHz, q: 2 },
        lookaheadMs: 2,
      },
      summary: `Dynamic high shelf @ ${shelfHz} Hz keyed at ${resonance.freqHz} Hz (de-ess, ${maxCutDb} dB max, 4 dB knee, 2 ms lookahead, ${channelNote})`,
      evidence: [
        `Resonance: ${resonance.freqHz} Hz (+${resonance.excessDb} dB)`,
        `5-10 kHz vs 0.5-2 kHz: ${sibilanceVsMid! >= 0 ? '+' : ''}${sibilanceVsMid!.toFixed(1)} dB (sibilant above ${SIBILANCE_VS_MID_DB} dB)`,
      ],
    };
  }
  return {
    kind: 'resonance',
    band: {
      id: 'd1',
      enabled: true,
      type: 'bell',
      freq: resonance.freqHz,
      q: 2.8,
      thresholdDb,
      maxCutDb,
      attackMs: 6,
      releaseMs: 95,
      kneeDb: 3,
      channel,
    },
    summary: `Dynamic bell @ ${resonance.freqHz} Hz (Q 2.8, ${maxCutDb} dB max, 3 dB knee, ${channelNote})`,
    evidence: [`Resonance: ${resonance.freqHz} Hz (+${resonance.excessDb} dB)`],
  };
}
