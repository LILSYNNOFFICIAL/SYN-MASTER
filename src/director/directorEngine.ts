import { isNoiseLikeFloor } from '../dsp/analyzer';
import { filterSourceTransientClickAnalysis } from '../dsp/clickDetect';
import {
  selectBestSafeFallbackCheckpoint,
  type SafeFallbackCandidate,
} from './safeCandidateFallback';

/**
 * Identity of a chain for "already rendered" checks: module ids, names and UI state are
 * ignored and numbers are rounded, so A -> B -> A oscillations (e.g. maximizer target
 * +0.5 / -0.5 LU) are caught despite float drift.
 */
export function chainRenderKey(chain: ProcessorModule[]): string {
  return JSON.stringify(chain, (k, v) => {
    if (k === 'id' || k === 'name' || k === 'expanded' || k === 'presetName' || k === 'group') return undefined;
    return typeof v === 'number' ? Math.round(v * 1000) / 1000 : v;
  });
}

/** Shimmer detection confidence at which the deterministic engine enables de-shimmer. */
export const SHIMMER_AUTO_CONFIDENCE = 0.6;
import type { FadeSettings } from '../dsp/fades';
import { evaluateMasterTargets, type MasterTargetGate } from './masterTargets';
import type { RestoreParams } from '../types/mastering';
import type {
  AiCallSource,
  AiChainLifecycleState,
  AiFallbackReason,
  AIMasteringStrategy,
  AiPassTrace,
  AiTimeoutHit,
  AudioAnalysis,
  ChainCommand,
  CustomObjectiveSpec,
  DirectorActivityEntry,
  DirectorCheckpoint,
  DirectorDiagnosisReport,
  DirectorOperatingMode,
  DirectorRecommendation,
  EQBand,
  ExportConfig,
  ExternalPluginRecord,
  MasterFinalReport,
  MasteringMode,
  MasteringObjectiveId,
  MultiObjectiveDimension,
  MultiObjectiveEvaluation,
  PluginIntelligenceSummary,
  PostFixVerificationReport,
  ProcessorModule,
  QCReport,
  QCTargetProfile,
  ReferenceComparisonReport,
  ResolvedObjectiveTarget,
  StemIntelligenceReport,
  VocalBalanceVerification,
} from '../types/mastering';
import { validateChain } from '../dsp/chainValidation';
import { directorMatchEqCommand, directorMatchEqPeakDb, hydrateMatchEqChain, type MatchEqProfile } from './matchEqDirector';
import { learnMatchEqSpectrum } from '../dsp/matchEq';
import type { StemInput, StemSetAnalysis } from '../dsp/stemAnalysis';
import { renderStemBusMix } from '../dsp/stemBusRenderer';
import { type ExternalPluginProcessCallback } from '../dsp/mixedChainRenderer';
import { renderAndAnalyzeOffThread } from '../dsp/workerClient';
import { QC_TARGET_PROFILES, runQualityControl } from '../dsp/qc';
import {
  analyzeTrackIntelligence,
  computeRegionEnergyDb,
  getDiagnosisThresholds,
  isAnalysisMeasurementReliable,
} from './analyzeIntelligence';
import { MUD_CORRECTION_HZ, MUD_REGION_HZ } from '../dsp/bandMap';
import {
  REFINE_MUD_PROPORTIONAL_Q,
  measureRumble,
  mudBell,
  planDynamicHighBand,
  planRumbleHighPass,
  planSideLowCut,
} from './eqStrategy';
import { applyStructuredChainCommands } from './chainCommands';
import { inspectPluginInventory } from './pluginIntelligence';
import { validateChainAgainstInventory } from './processorInventory';
import { computeChainFingerprint, isMasterFullyVerified, verifyPostFixAnalysis } from './postFixVerification';
import { deriveReferenceMatchBands } from './referenceMatch';

export function resolveObjectiveTarget(
  objectiveId: MasteringObjectiveId,
  customSpec?: Partial<CustomObjectiveSpec> | null,
  referenceAnalysis?: AudioAnalysis | null,
): ResolvedObjectiveTarget {
  switch (objectiveId) {
    case 'streaming':
      return {
        id: 'streaming',
        label: 'Streaming',
        targetLufs: -14.0,
        maxTruePeakDb: -1.0,
        minDynamicRangeDb: 7.5,
        tonalBias: 'neutral',
        stereoPreference: 'preserve',
        preserveTransients: true,
        lufsTolerance: 1.0,
        saturationAllowance: 'subtle',
        description:
          'Calibrated for Spotify/Apple/YouTube loudness normalization (-14.0 LUFS / -1.0 dBTP ceiling).',
      };
    case 'commercial-loudness':
      return {
        id: 'commercial-loudness',
        label: 'Commercial Loudness',
        targetLufs: -9.0,
        maxTruePeakDb: -0.5,
        minDynamicRangeDb: 5.5,
        tonalBias: 'neutral',
        stereoPreference: 'wide',
        preserveTransients: true,
        lufsTolerance: 1.2,
        saturationAllowance: 'moderate',
        description:
          'Competitive release loudness with multi-stage peak control and harmonic density (-9.0 LUFS / -0.5 dBTP).',
      };
    case 'dynamic':
      return {
        id: 'dynamic',
        label: 'Dynamic',
        targetLufs: -16.0,
        maxTruePeakDb: -1.2,
        minDynamicRangeDb: 10.0,
        tonalBias: 'neutral',
        stereoPreference: 'preserve',
        preserveTransients: true,
        lufsTolerance: 1.3,
        saturationAllowance: 'none',
        description:
          'Prioritizes micro-dynamic expression and unclipped transient peaks (-16.0 LUFS / -1.2 dBTP).',
      };
    case 'cinematic':
      return {
        id: 'cinematic',
        label: 'Cinematic',
        targetLufs: -16.5,
        maxTruePeakDb: -1.5,
        minDynamicRangeDb: 10.5,
        tonalBias: 'warm',
        stereoPreference: 'wide',
        preserveTransients: true,
        lufsTolerance: 1.5,
        saturationAllowance: 'subtle',
        description:
          'Wide orchestral stage, deep sub headroom, and wide dynamic macro-swells (-16.5 LUFS / -1.5 dBTP).',
      };
    case 'electronic':
      return {
        id: 'electronic',
        label: 'Electronic',
        targetLufs: -9.5,
        maxTruePeakDb: -0.8,
        minDynamicRangeDb: 6.0,
        tonalBias: 'bright',
        stereoPreference: 'wide',
        preserveTransients: true,
        lufsTolerance: 1.1,
        saturationAllowance: 'moderate',
        description:
          'Locked mono sub foundation, crisp air, and club-ready loudness (-9.5 LUFS / -0.8 dBTP).',
      };
    case 'hip-hop':
      return {
        id: 'hip-hop',
        label: 'Hip-Hop',
        targetLufs: -9.5,
        maxTruePeakDb: -0.8,
        minDynamicRangeDb: 6.0,
        tonalBias: 'warm',
        stereoPreference: 'preserve',
        preserveTransients: true,
        lufsTolerance: 1.1,
        saturationAllowance: 'moderate',
        description:
          'Weighty low-end sub punch, forward vocal pocket, and controlled ceiling (-9.5 LUFS / -0.8 dBTP).',
      };
    case 'pop':
      return {
        id: 'pop',
        label: 'Pop',
        targetLufs: -11.0,
        maxTruePeakDb: -1.0,
        minDynamicRangeDb: 6.8,
        tonalBias: 'bright',
        stereoPreference: 'wide',
        preserveTransients: true,
        lufsTolerance: 1.0,
        saturationAllowance: 'subtle',
        description:
          'Polished vocal presence, bright modern air, and radio/playlist punch (-11.0 LUFS / -1.0 dBTP).',
      };
    case 'acoustic':
      return {
        id: 'acoustic',
        label: 'Acoustic',
        targetLufs: -15.5,
        maxTruePeakDb: -1.0,
        minDynamicRangeDb: 9.5,
        tonalBias: 'warm',
        stereoPreference: 'preserve',
        preserveTransients: true,
        lufsTolerance: 1.3,
        saturationAllowance: 'none',
        description:
          'Linear natural timbre and gentle resonance cleanup preserving string/room decay (-15.5 LUFS / -1.0 dBTP).',
      };
    case 'vocal-focused':
      return {
        id: 'vocal-focused',
        label: 'Vocal-Focused',
        targetLufs: -13.0,
        maxTruePeakDb: -1.0,
        minDynamicRangeDb: 7.5,
        tonalBias: 'neutral',
        stereoPreference: 'preserve',
        preserveTransients: true,
        lufsTolerance: 1.1,
        saturationAllowance: 'subtle',
        description:
          'Low-mid mud control, de-essed clarity in 2–6 kHz presence pocket, and stable center image (-13.0 LUFS).',
      };
    case 'transparent':
      return {
        id: 'transparent',
        label: 'Transparent',
        targetLufs: -15.0,
        maxTruePeakDb: -1.0,
        minDynamicRangeDb: 9.0,
        tonalBias: 'neutral',
        stereoPreference: 'preserve',
        preserveTransients: true,
        lufsTolerance: 1.2,
        saturationAllowance: 'none',
        description:
          'Minimal tonal coloration, linear-phase preservation, high dynamic crest retention (-15 LUFS / -1.0 dBTP).',
      };
    case 'punchy':
      return {
        id: 'punchy',
        label: 'Punchy',
        targetLufs: -10.5,
        maxTruePeakDb: -0.8,
        minDynamicRangeDb: 6.2,
        tonalBias: 'neutral',
        stereoPreference: 'preserve',
        preserveTransients: true,
        lufsTolerance: 1.2,
        saturationAllowance: 'moderate',
        description:
          'Forward drum & transient impact, tight sub focus, controlled harmonic density (-10.5 LUFS / -0.8 dBTP).',
      };
    case 'warm':
      return {
        id: 'warm',
        label: 'Warm',
        targetLufs: -13.0,
        maxTruePeakDb: -1.0,
        minDynamicRangeDb: 8.0,
        tonalBias: 'warm',
        stereoPreference: 'wide',
        preserveTransients: true,
        lufsTolerance: 1.3,
        saturationAllowance: 'rich',
        description:
          'Even-order analog tube weight, smooth upper midrange, gentle optical glue (-13.0 LUFS / -1.0 dBTP).',
      };
    case 'custom': {
      const targetLufs =
        customSpec?.targetLufs ??
        (referenceAnalysis ? Math.max(-18, Math.min(-8, referenceAnalysis.integratedLufs)) : -13.0);
      return {
        id: 'custom',
        label: 'Custom Objective',
        targetLufs,
        maxTruePeakDb: customSpec?.maxTruePeakDb ?? -1.0,
        minDynamicRangeDb: customSpec?.minDynamicRangeDb ?? 7.0,
        tonalBias: customSpec?.tonalBias ?? 'neutral',
        stereoPreference: customSpec?.stereoPreference ?? 'preserve',
        preserveTransients: customSpec?.preserveTransients ?? true,
        lufsTolerance: 1.2,
        saturationAllowance: targetLufs > -11 ? 'moderate' : 'subtle',
        description: `User-defined mastering target (${targetLufs.toFixed(1)} LUFS, <= ${(customSpec?.maxTruePeakDb ?? -1.0).toFixed(1)} dBTP, DR >= ${(customSpec?.minDynamicRangeDb ?? 7.0).toFixed(1)} dB).`,
      };
    }
  }
}

export interface ExplainableMasterPlan {
  objective: ResolvedObjectiveTarget;
  diagnosis: DirectorDiagnosisReport;
  pluginSummary: PluginIntelligenceSummary;
  recommendations: DirectorRecommendation[];
  chain: ProcessorModule[];
  strategy: AIMasteringStrategy;
}

/**
 * Generates an Explainable Mastering Plan & structured ChainCommand[] directly from
 * measured AudioAnalysis, chosen Objective, optional Reference, and real Plugin inventory.
 * Selects ONLY needed processors — never blindly stacks all 10 DSP stages.
 */
