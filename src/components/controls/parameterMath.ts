import type { ExternalPluginParamValue } from '../../types/mastering';

export type ParameterScale = 'linear' | 'logarithmic';

export const KNOB_START_ANGLE_DEG = -135;
export const KNOB_END_ANGLE_DEG = 135;
export const KNOB_SWEEP_DEG = KNOB_END_ANGLE_DEG - KNOB_START_ANGLE_DEG;

export function clampNumber(value: number, min: number, max: number, fallback?: number): number {
  const safeMin = Math.min(min, max);
  const safeMax = Math.max(min, max);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return clampNumber(fallback ?? safeMin, safeMin, safeMax);
  }
  return Math.max(safeMin, Math.min(safeMax, value));
}

export function getStepDecimals(step: number, explicitPrecision?: number): number {
  if (typeof explicitPrecision === 'number' && Number.isInteger(explicitPrecision) && explicitPrecision >= 0) {
    return Math.min(6, explicitPrecision);
  }
  if (!Number.isFinite(step) || step <= 0) return 2;
  const s = step.toString();
  if (s.includes('e-')) {
    const exp = Number(s.split('e-')[1]);
    return Number.isFinite(exp) ? Math.min(6, exp) : 2;
  }
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : Math.min(6, s.length - dot - 1);
}

export function quantizeToStep(
  value: number,
  min: number,
  max: number,
  step: number,
  explicitPrecision?: number,
): number {
  const clamped = clampNumber(value, min, max);
  if (!Number.isFinite(step) || step <= 0) {
    return clamped;
  }
  const safeMin = Math.min(min, max);
  const safeMax = Math.max(min, max);
  const stepsFromMin = Math.round((clamped - safeMin) / step);
  const snapped = safeMin + stepsFromMin * step;
  const decimals = getStepDecimals(step, explicitPrecision);
  const rounded = Number(snapped.toFixed(Math.max(decimals, 4)));
  return clampNumber(rounded, safeMin, safeMax);
}

export function valueToNormalized(
  value: number,
  min: number,
  max: number,
  scale: ParameterScale = 'linear',
): number {
  const safeMin = Math.min(min, max);
  const safeMax = Math.max(min, max);
  const span = safeMax - safeMin;
  if (span <= 0) return 0;
  const clamped = clampNumber(value, safeMin, safeMax);

  if (scale === 'logarithmic' && safeMin > 0 && safeMax > safeMin) {
    const ratio = safeMax / safeMin;
    const norm = Math.log(clamped / safeMin) / Math.log(ratio);
    return clampNumber(norm, 0, 1);
  }

  return clampNumber((clamped - safeMin) / span, 0, 1);
}

export function normalizedToValue(
  normalized: number,
  min: number,
  max: number,
  scale: ParameterScale = 'linear',
  step = 0,
  explicitPrecision?: number,
): number {
  const safeMin = Math.min(min, max);
  const safeMax = Math.max(min, max);
  const norm = clampNumber(normalized, 0, 1);
  const span = safeMax - safeMin;
  if (span <= 0) return safeMin;

  let raw: number;
  if (scale === 'logarithmic' && safeMin > 0 && safeMax > safeMin) {
    raw = safeMin * Math.pow(safeMax / safeMin, norm);
  } else {
    raw = safeMin + norm * span;
  }

  return step > 0
    ? quantizeToStep(raw, safeMin, safeMax, step, explicitPrecision)
    : clampNumber(raw, safeMin, safeMax);
}

export function normalizedToAngleDeg(normalized: number): number {
  const norm = clampNumber(normalized, 0, 1);
  return KNOB_START_ANGLE_DEG + norm * KNOB_SWEEP_DEG;
}

export interface DragUpdateInput {
  startNormalized: number;
  deltaPx: number;
  sensitivityPx?: number;
  fine?: boolean;
  min: number;
  max: number;
  scale?: ParameterScale;
  step?: number;
  precision?: number;
}

export function computeDragValue({
  startNormalized,
  deltaPx,
  sensitivityPx = 150,
  fine = false,
  min,
  max,
  scale = 'linear',
  step = 0,
  precision,
}: DragUpdateInput): { value: number; normalized: number } {
  const effectiveRange = Math.max(40, sensitivityPx) * (fine ? 5 : 1);
  const nextNorm = clampNumber(startNormalized + deltaPx / effectiveRange, 0, 1);
  const value = normalizedToValue(nextNorm, min, max, scale, step, precision);
  return {
    value,
    normalized: valueToNormalized(value, min, max, scale),
  };
}

export interface KeyStepInput {
  currentValue: number;
  key: string;
  shiftKey?: boolean;
  min: number;
  max: number;
  scale?: ParameterScale;
  step?: number;
  precision?: number;
  defaultValue?: number;
}

