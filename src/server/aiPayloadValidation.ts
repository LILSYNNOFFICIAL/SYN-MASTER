import { MASTERING_OBJECTIVE_IDS, type AudioAnalysis, type MasteringMode, type MasteringObjectiveId } from '../types/mastering.ts';
import { MODE_MEANINGS } from '../ai/masteringPrompt.ts';
import { GUARD_FEEDBACK_REASON_CODES, type GuardBalanceMetric, type GuardBalanceSnapshot, type GuardFeedback } from '../director/guardFeedbackTypes.ts';

export interface SafeAvailablePlugin {
  name: string;
  role: string;
  manufacturer: string;
}

const AUDIO_NUMERIC_FIELDS: Array<keyof AudioAnalysis> = [
  'durationSec',
  'sampleRate',
  'channels',
  'integratedLufs',
  'shortTermLufsMax',
  'momentaryLufsMax',
  'loudnessRangeLu',
  'rmsDb',
  'samplePeakDb',
  'truePeakDb',
  'dynamicRangeDb',
  'crestFactorDb',
  'plrDb',
  'transientDensity',
  'spectralCentroidHz',
  'spectralSlopeDbPerOct',
  'stereoWidth',
  'midSideRatioDb',
  'phaseCorrelation',
  'lowEndCorrelation',
  'lrBalanceDb',
  'monoCompatibilityScore',
  'clippedSamples',
  'interSamplePeaks',
  'thdEstimatePercent',
  'noiseFloorDb',
  'dcOffset',
];

const SPECTRAL_BANDS = ['sub', 'bass', 'lowMid', 'mid', 'highMid', 'presence', 'air'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumberArray(value: unknown, maxLength: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length <= maxLength &&
    value.every((item) => typeof item === 'number' && Number.isFinite(item))
  );
}

/** Reject incomplete, non-finite, or unreasonable telemetry before it reaches Gemini. */
export function isValidAnalysisPayload(value: unknown): value is AudioAnalysis {
  if (!isRecord(value)) return false;
  for (const key of AUDIO_NUMERIC_FIELDS) {
    const field = value[key];
    if (typeof field !== 'number' || !Number.isFinite(field)) return false;
  }

  const durationSec = value.durationSec as number;
  const sampleRate = value.sampleRate as number;
  const channels = value.channels as number;
  if (durationSec < 0 || durationSec > 60 * 60 * 12) return false;
  if (sampleRate < 8000 || sampleRate > 384000) return false;
  if (!Number.isInteger(channels) || channels < 1 || channels > 8) return false;

  const zoneEnergyDb = value.zoneEnergyDb;
  if (!isRecord(zoneEnergyDb)) return false;
  for (const key of SPECTRAL_BANDS) {
    const field = zoneEnergyDb[key];
    if (typeof field !== 'number' || !Number.isFinite(field)) return false;
  }

  const frequencies = value.spectrumBinsFreq;
  const spectrumDb = value.spectrumBinsDb;
  const loudnessHistory = value.loudnessHistoryLufs;
  const resonances = value.resonances;
  if (!isFiniteNumberArray(frequencies, 8192)) return false;
  if (!isFiniteNumberArray(spectrumDb, 8192)) return false;
  if (frequencies.length !== spectrumDb.length) return false;
  if (!isFiniteNumberArray(loudnessHistory, 4096)) return false;
  if (!Array.isArray(resonances) || resonances.length > 128) return false;
  return resonances.every((peak) =>
    isRecord(peak) &&
    typeof peak.freqHz === 'number' &&
    Number.isFinite(peak.freqHz) &&
    peak.freqHz >= 0 &&
    typeof peak.excessDb === 'number' &&
    Number.isFinite(peak.excessDb) &&
    typeof peak.severity === 'string' &&
    ['low', 'moderate', 'high'].includes(peak.severity),
  );
}

export type PluginSanitizationResult =
  | { valid: true; value?: SafeAvailablePlugin[] }
  | { valid: false; error: string };

/** Keep only bounded display metadata; never forward untrusted plugin objects. */
export function sanitizeAvailablePlugins(value: unknown): PluginSanitizationResult {
  if (value === undefined || value === null) return { valid: true, value: undefined };
  if (!Array.isArray(value) || value.length > 128) {
    return { valid: false, error: 'availablePlugins must be an array of at most 128 entries.' };
  }

  const sanitized: SafeAvailablePlugin[] = [];
  for (const [index, entry] of value.slice(0, 32).entries()) {
    if (!isRecord(entry)) {
      return { valid: false, error: `availablePlugins[${index}] must be an object.` };
    }
    sanitized.push({
      name: typeof entry.name === 'string' ? entry.name.slice(0, 80) : '',
      role: typeof entry.role === 'string' ? entry.role.slice(0, 40) : '',
      manufacturer: typeof entry.manufacturer === 'string' ? entry.manufacturer.slice(0, 80) : '',
    });
  }
  return { valid: true, value: sanitized };
}