export function buildExplainableMasterPlan(input: {
  analysis: AudioAnalysis;
  objectiveId: MasteringObjectiveId;
  customSpec?: Partial<CustomObjectiveSpec> | null;
  referenceAnalysis?: AudioAnalysis | null;
  externalPlugins?: ExternalPluginRecord[];
  hostConnected?: boolean;
  stemAnalysis?: StemSetAnalysis | null;
  /** Learned source/reference spectra; enables one conservative Match EQ (reference only). */
  matchEqProfile?: MatchEqProfile | null;
}): ExplainableMasterPlan {
  const { analysis, objectiveId, customSpec, referenceAnalysis } = input;
  const objective = resolveObjectiveTarget(objectiveId, customSpec, referenceAnalysis);
  const diagnosis = analyzeTrackIntelligence(analysis, objective, referenceAnalysis);
  const pluginSummary = inspectPluginInventory(
    input.externalPlugins ?? [],
    Boolean(input.hostConnected),
    analysis,
    objective,
  );

  const recommendations: DirectorRecommendation[] = [];
  const bassMidDiff = analysis.zoneEnergyDb.bass - analysis.zoneEnergyDb.mid;
  const lowMidBuildup = analysis.zoneEnergyDb.lowMid - analysis.zoneEnergyDb.mid;
  const harshExcess = analysis.zoneEnergyDb.highMid - analysis.zoneEnergyDb.mid;
  const nf = analysis.noiseFloorDb ?? -72;

  if (input.stemAnalysis) {
    const stemSet = input.stemAnalysis;
    const stemNames = new Map(stemSet.stems.map((stem) => [stem.id, stem.name]));
    const grouped = new Map<string, typeof stemSet.overlaps>();
    for (const overlap of stemSet.overlaps) {
      const key = [overlap.stemAId, overlap.stemBId, overlap.band].sort().join(':');
      const group = grouped.get(key) ?? [];
      group.push(overlap);
      grouped.set(key, group);
    }

    const topCandidates = [...grouped.values()]
      .map((items) => items[0])
      .sort((a, b) => a.differenceDb - b.differenceDb)
      .slice(0, 6);

    for (const candidate of topCandidates) {
      const nameA = stemNames.get(candidate.stemAId) ?? candidate.stemAId;
      const nameB = stemNames.get(candidate.stemBId) ?? candidate.stemBId;
      const bandLabel = candidate.band;
      const findingId = `diag-stem-overlap-${candidate.stemAId}-${candidate.stemBId}-${bandLabel}`;
      diagnosis.findings.push({
        id: findingId,
        kind: 'observation',
        category: 'Spectral',
        title: `Stem Interaction Candidate: ${nameA} / ${nameB}`,
        severity: candidate.confidence === 'moderate' ? 'moderate' : 'low',
        evidence: [
          `Band: ${bandLabel}`,
          `${nameA}: ${candidate.stemALevelDb.toFixed(1)} dB`,
          `${nameB}: ${candidate.stemBLevelDb.toFixed(1)} dB`,
          `Band-level difference: ${candidate.differenceDb.toFixed(1)} dB`,
        ],
        evidenceStrength: candidate.confidence === 'moderate' ? 'multiple' : 'single',
        metrics: {
          stemALevelDb: candidate.stemALevelDb,
          stemBLevelDb: candidate.stemBLevelDb,
          differenceDb: candidate.differenceDb,
        },
        explanation: 'Both supplied stems contain comparable energy in this broad frequency region. This is a coexistence candidate only; it does not establish audible masking.',
        recommendedAction: 'Audition both stems together and in solo. If the interaction is audible, adjust the source stem arrangement, level, envelope, or stem-routed processing rather than applying an unverified master-bus cut.',
      });
      recommendations.push({
        id: `rec-${findingId}`,
        characteristic: `Stem interaction candidate: ${nameA} + ${nameB} (${bandLabel})`,
        supportingMeasurements: [
          `${nameA}: ${candidate.stemALevelDb.toFixed(1)} dB`,
          `${nameB}: ${candidate.stemBLevelDb.toFixed(1)} dB`,
          `Difference: ${candidate.differenceDb.toFixed(1)} dB`,
          `Confidence: ${candidate.confidence}`,
        ],
        proposedCorrection: 'Audition the two sources in context, then make any correction on the relevant source stem or bus.',
        selectedProcessor: 'parametric-eq',
        proposedParamsSummary: 'No master-bus EQ command generated. Stem-routed processing is required for a safe targeted correction.',
        commands: [],
        expectedResult: 'Improve separation only if listening confirms an audible conflict, while preserving unrelated mix elements.',
        potentialTradeoffs: 'A broad master-bus cut could damage other sources. This recommendation is advisory until stem-bus routing exists.',
        priority: candidate.confidence === 'moderate' ? 'recommended' : 'optional',
        statementType: 'hypothesis',
      });
    }

    if (topCandidates.length > 0) {
      diagnosis.workingWell.push(`Stem Intelligence screened ${stemSet.stems.length} supplied sources and identified ${topCandidates.length} spectral coexistence candidate(s) for listening review.`);
    }
  }

  // Stage 1: SYN-Restore ONLY if genuine DC offset, elevated quiet-frame noise floor, or strong sibilance/resonance exists
  const hasGenuineNoiseFloor = nf > -48 && analysis.rmsDb - nf >= 12 && isNoiseLikeFloor(analysis);
  const baselineClicks = analysis.clickCount ?? 0;
  // Measured AI shimmer (src/dsp/shimmerDetect.ts): only a confident detection (all cues
  // agree and there is enough HF to judge) switches de-shimmer on automatically.
  const shimmerConfidence = analysis.shimmer?.confidence ?? 0;
  const autoDeShimmer = shimmerConfidence >= SHIMMER_AUTO_CONFIDENCE ? Math.round(30 + 50 * Math.min(1, (shimmerConfidence - SHIMMER_AUTO_CONFIDENCE) / (1 - SHIMMER_AUTO_CONFIDENCE))) : 0;
  const needsRestore =
    baselineClicks > 0 ||
    autoDeShimmer > 0 ||
    analysis.dcOffset >= 0.004 ||
    hasGenuineNoiseFloor ||
    (analysis.zoneEnergyDb.presence - analysis.zoneEnergyDb.mid > -2.5 && analysis.resonances.some((r) => r.freqHz > 4500));

  // Measured isolated upper resonance (Stage 3 below). When it is sibilance, a keyed dynamic
  // high shelf de-esses it, so SYN-Restore's static de-esser drops to its light baseline
  // instead of stacking a second de-esser on the same region.
  const topRes = analysis.resonances.find((resonance) =>
    resonance.freqHz >= 2000 && resonance.freqHz <= 12000 && resonance.excessDb >= 6.0,
  );
  const dynamicHighPlan = topRes ? planDynamicHighBand(analysis, topRes) : null;

  if (needsRestore) {
    const hiss = hasGenuineNoiseFloor ? Math.min(42, Math.round((nf + 55) * 2.2)) : 4;
    const deEss = analysis.zoneEnergyDb.presence - analysis.zoneEnergyDb.mid > -2.5 && dynamicHighPlan?.kind !== 'sibilance' ? 24 : 8;
    const restoreParams = {
      dcOffset: analysis.dcOffset >= 0.004,
      humRemovalHz: 0 as const,
      hissReduction: Math.max(0, hiss),
      deEssAmount: deEss,
      deEssFreqHz: 6800,
      resonanceSuppress: analysis.resonances.length > 0 ? 16 : 6,
      mode: 'conservative' as const,
      // Fix clicks on the FIRST pass when they are measured, instead of waiting for a later pass.
      declick: baselineClicks > 0 ? Math.min(85, 45 + baselineClicks * 2) : 0,
      decrackle: baselineClicks > 20 ? 35 : baselineClicks > 0 ? 15 : 0,
      spikeRepair: baselineClicks > 0,
      deShimmer: autoDeShimmer,
    };
    recommendations.push({
      id: 'rec-restore',
      characteristic:
        nf > -48
          ? 'Elevated broadband noise floor & potential DC bias'
          : 'DC waveform offset / upper-band sibilance spike',
      supportingMeasurements: [
        `Noise Floor: ${nf.toFixed(1)} dBFS`,
        `DC Offset: ${(analysis.dcOffset * 100).toFixed(3)}%`,
        `Presence Energy: ${analysis.zoneEnergyDb.presence.toFixed(1)} dB`,
        ...(analysis.shimmer ? [`AI shimmer confidence: ${analysis.shimmer.confidence.toFixed(2)} (auto de-shimmer at ≥ ${SHIMMER_AUTO_CONFIDENCE})`] : []),
      ],
      proposedCorrection: 'Engage conservative pre-master cleanup prior to tonal EQ & compression.',
      selectedProcessor: 'restore',
      proposedParamsSummary: `${baselineClicks > 0 ? `De-click=${restoreParams.declick}% (${baselineClicks} clicks), ` : ''}${autoDeShimmer > 0 ? `De-shimmer=${autoDeShimmer}%, ` : ''}DC=${restoreParams.dcOffset ? 'ON' : 'OFF'}, Hiss=${restoreParams.hissReduction}%, De-Ess=${restoreParams.deEssAmount}% @ 6.8kHz (Conservative)`,
      commands: [
        {
          op: 'add',
          processorType: 'restore',
          name: 'SYN-Restore Cleanup',
          params: restoreParams,
          rationale: 'Clean subsonic DC bias and steady-state noise before level elevation.',
        },
      ],
      expectedResult: 'Lower quiet-passage noise floor and reclaim symmetric headroom without dulling transients.',
      potentialTradeoffs: 'Excessive hiss reduction can soften ambient air tails; kept in conservative mode.',
      priority: analysis.dcOffset >= 0.006 || nf > -42 ? 'critical' : 'recommended',
      statementType: 'hypothesis',
    });
  }

  // Stage 1b: Match EQ toward the reference (only with a learned reference; conservative).
  const matchEqCommand = referenceAnalysis ? directorMatchEqCommand(input.matchEqProfile) : null;
  if (matchEqCommand) {
    recommendations.push({
      id: 'rec-match-eq',
      characteristic: 'Long-term tonal balance differs from the loaded reference',
      supportingMeasurements: [
        `Learned spectra: source vs ${input.matchEqProfile?.referenceName ?? 'reference'} (1/24-octave LTAS)`,
        `Peak correction at 40 % / ±2.5 dB: ${directorMatchEqPeakDb(input.matchEqProfile).toFixed(1)} dB`,
      ],
      proposedCorrection: 'Apply 40 % of the 1/3-octave-smoothed reference match curve, limited to ±2.5 dB between 40 Hz and 16 kHz.',
      selectedProcessor: 'match-eq',
      proposedParamsSummary: 'Amount 40 % · Smoothing 1/3 oct · Max ±2.5 dB · 40 Hz-16 kHz · Stereo · Linear phase',
      commands: [matchEqCommand],
      expectedResult: 'Tonal shape moves part of the way toward the reference without copying its loudness or mix decisions.',
      potentialTradeoffs: 'A reference with a different arrangement can pull the wrong way; kept at 40 % with tight limits and re-measured every pass.',
      priority: 'optional',
      statementType: 'hypothesis',
    });
  }

  // Stage 2: Surgical Parametric EQ (weighted by Objective + Reference; skipped on already balanced transparent/dynamic tracks)
  const bands: EQBand[] = [];
  const eqTypeNotes: string[] = [];
  const hasValidReference = isAnalysisMeasurementReliable(referenceAnalysis);
  const referenceMatchBands = hasValidReference
    ? deriveReferenceMatchBands(analysis, referenceAnalysis)
    : [];
  if (referenceMatchBands.length > 0) {
    bands.push(...referenceMatchBands);
  }

  const needsSubHpf =
    analysis.dcOffset >= 0.002 ||
    analysis.zoneEnergyDb.sub - analysis.zoneEnergyDb.bass > 2.5 ||
    objective.id === 'hip-hop' ||
    objective.id === 'electronic' ||
    objective.id === 'commercial-loudness' ||
    measureRumble(analysis).measured;
  if (needsSubHpf) {
    // Flat 12 dB/oct (legacy) for headroom safety; Flat 18/24 dB/oct only for measured rumble.
    const rumble = planRumbleHighPass(analysis, objective, 'b1');
    bands.push(rumble.band);
    eqTypeNotes.push(rumble.summary);
  }

  // Mono bass: Side-channel low cut when the low end is measurably decorrelated.
  const sideLowCut = planSideLowCut(analysis);
  if (sideLowCut) {
    bands.push(sideLowCut.band);
    eqTypeNotes.push(sideLowCut.summary);
  }

  const eqReasons: string[] = [];
  let eqBassGain = 0;
  let eqBassIsTilt = false;
  const eqBassLimit =
    objective.id === 'hip-hop' ||
    objective.id === 'electronic' ||
    objective.id === 'warm' ||
    objective.id === 'cinematic'
      ? 13.5
      : 11.0;
  if (hasValidReference && referenceMatchBands.length === 0) {
    // Compare bass relative to the midrange so a reference's overall mastering level
    // cannot masquerade as a tonal deficit or trigger an unnecessary low-shelf move.
    const referenceBassMidDiff = referenceAnalysis.zoneEnergyDb.bass - referenceAnalysis.zoneEnergyDb.mid;
    const levelMatchedBassDelta = referenceBassMidDiff - bassMidDiff;
    eqBassGain = Number(Math.max(-3.0, Math.min(3.0, levelMatchedBassDelta * 0.45)).toFixed(1));
    eqReasons.push(`Reference-relative Bass/Mid delta: ${levelMatchedBassDelta >= 0 ? '+' : ''}${levelMatchedBassDelta.toFixed(1)} dB (45% weighted, level-matched)`);
  } else if (bassMidDiff > eqBassLimit && (lowMidBuildup > 2.6 || analysis.zoneEnergyDb.sub - analysis.zoneEnergyDb.bass > 4.5)) {
    eqBassGain = Number(Math.max(-3.0, -(bassMidDiff - (eqBassLimit - 1.5)) * 0.55).toFixed(1));
    eqReasons.push(`Bass-to-Mid excess: +${bassMidDiff.toFixed(1)} dB`);
  } else if (bassMidDiff < 2.0 && objective.id !== 'transparent' && objective.id !== 'dynamic' && objective.id !== 'acoustic') {
    eqBassGain = objective.id === 'hip-hop' || objective.id === 'electronic' ? 1.5 : 1.1;
    eqReasons.push(`Lean low-end (Bass-Mid ${bassMidDiff.toFixed(1)} dB)`);
    eqBassIsTilt = true;
  }
  if (Math.abs(eqBassGain) >= 0.3 && referenceMatchBands.length === 0) {
    if (eqBassIsTilt) {
      // A broad lift for a lean low end is a tilt move: Baxandall bass (two half-gain
      // first-order shelves at 88 Hz and 22 Hz) rises gently instead of adding a shelf bump.
      bands.push({ id: 'b2', enabled: true, shape: 'lowshelf', subtype: 'baxandall', freq: 88, gain: eqBassGain, q: 0.71 });
      eqTypeNotes.push(`Baxandall low shelf +${eqBassGain} dB @ 88 Hz (broad tilt for a lean low end)`);
    } else {
      // Corrective / reference-matched shelf: Analog (the legacy RBJ shelf, unchanged).
      bands.push({ id: 'b2', enabled: true, shape: 'lowshelf', freq: 88, gain: eqBassGain, q: 0.71 });
    }
  }

  const mudThresholds = getDiagnosisThresholds(objective, referenceAnalysis);
  const mudRegionDb = computeRegionEnergyDb(analysis, MUD_REGION_HZ[0], MUD_REGION_HZ[1]);
  const mudRegionVsMid = mudRegionDb !== null ? mudRegionDb - analysis.zoneEnergyDb.mid : null;
  const lowMidExcess = Math.max(
    0,
    lowMidBuildup - mudThresholds.lowMidBuildupLimit,
    mudRegionVsMid !== null ? mudRegionVsMid - mudThresholds.region150To400VsMidLimit : 0,
  );
  // Masking that comes and goes with the vocal/snare is handled by a dynamic band;
  // the static bell then only carries a light, constant share of the correction.
  const useDynamicMudControl = lowMidExcess > 0 && objective.id !== 'transparent';
  let mudCut = lowMidBuildup > 3.8 ? Number(Math.max(-3.2, -(lowMidBuildup - 2.6) * 0.6).toFixed(1)) : 0;
  if (useDynamicMudControl) mudCut = Number(Math.max(-1.5, Math.min(mudCut, -0.5)).toFixed(1));
  if (mudCut <= -0.4) {
    // Proportional Q: wide and gentle at a small cut, tighter if refinement deepens it.
    bands.push(mudBell('b3', 300, mudCut));
    eqReasons.push(`Low-mid buildup (+${lowMidBuildup.toFixed(1)} dB) -> ${mudCut} dB @ 300 Hz`);
    eqTypeNotes.push(`Proportional Q bell ${mudCut} dB @ 300 Hz (mud)`);
  }

  let highAirGain = 0;
  let highAirIsTilt = false;
  if (hasValidReference && referenceMatchBands.length === 0) {
    // Match air relative to the midrange, not absolute dBFS. This preserves real
    // brightness differences while cancelling a uniform reference level offset.
    const referenceAirMidDiff = referenceAnalysis.zoneEnergyDb.air - referenceAnalysis.zoneEnergyDb.mid;
    const sourceAirMidDiff = analysis.zoneEnergyDb.air - analysis.zoneEnergyDb.mid;
    const levelMatchedAirDelta = referenceAirMidDiff - sourceAirMidDiff;
    highAirGain = Number(Math.max(-2.5, Math.min(3.0, levelMatchedAirDelta * 0.4)).toFixed(1));
  } else if (objective.tonalBias === 'bright' && analysis.spectralSlopeDbPerOct < -1.1) {
    highAirGain = analysis.spectralSlopeDbPerOct < -2.2 ? 1.8 : 0.9;
    highAirIsTilt = true;
  } else if (objective.tonalBias === 'warm') {
    highAirGain = harshExcess > 1.5 ? -0.8 : 0;
  } else if (analysis.spectralSlopeDbPerOct < -3.8) {
    highAirGain = 1.1;
    highAirIsTilt = true;
  }
  if (Math.abs(highAirGain) >= 0.3 && referenceMatchBands.length === 0) {
    if (highAirIsTilt) {
      // Measured dark spectral slope: a Baxandall treble shelf keeps rising into the top
      // octave like a tone control, rather than a shelf plateau at 11.2 kHz.
      bands.push({ id: 'b4', enabled: true, shape: 'highshelf', subtype: 'baxandall', freq: 8000, gain: highAirGain, q: 0.71 });
      eqTypeNotes.push(`Baxandall high shelf ${highAirGain > 0 ? '+' : ''}${highAirGain} dB @ 8 kHz (slope ${analysis.spectralSlopeDbPerOct.toFixed(2)} dB/oct)`);
    } else {
      bands.push({ id: 'b4', enabled: true, shape: 'highshelf', freq: 11200, gain: highAirGain, q: 0.71 });
    }
    eqReasons.push(`Tilt (${analysis.spectralSlopeDbPerOct.toFixed(2)} dB/oct) + ${objective.tonalBias} bias -> ${highAirGain > 0 ? '+' : ''}${highAirGain} dB @ 11.2 kHz`);
  }

  const tiltDb = objective.tonalBias === 'warm' && objective.id !== 'acoustic' ? -0.4 : objective.tonalBias === 'bright' && eqReasons.length > 0 ? 0.4 : 0;
  if (bands.length > 0 || Math.abs(tiltDb) >= 0.2) {
    const eqParams = {
      phaseMode:
        objective.id === 'transparent' || objective.id === 'dynamic' || objective.id === 'acoustic'
          ? ('linear' as const)
          : ('minimum' as const),
      msMode: 'stereo' as const,
      tiltDb,
      bands: bands.length > 0 ? bands : [{ id: 'b1', enabled: true, shape: 'highpass' as const, freq: 24, gain: 0, q: 0.71 }],
    };
    recommendations.push({
      id: 'rec-eq',
      characteristic:
        eqReasons.length > 0
          ? 'Spectral contour calibration'
          : 'Subsonic headroom protection',
      supportingMeasurements: [
        `Slope: ${analysis.spectralSlopeDbPerOct.toFixed(2)} dB/oct`,
        `Centroid: ${analysis.spectralCentroidHz} Hz`,
        `Low-Mid/Mid: ${lowMidBuildup >= 0 ? '+' : ''}${lowMidBuildup.toFixed(1)} dB`,
        ...(eqReasons.length ? [eqReasons[0]] : []),
        ...(sideLowCut ? [`Low-End Corr: ${analysis.lowEndCorrelation.toFixed(2)}`] : []),
      ],
      proposedCorrection:
        eqParams.bands.length > 1
          ? 'Shape tonal contour surgically while clearing subsonic rumble below 28 Hz.'
          : 'Insert linear/clean high-pass at 24–28 Hz without altering musical midrange timbre.',
      selectedProcessor: 'parametric-eq',
      proposedParamsSummary: `${eqParams.phaseMode.toUpperCase()} phase · Tilt ${tiltDb >= 0 ? '+' : ''}${tiltDb} dB · ${eqParams.bands.length} band(s)${eqTypeNotes.length ? ` · ${eqTypeNotes.join(' · ')}` : ''}`,
      commands: [
        {
          op: 'add',
          processorType: 'parametric-eq',
          name: 'Master Contour EQ',
          params: eqParams,
          rationale: 'Calibrate subsonic headroom and broad tonal balance from measured spectral zones.',
        },
      ],
      expectedResult: 'Improved midrange articulation and subsonic headroom stability ahead of limiting.',
      potentialTradeoffs: 'Excessive cuts (>3 dB) can hollow out body; kept surgical.',
      priority: lowMidBuildup > 4.5 || bassMidDiff > 11 ? 'critical' : 'recommended',
      statementType: 'hypothesis',
    });
  }

  // Stage 3a: Dynamic low-mid masking control (150-400 Hz builds up under vocal and snare)
  if (useDynamicMudControl) {
    const mudMaxCut = Number(Math.max(-3.0, -Math.min(3.0, 1.0 + lowMidExcess * 0.4)).toFixed(1));
    const mudBands = [
      {
        id: 'd-mud',
        enabled: true,
        freq: 250,
        q: 1.0,
        thresholdDb: Math.round(Math.max(-40, Math.min(-16, analysis.rmsDb - 4))),
        maxCutDb: mudMaxCut,
        attackMs: 15,
        releaseMs: 140,
        // Proportional Q: light dips stay broad, the band narrows as it digs deeper.
        type: 'proportional' as const,
        kneeDb: 6,
      },
    ];
    recommendations.push({
      id: 'rec-dyn-mud',
      characteristic: 'Dynamic low-mid masking (150-400 Hz vs vocal/snare midrange)',
      supportingMeasurements: [
        `Low-Mid vs Mid: ${lowMidBuildup >= 0 ? '+' : ''}${lowMidBuildup.toFixed(1)} dB (limit +${mudThresholds.lowMidBuildupLimit.toFixed(1)} dB)`,
        ...(mudRegionVsMid !== null
          ? [`${MUD_REGION_HZ[0]}-${MUD_REGION_HZ[1]} Hz vs Mid: ${mudRegionVsMid >= 0 ? '+' : ''}${mudRegionVsMid.toFixed(1)} dB (limit +${mudThresholds.region150To400VsMidLimit.toFixed(1)} dB)`]
          : []),
      ],
      proposedCorrection: `Attenuate 250 Hz dynamically (up to ${mudMaxCut} dB) only when the low-mids build up.`,
      selectedProcessor: 'dynamic-eq',
      proposedParamsSummary: `Proportional Q band @ 250 Hz (Q=1.0, maxCut=${mudMaxCut} dB, 15/140 ms, 6 dB knee)`,
      commands: [
        {
          op: 'add',
          processorType: 'dynamic-eq',
          name: 'Dynamic Low-Mid Control',
          params: { bands: mudBands },
          rationale: 'Clear low-mid masking under vocals and snare without thinning quiet passages.',
        },
      ],
      expectedResult: 'Lower 150-400 Hz masking during dense sections while keeping body in sparse sections.',
      potentialTradeoffs: 'Too much cut can thin vocal body and snare weight; capped at -3 dB.',
      priority: lowMidExcess > 2 ? 'critical' : 'recommended',
      statementType: 'hypothesis',
    });
  }

  // Stage 3: Dynamic EQ is reserved for a measured isolated upper-mid resonance.
  // Broad high-mid energy and coherent musical harmonics are not enough evidence to
  // trigger frequency-selective gain reduction; those are handled by the tonal plan
  // and auditioned rather than automatically treated as defects.
  if (topRes && dynamicHighPlan) {
    const targetFreq = topRes.freqHz;
    const dynBands = [dynamicHighPlan.band];
    const sibilance = dynamicHighPlan.kind === 'sibilance';
    recommendations.push({
      id: 'rec-dyn-eq',
      characteristic: sibilance
        ? 'Sibilance: isolated resonance in the 4.5-10 kHz de-essing range'
        : 'Dynamic upper-mid harshness / localized resonance spike',
      supportingMeasurements: [
        `High-Mid vs Mid: ${harshExcess >= 0 ? '+' : ''}${harshExcess.toFixed(1)} dB`,
        ...dynamicHighPlan.evidence,
      ],
      proposedCorrection: sibilance
        ? `De-ess dynamically: a high shelf keyed at ${targetFreq} Hz dips only while sibilants exceed threshold.`
        : `Attenuate ${targetFreq} Hz dynamically only when transient peaks exceed threshold.`,
      selectedProcessor: 'dynamic-eq',
      proposedParamsSummary: dynamicHighPlan.summary,
      commands: [
        {
          op: 'add',
          processorType: 'dynamic-eq',
          name: sibilance ? 'Dynamic De-Esser' : 'Dynamic Resonance Control',
          params: { bands: dynBands },
          rationale: sibilance
            ? `Tame sibilance keyed at ${targetFreq} Hz without dulling the top end between sibilants.`
            : `Tame ${targetFreq} Hz spikes dynamically without dulling quiet passages.`,
        },
      ],
      expectedResult: 'Reduces listener fatigue while preserving average spectral brightness.',
      potentialTradeoffs: sibilance
        ? 'Too low a threshold can lisp vocals or soften hi-hats; capped and soft-kneed.'
        : 'Over-taming above 3 kHz can soften snare crack or vocal bite.',
      priority: 'recommended',
      statementType: 'hypothesis',
    });
  }

  // Stage 4: Bus Glue Compression (skip or use super gentle ratio if source DR < 6 dB or transparent mode)
  const needsGlue =
    analysis.dynamicRangeDb > 6.5 &&
    (objective.id !== 'transparent' || analysis.crestFactorDb > 13.5);
  if (needsGlue) {
    const compParams = {
      mode: objective.id === 'punchy' ? ('parallel' as const) : ('downward' as const),
      thresholdDb: Number(Math.max(-24, Math.min(-10, analysis.rmsDb + (objective.id === 'punchy' ? 4.0 : 3.0))).toFixed(1)),
      ratio: objective.id === 'transparent' ? 1.5 : objective.id === 'punchy' ? 2.5 : objective.id === 'warm' ? 1.9 : 2.0,
      attackMs: objective.preserveTransients ? 28 : 14,
      releaseMs: objective.id === 'warm' ? 190 : 120,
      kneeDb: objective.id === 'warm' ? 7 : 4,
      makeupDb: 0.6,
      scHpfHz: 85,
    };
    recommendations.push({
      id: 'rec-comp',
      characteristic: `Crest factor ${analysis.crestFactorDb.toFixed(1)} dB & DR ${analysis.dynamicRangeDb.toFixed(1)} dB`,
      supportingMeasurements: [
        `Dynamic Range: ${analysis.dynamicRangeDb.toFixed(1)} dB`,
        `Crest Factor: ${analysis.crestFactorDb.toFixed(1)} dB`,
        `Transient Density: ${(analysis.transientDensity * 100).toFixed(0)}%`,
      ],
      proposedCorrection: 'Apply gentle bus compression with 85 Hz sidechain HPF and slow attack to preserve kick/snare punch.',
      selectedProcessor: 'compressor',
      proposedParamsSummary: `${compParams.mode.toUpperCase()} · ${compParams.ratio}:1 @ ${compParams.thresholdDb} dB · Atk ${compParams.attackMs} ms`,
      commands: [
        {
          op: 'add',
          processorType: 'compressor',
          name: objective.id === 'warm' ? 'Optical Bus Glue' : 'Transient-Safe Bus Comp',
          wetDry: objective.id === 'punchy' ? 80 : 100,
          params: compParams,
          rationale: 'Cohesive bus glue and peak density smoothing ahead of final limiting.',
        },
      ],
      expectedResult: 'Steadier RMS density and ~1–2 dB peak headroom recovery for cleaner limiting.',
      potentialTradeoffs: 'Too fast an attack or low threshold will flatten drum transients; monitored in QC.',
      priority: 'recommended',
      statementType: 'hypothesis',
    });
  }

  // Stage 5: Harmonic Saturation ONLY when objective calls for warmth/punch AND source THD is clean
  if (
    objective.saturationAllowance !== 'none' &&
    objective.saturationAllowance !== 'subtle' &&
    analysis.thdEstimatePercent < 1.8
  ) {
    const satParams = {
      flavor: objective.id === 'warm' ? ('tube' as const) : ('tape' as const),
      drive: objective.id === 'warm' ? 28 : 20,
      tone: objective.id === 'warm' ? -14 : 6,
      harmonics: objective.id === 'warm' ? ('even' as const) : ('balanced' as const),
      oversampling: 2 as const,
    };
    recommendations.push({
      id: 'rec-saturation',
      characteristic:
        objective.id === 'warm'
          ? 'Clean source THD supports analog harmonic enrichment'
          : 'Commercial loudness objective benefits from soft tape crest rounding',
      supportingMeasurements: [
        `Pre THD: ${analysis.thdEstimatePercent.toFixed(2)}%`,
        `Objective: ${objective.label}`,
      ],
      proposedCorrection: `Insert ${satParams.flavor} saturation stage (${satParams.harmonics} harmonics, 2x oversampling).`,
      selectedProcessor: 'saturation',
      proposedParamsSummary: `${satParams.flavor.toUpperCase()} · Drive ${satParams.drive}% · Tone ${satParams.tone} · ${satParams.harmonics}`,
      commands: [
        {
          op: 'add',
          processorType: 'saturation',
          name: objective.id === 'warm' ? 'Analog Tube Stage' : 'Tape Crest Glue',
          params: satParams,
          rationale: 'Round micro-peaks harmonically before brickwall limiting.',
        },
      ],
      expectedResult: 'Adds perceived density and analog warmth with minimal inter-sample overshoot.',
      potentialTradeoffs: 'Adds measurable THD (+0.3% to +1.0%); rolled back if distortion threshold is exceeded.',
      priority: 'optional',
      statementType: 'hypothesis',
    });
  }

  // Stage 6: Stereo Imager when phase/low-end correlation, L/R skew, or width preference calls for intervention
  const needsStereoFix =
    analysis.lowEndCorrelation < 0.72 ||
    analysis.phaseCorrelation < 0.25 ||
    Math.abs(analysis.lrBalanceDb) > 0.6 ||
    objective.stereoPreference !== 'preserve';
  if (needsStereoFix) {
    const midWidth =
      objective.stereoPreference === 'narrow'
        ? 90
        : objective.stereoPreference === 'wide' && analysis.phaseCorrelation > 0.35
          ? 114
          : analysis.stereoWidth < 0.55
            ? 112
            : 100;
    const highWidth =
      objective.stereoPreference === 'narrow'
        ? 95
        : objective.stereoPreference === 'wide' && analysis.phaseCorrelation > 0.3
          ? 124
          : analysis.stereoWidth < 0.6
            ? 120
            : 105;
    const imgParams = {
      lowWidth: analysis.lowEndCorrelation < 0.65 ? 55 : 82,
      midWidth,
      highWidth,
      lowCrossHz: 150,
      highCrossHz: 3500,
      // The EQ's Side-channel low cut already makes the low end mono; do not stack a second
      // mono-bass crossover on top of it.
      monoBassBelowHz: sideLowCut ? 0 : analysis.lowEndCorrelation < 0.5 ? 115 : 90,
      lrBalanceDb: Number((-analysis.lrBalanceDb * 0.75).toFixed(2)),
      midSideGainDb: objective.stereoPreference === 'wide' && analysis.phaseCorrelation > 0.4 ? 0.3 : 0,
    };
    recommendations.push({
      id: 'rec-imager',
      characteristic:
        analysis.lowEndCorrelation < 0.72 || Math.abs(analysis.lrBalanceDb) > 0.6
          ? 'Low-end phase focus & L/R stereo alignment'
          : `Stereo width optimization (${objective.stereoPreference})`,
      supportingMeasurements: [
        `Phase Corr: ${analysis.phaseCorrelation.toFixed(2)}`,
        `Low-End Corr: ${analysis.lowEndCorrelation.toFixed(2)}`,
        `L/R Balance: ${analysis.lrBalanceDb.toFixed(2)} dB`,
      ],
      proposedCorrection: sideLowCut
        ? 'Narrow the low band and correct L/R balance; mono bass comes from the EQ Side-channel low cut.'
        : 'Anchor sub-bass in mono and correct L/R balance bias cleanly.',
      selectedProcessor: 'stereo-imager',
      proposedParamsSummary: `${imgParams.monoBassBelowHz > 0 ? `MonoBass <${imgParams.monoBassBelowHz}Hz` : 'MonoBass via EQ Side low cut'} · L/R ${imgParams.lrBalanceDb >= 0 ? '+' : ''}${imgParams.lrBalanceDb} dB · Mid ${midWidth}% / High ${highWidth}%`,
      commands: [
        {
          op: 'add',
          processorType: 'stereo-imager',
          name: 'Master Stereo Focus',
          params: imgParams,
          rationale: 'Secure mono club compatibility below 100 Hz and center stereo balance.',
        },
      ],
      expectedResult: 'Higher low-end mono correlation and centered stereo image.',
      potentialTradeoffs: 'Excessive side widening can hollow out vocal center; kept conservative.',
      priority: analysis.lowEndCorrelation < 0.4 || Math.abs(analysis.lrBalanceDb) > 1.2 ? 'critical' : 'recommended',
      statementType: 'hypothesis',
    });
  }

  // Stage 7: Real Connected VST3 Plugin Integration (ONLY if genuinely connected + compatible)
  const usableVst3 = pluginSummary.matches.find((m) => m.available && m.recommendedParams.length > 0);
  if (usableVst3 && input.externalPlugins) {
    const recRecord = input.externalPlugins.find((p) => p.uid === usableVst3.uid);
    if (recRecord) {
      recommendations.push({
        id: `rec-vst3-${usableVst3.uid}`,
        characteristic: `Connected external VST3 capability: ${usableVst3.name} (${usableVst3.role})`,
        supportingMeasurements: usableVst3.recommendedParams.map(
          (rp) => `${rp.paramName} -> ${(rp.normalizedValue * 100).toFixed(0)}% (${rp.rationale})`,
        ),
        proposedCorrection: `Include verified host VST3 "${usableVst3.name}" only if user inserts/loads native worker instance in rack.`,
        selectedProcessor: 'external-vst3',
        pluginName: usableVst3.name,
        proposedParamsSummary: usableVst3.recommendedParams
          .map((p) => `${p.paramName}=${p.normalizedValue.toFixed(2)}`)
          .join(' · '),
        commands: [], // Do not auto-spawn unloaded native process handles inside autonomous offline loop unless already active
        expectedResult: 'Integrates hardware-accurate third-party processing when native worker instance is active.',
        potentialTradeoffs: `Adds ${recRecord.latencySamples} samples latency and requires Windows host worker.`,
        priority: 'optional',
        statementType: 'hypothesis',
      });
    }
  }

  // Stage 8: Final True-Peak Maximizer / Safety Limiter (ALWAYS present as final ceiling safeguard)
  const maxParams = {
    character:
      objective.id === 'punchy'
        ? ('punchy' as const)
        : objective.id === 'warm'
          ? ('smooth' as const)
          : ('transparent' as const),
    targetLufs: objective.targetLufs,
    ceilingDb: objective.maxTruePeakDb,
    transientEmphasis: objective.preserveTransients ? (objective.id === 'punchy' ? 45 : 30) : 10,
    truePeak: true,
  };
  recommendations.push({
    id: 'rec-maximizer',
    characteristic: `Loudness calibration (${analysis.integratedLufs.toFixed(1)} -> ${objective.targetLufs.toFixed(1)} LUFS) & True Peak ceiling protection`,
    supportingMeasurements: [
      `Pre LUFS: ${analysis.integratedLufs.toFixed(1)} LUFS`,
      `Pre True Peak: ${analysis.truePeakDb.toFixed(2)} dBTP`,
      `Target: ${objective.targetLufs.toFixed(1)} LUFS / <= ${objective.maxTruePeakDb.toFixed(1)} dBTP`,
    ],
    proposedCorrection: 'Engage True-Peak calibrated Maximizer with transient emphasis to hit target loudness cleanly.',
    selectedProcessor: 'maximizer',
    proposedParamsSummary: `${maxParams.character.toUpperCase()} · Target ${maxParams.targetLufs} LUFS · Ceiling ${maxParams.ceilingDb} dBTP · Transients ${maxParams.transientEmphasis}%`,
    commands: [
      {
        op: 'add',
        processorType: 'maximizer',
        name: 'True-Peak Master Finalizer',
        params: maxParams,
        rationale: 'Calibrate final integrated loudness and enforce strict True-Peak headroom.',
      },
    ],
    expectedResult: `Integrated loudness converges near ${objective.targetLufs.toFixed(1)} LUFS with <= ${objective.maxTruePeakDb.toFixed(1)} dBTP ceiling.`,
    potentialTradeoffs:
      objective.targetLufs - analysis.integratedLufs > 6
        ? 'Large gain push (>6 LU) narrows dynamic range; monitored across refinement passes.'
        : 'Minimal dynamic range impact within target margin.',
    priority: 'critical',
    statementType: 'hypothesis',
  });

  // Execute structured commands on empty chain to build validated initial chain
  const initialCommands = recommendations.flatMap((r) => r.commands);
  const { chain } = applyStructuredChainCommands([], initialCommands);

  const strategy: AIMasteringStrategy = {
    id: `dir-strat-${Date.now()}`,
    timestamp: Date.now(),
    source: 'algorithmic',
    genre: diagnosis.artisticProfile,
    musicalStyle: `${objective.label} Objective`,
    instrumentationSummary: `Centroid ${analysis.spectralCentroidHz} Hz · Transient ${(analysis.transientDensity * 100).toFixed(0)}% · DR ${analysis.dynamicRangeDb.toFixed(1)} dB`,
    vocalPresence: input.stemAnalysis?.stems.some((stem) => stem.role === 'vocals')
      ? 'Separated vocal stem supplied; balance requires vocal/reference measurements'
      : 'Unverified; no separated vocal stem measurement',
    tonalCharacteristics: `Slope ${analysis.spectralSlopeDbPerOct.toFixed(2)} dB/oct · Width ${(analysis.stereoWidth * 100).toFixed(0)}% · Noise ${nf.toFixed(1)} dBFS`,
    issuesDetected: diagnosis.findings
      .filter((f) => f.kind === 'technical-problem')
      .map((f) => `${f.title}: ${f.evidence[0] ?? ''}`),
    strategySummary: `Constructed ${chain.length}-stage chain for ${objective.label} objective (${objective.targetLufs.toFixed(1)} LUFS / <= ${objective.maxTruePeakDb.toFixed(1)} dBTP).`,
    targetLufs: objective.targetLufs,
    targetTruePeakDb: objective.maxTruePeakDb,
    reasoningPerProcessor: recommendations
      .filter((r) => r.commands.length > 0)
      .map((r) => ({
        processorType: r.selectedProcessor,
        reason: `${r.characteristic} -> ${r.proposedCorrection} (Tradeoff: ${r.potentialTradeoffs})`,
      })),
    chain,
  };

  return {
    objective,
    diagnosis,
    pluginSummary,
    recommendations,
    chain,
    strategy,
  };
}

