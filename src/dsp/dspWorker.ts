import type { AudioAnalysis, ProcessorModule } from '../types/mastering';
import { analyzeAudioBuffer, extractWaveformPeaks } from './analyzer';
import type { FadeSettings } from './fades';
import { processChainOffline, type ProcessorMeterTelemetry } from './offlineDsp';

export interface DspWorkerRequest {
  id: number;
  kind: 'render-and-analyze' | 'render-only';
  channels: Float32Array[];
  sampleRate: number;
  chain: ProcessorModule[];
  peakBins?: number;
  postFades?: FadeSettings | null;
}

export interface DspWorkerSuccessResponse {
  id: number;
  ok: true;
  channels: Float32Array[];
  telemetry: ProcessorMeterTelemetry[];
  peaks?: number[];
  analysis: AudioAnalysis;
}

export interface DspWorkerErrorResponse {
  id: number;
  ok: false;
  error: string;
}

self.onmessage = (ev: MessageEvent<DspWorkerRequest>) => {
  const req = ev.data;
  try {
    const processed = processChainOffline(req.channels, req.sampleRate, req.chain, req.postFades);
    const analysis = analyzeAudioBuffer(processed.channels, req.sampleRate);
    const peaks =
      req.kind === 'render-and-analyze'
        ? extractWaveformPeaks(processed.channels, req.peakBins ?? 400)
        : undefined;

    const resp: DspWorkerSuccessResponse = {
      id: req.id,
      ok: true,
      channels: processed.channels,
      telemetry: processed.telemetry,
      peaks,
      analysis,
    };

    const transferList = processed.channels.map((ch) => ch.buffer);
    (self as unknown as { postMessage: (msg: unknown, transfer?: Transferable[]) => void }).postMessage(
      resp,
      transferList,
    );
  } catch (err) {
    const resp: DspWorkerErrorResponse = {
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : 'DSP worker failed',
    };
    (self as unknown as { postMessage: (msg: unknown) => void }).postMessage(resp);
  }
};
