import {
  applyMixtureConsistency,
  DEMUCS_SAMPLE_RATE,
  type MixtureConsistencyReport,
} from '../dsp/stemSeparationMath';

export interface SeparatedAudioStem {
  id: 'drums' | 'bass' | 'other' | 'vocals';
  label: string;
  channels: [Float32Array, Float32Array];
}

export interface StemSeparationProgress {
  stage: 'loading-model' | 'initializing' | 'separating' | 'resampling';
  progress: number;
  completedChunks?: number;
  totalChunks?: number;
  executionProvider?: string;
}

type StoredStemDescriptor = { id: SeparatedAudioStem['id']; label: string; length: number; leftFile: string; rightFile: string };

type WorkerResponse =
  | { type: 'progress'; jobId: string; stage: StemSeparationProgress['stage']; progress: number; completedChunks?: number; totalChunks?: number; executionProvider?: string }
  | { type: 'result'; jobId: string; directoryName: string; stems: StoredStemDescriptor[] }
  | { type: 'cancelled'; jobId: string }
  | { type: 'error'; jobId: string; message: string };

export interface StemSeparationResourceInput {
  durationSec: number;
  sampleRate: number;
  fileSizeBytes: number;
}

export interface SharedStemSeparationResult {
  /** Shared cached samples are read-only by convention; copy before any consumer mutation. */
  stems: readonly SeparatedAudioStem[];
  mixtureConsistency: MixtureConsistencyReport;
}

export interface SharedStemSeparationRequest {
  channels: [Float32Array, Float32Array];
  sampleRate: number;
  resource: StemSeparationResourceInput;
  signal: AbortSignal;
  highQuality?: boolean;
  onProgress?: (progress: StemSeparationProgress) => void;
}

interface SeparationRunnerOptions {
  highQuality: boolean;
}

interface SeparationServiceDependencies {
  assessResources: (input: StemSeparationResourceInput) => Promise<void>;
  runSeparation: (
    channels: [Float32Array, Float32Array],
    signal: AbortSignal,
    onProgress: (progress: StemSeparationProgress) => void,
    options: SeparationRunnerOptions,
  ) => Promise<SeparatedAudioStem[]>;
  maxCachedBytes?: number;
  onConsumerAdded?: (consumerCount: number) => void;
}

interface SeparationConsumer {
  onProgress?: (progress: StemSeparationProgress) => void;
}

interface SeparationJob {
  key: string;
  controller: AbortController;
  consumers: Set<SeparationConsumer>;
  promise: Promise<SharedStemSeparationResult>;
  resolve: (result: SharedStemSeparationResult) => void;
  reject: (error: unknown) => void;
}

interface CachedSeparation {
  result: SharedStemSeparationResult;
  bytes: number;
}

const DEMUCS_MODEL_ID = 'htdemucs-onnx:d54ed9eb60e258ea82131c6ee14578628816456a';
const DEFAULT_COMPLETED_CACHE_BYTES = 256 * 1024 * 1024;
const HASH_CHUNK_SAMPLES = 1 << 18;
const VALID_STEM_IDS = ['drums', 'bass', 'other', 'vocals'] as const;

export function estimateStemSeparationOutputBytes(durationSec: number, sampleRate: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0 ||
    !Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 384000) {
    throw new RangeError('Stem separation requires a valid duration and sample rate.');
  }
  return Math.ceil(durationSec * Math.max(44_100, sampleRate) * 8 * Float32Array.BYTES_PER_ELEMENT);
}

export function validateStemSeparationInputs(inputs: StemSeparationResourceInput[]): void {
  if (inputs.length === 0) throw new RangeError('At least one track is required for stem separation.');
  for (const input of inputs) {
    estimateStemSeparationOutputBytes(input.durationSec, input.sampleRate);
    if (!Number.isFinite(input.fileSizeBytes) || input.fileSizeBytes < 0 || input.fileSizeBytes > 512 * 1024 * 1024) {
      throw new Error('A source or reference file exceeds the 512 MB browser separation limit.');
    }
  }
}

