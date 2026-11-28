import type {
  BassEnhancerParams,
  CompressorParams,
  DynamicEQBand,
  DynamicEQBandType,
  DynamicEQParams,
  EQBand,
  EQBandShape,
  EQBandSubtype,
  EQChannel,
  EQSlope,
  ExternalPluginParamValue,
  ExternalVST3Params,
  LimiterParams,
  MaximizerParams,
  MultibandBandParams,
  MultibandMaximizerBand,
  MultibandMaximizerParams,
  TransientShaperParams,
  ClipperParams,
  DitherParams,
  MatchEqParams,
  MultibandCompParams,
  ParametricEQParams,
  ProcessorModule,
  ProcessorType,
  RestoreParams,
  SaturationParams,
  StereoImagerParams,
} from '../types/mastering';
import { ALL_SLOPES, EQ_CHANNELS, EQ_SUBTYPES, DYNAMIC_EQ_TYPES, allowedSlopes, resolveSubtype } from './eqDesign.ts';
import { MATCH_EQ_CHANNELS, MATCH_EQ_LIMITS, MATCH_EQ_SMOOTHING_OPTIONS, isValidSpectrumSet } from './matchEq.ts';
import { DEFAULT_VOCAL_REBALANCE_PARAMS, sanitizeVocalRebalanceParams, VOCAL_REBALANCE_LIMITS } from './vocalRebalance.ts';

/** Band limits shared by the editors and AI validation. */
export const MAX_EQ_BANDS = 8;
export const MAX_DYNAMIC_EQ_BANDS = 8;
export const EQ_SHAPES: readonly EQBandShape[] = ['highpass', 'lowshelf', 'bell', 'highshelf', 'lowpass', 'notch', 'bandpass', 'tilt'];

/** Single source of truth for processor parameter ranges and enums (used by clampers and AI prompts). */
export const PROCESSOR_PARAM_LIMITS = {
  module: {
    intensity: [0, 100] as const,
    wetDry: [0, 100] as const,
    inputGainDb: [-12, 12] as const,
    outputGainDb: [-12, 12] as const,
  },
  'parametric-eq': {
    maxBands: MAX_EQ_BANDS,
    phaseMode: ['minimum', 'linear'] as const,
    msMode: ['stereo', 'mid-side'] as const,
    tiltDb: [-6, 6] as const,
    band: {
      shape: EQ_SHAPES,
      subtype: EQ_SUBTYPES,
      slope: ALL_SLOPES,
      channel: EQ_CHANNELS,
      freq: [20, 19500] as const,
      gain: [-12, 12] as const,
      q: [0.25, 12] as const,
    },
  },
  'dynamic-eq': {
    maxBands: MAX_DYNAMIC_EQ_BANDS,
    band: {
      type: DYNAMIC_EQ_TYPES,
      mode: ['cut', 'boost'] as const,
      channel: EQ_CHANNELS,
      freq: [30, 16000] as const,
      q: [0.5, 10] as const,
      thresholdDb: [-45, 0] as const,
      maxCutDbCut: [-12, 0] as const,
      maxCutDbBoost: [0, 12] as const,
      ratio: [1.0, 20.0] as const,
      kneeDb: [0, 24] as const,
      attackMs: [1, 100] as const,
      releaseMs: [20, 600] as const,
      lookaheadMs: [0, 10] as const,
      sidechainMode: ['band', 'custom'] as const,
      sidechainFreq: [20, 20000] as const,
      sidechainQ: [0.3, 12] as const,
    },
  },
  compressor: {
    mode: ['downward', 'upward', 'parallel'] as const,
    thresholdDb: [-40, 0] as const,
    ratio: [1.0, 12.0] as const,
    attackMs: [0.5, 150] as const,
    releaseMs: [20, 1000] as const,
    kneeDb: [0, 12] as const,
    makeupDb: [-6, 12] as const,
    scHpfHz: [20, 250] as const,
  },
  'multiband-comp': {
    lowCrossHz: [60, 600] as const,
    highCrossMinOffsetHz: 200,
    highCrossMaxHz: 10000,
    band: {
      thresholdDb: [-40, 0] as const,
      ratio: [1.0, 10.0] as const,
      attackMs: [1, 120] as const,
      releaseMs: [20, 800] as const,
      gainDb: [-6, 6] as const,
    },
  },
  saturation: {
    flavor: ['tube', 'tape', 'soft-clip', 'hard-clip', 'exciter'] as const,
    drive: [0, 100] as const,
    tone: [-100, 100] as const,
    harmonics: ['even', 'odd', 'balanced'] as const,
    oversampling: [1, 2, 4] as const,
  },
  'stereo-imager': {
    lowWidth: [0, 160] as const,
    midWidth: [0, 175] as const,
    highWidth: [0, 190] as const,
    lowCrossHz: [60, 500] as const,
    highCrossMinOffsetHz: 250,
    highCrossMaxHz: 12000,
    monoBassBelowHz: [0, 200] as const,
    lrBalanceDb: [-4, 4] as const,
    midSideGainDb: [-6, 6] as const,
  },
  restore: {
    humRemovalHz: [0, 50, 60] as const,
    hissReduction: [0, 100] as const,
    deEssAmount: [0, 100] as const,
    deEssFreqHz: [3500, 11000] as const,
    resonanceSuppress: [0, 100] as const,
    mode: ['conservative', 'aggressive'] as const,
    declick: [0, 100] as const,
    decrackle: [0, 100] as const,
    deShimmer: [0, 100] as const,
    declip: [0, 100] as const,
  },
  'bass-enhancer': {
    subFreqHz: [35, 95] as const,
    subGainDb: [0, 7] as const,
    harmonicDrive: [0, 100] as const,
    tightness: [0, 100] as const,
  },
  limiter: {
    ceilingDb: [-6.0, -0.1] as const,
    thresholdDb: [-18.0, 0.0] as const,
    releaseMs: [10, 500] as const,
    lookaheadMs: [0, 10] as const,
    oversampling: [1, 2, 4] as const,
  },
  maximizer: {
    character: ['transparent', 'punchy', 'aggressive', 'smooth'] as const,
    targetLufs: [-24, -6] as const,
    ceilingDb: [-3.0, -0.1] as const,
    transientEmphasis: [0, 100] as const,
  },
  'transient-shaper': {
    attackDb: [-12, 12] as const,
    sustainDb: [-12, 12] as const,
    speedMs: [2, 60] as const,
    lowCutHz: [20, 300] as const,
  },
  clipper: {
    ceilingDb: [-6, 0] as const,
    driveDb: [0, 12] as const,
    softness: [0, 100] as const,
    oversampling: [1, 2, 4] as const,
  },
  'multiband-maximizer': {
    lowCrossHz: [40, 600] as const,
    highCrossMinOffsetHz: 250,
    highCrossMaxHz: 12000,
    band: {
      preGainDb: [-6, 12] as const,
      thresholdDb: [-36, 0] as const,
      ratio: [1, 20] as const,
      attackMs: [0.5, 200] as const,
      releaseMs: [10, 1000] as const,
      postGainDb: [-12, 6] as const,
    },
    ceilingDb: [-3, -0.1] as const,
    releaseMs: [10, 500] as const,
  },
  dither: {
    bitDepth: [16, 20, 24] as const,
    shape: ['tpdf', 'tpdf-hp', 'shaped'] as const,
  },
  'match-eq': {
    ...MATCH_EQ_LIMITS,
    smoothing: MATCH_EQ_SMOOTHING_OPTIONS,
    channel: MATCH_EQ_CHANNELS,
    phase: ['linear', 'minimum'] as const,
  },
  'vocal-rebalance': {
    vocalGainDb: [VOCAL_REBALANCE_LIMITS.gainMinDb, VOCAL_REBALANCE_LIMITS.gainMaxDb] as const,
    bassGainDb: [VOCAL_REBALANCE_LIMITS.gainMinDb, VOCAL_REBALANCE_LIMITS.gainMaxDb] as const,
    drumsGainDb: [VOCAL_REBALANCE_LIMITS.gainMinDb, VOCAL_REBALANCE_LIMITS.gainMaxDb] as const,
    sensitivity: [VOCAL_REBALANCE_LIMITS.sensitivityMin, VOCAL_REBALANCE_LIMITS.sensitivityMax] as const,
    smoothingMs: [VOCAL_REBALANCE_LIMITS.smoothingMinMs, VOCAL_REBALANCE_LIMITS.smoothingMaxMs] as const,
  },
} as const;

