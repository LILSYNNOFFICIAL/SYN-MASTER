import type { FadeSettings } from './fades';
import type { AudioAnalysis, ProcessorModule } from '../types/mastering.ts';
import { analyzeAudioBuffer, extractWaveformPeaks } from './analyzer.ts';
import {
  chainHasActiveExternalPlugins,
  renderMixedChain,
  type ExternalPluginProcessCallback,
} from './mixedChainRenderer.ts';
import { processChainOffline, type ProcessorMeterTelemetry } from './offlineDsp.ts';
import type {
  DspWorkerErrorResponse,
  DspWorkerRequest,
  DspWorkerSuccessResponse,
} from './dspWorker.ts';

export interface OffThreadRenderResult {
  channels: Float32Array[];
  telemetry: ProcessorMeterTelemetry[];
  analysis: AudioAnalysis;
  peaks?: number[];
  usedWorker: boolean;
  usedExternalHost: boolean;
}

type DspWorkerResponse = DspWorkerSuccessResponse | DspWorkerErrorResponse;

interface DspWorkerLike {
  onmessage: ((event: MessageEvent<DspWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: DspWorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
}

interface PendingJob {
  resolve: (response: DspWorkerSuccessResponse) => void;
  reject: (reason: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

export interface DspWorkerClientOptions {
  workerFactory?: () => DspWorkerLike | null;
  workerTimeoutMs?: number;
  maxMainThreadFallbackDurationSec?: number;
}

function defaultWorkerFactory(): DspWorkerLike | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(new URL('./dspWorker.ts', import.meta.url), {
      type: 'module',
      name: 'syn-master-dsp',
    }) as unknown as DspWorkerLike;
  } catch {
    return null;
  }
}

function makeError(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback);
}

/**
 * A lifecycle-managed DSP worker client. Failed or timed-out workers are terminated,
 * every pending request is rejected and removed, and the caller transparently falls
 * back to the in-thread renderer. Input audio is always cloned before transfer.
 */
export function createDspWorkerClient(options: DspWorkerClientOptions = {}) {
  const workerFactory = options.workerFactory ?? defaultWorkerFactory;
  const maxMainThreadFallbackDurationSec = Math.max(0, options.maxMainThreadFallbackDurationSec ?? 30);
  let worker: DspWorkerLike | null = null;
  let nextJobId = 1;
  const pendingJobs = new Map<number, PendingJob>();

  const clearPending = (id: number, error?: Error, response?: DspWorkerSuccessResponse) => {
    const pending = pendingJobs.get(id);
    if (!pending) return;
    pendingJobs.delete(id);
    clearTimeout(pending.timeoutId);
    if (response) pending.resolve(response);
    else pending.reject(error ?? new Error('DSP worker request failed'));
  };

  const failWorker = (reason: unknown) => {
    const failedWorker = worker;
    worker = null;
    try {
      failedWorker?.terminate();
    } catch {
      // Worker termination must not prevent pending-job cleanup.
    }
    const error = makeError(reason, 'DSP worker became unavailable');
    for (const id of [...pendingJobs.keys()]) clearPending(id, error);
  };

  const getWorker = (): DspWorkerLike | null => {
    if (worker) return worker;
    try {
      const created = workerFactory();
      if (!created) return null;
      worker = created;
      created.onmessage = (event) => {
        const message = event.data;
        if (!message || !Number.isInteger(message.id)) return;
        if (message.ok) clearPending(message.id, undefined, message);
        else clearPending(message.id, new Error(message.error || 'DSP worker reported an error'));
      };
      created.onerror = (event) => {
        event.preventDefault?.();
        failWorker(new Error(event.message || 'DSP worker crashed'));
      };
      created.onmessageerror = () => {
        failWorker(new Error('DSP worker returned an unreadable message'));
      };
      return created;
    } catch {
      worker = null;
      return null;
    }
  };

  const renderFallback = async (
    sourceChannels: Float32Array[],
    sampleRate: number,
    chain: ProcessorModule[],
    includePeaks: boolean,
    peakBins: number,
    postFades: FadeSettings | null = null,
  ): Promise<OffThreadRenderResult> => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const processed = processChainOffline(sourceChannels, sampleRate, chain, postFades);
    const analysis = analyzeAudioBuffer(processed.channels, sampleRate);
    const peaks = includePeaks ? extractWaveformPeaks(processed.channels, peakBins) : undefined;
    return {
      channels: processed.channels,
      telemetry: processed.telemetry,
      analysis,
      peaks,
      usedWorker: false,
      usedExternalHost: false,
    };
  };

