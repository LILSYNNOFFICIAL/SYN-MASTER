import { isNoiseLikeFloor } from './analyzer';
import type { AudioAnalysis, ExportConfig, QCCheckItem, QCReport, QCTargetProfile } from '../types/mastering';

export const QC_TARGET_PROFILES: QCTargetProfile[] = [
  {
    id: 'streaming',
    name: 'Streaming Standard (-14 LUFS / -1.0 dBTP)',
    targetLufs: -14.0,
    lufsTolerance: 1.5,
    maxTruePeakDb: -1.0,
    minDynamicRangeDb: 7.0,
    minPhaseCorrelation: 0.25,
    maxClippingSamples: 0,
  },
  {
    id: 'club',
    name: 'Commercial / Club (-9 LUFS / -0.5 dBTP)',
    targetLufs: -9.0,
    lufsTolerance: 1.5,
    maxTruePeakDb: -0.5,
    minDynamicRangeDb: 5.0,
    minPhaseCorrelation: 0.2,
    maxClippingSamples: 0,
  },
  {
    id: 'broadcast',
    name: 'EBU R128 / Broadcast (-23 LUFS / -1.0 dBTP)',
    targetLufs: -23.0,
    lufsTolerance: 1.0,
    maxTruePeakDb: -1.0,
    minDynamicRangeDb: 9.0,
    minPhaseCorrelation: 0.35,
    maxClippingSamples: 0,
  },
  {
    id: 'audiophile',
    name: 'Audiophile / Vinyl (-16 LUFS / -1.5 dBTP)',
    targetLufs: -16.0,
    lufsTolerance: 2.0,
    maxTruePeakDb: -1.5,
    minDynamicRangeDb: 9.5,
    minPhaseCorrelation: 0.3,
    maxClippingSamples: 0,
  },
];

