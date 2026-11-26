/**
 * Vocal Rebalance context for the shared AI prompt (kept tiny: it ships in the initial bundle
 * with masteringPrompt). Measurement, ranges and the gate live in
 * src/director/vocalRebalancePolicy.ts, which is loaded on demand by FIX ALL.
 */
export interface VocalBalanceMeasurement {
  /** Vocal stem vs everything else (dB), 150 Hz high-passed RMS over vocal-active frames. */
  vocalToMusicDb: number;
  /** Share of 400 ms frames where the vocal is present (0..1). */
  vocalActiveRatio: number;
  /** Whole-track bass / drums stem level relative to the mix (dB, unweighted RMS). */
  bassToMixDb: number;
  drumsToMixDb: number;
}

export interface VocalBalanceRange {
  low: number;
  high: number;
}

export interface VocalBalanceContext {
  stemsCached: boolean;
  /** Null when stems are missing or no vocal was detected (instrumental). */
  measurement: VocalBalanceMeasurement | null;
  range: VocalBalanceRange;
}

export const REBALANCE_AI_LIMITS = { vocalMinDb: -4, vocalMaxDb: 3, otherMaxAbsDb: 3, inRangeTrimDb: 1.5 } as const;

/** One prompt block telling the AI whether it may use the processor, and what was measured. */
export function summarizeVocalBalanceForPrompt(ctx: VocalBalanceContext | null | undefined): string {
  if (!ctx || !ctx.stemsCached) {
    return 'VOCAL REBALANCE: stems are NOT cached for this track, so do not use "vocal-rebalance".';
  }
  const r = ctx.range;
  if (!ctx.measurement) {
    return `VOCAL REBALANCE: stems are cached but no lead vocal was detected; do not change vocalGainDb. Objective vocal-to-music range: ${r.low} to +${r.high} dB.`;
  }
  const m = ctx.measurement;
  const verdict = m.vocalToMusicDb < r.low ? 'BURIED (below range)' : m.vocalToMusicDb > r.high ? 'TOO LOUD (above range)' : 'within range';
  return [
    'VOCAL REBALANCE (stems cached for this track):',
    `- Measured vocal-to-music ratio: ${m.vocalToMusicDb} dB (150 Hz high-passed RMS, vocal present in ${Math.round(m.vocalActiveRatio * 100)}% of the track) -> ${verdict}.`,
    `- Objective range: ${r.low} to +${r.high} dB. Bass stem ${m.bassToMixDb} dB and drums stem ${m.drumsToMixDb} dB relative to the mix.`,
    `- Use "vocal-rebalance" only to move the vocal toward that range (vocalGainDb ${REBALANCE_AI_LIMITS.vocalMinDb}..+${REBALANCE_AI_LIMITS.vocalMaxDb} dB; at most +/-${REBALANCE_AI_LIMITS.inRangeTrimDb} dB when already in range). Bass/drums moves need a clear reason (+/-${REBALANCE_AI_LIMITS.otherMaxAbsDb} dB). It is always placed first.`,
  ].join('\n');
}