  const renderAndAnalyzeOffThread = async (opts: {
    sourceChannels: Float32Array[];
    sampleRate: number;
    chain: ProcessorModule[];
    includePeaks?: boolean;
    peakBins?: number;
    externalProcessor?: ExternalPluginProcessCallback;
    /** Timeline fades applied after the chain (post-limiter). */
    postFades?: FadeSettings | null;
  }): Promise<OffThreadRenderResult> => {
    const {
      sourceChannels,
      sampleRate,
      chain,
      includePeaks = false,
      peakBins = 400,
      externalProcessor,
      postFades = null,
    } = opts;
    const safePeakBins = Math.max(1, Math.min(8192, Math.floor(peakBins)));
    const durationSec = (sourceChannels[0]?.length ?? 0) / sampleRate;
    // Outside a browser (headless Node runs, tests) there is no UI to freeze, so long
    // files may fall back to the in-process renderer.
    const requiresWorker = typeof window !== 'undefined' && durationSec > maxMainThreadFallbackDurationSec;
    const workerTimeoutMs = Math.max(
      1,
      Math.min(120_000, options.workerTimeoutMs ?? Math.max(45_000, durationSec * 1_500 + 15_000)),
    );
    const fallbackOrThrow = async (reason: unknown): Promise<OffThreadRenderResult> => {
      if (requiresWorker) {
        const detail = reason instanceof Error ? reason.message : 'Unknown DSP worker failure';
        throw new Error(
          `Off-thread DSP rendering failed for ${durationSec.toFixed(1)}s audio. Main-thread fallback was skipped to prevent the interface from freezing. ${detail}`,
        );
      }
      return renderFallback(sourceChannels, sampleRate, chain, includePeaks, safePeakBins, postFades);
    };

    if (chainHasActiveExternalPlugins(chain)) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const mixed = await renderMixedChain(sourceChannels, sampleRate, chain, externalProcessor, postFades);
      // Keep third-party VST3 execution in its host, but analyze its rendered output in the DSP worker.
      const analyzed = await renderAndAnalyzeOffThread({
        sourceChannels: mixed.channels,
        sampleRate,
        chain: [],
        includePeaks,
        peakBins: safePeakBins,
      });
      return {
        ...analyzed,
        telemetry: mixed.telemetry,
        usedExternalHost: mixed.usedExternalHost,
      };
    }

    const currentWorker = getWorker();
    if (!currentWorker) {
      return fallbackOrThrow(new Error('Web Worker is unavailable in this browser or deployment.'));
    }

    const id = nextJobId++;
    const clonedChannels = sourceChannels.map((channel) => new Float32Array(channel));
    const transferables = clonedChannels.map((channel) => channel.buffer as Transferable);
    const request: DspWorkerRequest = {
      id,
      kind: includePeaks ? 'render-and-analyze' : 'render-only',
      channels: clonedChannels,
      sampleRate,
      chain,
      peakBins: safePeakBins,
      postFades,
    };

    try {
      const response = await new Promise<DspWorkerSuccessResponse>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          const timeoutError = new Error(`DSP worker timed out after ${workerTimeoutMs} ms`);
          failWorker(timeoutError);
        }, workerTimeoutMs);
        pendingJobs.set(id, { resolve, reject, timeoutId });
        try {
          currentWorker.postMessage(request, transferables);
        } catch (error) {
          clearPending(id, makeError(error, 'Failed to send DSP worker request'));
          failWorker(error);
        }
      });
      return {
        channels: response.channels,
        telemetry: response.telemetry,
        analysis: response.analysis,
        peaks: response.peaks,
        usedWorker: true,
        usedExternalHost: false,
      };
    } catch (error) {
      return fallbackOrThrow(error);
    }
  };

  const dispose = () => {
    failWorker(new Error('DSP worker client disposed'));
  };

  return { renderAndAnalyzeOffThread, dispose, getPendingJobCount: () => pendingJobs.size };
}

const defaultClient = createDspWorkerClient();

export function renderAndAnalyzeOffThread(opts: {
  sourceChannels: Float32Array[];
  sampleRate: number;
  chain: ProcessorModule[];
  includePeaks?: boolean;
  peakBins?: number;
  externalProcessor?: ExternalPluginProcessCallback;
  postFades?: FadeSettings | null;
}): Promise<OffThreadRenderResult> {
  return defaultClient.renderAndAnalyzeOffThread(opts);
}

/** Exposed for app shutdown/cleanup and deterministic worker-lifecycle tests. */
export function disposeDspWorker(): void {
  defaultClient.dispose();
}