/**
 * Evaluates 11 independent technical mastering objectives separately.
 * Never reduces subjective musicality to an opaque score; labels convergence explicitly as telemetry alignment.
 */
export function evaluateMultiObjectiveMetrics(
  pre: AudioAnalysis,
  post: AudioAnalysis,
  objective: ResolvedObjectiveTarget,
  qcReport: QCReport,
  reference?: AudioAnalysis | null,
): MultiObjectiveEvaluation {
  const dimensions: MultiObjectiveDimension[] = [];
  const limitingFactors: string[] = [];

  // 1. Loudness Compliance
  const lufsErr = Math.abs(post.integratedLufs - objective.targetLufs);
  const loudnessScore = Math.max(0, Math.min(100, Math.round(100 - lufsErr * 14)));
  dimensions.push({
    key: 'loudness',
    label: 'Loudness Target',
    status: lufsErr <= 0.8 ? 'optimal' : lufsErr <= objective.lufsTolerance ? 'acceptable' : lufsErr <= 3.0 ? 'attention' : 'critical',
    score: loudnessScore,
    measuredSummary: `${post.integratedLufs.toFixed(1)} LUFS`,
    targetSummary: `${objective.targetLufs.toFixed(1)} ± ${objective.lufsTolerance.toFixed(1)} LUFS`,
    note: lufsErr <= 0.8 ? 'Calibrated on target.' : `Offset of ${(post.integratedLufs - objective.targetLufs).toFixed(1)} LU.`,
  });
  if (lufsErr > objective.lufsTolerance) limitingFactors.push(`Loudness off target by ${(post.integratedLufs - objective.targetLufs).toFixed(1)} LU`);

  // 2. True Peak Safety
  const tpOver = Math.max(0, post.truePeakDb - objective.maxTruePeakDb);
  const tpScore = post.truePeakDb <= objective.maxTruePeakDb + 0.05 ? 100 : Math.max(0, Math.round(100 - tpOver * 45));
  dimensions.push({
    key: 'truePeakSafety',
    label: 'True Peak Safety',
    status: post.truePeakDb <= objective.maxTruePeakDb + 0.05 ? 'optimal' : post.truePeakDb <= 0 ? 'attention' : 'critical',
    score: tpScore,
    measuredSummary: `${post.truePeakDb.toFixed(2)} dBTP`,
    targetSummary: `<= ${objective.maxTruePeakDb.toFixed(1)} dBTP`,
    note: tpOver > 0 ? `Exceeds ceiling by ${tpOver.toFixed(2)} dB.` : 'Inter-sample headroom protected.',
  });
  if (tpOver > 0.05) limitingFactors.push(`True Peak exceeds ${objective.maxTruePeakDb.toFixed(1)} dBTP`);

  // 3. Dynamic Integrity
  const drShortfall = Math.max(0, objective.minDynamicRangeDb - post.dynamicRangeDb);
  const drLoss = Math.max(0, pre.dynamicRangeDb - post.dynamicRangeDb);
  const dynScore = Math.max(0, Math.min(100, Math.round(100 - drShortfall * 18 - Math.max(0, drLoss - 3.5) * 10)));
  dimensions.push({
    key: 'dynamicIntegrity',
    label: 'Dynamic Integrity',
    status: drShortfall === 0 && drLoss <= 3.5 ? 'optimal' : drShortfall <= 1.2 ? 'acceptable' : drShortfall <= 2.5 ? 'attention' : 'critical',
    score: dynScore,
    measuredSummary: `${post.dynamicRangeDb.toFixed(1)} dB DR (Δ ${(post.dynamicRangeDb - pre.dynamicRangeDb).toFixed(1)})`,
    targetSummary: `>= ${objective.minDynamicRangeDb.toFixed(1)} dB DR`,
    note: drShortfall > 0 ? 'Compression/limiting compressing dynamic range below target.' : 'Macro-dynamics preserved.',
  });
  if (drShortfall > 0.5) limitingFactors.push(`Dynamic Range below ${objective.minDynamicRangeDb.toFixed(1)} dB`);

  // 4. Transient Preservation
  const crestDrop = Math.max(0, pre.crestFactorDb - post.crestFactorDb);
  const transientRatio = pre.transientDensity > 0.05 ? post.transientDensity / pre.transientDensity : 1;
  const transScore = Math.max(0, Math.min(100, Math.round(100 - Math.max(0, crestDrop - 3.5) * 11 - Math.max(0, (1 - transientRatio) * 40))));
  dimensions.push({
    key: 'transientPreservation',
    label: 'Transient Preservation',
    status: transScore >= 85 ? 'optimal' : transScore >= 70 ? 'acceptable' : transScore >= 50 ? 'attention' : 'critical',
    score: transScore,
    measuredSummary: `Crest ${post.crestFactorDb.toFixed(1)} dB · Density ${(post.transientDensity * 100).toFixed(0)}%`,
    targetSummary: objective.preserveTransients ? 'Preserve percussive attack' : 'Controlled density',
    note: crestDrop > 4.0 ? `Crest dropped by ${crestDrop.toFixed(1)} dB.` : 'Transient punch intact.',
  });

  // 5. Tonal Balance
  const bassMid = post.zoneEnergyDb.bass - post.zoneEnergyDb.mid;
  const highMidExcess = post.zoneEnergyDb.highMid - post.zoneEnergyDb.mid;
  const mudPenalty = Math.max(0, bassMid - 10) * 6 + Math.max(0, (post.zoneEnergyDb.lowMid - post.zoneEnergyDb.mid) - 4) * 7;
  const harshPenalty = Math.max(0, highMidExcess - 3.5) * 9;
  const tonalScore = Math.max(0, Math.min(100, Math.round(100 - mudPenalty - harshPenalty)));
  dimensions.push({
    key: 'tonalBalance',
    label: 'Tonal Balance',
    status: tonalScore >= 85 ? 'optimal' : tonalScore >= 70 ? 'acceptable' : 'attention',
    score: tonalScore,
    measuredSummary: `Slope ${post.spectralSlopeDbPerOct.toFixed(2)} dB/oct · Centroid ${post.spectralCentroidHz} Hz`,
    targetSummary: `${objective.tonalBias} tonal profile`,
    note: mudPenalty > 6 ? 'Elevated low-mid density.' : harshPenalty > 6 ? 'Upper-mid presence spike.' : 'Spectral distribution smooth.',
  });

  // 6. Stereo Integrity
  const lrPen = Math.max(0, Math.abs(post.lrBalanceDb) - 0.5) * 20;
  const phasePen =
    Math.max(0, 0.3 - post.phaseCorrelation) * 65 +
    Math.max(0, 0.45 - post.lowEndCorrelation) * 45;
  const bandPhase = post.stereoBandCorrelation;
  const bandPhasePen = bandPhase
    ? Math.max(0, 0.45 - bandPhase.low) * 25 +
      Math.max(0, 0.15 - bandPhase.mid) * 25 +
      Math.max(0, 0.15 - bandPhase.high) * 25
    : 0;
  const stereoScore = Math.max(0, Math.min(100, Math.round(100 - lrPen - phasePen - bandPhasePen)));
  dimensions.push({
    key: 'stereoIntegrity',
    label: 'Stereo & Phase Integrity',
    status: stereoScore >= 85 ? 'optimal' : stereoScore >= 70 ? 'acceptable' : stereoScore >= 50 ? 'attention' : 'critical',
    score: stereoScore,
    measuredSummary: `Corr ${post.phaseCorrelation.toFixed(2)} · Low ${post.lowEndCorrelation.toFixed(2)} · Bands L/M/H ${bandPhase ? `${bandPhase.low.toFixed(2)}/${bandPhase.mid.toFixed(2)}/${bandPhase.high.toFixed(2)}` : 'n/a'} · L/R ${post.lrBalanceDb.toFixed(2)} dB`,
    targetSummary: 'Mono-safe bass · Coherent frequency bands · Centered L/R',
    note: bandPhase && (bandPhase.low < 0.45 || bandPhase.mid < 0.15 || bandPhase.high < 0.15)
      ? 'Frequency-localized mono cancellation risk; audition affected band-limited fold-down.'
      : stereoScore < 75
        ? 'Check low-end mono focus or L/R balance.'
        : 'Coherent stereo field across measured bands.',
  });
  if (
    post.lowEndCorrelation < 0.35 ||
    post.phaseCorrelation < 0.1 ||
    (bandPhase && (bandPhase.low < 0.45 || bandPhase.mid < 0.15 || bandPhase.high < 0.15))
  ) {
    limitingFactors.push('Phase / frequency-band mono compatibility below safe threshold');
  }

  // 7. Distortion Control
  const thdDelta = Math.max(0, post.thdEstimatePercent - pre.thdEstimatePercent);
  const maxAllowedThd = objective.saturationAllowance === 'rich' ? 2.5 : objective.saturationAllowance === 'moderate' ? 1.8 : 1.0;
  const distScore = Math.max(0, Math.min(100, Math.round(100 - Math.max(0, post.thdEstimatePercent - maxAllowedThd) * 22 - Math.max(0, thdDelta - 1.5) * 15)));
  dimensions.push({
    key: 'distortion',
    label: 'Harmonic Distortion',
    status: distScore >= 85 ? 'optimal' : distScore >= 70 ? 'acceptable' : distScore >= 50 ? 'attention' : 'critical',
    score: distScore,
    measuredSummary: `${post.thdEstimatePercent.toFixed(2)}% THD`,
    targetSummary: `<= ${maxAllowedThd.toFixed(1)}% THD`,
    note: distScore < 75 ? 'Harmonic breakup above allowance.' : 'Harmonic ceiling clean.',
  });

  // 8. Noise Floor
  // Normalize the measured noise floor to the selected delivery loudness. Uniform
  // attenuation then leaves this dimension unchanged instead of masquerading as denoising.
  const nf = post.noiseFloorDb ?? -72;
  const preNf = pre.noiseFloorDb ?? -72;
  const nfHasMargin = post.rmsDb - nf >= 12;
  const noiseFloorAtTargetLufs = nf + (objective.targetLufs - post.integratedLufs);
  const preNoiseFloorAtTargetLufs = preNf + (objective.targetLufs - pre.integratedLufs);
  const levelMatchedNoiseReductionDb = preNoiseFloorAtTargetLufs - noiseFloorAtTargetLufs;
  const snrGainDb = (post.rmsDb - nf) - (pre.rmsDb - preNf);
  const noiseScore = !nfHasMargin
    ? 70
    : noiseFloorAtTargetLufs <= -58
      ? 100
      : Math.max(0, Math.round(100 - (noiseFloorAtTargetLufs + 58) * 3.5));
  dimensions.push({
    key: 'noise',
    label: 'Noise Floor',
    status: !nfHasMargin
      ? 'attention'
      : noiseFloorAtTargetLufs <= -52
        ? 'optimal'
        : noiseFloorAtTargetLufs <= -44
          ? 'acceptable'
          : 'attention',
    score: noiseScore,
    measuredSummary: nfHasMargin
      ? `${nf.toFixed(1)} dBFS raw · ${noiseFloorAtTargetLufs.toFixed(1)} dBFS at target loudness · NF Δ ${levelMatchedNoiseReductionDb >= 0 ? '+' : ''}${levelMatchedNoiseReductionDb.toFixed(1)} dB · SNR Δ ${snrGainDb >= 0 ? '+' : ''}${snrGainDb.toFixed(1)} dB`
      : 'Continuous program · no reliable quiet-passage noise margin',
    targetSummary: '<= -52.0 dBFS normalized to delivery LUFS',
    note: !nfHasMargin
      ? 'Noise floor is unverified because the recording has no sufficiently quiet passage for an independent estimate.'
      : noiseFloorAtTargetLufs > -48
        ? 'Elevated level-matched quiet-passage noise floor.'
        : 'Level-matched noise floor is controlled.',
  });
  if (!nfHasMargin) {
    limitingFactors.push('Noise floor cannot be independently verified from the available quiet passages');
  } else if (noiseFloorAtTargetLufs > -48) {
    limitingFactors.push('Level-matched quiet-passage noise floor remains elevated');
  }

  // 9. Clipping Prevention
  const clipScore = post.clippedSamples === 0 && post.interSamplePeaks === 0 ? 100 : Math.max(0, 100 - post.clippedSamples * 5 - post.interSamplePeaks * 3);
  dimensions.push({
    key: 'clipping',
    label: 'Clipping Prevention',
    status: post.clippedSamples === 0 && post.interSamplePeaks === 0 ? 'optimal' : post.clippedSamples === 0 ? 'attention' : 'critical',
    score: clipScore,
    measuredSummary: `${post.clippedSamples} clipped · ${post.interSamplePeaks} ISP`,
    targetSummary: '0 clipped · 0 ISP',
    note: clipScore === 100 ? 'Zero clipping or inter-sample overs.' : 'Reduce output ceiling / drive.',
  });
  if (post.clippedSamples > 0) limitingFactors.push(`${post.clippedSamples} clipped sample(s) detected`);

  // 10. Processing Restraint / Transparency (guards against over-processing)
  const slopeShift = Math.abs(post.spectralSlopeDbPerOct - pre.spectralSlopeDbPerOct);
  const transpScore = Math.max(0, Math.min(100, Math.round(100 - Math.max(0, slopeShift - 1.2) * 18 - Math.max(0, crestDrop - 4.0) * 8)));
  dimensions.push({
    key: 'musicalTransparency',
    label: 'Processing Restraint',
    status: transpScore >= 82 ? 'optimal' : transpScore >= 65 ? 'acceptable' : 'attention',
    score: transpScore,
    measuredSummary: `Spectral Shift ${slopeShift.toFixed(2)} dB/oct · Crest Δ -${crestDrop.toFixed(1)} dB`,
    targetSummary: objective.id === 'transparent' ? 'Minimal sonic footprint' : 'Controlled transformation',
    note: 'Measures technical restraint vs source; subjective musicality still requires human ear verification.',
  });

  // 11. Reference Similarity (optional)
  if (reference) {
    // Loudness delivery is already scored against the selected objective above.
    // A reference's playback/mastering gain must not also penalize tonal/stereo similarity.
    const refSlopeErr = Math.abs(post.spectralSlopeDbPerOct - reference.spectralSlopeDbPerOct);
    const refWidthErr = Math.abs(post.stereoWidth - reference.stereoWidth) * 100;
    const refScore = Math.max(0, Math.min(100, Math.round(100 - refSlopeErr * 12 - refWidthErr * 0.4)));
    dimensions.push({
      key: 'referenceSimilarity',
      label: 'Reference Alignment',
      status: refScore >= 80 ? 'optimal' : refScore >= 65 ? 'acceptable' : 'attention',
      score: refScore,
      measuredSummary: `LUFS Δ ${(post.integratedLufs - reference.integratedLufs).toFixed(1)} (informational) · Slope Δ ${(post.spectralSlopeDbPerOct - reference.spectralSlopeDbPerOct).toFixed(2)} · Width Δ ${((post.stereoWidth - reference.stereoWidth) * 100).toFixed(0)}%`,
      targetSummary: `Slope ${reference.spectralSlopeDbPerOct.toFixed(2)} dB/oct · Width ${(reference.stereoWidth * 100).toFixed(0)}%`,
      note: 'Level-neutral tonal/stereo comparison. LUFS difference is reported for context; delivery loudness is scored separately against the selected objective.',
    });
  } else {
    dimensions.push({
      key: 'referenceSimilarity',
      label: 'Reference Alignment',
      status: 'not-applicable',
      score: 100,
      measuredSummary: 'No reference loaded',
      targetSummary: 'Optional',
      note: 'Load a reference track in Reference tab to enable.',
    });
  }

  // Weighted technical convergence index (never claims subjective artistic perfection)
  const qcPenalty = qcReport.failCount * 10 + qcReport.warningCount * 3;
  const activeDims = dimensions.filter((d) => d.status !== 'not-applicable');
  const rawMean = activeDims.reduce((acc, d) => acc + d.score, 0) / Math.max(1, activeDims.length);
  const engineeringFitIndex = Math.max(0, Math.min(100, Number((rawMean - qcPenalty * 0.4).toFixed(1))));

  return {
    dimensions,
    engineeringFitIndex,
    limitingFactors,
    nonMeasurableNote:
      'Numerical telemetry convergence measures engineering compliance (loudness, headroom, dynamics, phase, distortion, QC). Artistic feel, groove, and emotional balance must be confirmed by ear.',
  };
}

