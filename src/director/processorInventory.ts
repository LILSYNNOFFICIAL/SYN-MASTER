import type { ChainCommand, ProcessorModule, ProcessorType } from '../types/mastering';
import { PROCESSOR_DEFAULT_NAMES, createDefaultParams, validateChain } from '../dsp/chainValidation';

export interface InventoryParamBound {
  min?: number;
  max?: number;
  unit?: string;
  options?: string[];
  defaultValue: number | string | boolean;
}

export interface VerifiedProcessorDescriptor {
  type: ProcessorType;
  displayName: string;
  role: 'cleanup' | 'eq' | 'dynamics' | 'color' | 'stereo' | 'limiting';
  realtimeSupported: boolean;
  offlineSupported: boolean;
  maxRecommendedInstances: number;
  parameters: Record<string, InventoryParamBound>;
}

/**
 * Authoritative verified inventory matching every real DSP engine stage in SYN MASTER.
 * Used by both deterministic AI planning and Gemini AI output validation.
 */
export const VERIFIED_NATIVE_PROCESSOR_INVENTORY: Record<
  Exclude<ProcessorType, 'external-vst3'>,
  VerifiedProcessorDescriptor
> = {
  restore: {
    type: 'restore',
    displayName: PROCESSOR_DEFAULT_NAMES.restore,
    role: 'cleanup',
    realtimeSupported: true,
    offlineSupported: true,
    maxRecommendedInstances: 1,
    parameters: {
      dcOffset: { defaultValue: true },
      humRemovalHz: { options: ['0', '50', '60'], defaultValue: 0, unit: 'Hz' },
      hissReduction: { min: 0, max: 100, defaultValue: 12, unit: '%' },
      deEssAmount: { min: 0, max: 100, defaultValue: 18, unit: '%' },
      deEssFreqHz: { min: 3500, max: 11000, defaultValue: 6500, unit: 'Hz' },
      resonanceSuppress: { min: 0, max: 100, defaultValue: 15, unit: '%' },
      mode: { options: ['conservative', 'aggressive'], defaultValue: 'conservative' },
    },
  },
  'parametric-eq': {
    type: 'parametric-eq',
    displayName: PROCESSOR_DEFAULT_NAMES['parametric-eq'],
    role: 'eq',
    realtimeSupported: true,
    offlineSupported: true,
    maxRecommendedInstances: 2,
    parameters: {
      phaseMode: { options: ['minimum', 'linear'], defaultValue: 'minimum' },
      msMode: { options: ['stereo', 'mid-side'], defaultValue: 'stereo' },
      tiltDb: { min: -6, max: 6, defaultValue: 0, unit: 'dB' },
    },
  },
  'dynamic-eq': {
    type: 'dynamic-eq',
    displayName: PROCESSOR_DEFAULT_NAMES['dynamic-eq'],
    role: 'eq',
    realtimeSupported: true,
    offlineSupported: true,
    maxRecommendedInstances: 2,
    parameters: {
      freq: { min: 30, max: 16000, defaultValue: 500, unit: 'Hz' },
      q: { min: 0.5, max: 10, defaultValue: 2.0 },
      thresholdDb: { min: -45, max: 0, defaultValue: -20, unit: 'dB' },
      maxCutDb: { min: -12, max: 0, defaultValue: -3, unit: 'dB' },
      attackMs: { min: 1, max: 100, defaultValue: 10, unit: 'ms' },
      releaseMs: { min: 20, max: 600, defaultValue: 110, unit: 'ms' },
    },
  },
  compressor: {
    type: 'compressor',
    displayName: PROCESSOR_DEFAULT_NAMES.compressor,
    role: 'dynamics',
    realtimeSupported: true,
    offlineSupported: true,
    maxRecommendedInstances: 2,
    parameters: {
      mode: { options: ['downward', 'upward', 'parallel'], defaultValue: 'downward' },
      thresholdDb: { min: -40, max: 0, defaultValue: -16, unit: 'dB' },
      ratio: { min: 1.0, max: 12.0, defaultValue: 2.2, unit: ':1' },
      attackMs: { min: 0.5, max: 150, defaultValue: 18, unit: 'ms' },
      releaseMs: { min: 20, max: 1000, defaultValue: 140, unit: 'ms' },
      kneeDb: { min: 0, max: 12, defaultValue: 4, unit: 'dB' },
      makeupDb: { min: -6, max: 12, defaultValue: 1.0, unit: 'dB' },
      scHpfHz: { min: 20, max: 250, defaultValue: 75, unit: 'Hz' },
    },
  },
  'multiband-comp': {
    type: 'multiband-comp',
    displayName: PROCESSOR_DEFAULT_NAMES['multiband-comp'],
    role: 'dynamics',
    realtimeSupported: true,
    offlineSupported: true,
    maxRecommendedInstances: 1,
    parameters: {
      lowCrossHz: { min: 60, max: 600, defaultValue: 180, unit: 'Hz' },
      highCrossHz: { min: 260, max: 10000, defaultValue: 3200, unit: 'Hz' },
    },
  },
  saturation: {
    type: 'saturation',
    displayName: PROCESSOR_DEFAULT_NAMES.saturation,
    role: 'color',
    realtimeSupported: true,
    offlineSupported: true,
    maxRecommendedInstances: 2,
    parameters: {
      flavor: { options: ['tube', 'tape', 'soft-clip', 'hard-clip', 'exciter'], defaultValue: 'tape' },
      drive: { min: 0, max: 100, defaultValue: 22, unit: '%' },
      tone: { min: -100, max: 100, defaultValue: 0 },
      harmonics: { options: ['even', 'odd', 'balanced'], defaultValue: 'balanced' },
      oversampling: { options: ['1', '2', '4'], defaultValue: 2 },
    },
  },
  'stereo-imager': {
    type: 'stereo-imager',
    displayName: PROCESSOR_DEFAULT_NAMES['stereo-imager'],
    role: 'stereo',
    realtimeSupported: true,
    offlineSupported: true,
    maxRecommendedInstances: 1,
    parameters: {
      lowWidth: { min: 0, max: 160, defaultValue: 85, unit: '%' },
      midWidth: { min: 0, max: 175, defaultValue: 108, unit: '%' },
      highWidth: { min: 0, max: 190, defaultValue: 118, unit: '%' },
      lowCrossHz: { min: 60, max: 500, defaultValue: 160, unit: 'Hz' },
      highCrossHz: { min: 310, max: 12000, defaultValue: 3500, unit: 'Hz' },
      monoBassBelowHz: { min: 0, max: 200, defaultValue: 95, unit: 'Hz' },
      lrBalanceDb: { min: -4, max: 4, defaultValue: 0, unit: 'dB' },
      midSideGainDb: { min: -6, max: 6, defaultValue: 0, unit: 'dB' },
    },
  },
  'bass-enhancer': {
    type: 'bass-enhancer',
    displayName: PROCESSOR_DEFAULT_NAMES['bass-enhancer'],
    role: 'color',
    realtimeSupported: true,
    offlineSupported: true,
    maxRecommendedInstances: 1,
    parameters: {
      subFreqHz: { min: 35, max: 95, defaultValue: 55, unit: 'Hz' },
      subGainDb: { min: 0, max: 7, defaultValue: 1.5, unit: 'dB' },
      harmonicDrive: { min: 0, max: 100, defaultValue: 24, unit: '%' },
      tightness: { min: 0, max: 100, defaultValue: 55, unit: '%' },
      monoFocus: { defaultValue: true },
    },
  },
  limiter: {
    type: 'limiter',
    displayName: PROCESSOR_DEFAULT_NAMES.limiter,
    role: 'limiting',
    realtimeSupported: true,
    offlineSupported: true,
    maxRecommendedInstances: 1,
    parameters: {
      ceilingDb: { min: -6.0, max: -0.1, defaultValue: -1.0, unit: 'dBTP' },
      thresholdDb: { min: -18.0, max: 0.0, defaultValue: -3.5, unit: 'dB' },
      releaseMs: { min: 10, max: 500, defaultValue: 90, unit: 'ms' },
      lookaheadMs: { min: 0, max: 10, defaultValue: 3, unit: 'ms' },
      truePeak: { defaultValue: true },
      oversampling: { options: ['1', '2', '4'], defaultValue: 4 },
    },
  },
  maximizer: {
    type: 'maximizer',
    displayName: PROCESSOR_DEFAULT_NAMES.maximizer,
    role: 'limiting',
    realtimeSupported: true,
    offlineSupported: true,
    maxRecommendedInstances: 1,
    parameters: {
      character: { options: ['transparent', 'punchy', 'aggressive', 'smooth'], defaultValue: 'transparent' },
      targetLufs: { min: -24, max: -6, defaultValue: -14, unit: 'LUFS' },
      ceilingDb: { min: -3.0, max: -0.1, defaultValue: -1.0, unit: 'dBTP' },
      transientEmphasis: { min: 0, max: 100, defaultValue: 25, unit: '%' },
      truePeak: { defaultValue: true },
    },
  },
};