export function computeKeyStepValue({
  currentValue,
  key,
  shiftKey = false,
  min,
  max,
  scale = 'linear',
  step = 0,
  precision,
  defaultValue,
}: KeyStepInput): number | null {
  const safeMin = Math.min(min, max);
  const safeMax = Math.max(min, max);
  const span = safeMax - safeMin;
  if (span <= 0) return safeMin;

  if (key === 'Home') return safeMin;
  if (key === 'End') return safeMax;
  if ((key === 'Backspace' || key === 'Delete') && defaultValue !== undefined) {
    return quantizeToStep(defaultValue, safeMin, safeMax, step, precision);
  }

  let dir = 0;
  let multiplier = 1;
  if (key === 'ArrowUp' || key === 'ArrowRight') dir = 1;
  else if (key === 'ArrowDown' || key === 'ArrowLeft') dir = -1;
  else if (key === 'PageUp') {
    dir = 1;
    multiplier = 10;
  } else if (key === 'PageDown') {
    dir = -1;
    multiplier = 10;
  } else {
    return null;
  }

  if (scale === 'logarithmic' && safeMin > 0) {
    const currentNorm = valueToNormalized(currentValue, safeMin, safeMax, 'logarithmic');
    const normDelta = (shiftKey ? 0.004 : 0.02) * multiplier * dir;
    return normalizedToValue(currentNorm + normDelta, safeMin, safeMax, 'logarithmic', step, precision);
  }

  const baseStep = step > 0 ? step : span / 100;
  if (shiftKey) {
    const fineStep = step > 0 ? Math.max(baseStep * 0.2, Math.min(baseStep, span / 500)) : span / 500;
    const fineDecimals = Math.max(getStepDecimals(baseStep, precision), getStepDecimals(fineStep));
    return quantizeToStep(currentValue + dir * fineStep * multiplier, safeMin, safeMax, fineStep, fineDecimals);
  }

  return quantizeToStep(currentValue + dir * baseStep * multiplier, safeMin, safeMax, baseStep, precision);
}

export interface FormatParameterOptions {
  unit?: string;
  step?: number;
  precision?: number;
  signed?: boolean;
  formatValue?: (value: number) => string;
}

export function formatParameterValue(value: number, opts: FormatParameterOptions = {}): string {
  if (!Number.isFinite(value)) return '—';
  if (opts.formatValue) {
    return opts.formatValue(value);
  }

  const unit = (opts.unit ?? '').trim();
  const lowerUnit = unit.toLowerCase();

  // Frequency auto-kHz formatting when unit is Hz
  if (lowerUnit === 'hz') {
    if (Math.abs(value) >= 1000) {
      const khz = value / 1000;
      return `${khz >= 10 ? khz.toFixed(1) : khz.toFixed(2)} kHz`;
    }
    return `${Math.round(value)} Hz`;
  }

  // Time formatting when unit is ms
  if (lowerUnit === 'ms') {
    if (Math.abs(value) >= 1000) {
      return `${(value / 1000).toFixed(2)} s`;
    }
    const dec = value < 10 && !Number.isInteger(value) ? 1 : 0;
    return `${value.toFixed(dec)} ms`;
  }

  const decimals = opts.precision ?? getStepDecimals(opts.step ?? 0.1);
  const zeroThreshold = 0.5 * Math.pow(10, -decimals);
  const safeVal = Math.abs(value) < zeroThreshold || Object.is(value, -0) ? 0 : value;
  const sign = opts.signed && safeVal > 0 ? '+' : '';
  const numStr = `${sign}${safeVal.toFixed(decimals)}`;

  if (!unit) return numStr;
  if (unit === '%' || unit === ':1' || unit === 'x') {
    return `${numStr}${unit}`;
  }
  return `${numStr} ${unit}`;
}

export function parseNumericEntry(
  raw: string,
  min: number,
  max: number,
  step = 0,
  unit = '',
  precision?: number,
  normalizedOverride = false,
): number | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  const hasKhzSuffix = trimmed.includes('khz');
  const hasSecSuffix = !trimmed.includes('ms') && /\d\s*s\b/.test(trimmed);
  const hasPctSuffix = trimmed.includes('%');
  const numericMatch = trimmed.match(/[-+]?\d*\.?\d+/);
  if (!numericMatch) return null;
  let parsed = Number(numericMatch[0]);
  if (!Number.isFinite(parsed)) return null;

  if (normalizedOverride) {
    if (hasPctSuffix) {
      parsed /= 100;
    }
  } else {
    const lowerUnit = unit.trim().toLowerCase();
    if (lowerUnit === 'hz' && hasKhzSuffix) {
      parsed *= 1000;
    } else if (lowerUnit === 'ms' && hasSecSuffix) {
      parsed *= 1000;
    }
  }

  return step > 0
    ? quantizeToStep(parsed, min, max, step, precision)
    : clampNumber(parsed, min, max);
}