/**
 * Intelligent Reference Track Comparison
 * Compares loudness, dynamic range, crest, transient density, tonal zones, and stereo width.
 */
export function compareReferenceIntelligent(
  pre: AudioAnalysis,
  post: AudioAnalysis,
  reference: AudioAnalysis,
): ReferenceComparisonReport {
  const zoneDeltasDb = {
    sub: Number((reference.zoneEnergyDb.sub - post.zoneEnergyDb.sub).toFixed(2)),
    bass: Number((reference.zoneEnergyDb.bass - post.zoneEnergyDb.bass).toFixed(2)),
    lowMid: Number((reference.zoneEnergyDb.lowMid - post.zoneEnergyDb.lowMid).toFixed(2)),
    mid: Number((reference.zoneEnergyDb.mid - post.zoneEnergyDb.mid).toFixed(2)),
    highMid: Number((reference.zoneEnergyDb.highMid - post.zoneEnergyDb.highMid).toFixed(2)),
    presence: Number((reference.zoneEnergyDb.presence - post.zoneEnergyDb.presence).toFixed(2)),
    air: Number((reference.zoneEnergyDb.air - post.zoneEnergyDb.air).toFixed(2)),
  };
  const suggestedActions: string[] = [];
  // Keep absolute zone deltas above for diagnostics, but derive tonal recommendations
  // from each band's relationship to the midrange so global loudness differences cancel.
  const referenceBassMid = reference.zoneEnergyDb.bass - reference.zoneEnergyDb.mid;
  const masterBassMid = post.zoneEnergyDb.bass - post.zoneEnergyDb.mid;
  const relativeBassDeltaDb = referenceBassMid - masterBassMid;
  const referenceAirMid = reference.zoneEnergyDb.air - reference.zoneEnergyDb.mid;
  const masterAirMid = post.zoneEnergyDb.air - post.zoneEnergyDb.mid;
  const relativeAirDeltaDb = referenceAirMid - masterAirMid;

  if (Math.abs(relativeBassDeltaDb) > 2.0) {
    suggestedActions.push(
      relativeBassDeltaDb > 0
        ? `Reference carries +${relativeBassDeltaDb.toFixed(1)} dB warmer bass weight relative to the midrange — consider gentle +${(relativeBassDeltaDb * 0.4).toFixed(1)} dB low-shelf @ 85 Hz.`
        : `Your master has ${Math.abs(relativeBassDeltaDb).toFixed(1)} dB heavier bass relative to the midrange — trim low shelf gently to preserve punch.`,
    );
  }
  if (Math.abs(relativeAirDeltaDb) > 2.2) {
    suggestedActions.push(
      relativeAirDeltaDb > 0
        ? `Reference has +${relativeAirDeltaDb.toFixed(1)} dB brighter air relative to the midrange — try +${(relativeAirDeltaDb * 0.35).toFixed(1)} dB high-shelf @ 11 kHz.`
        : `Reference is darker in the top octave relative to the midrange by ${Math.abs(relativeAirDeltaDb).toFixed(1)} dB — preserve air if intentional or trim slightly.`,
    );
  }
  const drDelta = post.dynamicRangeDb - reference.dynamicRangeDb;
  if (drDelta < -2.0) {
    suggestedActions.push(`Master is ${Math.abs(drDelta).toFixed(1)} dB more compressed than reference — increase Maximizer Transient Emphasis or relax Compressor ratio.`);
  }
  const widthDelta = (post.stereoWidth - reference.stereoWidth) * 100;
  if (Math.abs(widthDelta) > 15) {
    suggestedActions.push(
      widthDelta < 0
        ? `Reference stereo stage is ${Math.abs(widthDelta).toFixed(0)}% wider — subtle mid/high width expansion above 300 Hz may help.`
        : `Your master is ${widthDelta.toFixed(0)}% wider than reference — verify mono compatibility.`,
    );
  }
  if (suggestedActions.length === 0) {
    suggestedActions.push('Tonal contour, dynamics, and stereo spread align closely with the reference track.');
  }

  return {
    lufsDelta: Number((post.integratedLufs - reference.integratedLufs).toFixed(2)),
    dynamicRangeDeltaDb: Number(drDelta.toFixed(2)),
    crestDeltaDb: Number((post.crestFactorDb - reference.crestFactorDb).toFixed(2)),
    transientDensityDelta: Number((post.transientDensity - reference.transientDensity).toFixed(2)),
    spectralSlopeDelta: Number((post.spectralSlopeDbPerOct - reference.spectralSlopeDbPerOct).toFixed(2)),
    stereoWidthDelta: Number((post.stereoWidth - reference.stereoWidth).toFixed(3)),
    zoneDeltasDb,
    suggestedActions,
    cautionNote:
      pre.spectralSlopeDbPerOct < reference.spectralSlopeDbPerOct - 2.0
        ? 'Note: Your source mix is naturally darker than the reference; 40–45% weighted EQ matching avoids harsh over-brightening.'
        : 'Loudness-matched A/B auditioning isolates timbre and dynamics from level bias.',
  };
}

/**
 * Generates 3 truly differentiated Battle Mode candidates using distinct Mastering Objectives.
 * Never declares an automatic winner.
 */
export function buildBattleCandidatesIntelligent(analysis: AudioAnalysis): Array<{
  id: 'A' | 'B' | 'C';
  title: string;
  philosophy: string;
  chain: ProcessorModule[];
}> {
  const planA = buildExplainableMasterPlan({ analysis, objectiveId: 'transparent' });
  const planB = buildExplainableMasterPlan({ analysis, objectiveId: 'punchy' });
  const planC = buildExplainableMasterPlan({ analysis, objectiveId: 'warm' });

  return [
    {
      id: 'A',
      title: 'Transparent & Dynamic (-15 LUFS)',
      philosophy: 'Linear-phase precision, zero harmonic coloration, preserves maximum dynamic crest and original mix balance.',
      chain: planA.chain,
    },
    {
      id: 'B',
      title: 'Punchy Commercial (-10.5 LUFS)',
      philosophy: 'Parallel transient-preserving compression, subtle tape crest rounding, and competitive high-impact headroom.',
      chain: planB.chain,
    },
    {
      id: 'C',
      title: 'Warm Analog Stage (-13 LUFS)',
      philosophy: 'Even-order tube warmth, smooth optical glue, and gently expanded stereo width with sub-bass mono anchor.',
      chain: planC.chain,
    },
  ];
}

/**
 * Centre frequency for a Sub/Bass correction: the strongest 1/3-octave-smoothed point
 * inside the measured 20-60 Hz sub band. Keeping the correction inside the sub band
 * avoids the broad, fixed 45 Hz shelf reaching its gain limit while leaving residual
 * excess above the gate. The selected centre is retained once the control band exists,
 * so later passes refine the same notch instead of chasing a moving spectral peak.
 */
export function findSubBassCorrectionHz(analysis: AudioAnalysis): number {
  const freqs = analysis.spectrumBinsFreq;
  const dbs = analysis.spectrumBinsDb;
  if (!freqs?.length || !dbs?.length || freqs.length !== dbs.length) return 40;
  let bestHz = 40;
  let bestDb = -Infinity;
  for (let hz = 28; hz <= 56; hz += 2) {
    const lo = Math.max(20, hz / Math.pow(2, 1 / 6));
    const hi = Math.min(60, hz * Math.pow(2, 1 / 6));
    let sum = 0;
    let count = 0;
    for (let i = 0; i < freqs.length; i++) {
      if (freqs[i] >= lo && freqs[i] <= hi && freqs[i] >= 20 && freqs[i] <= 60 && Number.isFinite(dbs[i])) {
        sum += Math.pow(10, dbs[i] / 10);
        count++;
      }
    }
    if (count === 0) continue;
    const db = 10 * Math.log10(sum / count);
    if (db > bestDb) {
      bestDb = db;
      bestHz = hz;
    }
  }
  return Number.isFinite(bestDb) ? bestHz : 40;
}

/**
 * Centre frequency for a low-mid correction: the loudest 1/3-octave-smoothed point of the
 * measured spectrum inside the correction window, so the cut lands where the build-up is.
 */
export function findMudCenterHz(analysis: AudioAnalysis): number {
  const freqs = analysis.spectrumBinsFreq;
  const dbs = analysis.spectrumBinsDb;
  if (!freqs?.length || !dbs?.length || freqs.length !== dbs.length) return MUD_CORRECTION_HZ.center;
  let bestHz: number = MUD_CORRECTION_HZ.center;
  let bestDb = -Infinity;
  for (let hz = MUD_CORRECTION_HZ.min; hz <= MUD_CORRECTION_HZ.max; hz += 10) {
    const lo = hz / Math.pow(2, 1 / 6);
    const hi = hz * Math.pow(2, 1 / 6);
    let sum = 0;
    let count = 0;
    for (let i = 0; i < freqs.length; i++) {
      if (freqs[i] >= lo && freqs[i] <= hi && Number.isFinite(dbs[i])) {
        sum += Math.pow(10, dbs[i] / 10);
        count++;
      }
    }
    if (count === 0) continue;
    const db = 10 * Math.log10(sum / count);
    if (db > bestDb) {
      bestDb = db;
      bestHz = hz;
    }
  }
  return bestHz;
}

/**
 * Derives targeted ChainCommand[] from measured post-analysis, QC failures, and MultiObjective gaps.
 */
