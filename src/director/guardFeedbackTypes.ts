export const GUARD_FEEDBACK_REASON_CODES = [
  'regression-guard', 'low-mid-sub-bass-masking', 'technical-finding-regression',
  'clipping-regression', 'phase-regression', 'dynamics-regression',
  'transient-regression', 'distortion-regression', 'noise-regression',
  'true-peak-regression', 'loudness-regression', 'objective-score-regression',
  'objective-gate-downgrade', 'no-improvement',
] as const;
export type GuardFeedbackReasonCode = typeof GUARD_FEEDBACK_REASON_CODES[number];
export interface GuardBalanceMetric {
  valueDb: number | null;
  limitDb: number;
  remainingDb: number | null;
}
export interface GuardBalanceSnapshot {
  bassVsMid: GuardBalanceMetric;
  lowMidVsMid: GuardBalanceMetric;
  region150To400VsMid: GuardBalanceMetric;
  subVsBass: GuardBalanceMetric;
}
export interface GuardFeedback {
  pass: number;
  reasonCodes: GuardFeedbackReasonCode[];
  source: GuardBalanceSnapshot;
  rejected: GuardBalanceSnapshot;
}