export function runQualityControl(
  pre: AudioAnalysis | null,
  post: AudioAnalysis,
  profile: QCTargetProfile,
  exportConfig?: ExportConfig | null,
): QCReport {
  const checks: QCCheckItem[] = [];

  // 1. True Peak Ceiling
  const tpPass = post.truePeakDb <= profile.maxTruePeakDb + 0.05;
  const tpWarn = !tpPass && post.truePeakDb <= 0.0;
  checks.push({
    id: 'qc-true-peak',
    category: 'Headroom',
    label: 'True Peak Ceiling',
    status: tpPass ? 'pass' : tpWarn ? 'warning' : 'fail',
    measuredValue: `${post.truePeakDb.toFixed(2)} dBTP`,
    targetValue: `<= ${profile.maxTruePeakDb.toFixed(1)} dBTP`,
    explanation: tpPass
      ? 'Inter-sample headroom meets codec transcoding safety margin.'
      : 'True Peak exceeds delivery ceiling; lossy streaming encoders (AAC/MP3/Ogg) may clip.',
    suggestedFix: tpPass ? undefined : `Lower Limiter/Maximizer ceiling to ${profile.maxTruePeakDb.toFixed(1)} dBTP.`,
  });

  // 2. Sample Clipping & Inter-Sample Peaks
  const noClip = post.clippedSamples <= profile.maxClippingSamples;
  checks.push({
    id: 'qc-clipping',
    category: 'Integrity',
    label: 'Digital Sample Clipping',
    status: noClip ? 'pass' : 'fail',
    measuredValue: `${post.clippedSamples} samples`,
    targetValue: '0 clipped samples',
    explanation: noClip
      ? 'Zero full-scale digital clipping detected across output samples.'
      : `${post.clippedSamples} samples reached >= 0.0 dBFS, indicating hard digital clipping.`,
    suggestedFix: noClip ? undefined : 'Reduce input gain or engage True Peak Limiter ahead of output.',
  });

  // 3. Integrated Loudness Compliance
  const lufsDelta = Math.abs(post.integratedLufs - profile.targetLufs);
  const lufsStatus =
    lufsDelta <= profile.lufsTolerance
      ? 'pass'
      : lufsDelta <= profile.lufsTolerance + 2.5
        ? 'warning'
        : 'fail';
  checks.push({
    id: 'qc-lufs',
    category: 'Loudness',
    label: 'Integrated Loudness (ITU-R BS.1770)',
    status: lufsStatus,
    measuredValue: `${post.integratedLufs.toFixed(1)} LUFS`,
    targetValue: `${profile.targetLufs.toFixed(1)} ± ${profile.lufsTolerance.toFixed(1)} LUFS`,
    explanation:
      lufsStatus === 'pass'
        ? 'Integrated loudness aligns with target delivery normalization.'
        : post.integratedLufs < profile.targetLufs
          ? 'Master is quieter than target; platform normalization or competitive level may suffer.'
          : 'Master exceeds target loudness; streaming platforms will turn down playback gain.',
    suggestedFix:
      lufsStatus === 'pass'
        ? undefined
        : `Adjust Maximizer Target LUFS or Limiter threshold by ${(profile.targetLufs - post.integratedLufs).toFixed(1)} dB.`,
  });

  // 4. Dynamic Range & Transient Preservation
  const drLoss = pre ? pre.dynamicRangeDb - post.dynamicRangeDb : 0;
  const drStatus =
    post.dynamicRangeDb >= profile.minDynamicRangeDb && drLoss <= 4.5
      ? 'pass'
      : post.dynamicRangeDb >= profile.minDynamicRangeDb - 1.5
        ? 'warning'
        : 'fail';
  checks.push({
    id: 'qc-dynamics',
    category: 'Dynamics',
    label: 'Dynamic Range & Punch',
    status: drStatus,
    measuredValue: `${post.dynamicRangeDb.toFixed(1)} dB (PLR ${post.plrDb.toFixed(1)} dB)`,
    targetValue: `>= ${profile.minDynamicRangeDb.toFixed(1)} dB`,
    explanation:
      drStatus === 'pass'
        ? 'Healthy crest factor and musical transient impact preserved.'
        : 'Excessive compression or limiting has reduced transient contrast.',
    suggestedFix:
      drStatus === 'pass'
        ? undefined
        : 'Back off Limiter threshold or increase Compressor attack time.',
  });

  // 5. Phase Correlation & Mono Compatibility
  const localizedBandPhaseRisk = post.stereoBandCorrelation
    ? post.stereoBandCorrelation.low < 0.45 ||
      post.stereoBandCorrelation.mid < 0.15 ||
      post.stereoBandCorrelation.high < 0.15
    : false;
  const phaseStatus =
    post.phaseCorrelation < 0
      ? 'fail'
      : localizedBandPhaseRisk
        ? 'warning'
        : post.phaseCorrelation >= profile.minPhaseCorrelation && post.lowEndCorrelation >= 0.4
          ? 'pass'
          : 'warning';
  checks.push({
    id: 'qc-phase',
    category: 'Stereo',
    label: 'Stereo Phase & Mono Compatibility',
    status: phaseStatus,
    measuredValue: `Corr ${post.phaseCorrelation.toFixed(2)} (Low ${post.lowEndCorrelation.toFixed(2)})${post.stereoBandCorrelation ? ` · Bands L/M/H ${post.stereoBandCorrelation.low.toFixed(2)}/${post.stereoBandCorrelation.mid.toFixed(2)}/${post.stereoBandCorrelation.high.toFixed(2)}` : ''}`,
    targetValue: `>= +${profile.minPhaseCorrelation.toFixed(2)}`,
    explanation:
      phaseStatus === 'pass'
        ? 'Strong stereo coherence with reliable mono fold-down across measured bands.'
        : localizedBandPhaseRisk
          ? 'At least one frequency band has weak or negative L/R correlation. This may be intentional stereo design, but audition the band-limited mono fold-down for audible cancellation.'
          : 'Wide out-of-phase components or unfocused low-end stereo may cancel in mono playback.',
    suggestedFix:
      phaseStatus === 'pass'
        ? undefined
        : localizedBandPhaseRisk
        ? 'Audition band-limited mono fold-down. If cancellation is unintended, reduce width or correct polarity only in the affected frequency range.'
        : 'Enable Mono Bass (<100 Hz) and reduce Stereo Imager high/mid width.',
  });

  // 6. Spectral Change & Tonal Balance
  const bassMidDiff = post.zoneEnergyDb.bass - post.zoneEnergyDb.mid;
  const harshDiff = post.zoneEnergyDb.highMid - post.zoneEnergyDb.mid;
  const bassMidBefore = pre ? pre.zoneEnergyDb.bass - pre.zoneEnergyDb.mid : null;
  const harshBefore = pre ? pre.zoneEnergyDb.highMid - pre.zoneEnergyDb.mid : null;
  const bassMidDelta = bassMidBefore === null ? null : bassMidDiff - bassMidBefore;
  const harshDelta = harshBefore === null ? null : harshDiff - harshBefore;
  const bassMidRegressed = bassMidDelta !== null && bassMidDelta > 1.5;
  const harshRegressed = harshDelta !== null && harshDelta > 1.5;
  // With a source reference, judge what the mastering chain changed rather than
  // penalizing an intentional bass-heavy or bright mix that it preserved.
  // Without a source reference, retain broad screening guardrails.
  const spectralPass = pre
    ? !bassMidRegressed && !harshRegressed
    : bassMidDiff < 11 && harshDiff < 4.5;
  const spectralIssue = bassMidRegressed || (!harshRegressed && bassMidDiff >= 11)
    ? 'bass'
    : 'harsh';
  const signedDelta = (value: number | null): string =>
    value === null ? 'n/a' : `${value >= 0 ? '+' : ''}${value.toFixed(1)} dB`;
  checks.push({
    id: 'qc-spectral',
    category: 'Spectral',
    label: 'Spectral Change & Tonal Balance',
    status: spectralPass ? 'pass' : 'warning',
    measuredValue:
      `Slope ${post.spectralSlopeDbPerOct.toFixed(1)} dB/oct · Bass/Mid ${bassMidDiff.toFixed(1)} dB (Δ ${signedDelta(bassMidDelta)}) · High-Mid/Mid ${harshDiff.toFixed(1)} dB (Δ ${signedDelta(harshDelta)})`,
    targetValue: pre
      ? 'No >1.5 dB deterioration versus source'
      : 'Bass/Mid <11 dB · High-Mid/Mid <4.5 dB',
    explanation: spectralPass
      ? pre
        ? 'Processing preserved the source tonal balance. Existing bass-heavy or bright character is not treated as a new mastering defect.'
        : 'Spectral energy falls within broad screening guardrails.'
      : spectralIssue === 'bass'
        ? bassMidRegressed
          ? `Processing increased bass relative to midrange by ${signedDelta(bassMidDelta)} versus the source. Audition the level-matched change before correcting it.`
          : 'The source has strong bass relative to midrange. This tonal-balance observation is not proof of audible masking.'
        : harshRegressed
          ? `Processing increased upper-mid energy relative to midrange by ${signedDelta(harshDelta)} versus the source. Audition for added harshness before correcting it.`
          : 'The source has elevated upper-mid energy relative to midrange. Confirm audible harshness before applying EQ.',
    suggestedFix: spectralPass
      ? undefined
      : 'Compare level-matched source and processed audio. If the tonal shift is unintended or audible, adjust the responsible processing stage and reanalyze.',
  });

  // 7. DC Offset
  const dcPass = post.dcOffset < 0.005;
  checks.push({
    id: 'qc-dc',
    category: 'Integrity',
    label: 'DC Offset Symmetry',
    status: dcPass ? 'pass' : 'warning',
    measuredValue: `${(post.dcOffset * 100).toFixed(3)}%`,
    targetValue: '< 0.500%',
    explanation: dcPass
      ? 'Waveform is centered cleanly around zero crossing.'
      : 'DC offset detected, reducing usable headroom.',
    suggestedFix: dcPass ? undefined : 'Enable SYN-Restore DC Offset removal or HPF @ 25 Hz.',
  });

  // 8. L/R Channel Balance
  const lrAbs = Math.abs(post.lrBalanceDb ?? 0);
  const lrStatus = lrAbs <= 0.6 ? 'pass' : lrAbs <= 1.2 ? 'warning' : 'fail';
  checks.push({
    id: 'qc-lr-balance',
    category: 'Stereo',
    label: 'Left / Right Channel Balance',
    status: lrStatus,
    measuredValue: `${post.lrBalanceDb >= 0 ? '+' : ''}${post.lrBalanceDb.toFixed(2)} dB`,
    targetValue: 'Within ±0.6 dB',
    explanation:
      lrStatus === 'pass'
        ? 'Stereo image energy is balanced cleanly across left and right channels.'
        : 'Persistent L/R energy skew shifts center anchor off-axis.',
    suggestedFix:
      lrStatus === 'pass'
        ? undefined
        : `Adjust Stereo Imager L/R Balance by ${(-post.lrBalanceDb * 0.7).toFixed(2)} dB.`,
  });

  // 9. Harmonic & Inter-Sample Distortion
  const thd = post.thdEstimatePercent ?? 0;
  const ispCount = post.interSamplePeaks ?? 0;
  const distStatus =
    thd <= 1.5 && ispCount === 0
      ? 'pass'
      : thd <= 3.5 && ispCount <= 12
        ? 'warning'
        : 'fail';
  checks.push({
    id: 'qc-distortion',
    category: 'Integrity',
    label: 'Harmonic & Peak Distortion',
    status: distStatus,
    measuredValue: `${thd.toFixed(2)}% THD · ${ispCount} ISP`,
    targetValue: '<= 1.50% THD · 0 ISP',
    explanation:
      distStatus === 'pass'
        ? 'Harmonic density and inter-sample margins are clean without audible breakup.'
        : 'Elevated harmonic distortion or inter-sample overs indicate saturation/limiter stress.',
    suggestedFix:
      distStatus === 'pass'
        ? undefined
        : 'Reduce Saturation drive or relax Maximizer/Limiter threshold by 1–2 dB with 4x True Peak.',
  });

  // 10. Broadband Noise Floor (only evaluate quiet-frame noise floor when quiet passages exist >= 12 dB below program RMS)
  const nf = post.noiseFloorDb ?? -72;
  // Quiet frames that are quiet MUSIC (low HF share) are not a noise floor.
  const hasQuietGapMargin = post.rmsDb - nf >= 12 && isNoiseLikeFloor(post);
  const nfStatus = !hasQuietGapMargin || nf <= -52 ? 'pass' : nf <= -42 ? 'warning' : 'fail';
  checks.push({
    id: 'qc-noise-floor',
    category: 'Integrity',
    label: 'Broadband Noise Floor',
    status: nfStatus,
    measuredValue: hasQuietGapMargin ? `${nf.toFixed(1)} dBFS` : `${nf.toFixed(1)} dBFS (Continuous)`,
    targetValue: '<= -52.0 dBFS',
    explanation: !hasQuietGapMargin
      ? 'Program material sustains continuously without silent intervals; no anomalous noise floor intrusion detected.'
      : nfStatus === 'pass'
        ? 'Quiet-passage noise floor is low relative to program level.'
        : 'Elevated steady-state noise floor or hum detected in quiet frames.',
    suggestedFix:
      nfStatus === 'pass'
        ? undefined
        : 'Engage SYN-Restore Hiss Reduction / Hum Notch before bus compression.',
  });

  // 11. Export Delivery Integrity (verified against ExportConfig when supplied)
  if (exportConfig) {
    const missing16BitDither = exportConfig.wavBitDepth === 16 && exportConfig.dither === 'none';
    const ceilingUnsafe = exportConfig.ceilingDb > profile.maxTruePeakDb + 0.05;
    const exportStatus = ceilingUnsafe ? 'fail' : missing16BitDither ? 'warning' : 'pass';
    checks.push({
      id: 'qc-export-integrity',
      category: 'Headroom',
      label: 'Export Delivery Configuration',
      status: exportStatus,
      measuredValue: `${exportConfig.wavBitDepth}-bit ${(exportConfig.sampleRate / 1000).toFixed(1)}kHz (${exportConfig.dither.toUpperCase()})`,
      targetValue: `TP <= ${profile.maxTruePeakDb.toFixed(1)} dBTP · TPDF for 16-bit`,
      explanation:
        exportStatus === 'pass'
          ? 'Export format, dithering, and ceiling margin align with selected delivery profile.'
          : ceilingUnsafe
            ? `Export ceiling (${exportConfig.ceilingDb} dBTP) exceeds target profile limit (${profile.maxTruePeakDb} dBTP).`
            : '16-bit PCM export without TPDF dithering introduces quantization distortion.',
      suggestedFix:
        exportStatus === 'pass'
          ? undefined
          : ceilingUnsafe
            ? `Set Export Ceiling to <= ${profile.maxTruePeakDb.toFixed(1)} dBTP.`
            : 'Enable TPDF dither for 16-bit WAV export or export 24-bit WAV.',
    });
  }

  const failCount = checks.filter((c) => c.status === 'fail').length;
  const warningCount = checks.filter((c) => c.status === 'warning').length;
  const passedCount = checks.filter((c) => c.status === 'pass').length;

  return {
    overallStatus: failCount > 0 ? 'fail' : warningCount > 0 ? 'warning' : 'pass',
    passedCount,
    warningCount,
    failCount,
    checks,
  };
}
