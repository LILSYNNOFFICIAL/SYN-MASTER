/**
 * Pure helpers behind ProgressRing, the import overlay and the FIX ALL ring.
 * No React, no DOM: unit-tested in progressMath.test.ts.
 */

export type ProgressRingState = 'idle' | 'running' | 'stopped' | 'error';

/** Clamp to a finite 0..100 value (NaN / undefined become 0). */
export function clampPercent(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

/**
 * Never-decreasing progress. While a job runs, a lower incoming value is ignored; `reset`
 * (a new job, or the ring returning to idle) starts again from the incoming value.
 */
export function nextMonotonicPercent(prev: number, incoming: number, reset = false): number {
  const next = clampPercent(incoming);
  if (reset) return next;
  return Math.max(clampPercent(prev), next);
}

/** Map a 0..1 fraction of one stage onto that stage's [start, end] percent window. */
export function stagePercent(start: number, end: number, fraction: number): number {
  const f = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  return clampPercent(start + (end - start) * f);
}

// ---------------------------------------------------------------------------
// Import overlay: weights from the measured B1 timings (analysis dominates).
// ---------------------------------------------------------------------------

export type ImportStage = 'reading' | 'decoding' | 'analyzing' | 'waveform' | 'finishing';

export const IMPORT_STAGE_WINDOWS: Record<ImportStage, readonly [number, number]> = {
  reading: [0, 5],
  decoding: [5, 30],
  analyzing: [30, 90],
  waveform: [90, 96],
  finishing: [96, 100],
};

export const IMPORT_STAGE_LABELS: Record<ImportStage, string> = {
  reading: 'Reading file',
  decoding: 'Decoding audio',
  analyzing: 'Analyzing',
  waveform: 'Building waveform',
  finishing: 'Preparing playback',
};

export function importStagePercent(stage: ImportStage, fraction: number): number {
  const [a, b] = IMPORT_STAGE_WINDOWS[stage];
  return stagePercent(a, b, fraction);
}

// ---------------------------------------------------------------------------
// FIX ALL: computed from the Director's own stage / pass events (no timers).
// analysis 0-10, AI strategy 10-25, passes share the remaining 75 on an eased
// curve that approaches 95 (the pass count is not known in advance); 100 only
// on completion.
// ---------------------------------------------------------------------------

const PASS_EASE_PASSES = 2.2;

export function fixAllPercent(stage: string, pass: number, completed = false): number {
  if (completed) return 100;
  const s = (stage || '').toLowerCase();
  const p = Number.isFinite(pass) ? Math.max(0, Math.floor(pass)) : 0;
  if (p <= 0) {
    if (s.includes('stem')) return 7;
    if (s.includes('think')) return 18;
    if (s.includes('plan')) return 12;
    if (s.includes('analy')) return 4;
    return 2;
  }
  // Sub-stage position inside one pass.
  const sub = s.includes('optimi') || s.includes('think') ? 0.8 : s.includes('measur') || s.includes('verif') ? 0.5 : 0.1;
  const x = p - 1 + sub;
  const eased = 1 - Math.exp(-x / PASS_EASE_PASSES);
  return Math.min(95, Math.round((25 + 70 * eased) * 10) / 10);
}

/** User-facing stage text for the FIX ALL ring. */
export function fixAllStageLabel(stage: string, pass: number): string {
  const s = (stage || '').toLowerCase();
  if (s.includes('think')) return 'AI is thinking…';
  if (s.includes('stem')) return 'Preparing vocal stems';
  if (pass > 0 && s.includes('process')) return `Rendering pass ${pass}`;
  if (pass > 0 && s.includes('measur')) return `Verifying pass ${pass}`;
  if (pass > 0 && s.includes('optimi')) return `Refining after pass ${pass}`;
  if (s.includes('plan')) return 'Planning';
  if (s.includes('analy')) return 'Analyzing';
  if (s.includes('complet')) return 'Done';
  if (s.includes('stop')) return 'Stopped';
  return stage || 'Working';
}
