import type { FadeSettings } from './fades';
import type { AudioAnalysis, ProcessorModule } from '../types/mastering.ts';
import { analyzeAudioBuffer, extractWaveformPeaks } from './analyzer.ts';
import {
  chainHasActiveExternalPlugins,
  renderMixedChain,
  type ExternalPluginProcessCallback,
} from './mixedChainRenderer.ts';
import type { DynamicEqTrace, ProcessorMeterTelemetry } from './offlineDsp.ts';
import type {
  DspWorkerErrorResponse,
  DspWorkerMessage,
  DspWorkerProgressMessage,
  DspWorkerProgressStage,
  DspWorkerRequest,
  DspWorkerSuccessResponse,
} from './dspWorker.ts';
import type { VocalRebalanceParams } from '../types/mastering.ts';
import { fingerprintStereo, getRebalanceStems, rebalanceIsActive, type RebalanceStemSet } from './vocalRebalance.ts';

/**
 * The cached Vocal Rebalance stems a render needs, or null: an enabled rebalance with a stem
 * away from 0 dB and a stem set registered for exactly this source audio.
 */
/**
 * The in-process renderer is only needed when the DSP worker is unavailable, so it is loaded on
 * demand (keeps it out of the initial bundle). Same module, same code: results are identical.
 * The app prefetches it after first paint so a fallback render never waits on the network.
 */
export const loadOfflineDsp = () => import('./offlineDsp.ts');

export function rebalanceStemsForRender(
  chain: ProcessorModule[],
  sourceChannels: Float32Array[],
  sampleRate: number,
): RebalanceStemSet | null {
  const mod = chain.find((m) => m.type === 'vocal-rebalance' && m.enabled && !m.bypassed);
  if (!mod || !sourceChannels[0]) return null;
  if (!rebalanceIsActive(mod.params as VocalRebalanceParams, mod.intensity / 100)) return null;
  const left = sourceChannels[0];
  const right = sourceChannels[1] ?? sourceChannels[0];
  return getRebalanceStems(fingerprintStereo(left, right, sampleRate));
}

export interface OffThreadRenderResult {
  channels: Float32Array[];
  telemetry: ProcessorMeterTelemetry[];
  analysis: AudioAnalysis;
  peaks?: number[];
  usedWorker: boolean;
  usedExternalHost: boolean;
  /** Dynamic EQ detector / gain history (preview renders that asked for it). */
  dynamicEqTraces?: DynamicEqTrace[];
  /** High-resolution waveform peaks (when hiPeakBins was requested). */
  peaksHi?: number[];
}

/** Job progress: stage plus 0..1 fraction within the stage. */
export type OffThreadProgressCallback = (stage: DspWorkerProgressStage, fraction: number) => void;

/** Options for long jobs (import): progress, cancel, and zero-copy hand-off of the input. */
export interface OffThreadJobOptions {
  /** Compute high-res peaks in the same job (off the UI thread). */
  hiPeakBins?: number;
  onProgress?: OffThreadProgressCallback;
  /** Abort: the job is rejected with an AbortError and never falls back to the UI thread. */
  signal?: AbortSignal;
  /**
   * Transfer the caller's channel buffers to the worker instead of cloning them. The caller's
   * arrays become detached (length 0) and must not be used again; use the returned channels.
   * Only honoured on the worker path; the in-thread fallback leaves them intact.
   */
  transferSource?: boolean;
}

export function makeAbortError(): Error {
  const err = new Error('The operation was cancelled.');
  err.name = 'AbortError';
  return err;
}

/** Preview-only render options; export, Fix All and verification leave both off. */
export interface PreviewRenderOptions {
  /** Honour EQ / Dynamic EQ band solo (listen). */
  audition?: boolean;
  /** Record Dynamic EQ detector / gain traces for the meters and live curve. */
  collectDynamicEqTraces?: boolean;
}

type DspWorkerResponse = DspWorkerSuccessResponse | DspWorkerErrorResponse | DspWorkerProgressMessage;