/** Preflight browser resources before launching a stem-separation job. */
export async function assessStemSeparationResources(inputs: StemSeparationResourceInput[]): Promise<void> {
  validateStemSeparationInputs(inputs);
  const estimatedBytes = inputs.reduce(
    (sum, input) => sum + estimateStemSeparationOutputBytes(input.durationSec, input.sampleRate),
    0,
  );
  const deviceMemoryGb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  const memoryBudgetBytes = Math.min(2_048, Math.max(768, deviceMemoryGb * 512)) * 1024 * 1024;
  if (estimatedBytes > memoryBudgetBytes) {
    throw new Error(
      `Source/reference stem separation needs about ${Math.ceil(estimatedBytes / (1024 * 1024))} MB, above this device's estimated ${Math.floor(memoryBudgetBytes / (1024 * 1024))} MB safe working budget.`,
    );
  }
  if (!navigator.storage?.getDirectory || !navigator.storage?.estimate) {
    throw new Error('This browser does not support the temporary disk storage required for safe stem separation.');
  }
  const storageEstimate = await navigator.storage.estimate();
  const requiredStorageBytes = Math.ceil(
    Math.max(...inputs.map((input) => estimateStemSeparationOutputBytes(input.durationSec, input.sampleRate))) * 1.15,
  );
  const availableStorageBytes = Math.max(0, (storageEstimate.quota ?? 0) - (storageEstimate.usage ?? 0));
  if (availableStorageBytes < requiredStorageBytes) {
    throw new Error(
      `Not enough browser temporary storage for source/reference stem separation. About ${Math.ceil(requiredStorageBytes / (1024 * 1024))} MB is required, but only ${Math.floor(availableStorageBytes / (1024 * 1024))} MB is available.`,
    );
  }
}

async function cleanupTemporaryStems(jobId: string): Promise<void> {
  try {
    const storage = await navigator.storage?.getDirectory?.();
    if (!storage) return;
    const directoryName = `syn-master-stems-${jobId.replace(/[^a-zA-Z0-9-]/g, '')}`;
    await storage.removeEntry(directoryName, { recursive: true }).catch(() => undefined);
  } catch {
    // Temporary cleanup is best-effort after worker failure or cancellation.
  }
}

async function loadTemporaryStems(directoryName: string, descriptors: StoredStemDescriptor[]): Promise<SeparatedAudioStem[]> {
  const storage = await navigator.storage?.getDirectory?.();
  if (!storage) throw new Error('OPFS temporary storage became unavailable before stem import.');
  const directory = await storage.getDirectoryHandle(directoryName);
  try {
    const stems: SeparatedAudioStem[] = [];
    for (const descriptor of descriptors) {
      const leftHandle = await directory.getFileHandle(descriptor.leftFile);
      const rightHandle = await directory.getFileHandle(descriptor.rightFile);
      const [leftFile, rightFile] = await Promise.all([leftHandle.getFile(), rightHandle.getFile()]);
      const expectedBytes = descriptor.length * Float32Array.BYTES_PER_ELEMENT;
      if (leftFile.size !== expectedBytes || rightFile.size !== expectedBytes) {
        throw new Error(`Temporary ${descriptor.label} stem is incomplete. Expected ${expectedBytes} bytes per channel.`);
      }
      const [leftBytes, rightBytes] = await Promise.all([leftFile.arrayBuffer(), rightFile.arrayBuffer()]);
      stems.push({
        id: descriptor.id,
        label: descriptor.label,
        channels: [new Float32Array(leftBytes), new Float32Array(rightBytes)],
      });
    }
    return stems;
  } finally {
    await storage.removeEntry(directoryName, { recursive: true }).catch(() => undefined);
  }
}

