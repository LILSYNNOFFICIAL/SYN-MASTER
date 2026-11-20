import type {
  AnalysisFinding,
  AudioAnalysis,
  DirectorDiagnosisReport,
  MasteringObjectiveId,
  ResolvedObjectiveTarget,
} from '../types/mastering';

/**
 * Compute power-averaged spectral energy (dB) across a target frequency window [minHz, maxHz]
 * directly from real FFT spectrum bins in AudioAnalysis.
 */
export function computeRegionEnergyDb(
  analysis: AudioAnalysis,
  minHz: number,
  maxHz: number,
): number | null {
  const freqs = analysis.spectrumBinsFreq;
  const dbs = analysis.spectrumBinsDb;
  if (!freqs || !dbs || freqs.length === 0 || freqs.length !== dbs.length) {
    return null;
  }
  let powerSum = 0;
  let count = 0;
  for (let i = 0; i < freqs.length; i++) {
    const f = freqs[i];
    const db = dbs[i];
    if (f >= minHz && f <= maxHz && Number.isFinite(db)) {
      powerSum += Math.pow(10, db / 10);
      count++;
    }
  }
  if (count === 0) return null;
  return 10 * Math.log10(Math.max(1e-12, powerSum / count));
}

/**
 * Verifies that an AudioAnalysis object contains valid, finite, non-corrupted measurements
 * derived from a real non-silent audio signal.
 */
export function isAnalysisMeasurementReliable(
  analysis: AudioAnalysis | null | undefined,
): analysis is AudioAnalysis {
  if (!analysis) return false;
  const requiredFinite = [
    analysis.durationSec,
    analysis.sampleRate,
    analysis.integratedLufs,
    analysis.shortTermLufsMax,
    analysis.rmsDb,
    analysis.samplePeakDb,
    analysis.truePeakDb,
    analysis.dynamicRangeDb,
    analysis.crestFactorDb,
    analysis.plrDb,
    analysis.spectralCentroidHz,
    analysis.spectralSlopeDbPerOct,
    analysis.phaseCorrelation,
    analysis.lowEndCorrelation,
    analysis.lrBalanceDb,
    analysis.thdEstimatePercent,
    analysis.noiseFloorDb,
    analysis.dcOffset,
  ];
  if (requiredFinite.some((v) => !Number.isFinite(v))) return false;
  if (analysis.durationSec <= 0 || analysis.sampleRate < 8000) return false;
  if (!analysis.spectrumBinsFreq?.length || !analysis.spectrumBinsDb?.length) return false;
  if (analysis.rmsDb <= -85 && analysis.samplePeakDb <= -75) return false;
  return true;
}

export interface DiagnosisThresholds {
  bassMidDiffLimit: number;
  lowMidBuildupLimit: number;
  region150To400VsMidLimit: number;
  subExcessLimit: number;
  harshExcessLimit: number;
  dynamicRangeMin: number;
  noiseFloorMax: number;
  dcOffsetMax: number;
  phaseCorrMin: number;
  lowEndCorrMin: number;
  lrBalanceMax: number;
  thdMaxPercent: number;
}

export function getDiagnosisThresholds(
  objective: MasteringObjectiveId | ResolvedObjectiveTarget,
): DiagnosisThresholds {
  const objectiveId = typeof objective === 'string' ? objective : objective.id;
  const bassHeavyStyle =
    objectiveId === 'hip-hop' ||
    objectiveId === 'electronic' ||
    objectiveId === 'warm' ||
    objectiveId === 'cinematic' ||
    objectiveId === 'punchy';
  const brightStyle = objectiveId === 'pop' || objectiveId === 'electronic';
  const loudStyle =
    objectiveId === 'commercial-loudness' ||
    objectiveId === 'electronic' ||
    objectiveId === 'hip-hop';

  return {
    bassMidDiffLimit: bassHeavyStyle ? 14.5 : 11.5,
    lowMidBuildupLimit: bassHeavyStyle ? 5.2 : 4.8,
    region150To400VsMidLimit: bassHeavyStyle ? 7.2 : 6.8,
    subExcessLimit: bassHeavyStyle ? 5.5 : 4.5,
    harshExcessLimit: brightStyle ? 3.8 : 3.2,
    dynamicRangeMin: loudStyle ? 4.8 : 5.5,
    noiseFloorMax: -48,
    dcOffsetMax: 0.004,
    phaseCorrMin: 0.1,
    lowEndCorrMin: 0.35,
    lrBalanceMax: 0.8,
    thdMaxPercent: 2.2,
  };
}