export interface InventoryValidationResult {
  valid: boolean;
  errors: string[];
  sanitizedChain: ProcessorModule[];
}

function hasNonFiniteNumeric(
  value: unknown,
  path: string,
  errors: string[],
  seen: WeakSet<object> = new WeakSet(),
): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) errors.push(`Non-finite numeric value at ${path}`);
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, idx) => hasNonFiniteNumeric(item, `${path}[${idx}]`, errors, seen));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    hasNonFiniteNumeric(child, `${path}.${key}`, errors, seen);
  }
}

/**
 * Strictly validates any externally generated (AI/JSON) chain or command list against
 * the verified processor inventory, finite numbers, supported types, and parameter bounds.
 */
export function validateChainAgainstInventory(rawChain: unknown): InventoryValidationResult {
  const errors: string[] = [];
  if (!Array.isArray(rawChain)) {
    return { valid: false, errors: ['Chain payload must be an array'], sanitizedChain: [] };
  }
  if (rawChain.length === 0) {
    return { valid: false, errors: ['Chain must contain at least one processor'], sanitizedChain: [] };
  }
  if (rawChain.length > 12) {
    errors.push(`Chain length ${rawChain.length} exceeds 12-stage limit`);
  }

  for (let i = 0; i < rawChain.length; i++) {
    const item = rawChain[i];
    if (!item || typeof item !== 'object') {
      errors.push(`Stage ${i} is not a valid object`);
      continue;
    }
    const obj = item as Record<string, unknown>;
    const type = obj.type as ProcessorType;
    if (
      !Object.prototype.hasOwnProperty.call(obj, 'type') ||
      typeof type !== 'string' ||
      !(type === 'external-vst3' || Object.prototype.hasOwnProperty.call(VERIFIED_NATIVE_PROCESSOR_INVENTORY, type))
    ) {
      errors.push(`Unsupported processor type "${String(obj.type)}" at stage ${i}`);
      continue;
    }
    hasNonFiniteNumeric(obj, `stage[${i}]`, errors);
  }

  const sanitizedChain = validateChain(rawChain);
  return {
    valid: errors.length === 0 && sanitizedChain.length > 0,
    errors,
    sanitizedChain,
  };
}