/** Resample separated stereo stems to the active SYN-MASTER session rate. */
export async function resampleStereoChannels(
  channels: [Float32Array, Float32Array],
  sourceSampleRate: number,
  targetSampleRate: number,
): Promise<[Float32Array, Float32Array]> {
  if (channels[0].length < 1 || channels[0].length !== channels[1].length) {
    throw new RangeError('Stereo resampling requires two non-empty, equal-length channels.');
  }
  for (const rate of [sourceSampleRate, targetSampleRate]) {
    if (!Number.isFinite(rate) || rate < 8_000 || rate > 384_000) {
      throw new RangeError('Audio sample rates must be between 8000 and 384000 Hz.');
    }
  }
  if (sourceSampleRate === targetSampleRate) return channels;

  const outputLength = Math.max(1, Math.ceil(channels[0].length * targetSampleRate / sourceSampleRate));
  const offline = new OfflineAudioContext(2, outputLength, targetSampleRate);
  const input = offline.createBuffer(2, channels[0].length, sourceSampleRate);
  input.copyToChannel(channels[0] as Float32Array<ArrayBuffer>, 0);
  input.copyToChannel(channels[1] as Float32Array<ArrayBuffer>, 1);
  const source = offline.createBufferSource();
  source.buffer = input;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  return [rendered.getChannelData(0).slice(), rendered.getChannelData(1).slice()];
}