/**
 * SYN-ANALYZE Intelligence
 * Distinguishes factual observations, intentional artistic characteristics,
 * and genuine technical/mastering problems from real AudioAnalysis telemetry.
 */
export function analyzeTrackIntelligence(
  analysis: AudioAnalysis,
  objective: MasteringObjectiveId | ResolvedObjectiveTarget,
  reference?: AudioAnalysis | null,
): DirectorDiagnosisReport {
  const workingWell: string[] = [];
  const findings: AnalysisFinding[] = [];
  const objectiveId = typeof objective === 'string' ? objective : objective.id;
  const thresholds = getDiagnosisThresholds(objective);

  const bassMidDiff = analysis.zoneEnergyDb.bass - analysis.zoneEnergyDb.mid;
  const lowMidBuildup = analysis.zoneEnergyDb.lowMid - analysis.zoneEnergyDb.mid;
  const harshExcess = analysis.zoneEnergyDb.highMid - analysis.zoneEnergyDb.mid;
  const subExcess = analysis.zoneEnergyDb.sub - analysis.zoneEnergyDb.bass;
  const region150To400Db = computeRegionEnergyDb(analysis, 150, 400);
  const region150To400VsMid =
    region150To400Db !== null ? region150To400Db - analysis.zoneEnergyDb.mid : null;
  const nf = analysis.noiseFloorDb ?? -72;

  // 1. Digital Clipping & Inter-Sample Peaks (Technical problem)
  if (analysis.clippedSamples > 0 || analysis.truePeakDb > -0.1 || analysis.interSamplePeaks > 0) {
    findings.push({
      id: 'diag-clipping',
      kind: 'technical-problem',
      category: 'Integrity',
      title: 'Clipped Samples or Inter-Sample Ceiling Overshoot',
      severity: analysis.clippedSamples > 0 || analysis.truePeakDb > 0.2 ? 'high' : 'moderate',
      evidence: [
        `Clipped Samples: ${analysis.clippedSamples}`,
        `True Peak: ${analysis.truePeakDb.toFixed(2)} dBTP`,
        `Inter-Sample Peaks (>0 dBTP): ${analysis.interSamplePeaks}`,
      ],
      metrics: {
        clippedSamples: analysis.clippedSamples,
        truePeakDb: analysis.truePeakDb,
        samplePeakDb: analysis.samplePeakDb,
        interSamplePeaks: analysis.interSamplePeaks,
      },
      explanation:
        'Full-scale clipping or positive inter-sample peaks risk audible digital breakup on D/A converters and lossy streaming codecs.',
      recommendedAction: 'Apply pre-limiter input headroom trim and enforce 4x oversampled True Peak ceiling.',
    });
  } else {
    workingWell.push(
      `Clean headroom margin (True Peak ${analysis.truePeakDb.toFixed(2)} dBTP, 0 clipped samples).`,
    );
  }

  // 2. DC Offset (Technical problem)
  if (analysis.dcOffset >= thresholds.dcOffsetMax) {
    findings.push({
      id: 'diag-dc',
      kind: 'technical-problem',
      category: 'Integrity',
      title: 'DC Offset Waveform Asymmetry',
      severity: analysis.dcOffset > 0.01 ? 'high' : 'low',
      evidence: [`DC Offset: ${(analysis.dcOffset * 100).toFixed(3)}%`],
      metrics: {
        dcOffsetPercent: analysis.dcOffset * 100,
      },
      explanation:
        'Asymmetric DC bias wastes limiter headroom and can introduce clicks at edits or low-frequency speaker excursion.',
      recommendedAction: 'Enable SYN-Restore DC Offset removal and subsonic 26–30 Hz high-pass filter.',
    });
  }

  // 3. Elevated Broadband Noise Floor (Technical problem when quiet frames separate >=12 dB from program RMS)
  if (nf > thresholds.noiseFloorMax && analysis.rmsDb > -40 && analysis.rmsDb - nf >= 12) {
    findings.push({
      id: 'diag-noise',
      kind: 'technical-problem',
      category: 'Noise',
      title: 'Elevated Quiet-Passage Noise Floor',
      severity: nf > -38 ? 'high' : 'moderate',
      evidence: [
        `Estimated Noise Floor (5th pct 50ms RMS): ${nf.toFixed(1)} dBFS`,
        `Program RMS: ${analysis.rmsDb.toFixed(1)} dBFS`,
      ],
      metrics: {
        noiseFloorDb: nf,
        rmsDb: analysis.rmsDb,
      },
      explanation:
        'Bringing up overall loudness via limiting/compression will raise the audibility of steady hiss or mains hum.',
      recommendedAction: 'Insert conservative SYN-Restore cleanup prior to dynamics & maximization.',
    });
  } else {
    workingWell.push(
      analysis.rmsDb - nf < 12
        ? 'Continuous sustained program without exposed noise floor.'
        : `Low background noise floor (${nf.toFixed(1)} dBFS).`,
    );
  }

  // 4. Low-End Stereo Phase & Mono Compatibility (Technical problem vs Intentional wide mix)
  if (
    analysis.phaseCorrelation < thresholds.phaseCorrMin ||
    analysis.lowEndCorrelation < thresholds.lowEndCorrMin
  ) {
    findings.push({
      id: 'diag-phase',
      kind: 'technical-problem',
      category: 'Stereo',
      title: 'Low-End Phase Cancellation / Weak Mono Coherence',
      severity: analysis.phaseCorrelation < 0 || analysis.lowEndCorrelation < 0.15 ? 'high' : 'moderate',
      evidence: [
        `Global Phase Corr: ${analysis.phaseCorrelation.toFixed(2)}`,
        `Sub-120 Hz Low-End Corr: ${analysis.lowEndCorrelation.toFixed(2)}`,
        `Mono Compatibility Score: ${analysis.monoCompatibilityScore}/100`,
      ],
      metrics: {
        phaseCorrelation: analysis.phaseCorrelation,
        lowEndCorrelation: analysis.lowEndCorrelation,
        monoCompatibilityScore: analysis.monoCompatibilityScore,
      },
      explanation:
        'Out-of-phase bass energy or excessive mid-band phase cancellation will hollow out on mono club systems and smart speakers.',
      recommendedAction: 'Engage Stereo Imager Mono Bass (<95–115 Hz) and rein in excessive mid/low stereo width.',
    });
  } else if (analysis.stereoWidth > 0.92 && analysis.phaseCorrelation >= 0.3 && analysis.lowEndCorrelation >= 0.5) {
    findings.push({
      id: 'diag-wide-artistic',
      kind: 'artistic-choice',
      category: 'Stereo',
      title: 'Deliberately Wide Stereo Presentation',
      severity: 'info',
      evidence: [
        `Stereo Width: ${(analysis.stereoWidth * 100).toFixed(0)}%`,
        `Phase Corr: ${analysis.phaseCorrelation.toFixed(2)}`,
        `Low-End Corr: ${analysis.lowEndCorrelation.toFixed(2)}`,
      ],
      explanation:
        'The mix uses wide upper-frequency ambience while keeping low frequencies phase-coherent. Preserve this width unless target explicitly calls for narrow focus.',
    });
    workingWell.push(
      `Wide stereo field (${(analysis.stereoWidth * 100).toFixed(0)}%) remains phase-safe (+${analysis.phaseCorrelation.toFixed(2)} corr).`,
    );
  } else {
    workingWell.push(
      `Solid stereo coherence (Phase ${analysis.phaseCorrelation.toFixed(2)}, Low-End ${analysis.lowEndCorrelation.toFixed(2)}).`,
    );
  }

  // 5. L/R Balance Skew
  if (Math.abs(analysis.lrBalanceDb) > thresholds.lrBalanceMax) {
    findings.push({
      id: 'diag-lr-skew',
      kind: 'technical-problem',
      category: 'Stereo',
      title: 'Left/Right Channel Energy Skew',
      severity: Math.abs(analysis.lrBalanceDb) > 1.5 ? 'moderate' : 'low',
      evidence: [`L/R Balance: ${analysis.lrBalanceDb >= 0 ? '+' : ''}${analysis.lrBalanceDb.toFixed(2)} dB`],
      metrics: {
        lrBalanceAbsDb: Math.abs(analysis.lrBalanceDb),
        lrBalanceDb: analysis.lrBalanceDb,
      },
      explanation: 'Persistent channel imbalance pulls the stereo center toward one speaker.',
      recommendedAction: `Trim Stereo Imager L/R Balance by ${(-analysis.lrBalanceDb * 0.7).toFixed(2)} dB.`,
    });
  }

  // 6. Spectral Tilt & Low-Mid Buildup:
  // Distinguish intentionally bass-heavy/dark mix with clean midrange clarity from genuine 150–400 Hz mud masking.
  const isWarmTilt = analysis.spectralSlopeDbPerOct < -1.8 && analysis.spectralSlopeDbPerOct >= -4.2;
  const lowMidMasking =
    lowMidBuildup > thresholds.lowMidBuildupLimit ||
    (region150To400VsMid !== null && region150To400VsMid > thresholds.region150To400VsMidLimit);
  const excessiveLowEndOverflow =
    bassMidDiff > thresholds.bassMidDiffLimit &&
    (lowMidBuildup > 2.6 || subExcess > thresholds.subExcessLimit);
  const hasHeavyMud = lowMidMasking || excessiveLowEndOverflow;

  if (hasHeavyMud) {
    const regionStr =
      region150To400VsMid !== null
        ? `150–400 Hz vs Mid delta: ${region150To400VsMid >= 0 ? '+' : ''}${region150To400VsMid.toFixed(1)} dB (${region150To400Db!.toFixed(1)} dB avg)`
        : 'Problematic region: 150–400 Hz';
    findings.push({
      id: 'diag-mud',
      kind: 'technical-problem',
      category: 'Spectral',
      title: 'Low-Mid / Sub-Bass Buildup Masking Midrange',
      severity:
        lowMidBuildup > 6.0 ||
        bassMidDiff > 13 ||
        (region150To400VsMid !== null && region150To400VsMid > 7.5)
          ? 'high'
          : 'moderate',
      evidence: [
        `Bass vs Mid delta: ${bassMidDiff >= 0 ? '+' : ''}${bassMidDiff.toFixed(1)} dB`,
        `Low-Mid vs Mid delta: ${lowMidBuildup >= 0 ? '+' : ''}${lowMidBuildup.toFixed(1)} dB`,
        `Sub vs Bass delta: ${subExcess >= 0 ? '+' : ''}${subExcess.toFixed(1)} dB`,
        regionStr,
      ],
      metrics: {
        bassMidDiff,
        lowMidBuildup,
        subExcess,
        subDb: analysis.zoneEnergyDb.sub,
        bassDb: analysis.zoneEnergyDb.bass,
        lowMidDb: analysis.zoneEnergyDb.lowMid,
        midDb: analysis.zoneEnergyDb.mid,
        ...(region150To400Db !== null ? { region150To400Db } : {}),
        ...(region150To400VsMid !== null ? { region150To400VsMid } : {}),
      },
      explanation:
        'Excessive 150–400 Hz energy clouds vocal/snare clarity and forces the limiter to pump on bass notes.',
      recommendedAction: 'Apply surgical 260–340 Hz bell cut and subsonic 28 Hz high-pass filter.',
    });
  } else if (bassMidDiff > 7.5 && lowMidBuildup <= thresholds.lowMidBuildupLimit) {
    findings.push({
      id: 'diag-bass-heavy-clean',
      kind: 'artistic-choice',
      category: 'Spectral',
      title: 'Naturally Bass-Heavy Foundation (Clean Midrange Separation)',
      severity: 'info',
      evidence: [
        `Bass vs Mid delta: +${bassMidDiff.toFixed(1)} dB`,
        `Low-Mid vs Mid delta: ${lowMidBuildup >= 0 ? '+' : ''}${lowMidBuildup.toFixed(1)} dB`,
        ...(region150To400VsMid !== null
          ? [`150–400 Hz vs Mid: ${region150To400VsMid >= 0 ? '+' : ''}${region150To400VsMid.toFixed(1)} dB`]
          : []),
      ],
      explanation:
        'Low-frequency weight sits cleanly below the 150–400 Hz mud region without masking vocal/snare midrange articulation. Avoid unnecessary bass attenuation.',
    });
  } else if (
    lowMidBuildup < -4.8 &&
    (region150To400VsMid === null || region150To400VsMid < -3.5) &&
    bassMidDiff < 4.0
  ) {
    findings.push({
      id: 'diag-hollow-lowmid',
      kind: 'technical-problem',
      category: 'Spectral',
      title: 'Over-Cut Low-Mid / Hollow Tonal Imbalance',
      severity:
        lowMidBuildup < -7.0 || (region150To400VsMid !== null && region150To400VsMid < -5.5)
          ? 'high'
          : 'moderate',
      evidence: [
        `Low-Mid vs Mid delta: ${lowMidBuildup.toFixed(1)} dB`,
        ...(region150To400VsMid !== null
          ? [`150–400 Hz vs Mid delta: ${region150To400VsMid.toFixed(1)} dB`]
          : []),
        `Bass vs Mid delta: ${bassMidDiff >= 0 ? '+' : ''}${bassMidDiff.toFixed(1)} dB`,
      ],
      metrics: {
        lowMidBuildup,
        bassMidDiff,
        ...(region150To400VsMid !== null ? { region150To400VsMid } : {}),
      },
      explanation:
        'Excessive attenuation across 150–450 Hz strips vocal body, snare weight, and warm harmonic glue, leaving a thin or scooped tonal balance.',
      recommendedAction:
        'Reduce 150–400 Hz EQ cut depth by 3–6 dB or narrow filter Q to restore natural midrange body.',
    });
  } else if (isWarmTilt && harshExcess < 2.0) {
    findings.push({
      id: 'diag-dark-artistic',
      kind: 'artistic-choice',
      category: 'Spectral',
      title: 'Warm / Dark Aesthetic Tonal Tilt (No Mud Masking)',
      severity: 'info',
      evidence: [
        `Spectral Slope: ${analysis.spectralSlopeDbPerOct.toFixed(2)} dB/oct`,
        `Spectral Centroid: ${analysis.spectralCentroidHz} Hz`,
        `Low-Mid vs Mid: ${lowMidBuildup.toFixed(1)} dB`,
      ],
      explanation:
        objectiveId === 'warm' || objectiveId === 'transparent'
          ? 'The downward spectral slope appears intentional and balanced without low-mid mud. Avoid aggressive brightening that could erase the dark character.'
          : 'Mix has a warm downward tilt; apply only subtle upper-air lift if brightness target demands it.',
    });
  }

  const upperResonance = analysis.resonances.find((r) => r.freqHz >= 2000 && r.excessDb >= 6.5);
  if (harshExcess > thresholds.harshExcessLimit || upperResonance) {
    const topRes = upperResonance ?? analysis.resonances[0];
    findings.push({
      id: 'diag-harsh',
      kind: 'technical-problem',
      category: 'Spectral',
      title: 'Upper-Mid Harshness or Narrow Resonance Peaks',
      severity: harshExcess > 5.0 || (topRes?.excessDb ?? 0) > 8.0 ? 'high' : 'moderate',
      evidence: [
        `High-Mid vs Mid delta: ${harshExcess >= 0 ? '+' : ''}${harshExcess.toFixed(1)} dB`,
        ...(topRes ? [`Peak Resonance: ${topRes.freqHz} Hz (+${topRes.excessDb} dB)`] : []),
      ],
      metrics: {
        harshExcess,
        highMidDb: analysis.zoneEnergyDb.highMid,
        midDb: analysis.zoneEnergyDb.mid,
        topResonanceExcessDb: topRes?.excessDb ?? 0,
        topResonanceFreqHz: topRes?.freqHz ?? 0,
      },
      explanation:
        'Concentrated upper-mid spikes cause listener fatigue and exaggerate harshness when brought up to commercial loudness.',
      recommendedAction: 'Use Dynamic EQ on resonant peak bands so attenuation only engages during harsh transients.',
    });
  } else if (analysis.resonances.length === 0 && !hasHeavyMud) {
    workingWell.push('Smooth frequency distribution without severe narrow-band resonances.');
  }

  // 7. Dynamics & Transients (Observation vs Over-compressed vs Punchy artistic choice)
  if (analysis.dynamicRangeDb < thresholds.dynamicRangeMin) {
    findings.push({
      id: 'diag-overcompressed',
      kind: 'technical-problem',
      category: 'Dynamics',
      title: 'Pre-Compressed / Low Dynamic Headroom Source',
      severity: analysis.dynamicRangeDb < 4.0 ? 'high' : 'moderate',
      evidence: [
        `Dynamic Range: ${analysis.dynamicRangeDb.toFixed(1)} dB`,
        `Crest Factor: ${analysis.crestFactorDb.toFixed(1)} dB`,
        `LRA: ${analysis.loudnessRangeLu.toFixed(1)} LU`,
      ],
      metrics: {
        dynamicRangeDb: analysis.dynamicRangeDb,
        crestFactorDb: analysis.crestFactorDb,
        loudnessRangeLu: analysis.loudnessRangeLu,
      },
      explanation:
        'Source already exhibits dense compression. Heavy additional bus compression or brickwall limiting will crush micro-dynamics.',
      recommendedAction: 'Skip heavy bus compression; favor transient-preserving maximization or gentle upward polish.',
    });
  } else if (analysis.crestFactorDb > 12.5 && analysis.transientDensity > 0.35) {
    findings.push({
      id: 'diag-punchy-artistic',
      kind: 'artistic-choice',
      category: 'Dynamics',
      title: 'High-Crest Percussive / Dynamic Transient Profile',
      severity: 'info',
      evidence: [
        `Crest Factor: ${analysis.crestFactorDb.toFixed(1)} dB`,
        `Transient Density: ${(analysis.transientDensity * 100).toFixed(0)}%`,
        `DR: ${analysis.dynamicRangeDb.toFixed(1)} dB`,
      ],
      explanation:
        'Mix preserves strong drum/transient peaks. Compression should use slower attack (>= 20 ms) and sidechain HPF to retain punch.',
    });
    workingWell.push(`Expressive dynamic range (${analysis.dynamicRangeDb.toFixed(1)} dB DR) and punchy transients.`);
  } else {
    workingWell.push(
      `Balanced crest factor (${analysis.crestFactorDb.toFixed(1)} dB) and dynamic range (${analysis.dynamicRangeDb.toFixed(1)} dB).`,
    );
  }

  // 8. Harmonic Distortion Observation
  if (analysis.thdEstimatePercent > thresholds.thdMaxPercent) {
    findings.push({
      id: 'diag-thd',
      kind: 'technical-problem',
      category: 'Distortion',
      title: 'Elevated Pre-Existing Harmonic Distortion',
      severity: analysis.thdEstimatePercent > 5 ? 'high' : 'moderate',
      evidence: [`Estimated THD: ${analysis.thdEstimatePercent.toFixed(2)}%`],
      metrics: {
        thdEstimatePercent: analysis.thdEstimatePercent,
      },
      explanation: 'Source already contains noticeable harmonic saturation; avoid stacking aggressive saturation stages.',
      recommendedAction: 'Omit heavy saturation stages and prioritize clean surgical EQ/limiting.',
    });
  }

  // 9. Loudness Calibration Observation
  findings.push({
    id: 'diag-loudness-obs',
    kind: 'observation',
    category: 'Loudness',
    title: 'Baseline Integrated Loudness & Headroom Observation',
    severity: 'info',
    evidence: [
      `Integrated: ${analysis.integratedLufs.toFixed(1)} LUFS`,
      `Short-Term Max: ${analysis.shortTermLufsMax.toFixed(1)} LUFS`,
      `PLR: ${analysis.plrDb.toFixed(1)} dB`,
      ...(reference
        ? [`Reference Delta: ${(reference.integratedLufs - analysis.integratedLufs).toFixed(1)} LU`]
        : []),
    ],
    explanation: `Measured baseline loudness is ${analysis.integratedLufs.toFixed(1)} LUFS at ${analysis.rmsDb.toFixed(1)} dBFS RMS.`,
  });

  const artisticProfile = [
    analysis.spectralSlopeDbPerOct < -2.0 ? 'Warm/Dark Tilt' : analysis.spectralSlopeDbPerOct > -0.8 ? 'Bright/Modern' : 'Neutral Balance',
    analysis.transientDensity > 0.45 ? 'Transient-Rich' : 'Sustained/Dense',
    analysis.stereoWidth > 0.9 ? 'Wide Stage' : analysis.stereoWidth < 0.45 ? 'Focused/Narrow' : 'Balanced Stereo',
  ].join(' · ');

  return {
    workingWell,
    artisticProfile,
    findings,
  };
}