function clamp(v: number, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

export const PROCESSOR_DEFAULT_NAMES: Record<ProcessorType, string> = {
  'parametric-eq': 'Master Parametric EQ',
  'dynamic-eq': 'Dynamic Resonance EQ',
  compressor: 'Master Glue Compressor',
  'multiband-comp': '3-Band Multiband Dynamics',
  saturation: 'Analog Harmonic Saturator',
  'stereo-imager': 'Multiband Stereo Imager',
  restore: 'SYN-Restore Cleanup',
  'bass-enhancer': 'Sub-Bass & Low-End Sculptor',
  limiter: 'True Peak Lookahead Limiter',
  maximizer: 'Intelligent Maximizer',
  'transient-shaper': 'Transient Shaper',
  clipper: 'Peak Clipper',
  'multiband-maximizer': 'Multiband Maximizer (Maximus-style)',
  dither: 'Dither',
  'match-eq': 'Match EQ',
  'vocal-rebalance': 'Vocal Rebalance',
  'external-vst3': 'External VST3 Plugin',
};

export function createDefaultParams(type: ProcessorType): ProcessorModule['params'] {
  switch (type) {
    case 'parametric-eq':
      return {
        phaseMode: 'minimum',
        msMode: 'stereo',
        tiltDb: 0,
        bands: [
          { id: 'b1', enabled: true, shape: 'highpass', freq: 28, gain: 0, q: 0.71 },
          { id: 'b2', enabled: true, shape: 'lowshelf', freq: 95, gain: 0, q: 0.71 },
          { id: 'b3', enabled: true, shape: 'bell', freq: 320, gain: 0, q: 1.4 },
          { id: 'b4', enabled: true, shape: 'bell', freq: 2800, gain: 0, q: 1.2 },
          { id: 'b5', enabled: true, shape: 'highshelf', freq: 11500, gain: 0, q: 0.71 },
        ],
      } satisfies ParametricEQParams;
    case 'dynamic-eq':
      return {
        bands: [
          { id: 'd1', enabled: true, freq: 260, q: 2.2, thresholdDb: -22, maxCutDb: -3.5, ratio: 20 / 7, mode: 'cut', attackMs: 12, releaseMs: 120 },
          { id: 'd2', enabled: true, freq: 3800, q: 2.5, thresholdDb: -20, maxCutDb: -3.0, ratio: 20 / 7, mode: 'cut', attackMs: 8, releaseMs: 90 },
        ],
      } satisfies DynamicEQParams;
    case 'compressor':
      return {
        mode: 'downward',
        thresholdDb: -16,
        ratio: 2.2,
        attackMs: 18,
        releaseMs: 140,
        kneeDb: 4,
        makeupDb: 1.0,
        scHpfHz: 75,
      } satisfies CompressorParams;
    case 'multiband-comp':
      return {
        lowCrossHz: 180,
        highCrossHz: 3200,
        low: { thresholdDb: -18, ratio: 2.4, attackMs: 25, releaseMs: 160, gainDb: 0, bypass: false },
        mid: { thresholdDb: -17, ratio: 2.0, attackMs: 15, releaseMs: 120, gainDb: 0, bypass: false },
        high: { thresholdDb: -20, ratio: 2.2, attackMs: 8, releaseMs: 80, gainDb: 0, bypass: false },
      } satisfies MultibandCompParams;
    case 'saturation':
      return {
        flavor: 'tape',
        drive: 22,
        tone: 0,
        harmonics: 'balanced',
        oversampling: 2,
      } satisfies SaturationParams;
    case 'stereo-imager':
      return {
        lowWidth: 85,
        midWidth: 108,
        highWidth: 118,
        lowCrossHz: 160,
        highCrossHz: 3500,
        monoBassBelowHz: 95,
        lrBalanceDb: 0,
        midSideGainDb: 0,
      } satisfies StereoImagerParams;
    case 'restore':
      return {
        dcOffset: true,
        humRemovalHz: 0,
        hissReduction: 12,
        deEssAmount: 18,
        deEssFreqHz: 6500,
        resonanceSuppress: 15,
        mode: 'conservative',
        declick: 0,
        decrackle: 0,
        spikeRepair: false,
        deShimmer: 0,
        declip: 0,
      } satisfies RestoreParams;
    case 'bass-enhancer':
      return {
        subFreqHz: 55,
        subGainDb: 1.5,
        harmonicDrive: 24,
        tightness: 55,
        monoFocus: true,
      } satisfies BassEnhancerParams;
    case 'limiter':
      return {
        ceilingDb: -1.0,
        thresholdDb: -3.5,
        releaseMs: 90,
        lookaheadMs: 3,
        truePeak: true,
        oversampling: 4,
      } satisfies LimiterParams;
    case 'maximizer':
      return {
        character: 'transparent',
        targetLufs: -14,
        ceilingDb: -1.0,
        transientEmphasis: 25,
        truePeak: true,
      } satisfies MaximizerParams;
    case 'transient-shaper':
      return { attackDb: 2, sustainDb: 0, speedMs: 15, lowCutHz: 80 } satisfies TransientShaperParams;
    case 'dither':
      return { bitDepth: 24, shape: 'tpdf', autoBlank: true } satisfies DitherParams;
    case 'match-eq':
      return {
        amount: 75,
        smoothing: 3,
        maxBoostDb: 6,
        maxCutDb: 6,
        lowHz: 30,
        highHz: 18000,
        channel: 'stereo',
        phase: 'linear',
      } satisfies MatchEqParams;
    case 'vocal-rebalance':
      return { ...DEFAULT_VOCAL_REBALANCE_PARAMS };
    case 'clipper':
      return { ceilingDb: -0.8, driveDb: 1.5, softness: 60, oversampling: 4 } satisfies ClipperParams;
    case 'multiband-maximizer':
      return {
        lowCrossHz: 150,
        highCrossHz: 4000,
        low: { preGainDb: 1.5, thresholdDb: -16, ratio: 3, attackMs: 25, releaseMs: 160, postGainDb: 0, bypass: false },
        mid: { preGainDb: 1.5, thresholdDb: -18, ratio: 2.5, attackMs: 12, releaseMs: 120, postGainDb: 0, bypass: false },
        high: { preGainDb: 1, thresholdDb: -20, ratio: 2.5, attackMs: 6, releaseMs: 90, postGainDb: 0, bypass: false },
        ceilingDb: -1,
        releaseMs: 80,
      } satisfies MultibandMaximizerParams;
    case 'external-vst3':
      return {
        uid: '',
        bundlePath: '',
        pluginName: 'External VST3 Plugin',
        manufacturer: 'Unknown',
        version: '',
        format: 'vst3',
        instanceId: null,
        latencySamples: 0,
        hasEditor: false,
        editorOpen: false,
        status: 'unloaded',
        lastError: '',
        stateBase64: '',
        parameters: [],
      } satisfies ExternalVST3Params;
  }
}

export function createProcessorModule(
  type: ProcessorType,
  overrides?: Partial<ProcessorModule>,
): ProcessorModule {
  const id = overrides?.id ?? `${type}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    type,
    name: overrides?.name ?? PROCESSOR_DEFAULT_NAMES[type],
    enabled: overrides?.enabled ?? true,
    bypassed: overrides?.bypassed ?? false,
    intensity: clamp(overrides?.intensity ?? 100, PROCESSOR_PARAM_LIMITS.module.intensity[0], PROCESSOR_PARAM_LIMITS.module.intensity[1], 100),
    wetDry: clamp(overrides?.wetDry ?? 100, PROCESSOR_PARAM_LIMITS.module.wetDry[0], PROCESSOR_PARAM_LIMITS.module.wetDry[1], 100),
    inputGainDb: clamp(overrides?.inputGainDb ?? 0, PROCESSOR_PARAM_LIMITS.module.inputGainDb[0], PROCESSOR_PARAM_LIMITS.module.inputGainDb[1], 0),
    outputGainDb: clamp(overrides?.outputGainDb ?? 0, PROCESSOR_PARAM_LIMITS.module.outputGainDb[0], PROCESSOR_PARAM_LIMITS.module.outputGainDb[1], 0),
    expanded: overrides?.expanded ?? false,
    presetName: overrides?.presetName,
    group: overrides?.group,
    params: validateProcessorParams(type, overrides?.params ?? createDefaultParams(type)),
  };
}

export function validateProcessorParams(
  type: ProcessorType,
  raw: unknown,
): ProcessorModule['params'] {
  const defaults = createDefaultParams(type);
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  switch (type) {
    case 'parametric-eq': {
      const lim = PROCESSOR_PARAM_LIMITS['parametric-eq'];
      const def = defaults as ParametricEQParams;
      const rawBands = Array.isArray(src.bands) ? src.bands : def.bands;
      const bands: EQBand[] = rawBands.slice(0, lim.maxBands).map((b, idx) => {
        const bo = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
        const shape = (lim.band.shape as readonly string[]).includes(String(bo.shape))
          ? (bo.shape as EQBand['shape'])
          : 'bell';
        const band: EQBand = {
          id: typeof bo.id === 'string' && bo.id ? bo.id : `b${idx + 1}`,
          enabled: bo.enabled !== false,
          shape,
          freq: clamp(Number(bo.freq), lim.band.freq[0], lim.band.freq[1], 1000),
          gain: clamp(Number(bo.gain), lim.band.gain[0], lim.band.gain[1], 0),
          q: clamp(Number(bo.q), lim.band.q[0], lim.band.q[1], 1.0),
        };
        // New fields are only written when present and valid, so legacy bands keep their exact shape.
        if (typeof bo.subtype === 'string' && lim.band.subtype[shape].includes(bo.subtype as EQBandSubtype)) {
          band.subtype = bo.subtype as EQBandSubtype;
        }
        const slope = Number(bo.slope);
        if (bo.slope !== undefined && allowedSlopes(shape, resolveSubtype(band)).includes(slope as EQSlope)) {
          band.slope = slope as EQSlope;
        }
        if (typeof bo.channel === 'string' && (lim.band.channel as readonly string[]).includes(bo.channel)) {
          band.channel = bo.channel as EQChannel;
        }
        if (bo.solo === true) band.solo = true;
        return band;
      });
      const out: ParametricEQParams = {
        phaseMode: src.phaseMode === 'linear' ? 'linear' : 'minimum',
        msMode: src.msMode === 'mid-side' ? 'mid-side' : 'stereo',
        tiltDb: clamp(Number(src.tiltDb), lim.tiltDb[0], lim.tiltDb[1], 0),
        bands: bands.length > 0 ? bands : def.bands,
      };
      if (src.autoGain === true) out.autoGain = true;
      return out;
    }
    case 'dynamic-eq': {
      const lim = PROCESSOR_PARAM_LIMITS['dynamic-eq'];
      const def = defaults as DynamicEQParams;
      const rawBands = Array.isArray(src.bands) ? src.bands : def.bands;
      return {
        bands: rawBands.slice(0, lim.maxBands).map((b, idx): DynamicEQBand => {
          const bo = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
          const mode: 'cut' | 'boost' = bo.mode === 'boost' ? 'boost' : 'cut';
          const band: DynamicEQBand = {
            id: typeof bo.id === 'string' && bo.id ? bo.id : `d${idx + 1}`,
            enabled: bo.enabled !== false,
            freq: clamp(Number(bo.freq), lim.band.freq[0], lim.band.freq[1], 500),
            q: clamp(Number(bo.q), lim.band.q[0], lim.band.q[1], 2.0),
            thresholdDb: clamp(Number(bo.thresholdDb), lim.band.thresholdDb[0], lim.band.thresholdDb[1], -20),
            maxCutDb: mode === 'boost'
              ? clamp(Number(bo.maxCutDb), lim.band.maxCutDbBoost[0], lim.band.maxCutDbBoost[1], 3)
              : clamp(Number(bo.maxCutDb), lim.band.maxCutDbCut[0], lim.band.maxCutDbCut[1], -3),
            ratio: clamp(Number(bo.ratio), lim.band.ratio[0], lim.band.ratio[1], 20 / 7),
            mode,
            attackMs: clamp(Number(bo.attackMs), lim.band.attackMs[0], lim.band.attackMs[1], 10),
            releaseMs: clamp(Number(bo.releaseMs), lim.band.releaseMs[0], lim.band.releaseMs[1], 110),
          };
          if (typeof bo.type === 'string' && (lim.band.type as readonly string[]).includes(bo.type)) {
            band.type = bo.type as DynamicEQBandType;
          }
          if (bo.kneeDb !== undefined && Number.isFinite(Number(bo.kneeDb))) {
            band.kneeDb = clamp(Number(bo.kneeDb), lim.band.kneeDb[0], lim.band.kneeDb[1], 0);
          }
          if (typeof bo.channel === 'string' && (lim.band.channel as readonly string[]).includes(bo.channel)) {
            band.channel = bo.channel as EQChannel;
          }
          if (bo.sidechain && typeof bo.sidechain === 'object') {
            const sc = bo.sidechain as Record<string, unknown>;
            band.sidechain = {
              mode: sc.mode === 'custom' ? 'custom' : 'band',
              freq: clamp(Number(sc.freq), lim.band.sidechainFreq[0], lim.band.sidechainFreq[1], band.freq),
              q: clamp(Number(sc.q), lim.band.sidechainQ[0], lim.band.sidechainQ[1], band.q),
            };
          }
          if (bo.lookaheadMs !== undefined && Number.isFinite(Number(bo.lookaheadMs))) {
            band.lookaheadMs = clamp(Number(bo.lookaheadMs), lim.band.lookaheadMs[0], lim.band.lookaheadMs[1], 0);
          }
          if (bo.solo === true) band.solo = true;
          return band;
        }),
      };
    }
    case 'compressor': {
      const lim = PROCESSOR_PARAM_LIMITS.compressor;
      const def = defaults as CompressorParams;
      return {
        mode: (lim.mode as readonly string[]).includes(String(src.mode))
          ? (src.mode as CompressorParams['mode'])
          : def.mode,
        thresholdDb: clamp(Number(src.thresholdDb), lim.thresholdDb[0], lim.thresholdDb[1], def.thresholdDb),
        ratio: clamp(Number(src.ratio), lim.ratio[0], lim.ratio[1], def.ratio),
        attackMs: clamp(Number(src.attackMs), lim.attackMs[0], lim.attackMs[1], def.attackMs),
        releaseMs: clamp(Number(src.releaseMs), lim.releaseMs[0], lim.releaseMs[1], def.releaseMs),
        kneeDb: clamp(Number(src.kneeDb), lim.kneeDb[0], lim.kneeDb[1], def.kneeDb),
        makeupDb: clamp(Number(src.makeupDb), lim.makeupDb[0], lim.makeupDb[1], def.makeupDb),
        scHpfHz: clamp(Number(src.scHpfHz), lim.scHpfHz[0], lim.scHpfHz[1], def.scHpfHz),
      };
    }
    case 'multiband-comp': {
      const lim = PROCESSOR_PARAM_LIMITS['multiband-comp'];
      const def = defaults as MultibandCompParams;
      const validateBand = (b: unknown, fb: MultibandBandParams): MultibandBandParams => {
        const bo = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
        return {
          thresholdDb: clamp(Number(bo.thresholdDb), lim.band.thresholdDb[0], lim.band.thresholdDb[1], fb.thresholdDb),
          ratio: clamp(Number(bo.ratio), lim.band.ratio[0], lim.band.ratio[1], fb.ratio),
          attackMs: clamp(Number(bo.attackMs), lim.band.attackMs[0], lim.band.attackMs[1], fb.attackMs),
          releaseMs: clamp(Number(bo.releaseMs), lim.band.releaseMs[0], lim.band.releaseMs[1], fb.releaseMs),
          gainDb: clamp(Number(bo.gainDb), lim.band.gainDb[0], lim.band.gainDb[1], fb.gainDb),
          bypass: bo.bypass === true,
        };
      };
      const lowCross = clamp(Number(src.lowCrossHz), lim.lowCrossHz[0], lim.lowCrossHz[1], def.lowCrossHz);
      const highCross = clamp(Number(src.highCrossHz), lowCross + lim.highCrossMinOffsetHz, lim.highCrossMaxHz, def.highCrossHz);
      return {
        lowCrossHz: lowCross,
        highCrossHz: highCross,
        low: validateBand(src.low, def.low),
        mid: validateBand(src.mid, def.mid),
        high: validateBand(src.high, def.high),
      };
    }
    case 'saturation': {
      const lim = PROCESSOR_PARAM_LIMITS.saturation;
      const def = defaults as SaturationParams;
      return {
        flavor: (lim.flavor as readonly string[]).includes(String(src.flavor))
          ? (src.flavor as SaturationParams['flavor'])
          : def.flavor,
        drive: clamp(Number(src.drive), lim.drive[0], lim.drive[1], def.drive),
        tone: clamp(Number(src.tone), lim.tone[0], lim.tone[1], def.tone),
        harmonics: (lim.harmonics as readonly string[]).includes(String(src.harmonics))
          ? (src.harmonics as SaturationParams['harmonics'])
          : def.harmonics,
        oversampling: (lim.oversampling as readonly number[]).includes(Number(src.oversampling))
          ? (Number(src.oversampling) as 1 | 2 | 4)
          : 2,
      };
    }
    case 'stereo-imager': {
      const lim = PROCESSOR_PARAM_LIMITS['stereo-imager'];
      const def = defaults as StereoImagerParams;
      const lowCross = clamp(Number(src.lowCrossHz), lim.lowCrossHz[0], lim.lowCrossHz[1], def.lowCrossHz);
      return {
        lowWidth: clamp(Number(src.lowWidth), lim.lowWidth[0], lim.lowWidth[1], def.lowWidth),
        midWidth: clamp(Number(src.midWidth), lim.midWidth[0], lim.midWidth[1], def.midWidth),
        highWidth: clamp(Number(src.highWidth), lim.highWidth[0], lim.highWidth[1], def.highWidth),
        lowCrossHz: lowCross,
        highCrossHz: clamp(Number(src.highCrossHz), lowCross + lim.highCrossMinOffsetHz, lim.highCrossMaxHz, def.highCrossHz),
        monoBassBelowHz: clamp(Number(src.monoBassBelowHz), lim.monoBassBelowHz[0], lim.monoBassBelowHz[1], def.monoBassBelowHz),
        lrBalanceDb: clamp(Number(src.lrBalanceDb), lim.lrBalanceDb[0], lim.lrBalanceDb[1], def.lrBalanceDb),
        midSideGainDb: clamp(Number(src.midSideGainDb), lim.midSideGainDb[0], lim.midSideGainDb[1], def.midSideGainDb),
      };
    }
    case 'restore': {
      const lim = PROCESSOR_PARAM_LIMITS.restore;
      const def = defaults as RestoreParams;
      return {
        dcOffset: src.dcOffset !== false,
        humRemovalHz: (lim.humRemovalHz as readonly number[]).includes(Number(src.humRemovalHz))
          ? (Number(src.humRemovalHz) as 0 | 50 | 60)
          : 0,
        hissReduction: clamp(Number(src.hissReduction), lim.hissReduction[0], lim.hissReduction[1], def.hissReduction),
        deEssAmount: clamp(Number(src.deEssAmount), lim.deEssAmount[0], lim.deEssAmount[1], def.deEssAmount),
        deEssFreqHz: clamp(Number(src.deEssFreqHz), lim.deEssFreqHz[0], lim.deEssFreqHz[1], def.deEssFreqHz),
        resonanceSuppress: clamp(Number(src.resonanceSuppress), lim.resonanceSuppress[0], lim.resonanceSuppress[1], def.resonanceSuppress),
        mode: src.mode === 'aggressive' ? 'aggressive' : 'conservative',
        declick: clamp(Number(src.declick), lim.declick[0], lim.declick[1], def.declick ?? 0),
        decrackle: clamp(Number(src.decrackle), lim.decrackle[0], lim.decrackle[1], def.decrackle ?? 0),
        spikeRepair: src.spikeRepair === true,
        deShimmer: clamp(Number(src.deShimmer), lim.deShimmer[0], lim.deShimmer[1], def.deShimmer ?? 0),
      };
    }
    case 'bass-enhancer': {
      const lim = PROCESSOR_PARAM_LIMITS['bass-enhancer'];
      const def = defaults as BassEnhancerParams;
      return {
        subFreqHz: clamp(Number(src.subFreqHz), lim.subFreqHz[0], lim.subFreqHz[1], def.subFreqHz),
        subGainDb: clamp(Number(src.subGainDb), lim.subGainDb[0], lim.subGainDb[1], def.subGainDb),
        harmonicDrive: clamp(Number(src.harmonicDrive), lim.harmonicDrive[0], lim.harmonicDrive[1], def.harmonicDrive),
        tightness: clamp(Number(src.tightness), lim.tightness[0], lim.tightness[1], def.tightness),
        monoFocus: src.monoFocus !== false,
      };
    }
    case 'limiter': {
      const lim = PROCESSOR_PARAM_LIMITS.limiter;
      const def = defaults as LimiterParams;
      return {
        ceilingDb: clamp(Number(src.ceilingDb), lim.ceilingDb[0], lim.ceilingDb[1], def.ceilingDb),
        thresholdDb: clamp(Number(src.thresholdDb), lim.thresholdDb[0], lim.thresholdDb[1], def.thresholdDb),
        releaseMs: clamp(Number(src.releaseMs), lim.releaseMs[0], lim.releaseMs[1], def.releaseMs),
        lookaheadMs: clamp(Number(src.lookaheadMs), lim.lookaheadMs[0], lim.lookaheadMs[1], def.lookaheadMs),
        truePeak: src.truePeak !== false,
        oversampling: (lim.oversampling as readonly number[]).includes(Number(src.oversampling))
          ? (Number(src.oversampling) as 1 | 2 | 4)
          : 4,
      };
    }
    case 'maximizer': {
      const lim = PROCESSOR_PARAM_LIMITS.maximizer;
      const def = defaults as MaximizerParams;
      return {
        character: (lim.character as readonly string[]).includes(String(src.character))
          ? (src.character as MaximizerParams['character'])
          : def.character,
        targetLufs: clamp(Number(src.targetLufs), lim.targetLufs[0], lim.targetLufs[1], def.targetLufs),
        ceilingDb: clamp(Number(src.ceilingDb), lim.ceilingDb[0], lim.ceilingDb[1], def.ceilingDb),
        transientEmphasis: clamp(Number(src.transientEmphasis), lim.transientEmphasis[0], lim.transientEmphasis[1], def.transientEmphasis),
        truePeak: src.truePeak !== false,
      };
    }
    case 'transient-shaper': {
      const lim = PROCESSOR_PARAM_LIMITS['transient-shaper'];
      const def = defaults as TransientShaperParams;
      return {
        attackDb: clamp(Number(src.attackDb), lim.attackDb[0], lim.attackDb[1], def.attackDb),
        sustainDb: clamp(Number(src.sustainDb), lim.sustainDb[0], lim.sustainDb[1], def.sustainDb),
        speedMs: clamp(Number(src.speedMs), lim.speedMs[0], lim.speedMs[1], def.speedMs),
        lowCutHz: clamp(Number(src.lowCutHz), lim.lowCutHz[0], lim.lowCutHz[1], def.lowCutHz),
      };
    }
    case 'dither': {
      const lim = PROCESSOR_PARAM_LIMITS.dither;
      const def = defaults as DitherParams;
      const bd = Number(src.bitDepth);
      const shape = src.shape;
      return {
        bitDepth: (lim.bitDepth as readonly number[]).includes(bd) ? (bd as DitherParams['bitDepth']) : def.bitDepth,
        shape: (lim.shape as readonly string[]).includes(String(shape)) ? (shape as DitherParams['shape']) : def.shape,
        autoBlank: typeof src.autoBlank === 'boolean' ? src.autoBlank : def.autoBlank,
      };
    }
    case 'match-eq': {
      const lim = PROCESSOR_PARAM_LIMITS['match-eq'];
      const def = defaults as MatchEqParams;
      const sm = Number(src.smoothing);
      const lowHz = clamp(Number(src.lowHz), lim.lowHz[0], lim.lowHz[1], def.lowHz);
      const out: MatchEqParams = {
        amount: clamp(Number(src.amount), lim.amount[0], lim.amount[1], def.amount),
        smoothing: (lim.smoothing as readonly number[]).includes(sm) ? (sm as MatchEqParams['smoothing']) : def.smoothing,
        maxBoostDb: clamp(Number(src.maxBoostDb), lim.maxBoostDb[0], lim.maxBoostDb[1], def.maxBoostDb),
        maxCutDb: clamp(Math.abs(Number(src.maxCutDb)), lim.maxCutDb[0], lim.maxCutDb[1], def.maxCutDb),
        lowHz,
        highHz: clamp(Number(src.highHz), Math.max(lim.highHz[0], lowHz * 2), lim.highHz[1], Math.max(def.highHz, lowHz * 2)),
        channel: (lim.channel as readonly string[]).includes(String(src.channel)) ? (src.channel as MatchEqParams['channel']) : def.channel,
        phase: src.phase === 'minimum' ? 'minimum' : 'linear',
      };
      // Learned spectra are kept only when complete and finite (fixed 1/24-octave grid).
      if (isValidSpectrumSet(src.source) && isValidSpectrumSet(src.reference)) {
        out.source = { stereo: [...src.source.stereo], mid: [...src.source.mid], side: [...src.source.side] };
        out.reference = { stereo: [...src.reference.stereo], mid: [...src.reference.mid], side: [...src.reference.side] };
        if (typeof src.referenceName === 'string' && src.referenceName) out.referenceName = src.referenceName.slice(0, 160);
      }
      return out;
    }
    case 'vocal-rebalance':
      return sanitizeVocalRebalanceParams(src);
    case 'clipper': {
      const lim = PROCESSOR_PARAM_LIMITS.clipper;
      const def = defaults as ClipperParams;
      const os = Number(src.oversampling);
      return {
        ceilingDb: clamp(Number(src.ceilingDb), lim.ceilingDb[0], lim.ceilingDb[1], def.ceilingDb),
        driveDb: clamp(Number(src.driveDb), lim.driveDb[0], lim.driveDb[1], def.driveDb),
        softness: clamp(Number(src.softness), lim.softness[0], lim.softness[1], def.softness),
        oversampling: (lim.oversampling as readonly number[]).includes(os) ? (os as ClipperParams['oversampling']) : def.oversampling,
      };
    }
    case 'multiband-maximizer': {
      const lim = PROCESSOR_PARAM_LIMITS['multiband-maximizer'];
      const def = defaults as MultibandMaximizerParams;
      const band = (raw: unknown, d: MultibandMaximizerBand): MultibandMaximizerBand => {
        const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
        return {
          preGainDb: clamp(Number(b.preGainDb), lim.band.preGainDb[0], lim.band.preGainDb[1], d.preGainDb),
          thresholdDb: clamp(Number(b.thresholdDb), lim.band.thresholdDb[0], lim.band.thresholdDb[1], d.thresholdDb),
          ratio: clamp(Number(b.ratio), lim.band.ratio[0], lim.band.ratio[1], d.ratio),
          attackMs: clamp(Number(b.attackMs), lim.band.attackMs[0], lim.band.attackMs[1], d.attackMs),
          releaseMs: clamp(Number(b.releaseMs), lim.band.releaseMs[0], lim.band.releaseMs[1], d.releaseMs),
          postGainDb: clamp(Number(b.postGainDb), lim.band.postGainDb[0], lim.band.postGainDb[1], d.postGainDb),
          bypass: b.bypass === true,
        };
      };
      const lowCross = clamp(Number(src.lowCrossHz), lim.lowCrossHz[0], lim.lowCrossHz[1], def.lowCrossHz);
      return {
        lowCrossHz: lowCross,
        highCrossHz: clamp(Number(src.highCrossHz), lowCross + lim.highCrossMinOffsetHz, lim.highCrossMaxHz, def.highCrossHz),
        low: band(src.low, def.low),
        mid: band(src.mid, def.mid),
        high: band(src.high, def.high),
        ceilingDb: clamp(Number(src.ceilingDb), lim.ceilingDb[0], lim.ceilingDb[1], def.ceilingDb),
        releaseMs: clamp(Number(src.releaseMs), lim.releaseMs[0], lim.releaseMs[1], def.releaseMs),
      };
    }
    case 'external-vst3': {
      const def = defaults as ExternalVST3Params;
      const rawParams = Array.isArray(src.parameters) ? src.parameters : [];
      const parameters: ExternalPluginParamValue[] = rawParams.slice(0, 256).map((item, idx) => {
        const po = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
        const defVal = clamp(Number(po.defaultValueNormalized), 0, 1, 0);
        return {
          id: typeof po.id === 'number' && Number.isInteger(po.id) ? po.id : idx,
          name: typeof po.name === 'string' ? po.name.slice(0, 128) : `Param ${idx}`,
          label: typeof po.label === 'string' ? po.label.slice(0, 32) : '',
          valueNormalized: clamp(Number(po.valueNormalized ?? defVal), 0, 1, defVal),
          defaultValueNormalized: defVal,
          stepCount: typeof po.stepCount === 'number' ? Math.max(0, Math.round(po.stepCount)) : 0,
          isAutomatable: po.isAutomatable !== false,
          isReadOnly: po.isReadOnly === true,
          isBypass: po.isBypass === true,
          displayValue: typeof po.displayValue === 'string' ? po.displayValue.slice(0, 64) : undefined,
        };
      });
      const validStatus = ['unloaded', 'loading', 'active', 'crashed', 'host-offline', 'error'].includes(
        String(src.status),
      )
        ? (src.status as ExternalVST3Params['status'])
        : def.status;
      return {
        uid: typeof src.uid === 'string' ? src.uid : def.uid,
        bundlePath: typeof src.bundlePath === 'string' ? src.bundlePath : def.bundlePath,
        pluginName: typeof src.pluginName === 'string' && src.pluginName ? src.pluginName : def.pluginName,
        manufacturer: typeof src.manufacturer === 'string' && src.manufacturer ? src.manufacturer : def.manufacturer,
        version: typeof src.version === 'string' ? src.version : def.version,
        format: ['vst3', 'clap', 'au', 'lv2'].includes(String(src.format))
          ? (src.format as ExternalVST3Params['format'])
          : 'vst3',
        instanceId: typeof src.instanceId === 'string' && src.instanceId ? src.instanceId : null,
        latencySamples: clamp(Number(src.latencySamples), 0, 131072, 0),
        hasEditor: src.hasEditor === true,
        editorOpen: src.editorOpen === true,
        status: validStatus,
        lastError: typeof src.lastError === 'string' ? src.lastError.slice(0, 512) : '',
        stateBase64: typeof src.stateBase64 === 'string' ? src.stateBase64.slice(0, 1024 * 1024) : '',
        parameters,
      };
    }
  }
}

const VALID_TYPES = new Set<ProcessorType>([
  'parametric-eq',
  'dynamic-eq',
  'compressor',
  'multiband-comp',
  'saturation',
  'stereo-imager',
  'restore',
  'bass-enhancer',
  'limiter',
  'maximizer',
  'transient-shaper',
  'clipper',
  'multiband-maximizer',
  'dither',
  'match-eq',
  'vocal-rebalance',
  'external-vst3',
]);

export function validateChain(rawChain: unknown): ProcessorModule[] {
  if (!Array.isArray(rawChain)) return [];
  const validated: ProcessorModule[] = [];
  for (const item of rawChain.slice(0, 12)) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const type = obj.type as ProcessorType;
    if (!VALID_TYPES.has(type)) continue;
    validated.push(
      createProcessorModule(type, {
        id: typeof obj.id === 'string' && obj.id ? obj.id : undefined,
        name: typeof obj.name === 'string' && obj.name ? obj.name : PROCESSOR_DEFAULT_NAMES[type],
        enabled: obj.enabled !== false,
        bypassed: obj.bypassed === true,
        intensity: Number(obj.intensity ?? 100),
        wetDry: Number(obj.wetDry ?? 100),
        inputGainDb: Number(obj.inputGainDb ?? 0),
        outputGainDb: Number(obj.outputGainDb ?? 0),
        expanded: Boolean(obj.expanded),
        presetName: typeof obj.presetName === 'string' ? obj.presetName : undefined,
        params: obj.params as ProcessorModule['params'],
      }),
    );
  }
  return hoistVocalRebalance(validated);
}

/**
 * Vocal Rebalance works on stems of the SOURCE, so it must see the unprocessed track: keep a
 * single instance and move it to the head of the chain. Chains without it are returned as-is.
 */
export function hoistVocalRebalance(chain: ProcessorModule[]): ProcessorModule[] {
  const first = chain.findIndex((m) => m.type === 'vocal-rebalance');
  if (first < 0) return chain;
  const rest = chain.filter((m) => m.type !== 'vocal-rebalance');
  if (first === 0 && rest.length === chain.length - 1) return chain;
  return [chain[first], ...rest];
}