export function deriveRefinementCommands(
  pre: AudioAnalysis,
  post: AudioAnalysis,
  currentChain: ProcessorModule[],
  objective: ResolvedObjectiveTarget,
  qcReport: QCReport,
  evaluation: MultiObjectiveEvaluation,
  options?: { prevLufsError?: number },
): { commands: ChainCommand[]; hypothesis: string } {
  const commands: ChainCommand[] = [];
  const reasons: string[] = [];

  const maxMod = currentChain.find((m) => m.type === 'maximizer');
  const limMod = currentChain.find((m) => m.type === 'limiter');
  const compMod = currentChain.find((m) => m.type === 'compressor');
  const satMod = currentChain.find((m) => m.type === 'saturation');
  const imgMod = currentChain.find((m) => m.type === 'stereo-imager');
  const restoreMod = currentChain.find((m) => m.type === 'restore');
  const eqMod = currentChain.find((m) => m.type === 'parametric-eq');

  // 1. Fix True Peak / Clipping immediately
  if (post.truePeakDb > objective.maxTruePeakDb + 0.04 || post.clippedSamples > 0 || post.interSamplePeaks > 0) {
    const safeCeil = Number(
      Math.max(
        -3.0,
        Math.min(
          objective.maxTruePeakDb,
          post.truePeakDb > objective.maxTruePeakDb ? objective.maxTruePeakDb - 0.15 : objective.maxTruePeakDb,
        ),
      ).toFixed(2),
    );
    if (maxMod) {
      commands.push({
        op: 'configure',
        targetId: maxMod.id,
        processorType: 'maximizer',
        paramsPatch: { ceilingDb: safeCeil, truePeak: true },
        rationale: `Lower Maximizer ceiling to ${safeCeil} dBTP to eliminate True Peak / ISP overshoot.`,
      });
    }
    if (limMod) {
      commands.push({
        op: 'configure',
        targetId: limMod.id,
        processorType: 'limiter',
        paramsPatch: { ceilingDb: safeCeil, truePeak: true, oversampling: 4 },
        rationale: `Enforce 4x oversampled limiter ceiling at ${safeCeil} dBTP.`,
      });
    }
    if (!maxMod && !limMod) {
      commands.push({
        op: 'add',
        processorType: 'limiter',
        name: 'Safety True-Peak Limiter',
        params: { ceilingDb: safeCeil, thresholdDb: -1.5, releaseMs: 90, lookaheadMs: 3, truePeak: true, oversampling: 4 },
        rationale: 'Add missing True Peak ceiling protection.',
      });
    }
    reasons.push(`Enforce ${safeCeil} dBTP ceiling to clear clipping/ISP`);
  }

  // 2. Calibrate Integrated LUFS with oscillation damping, but do not trade away
  // source dynamics just to hit a loudness number.
  const lufsDiff = objective.targetLufs - post.integratedLufs;
  const oscillating =
    typeof options?.prevLufsError === 'number' &&
    options.prevLufsError !== 0 &&
    lufsDiff * options.prevLufsError < 0;
  const lufsGainStepScale = oscillating ? 0.42 : 0.72;
  const sourceDynamicsLimited = pre.dynamicRangeDb < objective.minDynamicRangeDb;
  const postDynamicsAtRisk =
    post.dynamicRangeDb < objective.minDynamicRangeDb ||
    pre.dynamicRangeDb - post.dynamicRangeDb > 2.5;
  const protectTransients = objective.preserveTransients && (sourceDynamicsLimited || postDynamicsAtRisk);

  if (Math.abs(lufsDiff) > 0.55 && !(protectTransients && lufsDiff > 0)) {
    if (maxMod) {
      const curTarget = (maxMod.params as { targetLufs: number }).targetLufs;
      const nextTarget = Number(Math.max(-24, Math.min(-6, curTarget + lufsDiff * lufsGainStepScale)).toFixed(2));
      commands.push({
        op: 'configure',
        targetId: maxMod.id,
        processorType: 'maximizer',
        paramsPatch: { targetLufs: nextTarget },
        rationale: `Steer Maximizer Target LUFS (${curTarget} -> ${nextTarget}) to close ${lufsDiff.toFixed(1)} LU error${oscillating ? ' (damped anti-oscillation step)' : ''}.`,
      });
      reasons.push(`Adjust Maximizer target by ${(lufsDiff * lufsGainStepScale).toFixed(1)} LU`);
    } else if (limMod) {
      const curThresh = (limMod.params as { thresholdDb: number }).thresholdDb;
      const nextThresh = Number(Math.max(-18, Math.min(0, curThresh - lufsDiff * (lufsGainStepScale * 0.9))).toFixed(2));
      commands.push({
        op: 'configure',
        targetId: limMod.id,
        processorType: 'limiter',
        paramsPatch: { thresholdDb: nextThresh },
        rationale: `Shift Limiter threshold to ${nextThresh} dB to approach ${objective.targetLufs} LUFS.`,
      });
      reasons.push(`Shift Limiter threshold toward ${nextThresh} dB`);
    }
  } else if (protectTransients && lufsDiff > 0.55) {
    reasons.push('Hold additional loudness drive because source/output dynamics are below the transient-preservation guardrail');
  }

  // 3. Recover only dynamics lost inside this processing pass. Transient emphasis is
  // a tone-shaping effect, not reconstruction, so do not use it as a DR repair control.
  const processingDynamicsCollapse =
    (post.dynamicRangeDb < objective.minDynamicRangeDb &&
      pre.dynamicRangeDb - post.dynamicRangeDb > 0.8) ||
    pre.dynamicRangeDb - post.dynamicRangeDb > 2.5;
  if (objective.preserveTransients && processingDynamicsCollapse) {
    if (maxMod) {
      const currentTarget = (maxMod.params as { targetLufs: number }).targetLufs;
      const deficitDb = Math.max(0, objective.minDynamicRangeDb - post.dynamicRangeDb);
      const retreatDb = Number(Math.max(0.5, Math.min(1.5, deficitDb * 0.35)).toFixed(2));
      const saferTarget = Number(Math.max(-24, currentTarget - retreatDb).toFixed(2));
      if (saferTarget < currentTarget) {
        commands.push({
          op: 'configure',
          targetId: maxMod.id,
          processorType: 'maximizer',
          paramsPatch: { targetLufs: saferTarget },
          rationale: `Back off Maximizer loudness drive by ${retreatDb.toFixed(2)} LU after measured dynamic-range collapse.`,
        });
      }
    }
    if (compMod && !compMod.bypassed) {
      const cp = compMod.params as { ratio: number; thresholdDb: number; attackMs: number };
      commands.push({
        op: 'configure',
        targetId: compMod.id,
        processorType: 'compressor',
        paramsPatch: {
          ratio: Number(Math.max(1.2, cp.ratio - 0.35).toFixed(2)),
          thresholdDb: Number(Math.min(-8, cp.thresholdDb + 1.5).toFixed(1)),
          attackMs: Math.min(50, cp.attackMs + 6),
        },
        rationale: 'Relax bus compression to recover transient contrast lost during mastering.',
      });
    }
    reasons.push('Back off processing-induced loudness/compression to recover measured dynamic range');
  }

  // 4. Frequency-localized phase / mono compatibility / L-R balance remediation.
  // Do not narrow healthy bands or move the mono-bass crossover to fix a high-band issue.
  const qcPhaseFail = qcReport.checks.some((c) => (c.id === 'qc-phase' || c.id === 'qc-lr-balance') && c.status !== 'pass');
  const bandPhase = post.stereoBandCorrelation;
  const globalPhaseRisk = post.phaseCorrelation < 0;
  const lowPhaseRisk = globalPhaseRisk || (bandPhase ? bandPhase.low < 0.45 : post.lowEndCorrelation < 0.45);
  const midPhaseRisk = globalPhaseRisk || (bandPhase ? bandPhase.mid < 0.15 : post.phaseCorrelation < 0.25);
  const highPhaseRisk = globalPhaseRisk || (bandPhase ? bandPhase.high < 0.15 : post.phaseCorrelation < 0.25);
  const lrBalanceRisk = Math.abs(post.lrBalanceDb) > 0.65;
  if (qcPhaseFail || lowPhaseRisk || midPhaseRisk || highPhaseRisk || lrBalanceRisk) {
    const reducedWidth = (current: number, floor: number) => Math.max(floor, current - 15);
    const affectedBands = [
      ...(lowPhaseRisk ? ['low'] : []),
      ...(midPhaseRisk ? ['mid'] : []),
      ...(highPhaseRisk ? ['high'] : []),
    ];
    if (imgMod) {
      const ip = imgMod.params as {
        lowWidth: number;
        midWidth: number;
        highWidth: number;
        monoBassBelowHz: number;
        lrBalanceDb: number;
      };
      const imagerIntensityScale = Math.max(0.15, Math.min(1, imgMod.intensity / 100));
      const correctedLrBalance = Math.max(
        -6,
        Math.min(6, ip.lrBalanceDb - (post.lrBalanceDb * 0.9) / imagerIntensityScale),
      );
      commands.push({
        op: 'configure',
        targetId: imgMod.id,
        processorType: 'stereo-imager',
        paramsPatch: {
          lowWidth: lowPhaseRisk ? reducedWidth(ip.lowWidth, 50) : ip.lowWidth,
          midWidth: midPhaseRisk ? reducedWidth(ip.midWidth, 70) : ip.midWidth,
          highWidth: highPhaseRisk ? reducedWidth(ip.highWidth, 70) : ip.highWidth,
          monoBassBelowHz: lowPhaseRisk ? Math.min(140, Math.max(95, ip.monoBassBelowHz + 15)) : ip.monoBassBelowHz,
          lrBalanceDb: lrBalanceRisk ? Number(correctedLrBalance.toFixed(2)) : ip.lrBalanceDb,
        },
        rationale: 'Reduce width only in phase-risk band(s) ' + (affectedBands.join(', ') || 'none') + ' and correct measured L/R balance.',
      });
    } else {
      commands.push({
        op: 'add',
        processorType: 'stereo-imager',
        name: 'QC Stereo Correction',
        params: {
          lowWidth: lowPhaseRisk ? 65 : 100,
          midWidth: midPhaseRisk ? 83 : 100,
          highWidth: highPhaseRisk ? 90 : 100,
          lowCrossHz: 150,
          highCrossHz: 3500,
          monoBassBelowHz: lowPhaseRisk ? 110 : 0,
          lrBalanceDb: lrBalanceRisk ? Number((-post.lrBalanceDb * 0.75).toFixed(2)) : 0,
          midSideGainDb: 0,
        },
        rationale: 'Insert targeted Stereo Imager correction for phase-risk band(s) ' + (affectedBands.join(', ') || 'none') + '.',
      });
    }
    reasons.push(
      affectedBands.length > 0
        ? 'Narrow only phase-risk ' + affectedBands.join('/') + ' band(s)'
        : 'Correct measured left/right channel imbalance',
    );
  }

  // 5. Distortion Control
  const distCheck = qcReport.checks.find((c) => c.id === 'qc-distortion');
  if (distCheck && distCheck.status !== 'pass' && satMod && !satMod.bypassed) {
    const maxAllowedThd =
      objective.saturationAllowance === 'rich' ? 2.5 :
      objective.saturationAllowance === 'moderate' ? 1.8 : 1.0;
    if (post.thdEstimatePercent > maxAllowedThd + 0.5) {
      commands.push({
        op: 'remove',
        targetId: satMod.id,
        processorType: 'saturation',
        rationale: `Remove optional saturation stage because rendered THD (${post.thdEstimatePercent.toFixed(2)}%) exceeds the ${maxAllowedThd.toFixed(1)}% objective allowance; retain independent corrective stages.`,
      });
      reasons.push('Remove optional saturation stage that exceeds the objective distortion allowance');
    } else {
      const sp = satMod.params as { drive: number };
      const nextDrive = Math.max(4, Math.round(sp.drive * 0.55));
      commands.push({
        op: 'configure',
        targetId: satMod.id,
        processorType: 'saturation',
        paramsPatch: { drive: nextDrive },
        rationale: `Back off Saturation drive (${sp.drive}% -> ${nextDrive}%) to reduce THD (${post.thdEstimatePercent.toFixed(2)}%).`,
      });
      reasons.push(`Reduce saturation drive to ${nextDrive}%`);
    }
  }

  // 6. Noise Floor / DC Remediation
  const noiseFail = qcReport.checks.some((c) => (c.id === 'qc-noise-floor' || c.id === 'qc-dc') && c.status !== 'pass');
  if (noiseFail) {
    if (restoreMod) {
      const rp = restoreMod.params as { hissReduction: number };
      commands.push({
        op: 'configure',
        targetId: restoreMod.id,
        processorType: 'restore',
        paramsPatch: { dcOffset: true, hissReduction: Math.min(60, rp.hissReduction + 18) },
        rationale: 'Increase conservative hiss reduction & DC filter.',
      });
    } else {
      commands.push({
        op: 'add',
        processorType: 'restore',
        position: 0,
        name: 'QC Noise & DC Cleanup',
        params: {
          dcOffset: true,
          humRemovalHz: 0,
          hissReduction: 28,
          deEssAmount: 12,
          deEssFreqHz: 6800,
          resonanceSuppress: 12,
          mode: 'conservative',
        },
        rationale: 'Prepend SYN-Restore to lower elevated noise floor / DC bias.',
      });
    }
    reasons.push('Engage SYN-Restore noise/DC remediation');
  }

  // Shared working copy of the EQ bands so the bass and low-mid steps both land in one command.
  let refineBands: EQBand[] | null = null;
  let refineEqCommandPushed = false;
  const getRefineBands = (): EQBand[] => {
    if (!refineBands) {
      const params = eqMod?.params as { bands?: EQBand[] } | undefined;
      refineBands = (params?.bands ?? []).map((band) => ({ ...band }));
    }
    return refineBands;
  };

  // 7. Measurement-specific bass-vs-mid correction. Do not use a low-mid bell cut
  // to solve excess energy in the separate 60-250 Hz bass measurement.
  const bassMidDiff = post.zoneEnergyDb.bass - post.zoneEnergyDb.mid;
  const bassMidLimit = getDiagnosisThresholds(objective).bassMidDiffLimit;
  if (bassMidDiff > bassMidLimit) {
    const excessDb = bassMidDiff - bassMidLimit;
    const cutStepDb = Number(Math.max(0.25, Math.min(0.75, excessDb * 0.75)).toFixed(2));
    const currentParams = eqMod?.params as { phaseMode?: 'minimum' | 'linear'; msMode?: 'stereo' | 'mid-side'; tiltDb?: number; bands?: EQBand[] } | undefined;
    const currentBands = currentParams?.bands ?? [];
    const bassShelfIndex = currentBands.findIndex((band) => band.shape === 'lowshelf' && band.freq >= 70 && band.freq <= 140);
    const nextBands = getRefineBands();
    if (bassShelfIndex >= 0) {
      const shelf = nextBands[bassShelfIndex];
      shelf.gain = Number(Math.max(-3, shelf.gain - cutStepDb).toFixed(2));
      shelf.enabled = true;
    } else {
      nextBands.push({ id: 'refine-bass-mid', enabled: true, shape: 'lowshelf', freq: 100, gain: -cutStepDb, q: 0.71 });
    }
    const rationale = `Reduce 60-250 Hz bass energy by a restrained ${cutStepDb.toFixed(2)} dB low shelf; Bass vs Mid is ${bassMidDiff.toFixed(1)} dB (limit ${bassMidLimit.toFixed(1)} dB).`;
    if (eqMod) {
      commands.push({
        op: 'configure',
        targetId: eqMod.id,
        processorType: 'parametric-eq',
        paramsPatch: { bands: nextBands },
        rationale,
      });
    } else {
      commands.push({
        op: 'add',
        processorType: 'parametric-eq',
        name: 'Bass-to-Mid Refinement EQ',
        params: { phaseMode: 'minimum', msMode: 'stereo', tiltDb: 0, bands: nextBands },
        rationale,
      });
    }
    refineEqCommandPushed = true;
    reasons.push(`Trim bass-vs-mid excess by ${cutStepDb.toFixed(2)} dB at 100 Hz`);
  }

  // 7b. Low-mid / mud-region correction. Deepens a 200-360 Hz bell in small steps while
  // the low-mid or 150-400 Hz masking measurement stays above its limit. Never digs past
  // -4 dB in total, and stops if the midrange is already hollow.
  {
    const thresholds = getDiagnosisThresholds(objective);
    const lowMidBuildupPost = post.zoneEnergyDb.lowMid - post.zoneEnergyDb.mid;
    const regionPost = computeRegionEnergyDb(post, MUD_REGION_HZ[0], MUD_REGION_HZ[1]);
    const regionVsMidPost = regionPost !== null ? regionPost - post.zoneEnergyDb.mid : null;
    const excessDb = Math.max(
      0,
      lowMidBuildupPost - thresholds.lowMidBuildupLimit,
      regionVsMidPost !== null ? regionVsMidPost - thresholds.region150To400VsMidLimit : 0,
    );
    const hollow = lowMidBuildupPost < -4.0;
    if (excessDb > 0.2 && !hollow) {
      const stepDb = Number(Math.max(0.5, Math.min(1.0, excessDb * 0.5)).toFixed(2));
      const bands = getRefineBands();
      const bellIndex = bands.findIndex(
        (band) => band.shape === 'bell' && band.freq >= MUD_CORRECTION_HZ.min && band.freq <= MUD_CORRECTION_HZ.max,
      );
      let appliedGain: number;
      if (bellIndex >= 0) {
        const bell = bands[bellIndex];
        appliedGain = Number(Math.max(-4, Math.min(bell.gain, 0) - stepDb).toFixed(2));
        bell.gain = appliedGain;
        bell.enabled = true;
        // Retune toward the measured build-up when the bell sits more than 1/3 octave away.
        const centerHz = findMudCenterHz(post);
        if (Math.abs(Math.log2(centerHz / bell.freq)) > 1 / 3) {
          bell.freq = Math.round(bell.freq * Math.pow(centerHz / bell.freq, 0.5));
        }
      } else {
        appliedGain = -stepDb;
        bands.push(mudBell('refine-low-mid', findMudCenterHz(post), appliedGain, REFINE_MUD_PROPORTIONAL_Q));
      }
      const atLimit = bellIndex >= 0 && appliedGain <= -4;
      const rationale =
        `Reduce ${MUD_REGION_HZ[0]}-${MUD_REGION_HZ[1]} Hz masking by ${stepDb.toFixed(2)} dB ` +
        `(Low-Mid vs Mid ${lowMidBuildupPost.toFixed(1)} dB, limit ${thresholds.lowMidBuildupLimit.toFixed(1)} dB` +
        (regionVsMidPost !== null ? `; ${MUD_REGION_HZ[0]}-${MUD_REGION_HZ[1]} Hz vs Mid ${regionVsMidPost.toFixed(1)} dB, limit ${thresholds.region150To400VsMidLimit.toFixed(1)} dB` : '') +
        ').';
      if (!atLimit || bellIndex < 0) {
        if (!refineEqCommandPushed) {
          if (eqMod) {
            commands.push({ op: 'configure', targetId: eqMod.id, processorType: 'parametric-eq', paramsPatch: { bands }, rationale });
          } else {
            commands.push({
              op: 'add',
              processorType: 'parametric-eq',
              name: 'Low-Mid Refinement EQ',
              params: { phaseMode: 'minimum', msMode: 'stereo', tiltDb: 0, bands },
              rationale,
            });
          }
          refineEqCommandPushed = true;
        }
        reasons.push(`Deepen low-mid bell to ${appliedGain.toFixed(2)} dB in the ${MUD_CORRECTION_HZ.min}-${MUD_CORRECTION_HZ.max} Hz mud region`);
      }
    }
  }

  // 8. Spectral harshness/mud QC follow-up
  const specCheck = qcReport.checks.find((c) => c.id === 'qc-spectral');
  if (specCheck && specCheck.status !== 'pass' && eqMod) {
    const ep = eqMod.params as { tiltDb: number };
    const mudHeavy = post.zoneEnergyDb.bass - post.zoneEnergyDb.mid >= 11;
    commands.push({
      op: 'configure',
      targetId: eqMod.id,
      processorType: 'parametric-eq',
      paramsPatch: {
        tiltDb: Number(Math.max(-3, Math.min(3, ep.tiltDb + (mudHeavy ? 0.5 : -0.5))).toFixed(2)),
      },
      rationale: mudHeavy ? 'Tilt spectral slope slightly brighter to offset heavy bass.' : 'Ease upper-mid tilt to tame harshness.',
    });
    reasons.push('Refine EQ tilt for spectral balance');
  }

  return {
    commands,
    hypothesis:
      reasons.length > 0
        ? `Hypothesis: ${reasons.join('; ')} will raise Fit Index (currently ${evaluation.engineeringFitIndex.toFixed(1)}) and resolve QC flags.`
        : 'Telemetry is balanced near convergence; minor verification pass.',
  };
}

export interface RunAutonomousDirectorOptions {
  sourceChannels: Float32Array[];
  sampleRate: number;
  operatingMode: DirectorOperatingMode;
  objectiveId: MasteringObjectiveId;
  mode?: MasteringMode;
  customSpec?: Partial<CustomObjectiveSpec> | null;
  qcProfile?: QCTargetProfile | null;
  exportConfig?: ExportConfig | null;
  referenceAnalysis?: AudioAnalysis | null;
  verificationBaselineAnalysis?: AudioAnalysis;
  verificationBaselineDiagnosis?: DirectorDiagnosisReport;
  vocalBalanceVerification?: VocalBalanceVerification;
  stemAnalysis?: StemSetAnalysis | null;
  stemBuses?: StemInput[];
  stemChainsById?: Record<string, ProcessorModule[]>;
  externalPlugins?: ExternalPluginRecord[];
  hostConnected?: boolean;
  initialChain?: ProcessorModule[];
  /**
   * Modules the caller has already gated to run before the planned chain when no initialChain
   * is given (e.g. a Vocal Rebalance the local policy proposed because stems are cached).
   * They are rendered, re-measured and judged by the objective gate like the rest of the pass.
   */
  leadModules?: ProcessorModule[];
  externalProcessor?: ExternalPluginProcessCallback;
  /** Timeline fades applied after the chain on every render the loop measures. */
  postFades?: FadeSettings | null;
  /**
   * Learned reference spectra (Match EQ). The loop learns the source side itself from the
   * rendered source timeline. Without it, unlearned Match EQ stages are removed.
   */
  matchEqReference?: { spectra: MatchEqProfile['reference']; name?: string } | null;
  renderPassFn?: (
    channels: Float32Array[],
    sampleRate: number,
    chain: ProcessorModule[],
  ) => Promise<{ channels: Float32Array[]; analysis: AudioAnalysis }>;
  aiRefineCallback?: (ctx: {
    preAnalysis: AudioAnalysis;
    postAnalysis: AudioAnalysis;
    currentChain: ProcessorModule[];
    mode?: MasteringMode;
    objective?: MasteringObjectiveId;
    referenceAnalysis?: AudioAnalysis | null;
    remainingFindings?: Array<{
      findingId: string;
      title: string;
      status: string;
      detail: string;
      recommendedAction?: string;
      measurementReliable: boolean;
    }>;
    targetLufs: number;
    targetTruePeakDb: number;
    preserveDynamics: boolean;
    qcReport: QCReport;
    targetGate: MasterTargetGate;
  }) => Promise<ProcessorModule[] | null | AiRefineSuggestion>;
  initialAiTrace?: AiPassTrace;
  maxIterations?: number;
  maxCpuBudgetMs?: number;
  convergenceThreshold?: number;
  isPaused?: () => boolean;
  shouldStop?: () => boolean;
  onProgress?: (update: {
    stage: string;
    lifecycle?: AiChainLifecycleState;
    passNumber: number;
    maxIterations: number;
    activityEntry?: DirectorActivityEntry;
    checkpoint?: DirectorCheckpoint;
    currentChain?: ProcessorModule[];
  }) => void;
}

/**
 * What an AI refinement callback may return: a proposed chain plus who produced it and any
 * provider notices (errors, fallbacks). It can only PROPOSE a chain; the loop renders it,
 * re-measures it and judges it against the objective gate like any other candidate.
 */
export interface AiRefineSuggestion {
  chain: ProcessorModule[] | null;
  producedBy?: string | null;
  notices?: string[];
  trace?: {
    source?: AiCallSource;
    fallbackReason?: AiFallbackReason | null;
    fallbackDetail?: string;
    modelName?: string | null;
    responseTimeMs?: number | null;
    promptChars?: number | null;
    timeoutHit?: AiTimeoutHit;
    aiReturnedModules?: ProcessorModule['type'][];
  };
}

const SOURCE_LIMITATION_FINDING_IDS = new Set(['diag-clipping', 'diag-overcompressed', 'diag-thd']);

function hasActionablePostFixFindings(report: PostFixVerificationReport): boolean {
  return report.activeFindings.some((finding) => !SOURCE_LIMITATION_FINDING_IDS.has(finding.findingId)) ||
    report.newlyIntroducedFindings.length > 0;
}

function summarizeActionablePostFixFindings(report: PostFixVerificationReport): string {
  const active = report.activeFindings.filter((finding) => !SOURCE_LIMITATION_FINDING_IDS.has(finding.findingId));
  const labels = [
    ...active.map((finding) => `${finding.originalFinding.title} [${finding.status}]`),
    ...report.newlyIntroducedFindings.map((finding) => `${finding.title} [NEW]`),
  ];
  return labels.length > 0 ? `${labels.length} actionable technical finding(s) remain: ${labels.join(', ')}.` : 'No actionable technical findings remain.';
}

function makeActivity(
  passNumber: number,
  phase: DirectorActivityEntry['phase'],
  kind: DirectorActivityEntry['kind'],
  message: string,
  details?: string,
): DirectorActivityEntry {
  return {
    id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
    passNumber,
    phase,
    kind,
    message,
    details,
  };
}

function toStemIntelligenceReport(
  stemSet?: StemSetAnalysis | null,
  chainsByStemId: Record<string, ProcessorModule[]> = {},
  processingApplied = false,
): StemIntelligenceReport | undefined {
  if (!stemSet) return undefined;
  const processingChains = Object.fromEntries(
    Object.entries(chainsByStemId).map(([id, chain]) => [id, chain.map((module) => module.type)]),
  );
  return {
    sampleRate: stemSet.sampleRate,
    durationSec: stemSet.durationSec,
    stemCount: stemSet.stems.length,
    stems: stemSet.stems.map((stem) => ({
      id: stem.id,
      name: stem.name,
      role: stem.role,
      offsetSamples: stem.offsetSamples,
      integratedLufs: stem.analysis.integratedLufs,
      truePeakDb: stem.analysis.truePeakDb,
      stereoWidth: stem.analysis.stereoWidth,
      processed: processingApplied && (chainsByStemId[stem.id] ?? []).some((module) => module.enabled && !module.bypassed && module.wetDry > 0.1),
      processors: (processingChains[stem.id] ?? []),
    })),
    overlaps: stemSet.overlaps.map((overlap) => ({
      stemAId: overlap.stemAId,
      stemBId: overlap.stemBId,
      band: overlap.band,
      differenceDb: overlap.differenceDb,
      confidence: overlap.confidence,
    })),
    warnings: [...stemSet.warnings],
    processingChains,
  };
}

