import type { AudioAnalysis, ResolvedObjectiveTarget, SpectralBandEnergy } from '../types/mastering';

/**
 * Objective master target gate.
 *
 * "Passed" here means the RENDERED output was measured and every blocking check met
 * its target. AI opinion and score heuristics never decide a pass on their own.
 *
 * Blocking checks: integrated LUFS, true peak (dBTP), clipped samples, clicks/pops,
 * DC offset, phase correlation (overall and low end), processing-induced dynamics
 * collapse (LRA / crest), and spectral balance against a reference curve when a
 * reference track is loaded. Without a reference, spectral balance against the
 * source curve is reported as advisory.
 */

export type MasterCheckStatus = 'pass' | 'fail' | 'advisory';

export interface MasterTargetCheck {
  id:
    | 'lufs'
    | 'true-peak'
    | 'clipping'
    | 'clicks'
    | 'dc-offset'
    | 'phase'
    | 'low-end-phase'
    | 'lra'
    | 'crest'
    | 'spectral-balance';
  label: string;
  measured: string;
  target: string;
  status: MasterCheckStatus;
  /** Which tool fixes this when it fails, and the setting the engine will use. */
  fix?: string;
}

export interface MasterTargetGate {
  passed: boolean;
  checks: MasterTargetCheck[];
  failed: MasterTargetCheck[];
  summary: string;
}

/** Tolerance for integrated loudness used by the gate (LU). */
export const GATE_LUFS_TOLERANCE = 0.65;
const ZONES: Array<keyof SpectralBandEnergy> = ['sub', 'bass', 'lowMid', 'mid', 'highMid', 'presence', 'air'];

/** Zone energies relative to the mid zone, so curves can be compared regardless of level. */
export function relativeSpectralCurve(a: AudioAnalysis): Record<keyof SpectralBandEnergy, number> {
  const out = {} as Record<keyof SpectralBandEnergy, number>;
  for (const z of ZONES) out[z] = (a.zoneEnergyDb?.[z] ?? 0) - (a.zoneEnergyDb?.mid ?? 0);
  return out;
}

export function spectralDeviation(
  post: AudioAnalysis,
  reference: AudioAnalysis,
): { maxDeviationDb: number; worstZone: keyof SpectralBandEnergy; perZone: Record<string, number> } {
  const a = relativeSpectralCurve(post);
  const b = relativeSpectralCurve(reference);
  let maxDeviationDb = 0;
  let worstZone: keyof SpectralBandEnergy = 'mid';
  const perZone: Record<string, number> = {};
  for (const z of ZONES) {
    if (z === 'mid') continue;
    // Sub and air are ignored below -60 dB relative (silence / band-limited sources).
    if (b[z] < -60) continue;
    const d = a[z] - b[z];
    perZone[z] = Number(d.toFixed(2));
    if (Math.abs(d) > Math.abs(maxDeviationDb)) {
      maxDeviationDb = d;
      worstZone = z;
    }
  }
  return { maxDeviationDb: Number(maxDeviationDb.toFixed(2)), worstZone, perZone };
}

