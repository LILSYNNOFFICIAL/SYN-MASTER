import { MUD_REGION_HZ } from '../dsp/bandMap';
import type {
  AnalysisFinding,
  AppliedCorrectionRecord,
  AudioAnalysis,
  DirectorDiagnosisReport,
  FindingMetricComparison,
  FindingVerificationStatus,
  MasteringObjectiveId,
  PostFixVerificationReport,
  ProcessorModule,
  ResolvedObjectiveTarget,
  VerifiedFindingState,
} from '../types/mastering';
import {
  analyzeTrackIntelligence,
  computeRegionEnergyDb,
  getDiagnosisThresholds,
  isAnalysisMeasurementReliable,
  type DiagnosisThresholds,
} from './analyzeIntelligence';

function fnv1aHash(str: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c + (i & 0xff);
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(16)}-${(h2 >>> 0).toString(16)}`;
}

const OBJECTIVE_LIMITS: Record<
  MasteringObjectiveId,
  { targetLufs: number; lufsTolerance: number; maxTruePeakDb: number; minDynamicRangeDb: number }
> = {
  streaming: { targetLufs: -14.0, lufsTolerance: 1.0, maxTruePeakDb: -1.0, minDynamicRangeDb: 7.5 },
  'commercial-loudness': { targetLufs: -9.0, lufsTolerance: 1.2, maxTruePeakDb: -0.5, minDynamicRangeDb: 5.5 },
  dynamic: { targetLufs: -16.0, lufsTolerance: 1.3, maxTruePeakDb: -1.2, minDynamicRangeDb: 10.0 },
  cinematic: { targetLufs: -16.5, lufsTolerance: 1.5, maxTruePeakDb: -1.5, minDynamicRangeDb: 10.5 },
  electronic: { targetLufs: -9.5, lufsTolerance: 1.1, maxTruePeakDb: -0.8, minDynamicRangeDb: 6.0 },
  'hip-hop': { targetLufs: -9.5, lufsTolerance: 1.1, maxTruePeakDb: -0.8, minDynamicRangeDb: 6.0 },
  pop: { targetLufs: -11.0, lufsTolerance: 1.0, maxTruePeakDb: -1.0, minDynamicRangeDb: 6.8 },
  acoustic: { targetLufs: -15.5, lufsTolerance: 1.3, maxTruePeakDb: -1.0, minDynamicRangeDb: 9.5 },
  'vocal-focused': { targetLufs: -13.0, lufsTolerance: 1.1, maxTruePeakDb: -1.0, minDynamicRangeDb: 7.5 },
  transparent: { targetLufs: -15.0, lufsTolerance: 1.2, maxTruePeakDb: -1.0, minDynamicRangeDb: 9.0 },
  punchy: { targetLufs: -10.5, lufsTolerance: 1.2, maxTruePeakDb: -0.8, minDynamicRangeDb: 6.2 },
  warm: { targetLufs: -13.0, lufsTolerance: 1.3, maxTruePeakDb: -1.0, minDynamicRangeDb: 8.0 },
  custom: { targetLufs: -13.0, lufsTolerance: 1.2, maxTruePeakDb: -1.0, minDynamicRangeDb: 7.0 },
};

function normalizeStageParamsForFingerprint(mod: ProcessorModule): unknown {
  if (mod.type === 'parametric-eq') {
    const p = mod.params as { phaseMode?: string; msMode?: string; tiltDb?: number; bands?: Array<{ enabled?: boolean; shape?: string; freq?: number; gain?: number; q?: number }> };
    const enabledBands = (p.bands ?? []).filter((b) => b.enabled !== false && (b.shape === 'highpass' || b.shape === 'lowpass' || Math.abs(b.gain ?? 0) > 1e-4));
    if (enabledBands.length === 0 && Math.abs(p.tiltDb ?? 0) <= 1e-4) {
      return { noop: true };
    }
    return {
      phaseMode: p.phaseMode,
      msMode: p.msMode,
      tiltDb: p.tiltDb ?? 0,
      bands: enabledBands.map((b) => ({ shape: b.shape, freq: b.freq, gain: b.gain, q: b.q })),
    };
  }
  if (mod.type === 'dynamic-eq') {
    const p = mod.params as { bands?: Array<{ enabled?: boolean; freq?: number; q?: number; thresholdDb?: number; maxCutDb?: number; attackMs?: number; releaseMs?: number }> };
    const enabledBands = (p.bands ?? []).filter((b) => b.enabled !== false && Math.abs(b.maxCutDb ?? 0) > 1e-4);
    if (enabledBands.length === 0) return { noop: true };
    return { bands: enabledBands.map((b) => ({ freq: b.freq, q: b.q, thresholdDb: b.thresholdDb, maxCutDb: b.maxCutDb, attackMs: b.attackMs, releaseMs: b.releaseMs })) };
  }
  if (mod.type === 'external-vst3') {
    const p = mod.params as { uid?: string; bundlePath?: string; instanceId?: string | null; stateBase64?: string; parameters?: Array<{ id: number; valueNormalized: number }> };
    return {
      uid: p.uid,
      bundlePath: p.bundlePath,
      instanceId: p.instanceId ?? null,
      stateBase64: p.stateBase64 ?? '',
      parameters: (p.parameters ?? []).map((pr) => [pr.id, Number(pr.valueNormalized.toFixed(5))]),
    };
  }
  return mod.params;
}

/**
 * Computes a canonical fingerprint for the effective DSP/VST3 processing chain.
 * Bypasses, disabled stages, 0%-wet stages, and no-op bands collapse cleanly to 'dry:0'.
 */
export function computeChainFingerprint(
  chain: ProcessorModule[] | null | undefined,
  chainBypassed = false,
): string {
  if (chainBypassed || !chain || chain.length === 0) {
    return 'dry:0';
  }
  const activeStages = chain
    .filter((m) => {
      if (!m.enabled || m.bypassed) return false;
      const gainActive = Math.abs(m.inputGainDb) > 1e-4 || Math.abs(m.outputGainDb) > 1e-4;
      if (m.wetDry <= 0 && !gainActive) return false;
      if (m.intensity <= 0 && !gainActive) return false;
      const norm = normalizeStageParamsForFingerprint(m);
      if (typeof norm === 'object' && norm !== null && 'noop' in norm && !gainActive) {
        return false;
      }
      return true;
    })
    .map((m) => ({
      type: m.type,
      wetDry: m.wetDry,
      intensity: m.intensity,
      inputGainDb: m.inputGainDb,
      outputGainDb: m.outputGainDb,
      params: normalizeStageParamsForFingerprint(m),
    }));

  if (activeStages.length === 0) {
    return 'dry:0';
  }
  const serialized = JSON.stringify(activeStages);
  return `active:${activeStages.length}:${fnv1aHash(serialized)}`;
}

function fmtSigned(v: number | null, decimals = 1, unit = ''): string {
  if (v === null || !Number.isFinite(v)) return 'UNVERIFIED';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(decimals)}${unit ? ` ${unit}` : ''}`;
}

function fmtPlain(v: number | null, decimals = 1, unit = ''): string {
  if (v === null || !Number.isFinite(v)) return 'UNVERIFIED';
  return `${v.toFixed(decimals)}${unit ? ` ${unit}` : ''}`;
}

