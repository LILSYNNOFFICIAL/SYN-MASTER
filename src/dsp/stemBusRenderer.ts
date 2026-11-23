import type { AudioAnalysis, ProcessorModule } from '../types/mastering';
import { analyzeAudioBuffer } from './analyzer';
import { validateChain } from './chainValidation';
import { renderAndAnalyzeOffThread, type OffThreadRenderResult } from './workerClient';
import type { ExternalPluginProcessCallback } from './mixedChainRenderer';
import { analyzeStemSet, type StemInput, type StemRole } from './stemAnalysis';

export interface StemBusRenderOptions {
  /** Independent processor chain keyed by the exact imported stem ID. */
  chainsByStemId?: Record<string, ProcessorModule[]>;
  externalProcessor?: ExternalPluginProcessCallback;
}

export interface RenderedStemBus {
  id: string;
  name: string;
  role: StemRole;
  offsetSamples: number;
  channels: Float32Array[];
  analysis: AudioAnalysis;
  telemetry: OffThreadRenderResult['telemetry'];
  chain: ProcessorModule[];
  usedWorker: boolean;
  usedExternalHost: boolean;
}

export interface StemBusMixResult {
  sourceAnalysis: ReturnType<typeof analyzeStemSet>;
  sampleRate: number;
  timelineSamples: number;
  durationSec: number;
  stems: RenderedStemBus[];
  mixChannels: [Float32Array, Float32Array];
  mixAnalysis: AudioAnalysis;
  warnings: string[];
}

/**
 * Render each imported stem through its own isolated processor chain, then
 * place the processed buses on their shared sample timeline and sum them.
 *
 * No normalization, auto-gain, or hidden limiting is applied to the sum.
 * Each bus is processed independently, so a vocal EQ cannot alter the bass
 * or drum stem. Final mix analysis reports any resulting overload honestly.
 */
export async function renderStemBusMix(
  stems: StemInput[],
  sampleRate: number,
  options: StemBusRenderOptions = {},
): Promise<StemBusMixResult> {
  const baseline = analyzeStemSet(stems, sampleRate);
  const chains = options.chainsByStemId ?? {};
  const knownIds = new Set(stems.map((stem) => stem.id));

  for (const id of Object.keys(chains)) {
    if (!knownIds.has(id)) {
      throw new RangeError(`Processor chain supplied for unknown stem "${id}"`);
    }
  }

  const renderedStems: RenderedStemBus[] = [];
  let timelineSamples = 0;

  // Render sequentially to cap peak memory usage for long multistem sessions.
  for (const stem of stems) {
    const requestedChain = chains[stem.id] ?? [];
    const validatedChain = validateChain(requestedChain);
    if (validatedChain.length !== requestedChain.length) {
      throw new TypeError(`Stem "${stem.id}" contains an invalid processor module`);
    }

    const stereoInput =
      stem.channels.length === 1
        ? [stem.channels[0], stem.channels[0]]
        : [stem.channels[0], stem.channels[1]];

    const rendered = await renderAndAnalyzeOffThread({
      sourceChannels: stereoInput,
      sampleRate,
      chain: validatedChain,
      externalProcessor: options.externalProcessor,
    });

    const left = rendered.channels[0];
    const right = rendered.channels[1] ?? rendered.channels[0];
    if (!(left instanceof Float32Array) || !(right instanceof Float32Array) || left.length !== right.length) {
      throw new Error(`DSP renderer returned an invalid channel layout for stem "${stem.id}"`);
    }

    const offsetSamples = stem.offsetSamples ?? 0;
    const end = offsetSamples + left.length;
    if (!Number.isSafeInteger(end)) {
      throw new RangeError(`Rendered stem "${stem.id}" exceeds the safe timeline range`);
    }
    timelineSamples = Math.max(timelineSamples, end);

    renderedStems.push({
      id: stem.id,
      name: stem.name,
      role: stem.role,
      offsetSamples,
      channels: [left, right],
      analysis: rendered.analysis,
      telemetry: rendered.telemetry,
      chain: validatedChain,
      usedWorker: rendered.usedWorker,
      usedExternalHost: rendered.usedExternalHost,
    });
  }

  const mixL = new Float32Array(timelineSamples);
  const mixR = new Float32Array(timelineSamples);
  for (const stem of renderedStems) {
    const [left, right] = stem.channels;
    for (let i = 0; i < left.length; i++) {
      mixL[stem.offsetSamples + i] += left[i];
      mixR[stem.offsetSamples + i] += right[i];
    }
  }

  const mixAnalysis = analyzeAudioBuffer([mixL, mixR], sampleRate);
  const warnings = [...baseline.warnings];
  if (mixAnalysis.clippedSamples > 0) {
    warnings.push('The processed stem-bus sum clips. Reduce one or more bus levels or revise processing; no automatic gain reduction was applied.');
  }
  if (renderedStems.some((stem) => stem.usedExternalHost)) {
    warnings.push('One or more stems used an external native plugin host. Confirm plugin latency compensation in the host workflow before final delivery.');
  }

  return {
    sourceAnalysis: baseline,
    sampleRate,
    timelineSamples,
    durationSec: timelineSamples / sampleRate,
    stems: renderedStems,
    mixChannels: [mixL, mixR],
    mixAnalysis,
    warnings: [...new Set(warnings)],
  };
}
