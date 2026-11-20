import type {
  AnalysisFinding,
  AudioAnalysis,
  DirectorDiagnosisReport,
  MasteringObjectiveId,
  ResolvedObjectiveTarget,
} from '../types/mastering';

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

  const bassMidDiff = analysis.zoneEnergyDb.bass - analysis.zoneEnergyDb.mid;
  const lowMidBuildup = analysis.zoneEnergyDb.lowMid - analysis.zoneEnergyDb.mid;
  const harshExcess = analysis.zoneEnergyDb.highMid - analysis.zoneEnergyDb.mid;
  const subExcess = analysis.zoneEnergyDb.sub - analysis.zoneEnergyDb.bass;
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
  if (analysis.dcOffset >= 0.004) {
    findings.push({
      id: 'diag-dc',
      kind: 'technical-problem',
      category: 'Integrity',
      title: 'DC Offset Waveform Asymmetry',
      severity: analysis.dcOffset > 0.01 ? 'high' : 'low',
      evidence: [`DC Offset: ${(analysis.dcOffset * 100).toFixed(3)}%`],
      explanation:
        'Asymmetric DC bias wastes limiter headroom and can introduce clicks at edits or low-frequency speaker excursion.',
      recommendedAction: 'Enable SYN-Restore DC Offset removal and subsonic 26–30 Hz high-pass filter.',
    });
  }

  // 3. Elevated Broadband Noise Floor (Technical problem when quiet frames separate >=12 dB from program RMS)
  if (nf > -48 && analysis.rmsDb > -40 && analysis.rmsDb - nf >= 12) {
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
  if (analysis.phaseCorrelation < 0.1 || analysis.lowEndCorrelation < 0.35) {
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
  if (Math.abs(analysis.lrBalanceDb) > 0.8) {
    findings.push({
      id: 'diag-lr-skew',
      kind: 'technical-problem',
      category: 'Stereo',
      title: 'Left/Right Channel Energy Skew',
      severity: Math.abs(analysis.lrBalanceDb) > 1.5 ? 'moderate' : 'low',
      evidence: [`L/R Balance: ${analysis.lrBalanceDb >= 0 ? '+' : ''}${analysis.lrBalanceDb.toFixed(2)} dB`],
      explanation: 'Persistent channel imbalance pulls the stereo center toward one speaker.',
      recommendedAction: `Trim Stereo Imager L/R Balance by ${(-analysis.lrBalanceDb * 0.7).toFixed(2)} dB.`,
    });
  }

  // 6. Spectral Tilt: Distinguish intentionally dark/warm mix vs genuinely muddy/resonant problem
  const isWarmTilt = analysis.spectralSlopeDbPerOct < -1.8 && analysis.spectralSlopeDbPerOct >= -4.2;
  const hasHeavyMud = lowMidBuildup > 4.2 || bassMidDiff > 10.5;
  if (hasHeavyMud) {
    findings.push({
      id: 'diag-mud',
      kind: 'technical-problem',
      category: 'Spectral',
      title: 'Low-Mid / Sub-Bass Buildup Masking Midrange',
      severity: lowMidBuildup > 6.0 || bassMidDiff > 13 ? 'high' : 'moderate',
      evidence: [
        `Bass vs Mid delta: +${bassMidDiff.toFixed(1)} dB`,
        `Low-Mid vs Mid delta: +${lowMidBuildup.toFixed(1)} dB`,
        `Sub vs Bass delta: ${subExcess.toFixed(1)} dB`,
      ],
      explanation:
        'Excessive 150–400 Hz energy clouds vocal/snare clarity and forces the limiter to pump on bass notes.',
      recommendedAction: 'Apply surgical 260–340 Hz bell cut and subsonic 28 Hz high-pass filter.',
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

  if (harshExcess > 3.2 || analysis.resonances.some((r) => r.freqHz >= 2000 && r.excessDb >= 6.5)) {
    const topRes = analysis.resonances[0];
    findings.push({
      id: 'diag-harsh',
      kind: 'technical-problem',
      category: 'Spectral',
      title: 'Upper-Mid Harshness or Narrow Resonance Peaks',
      severity: harshExcess > 5.0 || (topRes?.excessDb ?? 0) > 8.0 ? 'high' : 'moderate',
      evidence: [
        `High-Mid vs Mid delta: +${harshExcess.toFixed(1)} dB`,
        ...(topRes ? [`Peak Resonance: ${topRes.freqHz} Hz (+${topRes.excessDb} dB)`] : []),
      ],
      explanation:
        'Concentrated upper-mid spikes cause listener fatigue and exaggerate harshness when brought up to commercial loudness.',
      recommendedAction: 'Use Dynamic EQ on resonant peak bands so attenuation only engages during harsh transients.',
    });
  } else if (analysis.resonances.length === 0 && !hasHeavyMud) {
    workingWell.push('Smooth frequency distribution without severe narrow-band resonances.');
  }

  // 7. Dynamics & Transients (Observation vs Over-compressed vs Punchy artistic choice)
  if (analysis.dynamicRangeDb < 5.5) {
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
  if (analysis.thdEstimatePercent > 2.2) {
    findings.push({
      id: 'diag-thd',
      kind: 'technical-problem',
      category: 'Distortion',
      title: 'Elevated Pre-Existing Harmonic Distortion',
      severity: analysis.thdEstimatePercent > 5 ? 'high' : 'moderate',
      evidence: [`Estimated THD: ${analysis.thdEstimatePercent.toFixed(2)}%`],
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