function makeComparison(opts: {
  key: string;
  label: string;
  unit: string;
  beforeValue: number | null;
  afterValue: number | null;
  decimals?: number;
  signed?: boolean;
  thresholdFormatted?: string;
  improved: boolean | null;
  meetsThreshold: boolean | null;
}): FindingMetricComparison {
  const decimals = opts.decimals ?? 1;
  const fmt = opts.signed ? fmtSigned : fmtPlain;
  const delta =
    opts.beforeValue !== null &&
    opts.afterValue !== null &&
    Number.isFinite(opts.beforeValue) &&
    Number.isFinite(opts.afterValue)
      ? opts.afterValue - opts.beforeValue
      : null;

  return {
    key: opts.key,
    label: opts.label,
    unit: opts.unit,
    beforeValue: opts.beforeValue,
    afterValue: opts.afterValue,
    delta,
    beforeFormatted: fmt(opts.beforeValue, decimals, opts.unit),
    afterFormatted: fmt(opts.afterValue, decimals, opts.unit),
    thresholdFormatted: opts.thresholdFormatted,
    improved: opts.improved,
    meetsThreshold: opts.meetsThreshold,
  };
}

function relevantCorrectionLabels(
  finding: AnalysisFinding,
  appliedCorrections: AppliedCorrectionRecord[],
): string[] {
  const matched = appliedCorrections.filter(
    (c) =>
      !c.findingId ||
      c.findingId === finding.id ||
      (finding.id === 'diag-mud' && c.processorTypes.some((t) => t === 'parametric-eq' || t === 'dynamic-eq' || t === 'multiband-comp')) ||
      (finding.id === 'diag-clipping' && c.processorTypes.some((t) => t === 'limiter' || t === 'maximizer')) ||
      ((finding.id === 'diag-phase' || finding.id === 'diag-lr-skew') && c.processorTypes.includes('stereo-imager')) ||
      ((finding.id === 'diag-noise' || finding.id === 'diag-dc') && c.processorTypes.some((t) => t === 'restore' || t === 'parametric-eq')) ||
      (finding.id === 'diag-harsh' && c.processorTypes.some((t) => t === 'dynamic-eq' || t === 'parametric-eq' || t === 'restore')),
  );
  return (matched.length > 0 ? matched : appliedCorrections).map((c) => c.label);
}

