import type { ProcessorModule, ProcessorType } from '../../types/mastering';
import { createProcessorModule, createDefaultParams } from '../../dsp/chainValidation';

/**
 * The "Add module" menu. Every entry renders through a real SYN-DSP processor; tool
 * names such as "Clipper" or "High-pass filter" are configured templates of those
 * processors, so the AI and the offline renderer can always control and verify them.
 */
export interface CatalogItem {
  id: string;
  label: string;
  description: string;
  category: 'Repair' | 'EQ & Filters' | 'Dynamics' | 'Loudness' | 'Stereo' | 'Color';
  type: ProcessorType;
  build: () => ProcessorModule;
}

const mk = (type: ProcessorType, name: string, patch: Record<string, unknown> = {}, extra: Partial<ProcessorModule> = {}) =>
  createProcessorModule(type, {
    name,
    expanded: true,
    ...extra,
    params: { ...(createDefaultParams(type) as unknown as Record<string, unknown>), ...patch } as unknown as ProcessorModule['params'],
  });

export const MODULE_CATALOG: CatalogItem[] = [
  {
    id: 'ai-repair', label: 'AI Repair', category: 'Repair', type: 'restore',
    description: 'De-click, de-crackle, spike repair and AI-shimmer reduction for Suno/Udio audio',
    build: () => mk('restore', 'AI Repair (De-click / De-shimmer)', { hissReduction: 0, deEssAmount: 0, resonanceSuppress: 0, declick: 55, decrackle: 20, spikeRepair: true, deShimmer: 30 }),
  },
  {
    id: 'restore', label: 'Restore & Cleanup', category: 'Repair', type: 'restore',
    description: 'DC removal, hum notch, hiss gate, de-ess, resonance trim',
    build: () => mk('restore', 'SYN-Restore Cleanup'),
  },
  {
    id: 'de-esser', label: 'De-esser', category: 'Repair', type: 'restore',
    description: 'Dynamic sibilance control (6–8 kHz)',
    build: () => mk('restore', 'De-esser', { dcOffset: false, hissReduction: 0, resonanceSuppress: 0, deEssAmount: 45, deEssFreqHz: 6800 }),
  },
  {
    id: 'peq', label: 'Parametric EQ 2', category: 'EQ & Filters', type: 'parametric-eq',
    description: 'Spectrum + draggable band nodes, 7 band types',
    build: () => mk('parametric-eq', 'Parametric EQ 2'),
  },
  {
    id: 'hpf', label: 'High-pass filter', category: 'EQ & Filters', type: 'parametric-eq',
    description: 'Clean sub-rumble below 28 Hz',
    build: () => mk('parametric-eq', 'High-pass Filter', { bands: [{ id: 'hp', enabled: true, shape: 'highpass', freq: 28, gain: 0, q: 0.707 }] }),
  },
  {
    id: 'lpf', label: 'Low-pass filter', category: 'EQ & Filters', type: 'parametric-eq',
    description: 'Roll off fizz above 18 kHz',
    build: () => mk('parametric-eq', 'Low-pass Filter', { bands: [{ id: 'lp', enabled: true, shape: 'lowpass', freq: 18000, gain: 0, q: 0.707 }] }),
  },
  {
    id: 'dyn-eq', label: 'Dynamic EQ', category: 'EQ & Filters', type: 'dynamic-eq',
    description: 'Cuts resonances only when they jump out',
    build: () => mk('dynamic-eq', 'Dynamic EQ'),
  },
  {
    id: 'comp', label: 'Compressor', category: 'Dynamics', type: 'compressor',
    description: 'Glue bus compressor with sidechain HPF',
    build: () => mk('compressor', 'Glue Compressor'),
  },
  {
    id: 'mbc', label: 'Multiband compressor', category: 'Dynamics', type: 'multiband-comp',
    description: '3-band compressor with adjustable crossovers (frequency splitter)',
    build: () => mk('multiband-comp', 'Multiband Compressor'),
  },
  {
    id: 'clipper', label: 'Peak clipper', category: 'Dynamics', type: 'clipper',
    description: 'Oversampled soft/hard clipper: shave peaks before the limiter',
    build: () => mk('clipper', 'Peak Clipper'),
  },
  {
    id: 'transient', label: 'Transient shaper', category: 'Dynamics', type: 'transient-shaper',
    description: 'More or less punch (attack) and body (sustain)',
    build: () => mk('transient-shaper', 'Transient Shaper'),
  },
  {
    id: 'limiter', label: 'True-peak limiter', category: 'Loudness', type: 'limiter',
    description: 'Lookahead limiter, 4x oversampled true-peak ceiling',
    build: () => mk('limiter', 'True-Peak Limiter'),
  },
  {
    id: 'maximizer', label: 'Maximizer', category: 'Loudness', type: 'maximizer',
    description: 'LUFS-targeted loudness maximizer',
    build: () => mk('maximizer', 'Maximizer'),
  },
  {
    id: 'mbmax', label: 'Multiband maximizer', category: 'Loudness', type: 'multiband-maximizer',
    description: 'Maximus-style 3-band drive + compression into a true-peak ceiling',
    build: () => mk('multiband-maximizer', 'Multiband Maximizer'),
  },
  {
    id: 'imager', label: 'Stereo imager', category: 'Stereo', type: 'stereo-imager',
    description: '3-band width, mono bass, L/R balance',
    build: () => mk('stereo-imager', 'Stereo Imager'),
  },
  {
    id: 'mono-maker', label: 'Mono maker', category: 'Stereo', type: 'stereo-imager',
    description: 'Mono below 120 Hz for solid low end',
    build: () => mk('stereo-imager', 'Mono Maker', { lowWidth: 0, midWidth: 100, highWidth: 100, monoBassBelowHz: 120 }),
  },
  {
    id: 'saturation', label: 'Saturation', category: 'Color', type: 'saturation',
    description: 'Tube / tape harmonic warmth',
    build: () => mk('saturation', 'Analog Saturation'),
  },
  {
    id: 'exciter', label: 'Exciter', category: 'Color', type: 'saturation',
    description: 'High-frequency harmonic sparkle',
    build: () => mk('saturation', 'Exciter', { flavor: 'exciter', drive: 22, tone: 40, harmonics: 'even', oversampling: 4 }),
  },
  {
    id: 'bass', label: 'Bass enhancer', category: 'Color', type: 'bass-enhancer',
    description: 'Sub weight, harmonic bass and tightness',
    build: () => mk('bass-enhancer', 'Bass Enhancer'),
  },
];

export const CATALOG_CATEGORIES: CatalogItem['category'][] = ['Repair', 'EQ & Filters', 'Dynamics', 'Loudness', 'Stereo', 'Color'];
