import type { ExternalVST3Params, ProcessorModule } from '../types/mastering';
import { dbToLinear, linearToDb } from './analyzer';
import { applyFadesInPlace, type FadeSettings } from './fades';
import { processChainOffline, type ProcessorMeterTelemetry } from './offlineDsp';

export type ExternalPluginProcessCallback = (
  channels: Float32Array[],
  sampleRate: number,
  module: ProcessorModule,
) => Promise<{
  channels: Float32Array[];
  latencySamples?: number;
}>;

export interface MixedChainRenderResult {
  channels: Float32Array[];
  telemetry: ProcessorMeterTelemetry[];
  usedExternalHost: boolean;
  totalExternalLatencySamples: number;
}

export function chainHasActiveExternalPlugins(chain: ProcessorModule[]): boolean {
  return chain.some(
    (m) => m.type === 'external-vst3' && m.enabled && !m.bypassed && m.wetDry > 0.1,
  );
}

/**
 * Executes a hybrid mastering chain sequentially:
 *   [Native Run] -> [External VST3 Stage via Native Host] -> [Native Run] ...
 * Preserves wet/dry parallel blending, input/output trim, bit-identical bypass,
 * and NEVER fabricates substitute DSP if an active external VST3 host is unavailable.
 */
export async function renderMixedChain(
  sourceChannels: Float32Array[],
  sampleRate: number,
  chain: ProcessorModule[],
  externalProcessor?: ExternalPluginProcessCallback,
  postFades?: FadeSettings | null,
): Promise<MixedChainRenderResult> {
  if (!chainHasActiveExternalPlugins(chain)) {
    const syncRes = processChainOffline(sourceChannels, sampleRate, chain, postFades);
    return {
      channels: syncRes.channels,
      telemetry: syncRes.telemetry,
      usedExternalHost: false,
      totalExternalLatencySamples: 0,
    };
  }

  let current: Float32Array[] = [
    new Float32Array(sourceChannels[0]),
    new Float32Array(sourceChannels[1] ?? sourceChannels[0]),
  ];
  const allTelemetry: ProcessorMeterTelemetry[] = [];
  let nativeRun: ProcessorModule[] = [];
  let totalExternalLatencySamples = 0;

  const flushNativeRun = () => {
    if (nativeRun.length === 0) return;
    const res = processChainOffline(current, sampleRate, nativeRun);
    current = res.channels;
    allTelemetry.push(...res.telemetry);
    nativeRun = [];
  };

  for (const mod of chain) {
    if (mod.type !== 'external-vst3') {
      nativeRun.push(mod);
      continue;
    }

    flushNativeRun();

    const extParams = mod.params as ExternalVST3Params;
    const n = current[0].length;
    const dryL = new Float32Array(current[0]);
    const dryR = new Float32Array(current[1]);

    let inPeak = 0;
    for (let i = 0; i < n; i++) {
      const p = Math.max(Math.abs(current[0][i]), Math.abs(current[1][i]));
      if (p > inPeak) inPeak = p;
    }

    if (!mod.enabled || mod.bypassed || mod.wetDry <= 0.1) {
      allTelemetry.push({
        id: mod.id,
        inputPeakDb: Number(linearToDb(inPeak).toFixed(2)),
        outputPeakDb: Number(linearToDb(inPeak).toFixed(2)),
        gainReductionDb: 0,
      });
      continue;
    }

    if (!externalProcessor) {
      throw new Error(
        `External plugin "${extParams.pluginName}" requires a connected SYN-PLUGIN HOST instance.`,
      );
    }

    // Apply pre-input trim before feeding native VST3 worker
    const inGain = dbToLinear(mod.inputGainDb);
    if (Math.abs(inGain - 1) > 1e-4) {
      for (let i = 0; i < n; i++) {
        current[0][i] *= inGain;
        current[1][i] *= inGain;
      }
    }

    const extRes = await externalProcessor(current, sampleRate, mod);
    totalExternalLatencySamples += Math.max(0, extRes.latencySamples ?? 0);

    const wetL = extRes.channels[0];
    const wetR = extRes.channels[1] ?? extRes.channels[0];
    const wetMix = Math.max(0, Math.min(1, mod.wetDry / 100));
    const dryMix = 1 - wetMix;
    const outGain = dbToLinear(mod.outputGainDb);

    let outPeak = 0;
    const outL = new Float32Array(n);
    const outR = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const l = (dryL[i] * dryMix + (Number.isFinite(wetL[i]) ? wetL[i] : 0) * wetMix) * outGain;
      const r = (dryR[i] * dryMix + (Number.isFinite(wetR[i]) ? wetR[i] : 0) * wetMix) * outGain;
      outL[i] = l;
      outR[i] = r;
      const p = Math.max(Math.abs(l), Math.abs(r));
      if (p > outPeak) outPeak = p;
    }
    current = [outL, outR];

    allTelemetry.push({
      id: mod.id,
      inputPeakDb: Number(linearToDb(inPeak).toFixed(2)),
      outputPeakDb: Number(linearToDb(outPeak).toFixed(2)),
      gainReductionDb: 0,
    });
  }

  flushNativeRun();
  if (postFades) applyFadesInPlace(current, sampleRate, postFades);

  return {
    channels: current,
    telemetry: allTelemetry,
    usedExternalHost: true,
    totalExternalLatencySamples,
  };
}
