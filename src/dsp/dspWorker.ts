import type { AudioAnalysis, ProcessorModule } from '../types/mastering';
import { analyzeAudioBuffer, extractWaveformPeaks } from './analyzer';
import type { FadeSettings } from './fades';
import { processChainOffline, type DynamicEqTrace, type ProcessorMeterTelemetry } from './offlineDsp';
import { registerRebalanceStems, type RebalanceStemSet } from './vocalRebalance';

export interface DspWorkerRequest {
  id: number;
  kind: 'render-and-analyze' | 'render-only';
  channels: Float32Array[];
  sampleRate: number;
  chain: ProcessorModule[];
  peakBins?: number;
  postFades?: FadeSettings | null;
  /** Preview-only: honour band solo. */
  audition?: boolean;
  /** Preview-only: record Dynamic EQ traces. */
  collectDynamicEqTraces?: boolean;
  /** Also compute high-resolution waveform peaks (e.g. 1600 bins) here instead of on the UI thread. */
  hiPeakBins?: number;
  /** Post DspWorkerProgressMessage updates while the job runs (also keeps the client watchdog alive). */
  reportProgress?: boolean;
}

export type DspWorkerProgressStage = 'processing' | 'analyzing' | 'waveform';

/** Stage progress for one job (fraction 0..1 within the stage). Never carries audio. */
export interface DspWorkerProgressMessage {
  id: number;
  kind: 'progress';
  stage: DspWorkerProgressStage;
  fraction: number;
}

/**
 * Makes cached Vocal Rebalance stems resident in the worker (sent once per worker and stem
 * set, before the first render that needs them). No reply; messages are processed in order.
 */
export interface DspWorkerPutStemsMessage {
  kind: 'put-rebalance-stems';
  set: RebalanceStemSet;
}

export type DspWorkerMessage = DspWorkerRequest | DspWorkerPutStemsMessage;

export interface DspWorkerSuccessResponse {
  id: number;
  ok: true;
  channels: Float32Array[];
  telemetry: ProcessorMeterTelemetry[];
  peaks?: number[];
  analysis: AudioAnalysis;
  dynamicEqTraces?: DynamicEqTrace[];
  /** High-resolution peaks when the request set hiPeakBins. */
  peaksHi?: number[];
}

export interface DspWorkerErrorResponse {
  id: number;
  ok: false;
  error: string;
}

self.onmessage = (ev: MessageEvent<DspWorkerMessage>) => {
  const msg = ev.data;
  if (msg && msg.kind === 'put-rebalance-stems') {
    try {
      registerRebalanceStems(msg.set);
    } catch {
      // A malformed stem set is ignored: the rebalance then renders as a no-op (telemetry says so).
    }
    return;
  }
  const req = msg;
  const post = (self as unknown as { postMessage: (msg: unknown, transfer?: Transferable[]) => void }).postMessage.bind(self);
  let lastPostAt = 0;
  const progress = (stage: DspWorkerProgressStage, fraction: number, force = false) => {
    if (!req.reportProgress) return;
    const now = Date.now();
    if (!force && now - lastPostAt < 50) return;
    lastPostAt = now;
    const m: DspWorkerProgressMessage = { id: req.id, kind: 'progress', stage, fraction };
    post(m);
  };
  try {
    progress('processing', 0, true);
    const processed = processChainOffline(req.channels, req.sampleRate, req.chain, req.postFades, {
      takeOwnership: true,
      audition: req.audition === true,
      collectDynamicEqTraces: req.collectDynamicEqTraces === true,
    });
    progress('analyzing', 0, true);
    const analysis = analyzeAudioBuffer(
      processed.channels,
      req.sampleRate,
      req.reportProgress ? (f) => progress('analyzing', f) : undefined,
    );
    progress('waveform', 0, true);
    const peaks =
      req.kind === 'render-and-analyze'
        ? extractWaveformPeaks(processed.channels, req.peakBins ?? 400)
        : undefined;
    const peaksHi =
      req.hiPeakBins && req.hiPeakBins > 0 ? extractWaveformPeaks(processed.channels, req.hiPeakBins) : undefined;
    progress('waveform', 1, true);

    const resp: DspWorkerSuccessResponse = {
      id: req.id,
      ok: true,
      channels: processed.channels,
      telemetry: processed.telemetry,
      peaks,
      analysis,
      dynamicEqTraces: processed.dynamicEqTraces,
      ...(peaksHi ? { peaksHi } : {}),
    };

    // Transfer (not copy) the rendered audio back. Mono input renders to two channels that
    // may share one buffer; transfer each underlying buffer once.
    const transferList = Array.from(new Set(processed.channels.map((ch) => ch.buffer)));
    post(resp, transferList);
  } catch (err) {
    const resp: DspWorkerErrorResponse = {
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : 'DSP worker failed',
    };
    (self as unknown as { postMessage: (msg: unknown) => void }).postMessage(resp);
  }
};