function buildFinalReportFromState(params: {
  operatingMode: DirectorOperatingMode;
  objective: ResolvedObjectiveTarget;
  status: MasterFinalReport['status'];
  stopReason: string;
  iterationsExecuted: number;
  bestCheckpoint: DirectorCheckpoint;
  rolledBack: boolean;
  preAnalysis: AudioAnalysis;
  referenceAnalysis?: AudioAnalysis | null;
  verificationBaselineAnalysis?: AudioAnalysis;
  verificationBaselineDiagnosis?: DirectorDiagnosisReport;
  vocalBalanceVerification?: VocalBalanceVerification;
  stemAnalysis?: StemSetAnalysis | null;
  stemChainsById?: Record<string, ProcessorModule[]>;
  stemProcessingApplied?: boolean;
  diagnosis: DirectorDiagnosisReport;
  recommendations: DirectorRecommendation[];
  pluginSummary: PluginIntelligenceSummary;
  checkpoints: DirectorCheckpoint[];
  activityLog: DirectorActivityEntry[];
  aiPasses?: AiPassTrace[];
}): MasterFinalReport {
  const { preAnalysis, bestCheckpoint, diagnosis } = params;
  const postAnalysis = bestCheckpoint.analysis;
  const verificationBaseline = params.verificationBaselineAnalysis ?? preAnalysis;
  const verificationDiagnosis = params.verificationBaselineDiagnosis ?? diagnosis;
  const verifiedImprovements: string[] = [];
  const remainingTradeoffs: string[] = [];
  const resolvedProblems: string[] = [];
  const partiallyResolvedProblems: string[] = [];
  const preservedCharacteristics: string[] = [];

  const lufsDelta = postAnalysis.integratedLufs - preAnalysis.integratedLufs;
  verifiedImprovements.push(
    `Integrated Loudness: ${preAnalysis.integratedLufs.toFixed(1)} -> ${postAnalysis.integratedLufs.toFixed(1)} LUFS (${lufsDelta >= 0 ? '+' : ''}${lufsDelta.toFixed(1)} LU)`,
  );
  verifiedImprovements.push(
    `True Peak Headroom: ${preAnalysis.truePeakDb.toFixed(2)} -> ${postAnalysis.truePeakDb.toFixed(2)} dBTP (clipped: ${postAnalysis.clippedSamples})`,
  );
  verifiedImprovements.push(
    `Stereo & Phase: Corr ${postAnalysis.phaseCorrelation.toFixed(2)} (Low ${postAnalysis.lowEndCorrelation.toFixed(2)}), L/R ${postAnalysis.lrBalanceDb.toFixed(2)} dB`,
  );

  // Evidence-based post-fix reanalysis against baseline findings
  const hasExecutedProcessing = params.iterationsExecuted > 0 && bestCheckpoint.passNumber > 0;
  const chainFp = computeChainFingerprint(bestCheckpoint.chain);
  const postFixVerification = verifyPostFixAnalysis({
    baselineAnalysis: verificationBaseline,
    baselineDiagnosis: verificationDiagnosis,
    postAnalysis: hasExecutedProcessing ? postAnalysis : null,
    objective: params.objective,
    referenceAnalysis: params.referenceAnalysis,
    baselineAnalysisId: 'baseline',
    postAnalysisId: hasExecutedProcessing ? bestCheckpoint.id : 'baseline',
    currentChainFingerprint: chainFp,
    postChainFingerprint: hasExecutedProcessing ? chainFp : undefined,
    postProcessingStatus: hasExecutedProcessing ? 'ready' : 'idle',
    appliedCorrections: [
      ...(params.stemProcessingApplied
        ? (() => {
            const stemModules = Object.values(params.stemChainsById ?? {})
              .flat()
              .filter((module) => module.enabled && !module.bypassed && module.wetDry > 0.1);
            return stemModules.length > 0
              ? [{
                  id: 'corr-stem-buses',
                  timestamp: Date.now(),
                  label: 'Applied stem-bus processing',
                  processorTypes: stemModules.map((module) => module.type),
                  chainFingerprint: computeChainFingerprint(stemModules),
                }]
              : [];
          })()
        : []),
      ...(hasExecutedProcessing
        ? [{
            id: `corr-dir-${bestCheckpoint.passNumber}`,
            timestamp: bestCheckpoint.timestamp,
            label: `AI Automatic Pass #${bestCheckpoint.passNumber}`,
            processorTypes: bestCheckpoint.chain.map((module) => module.type),
            chainFingerprint: chainFp,
          }]
        : []),
    ],
  });

  for (const resolved of postFixVerification.resolvedFindings) {
    resolvedProblems.push(`${resolved.originalFinding.title} — ${resolved.verificationSummary}`);
  }
  for (const active of postFixVerification.activeFindings) {
    partiallyResolvedProblems.push(
      `${active.originalFinding.title} [${active.status}]: ${active.remainingDeviation ?? active.verificationSummary}`,
    );
  }
  for (const newly of postFixVerification.newlyIntroducedFindings) {
    remainingTradeoffs.push(`Newly detected after processing: ${newly.title} (${newly.evidence.join(', ')})`);
  }

  for (const finding of diagnosis.findings) {
    if (finding.kind === 'artistic-choice') {
      preservedCharacteristics.push(`${finding.title}: ${finding.explanation}`);
    }
  }

  for (const w of diagnosis.workingWell) {
    if (preservedCharacteristics.length < 4) preservedCharacteristics.push(w);
  }

  for (const lf of bestCheckpoint.multiObjective.limitingFactors) {
    remainingTradeoffs.push(lf);
  }
  for (const chk of bestCheckpoint.qcReport.checks) {
    if (chk.status !== 'pass') {
      remainingTradeoffs.push(`QC ${chk.status.toUpperCase()} (${chk.label}): ${chk.measuredValue} vs ${chk.targetValue}`);
    }
  }
  if (remainingTradeoffs.length === 0) {
    remainingTradeoffs.push('All measured QC and multi-objective tolerances met within configured limits.');
  }

  return {
    id: `report-${Date.now()}`,
    createdAt: Date.now(),
    operatingMode: params.operatingMode,
    objective: params.objective,
    status: params.status,
    stopReason: params.stopReason,
    iterationsExecuted: params.iterationsExecuted,
    bestPassNumber: bestCheckpoint.passNumber,
    rolledBack: params.rolledBack,
    preAnalysis,
    postAnalysis,
    qcReport: bestCheckpoint.qcReport,
    multiObjective: bestCheckpoint.multiObjective,
    diagnosis: params.diagnosis,
    recommendations: params.recommendations,
    pluginSummary: params.pluginSummary,
    finalChain: bestCheckpoint.chain,
    checkpoints: params.checkpoints,
    activityLog: params.activityLog,
    verifiedImprovements,
    remainingTradeoffs,
    resolvedProblems,
    partiallyResolvedProblems,
    preservedCharacteristics,
    postFixVerification,
    stemIntelligence: toStemIntelligenceReport(params.stemAnalysis, params.stemChainsById, params.stemProcessingApplied),
    vocalBalanceVerification: params.vocalBalanceVerification,
    ...(params.aiPasses && params.aiPasses.length > 0 ? { aiPasses: params.aiPasses } : {}),
  };
}

export function preventUnverifiedConvergence(report: MasterFinalReport): void {
  if (report.status !== 'converged' || isMasterFullyVerified(report)) return;
  report.status = 'completed';
  const vocalIncomplete =
    report.vocalBalanceVerification?.status === 'unresolved' ||
    report.vocalBalanceVerification?.status === 'unverified';
  report.stopReason = `${report.stopReason} Full verification incomplete: ${
    vocalIncomplete
      ? report.vocalBalanceVerification?.summary
      : 'one or more measured findings remain active, newly introduced, or unverified.'
  }`;
}

/**
 * Preserve only caller-required lead modules when an AI supplies a complete chain.
 * Tool selection and settings stay under AI control; Match EQ is separately
 * hydrated/bounded by a real learned reference before rendering.
 */
export function mergeAiChainWithRequiredModules(
  aiChain: ProcessorModule[],
  requiredModules: ProcessorModule[],
): ProcessorModule[] {
  // Keep the 12-stage safety limit without silently losing the AI's limiter or
  // evidence-critical processor because a caller prepended a required lead stage.
  const merged = [...structuredClone(requiredModules), ...structuredClone(aiChain)];
  const protectedTypes = new Set<string>(['vocal-rebalance', 'dynamic-eq', 'match-eq', 'restore', 'limiter', 'maximizer', 'dither']);
  while (merged.length > 12) {
    let dropAt = -1;
    for (let i = merged.length - 1; i >= 0; i--) {
      if (!protectedTypes.has(merged[i].type)) { dropAt = i; break; }
    }
    if (dropAt < 0) break;
    merged.splice(dropAt, 1);
  }
  return validateChain(merged);
}

/**
 * Closed-loop Autonomous Mastering Director (SYN-ITERATE + SYN-QC + Safeguards)
 */