export function separateWithDemucs(
  channels: [Float32Array, Float32Array],
  signal: AbortSignal,
  onProgress: (progress: StemSeparationProgress) => void,
  options: { highQuality?: boolean; timeoutMs?: number } = {},
): Promise<SeparatedAudioStem[]> {
  if (signal.aborted) return Promise.reject(new DOMException('Separation cancelled.', 'AbortError'));
  if (channels[0].length < 1 || channels[0].length !== channels[1].length) {
    return Promise.reject(new Error('A non-empty stereo audio buffer is required.'));
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/demucsSeparation.worker.ts', import.meta.url), { type: 'module' });
    const jobId = globalThis.crypto?.randomUUID?.() ?? `demucs-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let settled = false;
    const timeoutMs = Math.max(1_000, options.timeoutMs ?? 600_000);
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout !== null) clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      worker.terminate();
      callback();
    };
    const abort = () => worker.postMessage({ type: 'cancel', jobId });

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.jobId !== jobId) return;
      if (message.type === 'progress') {
        onProgress({
          stage: message.stage,
          progress: message.progress,
          completedChunks: message.completedChunks,
          totalChunks: message.totalChunks,
          executionProvider: message.executionProvider,
        });
      } else if (message.type === 'result') {
        finish(() => {
          void loadTemporaryStems(message.directoryName, message.stems).then(resolve, reject);
        });
      } else if (message.type === 'cancelled') {
        finish(() => {
          void cleanupTemporaryStems(jobId).finally(() => reject(new DOMException('Separation cancelled.', 'AbortError')));
        });
      } else {
        finish(() => {
          void cleanupTemporaryStems(jobId).finally(() => reject(new Error(message.message)));
        });
      }
    };

    worker.onerror = (event) => finish(() => {
      void cleanupTemporaryStems(jobId).finally(() => reject(new Error(event.message || 'The separation worker crashed.')));
    });
    signal.addEventListener('abort', abort, { once: true });
    timeout = setTimeout(() => finish(() => {
      void cleanupTemporaryStems(jobId).finally(() =>
        reject(new Error(`Stem separation timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`)),
      );
    }), timeoutMs);
    if (signal.aborted) {
      finish(() => reject(new DOMException('Separation cancelled.', 'AbortError')));
      return;
    }
    worker.postMessage(
      { type: 'start', jobId, channels, shifts: options.highQuality ? 2 : 1 },
      [channels[0].buffer, channels[1].buffer],
    );
  });
}

      async function createSeparationKey(
        channels: [Float32Array, Float32Array],
        highQuality: boolean,
        signal: AbortSignal,
      ): Promise<string> {
        if (channels[0].length === 0 || channels[0].length !== channels[1].length) {
          throw new RangeError('Shared stem separation requires aligned, non-empty stereo audio.');
        }
        const subtle = globalThis.crypto?.subtle;
        if (!subtle) throw new Error('Secure SHA-256 support is required to safely share separated stems.');

        const prefix = new TextEncoder().encode(
          `syn-master-stems-v1|${DEMUCS_MODEL_ID}|${DEMUCS_SAMPLE_RATE}|${highQuality ? 2 : 1}|${channels[0].length}|`,
        );
        const chunkDigests: Uint8Array[] = [];
        for (let channel = 0; channel < 2; channel += 1) {
          const samples = channels[channel];
          for (let offset = 0; offset < samples.length; offset += HASH_CHUNK_SAMPLES) {
            if (signal.aborted) throw new DOMException('Separation cancelled.', 'AbortError');
            const count = Math.min(HASH_CHUNK_SAMPLES, samples.length - offset);
            for (let index = offset; index < offset + count; index += 1) {
              if (!Number.isFinite(samples[index])) {
                throw new Error('Stem separation input contains a non-finite audio sample.');
              }
            }
            const bytes = new Uint8Array(count * Float32Array.BYTES_PER_ELEMENT);
            bytes.set(new Uint8Array(
              samples.buffer,
              samples.byteOffset + offset * Float32Array.BYTES_PER_ELEMENT,
              count * Float32Array.BYTES_PER_ELEMENT,
            ));
            chunkDigests.push(new Uint8Array(await subtle.digest('SHA-256', bytes.buffer)));
          }
        }
        if (signal.aborted) throw new DOMException('Separation cancelled.', 'AbortError');

        const digestInput = new Uint8Array(prefix.length + chunkDigests.length * 32);
        digestInput.set(prefix);
        let cursor = prefix.length;
        for (const digest of chunkDigests) {
          digestInput.set(digest, cursor);
          cursor += digest.length;
        }
        const digest = new Uint8Array(await subtle.digest('SHA-256', digestInput));
        return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
      }

      function assertCompleteStemSet(
        stems: SeparatedAudioStem[],
        sampleCount: number,
      ): void {
        const actualIds = stems.map((stem) => stem.id).sort();
        const expectedIds = [...VALID_STEM_IDS].sort();
        if (
          stems.length !== VALID_STEM_IDS.length ||
          actualIds.some((id, index) => id !== expectedIds[index]) ||
          stems.some((stem) =>
            stem.channels[0].length !== sampleCount ||
            stem.channels[1].length !== sampleCount,
          )
        ) {
          throw new Error('Stem separation returned an incomplete or mismatched stem set.');
        }
      }

      export function createSharedStemSeparationService(
        dependencies: SeparationServiceDependencies,
      ): { separate: (request: SharedStemSeparationRequest) => Promise<SharedStemSeparationResult> } {
        const inFlight = new Map<string, SeparationJob>();
        const completed = new Map<string, CachedSeparation>();
        const maxCachedBytes = Math.max(0, dependencies.maxCachedBytes ?? DEFAULT_COMPLETED_CACHE_BYTES);
        let cachedBytes = 0;

        const remember = (key: string, result: SharedStemSeparationResult): void => {
          const bytes = result.stems.reduce(
            (total, stem) => total + stem.channels[0].byteLength + stem.channels[1].byteLength,
            0,
          );
          if (bytes > maxCachedBytes || maxCachedBytes === 0) return;
          const prior = completed.get(key);
          if (prior) {
            cachedBytes -= prior.bytes;
            completed.delete(key);
          }
          completed.set(key, { result, bytes });
          cachedBytes += bytes;
          while (cachedBytes > maxCachedBytes) {
            const oldest = completed.entries().next().value as [string, CachedSeparation] | undefined;
            if (!oldest) break;
            completed.delete(oldest[0]);
            cachedBytes -= oldest[1].bytes;
          }
        };

        const subscribe = (
          job: SeparationJob,
          signal: AbortSignal,
          consumer: SeparationConsumer,
        ): Promise<SharedStemSeparationResult> => {
          if (signal.aborted) {
            return Promise.reject(new DOMException('Separation cancelled.', 'AbortError'));
          }
          job.consumers.add(consumer);
          dependencies.onConsumerAdded?.(job.consumers.size);
          return new Promise((resolve, reject) => {
            let settled = false;
            const detach = () => {
              signal.removeEventListener('abort', abort);
              job.consumers.delete(consumer);
            };
            const abort = () => {
              if (settled) return;
              settled = true;
              detach();
              reject(new DOMException('Separation cancelled.', 'AbortError'));
              if (job.consumers.size === 0 && inFlight.get(job.key) === job) {
                job.controller.abort();
              }
            };
            const finish = (action: () => void) => {
              if (settled) return;
              settled = true;
              detach();
              action();
            };

            signal.addEventListener('abort', abort, { once: true });
            job.promise.then(
              (result) => finish(() => resolve(result)),
              (error: unknown) => finish(() => reject(error)),
            );
            if (signal.aborted) abort();
          });
        };

        const separate = async (request: SharedStemSeparationRequest): Promise<SharedStemSeparationResult> => {
          if (request.signal.aborted) throw new DOMException('Separation cancelled.', 'AbortError');
          validateStemSeparationInputs([request.resource]);
          if (request.sampleRate !== DEMUCS_SAMPLE_RATE) {
            throw new RangeError(`Shared separation input must be resampled to ${DEMUCS_SAMPLE_RATE} Hz.`);
          }
          if (Math.abs(request.resource.durationSec - request.channels[0].length / DEMUCS_SAMPLE_RATE) > 1.5 / DEMUCS_SAMPLE_RATE) {
            throw new RangeError('Separation resource duration does not match the canonical audio length.');
          }

          const highQuality = request.highQuality === true;
          const key = await createSeparationKey(request.channels, highQuality, request.signal);
          if (request.signal.aborted) throw new DOMException('Separation cancelled.', 'AbortError');

          const cached = completed.get(key);
          if (cached) {
            completed.delete(key);
            completed.set(key, cached);
            return cached.result;
          }

          let job = inFlight.get(key);
          let startJob = false;
          if (!job || job.controller.signal.aborted) {
            let resolve!: SeparationJob['resolve'];
            let reject!: SeparationJob['reject'];
            const promise = new Promise<SharedStemSeparationResult>((res, rej) => {
              resolve = res;
              reject = rej;
            });
            job = {
              key,
              controller: new AbortController(),
              consumers: new Set(),
              promise,
              resolve,
              reject,
            };
            inFlight.set(key, job);
            startJob = true;
          }

          const result = subscribe(job, request.signal, { onProgress: request.onProgress });
          if (startJob) {
            const activeJob = job;
            void (async () => {
              try {
                await dependencies.assessResources(request.resource);
                if (activeJob.controller.signal.aborted) {
                  throw new DOMException('Separation cancelled.', 'AbortError');
                }
                const stems = await dependencies.runSeparation(
                  [request.channels[0].slice(), request.channels[1].slice()],
                  activeJob.controller.signal,
                  (progress) => {
                    for (const consumer of activeJob.consumers) consumer.onProgress?.(progress);
                  },
                  { highQuality },
                );
                if (activeJob.controller.signal.aborted) {
                  throw new DOMException('Separation cancelled.', 'AbortError');
                }
                assertCompleteStemSet(stems, request.channels[0].length);
                const mixtureConsistency = applyMixtureConsistency(
                  request.channels,
                  stems.map((stem) => stem.channels),
                );
                const sharedResult = { stems, mixtureConsistency };
                remember(key, sharedResult);
                activeJob.resolve(sharedResult);
              } catch (error) {
                activeJob.reject(error);
              } finally {
                if (inFlight.get(key) === activeJob) inFlight.delete(key);
              }
            })();
          }
          return result;
        };

        return { separate };
      }

      const sharedStemSeparationService = createSharedStemSeparationService({
        assessResources: async (resource) => assessStemSeparationResources([resource]),
        runSeparation: (channels, signal, onProgress, options) => separateWithDemucs(
          channels,
          signal,
          onProgress,
          options,
        ),
      });

      export async function requestSharedStemSeparation(
        request: SharedStemSeparationRequest,
      ): Promise<SharedStemSeparationResult> {
        return sharedStemSeparationService.separate(request);
      }