interface DspWorkerLike {
  onmessage: ((event: MessageEvent<DspWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: DspWorkerMessage, transfer?: Transferable[]): void;
  terminate(): void;
}

interface PendingJob {
  resolve: (response: DspWorkerSuccessResponse) => void;
  reject: (reason: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  /** Re-arm the inactivity watchdog (called on every progress message). */
  touch?: () => void;
  onProgress?: OffThreadProgressCallback;
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
 * back to the in-thread renderer. Input audio is cloned before transfer to preserve the
 * main-thread source; the worker owns and mutates its transferred copy in place.
 */
export function createDspWorkerClient(options: DspWorkerClientOptions = {}) {
  const workerFactory = options.workerFactory ?? defaultWorkerFactory;
  const maxMainThreadFallbackDurationSec = Math.max(0, options.maxMainThreadFallbackDurationSec ?? 30);
  let worker: DspWorkerLike | null = null;
  let nextJobId = 1;
  const pendingJobs = new Map<number, PendingJob>();
  /** Rebalance stem sets already resident in the current worker (reset with the worker). */
  let workerStemFingerprints = new Set<string>();

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
    workerStemFingerprints = new Set<string>();
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
      workerStemFingerprints = new Set<string>();
      created.onmessage = (event) => {
        const message = event.data;
        if (!message || !Number.isInteger(message.id)) return;
        if ((message as DspWorkerProgressMessage).kind === 'progress') {
          const prog = message as DspWorkerProgressMessage;
          const pending = pendingJobs.get(prog.id);
          if (!pending) return;
          pending.touch?.();
          try {
            pending.onProgress?.(prog.stage, prog.fraction);
          } catch {
            // A UI progress handler must never break the job.
          }
          return;
        }
        const done = message as DspWorkerSuccessResponse | DspWorkerErrorResponse;
        if (done.ok) clearPending(done.id, undefined, done);
        else clearPending(done.id, new Error(done.error || 'DSP worker reported an error'));
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
    preview: PreviewRenderOptions = {},
  ): Promise<OffThreadRenderResult> => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const { processChainOffline } = await loadOfflineDsp();
    const processed = processChainOffline(sourceChannels, sampleRate, chain, postFades, preview);
    const analysis = analyzeAudioBuffer(processed.channels, sampleRate);
    const peaks = includePeaks ? extractWaveformPeaks(processed.channels, peakBins) : undefined;
    return {
      channels: processed.channels,
      telemetry: processed.telemetry,
      analysis,
      peaks,
      usedWorker: false,
      usedExternalHost: false,
      dynamicEqTraces: processed.dynamicEqTraces,
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
  } & PreviewRenderOptions & OffThreadJobOptions): Promise<OffThreadRenderResult> => {
    const {
      sourceChannels,
      sampleRate,
      chain,
      includePeaks = false,
      peakBins = 400,
      externalProcessor,
      postFades = null,
    } = opts;
    const preview: PreviewRenderOptions = { audition: opts.audition === true, collectDynamicEqTraces: opts.collectDynamicEqTraces === true };
    const safePeakBins = Math.max(1, Math.min(8192, Math.floor(peakBins)));
    const safeHiBins = opts.hiPeakBins ? Math.max(1, Math.min(8192, Math.floor(opts.hiPeakBins))) : 0;
    if (opts.signal?.aborted) throw makeAbortError();
    const durationSec = (sourceChannels[0]?.length ?? 0) / sampleRate;
    // Headless runs (scripts/headless-master.ts sets globalThis.__SYN_HEADLESS__) have no
    // UI to freeze, so long files may fall back to the in-process renderer there.
    const headless = Boolean((globalThis as { __SYN_HEADLESS__?: boolean }).__SYN_HEADLESS__);
    const requiresWorker = !headless && durationSec > maxMainThreadFallbackDurationSec;
    // Inactivity watchdog. It scales with file length and, for jobs that report progress, is
    // re-armed on every progress message, so a long file on a slow phone is never killed while
    // it is still making progress; only a worker that goes silent for this long is failed.
    const workerTimeoutMs = Math.max(
      1,
      options.workerTimeoutMs ?? Math.min(
        opts.onProgress ? 600_000 : 120_000,
        Math.max(45_000, durationSec * 1_500 + 15_000),
      ),
    );
    const fallbackOrThrow = async (reason: unknown): Promise<OffThreadRenderResult> => {
      if (requiresWorker) {
        const detail = reason instanceof Error ? reason.message : 'Unknown DSP worker failure';
        throw new Error(
          `Off-thread DSP rendering failed for ${durationSec.toFixed(1)}s audio. Main-thread fallback was skipped to prevent the interface from freezing. ${detail}`,
        );
      }
      if (opts.signal?.aborted) throw makeAbortError();
      const fallback = await renderFallback(sourceChannels, sampleRate, chain, includePeaks, safePeakBins, postFades, preview);
      if (opts.signal?.aborted) throw makeAbortError();
      return safeHiBins
        ? { ...fallback, peaksHi: extractWaveformPeaks(fallback.channels, safeHiBins) }
        : fallback;
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
        hiPeakBins: safeHiBins || undefined,
        onProgress: opts.onProgress,
        signal: opts.signal,
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
    // Zero-copy hand-off when the caller gives up its arrays (import); otherwise clone so the
    // main-thread source stays intact (preview / Fix All renders).
    const ownsWholeBuffers = sourceChannels.every(
      (ch) => ch.byteOffset === 0 && ch.byteLength === ch.buffer.byteLength && !(typeof SharedArrayBuffer !== 'undefined' && ch.buffer instanceof SharedArrayBuffer),
    ) && new Set(sourceChannels.map((ch) => ch.buffer)).size === sourceChannels.length;
    const clonedChannels = opts.transferSource && ownsWholeBuffers
      ? sourceChannels
      : sourceChannels.map((channel) => new Float32Array(channel));
    const transferables = clonedChannels.map((channel) => channel.buffer as Transferable);
    const request: DspWorkerRequest = {
      id,
      kind: includePeaks ? 'render-and-analyze' : 'render-only',
      channels: clonedChannels,
      sampleRate,
      chain,
      peakBins: safePeakBins,
      postFades,
      ...preview,
      ...(safeHiBins ? { hiPeakBins: safeHiBins } : {}),
      ...(opts.onProgress ? { reportProgress: true } : {}),
    };

    // Vocal Rebalance: copy the cached stems into the worker once (structured clone; the main
    // thread keeps its copy for export / fallback renders).
    const stems = rebalanceStemsForRender(chain, sourceChannels, sampleRate);
    if (stems && !workerStemFingerprints.has(stems.fingerprint)) {
      try {
        currentWorker.postMessage({ kind: 'put-rebalance-stems', set: stems });
        workerStemFingerprints.add(stems.fingerprint);
      } catch (error) {
        failWorker(error);
        return fallbackOrThrow(error);
      }
    }

    try {
      const response = await new Promise<DspWorkerSuccessResponse>((resolve, reject) => {
        const onTimeout = () => {
          const timeoutError = new Error(`DSP worker timed out after ${workerTimeoutMs} ms without progress`);
          failWorker(timeoutError);
        };
        const job: PendingJob = { resolve, reject, timeoutId: setTimeout(onTimeout, workerTimeoutMs), onProgress: opts.onProgress };
        job.touch = () => {
          clearTimeout(job.timeoutId);
          job.timeoutId = setTimeout(onTimeout, workerTimeoutMs);
        };
        pendingJobs.set(id, job);
        if (opts.signal) {
          const onAbort = () => {
            if (!pendingJobs.has(id)) return;
            // The worker cannot be interrupted mid-job: terminate it when this is its only job
            // (a fresh worker is created for the next request); otherwise just drop the result.
            if (pendingJobs.size === 1) {
              const w = worker;
              worker = null;
              workerStemFingerprints = new Set<string>();
              try { w?.terminate(); } catch { /* ignore */ }
            }
            clearPending(id, makeAbortError());
          };
          opts.signal.addEventListener('abort', onAbort, { once: true });
        }
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
        dynamicEqTraces: response.dynamicEqTraces,
        ...(response.peaksHi ? { peaksHi: response.peaksHi } : {}),
      };
    } catch (error) {
      if (opts.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw makeAbortError();
      if (opts.transferSource && clonedChannels === sourceChannels && (sourceChannels[0]?.length ?? 0) === 0) {
        // The input was handed to a worker that then failed: it cannot be re-rendered here.
        throw makeError(error, 'DSP worker failed after taking the audio');
      }
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
} & PreviewRenderOptions & OffThreadJobOptions): Promise<OffThreadRenderResult> {
  return defaultClient.renderAndAnalyzeOffThread(opts);
}

/** Exposed for app shutdown/cleanup and deterministic worker-lifecycle tests. */
export function disposeDspWorker(): void {
  defaultClient.dispose();
}