export async function runAutonomousDirectorLoop(
  opts: RunAutonomousDirectorOptions,
): Promise<MasterFinalReport> {
  const startMs = Date.now();
  const maxIterations = Math.max(1, Math.min(10, opts.maxIterations ?? 3));
  const maxCpuBudgetMs = Math.max(2000, opts.maxCpuBudgetMs ?? 30000);
  const convergenceThreshold = Math.max(0.2, opts.convergenceThreshold ?? 0.8);

  const activityLog: DirectorActivityEntry[] = [];
  const checkpoints: DirectorCheckpoint[] = [];

  const emit = (
    stage: string,
    passNumber: number,
    entry?: DirectorActivityEntry,
    checkpoint?: DirectorCheckpoint,
    currentChain?: ProcessorModule[],
    lifecycle?: AiChainLifecycleState,
  ) => {
    if (entry) activityLog.push(entry);
    opts.onProgress?.({
      stage,
      lifecycle,
      passNumber,
      maxIterations,
      activityEntry: entry,
      checkpoint,
      currentChain,
    });
  };

  // Cooperative pause wait helper
  const waitIfPaused = async (): Promise<boolean> => {
    while (opts.isPaused?.()) {
      if (opts.shouldStop?.()) return false;
      await new Promise((r) => setTimeout(r, 120));
    }
    return !opts.shouldStop?.();
  };

  // Resolve the source timeline. When stem buses are supplied, their explicit
  // offsets define the canonical mix timeline rather than a potentially stale
  // stereo bounce passed by the caller.
  let sourceChannels = opts.sourceChannels;
  let resolvedStemAnalysis = opts.stemAnalysis ?? null;
  let stemProcessedChannels: Float32Array[] | null = null;
  let stemProcessingApplied = false;
  if (opts.stemBuses && opts.stemBuses.length > 0) {
    const dryStemRender = await renderStemBusMix(opts.stemBuses, opts.sampleRate);
    sourceChannels = dryStemRender.mixChannels;
    resolvedStemAnalysis = dryStemRender.sourceAnalysis;
    const knownStemIds = new Set(opts.stemBuses.map((stem) => stem.id));
    for (const stemId of Object.keys(opts.stemChainsById ?? {})) {
      if (!knownStemIds.has(stemId)) throw new RangeError(`Stem processor chain references unknown stem "${stemId}"`);
    }

    const hasActiveStemProcessing = opts.operatingMode !== 'manual' &&
      Object.values(opts.stemChainsById ?? {}).some((chain) =>
        chain.some((module) => module.enabled && !module.bypassed && module.wetDry > 0.1),
      );
    if (hasActiveStemProcessing) {
      const processedStemRender = await renderStemBusMix(opts.stemBuses, opts.sampleRate, {
        chainsByStemId: opts.stemChainsById,
        externalProcessor: opts.externalProcessor,
      });
      stemProcessedChannels = processedStemRender.mixChannels;
      stemProcessingApplied = true;
    }
  }

  const passSourceChannels = stemProcessedChannels ?? sourceChannels;

  // Phase 1: Baseline Analysis (yield cleanly so UI never freezes on trigger)
  emit('Analyzing', 0, undefined, undefined, undefined, 'Analyzing');
  const baselineRendered = await renderAndAnalyzeOffThread({
    sourceChannels,
    sampleRate: opts.sampleRate,
    chain: [],
    externalProcessor: opts.externalProcessor,
    postFades: opts.postFades,
  });
  const preAnalysis = baselineRendered.analysis;
  const objective = resolveObjectiveTarget(opts.objectiveId, opts.customSpec, opts.referenceAnalysis);
  // VERIFY FIX: the QC profile and the mastering objective used to be chosen separately
  // (e.g. objective "Electronic" -9.5 LUFS while QC stayed on "Streaming" -14 LUFS). The
  // refinement chased one loudness target while QC judged against another, so a run could
  // never truly pass, or "passed" against the wrong target. The objective is now the single
  // source of truth for loudness / true peak; the QC profile only supplies its other limits.
  const qcProfile: QCTargetProfile = alignQcProfileToObjective(opts.qcProfile ?? QC_TARGET_PROFILES[0], objective);

  emit('Planning', 0, undefined, undefined, undefined, 'Planning');
  // Match EQ profile: reference spectra from the caller, source learned from this timeline.
  let matchEqProfile: MatchEqProfile | null = null;
  if (opts.matchEqReference && opts.referenceAnalysis) {
    const learnedSource = learnMatchEqSpectrum(passSourceChannels, opts.sampleRate);
    if (learnedSource) {
      matchEqProfile = { source: learnedSource, reference: opts.matchEqReference.spectra, referenceName: opts.matchEqReference.name };
    }
  }

  const plan = buildExplainableMasterPlan({
    analysis: preAnalysis,
    objectiveId: opts.objectiveId,
    customSpec: opts.customSpec,
    referenceAnalysis: opts.referenceAnalysis,
    matchEqProfile,
    stemAnalysis: resolvedStemAnalysis,
    externalPlugins: opts.externalPlugins,
    hostConnected: opts.hostConnected,
  });

  emit(
    'Analyzing',
    0,
    makeActivity(
      0,
      'analyze',
      'observation',
      `Baseline analyzed: ${preAnalysis.integratedLufs.toFixed(1)} LUFS, ${preAnalysis.truePeakDb.toFixed(2)} dBTP, DR ${preAnalysis.dynamicRangeDb.toFixed(1)} dB, Noise ${(preAnalysis.noiseFloorDb ?? -72).toFixed(1)} dBFS.`,
      `Profile: ${plan.diagnosis.artisticProfile} · Technical problems: ${plan.diagnosis.findings.filter((f) => f.kind === 'technical-problem').length}`,
    ),
    undefined,
    undefined,
    'Analyzing',
  );

  emit(
    'SYN-PLUGIN',
    0,
    makeActivity(
      0,
      'plugin',
      plan.pluginSummary.compatibleAvailableCount > 0 ? 'observation' : 'warning',
      plan.pluginSummary.statusSummary,
    ),
    undefined,
    undefined,
    'Planning',
  );

  const baseQc = runQualityControl(preAnalysis, preAnalysis, qcProfile, opts.exportConfig);
  const baseEval = evaluateMultiObjectiveMetrics(preAnalysis, preAnalysis, objective, baseQc, opts.referenceAnalysis);
  const baseCheckpoint: DirectorCheckpoint = {
    id: 'cp-0',
    passNumber: 0,
    label: 'Unprocessed Baseline',
    timestamp: Date.now(),
    chain: structuredClone(opts.initialChain ?? []),
    analysis: preAnalysis,
    qcReport: baseQc,
    multiObjective: baseEval,
    iterationSummary: {
      activeProcessor: 'Baseline Input',
      detectedIssue: 'Pre-master measurement',
      measuredValue: `${preAnalysis.integratedLufs.toFixed(1)} LUFS / ${preAnalysis.truePeakDb.toFixed(2)} dBTP`,
      targetValue: `${objective.targetLufs.toFixed(1)} LUFS / <= ${objective.maxTruePeakDb.toFixed(1)} dBTP`,
      outcome: 'baseline',
    },
  };
  baseCheckpoint.targetGate = evaluateMasterTargets(preAnalysis, objective, {
    preAnalysis,
    referenceAnalysis: opts.referenceAnalysis,
  });
  checkpoints.push(baseCheckpoint);
  emit('Planning', 0, undefined, baseCheckpoint, undefined, 'Planning');

  // If Manual mode, stop cleanly after producing explainable plan & baseline without mutating audio
  if (opts.operatingMode === 'manual') {
    emit(
      'Completed',
      0,
      makeActivity(
        0,
        'plan',
        'hypothesis',
        `Generated ${plan.recommendations.length}-step explainable plan for Manual review (no automatic chain mutations executed).`,
      ),
      undefined,
      undefined,
      'Completed',
    );
    return buildFinalReportFromState({
      operatingMode: opts.operatingMode,
      objective,
      status: 'completed',
      stopReason: 'Manual mode: Explainable plan generated for engineer-controlled execution.',
      iterationsExecuted: 0,
      bestCheckpoint: baseCheckpoint,
      rolledBack: false,
      preAnalysis,
      referenceAnalysis: opts.referenceAnalysis,
      verificationBaselineAnalysis: opts.verificationBaselineAnalysis,
      verificationBaselineDiagnosis: opts.verificationBaselineDiagnosis,
      vocalBalanceVerification: opts.vocalBalanceVerification,
      stemAnalysis: resolvedStemAnalysis,
      stemChainsById: opts.stemChainsById,
      stemProcessingApplied,
      diagnosis: plan.diagnosis,
      recommendations: plan.recommendations,
      pluginSummary: plan.pluginSummary,
      checkpoints,
      activityLog,
      aiPasses: opts.initialAiTrace ? [structuredClone(opts.initialAiTrace)] : undefined,
    });
  }

  // Initial working chain: use validated Gemini or initialChain in Assisted if user wants refinement, else planned chain
  // Match EQ stages proposed by the AI carry no spectra: hydrate them from the learned profile
  // and hold them to the Director's conservative ceiling; without a reference, drop them.
  const prepareChain = (c: ProcessorModule[], fromAi: boolean) =>
    hydrateMatchEqChain(c, matchEqProfile, { dropUnlearned: true, conservative: fromAi });
  let workingChain: ProcessorModule[] =
    opts.initialChain && opts.initialChain.length > 0
      ? prepareChain(mergeAiChainWithRequiredModules(opts.initialChain, opts.leadModules ?? []), true)
      : opts.leadModules && opts.leadModules.length > 0
        ? validateChain([...structuredClone(opts.leadModules), ...structuredClone(plan.chain)])
        : structuredClone(plan.chain);

  emit(
    'Building chain',
    0,
    makeActivity(
      0,
      'plan',
      'command',
      `Initialized ${workingChain.length}-stage DSP chain for ${objective.label} objective.`,
      workingChain.map((m) => m.name).join(' -> '),
    ),
    undefined,
    workingChain,
    'Building chain',
  );

  // In Assisted mode, render pass 1 only (verify hypothesis + QC) then hand control back to engineer
  const loopMax = opts.operatingMode === 'assisted' ? 1 : maxIterations;

  const aiPasses: AiPassTrace[] = opts.initialAiTrace ? [structuredClone(opts.initialAiTrace)] : [];
  let pendingAiTrace: AiPassTrace | null = aiPasses[0] ?? null;

  let bestCheckpoint: DirectorCheckpoint = baseCheckpoint;
  const safeFallbackCandidates: SafeFallbackCandidate[] = [];
  let lastFit = baseEval.engineeringFitIndex;
  // Chains already rendered and measured. Re-rendering one of them cannot change the
  // result, so the loop stops instead of burning passes on an identical render.
  const renderedChainKeys = new Set<string>();
  let prevLufsError: number | undefined;
  let finalStatus: MasterFinalReport['status'] = 'completed';
  let stopReason = 'Completed scheduled mastering passes.';
  let rolledBack = false;
  let iterationsExecuted = 0;

  for (let pass = 1; pass <= loopMax; pass++) {
    if (!(await waitIfPaused())) {
      finalStatus = 'stopped-by-user';
      stopReason = 'Stopped by engineer override before pass ' + pass + '.';
      emit('Stopped', pass, makeActivity(pass, 'halted', 'warning', stopReason), undefined, undefined, 'Stopped');
      break;
    }

    if (Date.now() - startMs > maxCpuBudgetMs) {
      finalStatus = 'budget-reached';
      stopReason = `Stopped after pass ${pass - 1} due to ${Math.round(maxCpuBudgetMs / 1000)}s CPU time budget.`;
      emit('Stopped', pass, makeActivity(pass, 'halted', 'warning', stopReason), undefined, undefined, 'Stopped');
      break;
    }

    emit('Processing', pass, undefined, undefined, workingChain, 'Processing');
    const rendered = opts.renderPassFn
      ? await opts.renderPassFn(passSourceChannels, opts.sampleRate, workingChain)
      : await renderAndAnalyzeOffThread({
          sourceChannels: passSourceChannels,
          sampleRate: opts.sampleRate,
          chain: workingChain,
          externalProcessor: opts.externalProcessor,
          postFades: opts.postFades,
        });

    emit('Measuring', pass, undefined, undefined, workingChain, 'Measuring');
    const post = rendered.channels
      ? filterSourceTransientClickAnalysis(
          passSourceChannels,
          rendered.channels,
          opts.sampleRate,
          preAnalysis,
          rendered.analysis,
        )
      : rendered.analysis;
    const qcReport = runQualityControl(preAnalysis, post, qcProfile, opts.exportConfig);
    const multiObjective = evaluateMultiObjectiveMetrics(
      preAnalysis,
      post,
      objective,
      qcReport,
      opts.referenceAnalysis,
    );

    const postDiagnosis = analyzeTrackIntelligence(post, objective, opts.referenceAnalysis);
    // Independent post-fix verification is part of the convergence gate, not just a UI report.
    // Source-integrity limits (pre-clipped, pre-compressed, or pre-distorted material) remain
    // disclosed but are not mistaken for a correctable mastering-stage failure.
    const passVerification = verifyPostFixAnalysis({
      baselineAnalysis: preAnalysis,
      baselineDiagnosis: plan.diagnosis,
      postAnalysis: post,
      objective,
      referenceAnalysis: opts.referenceAnalysis,
      baselineAnalysisId: 'baseline',
      postAnalysisId: `pass-${pass}`,
      currentChainFingerprint: computeChainFingerprint(workingChain),
      postChainFingerprint: computeChainFingerprint(workingChain),
      postProcessingStatus: 'ready',
    });
    const baselineTechnicalFindings = plan.diagnosis.findings.filter(
      (finding) => finding.kind === 'technical-problem',
    );
    const baselineTechnicalIds = new Set(baselineTechnicalFindings.map((finding) => finding.id));
    const baselineTechnicalById = new Map<string, (typeof baselineTechnicalFindings)[number]>(
      baselineTechnicalFindings.map((finding) => [finding.id, finding] as const),
    );
    const introducedTechnicalFindings = postDiagnosis.findings.filter(
      (finding) => finding.kind === 'technical-problem' && !baselineTechnicalIds.has(finding.id),
    );
    const severityRank = (severity: string) =>
      severity === 'high' ? 3 : severity === 'moderate' ? 2 : severity === 'low' ? 1 : 0;
    const worsenedTechnicalFindings = postDiagnosis.findings.filter((finding) => {
      if (finding.kind !== 'technical-problem') return false;
      const baselineFinding = baselineTechnicalById.get(finding.id);
      return Boolean(baselineFinding && severityRank(finding.severity) > severityRank(baselineFinding.severity));
    });
    const introducedClipping =
      post.clippedSamples > preAnalysis.clippedSamples && post.clippedSamples > 0;
    const bandPhaseRegressed = (['low', 'mid', 'high'] as const).some((band) => {
      const before = preAnalysis.stereoBandCorrelation?.[band];
      const after = post.stereoBandCorrelation?.[band];
      const riskThreshold = band === 'low' ? 0.45 : 0.15;
      return typeof before === 'number' && typeof after === 'number' &&
        after < riskThreshold && (before >= riskThreshold || after < before - 0.25);
    });
    const processingDynamicsRegressed =
      objective.preserveTransients &&
      post.dynamicRangeDb < objective.minDynamicRangeDb &&
      preAnalysis.dynamicRangeDb - post.dynamicRangeDb > 1.0;
    const transientDetailRegressed =
      objective.preserveTransients &&
      ((preAnalysis.transientDensity >= 0.08 &&
        post.transientDensity < preAnalysis.transientDensity * 0.65) ||
        post.crestFactorDb < preAnalysis.crestFactorDb - 3.0);
    const maxAllowedThd =
      objective.saturationAllowance === 'rich' ? 2.5 :
      objective.saturationAllowance === 'moderate' ? 1.8 : 1.0;
    const distortionRegressed =
      post.thdEstimatePercent > maxAllowedThd &&
      post.thdEstimatePercent > preAnalysis.thdEstimatePercent + 0.75;
    const preNoise = preAnalysis.noiseFloorDb ?? -96;
    const postNoise = post.noiseFloorDb ?? -96;
    const preNoiseAtTarget = preNoise + (objective.targetLufs - preAnalysis.integratedLufs);
    const postNoiseAtTarget = postNoise + (objective.targetLufs - post.integratedLufs);
    const noiseRegressed =
      preAnalysis.rmsDb - preNoise >= 12 &&
      post.rmsDb - postNoise >= 12 &&
      postNoiseAtTarget > preNoiseAtTarget + 1.5 &&
      (post.rmsDb - postNoise) < (preAnalysis.rmsDb - preNoise) - 1.0;
    const introducedTruePeakBreach =
      post.truePeakDb > objective.maxTruePeakDb + 0.05 &&
      (preAnalysis.truePeakDb <= objective.maxTruePeakDb + 0.05 ||
        post.truePeakDb > preAnalysis.truePeakDb + 0.25);
    const introducedLoudnessOvershoot =
      post.integratedLufs > objective.targetLufs + objective.lufsTolerance + 1.5 &&
      (preAnalysis.integratedLufs <= objective.targetLufs + objective.lufsTolerance + 1.0 ||
        post.integratedLufs > preAnalysis.integratedLufs + 1.0);
    const previousDimensionScores = new Map<string, number>(
      bestCheckpoint.multiObjective.dimensions.map((dimension) => [dimension.key, dimension.score] as const),
    );
    const severeDimensionRegressions = multiObjective.dimensions.filter((dimension) => {
      // Processing restraint is a preference/effort dimension, not a technical failure.
      // Actual damage is guarded independently by transient, dynamics, THD, noise, phase,
      // clipping, true-peak, and loudness regression checks above.
      if (dimension.key === 'musicalTransparency') return false;
      const previousScore = previousDimensionScores.get(dimension.key);
      return previousScore !== undefined && previousScore - dimension.score > 15;
    });
    const hardRegressionReasons = [
      ...(introducedClipping ? ['new clipped samples'] : []),
      ...introducedTechnicalFindings.map((finding) => finding.title),
      ...worsenedTechnicalFindings.map((finding) => finding.title + ' worsened'),
      ...(bandPhaseRegressed ? ['new or worsened frequency-band phase cancellation'] : []),
      ...(processingDynamicsRegressed ? ['processing-induced dynamic-range collapse'] : []),
      ...(transientDetailRegressed ? ['transient detail regression'] : []),
      ...(distortionRegressed ? ['objective harmonic-distortion regression'] : []),
      ...(noiseRegressed ? ['level-matched noise-floor regression'] : []),
      ...(introducedTruePeakBreach ? ['new objective true-peak ceiling breach'] : []),
      ...(introducedLoudnessOvershoot ? ['new loudness overshoot'] : []),
      ...severeDimensionRegressions.map((dimension) =>
        dimension.label + ' objective score regressed by more than 15 points',
      ),
    ];
    const hardRegression = hardRegressionReasons.length > 0;
    const isFirstValid =
      bestCheckpoint.passNumber === 0 &&
      !hardRegression &&
      multiObjective.engineeringFitIndex >= bestCheckpoint.multiObjective.engineeringFitIndex - 1.0;
    // Mud progress counts as improvement even when the Fit Index does not move, as long
    // as the overall fit holds; otherwise every low-mid refinement pass is rolled back.
    const mudVsMid = (a: AudioAnalysis) => {
      const region = computeRegionEnergyDb(a, MUD_REGION_HZ[0], MUD_REGION_HZ[1]);
      return region !== null ? region - a.zoneEnergyDb.mid : a.zoneEnergyDb.lowMid - a.zoneEnergyDb.mid;
    };
    const mudProgress =
      !hardRegression &&
      !isFirstValid &&
      bestCheckpoint.passNumber > 0 &&
      mudVsMid(post) <= mudVsMid(bestCheckpoint.analysis) - 0.1 &&
      multiObjective.engineeringFitIndex >= bestCheckpoint.multiObjective.engineeringFitIndex - 0.5 &&
      qcReport.failCount <= bestCheckpoint.qcReport.failCount;
    // Objective gate measured on THIS pass's rendered audio.
    const targetGate = evaluateMasterTargets(post, objective, {
      preAnalysis,
      referenceAnalysis: opts.referenceAnalysis,
    });
    const bestGatePassed = bestCheckpoint.passNumber > 0 && Boolean(bestCheckpoint.targetGate?.passed);
    // A pass that meets every objective target (without a hard regression) beats a retained
    // pass that does not; a pass that fails the gate can never replace one that passes it.
    const gateUpgrade = !hardRegression && targetGate.passed && !bestGatePassed;
    const gateDowngrade = bestGatePassed && !targetGate.passed;
    const improved =
      !hardRegression &&
      !gateDowngrade &&
      (gateUpgrade ||
        isFirstValid ||
        mudProgress ||
        multiObjective.engineeringFitIndex > bestCheckpoint.multiObjective.engineeringFitIndex + 0.05 ||
        (qcReport.failCount < bestCheckpoint.qcReport.failCount &&
          multiObjective.engineeringFitIndex >= bestCheckpoint.multiObjective.engineeringFitIndex - 1.5));

    const prevCp = checkpoints[checkpoints.length - 1];
    const cp: DirectorCheckpoint = {
      id: `cp-${pass}`,
      passNumber: pass,
      label: pass === 1 ? 'Initial Master Render' : `Autonomous Refinement #${pass}`,
      timestamp: Date.now(),
      chain: structuredClone(workingChain),
      analysis: post,
      qcReport,
      multiObjective,
      targetGate,
      iterationSummary: {
        activeProcessor: workingChain.map((m) => m.name).slice(0, 3).join(' + ') || 'Dry Pass',
        detectedIssue:
          hardRegressionReasons[0] ??
          multiObjective.limitingFactors[0] ??
          (qcReport.overallStatus === 'pass' ? 'Within target tolerances' : 'Fine calibration'),
        measuredValue: `${post.integratedLufs.toFixed(1)} LUFS · ${post.truePeakDb.toFixed(2)} dBTP · DR ${post.dynamicRangeDb.toFixed(1)} dB`,
        targetValue: `${objective.targetLufs.toFixed(1)} LUFS · <= ${objective.maxTruePeakDb.toFixed(1)} dBTP`,
        previousValue: prevCp
          ? `${prevCp.analysis.integratedLufs.toFixed(1)} LUFS · Fit ${prevCp.multiObjective.engineeringFitIndex.toFixed(1)}`
          : undefined,
        outcome: improved ? 'improved' : 'regressed',
      },
    };
    checkpoints.push(cp);
    if (pendingAiTrace) {
      pendingAiTrace.finalRenderedModules = cp.chain.map((m) => m.type);
      pendingAiTrace = null;
    }
    safeFallbackCandidates.push({
      checkpoint: cp,
      hardRegressionReasons: [...hardRegressionReasons],
    });
    renderedChainKeys.add(chainRenderKey(cp.chain));
    iterationsExecuted = pass;

    emit(
      'Validating',
      pass,
      makeActivity(
        pass,
        'evaluate',
        'verified-result',
        `Pass ${pass} measured: ${post.integratedLufs.toFixed(1)} LUFS, ${post.truePeakDb.toFixed(2)} dBTP, DR ${post.dynamicRangeDb.toFixed(1)} dB, Fit ${multiObjective.engineeringFitIndex.toFixed(1)}/100, QC ${qcReport.overallStatus.toUpperCase()}.`,
        `THD ${post.thdEstimatePercent.toFixed(2)}% · Clipped ${post.clippedSamples} · Clicks ${post.clickCount ?? 0} · Phase ${post.phaseCorrelation.toFixed(2)} · Gate ${targetGate.passed ? 'PASS' : 'FAIL'}${targetGate.passed ? '' : ` (${targetGate.failed.map((c) => c.label).join(', ')})`}`,
      ),
      cp,
      undefined,
      'Validating',
    );

    if (improved) {
      bestCheckpoint = cp;
    } else if (hardRegression || pass > 1 || (bestCheckpoint.passNumber === 0 && !isFirstValid)) {
      const rejectionDetail = hardRegressionReasons.length > 0
        ? 'Regression guard rejected: ' + hardRegressionReasons.join('; ')
        : `Fit ${multiObjective.engineeringFitIndex.toFixed(1)} did not improve over ${bestCheckpoint.multiObjective.engineeringFitIndex.toFixed(1)}`;
      emit(
        'Validating',
        pass,
        makeActivity(
          pass,
          'rollback',
          'warning',
          `Pass ${pass} was not retained. ${rejectionDetail}; keeping Pass ${bestCheckpoint.passNumber}.`,
        ),
        undefined,
        undefined,
        'Validating',
      );
    }

    // A user stop request takes priority over convergence. The progress callback above
    // may set shouldStop after receiving this checkpoint.
    if (opts.shouldStop?.()) {
      finalStatus = 'stopped-by-user';
      stopReason = `Stopped by engineer override after pass ${pass}.`;
      emit('Stopped', pass, makeActivity(pass, 'halted', 'warning', stopReason), undefined, undefined, 'Stopped');
      break;
    }

    // Check convergence / early stop.
    // VERIFY FIX: convergence used to be judged on the pass just rendered even when that
    // pass had been REJECTED by the regression guards. The run then reported "Converged"
    // while the chain actually delivered was an older pass that never met the targets.
    // Convergence is now judged only on the retained best pass, using the objective gate
    // measured on its rendered audio.
    // STOP-ON-PASS: a retained render is complete only when every blocking objective
    // target AND every blocking QC check passes. Warnings remain non-blocking advisories;
    // QC failures must never be relabelled as a clean master merely because LUFS/peak pass.
    const bestIsThisPass = bestCheckpoint === cp;
    const mudStillOpen = postDiagnosis.findings.some((f) => f.id === 'diag-mud');
    if (bestIsThisPass && targetGate.passed && qcReport.failCount === 0 && !hasActionablePostFixFindings(passVerification)) {
      if (cp.iterationSummary) cp.iterationSummary.outcome = 'converged';
      finalStatus = 'converged';
      stopReason = `Converged on Pass ${pass}: all objective targets, blocking QC checks, and actionable post-fix findings pass (LUFS ${post.integratedLufs.toFixed(1)}, True Peak ${post.truePeakDb.toFixed(2)} dBTP, clips ${post.clippedSamples}, clicks ${post.clickCount ?? 0}).${mudStillOpen ? ' Low-mid density remains as an advisory note.' : ''}${qcReport.warningCount > 0 ? ` ${qcReport.warningCount} non-blocking QC warning(s) remain.` : ''}`;
      emit('Completed', pass, makeActivity(pass, 'complete', 'verified-result', stopReason), undefined, undefined, 'Completed');
      break;
    }

    // A plateau is only a reason to stop once the retained pass already meets the gate;
    // otherwise keep iterating until the pass cap, the budget, or no safe command remains.
    const bestVerification = verifyPostFixAnalysis({
      baselineAnalysis: preAnalysis,
      baselineDiagnosis: plan.diagnosis,
      postAnalysis: bestCheckpoint.analysis,
      objective,
      referenceAnalysis: opts.referenceAnalysis,
      baselineAnalysisId: 'baseline',
      postAnalysisId: `best-pass-${bestCheckpoint.passNumber}`,
      currentChainFingerprint: computeChainFingerprint(bestCheckpoint.chain),
      postChainFingerprint: computeChainFingerprint(bestCheckpoint.chain),
      postProcessingStatus: 'ready',
    });
    const bestGateNow = Boolean(bestCheckpoint.targetGate?.passed) &&
      bestCheckpoint.passNumber > 0 &&
      bestCheckpoint.qcReport.failCount === 0 &&
      !hasActionablePostFixFindings(bestVerification);
    if (pass > 1 && bestGateNow && !mudStillOpen && Math.abs(multiObjective.engineeringFitIndex - lastFit) < convergenceThreshold) {
      finalStatus = 'completed';
      stopReason = `Stopped safely after Pass ${pass}: retained Pass ${bestCheckpoint.passNumber} meets the objective gate and further refinement reached a plateau (ΔFit ${(multiObjective.engineeringFitIndex - lastFit).toFixed(2)} < ${convergenceThreshold}).`;
      emit('Completed', pass, makeActivity(pass, 'complete', 'verified-result', stopReason), undefined, undefined, 'Completed');
      break;
    }
    lastFit = multiObjective.engineeringFitIndex;

    // Derive next refinement if another pass remains
    if (pass < loopMax) {
      emit('Optimizing', pass, undefined, undefined, workingChain, 'Optimizing');
      let nextChainFromAi: ProcessorModule[] | null = null;
      let aiProducedBy = 'cloud AI';
      const remainingFindings = [
        ...passVerification.activeFindings.map((finding) => ({
          findingId: finding.findingId,
          title: finding.originalFinding.title,
          status: finding.status,
          detail: finding.remainingDeviation ?? finding.verificationSummary,
          recommendedAction: finding.nextRecommendedAction ?? finding.originalFinding.recommendedAction,
          measurementReliable: finding.measurementReliable,
        })),
        ...passVerification.newlyIntroducedFindings.map((finding) => ({
          findingId: finding.id,
          title: finding.title,
          status: 'NEW',
          detail: finding.evidence.join(' · ') || finding.explanation,
          recommendedAction: finding.recommendedAction,
          measurementReliable: true,
        })),
      ];
      let stoppedDuringAiRefine = false;
      let refineTraceMeta: AiRefineSuggestion['trace'] | undefined;
      let refineValidationFailedDetail: string | undefined;
      let refineErrorDetail: string | undefined;
      let refineAiReturnedModules: ProcessorModule['type'][] = [];
      if (opts.aiRefineCallback) {
        try {
          const rawSuggestion = await opts.aiRefineCallback({
            preAnalysis,
            postAnalysis: post,
            currentChain: workingChain,
            objective: opts.objectiveId,
            ...(opts.mode ? { mode: opts.mode } : {}),
            referenceAnalysis: opts.referenceAnalysis,
            remainingFindings,
            targetLufs: objective.targetLufs,
            targetTruePeakDb: objective.maxTruePeakDb,
            preserveDynamics: objective.preserveTransients,
            qcReport,
            targetGate,
          });
          if (opts.shouldStop?.()) {
            stoppedDuringAiRefine = true;
          } else {
            const suggestion: AiRefineSuggestion = Array.isArray(rawSuggestion) || rawSuggestion === null
              ? { chain: rawSuggestion }
              : rawSuggestion;
            refineTraceMeta = suggestion.trace;
            if (refineTraceMeta?.aiReturnedModules) {
              refineAiReturnedModules = [...refineTraceMeta.aiReturnedModules];
            }
            for (const notice of suggestion.notices ?? []) {
              emit('Optimizing', pass, makeActivity(pass, 'refine', 'warning', notice), undefined, undefined, 'Optimizing');
            }
            if (suggestion.producedBy) {
              aiProducedBy = suggestion.producedBy;
            }
            const candidateAiChain = suggestion.chain;
            if (candidateAiChain) {
              if (refineAiReturnedModules.length === 0) {
                refineAiReturnedModules = candidateAiChain.map((m) => m.type);
              }
              const invCheck = validateChainAgainstInventory(candidateAiChain);
              if (invCheck.valid) {
                nextChainFromAi = prepareChain(
                  mergeAiChainWithRequiredModules(invCheck.sanitizedChain, opts.leadModules ?? []),
                  true,
                );
              } else {
                refineValidationFailedDetail = invCheck.errors[0] ?? 'schema violation';
                emit(
                  'Optimizing',
                  pass,
                  makeActivity(
                    pass,
                    'refine',
                    'warning',
                    `Rejected out-of-inventory AI refinement (${refineValidationFailedDetail}); falling back to deterministic DSP Director.`,
                  ),
                  undefined,
                  undefined,
                  'Optimizing',
                );
              }
            }
          }
        } catch (err) {
          if (opts.shouldStop?.()) {
            stoppedDuringAiRefine = true;
          } else {
            refineErrorDetail = err instanceof Error ? err.message : 'unavailable';
            emit(
              'Optimizing',
              pass,
              makeActivity(
                pass,
                'refine',
                'warning',
                `AI refinement skipped (${refineErrorDetail}); continuing with deterministic DSP Director remediation.`,
              ),
              undefined,
              undefined,
              'Optimizing',
            );
          }
        }
      }

      if (stoppedDuringAiRefine || opts.shouldStop?.()) {
        finalStatus = 'stopped-by-user';
        stopReason = `Stopped by engineer override after pass ${pass}.`;
        emit('Stopped', pass, makeActivity(pass, 'halted', 'warning', stopReason), undefined, undefined, 'Stopped');
        break;
      }

      if (nextChainFromAi && nextChainFromAi.length > 0) {
        // AI is allowed to propose the complete chain, but it cannot bypass deterministic
        // repairs for measured blocking gates. Merge those repairs into the AI candidate,
        // then let the next real render and measurement decide whether they worked.
        const gateFix = deriveGateRepairCommands(targetGate, nextChainFromAi, post);
        if (gateFix.commands.length > 0) {
          const repaired = applyStructuredChainCommands(nextChainFromAi, gateFix.commands);
          if (repaired.appliedCount > 0) {
            nextChainFromAi = repaired.chain;
            emit(
              'Optimizing',
              pass,
              makeActivity(
                pass,
                'refine',
                'command',
                `Applied ${repaired.appliedCount} deterministic objective-gate repair(s) alongside the AI refinement.`,
                gateFix.reasons.join(' · '),
              ),
              undefined,
              nextChainFromAi,
              'Optimizing',
            );
          }
        }
        const defaultSource: AiCallSource = aiProducedBy.toLowerCase().includes('gemini') ? 'gemini-cloud' : 'byo-provider';
        const refineTrace: AiPassTrace = {
          pass,
          stage: 'refine',
          source: refineTraceMeta?.source ?? defaultSource,
          fallbackReason: refineTraceMeta?.fallbackReason ?? null,
          ...(refineTraceMeta?.fallbackDetail ? { fallbackDetail: refineTraceMeta.fallbackDetail } : {}),
          modelName: refineTraceMeta?.modelName ?? null,
          responseTimeMs: refineTraceMeta?.responseTimeMs ?? null,
          promptChars: refineTraceMeta?.promptChars ?? null,
          timeoutHit: refineTraceMeta?.timeoutHit ?? null,
          aiReturnedModules: refineAiReturnedModules,
          finalRenderedModules: nextChainFromAi.map((m) => m.type),
        };
        aiPasses.push(refineTrace);
        pendingAiTrace = refineTrace;
        if (renderedChainKeys.has(chainRenderKey(nextChainFromAi))) {
          pendingAiTrace = null;
          finalStatus = 'completed';
          const remainingQcFailures = qcReport.checks.filter((check) => check.status === 'fail');
          const qcDetail = remainingQcFailures.length > 0
            ? ` ${remainingQcFailures.length} blocking QC failure(s) remain: ${remainingQcFailures.map((check) => check.label).join(', ')}. The master is NOT fully verified.`
            : ' No blocking QC failures remain.';
          stopReason = `Stopped after Pass ${pass}: AI refinement plus deterministic gate repairs produced no new measurable chain.${targetGate.passed ? ' Objective targets pass.' : ` Objective targets still fail: ${targetGate.failed.map((check) => check.label).join(', ')}.`}${qcDetail}`;
          emit('Completed', pass, makeActivity(pass, 'complete', 'verified-result', stopReason), undefined, undefined, 'Completed');
          break;
        }
        workingChain = nextChainFromAi;
        emit(
          'Optimizing',
          pass,
          makeActivity(pass, 'refine', 'hypothesis', `Applied AI refinement suggested by ${aiProducedBy} for the next render pass (it is re-rendered and re-measured against the objective gate like any other candidate).`),
          undefined,
          workingChain,
          'Optimizing',
        );
      } else {
        // Refine from bestCheckpoint.chain so regression never compounds!
        const refinementSourceChain = bestCheckpoint.passNumber > 0 ? bestCheckpoint.chain : workingChain;
        const refinementSourcePost = bestCheckpoint.passNumber > 0 ? bestCheckpoint.analysis : post;
        const refinementSourceQc = bestCheckpoint.passNumber > 0 ? bestCheckpoint.qcReport : qcReport;
        const refinementSourceEval = bestCheckpoint.passNumber > 0 ? bestCheckpoint.multiObjective : multiObjective;

        const inferredFallbackReason: AiFallbackReason = !opts.aiRefineCallback
          ? 'user-disabled'
          : refineValidationFailedDetail
            ? 'validation'
            : refineTraceMeta?.fallbackReason ?? 'server-error';
        const inferredFallbackDetail = !opts.aiRefineCallback
          ? 'Cloud AI is turned off'
          : refineValidationFailedDetail ?? refineTraceMeta?.fallbackDetail ?? refineErrorDetail;
        const fallbackTrace: AiPassTrace = {
          pass,
          stage: 'refine',
          source: 'deterministic-director',
          fallbackReason: inferredFallbackReason,
          ...(inferredFallbackDetail ? { fallbackDetail: inferredFallbackDetail } : {}),
          modelName: refineTraceMeta?.modelName ?? null,
          responseTimeMs: refineTraceMeta?.responseTimeMs ?? null,
          promptChars: refineTraceMeta?.promptChars ?? null,
          timeoutHit: refineTraceMeta?.timeoutHit ?? null,
          aiReturnedModules: refineAiReturnedModules,
          finalRenderedModules: refinementSourceChain.map((m) => m.type),
        };
        aiPasses.push(fallbackTrace);
        pendingAiTrace = fallbackTrace;

        // eslint-disable-next-line prefer-const
        let { commands, hypothesis } = deriveRefinementCommands(
          preAnalysis,
          refinementSourcePost,
          refinementSourceChain,
          objective,
          refinementSourceQc,
          refinementSourceEval,
          { prevLufsError },
        );
        prevLufsError = objective.targetLufs - refinementSourcePost.integratedLufs;
        const refinementGate = bestCheckpoint.passNumber > 0 ? bestCheckpoint.targetGate : targetGate;
        if (refinementGate) {
          const gateFix = deriveGateRepairCommands(refinementGate, refinementSourceChain, refinementSourcePost);
          commands.push(...gateFix.commands);
          if (gateFix.reasons.length > 0) hypothesis = [hypothesis, ...gateFix.reasons].filter(Boolean).join(' · ');
        }

        if (commands.length === 0) {
          pendingAiTrace = null;
          finalStatus = 'completed';
          stopReason = `No additional safe parameter corrections were identified after Pass ${pass}. Any remaining deviations are reported for engineer review; the audio is not marked as perfect.`;
          emit('Completed', pass, makeActivity(pass, 'complete', 'verified-result', stopReason), undefined, undefined, 'Completed');
          break;
        }
        emit('Optimizing', pass, makeActivity(pass, 'refine', 'hypothesis', hypothesis), undefined, undefined, 'Optimizing');
        const applied = applyStructuredChainCommands(refinementSourceChain, commands);
        fallbackTrace.finalRenderedModules = applied.chain.map((m) => m.type);
        if (renderedChainKeys.has(chainRenderKey(applied.chain))) {
          pendingAiTrace = null;
          finalStatus = 'completed';
          stopReason = `Stopped after Pass ${pass}: the next correction would re-render a chain that was already measured (its parameters are at their limits), so another pass cannot change the result.`;
          emit('Completed', pass, makeActivity(pass, 'complete', 'verified-result', stopReason), undefined, undefined, 'Completed');
          break;
        }
        workingChain = applied.chain;
        emit(
          'Building chain',
          pass,
          makeActivity(
            pass,
            'chain',
            'command',
            `Executed ${applied.appliedCount} structured chain command(s) for Pass ${pass + 1}.`,
            commands.map((c) => `${c.op}:${'processorType' in c && c.processorType ? c.processorType : ''}`).join(', '),
          ),
          undefined,
          workingChain,
          'Building chain',
        );
      }
    }
  }

  let safeFallbackSelected = false;
  if (bestCheckpoint.passNumber === 0) {
    const safeFallback = selectBestSafeFallbackCheckpoint(
      baseCheckpoint,
      safeFallbackCandidates,
    );
    if (safeFallback) {
      bestCheckpoint = safeFallback;
      safeFallbackSelected = true;
      rolledBack = true;
      if (finalStatus === 'completed') finalStatus = 'rolled-back';
      stopReason =
        `${stopReason} Safely retained Pass ${safeFallback.passNumber} because it reduced blocking objective/QC failures without a hard regression. Its measured objective gate remains ${safeFallback.targetGate?.passed ? 'PASS' : 'NOT PASSED'}.`;
      emit(
        'Validating',
        safeFallback.passNumber,
        makeActivity(safeFallback.passNumber, 'rollback', 'warning', stopReason),
        undefined,
        undefined,
        'Validating',
      );
    }
  }

  if (finalStatus === 'completed' && loopMax > 0 && iterationsExecuted >= loopMax) {
    const bestMeetsTargets =
      Math.abs(bestCheckpoint.analysis.integratedLufs - objective.targetLufs) <= 0.65 &&
      bestCheckpoint.analysis.truePeakDb <= objective.maxTruePeakDb + 0.05 &&
      bestCheckpoint.qcReport.overallStatus === 'pass' &&
      bestCheckpoint.multiObjective.engineeringFitIndex >= 90;
    if (!bestMeetsTargets) {
      stopReason = `Reached the configured ${loopMax}-pass safety limit. Best validated pass #${bestCheckpoint.passNumber} was retained; remaining deviations are reported in post-fix verification.`;
    }
  }

  // Final rollback safeguard if final checkpoint wasn't the best
  const lastExecuted = checkpoints[checkpoints.length - 1];
  if (
    lastExecuted &&
    bestCheckpoint.passNumber !== lastExecuted.passNumber &&
    !safeFallbackSelected
  ) {
    rolledBack = true;
    if (finalStatus === 'completed') finalStatus = 'rolled-back';
    stopReason = bestCheckpoint.passNumber === 0
      ? 'All processing passes failed regression guards or quality comparisons; restored the untouched source baseline.'
      : `Automatically rolled back to best verified Pass ${bestCheckpoint.passNumber} (Fit ${bestCheckpoint.multiObjective.engineeringFitIndex.toFixed(1)}/100).`;
    emit(
      'Validating',
      bestCheckpoint.passNumber,
      makeActivity(bestCheckpoint.passNumber, 'rollback', 'warning', stopReason),
      undefined,
      undefined,
      'Validating',
    );
  }
  bestCheckpoint.isBest = true;

  // Final verification gate on the DELIVERED render. "Converged" is only reported when the
  // retained pass's re-measured audio meets every objective target.
  const finalGate =
    bestCheckpoint.targetGate ??
    evaluateMasterTargets(bestCheckpoint.analysis, objective, { preAnalysis, referenceAnalysis: opts.referenceAnalysis });
  const finalQcFailures = bestCheckpoint.qcReport.checks.filter((check) => check.status === 'fail');
  const finalPostFixVerification = verifyPostFixAnalysis({
    baselineAnalysis: preAnalysis,
    baselineDiagnosis: plan.diagnosis,
    postAnalysis: bestCheckpoint.passNumber > 0 ? bestCheckpoint.analysis : null,
    objective,
    referenceAnalysis: opts.referenceAnalysis,
    baselineAnalysisId: 'baseline',
    postAnalysisId: bestCheckpoint.passNumber > 0 ? `best-pass-${bestCheckpoint.passNumber}` : 'baseline',
    currentChainFingerprint: computeChainFingerprint(bestCheckpoint.chain),
    postChainFingerprint: bestCheckpoint.passNumber > 0 ? computeChainFingerprint(bestCheckpoint.chain) : undefined,
    postProcessingStatus: bestCheckpoint.passNumber > 0 ? 'ready' : 'idle',
  });
  if (finalStatus === 'converged' && (
    !finalGate.passed ||
    finalQcFailures.length > 0 ||
    hasActionablePostFixFindings(finalPostFixVerification)
  )) finalStatus = 'completed';
  if (finalStatus !== 'stopped-by-user') {
    const objectiveSummary = finalGate.passed
      ? 'all objective targets met on the delivered render'
      : `NOT all objective targets met. ${finalGate.summary}`;
    const qcSummary = finalQcFailures.length > 0
      ? `NOT fully verified: ${finalQcFailures.length} blocking QC failure(s) remain (${finalQcFailures.map((check) => check.label).join(', ')}).`
      : `no blocking QC failures remain.${bestCheckpoint.qcReport.warningCount > 0 ? ` ${bestCheckpoint.qcReport.warningCount} non-blocking QC warning(s) remain.` : ''}`;
    const technicalSummary = summarizeActionablePostFixFindings(finalPostFixVerification);
    const sourceLimitations = finalPostFixVerification.activeFindings.filter((finding) =>
      SOURCE_LIMITATION_FINDING_IDS.has(finding.findingId),
    );
    const sourceSummary = sourceLimitations.length > 0
      ? ` ${sourceLimitations.length} pre-existing source limitation(s) remain visible; they cannot be reconstructed by this mastering chain.`
      : '';
    stopReason = `${stopReason} Final verification: ${objectiveSummary}; ${qcSummary}; ${technicalSummary}${sourceSummary}`;
  }

  emit(
    finalStatus === 'stopped-by-user' ? 'Stopped' : 'Completed',
    bestCheckpoint.passNumber,
    undefined,
    undefined,
    bestCheckpoint.chain,
    finalStatus === 'stopped-by-user' ? 'Stopped' : 'Completed',
  );

  const finalReport = buildFinalReportFromState({
    operatingMode: opts.operatingMode,
    objective,
    status: finalStatus,
    stopReason,
    iterationsExecuted,
    bestCheckpoint,
    rolledBack,
    preAnalysis,
    referenceAnalysis: opts.referenceAnalysis,
    verificationBaselineAnalysis: opts.verificationBaselineAnalysis,
    verificationBaselineDiagnosis: opts.verificationBaselineDiagnosis,
    vocalBalanceVerification: opts.vocalBalanceVerification,
    stemAnalysis: resolvedStemAnalysis,
    stemChainsById: opts.stemChainsById,
    stemProcessingApplied,
    diagnosis: plan.diagnosis,
    recommendations: plan.recommendations,
    pluginSummary: plan.pluginSummary,
    checkpoints,
    activityLog,
    aiPasses,
  });
  finalReport.targetGate = finalGate;
  preventUnverifiedConvergence(finalReport);
  return finalReport;
}