function buildBaselineComparisonsForFinding(
  finding: AnalysisFinding,
  pre: AudioAnalysis,
  post: AudioAnalysis | null,
  thresholds: DiagnosisThresholds,
  objectiveTarget: ResolvedObjectiveTarget | undefined,
  objectiveId: MasteringObjectiveId,
): FindingMetricComparison[] {
  const preBassMid = pre.zoneEnergyDb.bass - pre.zoneEnergyDb.mid;
  const preLowMid = pre.zoneEnergyDb.lowMid - pre.zoneEnergyDb.mid;
  const preSubBass = pre.zoneEnergyDb.sub - pre.zoneEnergyDb.bass;
  const preRegion = computeRegionEnergyDb(pre, MUD_REGION_HZ[0], MUD_REGION_HZ[1]);
  const preRegionVsMid = preRegion !== null ? preRegion - pre.zoneEnergyDb.mid : null;

  const postBassMid = post ? post.zoneEnergyDb.bass - post.zoneEnergyDb.mid : null;
  const postLowMid = post ? post.zoneEnergyDb.lowMid - post.zoneEnergyDb.mid : null;
  const postSubBass = post ? post.zoneEnergyDb.sub - post.zoneEnergyDb.bass : null;
  const postRegion = post ? computeRegionEnergyDb(post, MUD_REGION_HZ[0], MUD_REGION_HZ[1]) : null;
  const postRegionVsMid = post && postRegion !== null ? postRegion - post.zoneEnergyDb.mid : null;

  switch (finding.id) {
    case 'diag-mud': {
      return [
        makeComparison({
          key: 'lowMidBuildup',
          label: 'Low-Mid vs Mid',
          unit: 'dB',
          beforeValue: preLowMid,
          afterValue: postLowMid,
          signed: true,
          thresholdFormatted: `<= +${thresholds.lowMidBuildupLimit.toFixed(1)} dB`,
          improved: postLowMid !== null ? postLowMid <= preLowMid - 0.5 : null,
          meetsThreshold: postLowMid !== null ? postLowMid <= thresholds.lowMidBuildupLimit : null,
        }),
        makeComparison({
          key: 'region150To400VsMid',
          label: '150–400 Hz vs Mid',
          unit: 'dB',
          beforeValue: preRegionVsMid,
          afterValue: postRegionVsMid,
          signed: true,
          thresholdFormatted: `<= +${thresholds.region150To400VsMidLimit.toFixed(1)} dB`,
          improved:
            preRegionVsMid !== null && postRegionVsMid !== null
              ? postRegionVsMid <= preRegionVsMid - 0.5
              : null,
          meetsThreshold:
            postRegionVsMid !== null
              ? postRegionVsMid <= thresholds.region150To400VsMidLimit
              : null,
        }),
        makeComparison({
          key: 'bassMidDiff',
          label: 'Bass vs Mid',
          unit: 'dB',
          beforeValue: preBassMid,
          afterValue: postBassMid,
          signed: true,
          thresholdFormatted: `<= +${thresholds.bassMidDiffLimit.toFixed(1)} dB`,
          improved: postBassMid !== null ? postBassMid <= preBassMid - 0.5 : null,
          meetsThreshold: postBassMid !== null ? postBassMid <= thresholds.bassMidDiffLimit : null,
        }),
        makeComparison({
          key: 'subExcess',
          label: 'Sub vs Bass',
          unit: 'dB',
          beforeValue: preSubBass,
          afterValue: postSubBass,
          signed: true,
          thresholdFormatted: `<= +${thresholds.subExcessLimit.toFixed(1)} dB`,
          improved: postSubBass !== null ? postSubBass <= preSubBass - 0.5 : null,
          meetsThreshold: postSubBass !== null ? postSubBass <= thresholds.subExcessLimit : null,
        }),
      ];
    }

    case 'diag-clipping': {
      const maxTruePeakDb = objectiveTarget?.maxTruePeakDb ?? OBJECTIVE_LIMITS[objectiveId].maxTruePeakDb;
      const ceilingLimit = Math.min(-0.1, maxTruePeakDb + 0.05);
      return [
        makeComparison({
          key: 'clippedSamples',
          label: 'Clipped Samples',
          unit: '',
          decimals: 0,
          beforeValue: pre.clippedSamples,
          afterValue: post ? post.clippedSamples : null,
          thresholdFormatted: '0',
          improved: post ? post.clippedSamples < pre.clippedSamples : null,
          meetsThreshold: post ? post.clippedSamples === 0 : null,
        }),
        makeComparison({
          key: 'truePeakDb',
          label: 'True Peak',
          unit: 'dBTP',
          decimals: 2,
          beforeValue: pre.truePeakDb,
          afterValue: post ? post.truePeakDb : null,
          thresholdFormatted: `<= ${ceilingLimit.toFixed(2)} dBTP`,
          improved: post ? post.truePeakDb <= pre.truePeakDb - 0.2 : null,
          meetsThreshold: post ? post.truePeakDb <= ceilingLimit : null,
        }),
        makeComparison({
          key: 'interSamplePeaks',
          label: 'Inter-Sample Peaks',
          unit: '',
          decimals: 0,
          beforeValue: pre.interSamplePeaks,
          afterValue: post ? post.interSamplePeaks : null,
          thresholdFormatted: '0',
          improved: post ? post.interSamplePeaks < pre.interSamplePeaks : null,
          meetsThreshold: post ? post.interSamplePeaks === 0 : null,
        }),
      ];
    }

    case 'diag-dc': {
      const limitPct = thresholds.dcOffsetMax * 100;
      return [
        makeComparison({
          key: 'dcOffsetPercent',
          label: 'DC Offset',
          unit: '%',
          decimals: 3,
          beforeValue: pre.dcOffset * 100,
          afterValue: post ? post.dcOffset * 100 : null,
          thresholdFormatted: `< ${limitPct.toFixed(2)}%`,
          improved: post ? post.dcOffset < pre.dcOffset * 0.85 : null,
          meetsThreshold: post ? post.dcOffset < thresholds.dcOffsetMax : null,
        }),
      ];
    }

    case 'diag-noise': {
      const targetLufs = objectiveTarget?.targetLufs ?? OBJECTIVE_LIMITS[objectiveId].targetLufs;
      const preNoiseRaw = pre.noiseFloorDb ?? -96;
      const postNoiseRaw = post ? (post.noiseFloorDb ?? -96) : null;
      const preNf = preNoiseRaw + (targetLufs - pre.integratedLufs);
      const postNf = post && postNoiseRaw !== null
        ? postNoiseRaw + (targetLufs - post.integratedLufs)
        : null;
      const preSnr = pre.rmsDb - preNoiseRaw;
      const postSnr = post && postNoiseRaw !== null ? post.rmsDb - postNoiseRaw : null;
      return [
        makeComparison({
          key: 'noiseFloorDbAtTargetLufs',
          label: 'Level-Matched Noise Floor',
          unit: 'dBFS',
          decimals: 1,
          beforeValue: preNf,
          afterValue: postNf,
          thresholdFormatted: `<= ${thresholds.noiseFloorMax.toFixed(1)} dBFS at ${targetLufs.toFixed(1)} LUFS`,
          improved: postNf !== null ? postNf <= preNf - 1.5 : null,
          meetsThreshold: postNf !== null ? postNf <= thresholds.noiseFloorMax : null,
        }),
        makeComparison({
          key: 'signalToNoiseDb',
          label: 'Signal-to-Noise Ratio',
          unit: 'dB',
          decimals: 1,
          beforeValue: preSnr,
          afterValue: postSnr,
          thresholdFormatted: 'improve by >= 1.0 dB',
          improved: postSnr !== null ? postSnr >= preSnr + 1.0 : null,
          meetsThreshold: postSnr !== null ? postSnr >= preSnr + 1.0 : null,
        }),
        makeComparison({
          key: 'transientDensity',
          label: 'Transient Density',
          unit: '',
          decimals: 2,
          beforeValue: pre.transientDensity,
          afterValue: post ? post.transientDensity : null,
          improved: null,
          meetsThreshold: post ? post.transientDensity >= pre.transientDensity * 0.65 : null,
        }),
        makeComparison({
          key: 'crestFactorDb',
          label: 'Crest Factor',
          unit: 'dB',
          decimals: 1,
          beforeValue: pre.crestFactorDb,
          afterValue: post ? post.crestFactorDb : null,
          improved: null,
          meetsThreshold: post ? post.crestFactorDb >= pre.crestFactorDb - 1.5 : null,
        }),
        makeComparison({
          key: 'airEnergyDb',
          label: 'Air Band Energy',
          unit: 'dB',
          decimals: 1,
          beforeValue: pre.zoneEnergyDb.air,
          afterValue: post ? post.zoneEnergyDb.air : null,
          improved: null,
          meetsThreshold: post ? post.zoneEnergyDb.air >= pre.zoneEnergyDb.air - 3.0 : null,
        }),
      ];
    }

    case 'diag-phase': {
      return [
        makeComparison({
          key: 'lowEndCorrelation',
          label: 'Sub-120 Hz Corr',
          unit: '',
          decimals: 2,
          signed: true,
          beforeValue: pre.lowEndCorrelation,
          afterValue: post ? post.lowEndCorrelation : null,
          thresholdFormatted: `>= +${thresholds.lowEndCorrMin.toFixed(2)}`,
          improved: post ? post.lowEndCorrelation >= pre.lowEndCorrelation + 0.08 : null,
          meetsThreshold: post ? post.lowEndCorrelation >= thresholds.lowEndCorrMin : null,
        }),
        makeComparison({
          key: 'phaseCorrelation',
          label: 'Global Phase Corr',
          unit: '',
          decimals: 2,
          signed: true,
          beforeValue: pre.phaseCorrelation,
          afterValue: post ? post.phaseCorrelation : null,
          thresholdFormatted: `>= +${thresholds.phaseCorrMin.toFixed(2)}`,
          improved: post ? post.phaseCorrelation >= pre.phaseCorrelation + 0.08 : null,
          meetsThreshold: post ? post.phaseCorrelation >= thresholds.phaseCorrMin : null,
        }),
        makeComparison({
          key: 'monoCompatibilityScore',
          label: 'Mono Compat',
          unit: '/100',
          decimals: 0,
          beforeValue: pre.monoCompatibilityScore,
          afterValue: post ? post.monoCompatibilityScore : null,
          thresholdFormatted: '>= 70/100',
          improved: post ? post.monoCompatibilityScore >= pre.monoCompatibilityScore + 8 : null,
          meetsThreshold: post ? post.monoCompatibilityScore >= 70 : null,
        }),
      ];
    }

    case 'diag-lr-skew': {
      return [
        makeComparison({
          key: 'lrBalanceDb',
          label: 'L/R Balance',
          unit: 'dB',
          decimals: 2,
          signed: true,
          beforeValue: pre.lrBalanceDb,
          afterValue: post ? post.lrBalanceDb : null,
          thresholdFormatted: `|delta| <= ${thresholds.lrBalanceMax.toFixed(2)} dB`,
          improved: post ? Math.abs(post.lrBalanceDb) <= Math.abs(pre.lrBalanceDb) - 0.25 : null,
          meetsThreshold: post ? Math.abs(post.lrBalanceDb) <= thresholds.lrBalanceMax : null,
        }),
      ];
    }

    case 'diag-harsh': {
      const preHarsh = pre.zoneEnergyDb.highMid - pre.zoneEnergyDb.mid;
      const postHarsh = post ? post.zoneEnergyDb.highMid - post.zoneEnergyDb.mid : null;
      const preRes = pre.resonances.find((r) => r.freqHz >= 2000)?.excessDb ?? 0;
      const postRes = post
        ? (post.resonances.find((r) => r.freqHz >= 2000)?.excessDb ?? 0)
        : null;
      return [
        makeComparison({
          key: 'harshExcess',
          label: 'High-Mid vs Mid',
          unit: 'dB',
          signed: true,
          beforeValue: preHarsh,
          afterValue: postHarsh,
          thresholdFormatted: `<= +${thresholds.harshExcessLimit.toFixed(1)} dB`,
          improved: postHarsh !== null ? postHarsh <= preHarsh - 0.6 : null,
          meetsThreshold: postHarsh !== null ? postHarsh <= thresholds.harshExcessLimit : null,
        }),
        makeComparison({
          key: 'topResonanceExcessDb',
          label: 'Peak Resonance',
          unit: 'dB',
          beforeValue: preRes,
          afterValue: postRes,
          thresholdFormatted: '< 6.5 dB',
          improved: postRes !== null ? postRes <= preRes - 0.8 : null,
          meetsThreshold: postRes !== null ? postRes < 6.5 : null,
        }),
      ];
    }

    case 'diag-overcompressed': {
      return [
        makeComparison({
          key: 'dynamicRangeDb',
          label: 'Dynamic Range',
          unit: 'dB',
          beforeValue: pre.dynamicRangeDb,
          afterValue: post ? post.dynamicRangeDb : null,
          thresholdFormatted: `>= ${thresholds.dynamicRangeMin.toFixed(1)} dB`,
          improved: post ? post.dynamicRangeDb >= pre.dynamicRangeDb + 0.5 : null,
          meetsThreshold: post ? post.dynamicRangeDb >= thresholds.dynamicRangeMin : null,
        }),
        makeComparison({
          key: 'crestFactorDb',
          label: 'Crest Factor',
          unit: 'dB',
          beforeValue: pre.crestFactorDb,
          afterValue: post ? post.crestFactorDb : null,
          improved: post ? post.crestFactorDb >= pre.crestFactorDb + 0.6 : null,
          meetsThreshold: post ? post.crestFactorDb >= 7.5 : null,
        }),
      ];
    }

    case 'diag-thd': {
      return [
        makeComparison({
          key: 'thdEstimatePercent',
          label: 'Estimated THD',
          unit: '%',
          decimals: 2,
          beforeValue: pre.thdEstimatePercent,
          afterValue: post ? post.thdEstimatePercent : null,
          thresholdFormatted: `<= ${thresholds.thdMaxPercent.toFixed(1)}%`,
          improved: post ? post.thdEstimatePercent <= pre.thdEstimatePercent - 0.35 : null,
          meetsThreshold: post ? post.thdEstimatePercent <= thresholds.thdMaxPercent : null,
        }),
      ];
    }

    default:
      return [];
  }
}

