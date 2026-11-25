/**
 * Match EQ in the Director and FIX ALL: when a reference track is loaded, the learned
 * source/reference spectra form a MatchEqProfile. The local Director adds one conservative
 * Match EQ from it, and any AI-proposed Match EQ (which never carries spectra) is hydrated
 * from it before rendering. Without a reference, Match EQ modules that have nothing learned
 * are removed so a chain never carries a dead stage.
 */
import type { ChainCommand, MatchEqParams, ProcessorModule } from '../types/mastering';
import {
  MATCH_EQ_DIRECTOR_DEFAULTS,
  computeMatchEqCurve,
  isMatchEqLearned,
  type MatchEqProfile,
} from '../dsp/matchEq';

export type { MatchEqProfile };

/** Below this peak correction (dB, at the Director's conservative settings) the Director skips Match EQ. */
export const MATCH_EQ_MIN_USEFUL_DB = 0.5;

/** Director safety ceiling: amount / limits never exceed these, whoever proposed them. */
export const MATCH_EQ_DIRECTOR_CEILING = { amount: 60, maxBoostDb: 3, maxCutDb: 3 } as const;

/**
 * Fill each Match EQ's learned spectra from `profile` when it has none. A module that already
 * carries its own learned spectra (a user preset, a manual Learn) is kept as is. With
 * `dropUnlearned`, modules left without spectra are removed; with `conservative`, hydrated
 * modules are clamped to MATCH_EQ_DIRECTOR_CEILING.
 */
export function hydrateMatchEqChain(
  chain: ProcessorModule[],
  profile: MatchEqProfile | null | undefined,
  options: { dropUnlearned?: boolean; conservative?: boolean } = {},
): ProcessorModule[] {
  if (!chain.some((m) => m.type === 'match-eq')) return chain;
  const out: ProcessorModule[] = [];
  for (const m of chain) {
    if (m.type !== 'match-eq') {
      out.push(m);
      continue;
    }
    let p = m.params as MatchEqParams;
    let hydrated = false;
    if (!isMatchEqLearned(p) && profile) {
      p = { ...p, source: profile.source, reference: profile.reference, ...(profile.referenceName ? { referenceName: profile.referenceName } : {}) };
      hydrated = true;
    }
    if (!isMatchEqLearned(p) && options.dropUnlearned) continue;
    // Only stages hydrated here (proposed without spectra, i.e. by an AI) are held to the
    // ceiling; a Match EQ the user learned and set by hand keeps its settings.
    if (options.conservative && hydrated) {
      p = {
        ...p,
        amount: Math.min(p.amount, MATCH_EQ_DIRECTOR_CEILING.amount),
        maxBoostDb: Math.min(p.maxBoostDb, MATCH_EQ_DIRECTOR_CEILING.maxBoostDb),
        maxCutDb: Math.min(p.maxCutDb, MATCH_EQ_DIRECTOR_CEILING.maxCutDb),
        smoothing: p.smoothing > 6 ? 6 : p.smoothing,
      };
    }
    out.push(p === m.params ? m : { ...m, params: p });
  }
  return out;
}

/** Conservative Match EQ params from a profile (the local Director's choice). */
export function directorMatchEqParams(profile: MatchEqProfile): MatchEqParams {
  return {
    ...MATCH_EQ_DIRECTOR_DEFAULTS,
    source: profile.source,
    reference: profile.reference,
    ...(profile.referenceName ? { referenceName: profile.referenceName } : {}),
  };
}

/** Peak correction of the Director's conservative curve, or 0 when nothing useful is learned. */
export function directorMatchEqPeakDb(profile: MatchEqProfile | null | undefined): number {
  if (!profile) return 0;
  const curve = computeMatchEqCurve(directorMatchEqParams(profile));
  return curve.learned ? curve.correctionDb.reduce((m, c) => Math.max(m, Math.abs(c)), 0) : 0;
}

/** The Director's add command, or null when no reference is learned or the match would be negligible. */
export function directorMatchEqCommand(profile: MatchEqProfile | null | undefined): ChainCommand | null {
  if (!profile || directorMatchEqPeakDb(profile) < MATCH_EQ_MIN_USEFUL_DB) return null;
  return {
    op: 'add',
    processorType: 'match-eq',
    name: 'Reference Match EQ',
    params: directorMatchEqParams(profile),
    rationale: 'Move the long-term tonal balance toward the loaded reference, conservatively (40 %, ±2.5 dB, 1/3-octave smoothing).',
  };
}
