import type { AudioAnalysis } from '../types/mastering.ts';

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