/** Keep QC loudness / true-peak limits identical to the mastering objective. */
export function alignQcProfileToObjective(
  profile: QCTargetProfile,
  objective: ResolvedObjectiveTarget,
): QCTargetProfile {
  return {
    ...profile,
    id: `${profile.id}@${objective.id}`,
    name: `${objective.label} Delivery (${objective.targetLufs.toFixed(1)} LUFS / ${objective.maxTruePeakDb.toFixed(1)} dBTP)`,
    targetLufs: objective.targetLufs,
    lufsTolerance: Math.min(profile.lufsTolerance, objective.lufsTolerance),
    maxTruePeakDb: objective.maxTruePeakDb,
    minDynamicRangeDb: objective.minDynamicRangeDb,
  };
}

/**
 * Commands for gate failures the classic refinement path does not cover:
 * clicks/pops (Restore de-click / spike repair) and DC offset.
 */
export function deriveGateRepairCommands(
  gate: MasterTargetGate,
  chain: ProcessorModule[],
  post: AudioAnalysis,
): { commands: ChainCommand[]; reasons: string[] } {
  const commands: ChainCommand[] = [];
  const reasons: string[] = [];
  const failed = new Set(gate.failed.map((c) => c.id));
  const restoreMod = chain.find((m) => m.type === 'restore');
  const wantsClicks = failed.has('clicks');
  const wantsDc = failed.has('dc-offset');
  const wantsSubExcess = failed.has('sub-excess');
  // Crest-factor collapse: give transients back with a transient shaper before the limiter.
  if (failed.has('crest')) {
    const ts = chain.find((m) => m.type === 'transient-shaper');
    const limIdx = chain.findIndex((m) => m.type === 'limiter' || m.type === 'maximizer' || m.type === 'multiband-maximizer');
    if (ts) {
      const tp = ts.params as { attackDb: number };
      if (tp.attackDb < 6) {
        commands.push({ op: 'configure', targetId: ts.id, processorType: 'transient-shaper', paramsPatch: { attackDb: Math.min(6, tp.attackDb + 1.5) }, rationale: 'Restore transient punch lost to limiting (crest-factor gate).' });
        reasons.push(`Transient shaper attack +1.5 dB (crest ${post.crestFactorDb.toFixed(1)} dB)`);
      }
    } else {
      commands.push({
        op: 'add',
        processorType: 'transient-shaper',
        position: limIdx >= 0 ? limIdx : undefined,
        name: 'Transient Shaper (punch restore)',
        params: { attackDb: 2, sustainDb: 0, speedMs: 15, lowCutHz: 80 },
        rationale: 'Crest factor collapsed under limiting; add attack before the limiter.',
      });
      reasons.push('Add transient shaper before the limiter (crest-factor gate)');
    }
  }

  if (wantsSubExcess) {
    const subBassExcessDb = post.zoneEnergyDb.sub - post.zoneEnergyDb.bass;
    const subBassLimitDb = gate.failed.find((check) => check.id === 'sub-excess')?.targetValueDb ?? 0;
    const excessAboveLimitDb = Math.max(0, subBassExcessDb - subBassLimitDb);
    const reductionStepDb = Math.min(1.5, Math.max(0.15, excessAboveLimitDb * 0.5));
    const eqMod = chain.find((m) => m.type === 'parametric-eq' && m.enabled && !m.bypassed);
    const eqBands = eqMod ? ((eqMod.params as { bands?: EQBand[] }).bands ?? []) : [];
    const controlBandIndex = eqBands.findIndex((band) => band.id === 'syn-sub-excess');
    const existingControlBand = controlBandIndex >= 0 ? eqBands[controlBandIndex] : null;
    const correctionFreqHz =
      existingControlBand?.shape === 'bell' && existingControlBand.freq >= 20 && existingControlBand.freq <= 60
        ? existingControlBand.freq
        : findSubBassCorrectionHz(post);
    const nextBand: EQBand = existingControlBand
      ? {
          ...existingControlBand,
          enabled: true,
          shape: 'bell',
          freq: correctionFreqHz,
          q: 1.0,
          gain: Math.max(-12, existingControlBand.gain - reductionStepDb),
        }
      : {
          id: 'syn-sub-excess',
          enabled: true,
          shape: 'bell',
          freq: correctionFreqHz,
          gain: -Math.min(8, Math.max(0.25, excessAboveLimitDb * 0.75)),
          q: 1.0,
        };

    if (eqMod && (controlBandIndex >= 0 || eqBands.length < 8)) {
      const bands = controlBandIndex >= 0
        ? eqBands.map((band, index) => index === controlBandIndex ? nextBand : band)
        : [...eqBands, nextBand];
      commands.push({
        op: 'configure',
        targetId: eqMod.id,
        processorType: 'parametric-eq',
        paramsPatch: { bands },
        rationale: `Reduce measured Sub/Bass excess above the +${subBassLimitDb.toFixed(1)} dB objective limit with a ${nextBand.freq} Hz spectrum-centered bell at ${nextBand.gain.toFixed(1)} dB.`,
      });
      reasons.push(`${nextBand.freq} Hz Sub/Bass bell ${nextBand.gain.toFixed(1)} dB (measured +${subBassExcessDb.toFixed(1)} dB; objective limit +${subBassLimitDb.toFixed(1)} dB)`);
    } else {
      const dynamicsIndex = chain.findIndex((m) =>
        m.type === 'compressor' || m.type === 'multiband-comp' || m.type === 'limiter' ||
        m.type === 'maximizer' || m.type === 'multiband-maximizer',
      );
      commands.push({
        op: 'add',
        processorType: 'parametric-eq',
        position: dynamicsIndex >= 0 ? dynamicsIndex : chain.length,
        name: 'Sub/Bass Excess Control',
        params: { phaseMode: 'minimum', msMode: 'stereo', tiltDb: 0, bands: [nextBand] },
        rationale: `Reduce measured 20-60 Hz Sub/Bass excess above the +${subBassLimitDb.toFixed(1)} dB objective limit with a spectrum-centered ${nextBand.freq} Hz bell, before dynamics.`,
      });
      reasons.push(`Add ${nextBand.freq} Hz Sub/Bass bell ${nextBand.gain.toFixed(1)} dB (measured +${subBassExcessDb.toFixed(1)} dB; objective limit +${subBassLimitDb.toFixed(1)} dB)`);
    }

    const bassEnhancer = chain.find((m) => m.type === 'bass-enhancer' && m.enabled && !m.bypassed);
    if (bassEnhancer) {
      const params = bassEnhancer.params as { subGainDb: number };
      if (params.subGainDb > 0) {
        commands.push({
          op: 'configure',
          targetId: bassEnhancer.id,
          processorType: 'bass-enhancer',
          paramsPatch: { subGainDb: 0 },
          rationale: 'Remove additive sub-band gain while the Sub/Bass excess gate is failing.',
        });
        reasons.push('Bass Enhancer sub gain set to 0 dB');
      }
    }
  }

  if (!wantsClicks && !wantsDc) return { commands, reasons };
  if (restoreMod) {
    const rp = restoreMod.params as RestoreParams;
    const patch: Partial<RestoreParams> = {};
    if (wantsClicks) {
      patch.declick = Math.min(100, Math.max(40, (rp.declick ?? 0) + 25));
      patch.decrackle = Math.min(80, Math.max(20, (rp.decrackle ?? 0) + 15));
      patch.spikeRepair = true;
      reasons.push(`De-click ${patch.declick}% / de-crackle ${patch.decrackle}% for ${post.clickCount ?? 0} measured click(s)`);
    }
    if (wantsDc) {
      patch.dcOffset = true;
      reasons.push('DC offset removal on');
    }
    commands.push({
      op: 'configure',
      targetId: restoreMod.id,
      processorType: 'restore',
      paramsPatch: patch,
      rationale: reasons.join('; '),
    });
  } else {
    const params: RestoreParams = {
      dcOffset: wantsDc,
      humRemovalHz: 0,
      hissReduction: 0,
      deEssAmount: 0,
      deEssFreqHz: 6800,
      resonanceSuppress: 0,
      mode: 'conservative',
      declick: wantsClicks ? 55 : 0,
      decrackle: wantsClicks ? 25 : 0,
      spikeRepair: wantsClicks,
      deShimmer: 0,
    };
    commands.push({
      op: 'add',
      processorType: 'restore',
      position: 0,
      name: 'SYN-Repair (De-click / DC)',
      params,
      rationale: 'Prepend repair stage: measured clicks/pops or DC offset fail the objective gate.',
    });
    reasons.push(wantsClicks ? `Add de-click for ${post.clickCount ?? 0} measured click(s)` : 'Add DC offset removal');
  }
  return { commands, reasons };
}
