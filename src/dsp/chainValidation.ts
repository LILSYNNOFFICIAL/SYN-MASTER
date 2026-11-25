import type {
  BassEnhancerParams,
  CompressorParams,
  DynamicEQParams,
  EQBand,
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
  MultibandCompParams,
  ParametricEQParams,
  ProcessorModule,
  ProcessorType,
  RestoreParams,
  SaturationParams,
  StereoImagerParams,
} from '../types/mastering';

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
    intensity: clamp(overrides?.intensity ?? 100, 0, 100, 100),
    wetDry: clamp(overrides?.wetDry ?? 100, 0, 100, 100),
    inputGainDb: clamp(overrides?.inputGainDb ?? 0, -12, 12, 0),
    outputGainDb: clamp(overrides?.outputGainDb ?? 0, -12, 12, 0),
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
      const def = defaults as ParametricEQParams;
      const rawBands = Array.isArray(src.bands) ? src.bands : def.bands;
      const bands: EQBand[] = rawBands.slice(0, 8).map((b, idx) => {
        const bo = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
        const shape = ['highpass', 'lowshelf', 'bell', 'highshelf', 'lowpass', 'notch'].includes(
          String(bo.shape),
        )
          ? (bo.shape as EQBand['shape'])
          : 'bell';
        return {
          id: typeof bo.id === 'string' && bo.id ? bo.id : `b${idx + 1}`,
          enabled: bo.enabled !== false,
          shape,
          freq: clamp(Number(bo.freq), 20, 19500, 1000),
          gain: clamp(Number(bo.gain), -12, 12, 0),
          q: clamp(Number(bo.q), 0.25, 12, 1.0),
        };
      });
      return {
        phaseMode: src.phaseMode === 'linear' ? 'linear' : 'minimum',
        msMode: src.msMode === 'mid-side' ? 'mid-side' : 'stereo',
        tiltDb: clamp(Number(src.tiltDb), -6, 6, 0),
        bands: bands.length > 0 ? bands : def.bands,
      };
    }
    case 'dynamic-eq': {
      const def = defaults as DynamicEQParams;
      const rawBands = Array.isArray(src.bands) ? src.bands : def.bands;
      return {
        bands: rawBands.slice(0, 4).map((b, idx): DynamicEQParams['bands'][number] => {
          const bo = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
          const mode: 'cut' | 'boost' = bo.mode === 'boost' ? 'boost' : 'cut';
          return {
            id: typeof bo.id === 'string' && bo.id ? bo.id : `d${idx + 1}`,
            enabled: bo.enabled !== false,
            freq: clamp(Number(bo.freq), 30, 16000, 500),
            q: clamp(Number(bo.q), 0.5, 10, 2.0),
            thresholdDb: clamp(Number(bo.thresholdDb), -45, 0, -20),
            maxCutDb: mode === 'boost'
              ? clamp(Number(bo.maxCutDb), 0, 12, 3)
              : clamp(Number(bo.maxCutDb), -12, 0, -3),
            ratio: clamp(Number(bo.ratio), 1.0, 20.0, 20 / 7),
            mode,
            attackMs: clamp(Number(bo.attackMs), 1, 100, 10),
            releaseMs: clamp(Number(bo.releaseMs), 20, 600, 110),
          };
        }),
      };
    }
    case 'compressor': {
      const def = defaults as CompressorParams;
      return {
        mode: ['downward', 'upward', 'parallel'].includes(String(src.mode))
          ? (src.mode as CompressorParams['mode'])
          : def.mode,
        thresholdDb: clamp(Number(src.thresholdDb), -40, 0, def.thresholdDb),
        ratio: clamp(Number(src.ratio), 1.0, 12.0, def.ratio),
        attackMs: clamp(Number(src.attackMs), 0.5, 150, def.attackMs),
        releaseMs: clamp(Number(src.releaseMs), 20, 1000, def.releaseMs),
        kneeDb: clamp(Number(src.kneeDb), 0, 12, def.kneeDb),
        makeupDb: clamp(Number(src.makeupDb), -6, 12, def.makeupDb),
        scHpfHz: clamp(Number(src.scHpfHz), 20, 250, def.scHpfHz),
      };
    }
    case 'multiband-comp': {
      const def = defaults as MultibandCompParams;
      const validateBand = (b: unknown, fb: MultibandBandParams): MultibandBandParams => {
        const bo = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
        return {
          thresholdDb: clamp(Number(bo.thresholdDb), -40, 0, fb.thresholdDb),
          ratio: clamp(Number(bo.ratio), 1.0, 10.0, fb.ratio),
          attackMs: clamp(Number(bo.attackMs), 1, 120, fb.attackMs),
          releaseMs: clamp(Number(bo.releaseMs), 20, 800, fb.releaseMs),
          gainDb: clamp(Number(bo.gainDb), -6, 6, fb.gainDb),
          bypass: bo.bypass === true,
        };
      };
      const lowCross = clamp(Number(src.lowCrossHz), 60, 600, def.lowCrossHz);
      const highCross = clamp(Number(src.highCrossHz), lowCross + 200, 10000, def.highCrossHz);
      return {
        lowCrossHz: lowCross,
        highCrossHz: highCross,
        low: validateBand(src.low, def.low),
        mid: validateBand(src.mid, def.mid),
        high: validateBand(src.high, def.high),
      };
    }
    case 'saturation': {
      const def = defaults as SaturationParams;
      return {
        flavor: ['tube', 'tape', 'soft-clip', 'hard-clip', 'exciter'].includes(String(src.flavor))
          ? (src.flavor as SaturationParams['flavor'])
          : def.flavor,
        drive: clamp(Number(src.drive), 0, 100, def.drive),
        tone: clamp(Number(src.tone), -100, 100, def.tone),
        harmonics: ['even', 'odd', 'balanced'].includes(String(src.harmonics))
          ? (src.harmonics as SaturationParams['harmonics'])
          : def.harmonics,
        oversampling: [1, 2, 4].includes(Number(src.oversampling))
          ? (Number(src.oversampling) as 1 | 2 | 4)
          : 2,
      };
    }
    case 'stereo-imager': {
      const def = defaults as StereoImagerParams;
      const lowCross = clamp(Number(src.lowCrossHz), 60, 500, def.lowCrossHz);
      return {
        lowWidth: clamp(Number(src.lowWidth), 0, 160, def.lowWidth),
        midWidth: clamp(Number(src.midWidth), 0, 175, def.midWidth),
        highWidth: clamp(Number(src.highWidth), 0, 190, def.highWidth),
        lowCrossHz: lowCross,
        highCrossHz: clamp(Number(src.highCrossHz), lowCross + 250, 12000, def.highCrossHz),
        monoBassBelowHz: clamp(Number(src.monoBassBelowHz), 0, 200, def.monoBassBelowHz),
        lrBalanceDb: clamp(Number(src.lrBalanceDb), -4, 4, def.lrBalanceDb),
        midSideGainDb: clamp(Number(src.midSideGainDb), -6, 6, def.midSideGainDb),
      };
    }
    case 'restore': {
      const def = defaults as RestoreParams;
      return {
        dcOffset: src.dcOffset !== false,
        humRemovalHz: [0, 50, 60].includes(Number(src.humRemovalHz))
          ? (Number(src.humRemovalHz) as 0 | 50 | 60)
          : 0,
        hissReduction: clamp(Number(src.hissReduction), 0, 100, def.hissReduction),
        deEssAmount: clamp(Number(src.deEssAmount), 0, 100, def.deEssAmount),
        deEssFreqHz: clamp(Number(src.deEssFreqHz), 3500, 11000, def.deEssFreqHz),
        resonanceSuppress: clamp(Number(src.resonanceSuppress), 0, 100, def.resonanceSuppress),
        mode: src.mode === 'aggressive' ? 'aggressive' : 'conservative',
        declick: clamp(Number(src.declick), 0, 100, def.declick ?? 0),
        decrackle: clamp(Number(src.decrackle), 0, 100, def.decrackle ?? 0),
        spikeRepair: src.spikeRepair === true,
        deShimmer: clamp(Number(src.deShimmer), 0, 100, def.deShimmer ?? 0),
      };
    }
    case 'bass-enhancer': {
      const def = defaults as BassEnhancerParams;
      return {
        subFreqHz: clamp(Number(src.subFreqHz), 35, 95, def.subFreqHz),
        subGainDb: clamp(Number(src.subGainDb), 0, 7, def.subGainDb),
        harmonicDrive: clamp(Number(src.harmonicDrive), 0, 100, def.harmonicDrive),
        tightness: clamp(Number(src.tightness), 0, 100, def.tightness),
        monoFocus: src.monoFocus !== false,
      };
    }
    case 'limiter': {
      const def = defaults as LimiterParams;
      return {
        ceilingDb: clamp(Number(src.ceilingDb), -6.0, -0.1, def.ceilingDb),
        thresholdDb: clamp(Number(src.thresholdDb), -18.0, 0.0, def.thresholdDb),
        releaseMs: clamp(Number(src.releaseMs), 10, 500, def.releaseMs),
        lookaheadMs: clamp(Number(src.lookaheadMs), 0, 10, def.lookaheadMs),
        truePeak: src.truePeak !== false,
        oversampling: [1, 2, 4].includes(Number(src.oversampling))
          ? (Number(src.oversampling) as 1 | 2 | 4)
          : 4,
      };
    }
    case 'maximizer': {
      const def = defaults as MaximizerParams;
      return {
        character: ['transparent', 'punchy', 'aggressive', 'smooth'].includes(String(src.character))
          ? (src.character as MaximizerParams['character'])
          : def.character,
        targetLufs: clamp(Number(src.targetLufs), -24, -6, def.targetLufs),
        ceilingDb: clamp(Number(src.ceilingDb), -3.0, -0.1, def.ceilingDb),
        transientEmphasis: clamp(Number(src.transientEmphasis), 0, 100, def.transientEmphasis),
        truePeak: src.truePeak !== false,
      };
    }
    case 'transient-shaper': {
      const def = defaults as TransientShaperParams;
      return {
        attackDb: clamp(Number(src.attackDb), -12, 12, def.attackDb),
        sustainDb: clamp(Number(src.sustainDb), -12, 12, def.sustainDb),
        speedMs: clamp(Number(src.speedMs), 2, 60, def.speedMs),
        lowCutHz: clamp(Number(src.lowCutHz), 20, 300, def.lowCutHz),
      };
    }
    case 'dither': {
      const def = defaults as DitherParams;
      const bd = Number(src.bitDepth);
      const shape = src.shape;
      return {
        bitDepth: bd === 16 || bd === 20 || bd === 24 ? bd : def.bitDepth,
        shape: shape === 'tpdf' || shape === 'tpdf-hp' || shape === 'shaped' ? shape : def.shape,
        autoBlank: typeof src.autoBlank === 'boolean' ? src.autoBlank : def.autoBlank,
      };
    }
    case 'clipper': {
      const def = defaults as ClipperParams;
      const os = Number(src.oversampling);
      return {
        ceilingDb: clamp(Number(src.ceilingDb), -6, 0, def.ceilingDb),
        driveDb: clamp(Number(src.driveDb), 0, 12, def.driveDb),
        softness: clamp(Number(src.softness), 0, 100, def.softness),
        oversampling: os === 1 || os === 2 || os === 4 ? os : def.oversampling,
      };
    }
    case 'multiband-maximizer': {
      const def = defaults as MultibandMaximizerParams;
      const band = (raw: unknown, d: MultibandMaximizerBand): MultibandMaximizerBand => {
        const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
        return {
          preGainDb: clamp(Number(b.preGainDb), -6, 12, d.preGainDb),
          thresholdDb: clamp(Number(b.thresholdDb), -36, 0, d.thresholdDb),
          ratio: clamp(Number(b.ratio), 1, 20, d.ratio),
          attackMs: clamp(Number(b.attackMs), 0.5, 200, d.attackMs),
          releaseMs: clamp(Number(b.releaseMs), 10, 1000, d.releaseMs),
          postGainDb: clamp(Number(b.postGainDb), -12, 6, d.postGainDb),
          bypass: b.bypass === true,
        };
      };
      const lowCross = clamp(Number(src.lowCrossHz), 40, 600, def.lowCrossHz);
      return {
        lowCrossHz: lowCross,
        highCrossHz: clamp(Number(src.highCrossHz), lowCross + 250, 12000, def.highCrossHz),
        low: band(src.low, def.low),
        mid: band(src.mid, def.mid),
        high: band(src.high, def.high),
        ceilingDb: clamp(Number(src.ceilingDb), -3, -0.1, def.ceilingDb),
        releaseMs: clamp(Number(src.releaseMs), 10, 500, def.releaseMs),
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
  return validated;
}
