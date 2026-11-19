import type { AudioAnalysis, ProcessorModule } from '../types/mastering.ts';
import { analyzeAudioBuffer, extractWaveformPeaks } from './analyzer.ts';
import { validateChainAgainstInventory } from '../director/processorInventory.ts';
import { processChainOffline, type ProcessorMeterTelemetry } from './offlineDsp.ts';

export interface DspWorkerRequest {
  id: number;
  kind: 'render-and-analyze' | 'render-only';
  channels: Float32Array[];
  sampleRate: number;
  chain: ProcessorModule[];
  peakBins?: number;
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

type DspWorkerResponse = DspWorkerSuccessResponse | DspWorkerErrorResponse;

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<DspWorkerRequest>) => void) | null;
  postMessage: (message: DspWorkerResponse, transfer?: Transferable[]) => void;
};

scope.onmessage = (event) => {
  const request = event.data;
  const id = Number.isInteger(request?.id) ? request.id : -1;
  try {
    if (!request || !Number.isInteger(request.id) || request.id < 1) {
      throw new Error('DSP worker request has an invalid job id');
    }
    if (request.kind !== 'render-and-analyze' && request.kind !== 'render-only') {
      throw new Error('DSP worker request has an unsupported operation');
    }
    if (!Number.isFinite(request.sampleRate) || request.sampleRate < 8000 || request.sampleRate > 384000) {
      throw new Error('DSP worker sample rate must be between 8 kHz and 384 kHz');
    }
    if (!Array.isArray(request.channels) || request.channels.length < 1 || request.channels.length > 8) {
      throw new Error('DSP worker requires between one and eight audio channels');
    }
    const channelLength = request.channels[0]?.length;
    if (!Number.isInteger(channelLength) || channelLength < 1 || channelLength > request.sampleRate * 60 * 30) {
      throw new Error('DSP worker audio length is outside the supported 30-minute range');
    }
    if (request.channels.some((channel) => !(channel instanceof Float32Array) || channel.length !== channelLength)) {
      throw new Error('DSP worker channels must be equal-length Float32Array buffers');
    }
    if (!Array.isArray(request.chain) || request.chain.length > 12) {
      throw new Error('DSP worker processor chain must contain at most twelve stages');
    }
    if (request.chain.length > 0) {
      const validation = validateChainAgainstInventory(request.chain);
      if (!validation.valid) throw new Error(validation.errors[0] || 'Processor chain failed inventory validation');
      request.chain = validation.sanitizedChain;
    }

    const peakBins = Math.max(1, Math.min(8192, Math.floor(request.peakBins ?? 400)));
    const processed = processChainOffline(request.channels, request.sampleRate, request.chain);
    const analysis = analyzeAudioBuffer(processed.channels, request.sampleRate);
    const peaks =
      request.kind === 'render-and-analyze'
        ? extractWaveformPeaks(processed.channels, peakBins)
        : undefined;

    const response: DspWorkerSuccessResponse = {
      id,
      ok: true,
      channels: processed.channels,
      telemetry: processed.telemetry,
      peaks,
      analysis,
    };
    scope.postMessage(response, processed.channels.map((channel) => channel.buffer as Transferable));
  } catch (error) {
    scope.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : 'DSP worker failed',
    });
  }
};