export interface SafeVocalBalance {
  stemsCached: boolean;
  measurement: { vocalToMusicDb: number; vocalActiveRatio: number; bassToMixDb: number; drumsToMixDb: number } | null;
  range: { low: number; high: number };
}

/**
 * Vocal Rebalance context for the prompt: only bounded finite numbers pass. Anything malformed
 * becomes "stems not cached", which tells the model not to use the processor.
 */
export function sanitizeVocalBalance(value: unknown): SafeVocalBalance | undefined {
  if (value === undefined) return undefined;
  const notCached: SafeVocalBalance = { stemsCached: false, measurement: null, range: { low: -7, high: 2 } };
  if (!isRecord(value)) return notCached;
  const num = (v: unknown, min: number, max: number): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? Math.round(v * 100) / 100 : null;
  const range = isRecord(value.range) ? value.range : {};
  const low = num(range.low, -30, 10);
  const high = num(range.high, -30, 10);
  if (low === null || high === null || low > high) return notCached;
  let measurement: SafeVocalBalance['measurement'] = null;
  if (isRecord(value.measurement)) {
    const m = value.measurement;
    const v = num(m.vocalToMusicDb, -60, 40);
    const a = num(m.vocalActiveRatio, 0, 1);
    const b = num(m.bassToMixDb, -120, 20);
    const d = num(m.drumsToMixDb, -120, 20);
    if (v !== null && a !== null && b !== null && d !== null) measurement = { vocalToMusicDb: v, vocalActiveRatio: a, bassToMixDb: b, drumsToMixDb: d };
  }
  return { stemsCached: value.stemsCached === true, measurement, range: { low, high } };
}

const VALID_OBJECTIVE_SET = new Set<string>(MASTERING_OBJECTIVE_IDS);

export function sanitizeObjectiveId(value: unknown): MasteringObjectiveId | undefined {
  return typeof value === 'string' && VALID_OBJECTIVE_SET.has(value)
    ? (value as MasteringObjectiveId)
    : undefined;
}


/** Accept only fixed reason codes and finite, bounded measurements; never forward arbitrary prompt text. */
export function sanitizeGuardFeedback(value: unknown): GuardFeedback | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.pass !== 'number' || !Number.isInteger(value.pass) || value.pass < 1 || value.pass > 10) return undefined;
  if (!Array.isArray(value.reasonCodes) || value.reasonCodes.length < 1 || value.reasonCodes.length > 14) return undefined;
  const allowed = new Set<string>(GUARD_FEEDBACK_REASON_CODES);
  if (!value.reasonCodes.every((code) => typeof code === 'string' && allowed.has(code))) return undefined;
  const readMetric = (raw: unknown): GuardBalanceMetric | null => {
    if (!isRecord(raw)) return null;
    const limit = raw.limitDb, measured = raw.valueDb;
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < -120 || limit > 120) return null;
    if (measured !== null && (typeof measured !== 'number' || !Number.isFinite(measured) || measured < -120 || measured > 120)) return null;
    const valueDb = measured === null ? null : Math.round(measured * 100) / 100;
    const limitDb = Math.round(limit * 100) / 100;
    return { valueDb, limitDb, remainingDb: valueDb === null ? null : Math.round((limitDb - valueDb) * 100) / 100 };
  };
  const readSnapshot = (raw: unknown): GuardBalanceSnapshot | null => {
    if (!isRecord(raw)) return null;
    const bassVsMid = readMetric(raw.bassVsMid);
    const lowMidVsMid = readMetric(raw.lowMidVsMid);
    const region150To400VsMid = readMetric(raw.region150To400VsMid);
    const subVsBass = readMetric(raw.subVsBass);
    return bassVsMid && lowMidVsMid && region150To400VsMid && subVsBass
      ? { bassVsMid, lowMidVsMid, region150To400VsMid, subVsBass }
      : null;
  };
  const source = readSnapshot(value.source), rejected = readSnapshot(value.rejected);
  if (!source || !rejected) return undefined;
  return {
    pass: value.pass,
    reasonCodes: [...new Set(value.reasonCodes as GuardFeedback['reasonCodes'])],
    source,
    rejected,
  };
}

export function sanitizeMasteringMode(value: unknown): MasteringMode | undefined {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(MODE_MEANINGS, value)
    ? (value as MasteringMode)
    : undefined;
}