/**
 * Computes SVG arc path in degrees where 0 deg is 12 o'clock (-90 in standard SVG trig).
 */
export function polarToCartesian(cx: number, cy: number, radius: number, angleDeg: number): { x: number; y: number } {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(rad),
    y: cy + radius * Math.sin(rad),
  };
}

export function describeArcPath(
  cx: number,
  cy: number,
  radius: number,
  startAngleDeg: number,
  endAngleDeg: number,
): string {
  const start = polarToCartesian(cx, cy, radius, startAngleDeg);
  const end = polarToCartesian(cx, cy, radius, endAngleDeg);
  const diff = endAngleDeg - startAngleDeg;
  if (Math.abs(diff) < 0.01) return '';
  const largeArcFlag = Math.abs(diff) <= 180 ? '0' : '1';
  const sweepFlag = diff >= 0 ? '1' : '0';
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${radius.toFixed(2)} ${radius.toFixed(2)} 0 ${largeArcFlag} ${sweepFlag} ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

export interface InferredVst3ControlSpec {
  kind: 'toggle' | 'knob';
  min: number;
  max: number;
  step: number;
  scale: ParameterScale;
  unit: string;
  precision: number;
  bipolar: boolean;
  signed: boolean;
  formatValue: (normalizedValue: number) => string;
}

/**
 * Interprets real VST3 parameter metadata returned by syn-plugin-worker.
 * Note: VST3 transport parameters operate in [0, 1] normalized space while presenting
 * domain-appropriate engineering formatting & curve metadata.
 */
export function inferExternalVst3ControlSpec(param: ExternalPluginParamValue): InferredVst3ControlSpec {
  const nameLower = param.name.toLowerCase();
  const labelLower = param.label.trim().toLowerCase();
  const combined = `${nameLower} ${labelLower}`;
  const isSwitch = param.stepCount === 1;

  if (isSwitch) {
    return {
      kind: 'toggle',
      min: 0,
      max: 1,
      step: 1,
      scale: 'linear',
      unit: '',
      precision: 0,
      bipolar: false,
      signed: false,
      formatValue: (v) => param.displayValue || (v >= 0.5 ? 'On' : 'Off'),
    };
  }

  let unit = param.label.trim();
  let scale: ParameterScale = 'linear';
  let bipolar = false;
  let signed = false;
  let precision = 2;

  if (!unit) {
    if (combined.includes('gain') || combined.includes('thresh') || combined.includes('ceiling') || combined.includes('tilt') || combined.includes('level') || combined.includes('trim')) {
      unit = 'dB';
    } else if (combined.includes('freq') || combined.includes('cutoff') || combined.includes('hpf') || combined.includes('lpf') || combined.includes('xover')) {
      unit = 'Hz';
    } else if (combined.includes('attack') || combined.includes('release') || combined.includes('delay') || combined.includes('lookahead') || combined.includes('time')) {
      unit = 'ms';
    } else if (combined.includes('ratio')) {
      unit = ':1';
    } else {
      unit = '%';
    }
  }

  const u = unit.toLowerCase();
  if (u === 'hz' || u === 'khz') {
    scale = 'logarithmic';
    precision = 0;
  } else if (u === 'ms' || u === 's') {
    scale = 'logarithmic';
    precision = 1;
  } else if (u === 'db' || u === 'dbtp' || u === 'lufs') {
    bipolar = combined.includes('gain') || combined.includes('tilt') || combined.includes('trim') || combined.includes('balance') || Math.abs(param.defaultValueNormalized - 0.5) < 0.02;
    signed = bipolar;
    precision = 1;
  } else if (u === '%') {
    bipolar = Math.abs(param.defaultValueNormalized - 0.5) < 0.02 && (combined.includes('pan') || combined.includes('balance') || combined.includes('tilt') || combined.includes('tone'));
    precision = 0;
  }

  const discreteSteps = param.stepCount > 1 && param.stepCount <= 200 ? 1 / param.stepCount : 0.005;

  return {
    kind: 'knob',
    min: 0,
    max: 1,
    step: discreteSteps,
    scale,
    unit,
    precision,
    bipolar,
    signed,
    formatValue: (normVal: number) => {
      if (param.displayValue && Math.abs(normVal - param.valueNormalized) < 1e-4) {
        // Ensure host displayValue already carries or gets clean formatting
        return param.displayValue;
      }
      if (u === '%') {
        return `${Math.round(clampNumber(normVal, 0, 1) * 100)}%`;
      }
      return `${Math.round(clampNumber(normVal, 0, 1) * 100)}% (${unit})`;
    },
  };
}
