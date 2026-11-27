import type { AudioAnalysis } from '../types/mastering.ts';
import type { DiagnosisThresholds } from './analyzeIntelligence.ts';
import {
  GUARD_FEEDBACK_REASON_CODES,
  type GuardBalanceMetric,
  type GuardBalanceSnapshot,
  type GuardFeedback,
  type GuardFeedbackReasonCode,
} from './guardFeedbackTypes.ts';
export { GUARD_FEEDBACK_REASON_CODES } from './guardFeedbackTypes.ts';
export type { GuardBalanceMetric, GuardBalanceSnapshot, GuardFeedback, GuardFeedbackReasonCode } from './guardFeedbackTypes.ts';

function computeRegionEnergyDb(analysis: AudioAnalysis, minHz: number, maxHz: number): number | null {
  const freqs = analysis.spectrumBinsFreq;
  const dbs = analysis.spectrumBinsDb;
  if (!freqs || !dbs || freqs.length === 0 || freqs.length !== dbs.length) return null;
  let powerSum = 0;
  let count = 0;
  for (let i = 0; i < freqs.length; i++) {
    if (freqs[i] >= minHz && freqs[i] <= maxHz && Number.isFinite(dbs[i])) {
      powerSum += Math.pow(10, dbs[i] / 10);
      count++;
    }
  }
  return count === 0 ? null : 10 * Math.log10(Math.max(1e-13, powerSum / count));
}
function metric(valueDb: number | null, limitDb: number): GuardBalanceMetric {
  const value = valueDb !== null && Number.isFinite(valueDb) ? Math.round(valueDb * 100) / 100 : null;
  const limit = Math.round(limitDb * 100) / 100;
  return { valueDb: value, limitDb: limit, remainingDb: value === null ? null : Math.round((limit - value) * 100) / 100 };
}
export function measureGuardBalance(analysis: AudioAnalysis, limits: DiagnosisThresholds): GuardBalanceSnapshot {
  const region = computeRegionEnergyDb(analysis, 150, 400);
  return {
    bassVsMid: metric(analysis.zoneEnergyDb.bass - analysis.zoneEnergyDb.mid, limits.bassMidDiffLimit),
    lowMidVsMid: metric(analysis.zoneEnergyDb.lowMid - analysis.zoneEnergyDb.mid, limits.lowMidBuildupLimit),
    region150To400VsMid: metric(region === null ? null : region - analysis.zoneEnergyDb.mid, limits.region150To400VsMidLimit),
    subVsBass: metric(analysis.zoneEnergyDb.sub - analysis.zoneEnergyDb.bass, limits.subExcessLimit),
  };
}
export function buildGuardFeedback(input: {
  pass: number; reasonCodes: GuardFeedbackReasonCode[]; source: AudioAnalysis; rejected: AudioAnalysis; limits: DiagnosisThresholds;
}): GuardFeedback {
  const reasonCodes = [...new Set(input.reasonCodes)].filter((code) =>
    (GUARD_FEEDBACK_REASON_CODES as readonly string[]).includes(code),
  );
  return {
    pass: Math.max(1, Math.min(10, Math.trunc(input.pass))),
    reasonCodes: reasonCodes.length ? reasonCodes : ['no-improvement'],
    source: measureGuardBalance(input.source, input.limits),
    rejected: measureGuardBalance(input.rejected, input.limits),
  };
}
const REASON_LABELS: Record<GuardFeedbackReasonCode, string> = {
  'regression-guard': 'Director regression guard rejection',
  'low-mid-sub-bass-masking': 'low-mid / sub-bass balance finding',
  'technical-finding-regression': 'new or worsened technical finding',
  'clipping-regression': 'new clipping',
  'phase-regression': 'phase regression',
  'dynamics-regression': 'dynamic-range regression',
  'transient-regression': 'transient-detail regression',
  'distortion-regression': 'distortion regression',
  'noise-regression': 'noise-floor regression',
  'true-peak-regression': 'true-peak regression',
  'loudness-regression': 'loudness overshoot',
  'objective-score-regression': 'objective score regression',
  'objective-gate-downgrade': 'objective gate downgrade',
  'no-improvement': 'candidate did not improve the retained result',
};
function formatMetric(label: string, item: GuardBalanceMetric): string {
  if (item.valueDb === null || item.remainingDb === null) return `- ${label}: unavailable; objective/reference limit ${item.limitDb.toFixed(2)} dB`;
  return `- ${label}: measured ${item.valueDb.toFixed(2)} dB; limit ${item.limitDb.toFixed(2)} dB; remaining headroom ${item.remainingDb.toFixed(2)} dB`;
}
export function formatGuardFeedbackForPrompt(feedback?: GuardFeedback | null): string {
  if (!feedback) return '';
  const reasons = feedback.reasonCodes.map((code) => REASON_LABELS[code]).join('; ');
  const snapshot = (label: string, values: GuardBalanceSnapshot) => [
    `${label}:`,
    formatMetric('Bass vs Mid', values.bassVsMid),
    formatMetric('Low-Mid vs Mid', values.lowMidVsMid),
    formatMetric('150–400 Hz vs Mid', values.region150To400VsMid),
    formatMetric('Sub vs Bass', values.subVsBass),
  ].join('\n');
  return [
    `DIRECTOR REJECTION FEEDBACK — THIS TRACK ONLY (rejected pass ${feedback.pass})`,
    `Reason categories: ${reasons}`,
    'Each limit is computed for this track’s selected mastering objective and supplied reference, when present. Remaining headroom is limit minus measurement; a negative value means the measurement exceeds the limit.',
    snapshot('Original source measurements', feedback.source),
    snapshot('Rejected render measurements', feedback.rejected),
    'This is diagnostic evidence, not a prescribed correction. Do not assume a particular EQ band, processor, or compensating move. Reassess the complete source measurements, musical intent, current chain, objective, reference, and rejected render. Independently decide whether to change, replace, remove, or retain any processor, choose another strategy, or avoid forcing a change when the evidence does not support one. The Director regression guard and objective gate remain authoritative; every proposal must be rendered and measured again.',
  ].join('\n\n');
}