function classifyVerifiedFinding(opts: {
  finding: AnalysisFinding;
  pre: AudioAnalysis;
  post: AudioAnalysis;
  postFinding: AnalysisFinding | null;
  thresholds: DiagnosisThresholds;
  objectiveTarget?: ResolvedObjectiveTarget;
  objectiveId: MasteringObjectiveId;
  appliedCorrections: AppliedCorrectionRecord[];
}): VerifiedFindingState {
  const { finding, pre, post, postFinding, thresholds, objectiveTarget, objectiveId, appliedCorrections } = opts;
  const comparisons = buildBaselineComparisonsForFinding(finding, pre, post, thresholds, objectiveTarget, objectiveId);
  const appliedLabels = relevantCorrectionLabels(finding, appliedCorrections);
  const stillFlagged = Boolean(postFinding);

  let status: FindingVerificationStatus;
  let remainingDeviation: string | undefined;
  let nextRecommendedAction: string | undefined;
  let verificationSummary: string;

  if (finding.id === 'diag-clipping' && pre.clippedSamples > 0) {
    const sourceClippedSamples = pre.clippedSamples;
    const outputClippedSamples = post.clippedSamples;
    status = 'UNRESOLVED';
    remainingDeviation =
      `Source integrity remains unverified: baseline contained ${sourceClippedSamples} sample(s) at or near full scale; rendered output reports ${outputClippedSamples}.`;
    nextRecommendedAction =
      'Return to an unclipped premaster or use a dedicated declipping restoration process before mastering. Output gain reduction can restore headroom, but it cannot reconstruct waveform peaks that were already flattened in the source.';
    verificationSummary =
      `VERIFICATION: The source entered mastering with ${sourceClippedSamples} sample(s) at or near full scale. The rendered output reports ${outputClippedSamples}, but level reduction alone cannot establish that missing waveform peaks were reconstructed. This workflow has no verified source-declipping reconstruction step. Status: UNRESOLVED`;
  } else if (finding.id === 'diag-overcompressed' && pre.dynamicRangeDb < thresholds.dynamicRangeMin) {
    status = 'UNRESOLVED';
    remainingDeviation =
      `The premaster entered mastering with only ${pre.dynamicRangeDb.toFixed(1)} dB dynamic range (source threshold >= ${thresholds.dynamicRangeMin.toFixed(1)} dB); the rendered output reports ${post.dynamicRangeDb.toFixed(1)} dB.`;
    nextRecommendedAction =
      'Use an uncompressed premaster or separated stems to recover transient and microdynamic detail. A changed stereo-master DR or crest reading does not prove that transient information already removed before mastering has been reconstructed.';
    verificationSummary =
      `VERIFICATION: The source entered mastering already dynamically compressed (${pre.dynamicRangeDb.toFixed(1)} dB DR, ${pre.crestFactorDb.toFixed(1)} dB crest). The rendered output reports ${post.dynamicRangeDb.toFixed(1)} dB DR and ${post.crestFactorDb.toFixed(1)} dB crest, but meter movement alone cannot establish reconstruction of source transients or microdynamics. This workflow has no verified source-dynamics reconstruction step. Status: UNRESOLVED`;
  } else if (finding.id === 'diag-thd' && pre.thdEstimatePercent > thresholds.thdMaxPercent) {
    status = 'UNRESOLVED';
    remainingDeviation =
      `The source entered mastering with ${pre.thdEstimatePercent.toFixed(2)}% estimated THD (source threshold <= ${thresholds.thdMaxPercent.toFixed(1)}%); the rendered output reports ${post.thdEstimatePercent.toFixed(2)}%.`;
    nextRecommendedAction =
      'Return to a cleaner premaster or original stems, or use a dedicated distortion-restoration process with independent artifact checks. This mastering chain has no verified source de-distortion reconstruction step.';
    verificationSummary =
      `VERIFICATION: The source entered mastering with ${pre.thdEstimatePercent.toFixed(2)}% estimated harmonic distortion. The rendered output reports ${post.thdEstimatePercent.toFixed(2)}%, but a lower estimate alone does not establish that source distortion artifacts were reconstructed or removed transparently. This workflow has no verified source de-distortion reconstruction step. Status: UNRESOLVED`;
  } else if (finding.id === 'diag-noise') {
    const targetLufs = objectiveTarget?.targetLufs ?? OBJECTIVE_LIMITS[objectiveId].targetLufs;
    const preNoise = pre.noiseFloorDb ?? -96;
    const postNoise = post.noiseFloorDb ?? -96;
    const preNoiseAtTarget = preNoise + (targetLufs - pre.integratedLufs);
    const postNoiseAtTarget = postNoise + (targetLufs - post.integratedLufs);
    const preSnr = pre.rmsDb - preNoise;
    const postSnr = post.rmsDb - postNoise;
    const noiseFloorDrop = preNoiseAtTarget - postNoiseAtTarget;
    const snrGain = postSnr - preSnr;
    const transientDamage =
      pre.transientDensity >= 0.08 && post.transientDensity < pre.transientDensity * 0.65;
    const crestDamage = post.crestFactorDb < pre.crestFactorDb - 1.5;
    const airDamage = post.zoneEnergyDb.air < pre.zoneEnergyDb.air - 3.0;
    const collateral = transientDamage || crestDamage || airDamage;

    if (noiseFloorDrop >= 1.5 && snrGain >= 1.0) {
      if (collateral) {
        status = 'PARTIALLY_RESOLVED';
        const losses = [
          ...(transientDamage ? ['transient density'] : []),
          ...(crestDamage ? ['crest factor'] : []),
          ...(airDamage ? ['high-frequency air'] : []),
        ];
        remainingDeviation = 'Level-matched noise floor improved by ' + fmtSigned(noiseFloorDrop, 1, 'dB') +
          ' and SNR by ' + fmtSigned(snrGain, 1, 'dB') +
          ', but processing also reduced ' + losses.join(', ') + '.';
        nextRecommendedAction =
          'Reduce restoration intensity or narrow its frequency/time action. Preserve transient attacks and air tails, then compare the result using level-matched A/B auditioning.';
        verificationSummary =
          'VERIFICATION: Level-matched noise floor fell ' + fmtSigned(noiseFloorDrop, 1, 'dB') +
          ' and signal-to-noise ratio improved ' + fmtSigned(snrGain, 1, 'dB') +
          ', but collateral signal loss was detected (' + losses.join(', ') + '). Status: PARTIALLY RESOLVED';
      } else if (postNoiseAtTarget <= thresholds.noiseFloorMax && !stillFlagged) {
        status = 'RESOLVED';
        verificationSummary =
          'VERIFICATION: Level-matched noise floor fell ' + fmtSigned(noiseFloorDrop, 1, 'dB') +
          ' and signal-to-noise ratio improved ' + fmtSigned(snrGain, 1, 'dB') +
          '. Transient density, crest factor, and high-frequency air remained within preservation checks. Status: RESOLVED';
      } else {
        status = 'IMPROVED';
        remainingDeviation =
          'Level-matched noise floor is ' + fmtSigned(postNoiseAtTarget, 1, 'dBFS') +
          ' (target <= ' + thresholds.noiseFloorMax.toFixed(1) + ' dBFS at ' + targetLufs.toFixed(1) + ' LUFS).';
        nextRecommendedAction =
          'Continue with conservative, noise-specific reduction only if level-matched audition confirms the remaining noise is audible.';
        verificationSummary =
          'VERIFICATION: Signal-to-noise ratio improved ' + fmtSigned(snrGain, 1, 'dB') +
          ' without measured transient/air collateral, but the level-matched noise-floor target remains unmet. Status: IMPROVED';
      }
    } else {
      status = 'UNRESOLVED';
      remainingDeviation =
        'Level-matched noise floor changed ' + fmtSigned(noiseFloorDrop, 1, 'dB') +
        ', while signal-to-noise ratio changed ' + fmtSigned(snrGain, 1, 'dB') +
        '.';
      nextRecommendedAction =
        'Use noise-specific reduction rather than lowering the whole signal. Verify improvement from quiet passages relative to program level.';
      verificationSummary =
        'VERIFICATION: A lower absolute noise-floor reading is not sufficient. Level-matched noise floor and signal-to-noise ratio must improve; uniform attenuation or level movement cannot be counted as noise removal. Status: UNRESOLVED';
    }
  } else if (finding.id === 'diag-mud') {
    const preLowMid = pre.zoneEnergyDb.lowMid - pre.zoneEnergyDb.mid;
    const postLowMid = post.zoneEnergyDb.lowMid - post.zoneEnergyDb.mid;
    const preBassMid = pre.zoneEnergyDb.bass - pre.zoneEnergyDb.mid;
    const postBassMid = post.zoneEnergyDb.bass - post.zoneEnergyDb.mid;
    const preSubBass = pre.zoneEnergyDb.sub - pre.zoneEnergyDb.bass;
    const postSubBass = post.zoneEnergyDb.sub - post.zoneEnergyDb.bass;
    const preReg = computeRegionEnergyDb(pre, MUD_REGION_HZ[0], MUD_REGION_HZ[1]);
    const postReg = computeRegionEnergyDb(post, MUD_REGION_HZ[0], MUD_REGION_HZ[1]);
    const preRegVsMid = preReg !== null ? preReg - pre.zoneEnergyDb.mid : null;
    const postRegVsMid = postReg !== null ? postReg - post.zoneEnergyDb.mid : null;

    const lowMidMet = postLowMid <= thresholds.lowMidBuildupLimit;
    const regMet = postRegVsMid === null || postRegVsMid <= thresholds.region150To400VsMidLimit;
    const subNeeded = preSubBass > thresholds.subExcessLimit;
    const subMet = !subNeeded || postSubBass <= thresholds.subExcessLimit;
    const bassNeeded = preBassMid > thresholds.bassMidDiffLimit;
    const bassMet = !bassNeeded || postBassMid <= thresholds.bassMidDiffLimit;

    // Secondary check: vocal/snare midrange separation (Mid vs LowMid) improved AND midrange did not collapse
    const preClarity = pre.zoneEnergyDb.mid - pre.zoneEnergyDb.lowMid;
    const postClarity = post.zoneEnergyDb.mid - post.zoneEnergyDb.lowMid;
    const midIntact = post.zoneEnergyDb.mid >= pre.zoneEnergyDb.mid - 6.0;
    const secondaryClaritySupported = postClarity >= preClarity - 0.15 && midIntact;

    const lowMidDropped = postLowMid <= preLowMid - 0.7;
    const regDropped = preRegVsMid !== null && postRegVsMid !== null && postRegVsMid <= preRegVsMid - 0.7;
    const bassDropped = postBassMid <= preBassMid - 0.8;
    const subDropped = postSubBass <= preSubBass - 0.8;
    const anyMeaningfulDrop = lowMidDropped || regDropped || bassDropped || subDropped;

    // Absolute band movement. Every mud metric above is relative to Mid, so a pass that
    // dips the mids makes low-mid look worse even when low-mid energy itself fell.
    // Level-matched: remove the overall loudness change so a limiter gain push or trim
    // does not read as every band moving together.
    const levelShift = Number.isFinite(post.integratedLufs) && Number.isFinite(pre.integratedLufs)
      ? post.integratedLufs - pre.integratedLufs
      : 0;
    const midAbsChange = post.zoneEnergyDb.mid - pre.zoneEnergyDb.mid - levelShift;
    const lowMidAbsChange = post.zoneEnergyDb.lowMid - pre.zoneEnergyDb.lowMid - levelShift;
    const regAbsChange = preReg !== null && postReg !== null ? postReg - preReg - levelShift : null;
    const absoluteNote =
      ` Level-matched band change: ${MUD_REGION_HZ[0]}–${MUD_REGION_HZ[1]} Hz ${regAbsChange !== null ? fmtSigned(regAbsChange, 1, 'dB') : 'n/a'}, ` +
      `Low-Mid ${fmtSigned(lowMidAbsChange, 1, 'dB')}, Mid ${fmtSigned(midAbsChange, 1, 'dB')}.` +
      (midAbsChange < -1.0
        ? ` Mid fell ${Math.abs(midAbsChange).toFixed(1)} dB, so the relative low-mid readings overstate the remaining mud; restore the midrange before cutting further.`
        : '');

    const aspectChecks = [lowMidMet, regMet, ...(subNeeded ? [subMet] : []), ...(bassNeeded ? [bassMet] : [])];
    const metCount = aspectChecks.filter(Boolean).length;

    if (!stillFlagged && lowMidMet && regMet && subMet && bassMet && secondaryClaritySupported) {
      status = 'RESOLVED';
      verificationSummary =
        `VERIFICATION: Low-Mid vs Mid moved ${fmtSigned(preLowMid, 1, 'dB')} -> ${fmtSigned(postLowMid, 1, 'dB')}` +
        (postRegVsMid !== null
          ? `, 150–400 Hz vs Mid moved ${fmtSigned(preRegVsMid, 1, 'dB')} -> ${fmtSigned(postRegVsMid, 1, 'dB')}`
          : '') +
        `, Bass vs Mid ${fmtSigned(preBassMid, 1, 'dB')} -> ${fmtSigned(postBassMid, 1, 'dB')}. Midrange separation confirmed. Status: RESOLVED` + absoluteNote;
    } else if (metCount > 0 && metCount < aspectChecks.length) {
      status = 'PARTIALLY_RESOLVED';
      const remaining: string[] = [];
      if (!lowMidMet) remaining.push(`Low-Mid vs Mid +${postLowMid.toFixed(1)} dB (target <= +${thresholds.lowMidBuildupLimit.toFixed(1)} dB)`);
      if (!regMet && postRegVsMid !== null) remaining.push(`150–400 Hz vs Mid +${postRegVsMid.toFixed(1)} dB (target <= +${thresholds.region150To400VsMidLimit.toFixed(1)} dB)`);
      if (subNeeded && !subMet) remaining.push(`Sub vs Bass +${postSubBass.toFixed(1)} dB (target <= +${thresholds.subExcessLimit.toFixed(1)} dB)`);
      if (bassNeeded && !bassMet) remaining.push(`Bass vs Mid +${postBassMid.toFixed(1)} dB (target <= +${thresholds.bassMidDiffLimit.toFixed(1)} dB)`);
      remainingDeviation = remaining.join('; ');
      const remainingActions: string[] = [];
      if (!subMet) remainingActions.push('Engage a 28-32 Hz high-pass filter to reduce subsonic excess.');
      if (!bassMet) remainingActions.push('Apply a restrained 80-120 Hz low-shelf reduction to address Bass vs Mid excess.');
      if (!lowMidMet || !regMet) remainingActions.push('Use a narrow 220-340 Hz bell cut only if the low-mid measurements remain elevated.');
      nextRecommendedAction = remainingActions.join(' ');
      verificationSummary = `VERIFICATION: Some mud metrics cleared, but ${remainingDeviation}. Status: PARTIALLY RESOLVED` + absoluteNote;
    } else if (anyMeaningfulDrop) {
      status = 'IMPROVED';
      remainingDeviation = `Low-Mid vs Mid remains ${fmtSigned(postLowMid, 1, 'dB')} (limit <= +${thresholds.lowMidBuildupLimit.toFixed(1)} dB)`;
      nextRecommendedAction = 'Increase surgical 240–320 Hz attenuation (-1.0 to -2.0 dB) or verify EQ wet/bypass state.';
      verificationSummary =
        `VERIFICATION: Buildup decreased (Low-Mid ${fmtSigned(preLowMid, 1)} -> ${fmtSigned(postLowMid, 1)} dB` +
        (postRegVsMid !== null ? `, 150–400 Hz ${fmtSigned(preRegVsMid, 1)} -> ${fmtSigned(postRegVsMid, 1)} dB` : '') +
        `), but remains above threshold. Status: IMPROVED` + absoluteNote;
    } else {
      status = 'UNRESOLVED';
      remainingDeviation = `Low-Mid vs Mid at ${fmtSigned(postLowMid, 1, 'dB')}, Bass vs Mid at ${fmtSigned(postBassMid, 1, 'dB')}`;
      nextRecommendedAction = finding.recommendedAction;
      verificationSummary = `VERIFICATION: No meaningful reduction measured in 150–400 Hz / low-mid energy (${fmtSigned(preLowMid, 1)} -> ${fmtSigned(postLowMid, 1)} dB). Status: UNRESOLVED` + absoluteNote;
    }
  } else {
    // Generic evidence-driven classifier for clipping, DC, noise, phase, L/R skew, harshness, over-compression, THD
    const evaluated = comparisons.filter((c) => c.meetsThreshold !== null);
    const metCount = evaluated.filter((c) => c.meetsThreshold === true).length;
    const improvedCount = evaluated.filter((c) => c.improved === true).length;

    if (!stillFlagged && (evaluated.length === 0 || metCount === evaluated.length)) {
      status = 'RESOLVED';
      const summaryPairs = comparisons
        .slice(0, 3)
        .map((c) => `${c.label}: ${c.beforeFormatted} -> ${c.afterFormatted}`)
        .join('; ');
      verificationSummary = `VERIFICATION: ${summaryPairs}. All measured targets satisfied. Status: RESOLVED`;
    } else if (metCount > 0 && metCount < evaluated.length) {
      status = 'PARTIALLY_RESOLVED';
      const failing = evaluated
        .filter((c) => c.meetsThreshold === false)
        .map((c) => `${c.label}: ${c.afterFormatted}${c.thresholdFormatted ? ` (target ${c.thresholdFormatted})` : ''}`);
      remainingDeviation = failing.join('; ');
      nextRecommendedAction = finding.recommendedAction;
      verificationSummary = `VERIFICATION: Partial fix confirmed; remaining: ${remainingDeviation}. Status: PARTIALLY RESOLVED`;
    } else if (improvedCount > 0) {
      status = 'IMPROVED';
      const failing = evaluated
        .filter((c) => c.meetsThreshold === false)
        .map((c) => `${c.label}: ${c.beforeFormatted} -> ${c.afterFormatted}${c.thresholdFormatted ? ` (target ${c.thresholdFormatted})` : ''}`);
      remainingDeviation = failing.join('; ');
      nextRecommendedAction = finding.recommendedAction;
      verificationSummary = `VERIFICATION: Measurable progress (${failing.join('; ')}), still outside threshold. Status: IMPROVED`;
    } else {
      status = 'UNRESOLVED';
      const currentVals = comparisons
        .slice(0, 2)
        .map((c) => `${c.label}: ${c.afterFormatted}${c.thresholdFormatted ? ` (target ${c.thresholdFormatted})` : ''}`)
        .join('; ');
      remainingDeviation = currentVals;
      nextRecommendedAction = finding.recommendedAction;
      verificationSummary = `VERIFICATION: Metric remained outside acceptable threshold without measurable improvement (${currentVals}). Status: UNRESOLVED`;
    }
  }

  return {
    findingId: finding.id,
    originalFinding: finding,
    postFinding,
    status,
    updatedSeverity:
      status === 'RESOLVED'
        ? 'none'
        : postFinding?.severity ?? finding.severity,
    beforeMeasurements: comparisons,
    afterMeasurements: comparisons,
    verificationSummary,
    remainingDeviation,
    nextRecommendedAction,
    appliedCorrections: appliedLabels,
    measurementReliable: true,
  };
}