export function evaluateMasterTargets(
  post: AudioAnalysis,
  objective: ResolvedObjectiveTarget,
  options: { preAnalysis?: AudioAnalysis | null; referenceAnalysis?: AudioAnalysis | null } = {},
): MasterTargetGate {
  const pre = options.preAnalysis ?? null;
  const ref = options.referenceAnalysis ?? null;
  const checks: MasterTargetCheck[] = [];
  const st = (ok: boolean): MasterCheckStatus => (ok ? 'pass' : 'fail');

  const lufsErr = post.integratedLufs - objective.targetLufs;
  checks.push({
    id: 'lufs',
    label: 'Integrated loudness',
    measured: `${post.integratedLufs.toFixed(1)} LUFS`,
    target: `${objective.targetLufs.toFixed(1)} ± ${GATE_LUFS_TOLERANCE} LUFS`,
    status: st(Math.abs(lufsErr) <= GATE_LUFS_TOLERANCE),
    fix: `Maximizer/limiter drive ${lufsErr > 0 ? '-' : '+'}${Math.abs(lufsErr).toFixed(1)} dB (target ${objective.targetLufs.toFixed(1)} LUFS)`,
  });

  checks.push({
    id: 'true-peak',
    label: 'True peak',
    measured: `${post.truePeakDb.toFixed(2)} dBTP`,
    target: `≤ ${objective.maxTruePeakDb.toFixed(1)} dBTP`,
    status: st(post.truePeakDb <= objective.maxTruePeakDb + 0.05),
    fix: `True-peak limiter ceiling ${(objective.maxTruePeakDb - 0.15).toFixed(2)} dBTP, 4x oversampling`,
  });

  checks.push({
    id: 'clipping',
    label: 'Clipped samples',
    measured: String(post.clippedSamples),
    target: '0',
    status: st(post.clippedSamples === 0),
    fix: 'Lower limiter ceiling; clipper before limiter if transients overshoot',
  });

  const clicks = post.clickCount ?? 0;
  const preClicks = pre?.clickCount ?? 0;
  // A master must not add clicks, and must remove most of the ones the source had.
  const clickLimit = Math.max(0, Math.floor(preClicks * 0.25));
  checks.push({
    id: 'clicks',
    label: 'Clicks / pops',
    measured: `${clicks}${post.clicksPerMinute !== undefined ? ` (${post.clicksPerMinute}/min)` : ''}`,
    target: preClicks > 0 ? `≤ ${clickLimit} (source had ${preClicks})` : '0',
    status: st(clicks <= clickLimit),
    fix: 'Restore: de-click on, sensitivity up; transient spike repair on',
  });

  checks.push({
    id: 'dc-offset',
    label: 'DC offset',
    measured: post.dcOffset.toFixed(5),
    target: '< 0.00400',
    status: st(Math.abs(post.dcOffset) < 0.004),
    fix: 'Restore: DC offset removal on (5 Hz high-pass)',
  });

  const phaseFloor = pre ? Math.min(0.2, pre.phaseCorrelation - 0.05) : 0.2;
  checks.push({
    id: 'phase',
    label: 'Phase correlation',
    measured: post.phaseCorrelation.toFixed(2),
    target: `≥ ${phaseFloor.toFixed(2)}`,
    status: st(post.phaseCorrelation >= phaseFloor),
    fix: 'Stereo imager: reduce width; mono below 120 Hz',
  });

  const lowFloor = pre ? Math.min(0.5, pre.lowEndCorrelation - 0.05) : 0.5;
  checks.push({
    id: 'low-end-phase',
    label: 'Low-end phase',
    measured: post.lowEndCorrelation.toFixed(2),
    target: `≥ ${lowFloor.toFixed(2)}`,
    status: st(post.lowEndCorrelation >= lowFloor),
    fix: 'Stereo imager: mono-maker below 120 Hz; bass enhancer mono focus',
  });

  // Dynamics: fail only when PROCESSING collapsed dynamics below the objective's
  // minimum. A source that arrives already crushed is reported, not blamed on the master.
  const lraCollapsed =
    pre !== null &&
    post.dynamicRangeDb < objective.minDynamicRangeDb &&
    pre.dynamicRangeDb - post.dynamicRangeDb > 1.5;
  checks.push({
    id: 'lra',
    label: 'Dynamic range / LRA',
    measured: `DR ${post.dynamicRangeDb.toFixed(1)} dB · LRA ${post.loudnessRangeLu.toFixed(1)} LU`,
    target: `DR ≥ ${objective.minDynamicRangeDb.toFixed(1)} dB (or not reduced >1.5 dB)`,
    status: lraCollapsed ? 'fail' : post.dynamicRangeDb < objective.minDynamicRangeDb ? 'advisory' : 'pass',
    fix: 'Reduce maximizer drive / compressor ratio',
  });

  const crestCollapsed = pre !== null && post.crestFactorDb < pre.crestFactorDb - 4 && post.crestFactorDb < 7;
  checks.push({
    id: 'crest',
    label: 'Crest factor',
    measured: `${post.crestFactorDb.toFixed(1)} dB`,
    target: pre ? `≥ ${Math.min(7, pre.crestFactorDb - 4).toFixed(1)} dB` : '≥ 7 dB',
    status: crestCollapsed ? 'fail' : 'pass',
    fix: 'Slower limiter release, less clipper/maximizer drive, transient shaper attack +',
  });

  if (ref) {
    const dev = spectralDeviation(post, ref);
    checks.push({
      id: 'spectral-balance',
      label: 'Spectral balance vs reference',
      measured: `worst ${dev.worstZone} ${dev.maxDeviationDb >= 0 ? '+' : ''}${dev.maxDeviationDb.toFixed(1)} dB`,
      target: '±3.0 dB per zone',
      status: st(Math.abs(dev.maxDeviationDb) <= 3),
      fix: `Parametric EQ ${dev.worstZone} ${dev.maxDeviationDb > 0 ? 'cut' : 'boost'} ${Math.min(4, Math.abs(dev.maxDeviationDb)).toFixed(1)} dB`,
    });
  } else if (pre) {
    const dev = spectralDeviation(post, pre);
    checks.push({
      id: 'spectral-balance',
      label: 'Spectral balance vs source curve',
      measured: `worst ${dev.worstZone} ${dev.maxDeviationDb >= 0 ? '+' : ''}${dev.maxDeviationDb.toFixed(1)} dB`,
      target: '±4.0 dB per zone (advisory without a reference)',
      status: Math.abs(dev.maxDeviationDb) <= 4 ? 'pass' : 'advisory',
      fix: `Parametric EQ ${dev.worstZone} ${dev.maxDeviationDb > 0 ? 'cut' : 'boost'}`,
    });
  }

  const failed = checks.filter((c) => c.status === 'fail');
  return {
    passed: failed.length === 0,
    checks,
    failed,
    summary:
      failed.length === 0
        ? 'All objective targets met on the rendered master.'
        : `Failed: ${failed.map((c) => `${c.label} ${c.measured} (target ${c.target})`).join('; ')}`,
  };
}