export function validateChainCommand(cmd: ChainCommand): { valid: boolean; reason?: string } {
  if (!cmd || typeof cmd !== 'object') {
    return { valid: false, reason: 'Command must be an object' };
  }

  const errs: string[] = [];
  hasNonFiniteNumeric(cmd, 'command', errs);
  if (errs.length > 0) return { valid: false, reason: errs[0] };

  const allowedOps = new Set(['add', 'remove', 'reorder', 'configure', 'gain-stage', 'wet-dry', 'bypass']);
  if (!allowedOps.has(cmd.op)) {
    return { valid: false, reason: `Unsupported chain command operation: ${String(cmd.op)}` };
  }

  const processorRequired = ['add', 'configure', 'gain-stage', 'wet-dry', 'bypass'].includes(cmd.op);
  const hasOwnProcessorType = Object.prototype.hasOwnProperty.call(cmd, 'processorType');
  const processorType = 'processorType' in cmd ? cmd.processorType : undefined;
  if (processorRequired && (!hasOwnProcessorType || processorType === undefined)) {
    return { valid: false, reason: `Command ${cmd.op} requires an own processorType field` };
  }
  if (hasOwnProcessorType && processorType !== undefined) {
    const supported = typeof processorType === 'string' && (
      processorType === 'external-vst3' ||
      Object.prototype.hasOwnProperty.call(VERIFIED_NATIVE_PROCESSOR_INVENTORY, processorType)
    );
    if (!supported) {
      return { valid: false, reason: `Unsupported processorType: ${String(processorType)}` };
    }
  }

  if (cmd.op === 'add') {
    const defaults = createDefaultParams(cmd.processorType);
    if (!defaults) {
      return { valid: false, reason: `Cannot construct defaults for ${String(cmd.processorType)}` };
    }
  }
  if (cmd.op === 'reorder' && (
    !Array.isArray(cmd.order) ||
    cmd.order.length > 12 ||
    cmd.order.some((type) => typeof type !== 'string' || !(
      type === 'external-vst3' ||
      Object.prototype.hasOwnProperty.call(VERIFIED_NATIVE_PROCESSOR_INVENTORY, type)
    ))
  )) {
    return { valid: false, reason: 'Reorder command contains unsupported processor types' };
  }
  if (cmd.op === 'configure' && (
    !cmd.paramsPatch || typeof cmd.paramsPatch !== 'object' || Array.isArray(cmd.paramsPatch)
  )) {
    return { valid: false, reason: 'Configure command paramsPatch must be an object' };
  }
  return { valid: true };
}