export interface VerifyPostFixInput {
  baselineAnalysis: AudioAnalysis;
  baselineDiagnosis?: DirectorDiagnosisReport | null;
  postAnalysis: AudioAnalysis | null;
  objective: MasteringObjectiveId | ResolvedObjectiveTarget;
  referenceAnalysis?: AudioAnalysis | null;
  baselineAnalysisId?: string;
  postAnalysisId?: string;
  currentChainFingerprint?: string;
  postChainFingerprint?: string;
  postProcessingStatus?: 'idle' | 'processing' | 'ready' | 'failed';
  postProcessingError?: string | null;
  appliedCorrections?: AppliedCorrectionRecord[];
}

/**
 * Reanalyzes the actual resulting processed audio and independently verifies whether
 * every baseline technical problem is RESOLVED, IMPROVED, PARTIALLY_RESOLVED,
 * UNRESOLVED, or UNVERIFIED. Never fakes resolution from processor settings alone.
 */
export function verifyPostFixAnalysis(input: VerifyPostFixInput): PostFixVerificationReport {
  const baselineDiag =
    input.baselineDiagnosis ??
    analyzeTrackIntelligence(input.baselineAnalysis, input.objective, input.referenceAnalysis);
  const thresholds = getDiagnosisThresholds(input.objective, input.referenceAnalysis);
  const objectiveId =
    typeof input.objective === 'string' ? input.objective : input.objective.id;
  const objectiveTarget =
    typeof input.objective === 'string' ? undefined : input.objective;
  const appliedCorrections = input.appliedCorrections ?? [];
  const baselineId = input.baselineAnalysisId ?? 'baseline';
  const postId = input.postAnalysisId ?? (input.postAnalysis ? 'post' : 'missing');
  const currentFp = input.currentChainFingerprint ?? 'unknown';

  const baselineRegion = computeRegionEnergyDb(input.baselineAnalysis, MUD_REGION_HZ[0], MUD_REGION_HZ[1]);

  const baselineTechnical = baselineDiag.findings.filter(
    (f) => f.kind === 'technical-problem',
  );
  const artisticAndObservations = baselineDiag.findings.filter(
    (f) => f.kind !== 'technical-problem',
  );

  // Freshness & integrity checks
  let analysisFresh = true;
  let verificationError: string | undefined;

  if (input.postProcessingStatus === 'failed' || input.postProcessingError) {
    analysisFresh = false;
    verificationError =
      input.postProcessingError ||
      'Post-processing render or audio reanalysis failed; findings cannot be marked resolved.';
  } else if (!input.postAnalysis) {
    analysisFresh = false;
    verificationError =
      input.postProcessingStatus === 'processing'
        ? 'Reanalyzing processed audio signal...'
        : appliedCorrections.length > 0
          ? 'Correction applied without completed post-fix audio reanalysis.'
          : 'Processed audio has not been analyzed yet.';
  } else if (!isAnalysisMeasurementReliable(input.postAnalysis)) {
    analysisFresh = false;
    verificationError =
      'Post-fix audio measurements failed reliability checks (non-finite or silent signal).';
  } else if (
    input.postChainFingerprint &&
    input.currentChainFingerprint &&
    input.postChainFingerprint !== input.currentChainFingerprint
  ) {
    analysisFresh = false;
    verificationError =
      'Post-analysis telemetry belongs to an outdated mastering chain and does not match active parameters.';
  } else if (
    input.postAnalysisId &&
    input.baselineAnalysisId &&
    input.postAnalysisId === input.baselineAnalysisId &&
    appliedCorrections.length > 0
  ) {
    analysisFresh = false;
    verificationError =
      'Detected cached baseline analysis ID instead of fresh post-fix processed audio.';
  }

  // If stale / failed / missing / unreliable: never report RESOLVED and never fabricate after metrics
  if (!analysisFresh || !input.postAnalysis) {
    const isInitialIdle =
      !input.postAnalysis &&
      input.postProcessingStatus !== 'failed' &&
      !input.postProcessingError &&
      appliedCorrections.length === 0;
    const fallbackStatus: FindingVerificationStatus = isInitialIdle ? 'ACTIVE' : 'UNVERIFIED';

    const activeFindings: VerifiedFindingState[] = baselineTechnical.map((finding) => {
      const comps = buildBaselineComparisonsForFinding(
        finding,
        input.baselineAnalysis,
        null,
        thresholds,
        objectiveTarget,
        objectiveId,
      );
      return {
        findingId: finding.id,
        originalFinding: finding,
        postFinding: null,
        status: fallbackStatus,
        updatedSeverity: finding.severity,
        beforeMeasurements: comps,
        afterMeasurements: comps,
        verificationSummary:
          fallbackStatus === 'ACTIVE'
            ? 'Baseline technical finding measured prior to processing verification.'
            : `VERIFICATION UNVERIFIED: ${verificationError ?? 'Processed audio reanalysis required.'}`,
        remainingDeviation:
          fallbackStatus === 'UNVERIFIED' ? 'Awaiting valid processed audio analysis' : undefined,
        nextRecommendedAction: finding.recommendedAction,
        appliedCorrections: relevantCorrectionLabels(finding, appliedCorrections),
        measurementReliable: false,
      };
    });

    return {
      id: `pfv-${Date.now()}`,
      timestamp: Date.now(),
      chainFingerprint: currentFp,
      baselineAnalysisId: baselineId,
      postAnalysisId: postId,
      baselineAnalysis: input.baselineAnalysis,
      postAnalysis: null,
      analysisFresh: false,
      verificationError,
      appliedCorrections,
      activeFindings,
      resolvedFindings: [],
      artisticAndObservations,
      newlyIntroducedFindings: [],
      postDiagnosis: null,
      affectedMetricsSummary: {
        integratedLufsBefore: input.baselineAnalysis.integratedLufs,
        integratedLufsAfter: null,
        shortTermLufsMaxBefore: input.baselineAnalysis.shortTermLufsMax,
        shortTermLufsMaxAfter: null,
        rmsDbBefore: input.baselineAnalysis.rmsDb,
        rmsDbAfter: null,
        samplePeakDbBefore: input.baselineAnalysis.samplePeakDb,
        samplePeakDbAfter: null,
        truePeakDbBefore: input.baselineAnalysis.truePeakDb,
        truePeakDbAfter: null,
        crestFactorDbBefore: input.baselineAnalysis.crestFactorDb,
        crestFactorDbAfter: null,
        plrDbBefore: input.baselineAnalysis.plrDb,
        plrDbAfter: null,
        dynamicRangeDbBefore: input.baselineAnalysis.dynamicRangeDb,
        dynamicRangeDbAfter: null,
        spectralSlopeBefore: input.baselineAnalysis.spectralSlopeDbPerOct,
        spectralSlopeAfter: null,
        spectralCentroidBefore: input.baselineAnalysis.spectralCentroidHz,
        spectralCentroidAfter: null,
        region150To400DbBefore: baselineRegion,
        region150To400DbAfter: null,
      },
    };
  }

  // Fresh, reliable post-analysis confirmed: run independent diagnosis on the processed audio signal
  const postAnalysis = input.postAnalysis;
  const postDiag = analyzeTrackIntelligence(
    postAnalysis,
    input.objective,
    input.referenceAnalysis,
  );
  const postTechById = new Map<string, AnalysisFinding>();
  for (const pf of postDiag.findings) {
    if (pf.kind === 'technical-problem') {
      postTechById.set(pf.id, pf);
    }
  }

  const activeFindings: VerifiedFindingState[] = [];
  const resolvedFindings: VerifiedFindingState[] = [];

  for (const baselineFinding of baselineTechnical) {
    const postFinding = postTechById.get(baselineFinding.id) ?? null;
    const verified = classifyVerifiedFinding({
      finding: baselineFinding,
      pre: input.baselineAnalysis,
      post: postAnalysis,
      postFinding,
      thresholds,
      objectiveTarget,
      objectiveId,
      appliedCorrections,
    });
    if (verified.status === 'RESOLVED') {
      resolvedFindings.push(verified);
    } else {
      activeFindings.push(verified);
    }
  }

  const baselineIds = new Set(baselineTechnical.map((f) => f.id));
  const postTechIds = new Set(postDiag.findings.filter((f) => f.kind === 'technical-problem').map((f) => f.id));
  const newlyIntroducedFindings: AnalysisFinding[] = postDiag.findings.filter(
    (f) => f.kind === 'technical-problem' && !baselineIds.has(f.id),
  );

  // Objective-aware newly introduced issues (True Peak ceiling breach, excessive loudness overshoot, DR collapse, or severe low-mid over-cut)
  const limits = objectiveTarget ?? OBJECTIVE_LIMITS[typeof input.objective === 'string' ? input.objective : input.objective.id];
  if (
    limits &&
    !baselineIds.has('diag-clipping') &&
    !postTechIds.has('diag-clipping') &&
    postAnalysis.truePeakDb > limits.maxTruePeakDb + 0.05 &&
    (input.baselineAnalysis.truePeakDb <= limits.maxTruePeakDb + 0.05 ||
      postAnalysis.truePeakDb > input.baselineAnalysis.truePeakDb + 0.25)
  ) {
    newlyIntroducedFindings.push({
      id: 'diag-tp-ceiling-exceeded',
      kind: 'technical-problem',
      category: 'Integrity',
      title: 'True Peak Delivery Ceiling Exceeded',
      severity: postAnalysis.truePeakDb > -0.1 ? 'high' : 'moderate',
      evidence: [
        `True Peak: ${postAnalysis.truePeakDb.toFixed(2)} dBTP (Limit <= ${limits.maxTruePeakDb.toFixed(1)} dBTP)`,
        `Baseline True Peak: ${input.baselineAnalysis.truePeakDb.toFixed(2)} dBTP`,
      ],
      metrics: {
        truePeakDb: postAnalysis.truePeakDb,
        maxTruePeakDb: limits.maxTruePeakDb,
      },
      explanation:
        'Processing raised output peak levels past the objective True Peak delivery ceiling, risking codec transcoding distortion.',
      recommendedAction: `Lower Maximizer/Limiter ceiling to ${limits.maxTruePeakDb.toFixed(1)} dBTP with 4x True Peak enabled.`,
    });
  }

  if (
    limits &&
    postAnalysis.integratedLufs > limits.targetLufs + limits.lufsTolerance + 1.5 &&
    postAnalysis.integratedLufs > input.baselineAnalysis.integratedLufs + 1.0 &&
    input.baselineAnalysis.integratedLufs <= limits.targetLufs + limits.lufsTolerance + 1.0
  ) {
    newlyIntroducedFindings.push({
      id: 'diag-loudness-overshoot',
      kind: 'technical-problem',
      category: 'Loudness',
      title: 'Excessive Loudness Overshoot Above Objective Target',
      severity:
        postAnalysis.integratedLufs > limits.targetLufs + limits.lufsTolerance + 3.5
          ? 'high'
          : 'moderate',
      evidence: [
        `Integrated: ${postAnalysis.integratedLufs.toFixed(1)} LUFS (Target ${limits.targetLufs.toFixed(1)} ± ${limits.lufsTolerance.toFixed(1)} LUFS)`,
        `Baseline: ${input.baselineAnalysis.integratedLufs.toFixed(1)} LUFS`,
      ],
      metrics: {
        integratedLufs: postAnalysis.integratedLufs,
        targetLufs: limits.targetLufs,
      },
      explanation:
        'Processing pushed integrated loudness well above target; streaming normalization will turn the master down while sacrificing headroom.',
      recommendedAction: `Reduce Maximizer Target LUFS / Limiter drive toward ${limits.targetLufs.toFixed(1)} LUFS.`,
    });
  }

  if (
    limits &&
    !baselineIds.has('diag-overcompressed') &&
    !postTechIds.has('diag-overcompressed') &&
    ((postAnalysis.dynamicRangeDb < limits.minDynamicRangeDb &&
      input.baselineAnalysis.dynamicRangeDb >= limits.minDynamicRangeDb) ||
      input.baselineAnalysis.dynamicRangeDb - postAnalysis.dynamicRangeDb > 4.5)
  ) {
    newlyIntroducedFindings.push({
      id: 'diag-overcompressed',
      kind: 'technical-problem',
      category: 'Dynamics',
      title: 'Dynamic Range Collapse Introduced by Processing',
      severity: postAnalysis.dynamicRangeDb < limits.minDynamicRangeDb - 1.5 ? 'high' : 'moderate',
      evidence: [
        `Dynamic Range: ${postAnalysis.dynamicRangeDb.toFixed(1)} dB (Target >= ${limits.minDynamicRangeDb.toFixed(1)} dB)`,
        `Baseline DR: ${input.baselineAnalysis.dynamicRangeDb.toFixed(1)} dB`,
      ],
      metrics: {
        dynamicRangeDb: postAnalysis.dynamicRangeDb,
        minDynamicRangeDb: limits.minDynamicRangeDb,
      },
      explanation:
        'Excessive compression or limiting flattened transient contrast beyond objective dynamic range limits.',
      recommendedAction: 'Ease Limiter/Maximizer drive or relax bus compression ratio.',
    });
  }

  const preLowMidDelta = input.baselineAnalysis.zoneEnergyDb.lowMid - input.baselineAnalysis.zoneEnergyDb.mid;
  const postLowMidDelta = postAnalysis.zoneEnergyDb.lowMid - postAnalysis.zoneEnergyDb.mid;
  if (
    !baselineIds.has('diag-hollow-lowmid') &&
    !postTechIds.has('diag-hollow-lowmid') &&
    preLowMidDelta - postLowMidDelta >= 10.0 &&
    postLowMidDelta < -4.0
  ) {
    newlyIntroducedFindings.push({
      id: 'diag-overcut-imbalance',
      kind: 'technical-problem',
      category: 'Spectral',
      title: 'Over-Cut Low-Mid / Hollow Tonal Imbalance',
      severity: postLowMidDelta < -6.0 ? 'high' : 'moderate',
      evidence: [
        `Low-Mid vs Mid: ${fmtSigned(preLowMidDelta, 1, 'dB')} -> ${fmtSigned(postLowMidDelta, 1, 'dB')}`,
      ],
      metrics: {
        lowMidBuildup: postLowMidDelta,
        swingDb: postLowMidDelta - preLowMidDelta,
      },
      explanation:
        'Aggressive attenuation removed excessive low-mid body relative to baseline, introducing a thin/scooped tonal balance.',
      recommendedAction: 'Back off 150–400 Hz EQ cut depth by 3–6 dB to restore midrange warmth.',
    });
  }

  const postRegion = computeRegionEnergyDb(postAnalysis, MUD_REGION_HZ[0], MUD_REGION_HZ[1]);

  return {
    id: `pfv-${Date.now()}`,
    timestamp: Date.now(),
    chainFingerprint: currentFp,
    baselineAnalysisId: baselineId,
    postAnalysisId: postId,
    baselineAnalysis: input.baselineAnalysis,
    postAnalysis,
    analysisFresh: true,
    appliedCorrections,
    activeFindings,
    resolvedFindings,
    artisticAndObservations: postDiag.findings.filter((f) => f.kind !== 'technical-problem'),
    newlyIntroducedFindings,
    postDiagnosis: postDiag,
    affectedMetricsSummary: {
      integratedLufsBefore: input.baselineAnalysis.integratedLufs,
      integratedLufsAfter: postAnalysis.integratedLufs,
      shortTermLufsMaxBefore: input.baselineAnalysis.shortTermLufsMax,
      shortTermLufsMaxAfter: postAnalysis.shortTermLufsMax,
      rmsDbBefore: input.baselineAnalysis.rmsDb,
      rmsDbAfter: postAnalysis.rmsDb,
      samplePeakDbBefore: input.baselineAnalysis.samplePeakDb,
      samplePeakDbAfter: postAnalysis.samplePeakDb,
      truePeakDbBefore: input.baselineAnalysis.truePeakDb,
      truePeakDbAfter: postAnalysis.truePeakDb,
      crestFactorDbBefore: input.baselineAnalysis.crestFactorDb,
      crestFactorDbAfter: postAnalysis.crestFactorDb,
      plrDbBefore: input.baselineAnalysis.plrDb,
      plrDbAfter: postAnalysis.plrDb,
      dynamicRangeDbBefore: input.baselineAnalysis.dynamicRangeDb,
      dynamicRangeDbAfter: postAnalysis.dynamicRangeDb,
      spectralSlopeBefore: input.baselineAnalysis.spectralSlopeDbPerOct,
      spectralSlopeAfter: postAnalysis.spectralSlopeDbPerOct,
      spectralCentroidBefore: input.baselineAnalysis.spectralCentroidHz,
      spectralCentroidAfter: postAnalysis.spectralCentroidHz,
      region150To400DbBefore: baselineRegion,
      region150To400DbAfter: postRegion,
    },
  };
}
